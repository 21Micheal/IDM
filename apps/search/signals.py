"""Django signals that keep the search index aligned with document changes."""
from django.core.exceptions import ObjectDoesNotExist
from django.db.models.signals import m2m_changed, post_delete, post_save
from django.dispatch import receiver

from apps.documents.models import Document
from apps.search.indexing import queue_index_document
from apps.workflows.models import WorkflowTask


@receiver(m2m_changed, sender=Document.tags.through)
def document_tags_changed(sender, instance, action, **kwargs):
    if action in ("post_add", "post_remove", "post_clear"):
        queue_index_document(str(instance.id))


@receiver(post_save, sender=WorkflowTask)
@receiver(post_delete, sender=WorkflowTask)
def workflow_task_changed(sender, instance, **kwargs):
    try:
        document_id = getattr(instance.workflow_instance, "document_id", None)
    except ObjectDoesNotExist:
        document_id = None
    if document_id:
        queue_index_document(str(document_id))
