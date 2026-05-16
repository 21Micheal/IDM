from __future__ import annotations

from .models import AuditLog


def record_audit_event(event, *, actor=None, obj=None, changes=None, request=None):
    ev = event if isinstance(event, str) else getattr(event, "value", str(event))
    ip_address = None
    user_agent = ""
    if request is not None:
        ip_address = request.META.get("REMOTE_ADDR")
        user_agent = request.META.get("HTTP_USER_AGENT", "")[:500]

    AuditLog.objects.create(
        event=ev,
        actor=actor,
        object_type=obj.__class__.__name__ if obj is not None else "",
        object_id=str(obj.pk) if obj is not None else "",
        object_repr=str(obj)[:255] if obj is not None else "",
        changes=changes or {},
        ip_address=ip_address,
        user_agent=user_agent,
    )
