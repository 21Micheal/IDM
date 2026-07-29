"""
Ad-hoc "Request signature" API — collect e-signatures from specific people on a
PDF, with optional ordered/sequential signing. No workflow, no user-chosen
document type (a hidden system type is used).
"""
from __future__ import annotations

import hashlib
import json

from django.core.files.base import ContentFile
from django.db import transaction
from django.utils import timezone
from rest_framework import serializers, viewsets, status, permissions
from rest_framework.decorators import action
from rest_framework.parsers import MultiPartParser, FormParser, JSONParser
from rest_framework.response import Response

from apps.accounts.models import User
from apps.accounts.serializers import UserSummarySerializer
from apps.search.utils import SEARCH_INDEX_EXCEPTIONS

from .models import (
    Document, DocumentStatus, SignatureRequest, SignatureRequestSigner,
    get_signature_request_document_type,
)
from .serializers import _generate_unique_reference
from .signing import embed_signing_items_into_document, SignatureError


# ── Serializers ────────────────────────────────────────────────────────────────

class SignatureSignerSerializer(serializers.ModelSerializer):
    signer = UserSummarySerializer(read_only=True)

    class Meta:
        model = SignatureRequestSigner
        fields = ["id", "signer", "order", "status", "signed_at", "decline_reason"]


class SignatureRequestSerializer(serializers.ModelSerializer):
    requested_by = UserSummarySerializer(read_only=True)
    signers = SignatureSignerSerializer(many=True, read_only=True)
    document_id = serializers.UUIDField(source="document.id", read_only=True)
    document_title = serializers.CharField(source="document.title", read_only=True)
    document_reference = serializers.CharField(source="document.reference_number", read_only=True)
    progress = serializers.SerializerMethodField()
    my_signer_status = serializers.SerializerMethodField()
    can_sign = serializers.SerializerMethodField()
    can_cancel = serializers.SerializerMethodField()

    class Meta:
        model = SignatureRequest
        fields = [
            "id", "document_id", "document_title", "document_reference",
            "requested_by", "ordered", "message", "status",
            "created_at", "completed_at", "signers",
            "progress", "my_signer_status", "can_sign", "can_cancel",
        ]

    def _user(self):
        request = self.context.get("request")
        return getattr(request, "user", None)

    def get_progress(self, obj):
        signers = list(obj.signers.all())
        signed = sum(1 for s in signers if s.status == SignatureRequestSigner.Status.SIGNED)
        return {"signed": signed, "total": len(signers)}

    def get_my_signer_status(self, obj):
        user = self._user()
        if not user:
            return None
        row = next((s for s in obj.signers.all() if s.signer_id == user.id), None)
        return row.status if row else None

    def get_can_sign(self, obj):
        user = self._user()
        if not user or obj.status != SignatureRequest.Status.PENDING:
            return False
        current = obj.current_pending_signers()
        return any(s.signer_id == user.id for s in current)

    def get_can_cancel(self, obj):
        user = self._user()
        return bool(
            user
            and obj.status == SignatureRequest.Status.PENDING
            and (obj.requested_by_id == user.id or getattr(user, "has_admin_access", False))
        )


# ── ViewSet ────────────────────────────────────────────────────────────────────

