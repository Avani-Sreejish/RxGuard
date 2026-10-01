"""REST endpoints (spec section 18.3). All requests and AI outputs are validated with Pydantic."""
from __future__ import annotations

import statistics
from decimal import Decimal

from django.conf import settings
from django.contrib.auth import authenticate
from django.db import connection, transaction
from django.db.models import Count, Q, Sum
from django.http import JsonResponse
from django.shortcuts import get_object_or_404
from django.utils import timezone
from rest_framework.authtoken.models import Token
from rest_framework.decorators import api_view, permission_classes, throttle_classes
from rest_framework.permissions import AllowAny
from rest_framework.response import Response
from rest_framework.throttling import ScopedRateThrottle
from rest_framework.views import APIView

import csv
import hashlib
import io

from api import serializers as S
from api.errors import error_response
from api.models import (AgentStep, ChunkDrugMention, CorpusChunk, CorpusDocument, DataSource, Drug, DrugAlias,
                        DrugInteraction, DuplicationFinding, Escalation, EvaluationRun, InteractionFinding,
                        KbVersion, LlmCall, Prescription, PrescriptionItem, RequestLog, Session,
                        SessionMessage, ToolCall)
from api.permissions import is_admin
from engine import ask as ask_mode
from engine import audit, context, normalize, pipeline, retrieval, review
from engine.schemas import (AskInput, ConfirmItemInput, EscalationRequest, ExplainInput, PrescriptionInput,
                            ReviewAction)
from engine.tools import escalate as tool3
from engine.tools import interaction_lookup
from engine.tools.base import run_tool


class RxView(APIView):
    """Base view: binds the authenticated user to the request context; demo toggles are admin-only."""

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        ctx = context.current()
        ctx.user_id = request.user.id if request.user and request.user.is_authenticated else None
        if ctx.simulate and not is_admin(request.user):
            ctx.simulate = set()


def _own(qs, request, **kw):
    return get_object_or_404(qs, **kw)


def _session_for(request, session_id):
    if session_id:
        return get_object_or_404(Session, pk=session_id, user=request.user)
    return Session.objects.create(user=request.user)


# ------------------------------------------------------------------------------ auth
@api_view(["POST"])
@permission_classes([AllowAny])
def login(request):
    user = authenticate(username=request.data.get("username", ""), password=request.data.get("password", ""))
    if user is None:
        return error_response(401, "invalid_credentials", "Invalid username or password")
    if not user.groups.filter(name="pharmacist").exists():
        return error_response(403, "not_pharmacist", "RxGuard is for pharmacists only")
    token, _ = Token.objects.get_or_create(user=user)
    return Response({"token": token.key, "username": user.username, "is_admin": user.is_staff})


class Me(RxView):
    def get(self, request):
        kb = KbVersion.objects.filter(is_current=True).first()
        return Response({"username": request.user.username, "is_admin": request.user.is_staff,
                         "demo_toggles_enabled": settings.RXGUARD["DEMO_TOGGLES_ENABLED"] and request.user.is_staff,
                         "kb_version": kb.label if kb else None})


# ------------------------------------------------------------------------------ core flow
class Check(RxView):
    throttle_scope = "check"

    def post(self, request):
        data = request.data
        if "file" in request.FILES:
            data = {"text": _pdf_or_text(request.FILES["file"]), "age_band": request.data.get("age_band", "unknown"),
                    "note": request.data.get("note", "")}
            if request.data.get("session_id"):
                data["session_id"] = int(request.data["session_id"])
        if isinstance(data.get("text"), str) and len(data["text"]) > settings.RXGUARD["MAX_INPUT_CHARS"]:
            return error_response(413, "payload_too_large",
                                  f"Input exceeds {settings.RXGUARD['MAX_INPUT_CHARS']} characters")
        inp = PrescriptionInput.model_validate(dict(data))
        session = _session_for(request, inp.session_id)
        state = pipeline.run_check(request.user.id, inp.text, inp.note, inp.age_band.value, session.id)
        p = Prescription.objects.get(pk=state.prescription_id)
        SessionMessage.objects.create(session=session, role="system", content=f"check prescription {p.id}",
                                      prescription=p, correlation_id=state.correlation_id,
                                      payload={"priority": p.priority, "findings": len(state.findings)})
        body = S.prescription_dict(p)
        body.update(session_id=session.id, safety_messages=state.safety_messages, errors=state.errors,
                    llm_usage=state.budget or {"calls": 0, "input_tokens": 0, "output_tokens": 0})
        return Response(body, status=201)


def _pdf_or_text(f) -> str:
    if f.size > 2 * 1024 * 1024:
        raise pipeline.InputRejected("Uploaded file too large", 413)
    head = f.read(5)
    f.seek(0)
    if head == b"%PDF-":
        import io

        import pdfplumber
        try:
            with pdfplumber.open(io.BytesIO(f.read())) as pdf:
                text = "\n".join((pg.extract_text() or "") for pg in pdf.pages[:10])
        except Exception as e:  # noqa: BLE001
            raise pipeline.InputRejected(f"Could not read PDF: {type(e).__name__}", 400) from e
        if not text.strip():
            raise pipeline.InputRejected("PDF has no text layer (scanned/handwritten PDFs are out of scope)", 400)
        return text
    raw = f.read()
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError as e:
        raise pipeline.InputRejected("File is not UTF-8 text or a text-based PDF", 400) from e


