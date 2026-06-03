from django.core.management.base import BaseCommand

from apps.documents.models import BulkUpload, BulkUploadStatus, Document
from apps.documents.relationship_suggestions import (
    cleanup_duplicate_auto_po_relationships,
    cleanup_unclassified_relationships,
)
from apps.documents.serializers import _generate_unique_reference


class Command(BaseCommand):
    help = "Remove stale or duplicate auto-generated PO relationships from bulk intake."

    def add_arguments(self, parser):
        parser.add_argument(
            "--bulk-upload-id",
            dest="bulk_upload_id",
            default=None,
            help="Limit cleanup to one bulk upload batch.",
        )

    def handle(self, *args, **options):
        removed_unclassified = cleanup_unclassified_relationships(
            bulk_upload_id=options.get("bulk_upload_id"),
        )
        removed_duplicates = cleanup_duplicate_auto_po_relationships(
            bulk_upload_id=options.get("bulk_upload_id"),
        )
        repaired_references = 0
        temp_ref_docs = (
            Document.objects
            .select_related("document_type")
            .exclude(document_type__code="UNCLASS")
            .filter(reference_number__startswith="MIX-")
        )
        if options.get("bulk_upload_id"):
            temp_ref_docs = temp_ref_docs.filter(bulk_upload_id=options["bulk_upload_id"])
        for doc in temp_ref_docs:
            doc.reference_number = _generate_unique_reference(doc.document_type)
            doc.save(update_fields=["reference_number", "updated_at"])
            repaired_references += 1

        removed_failed_drafts = 0
        failed_bulk_ids = BulkUpload.objects.filter(
            mode=BulkUpload.Mode.RELATED_SET,
            status=BulkUploadStatus.FAILED,
        ).values_list("id", flat=True)
        failed_drafts = Document.objects.filter(
            document_type__code="UNCLASS",
            bulk_upload_id__in=failed_bulk_ids,
        )
        if options.get("bulk_upload_id"):
            failed_drafts = failed_drafts.filter(bulk_upload_id=options["bulk_upload_id"])
        removed_failed_drafts, _ = failed_drafts.delete()

        self.stdout.write(
            self.style.SUCCESS(
                "Removed "
                f"{removed_unclassified} unclassified and "
                f"{removed_duplicates} duplicate auto relationship(s). "
                f"Repaired {repaired_references} temporary reference(s). "
                f"Deleted {removed_failed_drafts} failed unclassified draft(s)."
            )
        )
