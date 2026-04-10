from .models import AuditLog

class AuditMixin:
    def record_audit(self, event, obj, changes=None):
        request = self.request
        AuditLog.objects.create(
            event=event,
            actor=request.user,
            object_type=obj.__class__.__name__,
            object_id=str(obj.pk),
            object_repr=str(obj)[:255],
            changes=changes or {},
            ip_address=request.META.get("REMOTE_ADDR"),
            user_agent=request.META.get("HTTP_USER_AGENT", "")[:500],
        )