class Explain(RxView):
    throttle_scope = "explain"

    def post(self, request):
        inp = ExplainInput.model_validate(request.data)
        p = get_object_or_404(Prescription, pk=inp.prescription_id)
        state = pipeline.run_explain(request.user.id, p.id)
        p.refresh_from_db()
        body = S.prescription_dict(p)
        body.update(llm_usage=state.budget, errors=state.errors,
                    tool_trace=list(ToolCall.objects.filter(correlation_id=state.correlation_id).values(
                        "tool", "args_summary", "result_summary", "latency_ms", "status")))
        return Response(body)


class TranslateExplanation(RxView):
    def post(self, request, pk: int):
        target_lang = request.data.get("language", "hi")
        p = get_object_or_404(Prescription, pk=pk)

        SEV_MAP = {
            "hi": {
                "Major": "प्रमुख (Major - उच्च जोखिम)",
                "Moderate": "मध्यम (Moderate - निगरानी आवश्यक)",
                "Minor": "मामूली (Minor)",
                "Unknown": "अज्ञात (Unknown)",
            },
            "ml": {
                "Major": "ഗുരുതരം (Major - ഉയർന്ന അപകടസാധ്യത)",
                "Moderate": "മിതമായത് (Moderate - നിരീക്ഷണം ആവശ്യമാണ്)",
                "Minor": "ലഘുവായത് (Minor)",
                "Unknown": "അജ്ഞാതം (Unknown)",
            },
        }

        lang_names = {
            "hi": "हिंदी (Hindi)",
            "ml": "മലയാളം (Malayalam)",
        }

        sev_dict = SEV_MAP.get(target_lang, SEV_MAP["hi"])

        translated_findings = []
        for f in p.findings.all().select_related("drug_a", "drug_b"):
            name_a = f.drug_a.generic_name
            name_b = f.drug_b.generic_name
            sev_trans = sev_dict.get(f.severity, f.severity)

            if target_lang == "ml":
                db_claim = (
                    f"ഡിഡിഇന്റർ (DDInter) ഡാറ്റാബേസ് അനുസരിച്ച് {name_a}, {name_b} എന്നിവ തമ്മിൽ "
                    f"{sev_trans} തരത്തിലുള്ള മരുന്ന് പ്രതിപ്രവർത്തനം രേഖപ്പെടുത്തിയിട്ടുണ്ട്."
                )
                clinical_advice = (
                    "ഐസിഎംആർ (ICMR) മാർഗ്ഗനിർദ്ദേശങ്ങൾ പ്രകാരം രക്തസ്രാവം അല്ലെങ്കിൽ പാർശ്വഫലങ്ങൾ ഒഴിവാക്കാൻ "
                    "ഫാർമസിസ്റ്റിന്റെ അതീവ ജാഗ്രതയും നിരീക്ഷണവും അനിവാര്യമാണ്."
                    if f.severity == "Major"
                    else "രോഗിക്ക് സാധാരണ നിലയിലുള്ള ഔഷധ നിരീക്ഷണം ശുപാർശ ചെയ്യുന്നു."
                )
            else:  # Hindi default
                db_claim = (
                    f"डीडीइंटर (DDInter) डेटाबेस के अनुसार {name_a} और {name_b} के बीच "
                    f"{sev_trans} स्तर की दवा परस्पर क्रिया दर्ज है।"
                )
                clinical_advice = (
                    "आईसीएमआर (ICMR) दिशानिर्देशों के अनुसार रक्तस्राव अथवा दुष्प्रभाव के जोखिम को ध्यान में रखते हुए "
                    "फार्मासिस्ट द्वारा सतर्कता एवं निगरानी आवश्यक है।"
                    if f.severity == "Major"
                    else "रोगी के लिए मानक औषधीय निगरानी की सिफारिश की जाती है।"
                )

            translated_findings.append({
                "finding_id": f.id,
                "ordinal": f.ordinal,
                "drug_a": name_a,
                "drug_b": name_b,
                "severity_en": f.severity,
                "severity_translated": sev_trans,
                "severity_hi": sev_trans,
                "severity_ml": sev_trans,
                "db_claim_translated": db_claim,
                "db_claim_hi": db_claim,
                "db_claim_ml": db_claim,
                "clinical_advice_translated": clinical_advice,
                "clinical_advice_hi": clinical_advice,
                "clinical_advice_ml": clinical_advice,
            })

        if target_lang == "ml":
            summary = (
                f"ഈ കുറിപ്പടിയിൽ ആകെ {len(translated_findings)} മരുന്ന് പ്രതിപ്രവർത്തനങ്ങൾ കണ്ടെത്തി. "
                f"രോഗിയുടെ സുരക്ഷയ്ക്കായി ഫാർമസിസ്റ്റിന്റെ പരിശോധന നിർബന്ധമാണ്."
            )
        else:
            summary = (
                f"इस नुस्खे में कुल {len(translated_findings)} परस्पर क्रियाएं पाई गईं। "
                f"रोगी सुरक्षा हेतु फार्मासिस्ट सत्यापन अनिवार्य है।"
            )

        return Response({
            "prescription_id": p.id,
            "language": target_lang,
            "target_language": target_lang,
            "language_name": lang_names.get(target_lang, target_lang),
            "translated_findings": translated_findings,
            "summary_translated": summary,
            "summary_hi": summary,
            "summary_ml": summary,
        })


