from .models import AuditLog


class AuditMixin:
    def record_audit(self, event, obj, changes=None):
        request = self.request
        ev = event if isinstance(event, str) else getattr(event, "value", str(event))
        AuditLog.objects.create(
            event=ev,
            actor=request.user,
            object_type=obj.__class__.__name__,
            object_id=str(obj.pk),
            object_repr=str(obj)[:255],
            changes=changes or {},
            ip_address=request.META.get("REMOTE_ADDR"),
            user_agent=request.META.get("HTTP_USER_AGENT", "")[:500],
        )
