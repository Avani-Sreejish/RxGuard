from rest_framework.permissions import BasePermission

PHARMACIST_GROUP = "pharmacist"


class IsPharmacist(BasePermission):
    """RxGuard is pharmacist-only: every endpoint except health checks requires this role."""
    message = "Pharmacist role required"

    def has_permission(self, request, view):
        u = request.user
        return bool(u and u.is_authenticated and u.groups.filter(name=PHARMACIST_GROUP).exists())


def is_admin(user) -> bool:
    return bool(user and user.is_authenticated and user.is_staff)
