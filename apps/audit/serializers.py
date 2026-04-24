import re

from rest_framework import serializers
from .models import AuditLog

class AuditLogSerializer(serializers.ModelSerializer):
    actor_email = serializers.CharField(source="actor.email", read_only=True, default="")
    actor_name = serializers.SerializerMethodField()
    actor_job_description = serializers.CharField(source="actor.job_description", read_only=True, default="")
    actor_has_admin_access = serializers.BooleanField(source="actor.has_admin_access", read_only=True, default=False)
    summary = serializers.SerializerMethodField()

    class Meta:
        model = AuditLog
        fields = [
            "id", "event", "summary", "actor_email", "actor_name", "actor_job_description", "actor_has_admin_access",
            "object_type", "object_id", "object_repr", "changes",
            "ip_address", "user_agent", "timestamp"
        ]

    def get_actor_name(self, obj):
        if obj.actor:
            return obj.actor.get_full_name() or obj.actor.email
        return ""

    def get_summary(self, obj):
        actor = self.get_actor_name(obj) or "System"
        event = obj.event or ""

        if event == "user.login":
            return f"{actor} logged in"
        if event == "user.login_failed":
            return f"{actor} failed to log in"
        if event == "user.mfa_enabled":
            return f"{actor} enabled multi-factor authentication"

        object_label = self._get_document_label(obj)
        if obj.object_type == "Document" or event.startswith("document.") or event.startswith("workflow."):
            event_verb = self._get_verb(event)
            if object_label:
                if event == "document.version_uploaded":
                    return f"{actor} {event_verb} document {object_label}"
                return f"{actor} {event_verb} document {object_label}"
            return f"{actor} {event_verb} the document"

        if event == "permission.changed":
            return f"{actor} changed permissions"

        return f"{actor} {event.replace('.', ' ')}"

    def _get_document_label(self, obj):
        if not obj.object_repr:
            return ""
        match = re.match(r"^\[(?P<ref>[^\]]+)\]", obj.object_repr)
        if match:
            return match.group("ref")
        return obj.object_repr

    def _get_verb(self, event: str) -> str:
        verb_map = {
            "document.created": "created",
            "document.viewed": "viewed",
            "document.downloaded": "downloaded",
            "document.updated": "edited",
            "document.deleted": "deleted",
            "document.submitted": "submitted",
            "workflow.approved": "approved",
            "workflow.rejected": "rejected",
            "document.archived": "archived",
            "document.version_uploaded": "uploaded a new version of",
            "document.version_restored": "restored",
            "document.edit_lock_acquired": "started editing",
            "document.edit_lock_released": "stopped editing",
            "document.ocr_queued": "queued OCR for",
            "permission.changed": "changed permissions on",
        }
        return verb_map.get(event, "updated")
