"""REST endpoints (spec section 18.3). All requests and AI outputs are validated with Pydantic."""
from __future__ import annotations

import csv
import statistics
import threading
from decimal import Decimal

from django.conf import settings
from django.contrib.auth import authenticate
from django.db import connection
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

from api import serializers as S
from api.errors import error_response
from api.models import (AgentStep, CorpusDocument, DataSource, Drug, DrugAlias, DuplicationFinding, Escalation,
                        EvaluationRun, InteractionFinding, KbVersion, LlmCall, Prescription, PrescriptionItem,
                        RequestLog, Session, SessionMessage, ToolCall)
from api.permissions import is_admin
from engine import ask as ask_mode
from engine import audit, context, normalize, pipeline, retrieval, review
from engine.schemas import (AskInput, ConfirmItemInput, EscalationRequest, ExplainInput, PrescriptionInput,
                            ReviewAction)
from engine.tools import escalate as tool3
from engine.tools import interaction_lookup
from engine.tools.base import run_tool
from kbload import uploads


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
    """Fixed Hindi / Malayalam wording of each finding's DATABASE claim (no LLM, no advice).

    Only the stored fact is rendered: source, both drug names (Latin script) and severity. Nothing here adds
    clinical guidance or cites a guideline; guideline text and AI claims stay in English unless they go
    through a verified translation path.
    """
    SEVERITY = {
        "hi": {"Major": "प्रमुख (Major)", "Moderate": "मध्यम (Moderate)", "Minor": "मामूली (Minor)",
               "Unknown": "अज्ञात (Unknown)"},
        "ml": {"Major": "ഗുരുതരം (Major)", "Moderate": "മിതമായത് (Moderate)", "Minor": "ലഘുവായത് (Minor)",
               "Unknown": "അജ്ഞാതം (Unknown)"},
    }
    NAMES = {"hi": "हिंदी (Hindi)", "ml": "മലയാളം (Malayalam)"}

    def post(self, request, pk: int):
        lang = request.data.get("language")
        if lang not in self.SEVERITY:
            return error_response(400, "validation_error", "language must be 'hi' or 'ml'.")
        p = get_object_or_404(Prescription, pk=pk)
        rows = []
        for f in p.findings.all().select_related("drug_a", "drug_b").order_by("ordinal"):
            a, b = f.drug_a.generic_name, f.drug_b.generic_name
            src = interaction_lookup.source_label(f.source)
            sev = self.SEVERITY[lang].get(f.severity, f.severity)
            claim = (f"{src} में {a} और {b} के बीच {sev} परस्पर क्रिया दर्ज है।" if lang == "hi" else
                     f"{src}-ൽ {a}, {b} എന്നിവ തമ്മിൽ {sev} പ്രതിപ്രവർത്തനം രേഖപ്പെടുത്തിയിട്ടുണ്ട്.")
            rows.append({"finding_id": f.id, "ordinal": f.ordinal, "drug_a": a, "drug_b": b,
                         "severity_en": f.severity, "severity_translated": sev, "db_claim_translated": claim,
                         "db_claim_en": interaction_lookup.db_claim_text(a, b, f.severity, f.source)})
        n = len(rows)
        summary = (f"इस नुस्खे में {n} परस्पर क्रियाएँ दर्ज हैं।" if lang == "hi" else
                   f"ഈ കുറിപ്പടിയിൽ {n} പ്രതിപ്രവർത്തനങ്ങൾ രേഖപ്പെടുത്തിയിട്ടുണ്ട്.")
        return Response({"prescription_id": p.id, "language": lang, "language_name": self.NAMES[lang],
                         "translated_findings": rows, "summary_translated": summary,
                         "notice": "Fixed translation of the database record only. The English text is the "
                                   "reference."})


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


_DDINTER_FILES: dict[str, list[str]] | None = None
_DDINTER_LOCK = threading.Lock()


def _ddinter_files(record_id: str) -> list[str]:
    """DDInter category CSVs that contain this record (ordered DDInter-ID pair, e.g. 'DDInter1951|DDInter20').
    The raw files are read once per process; a pair can appear in several ATC category files."""
    global _DDINTER_FILES
    with _DDINTER_LOCK:
        if _DDINTER_FILES is None:
            found: dict[str, list[str]] = {}
            raw_dir = settings.REPO_ROOT / "data" / "raw" / "ddinter"
            for path in sorted(raw_dir.glob("ddinter_downloads_code_*.csv")):
                with open(path, encoding="utf-8", errors="replace", newline="") as fp:
                    for row in csv.DictReader(fp):
                        a, b = row.get("DDInterID_A"), row.get("DDInterID_B")
                        if a and b:
                            files = found.setdefault("|".join(sorted((a, b))), [])
                            if path.name not in files:
                                files.append(path.name)
            _DDINTER_FILES = found
    return _DDINTER_FILES.get(record_id, [])