class SignatureRequestViewSet(viewsets.ModelViewSet):
    serializer_class = SignatureRequestSerializer
    permission_classes = [permissions.IsAuthenticated]
    parser_classes = [MultiPartParser, FormParser, JSONParser]
    http_method_names = ["get", "post", "delete", "head", "options"]

    def get_queryset(self):
        user = self.request.user
        qs = (
            SignatureRequest.objects
            .select_related("document", "requested_by", "requested_by__department")
            .prefetch_related("signers__signer")
        )
        from django.db.models import Q
        document_id = self.request.query_params.get("document")
        if document_id:
            qs = qs.filter(document_id=document_id)
        box = self.request.query_params.get("box")
        if box == "sent":
            return qs.filter(requested_by=user)
        if box == "incoming":
            # Only requests still awaiting THIS user's signature: their signer row
            # is pending AND the request is still active. Once they sign (or the
            # request completes/cancels) it leaves their "awaiting my signature".
            return qs.filter(
                signers__signer=user,
                signers__status=SignatureRequestSigner.Status.PENDING,
                status=SignatureRequest.Status.PENDING,
            ).distinct()
        if box == "signed":
            return qs.filter(
                signers__signer=user,
                signers__status=SignatureRequestSigner.Status.SIGNED,
            ).distinct()
        return qs.filter(Q(requested_by=user) | Q(signers__signer=user)).distinct()

    @action(detail=False, methods=["get"])
    def incoming_count(self, request):
        """Number of requests still awaiting the current user's signature — drives
        the nav badge."""
        count = (
            SignatureRequest.objects
            .filter(
                signers__signer=request.user,
                signers__status=SignatureRequestSigner.Status.PENDING,
                status=SignatureRequest.Status.PENDING,
            )
            .distinct()
            .count()
        )
        return Response({"count": count})

    # ── Create ───────────────────────────────────────────────────────────────
    def create(self, request, *args, **kwargs):
        upload = request.FILES.get("file")
        if not upload:
            return Response({"detail": "A document file is required."}, status=400)
        name = (upload.name or "").lower()
        ctype = (getattr(upload, "content_type", "") or "").lower()
        is_pdf_upload = name.endswith(".pdf") or "pdf" in ctype
        office_exts = (".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".odt", ".ods", ".odp")
        is_office_upload = name.endswith(office_exts)
        if not (is_pdf_upload or is_office_upload):
            return Response(
                {"detail": "Upload a PDF or Office document (Word, Excel, PowerPoint). It is signed on its PDF rendition."},
                status=400,
            )
        import mimetypes as _mimetypes
        file_mime = (
            "application/pdf" if is_pdf_upload
            else (upload.content_type or _mimetypes.guess_type(name)[0] or "application/octet-stream")
        )

        title = (request.data.get("title") or upload.name or "Signature request").strip()
        message = (request.data.get("message") or "").strip()
        ordered = str(request.data.get("ordered", "")).lower() in ("1", "true", "yes", "on")

        raw_signers = request.data.get("signers")
        if isinstance(raw_signers, str):
            try:
                signer_ids = json.loads(raw_signers) if raw_signers.strip() else []
            except json.JSONDecodeError:
                return Response({"detail": "signers must be a JSON array of user ids."}, status=400)
        elif isinstance(raw_signers, (list, tuple)):
            signer_ids = list(raw_signers)
        else:
            signer_ids = request.data.getlist("signers") if hasattr(request.data, "getlist") else []

        # De-dupe while preserving order. The requester MAY include themselves as
        # a signer (e.g. they are also on the approving committee).
        seen, ordered_ids = set(), []
        for sid in signer_ids:
            sid = str(sid)
            if sid and sid not in seen:
                seen.add(sid)
                ordered_ids.append(sid)
        if not ordered_ids:
            return Response({"detail": "Select at least one signer."}, status=400)

        users = {str(u.id): u for u in User.objects.filter(id__in=ordered_ids, is_active=True)}
        missing = [sid for sid in ordered_ids if sid not in users]
        if missing:
            return Response({"detail": "One or more selected signers are invalid."}, status=400)

        content = upload.read()
        checksum = hashlib.sha256(content).hexdigest()
        doc_type = get_signature_request_document_type()
        reference_number = _generate_unique_reference(doc_type)

        with transaction.atomic():
            try:
                doc = Document.objects.create(
                    title=title,
                    reference_number=reference_number,
                    file=ContentFile(content, name=upload.name or "document"),
                    file_name=upload.name or "document",
                    file_size=len(content),
                    file_mime_type=file_mime,
                    checksum=checksum,
                    uploaded_by=request.user,
                    owned_by=request.user,
                    document_type=doc_type,
                    status=DocumentStatus.PENDING_SIGNATURE,
                    current_version=0,
                )
            except SEARCH_INDEX_EXCEPTIONS:
                doc = Document.objects.filter(reference_number=reference_number).first()
                if doc is None:
                    raise

            sig_request = SignatureRequest.objects.create(
                document=doc,
                requested_by=request.user,
                ordered=ordered,
                message=message,
            )
            for idx, sid in enumerate(ordered_ids):
                SignatureRequestSigner.objects.create(
                    request=sig_request, signer=users[sid], order=idx,
                )

            # Office uploads are signed on their PDF rendition — generate it now so
            # signers can place items as soon as they open the request.
            if doc.is_office_doc():
                from apps.documents.tasks import generate_document_preview
                Document.objects.filter(id=doc.id).update(preview_status="pending")
                transaction.on_commit(lambda: generate_document_preview.delay(str(doc.id)))

        self._notify_current_signers(sig_request)
        ser = self.get_serializer(sig_request)
        return Response(ser.data, status=status.HTTP_201_CREATED)

    # ── Sign ─────────────────────────────────────────────────────────────────
    @action(detail=True, methods=["post"])
    def sign(self, request, pk=None):
        sig_request = self.get_object()
        if sig_request.status != SignatureRequest.Status.PENDING:
            return Response({"detail": "This request is no longer open for signing."}, status=400)

        row = sig_request.signers.filter(
            signer=request.user, status=SignatureRequestSigner.Status.PENDING
        ).first()
        if not row:
            return Response({"detail": "You are not a pending signer on this request."}, status=403)
        if sig_request.ordered and row.id not in {s.id for s in sig_request.current_pending_signers()}:
            return Response({"detail": "It is not your turn to sign yet."}, status=400)

        # `items` is the Sejda-style placed-items array from SignaturePlacementModal
        # (one or more signature items plus any optional name/date/text items).
        items = request.data.get("items")
        if isinstance(items, str):
            try:
                items = json.loads(items) if items.strip() else None
            except json.JSONDecodeError:
                return Response({"detail": "Placement data is invalid."}, status=400)

        if not items:
            # Back-compat: older clients send a single `placement` object for
            # just the signature, with no name/date/text items.
            placement = request.data.get("placement")
            if isinstance(placement, str):
                try:
                    placement = json.loads(placement)
                except json.JSONDecodeError:
                    placement = None
            if isinstance(placement, dict):
                items = [{**placement, "kind": "signature"}]

        use_new_signature = str(request.data.get("use_new_signature", "")).lower() in ("1", "true", "yes", "on")
        signature_image = request.data.get("signature_image") if use_new_signature else None

        try:
            version, info = embed_signing_items_into_document(
                sig_request.document,
                request.user,
                items,
                use_new_signature=use_new_signature,
                signature_image=signature_image,
            )
        except SignatureError as exc:
            return Response({"detail": str(exc)}, status=400)

        now = timezone.now()
        row.status = SignatureRequestSigner.Status.SIGNED
        row.signed_at = now
        row.placement = {"items": info["items"]}
        row.save(update_fields=["status", "signed_at", "placement"])

        remaining = sig_request.signers.filter(status=SignatureRequestSigner.Status.PENDING).exists()
        if remaining:
            from apps.notifications.tasks import notify_signature_signed
            notify_signature_signed.delay(str(sig_request.id), str(request.user.id))
        else:
            sig_request.status = SignatureRequest.Status.COMPLETED
            sig_request.completed_at = now
            sig_request.save(update_fields=["status", "completed_at"])
            self._set_document_status(sig_request.document, DocumentStatus.SIGNED)
            from apps.notifications.tasks import notify_signature_completed
            notify_signature_completed.delay(str(sig_request.id))

        sig_request.refresh_from_db()
        return Response(self.get_serializer(sig_request).data)

    # ── Decline ──────────────────────────────────────────────────────────────
    @action(detail=True, methods=["post"])
    def decline(self, request, pk=None):
        sig_request = self.get_object()
        if sig_request.status != SignatureRequest.Status.PENDING:
            return Response({"detail": "This request is no longer open."}, status=400)
        row = sig_request.signers.filter(
            signer=request.user, status=SignatureRequestSigner.Status.PENDING
        ).first()
        if not row:
            return Response({"detail": "You are not a pending signer on this request."}, status=403)
        reason = (request.data.get("reason") or "").strip()
        if not reason:
            return Response({"detail": "A reason is required to decline."}, status=400)

        row.status = SignatureRequestSigner.Status.DECLINED
        row.decline_reason = reason
        row.save(update_fields=["status", "decline_reason"])
        sig_request.status = SignatureRequest.Status.DECLINED
        sig_request.save(update_fields=["status"])
        self._set_document_status(sig_request.document, DocumentStatus.REJECTED)

        from apps.notifications.tasks import notify_signature_declined
        notify_signature_declined.delay(str(sig_request.id), str(request.user.id))
        return Response(self.get_serializer(sig_request).data)

    # ── Cancel (requester) ───────────────────────────────────────────────────
    @action(detail=True, methods=["post"])
    def cancel(self, request, pk=None):
        sig_request = self.get_object()
        if sig_request.requested_by_id != request.user.id and not request.user.has_admin_access:
            return Response({"detail": "Only the requester can cancel this."}, status=403)
        if sig_request.status != SignatureRequest.Status.PENDING:
            return Response({"detail": "This request is no longer open."}, status=400)
        sig_request.status = SignatureRequest.Status.CANCELLED
        sig_request.save(update_fields=["status"])
        self._set_document_status(sig_request.document, DocumentStatus.DRAFT)
        return Response(self.get_serializer(sig_request).data)

    # ── Helpers ──────────────────────────────────────────────────────────────
    def _set_document_status(self, document, new_status):
        document.status = new_status
        try:
            document.save(update_fields=["status", "updated_at"])
        except SEARCH_INDEX_EXCEPTIONS:
            Document.objects.filter(pk=document.pk).update(status=new_status)

    def _notify_current_signers(self, sig_request):
        from apps.notifications.tasks import notify_signature_requested
        for s in sig_request.current_pending_signers():
            notify_signature_requested.delay(str(s.signer_id), str(sig_request.id))