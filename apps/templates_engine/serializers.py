from rest_framework import serializers
from apps.accounts.serializers import UserSummarySerializer
from .models import DocumentTemplate


class DocumentTemplateSerializer(serializers.ModelSerializer):
    created_by = UserSummarySerializer(read_only=True)
    document_type_id   = serializers.SerializerMethodField()
    document_type_name = serializers.SerializerMethodField()
    document_type_code = serializers.SerializerMethodField()

    def get_document_type_id(self, obj):
        return str(obj.document_type_id) if obj.document_type_id else None

    def get_document_type_name(self, obj):
        return obj.document_type.name if obj.document_type else None

    def get_document_type_code(self, obj):
        return obj.document_type.code if obj.document_type else None

    class Meta:
        model = DocumentTemplate
        fields = [
            "id", "name", "description", "type", "kind", "category", "tags",
            "document_type", "document_type_id", "document_type_name", "document_type_code",
            "sections", "design", "placeholders", "sunsystems", "workflow_type",
            "requisition_type_field", "travel_type_value",
            "file", "file_name",
            "use_count", "is_active",
            "created_by", "created_at", "updated_at",
        ]
        # is_active is server-managed (created active, soft-deleted via destroy).
        # Keeping it read-only also avoids the DRF multipart quirk where an absent
        # BooleanField is parsed as False — which previously deactivated uploads.
        read_only_fields = ["id", "use_count", "is_active", "created_by", "created_at", "updated_at"]

    def validate_sections(self, value):
        """Ensure sections is a list of dicts with required keys, and that the
        on-demand / button / linked-table constructs are internally coherent."""
        if not isinstance(value, list):
            raise serializers.ValidationError("sections must be a list.")
        for i, section in enumerate(value):
            if not isinstance(section, dict):
                raise serializers.ValidationError(f"Section {i} must be an object.")
            if "id" not in section or "title" not in section:
                raise serializers.ValidationError(f"Section {i} must have 'id' and 'title'.")
            fields = section.get("fields", [])
            if not isinstance(fields, list):
                raise serializers.ValidationError(f"Section {i} 'fields' must be a list.")
            for flag in ("onDemand", "removable"):
                if flag in section and not isinstance(section.get(flag), bool):
                    raise serializers.ValidationError(
                        f"Section {i} '{flag}' must be a boolean."
                    )

        by_id = {s.get("id"): s for s in value if isinstance(s, dict)}
        for i, section in enumerate(value):
            if not isinstance(section, dict):
                continue
            for j, field in enumerate(section.get("fields") or []):
                if not isinstance(field, dict):
                    continue
                where = f"Section {i} field {j}"
                if field.get("type") == "button":
                    button = field.get("button") or {}
                    action = button.get("action")
                    if action == "add_block":
                        target = button.get("targetSectionId")
                        target_section = by_id.get(target)
                        if not target or target_section is None:
                            raise serializers.ValidationError(
                                f"{where}: an add_block button must target an existing section."
                            )
                        if not target_section.get("onDemand"):
                            raise serializers.ValidationError(
                                f"{where}: an add_block button must target an on-demand section."
                            )
                        if target == section.get("id"):
                            raise serializers.ValidationError(
                                f"{where}: a button cannot add the section it sits in."
                            )
                    elif action == "calculate":
                        if not button.get("targetKey"):
                            raise serializers.ValidationError(
                                f"{where}: a calculate button needs a target field."
                            )
                        calc = button.get("calc") or {}
                        if not str(calc.get("expression") or "").strip():
                            raise serializers.ValidationError(
                                f"{where}: a calculate button needs a non-empty expression."
                            )
                if field.get("type") == "reference" and field.get("referenceSource") == "table":
                    ref = field.get("tableRef") or {}
                    if not ref.get("tableKey"):
                        raise serializers.ValidationError(f"{where}: a table reference needs a table.")
                    if ref.get("scope") == "other_form" and not ref.get("templateId"):
                        raise serializers.ValidationError(
                            f"{where}: an other-form table reference needs a template."
                        )
                    if ref.get("mode") == "embed" and not (ref.get("snapshot") or {}).get("columns"):
                        raise serializers.ValidationError(
                            f"{where}: an embedded table needs a saved column snapshot."
                        )
                    if ref.get("mode") == "row_picker" and not ref.get("displayColumn"):
                        raise serializers.ValidationError(
                            f"{where}: a row picker needs a display column."
                        )
        return value

    def validate(self, attrs):
        template_type = attrs.get("type", getattr(self.instance, "type", "built"))
        template_kind = attrs.get("kind", getattr(self.instance, "kind", "form"))
        if template_type == "built":
            if template_kind == "document":
                design = attrs.get("design", getattr(self.instance, "design", {})) or {}
                if not design.get("blocks"):
                    raise serializers.ValidationError(
                        {"design": "Add at least one block to the document layout."}
                    )
            elif not attrs.get("sections", getattr(self.instance, "sections", [])):
                raise serializers.ValidationError({"sections": "At least one section is required."})
        if not attrs.get("document_type", getattr(self.instance, "document_type", None)):
            raise serializers.ValidationError({"document_type": "Select the document type this template belongs to."})
        return attrs