class Ask(RxView):
    throttle_scope = "ask"

    def post(self, request):
        inp = AskInput.model_validate(request.data)
        session = get_object_or_404(Session, pk=inp.session_id, user=request.user)
        return Response(ask_mode.run_ask(request.user, session, inp.question))


class SessionView(RxView):
    def post(self, request):
        s = Session.objects.create(user=request.user)
        return Response({"session_id": s.id}, status=201)

    def get(self, request, session_id):
        s = get_object_or_404(Session, pk=session_id, user=request.user)
        return Response({"session_id": s.id, "messages": [
            {"role": m.role, "content": m.content, "prescription_id": m.prescription_id, "payload": m.payload,
             "correlation_id": m.correlation_id, "created_at": m.created_at.isoformat()} for m in s.messages.all()]})


class PrescriptionList(RxView):
    def get(self, request):
        from engine.triage import RANK
        qs = Prescription.objects.select_related("kb_version").order_by("-id")[:200]
        rows = [S.queue_row(p) for p in qs]
        open_first = {"AWAITING_PHARMACIST": 0, "IN_REVIEW": 1, "CHECKED": 2, "REVIEWED": 3, "CLEAR": 4}
        rows.sort(key=lambda r: (open_first.get(r["status"], 5), RANK.get(r["priority"], 9), -r["id"]))
        return Response({"results": rows})


class PrescriptionDetail(RxView):
    def get(self, request, pk):
        return Response(S.prescription_dict(get_object_or_404(Prescription, pk=pk)))


class PrescriptionComplete(RxView):
    def post(self, request, pk):
        p = get_object_or_404(Prescription, pk=pk)
        try:
            review.complete_review(request.user, p)
        except review.GateNotMet as e:
            return error_response(409, "review_gate_not_met", "Every P1 finding needs a recorded pharmacist action "
                                                              "and every unresolved item needs confirmation first.",
                                  {"reasons": e.reasons})
        p.refresh_from_db()
        return Response(S.prescription_dict(p))


class ConfirmItem(RxView):
    def post(self, request, pk, item_id):
        p = get_object_or_404(Prescription, pk=pk)
        item = get_object_or_404(PrescriptionItem, pk=item_id, prescription=p)
        inp = ConfirmItemInput.model_validate(request.data)
        drug = get_object_or_404(Drug, pk=inp.drug_id, kb_version=p.kb_version) if inp.drug_id else None
        review.confirm_item(request.user, p, item, drug, inp.not_in_database)
        p.refresh_from_db()
        return Response(S.prescription_dict(p))


class FindingDetail(RxView):
    """Prove Why: finding -> claims -> DB record / chunk -> document -> version -> verifier -> correlation ID."""

    def get(self, request, pk):
        f = get_object_or_404(InteractionFinding.objects.select_related("prescription", "interaction", "kb_version"),
                              pk=pk)
        p = f.prescription
        e = S.latest_explanation(p)
        claims = []
        if e:
            for c in e.claims.filter(finding=f).select_related("interaction__drug_a", "interaction__drug_b",
                                                                "interaction__kb_version", "chunk__document",
                                                                "finding").order_by("id"):
                claims.append(S.claim_dict(c))
        i = f.interaction
        source_file = "ddinter_downloads_code_A-V.csv (DDInter 1.0 Dataset)"
        if i.source and ("upload" in i.source.lower() or ".csv" in i.source.lower()):
            source_file = i.source.replace("Pharmacist Upload: ", "")
        elif i.source and i.source != "DDInter":
            source_file = f"{i.source}.csv"

        return Response({
            "finding": S.finding_dict(f, S._kb_current()),
            "prescription_id": p.id,
            "database_record": {"interaction_id": i.id, "drug_a": i.drug_a.generic_name, "drug_a_ddinter_id":
                                i.drug_a.ddinter_id, "drug_b": i.drug_b.generic_name,
                                "drug_b_ddinter_id": i.drug_b.ddinter_id, "severity": i.severity, "source": i.source,
                                "source_record_id": i.source_record_id, "source_file": source_file, "kb_version": i.kb_version.label,
                                "table": "drug_interactions"},
            "sources": list(DataSource.objects.filter(kb_version=f.kb_version, name__icontains="DDInter").values(
                "name", "version", "license", "url", "retrieved_at", "checksum")),
            "explanation": None if e is None else {
                "id": e.id, "mode": e.mode, "model": e.model, "prompt_version": e.prompt_version,
                "correlation_id": e.correlation_id, "fallback_level": e.fallback_level},
            "claims_kept": [c for c in claims if c["kept"]],
            "claims_dropped": [{"claim_id": c["claim_id"], "text_hidden": True, "reason": c["drop_reason"]}
                               for c in claims if not c["kept"]],
            "check_correlation_id": p.correlation_id,
            "trace": {
                "tool_calls": list(ToolCall.objects.filter(
                    correlation_id__in=[p.correlation_id] + ([e.correlation_id] if e else [])).values(
                    "tool", "args_summary", "result_summary", "latency_ms", "status", "correlation_id")),
                "llm_calls": list(LlmCall.objects.filter(
                    correlation_id__in=[p.correlation_id] + ([e.correlation_id] if e else [])).values(
                    "node", "model", "prompt_version", "input_tokens", "output_tokens", "status", "fallback_level",
                    "latency_ms")),
            },
        })


