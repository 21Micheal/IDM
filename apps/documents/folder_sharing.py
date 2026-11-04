"""Shared-folder lookup helpers used by folder and document access checks."""

from django.db.models import Q
from django.utils import timezone

from .models import DocumentFolder, DocumentFolderItem, DocumentFolderShare


def active_folder_shares(user):
    return DocumentFolderShare.objects.filter(
        recipient=user,
        revoked_at__isnull=True,
    ).filter(Q(expires_at__isnull=True) | Q(expires_at__gt=timezone.now()))


def descendant_folder_ids(root_ids):
    """Include roots and descendants, respecting the folder tree's bounded depth."""
    found = set(root_ids)
    frontier = set(found)
    while frontier:
        children = set(DocumentFolder.objects.filter(parent_id__in=frontier).values_list("id", flat=True))
        frontier = children - found
        found.update(frontier)
    return found


def shared_folder_ids(user):
    return descendant_folder_ids(active_folder_shares(user).values_list("folder_id", flat=True))


def folder_shares_for_folder(user, folder):
    ancestors = {folder.id}
    frontier = {folder.id}
    while frontier:
        parents = set(DocumentFolder.objects.filter(id__in=frontier, parent__isnull=False).values_list("parent_id", flat=True))
        frontier = parents - ancestors
        ancestors.update(frontier)
    return active_folder_shares(user).filter(folder_id__in=ancestors).select_related("shared_by", "folder")


def shared_document_ids(user):
    return DocumentFolderItem.objects.filter(folder_id__in=shared_folder_ids(user)).values("document_id")


def folder_share_permissions_for_document(user, document):
    """Union active folder grants whose shared tree contains this document."""
    folder_ids = set(DocumentFolderItem.objects.filter(document=document).values_list("folder_id", flat=True))
    if not folder_ids:
        return set()

    ancestors = set(folder_ids)
    frontier = set(folder_ids)
    while frontier:
        parents = set(DocumentFolder.objects.filter(id__in=frontier, parent__isnull=False).values_list("parent_id", flat=True))
        frontier = parents - ancestors
        ancestors.update(frontier)

    shares = active_folder_shares(user).filter(folder_id__in=ancestors)
    permissions = set()
    for share in shares:
        permissions.update(share.effective_permissions)
    return permissions
