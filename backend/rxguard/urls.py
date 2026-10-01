from django.urls import path

from api import views as v

handler404 = "api.errors.handler404"
handler500 = "api.errors.handler500"

api = "api/v1/"
urlpatterns = [
    path("healthz", v.healthz),
    path("readyz", v.readyz),
    path(api + "auth/token", v.login),
    path(api + "me", v.Me.as_view()),
    path(api + "check", v.Check.as_view()),
    path(api + "explain", v.Explain.as_view()),
    path(api + "ask", v.Ask.as_view()),
    path(api + "sessions", v.SessionView.as_view()),
    path(api + "sessions/<int:session_id>", v.SessionView.as_view()),
    path(api + "prescriptions", v.PrescriptionList.as_view()),
    path(api + "prescriptions/<int:pk>", v.PrescriptionDetail.as_view()),
    path(api + "prescriptions/<int:pk>/complete", v.PrescriptionComplete.as_view()),
    path(api + "prescriptions/<int:pk>/items/<int:item_id>/confirm", v.ConfirmItem.as_view()),
    path(api + "prescriptions/<int:prescription_id>/steps", v.AgentSteps.as_view()),
    path(api + "findings/<int:pk>", v.FindingDetail.as_view()),
    path(api + "reviews/<int:finding_id>", v.Reviews.as_view()),
    path(api + "escalations", v.Escalations.as_view()),
    path(api + "audit/<int:prescription_id>", v.AuditTrail.as_view()),
    path(api + "audit/<int:prescription_id>/verify", v.AuditVerify.as_view()),
    path(api + "drugs/search", v.DrugSearch.as_view()),
    path(api + "kb", v.KbInfo.as_view()),
    path(api + "demo/prescriptions", v.DemoPrescriptions.as_view()),
    path(api + "metrics/cost", v.CostMetrics.as_view()),
    path(api + "metrics/latency", v.LatencyMetrics.as_view()),
    path(api + "metrics/overview", v.Overview.as_view()),
]