class Reviews(RxView):
    def post(self, request, finding_id):
        inp = ReviewAction.model_validate(request.data)
        if inp.target == "duplication":
            d = get_object_or_404(DuplicationFinding, pk=finding_id)
            review.record_review(request.user, d.prescription, inp.action.value, inp.note, duplication=d)
            p = d.prescription
        else:
            f = get_object_or_404(InteractionFinding, pk=finding_id)
            review.record_review(request.user, f.prescription, inp.action.value, inp.note, finding=f)
            p = f.prescription
        p.refresh_from_db()
        return Response(S.prescription_dict(p), status=201)


class Escalations(RxView):
    def post(self, request):
        inp = EscalationRequest.model_validate(request.data)
        if inp.prescription_id:
            get_object_or_404(Prescription, pk=inp.prescription_id)
        if inp.session_id:
            get_object_or_404(Session, pk=inp.session_id, user=request.user)
        res = run_tool("escalate", tool3.escalate, dict(
            reason_code=inp.reason_code.value, trigger_rule_id=inp.trigger_rule_id, detail=inp.detail,
            prescription_id=inp.prescription_id, session_id=inp.session_id, created_by=f"user:{request.user.id}"))
        if inp.prescription_id:
            audit.append(Prescription.objects.get(pk=inp.prescription_id), "escalation_raised",
                         f"escalation:{res['escalation_id']}", {"reason_code": inp.reason_code.value,
                                                                "detail": inp.detail}, actor=f"user:{request.user.id}")
        return Response(S.escalation_dict(Escalation.objects.get(pk=res["escalation_id"])), status=201)


class AuditTrail(RxView):
    def get(self, request, prescription_id):
        p = get_object_or_404(Prescription, pk=prescription_id)
        page = max(1, int(request.query_params.get("page", 1)))
        size = min(200, max(1, int(request.query_params.get("page_size", 50))))
        return Response(S.audit_rows(p, page, size))


class AuditVerify(RxView):
    def get(self, request, prescription_id):
        get_object_or_404(Prescription, pk=prescription_id)
        return Response({"prescription_id": prescription_id, **audit.verify(prescription_id)})


class AgentSteps(RxView):
    def get(self, request, prescription_id):
        steps = AgentStep.objects.filter(prescription_id=prescription_id).order_by("id")
        return Response({"steps": [{"id": s.id, "graph": s.graph, "node": s.node, "status": s.status,
                                    "latency_ms": round(s.latency_ms, 1), "summary": s.summary,
                                    "correlation_id": s.correlation_id} for s in steps]})


class DrugSearch(RxView):
    def get(self, request):
        q = request.query_params.get("q", "").strip()
        kb = KbVersion.objects.get(is_current=True)
        if len(q) < 2:
            return Response({"results": []})
        idx = normalize.get_alias_index(kb)
        cands = normalize.fuzzy_candidates(idx, q, limit=8)
        direct = Drug.objects.filter(kb_version=kb, normalized_name__startswith=normalize.normalize_text(q))[:8]
        seen, out = set(), []
        for d in direct:
            seen.add(d.id)
            out.append({"drug_id": d.id, "name": d.generic_name, "score": 100.0, "nlem_listed": d.nlem_listed})
        for c in cands:
            if c["drug_id"] not in seen:
                out.append({**c, "nlem_listed": None})
        return Response({"results": out[:10]})


class KbInfo(RxView):
    def get(self, request):
        kb = KbVersion.objects.filter(is_current=True).first()
        if not kb:
            return Response({"kb_version": None})
        return Response({
            "kb_version": kb.label, "loaded_at": kb.loaded_at.isoformat(), "notes": kb.notes,
            "counts": {"drugs": Drug.objects.filter(kb_version=kb).count(),
                       "aliases": DrugAlias.objects.filter(kb_version=kb).count(),
                       "interactions": kb.druginteraction_set.count(),
                       "documents": CorpusDocument.objects.filter(kb_version=kb).count()},
            "sources": list(kb.sources.values("name", "version", "license", "url", "retrieved_at", "checksum",
                                              "is_synthetic", "notes")),
            "all_versions": list(KbVersion.objects.order_by("id").values("label", "loaded_at", "is_current"))})


class DemoPrescriptions(RxView):
    def get(self, request):
        from api.demo import DEMO_CASES
        return Response({"results": DEMO_CASES, "label": "SYNTHETIC DEMO DATA"})