def _source_file(i) -> tuple[str, list[dict]]:
    """(file the interaction row came from, its data_sources rows) for Prove Why."""
    fields = ("name", "version", "license", "url", "retrieved_at", "checksum")
    if interaction_lookup.source_label(i.source) == "DDInter":
        files = _ddinter_files(i.source_record_id)
        name = ", ".join(files) if files else "raw file not available on this server"
        return f"{name} (DDInter 1.0)", list(DataSource.objects.filter(
            kb_version=i.kb_version, name__icontains="DDInter").values(*fields))
    sha = i.source_record_id.split("#", 1)[0]
    src = DataSource.objects.filter(kb_version=i.kb_version, checksum__startswith=sha).values(*fields) if sha else []
    src = list(src)
    return (src[0]["name"].split(": ", 1)[-1] if src else "uploaded file (record not found)"), src


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
        source_file, sources = _source_file(i)

        return Response({
            "finding": S.finding_dict(f, S._kb_current()),
            "prescription_id": p.id,
            "database_record": {"interaction_id": i.id, "drug_a": i.drug_a.generic_name, "drug_a_ddinter_id":
                                i.drug_a.ddinter_id, "drug_b": i.drug_b.generic_name,
                                "drug_b_ddinter_id": i.drug_b.ddinter_id, "severity": i.severity, "source": i.source,
                                "source_record_id": i.source_record_id, "source_file": source_file, "kb_version": i.kb_version.label,
                                "table": "drug_interactions"},
            "sources": sources,
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


class _UploadView(RxView):
    """Admin-only knowledge-base uploads. Validation and safety rules live in kbload/uploads.py."""

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        if not is_admin(request.user):
            from rest_framework.exceptions import PermissionDenied
            raise PermissionDenied("Only administrators can change the knowledge base.")

    def handle_upload(self, request, default_name: str, ingest):
        kb = KbVersion.objects.filter(is_current=True).first()
        if not kb:
            return error_response(503, "kb_unavailable", "No current knowledge-base version.")
        try:
            f = request.FILES.get("file")
            if f:
                if f.size > uploads.MAX_BYTES:
                    raise uploads.UploadError("upload_too_large", "Uploads are limited to 2 MB.")
                raw, name = f.read(), f.name
            else:
                text = request.data.get("csv_text", "")
                if not text.strip():
                    raise uploads.UploadError("validation_error", "Provide a file or csv_text.")
                raw, name = text.encode("utf-8"), default_name
            return Response(ingest(kb, raw, name))
        except uploads.UploadError as e:
            return error_response(400, e.code, str(e), e.details)
        except retrieval.IndexUnavailable as e:
            return error_response(503, "index_unavailable", "The guideline index is not available, so nothing "
                                  "was added. Run the seed first.", {"reason": str(e)[:200]})


class UploadInteractions(_UploadView):
    def post(self, request):
        return self.handle_upload(request, "direct_entry.csv",
                                  lambda kb, raw, name: uploads.ingest_interactions(kb, raw, name, request.user))


class UploadGuidelines(_UploadView):
    DOC_TYPES = {"GUIDELINE", "HOSPITAL_PROTOCOL", "FORMULARY"}

    def post(self, request):
        title = (request.data.get("title") or "").strip()
        doc_type = (request.data.get("doc_type") or "GUIDELINE").strip().upper()
        if not title:
            return error_response(400, "validation_error", "A document title is required (it is cited on screen).")
        if doc_type not in self.DOC_TYPES:
            return error_response(400, "validation_error", f"doc_type must be one of {sorted(self.DOC_TYPES)}.")
        source = (request.data.get("source") or "Hospital upload").strip()[:120]
        version = (request.data.get("version") or timezone.now().strftime("%Y.%m")).strip()[:32]
        classes = settings.REPO_ROOT / "data" / "curated" / "drug_classes.csv"
        return self.handle_upload(
            request, f"{title.lower().replace(' ', '_')[:60]}.txt",
            lambda kb, raw, name: uploads.ingest_guideline(kb, raw, name, title, doc_type, source, version,
                                                           request.user, classes_csv=classes))


class DatasetTemplates(RxView):
    LABEL = "FORMAT EXAMPLE ONLY - not clinical data. Replace every row with your hospital's reviewed data."

    def get(self, request):
        return Response({
            "label": self.LABEL,
            "interactions_template": (
                "drug_a,drug_b,severity,notes\n"
                "<generic name in the KB>,<generic name in the KB>,Major|Moderate|Minor|Unknown,"
                "<optional; not stored>\n"),
            "guidelines_template": (
                "section,text\n"
                "\"<section heading>\",\"<exact wording of this section from your approved protocol>\"\n"),
            "rules": [
                "Drug names must already exist in the knowledge base (generic name, synonym or brand).",
                "Pairs already recorded (by DDInter or an earlier upload) are kept unchanged.",
                "Uploaded interactions are shown as 'Hospital upload records ...', never as DDInter.",
                "Guideline sections must be at most 2,000 characters; plain text is split on blank lines.",
            ],
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
