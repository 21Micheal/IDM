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

        if obj.object_repr and "@" in obj.object_repr:
            local_part = obj.object_repr.split("@", 1)[0]
            friendly = re.sub(r"[._]+", " ", local_part).strip()
            return friendly.title()

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
        if event == "user.created":
            return f"{actor} added user {obj.object_repr}".strip()
        if event == "user.deleted":
            return f"{actor} removed user {obj.object_repr}".strip()
        if event == "user.password_reset":
            return f"{actor} reset the password for {obj.object_repr}".strip()
        if event == "user.activated":
            return f"{actor} activated {obj.object_repr}".strip()
        if event == "user.deactivated":
            return f"{actor} deactivated {obj.object_repr}".strip()

        object_label = self._get_document_label(obj)
        label_upper = object_label.upper()
        document_kind = (
            "requisition" if label_upper.startswith("REQ-")
            else "LPO" if label_upper.startswith("LPO-")
            else "document"
        )

        if event == "document.viewed":
            target = f"{document_kind} {object_label}" if object_label else f"the {document_kind}"
            return f"{actor} viewed {target}"

        if event == "document.updated":
            changes = obj.changes if isinstance(obj.changes, dict) else {}
            target = f"{document_kind} {object_label}" if object_label else f"the {document_kind}"

            if changes.get("form"):
                changed_fields = changes.get("changed_fields")
                if isinstance(changed_fields, list) and changed_fields:
                    return f"{actor} amended {target}: {', '.join(str(field) for field in changed_fields)}"
                if isinstance(changed_fields, list):
                    return f"{actor} saved a new version of {target}; no form fields changed"
                return f"{actor} saved a new version of {target}; field changes were not recorded"

            metadata_edits = changes.get("metadata_edits")
            if isinstance(metadata_edits, list) and metadata_edits:
                fields = [
                    str(edit.get("field") or edit.get("key") or "Field")
                    for edit in metadata_edits if isinstance(edit, dict)
                ]
                if fields:
                    return f"{actor} updated {target}: {', '.join(fields)}"

            return f"{actor} updated {target}"

        if obj.object_type == "Document" or event.startswith("document.") or event.startswith("workflow."):
            event_verb = self._get_verb(event)
            if object_label:
                return f"{actor} {event_verb} {document_kind} {object_label}"
            return f"{actor} {event_verb} the {document_kind}"

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
            "document.bulk_uploaded": "bulk uploaded",
            "document.bulk_reviewed": "reviewed bulk-upload metadata for",
            "document.preview_queued": "queued preview generation for",
            "document.ocr_queued": "queued OCR for",
            "document.ocr_completed": "completed OCR for",
            "document.ocr_failed": "failed OCR for",
            "workflow.approved": "approved",
            "workflow.rejected": "rejected",
            "workflow.returned": "returned",
            "workflow.held": "put on hold",
            "workflow.released": "released from hold",
            "workflow.cancelled": "cancelled the workflow for",
            "workflow.delegated": "delegated tasks to",
            "workflow.reassigned": "reassigned tasks to",
            "document.archived": "archived",
            "document.version_uploaded": "uploaded a new version of",
            "document.version_restored": "restored",
            "document.version_preview_queued": "queued version preview generation for",
            "document.edit_lock_acquired": "started editing",
            "document.edit_lock_released": "stopped editing",
            "document.previewed": "opened a preview of",
            "document.printed": "used the browser print dialog for",
            "permission.changed": "changed permissions on",
            "audit.exported": "exported",
        }
        return verb_map.get(event, "updated")