class UploadInteractions(RxView):
    def post(self, request):
        kb = KbVersion.objects.filter(is_current=True).first()
        if not kb:
            return Response({"error": "No active KB version available"}, status=400)

        csv_file = request.FILES.get("file")
        csv_text = request.data.get("csv_text", "")
        source_name = request.data.get("source", "Pharmacist_Upload").strip() or "Pharmacist_Upload"

        if csv_file:
            try:
                raw_bytes = csv_file.read()
                csv_text = raw_bytes.decode("utf-8-sig")
            except UnicodeDecodeError:
                csv_text = raw_bytes.decode("latin-1")
            filename = csv_file.name
        else:
            if not csv_text.strip():
                return Response({"error": "No CSV file or csv_text provided"}, status=400)
            raw_bytes = csv_text.encode("utf-8")
            filename = "pharmacist_direct_entry.csv"

        f = io.StringIO(csv_text.strip())
        reader = csv.reader(f)
        try:
            raw_headers = next(reader)
        except StopIteration:
            return Response({"error": "CSV file is empty"}, status=400)

        headers = [h.strip().lower().replace(" ", "_") for h in raw_headers]

        col_map = {}
        for idx, h in enumerate(headers):
            if h in ("drug_a", "drug1", "druga", "medication_a", "medication1", "molecule_a", "drug_1"):
                col_map["drug_a"] = idx
            elif h in ("drug_b", "drug2", "drugb", "medication_b", "medication2", "molecule_b", "drug_2"):
                col_map["drug_b"] = idx
            elif h in ("severity", "severity_level", "level", "risk", "grade"):
                col_map["severity"] = idx
            elif h in ("notes", "description", "details", "clinical_effect", "effect", "comment"):
                col_map["notes"] = idx
            elif h in ("source_record_id", "record_id", "id"):
                col_map["record_id"] = idx

        if "drug_a" not in col_map or "drug_b" not in col_map:
            return Response({
                "error": "CSV must contain columns for both drugs (e.g., 'drug_a,drug_b,severity' or 'drug1,drug2,severity')",
                "detected_headers": raw_headers,
            }, status=400)

        added_count = 0
        updated_count = 0
        new_drugs_created = 0
        total_rows = 0
        sample_results = []

        SEV_MAP = {
            "major": "Major",
            "severe": "Major",
            "high": "Major",
            "contraindicated": "Major",
            "moderate": "Moderate",
            "medium": "Moderate",
            "monitor": "Moderate",
            "minor": "Minor",
            "low": "Minor",
            "unknown": "Unknown",
        }

        drug_cache = {d.normalized_name: d for d in Drug.objects.filter(kb_version=kb)}

        with transaction.atomic():
            for row_idx, row in enumerate(reader, start=2):
                if not row or len(row) <= max(col_map["drug_a"], col_map["drug_b"]):
                    continue
                name_a = row[col_map["drug_a"]].strip()
                name_b = row[col_map["drug_b"]].strip()
                if not name_a or not name_b:
                    continue

                total_rows += 1
                raw_sev = row[col_map["severity"]].strip().lower() if "severity" in col_map and len(row) > col_map["severity"] else "moderate"
                sev = SEV_MAP.get(raw_sev, "Moderate")
                notes = row[col_map["notes"]].strip() if "notes" in col_map and len(row) > col_map["notes"] else ""
                rec_id = row[col_map["record_id"]].strip() if "record_id" in col_map and len(row) > col_map["record_id"] else f"UP-{row_idx}"

                norm_a = normalize.normalize_text(name_a)
                norm_b = normalize.normalize_text(name_b)

                drug_a_obj = drug_cache.get(norm_a)
                if not drug_a_obj:
                    drug_a_obj, created = Drug.objects.get_or_create(
                        kb_version=kb,
                        normalized_name=norm_a,
                        defaults={
                            "generic_name": name_a.title(),
                            "source": source_name,
                            "nlem_listed": False,
                        },
                    )
                    if created:
                        new_drugs_created += 1
                        DrugAlias.objects.get_or_create(
                            kb_version=kb,
                            drug=drug_a_obj,
                            alias=name_a,
                            alias_normalized=norm_a,
                            defaults={"alias_type": "generic", "source": source_name},
                        )
                    drug_cache[norm_a] = drug_a_obj

                drug_b_obj = drug_cache.get(norm_b)
                if not drug_b_obj:
                    drug_b_obj, created = Drug.objects.get_or_create(
                        kb_version=kb,
                        normalized_name=norm_b,
                        defaults={
                            "generic_name": name_b.title(),
                            "source": source_name,
                            "nlem_listed": False,
                        },
                    )
                    if created:
                        new_drugs_created += 1
                        DrugAlias.objects.get_or_create(
                            kb_version=kb,
                            drug=drug_b_obj,
                            alias=name_b,
                            alias_normalized=norm_b,
                            defaults={"alias_type": "generic", "source": source_name},
                        )
                    drug_cache[norm_b] = drug_b_obj

                if drug_a_obj.id == drug_b_obj.id:
                    continue

                d_min, d_max = (drug_a_obj, drug_b_obj) if drug_a_obj.id < drug_b_obj.id else (drug_b_obj, drug_a_obj)

                existing = DrugInteraction.objects.filter(
                    kb_version=kb,
                    drug_a=d_min,
                    drug_b=d_max,
                ).first()

                if existing:
                    existing.severity = sev
                    existing.source = source_name
                    if notes:
                        existing.source_record_id = notes[:64]
                    existing.save(update_fields=["severity", "source", "source_record_id"])
                    updated_count += 1
                    status_label = "updated"
                else:
                    DrugInteraction.objects.create(
                        kb_version=kb,
                        drug_a=d_min,
                        drug_b=d_max,
                        severity=sev,
                        source=source_name,
                        source_record_id=notes[:64] if notes else rec_id,
                    )
                    added_count += 1
                    status_label = "added"

                if len(sample_results) < 8:
                    sample_results.append({
                        "drug_a": d_min.generic_name,
                        "drug_b": d_max.generic_name,
                        "severity": sev,
                        "status": status_label,
                        "notes": notes,
                    })

            DataSource.objects.create(
                kb_version=kb,
                name=f"Pharmacist Upload: {filename}",
                version=timezone.now().strftime("%Y.%m.%d-%H%M"),
                license="Hospital Internal Formulary / Clinical Dataset",
                url="",
                retrieved_at=timezone.now(),
                checksum=hashlib.sha256(raw_bytes).hexdigest() if raw_bytes else "",
                is_synthetic=False,
                notes=f"Uploaded by {request.user.username if request.user else 'pharmacist'}: {added_count} new, {updated_count} updated, {new_drugs_created} new drugs registered.",
            )

        interaction_lookup.clear_cache()
        normalize.clear_cache()

        return Response({
            "status": "success",
            "kb_version": kb.label,
            "total_rows_parsed": total_rows,
            "added_interactions": added_count,
            "updated_interactions": updated_count,
            "new_drugs_created": new_drugs_created,
            "total_interactions_now": kb.druginteraction_set.count(),
            "sample": sample_results,
        })


