"""Django signals that keep the search index aligned with document changes."""
from django.db.models.signals import m2m_changed
from django.dispatch import receiver

from apps.documents.models import Document
from apps.search.indexing import queue_index_document


@receiver(m2m_changed, sender=Document.tags.through)
def document_tags_changed(sender, instance, action, **kwargs):
    if action in ("post_add", "post_remove", "post_clear"):
        queue_index_document(str(instance.id))
