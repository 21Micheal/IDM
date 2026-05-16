from .utils import record_audit_event


class AuditMixin:
    def record_audit(self, event, obj, changes=None):
        request = self.request
        record_audit_event(
            event,
            actor=request.user,
            obj=obj,
            changes=changes,
            request=request,
        )