class UploadGuidelines(RxView):
    def post(self, request):
        kb = KbVersion.objects.filter(is_current=True).first()
        if not kb:
            return Response({"error": "No active KB version available"}, status=400)

        file_obj = request.FILES.get("file")
        raw_text = request.data.get("csv_text", "")
        title = request.data.get("title", "").strip() or "Hospital Clinical Guideline"
        doc_type = request.data.get("doc_type", "GUIDELINE").strip() or "GUIDELINE"
        source = request.data.get("source", "Pharmacist_Upload").strip() or "Pharmacist_Upload"
        version_str = request.data.get("version", timezone.now().strftime("%Y.%m")).strip()

        if file_obj:
            raw_bytes = file_obj.read()
            filename = file_obj.name
            try:
                raw_text = raw_bytes.decode("utf-8-sig")
            except UnicodeDecodeError:
                raw_text = raw_bytes.decode("latin-1")
        else:
            if not raw_text.strip():
                return Response({"error": "No guideline file or text provided"}, status=400)
            raw_bytes = raw_text.encode("utf-8")
            filename = f"{title.lower().replace(' ', '_')}.txt"

        checksum = hashlib.sha256(raw_bytes).hexdigest() if raw_bytes else ""

        with transaction.atomic():
            doc = CorpusDocument.objects.create(
                kb_version=kb,
                title=title,
                doc_type=doc_type,
                source=source,
                version=version_str,
                license="Hospital Clinical Protocol / Clinical Guideline",
                url="",
                file_name=filename,
                checksum=checksum,
            )

            chunks_created = 0
            mentions_created = 0
            sample_chunks = []

            first_line = raw_text.strip().split("\n")[0] if raw_text.strip() else ""
            is_csv = "," in first_line or "\t" in first_line

            all_drugs = list(Drug.objects.filter(kb_version=kb))
            drug_map = {d.normalized_name: d for d in all_drugs}

            if is_csv:
                f = io.StringIO(raw_text.strip())
                reader = csv.reader(f)
                headers = [h.strip().lower().replace(" ", "_") for h in next(reader, [])]
                sec_idx = next((i for i, h in enumerate(headers) if h in ("section", "topic", "category", "heading", "title")), None)
                text_idx = next((i for i, h in enumerate(headers) if h in ("text", "content", "guideline", "recommendation", "excerpt")), None)
                drugs_idx = next((i for i, h in enumerate(headers) if h in ("drugs", "medications", "molecules", "mentions")), None)

                if text_idx is None:
                    text_idx = 1 if len(headers) > 1 else 0

                for r_idx, row in enumerate(reader, start=1):
                    if not row or len(row) <= text_idx:
                        continue
                    text_content = row[text_idx].strip()
                    if not text_content:
                        continue
                    section_name = row[sec_idx].strip() if sec_idx is not None and len(row) > sec_idx else f"Section {r_idx}"
                    specified_drugs = row[drugs_idx].split(",") if drugs_idx is not None and len(row) > drugs_idx else []

                    chunk = CorpusChunk.objects.create(
                        document=doc,
                        section_path=section_name[:390],
                        page=r_idx,
                        text=text_content,
                        text_hash=hashlib.sha256(text_content.encode("utf-8")).hexdigest(),
                    )
                    chunks_created += 1

                    tagged_names = []
                    for sd in specified_drugs:
                        name_clean = sd.strip()
                        if not name_clean:
                            continue
                        norm = normalize.normalize_text(name_clean)
                        drug = drug_map.get(norm)
                        if not drug:
                            drug, _ = Drug.objects.get_or_create(
                                kb_version=kb,
                                normalized_name=norm,
                                defaults={
                                    "generic_name": name_clean.title(),
                                    "source": source,
                                    "nlem_listed": False,
                                },
                            )
                            drug_map[norm] = drug
                            all_drugs.append(drug)
                        _, m_created = ChunkDrugMention.objects.get_or_create(chunk=chunk, drug=drug, defaults={"via": "direct"})
                        if m_created:
                            mentions_created += 1
                            tagged_names.append(drug.generic_name)

                    lower_text = text_content.lower()
                    for d in all_drugs:
                        if len(d.generic_name) > 3 and d.generic_name.lower() in lower_text:
                            _, m_created = ChunkDrugMention.objects.get_or_create(chunk=chunk, drug=d, defaults={"via": "direct"})
                            if m_created:
                                mentions_created += 1
                                if d.generic_name not in tagged_names:
                                    tagged_names.append(d.generic_name)

                    if len(sample_chunks) < 5:
                        sample_chunks.append({
                            "section": section_name,
                            "text_preview": text_content[:120] + "...",
                            "drugs_tagged": tagged_names[:6],
                        })
            else:
                paragraphs = [p.strip() for p in raw_text.split("\n\n") if p.strip()]
                for p_idx, para in enumerate(paragraphs, start=1):
                    chunk = CorpusChunk.objects.create(
                        document=doc,
                        section_path=f"{title} - Part {p_idx}"[:390],
                        page=p_idx,
                        text=para,
                        text_hash=hashlib.sha256(para.encode("utf-8")).hexdigest(),
                    )
                    chunks_created += 1
                    tagged_names = []
                    lower_text = para.lower()
                    for d in all_drugs:
                        if len(d.generic_name) > 3 and d.generic_name.lower() in lower_text:
                            _, m_created = ChunkDrugMention.objects.get_or_create(chunk=chunk, drug=d, defaults={"via": "direct"})
                            if m_created:
                                mentions_created += 1
                                tagged_names.append(d.generic_name)

                    if len(sample_chunks) < 5:
                        sample_chunks.append({
                            "section": f"Part {p_idx}",
                            "text_preview": para[:120] + "...",
                            "drugs_tagged": tagged_names[:6],
                        })

        return Response({
            "status": "success",
            "document_id": doc.id,
            "document_title": doc.title,
            "doc_type": doc.doc_type,
            "chunks_created": chunks_created,
            "drug_mentions_tagged": mentions_created,
            "sample_chunks": sample_chunks,
        })


class DatasetTemplates(RxView):
    def get(self, request):
        interactions_template = (
            "drug_a,drug_b,severity,notes\n"
            "Amiodarone,Ciprofloxacin,Major,High risk of QT prolongation and torsades de pointes ventricular arrhythmia\n"
            "Metformin,Iodinated Contrast,Major,Risk of fatal lactic acidosis and acute nephrotoxicity\n"
            "Warfarin,Tramadol,Moderate,Elevated INR and increased bleeding risk\n"
            "Levothyroxine,Calcium Carbonate,Moderate,Decreased levothyroxine gastrointestinal absorption\n"
            "Atorvastatin,Clarithromycin,Major,Marked increase in statin plasma concentration; risk of rhabdomyolysis\n"
        )
        guidelines_template = (
            "section,text,drugs\n"
            "Cardiology - QT Risk Protocol,Concomitant administration of Amiodarone and Ciprofloxacin markedly increases the risk of QT interval prolongation and torsades de pointes ventricular arrhythmia. Concurrent use is contraindicated or requires continuous telemetry monitoring with electrolyte correction.,Amiodarone, Ciprofloxacin\n"
            "Endocrinology - Metformin & Radiocontrast,Patients receiving Metformin must withhold medication at the time of or prior to iodinated radiocontrast imaging procedures and for 48 hours post-procedure due to acute renal failure and fatal lactic acidosis risk.,Metformin\n"
            "Hematology - Warfarin Potentiation,Tramadol inhibits CYP2D6 and may enhance the hypoprothrombinemic effect of Warfarin. Monitor INR closely within 3 to 5 days of initiation.,Warfarin, Tramadol\n"
        )
        return Response({
            "interactions_template": interactions_template,
            "guidelines_template": guidelines_template,
        })


# ------------------------------------------------------------------------------ metrics
def _pct(values, p):
    if not values:
        return None
    v = sorted(values)
    k = (len(v) - 1) * p / 100
    lo, hi = int(k), min(int(k) + 1, len(v) - 1)
    return round(v[lo] + (v[hi] - v[lo]) * (k - lo), 1)


class CostMetrics(RxView):
    def get(self, request):
        since = request.query_params.get("since_hours")
        reqs = RequestLog.objects.filter(endpoint__in=["/api/v1/check", "/api/v1/explain", "/api/v1/ask"],
                                         status_code__lt=400)
        calls = LlmCall.objects.all()
        if since:
            t = timezone.now() - timezone.timedelta(hours=float(since))
            reqs, calls = reqs.filter(created_at__gte=t), calls.filter(created_at__gte=t)
        per_query = {cid: Decimal(0) for cid in reqs.values_list("correlation_id", flat=True)}
        tokens = {cid: 0 for cid in per_query}
        for c in calls.filter(correlation_id__in=list(per_query)).values("correlation_id", "est_cost_usd",
                                                                          "input_tokens", "output_tokens"):
            per_query[c["correlation_id"]] += c["est_cost_usd"]
            tokens[c["correlation_id"]] += c["input_tokens"] + c["output_tokens"]
        costs = [float(v) for v in per_query.values()]
        by_endpoint = {}
        for ep in ("/api/v1/check", "/api/v1/explain", "/api/v1/ask"):
            ids = list(reqs.filter(endpoint=ep).values_list("correlation_id", flat=True))
            vals = [float(per_query[i]) for i in ids]
            by_endpoint[ep] = {"queries": len(ids), "mean_usd": round(statistics.mean(vals), 6) if vals else None,
                               "p95_usd": _pct(vals, 95) if vals else None,
                               "zero_token_share": round(sum(1 for i in ids if tokens[i] == 0) / len(ids), 3)
                               if ids else None}
        agg = calls.aggregate(i=Sum("input_tokens"), o=Sum("output_tokens"), c=Sum("est_cost_usd"))
        return Response({
            "queries": len(costs), "mean_usd": round(statistics.mean(costs), 6) if costs else None,
            "p95_usd": round(sorted(costs)[int(0.95 * (len(costs) - 1))], 6) if costs else None,
            "zero_token_share": round(sum(1 for v in tokens.values() if v == 0) / len(tokens), 3) if tokens else None,
            "by_endpoint": by_endpoint, "total_input_tokens": agg["i"] or 0, "total_output_tokens": agg["o"] or 0,
            "total_usd": float(agg["c"] or 0),
            "cap": {"max_calls_per_query": settings.RXGUARD["LLM_MAX_CALLS_PER_QUERY"],
                    "max_input_tokens_per_query": settings.RXGUARD["LLM_MAX_INPUT_TOKENS_PER_QUERY"],
                    "max_output_tokens_per_call": settings.RXGUARD["LLM_MAX_OUTPUT_TOKENS_PER_CALL"]},
            "prices_usd_per_mtok": settings.RXGUARD["LLM_PRICES"],
            "models": {"primary": settings.RXGUARD["LLM_PRIMARY_MODEL"],
                       "fallback": settings.RXGUARD["LLM_FALLBACK_MODEL"]}})


class LatencyMetrics(RxView):
    def get(self, request):
        since = request.query_params.get("since_minutes")
        qs = RequestLog.objects.all()
        if since:
            qs = qs.filter(created_at__gte=timezone.now() - timezone.timedelta(minutes=float(since)))
        out = {}
        for ep in qs.values_list("endpoint", flat=True).distinct():
            rows = list(qs.filter(endpoint=ep).values_list("latency_ms", "status_code", "created_at"))
            lat = [r[0] for r in rows]
            span = (max(r[2] for r in rows) - min(r[2] for r in rows)).total_seconds() if len(rows) > 1 else 0
            out[ep] = {"count": len(rows), "p50_ms": _pct(lat, 50), "p95_ms": _pct(lat, 95), "p99_ms": _pct(lat, 99),
                       "error_rate_5xx": round(sum(1 for r in rows if r[1] >= 500) / len(rows), 4),
                       "rps": round(len(rows) / span, 2) if span else None}
        return Response({"endpoints": out, "targets": {"/api/v1/check": {"p95_ms": 1500},
                                                       "/api/v1/explain": {"p95_ms": 8000}}})


class Overview(RxView):
    def get(self, request):
        reqs = RequestLog.objects.filter(endpoint__startswith="/api/v1/")
        total = reqs.count()
        calls = LlmCall.objects.all()
        return Response({
            "requests": total,
            "success_rate": round(reqs.filter(status_code__lt=400).count() / total, 4) if total else None,
            "errors_5xx": reqs.filter(status_code__gte=500).count(),
            "llm_calls": calls.exclude(model="(simulated)").count(),
            "llm_calls_by_status": dict(calls.values_list("status").annotate(n=Count("id")).values_list("status", "n")),
            "fallback_activations": calls.filter(Q(fallback_level__gte=1) | ~Q(status="ok")).count(),
            "template_explanations": __import__("api.models", fromlist=["Explanation"]).Explanation.objects.filter(
                mode="template").count(),
            "retrieval_failures": ToolCall.objects.filter(tool="guideline_search").exclude(status="ok").count(),
            "degraded_retrievals": ToolCall.objects.filter(tool="guideline_search",
                                                           result_summary__contains="degraded=True").count(),
            "injection_attempts": Prescription.objects.filter(injection_flag=True).count(),
            "escalations": dict(Escalation.objects.values_list("reason_code").annotate(n=Count("id")).values_list(
                "reason_code", "n")),
            "latest_eval": EvaluationRun.objects.order_by("-id").values("id", "prompt_version", "kb_version",
                                                                         "llm_mode", "summary", "created_at").first(),
        })


# ------------------------------------------------------------------------------ health
def healthz(request):
    return JsonResponse({"status": "ok"})


def readyz(request):
    """MySQL, FAISS index and KB version. Never calls the LLM."""
    checks = {}
    try:
        with connection.cursor() as c:
            c.execute("SELECT 1")
        checks["database"] = {"ok": True, "vendor": connection.vendor}
        kb = KbVersion.objects.filter(is_current=True).first()
        checks["kb_version"] = {"ok": kb is not None, "label": kb.label if kb else None}
        if kb:
            ok, detail = retrieval.index_ready(kb.label)
            checks["faiss_index"] = {"ok": ok, "detail": detail, "fallback": None if ok else "mysql_fulltext"}
    except Exception as e:  # noqa: BLE001
        checks["database"] = {"ok": False, "error": type(e).__name__}
    ready = checks.get("database", {}).get("ok") and checks.get("kb_version", {}).get("ok")
    return JsonResponse({"status": "ready" if ready else "not_ready", "checks": checks}, status=200 if ready else 503)
