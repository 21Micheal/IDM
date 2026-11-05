"""Search API views."""
from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import date, datetime
from uuid import UUID

from elasticsearch import ApiError, ConnectionError as ESConnectionError, TransportError
from rest_framework.response import Response
from rest_framework import status
from rest_framework.permissions import IsAuthenticated
from rest_framework.views import APIView
from elasticsearch_dsl import Q

SEARCH_TEXT_FIELDS = [
    "title^6",
    "reference_number^5",
    "supplier^4",
    "metadata_text^3",
    "tags^4",
    "personal_tags^4",
    "file_name^2",
    "extracted_text^2",
]

SEARCH_SNIPPET_FIELDS = [
    "extracted_text",
    "metadata_text",
    "supplier",
    "title",
    "reference_number",
    "tags",
    "personal_tags",
    "file_name",
]

MAX_SEARCH_LENGTH = 500

MIME_FORMAT_MAP = {
    "pdf": ["application/pdf"],
    "word": [
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ],
    "spreadsheet": [
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/csv",
    ],
    "presentation": [
        "application/vnd.ms-powerpoint",
        "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ],
    "image": [
        "image/png",
        "image/jpeg",
        "image/jpg",
        "image/tiff",
        "image/webp",
    ],
}


def _expand_mime_types(value) -> list[str]:
    expanded: list[str] = []
    for item in _as_list(value):
        token = str(item or "").strip().lower()
        if not token:
            continue
        if token in MIME_FORMAT_MAP:
            expanded.extend(MIME_FORMAT_MAP[token])
        else:
            expanded.append(str(item).strip())
    return expanded

_TOKEN_RE = re.compile(r"[\w-]+", re.UNICODE)
_ES_LEGACY_TAG_RE = re.compile(r"</?em>", re.IGNORECASE)
_QUERY_STRING_SPECIAL_RE = re.compile(r'([+\-=!(){}\[\]^"~?:\\/]|&&|\|\|)')


def _search_terms(search_text: str) -> list[str]:
    terms: list[str] = []
    for term in _TOKEN_RE.findall(search_text.lower()):
        if len(term) < 2 or term in terms:
            continue
        terms.append(term)
    return terms


def _as_text(value) -> str:
    if value in (None, ""):
        return ""
    return str(value).strip()


def _parse_positive_int(value, default: int, *, maximum: int | None = None) -> int:
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    parsed = max(1, parsed)
    if maximum is not None:
        parsed = min(maximum, parsed)
    return parsed


def _as_filter_dict(value) -> dict:
    return value if isinstance(value, dict) else {}


def _as_list(value) -> list:
    if value in (None, ""):
        return []
    if isinstance(value, str):
        return [value]
    if isinstance(value, Iterable) and not isinstance(value, (dict, bytes, bytearray)):
        return [item for item in value if item not in (None, "")]
    return [value]


def _parse_bool(value) -> bool | None:
    if isinstance(value, bool):
        return value
    if value in (None, ""):
        return None
    normalized = str(value).strip().lower()
    if normalized in {"true", "1", "yes", "y", "on"}:
        return True
    if normalized in {"false", "0", "no", "n", "off"}:
        return False
    return None


def _es_value(value):
    if isinstance(value, (datetime, date)):
        return value.isoformat()
    return value


def _wildcard_query(search_text: str) -> str:
    terms = _search_terms(search_text)
    escaped_terms = [
        _QUERY_STRING_SPECIAL_RE.sub(r"\\\1", term)
        for term in terms
    ]
    return " AND ".join(f"*{term}*" for term in escaped_terms)


def _as_searchable_text(value) -> str:
    if value in (None, ""):
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, Iterable) and not isinstance(value, (dict, bytes, bytearray)):
        return " ".join(str(item) for item in value if item not in (None, ""))
    return str(value)


def _find_match_index(text: str, search_text: str, terms: list[str]) -> int:
    lowered = text.lower()
    phrase = search_text.strip().lower()
    if phrase:
        phrase_index = lowered.find(phrase)
        if phrase_index != -1:
            return phrase_index

    indexes = [lowered.find(term) for term in terms]
    indexes = [index for index in indexes if index != -1]
    return min(indexes) if indexes else -1


def _sentence_around_match(
    text: str,
    match_index: int,
    search_text: str = "",
    terms: list[str] | None = None,
    context_chars: int = 140,
) -> str:
    """Extract a generous intermediate context window around match_index with <mark> tags."""
    if match_index < 0 or not text:
        return ""

    match_len = len(search_text.strip()) if search_text.strip() else 4
    if terms:
        for t in terms:
            if t in text.lower():
                match_len = len(t)
                break

    raw_start = max(0, match_index - context_chars)
    raw_end = min(len(text), match_index + match_len + context_chars)

    # Expand to word boundary at start
    start = raw_start
    if start > 0:
        sp = text.rfind(" ", max(0, start - 25), start)
        nl = text.rfind("\n", max(0, start - 25), start)
        bound = max(sp, nl)
        if bound != -1:
            start = bound + 1

    # Expand to word boundary at end
    end = raw_end
    if end < len(text):
        sp = text.find(" ", end, min(len(text), end + 25))
        nl = text.find("\n", end, min(len(text), end + 25))
        candidates = [c for c in (sp, nl) if c != -1]
        if candidates:
            end = min(candidates)

    window = text[start:end]
    cleaned = re.sub(r"\s+", " ", window).strip()

    # Wrap matching terms in <mark>...</mark> if not already wrapped
    all_terms = []
    if search_text.strip():
        all_terms.append(search_text.strip())
    if terms:
        all_terms.extend(terms)

    unique_terms = sorted(set(all_terms), key=lambda x: len(x), reverse=True)
    if unique_terms:
        pattern = re.compile(
            r"(?<!<mark>)(?:\b)(" + "|".join(re.escape(t) for t in unique_terms) + r")(?:\b)(?!</mark>)",
            re.IGNORECASE,
        )
        cleaned = pattern.sub(r"<mark>\1</mark>", cleaned)

    prefix = "... " if start > 0 else ""
    suffix = " ..." if end < len(text) else ""
    return f"{prefix}{cleaned}{suffix}".strip()


def _build_source_highlights(hit, search_text: str) -> dict[str, str]:
    terms = _search_terms(search_text)
    if not terms and not search_text.strip():
        return {}

    highlights: dict[str, str] = {}
    for field in SEARCH_SNIPPET_FIELDS:
        source_value = hit.get(field, "") if isinstance(hit, dict) else getattr(hit, field, "")
        source_text = _as_searchable_text(source_value)
        if not source_text:
            continue

        match_index = _find_match_index(source_text, search_text, terms)
        if match_index == -1:
            continue

        snippet = _sentence_around_match(source_text, match_index, search_text, terms)
        if snippet:
            highlights[field] = snippet

    return highlights


def _build_document_highlights(document, search_text: str) -> dict[str, str]:
    """Build stable context snippets from the current database source.

    Elasticsearch's highlighter can omit fields when source fragments are
    unavailable or the match is deep in a large extracted field. Use the
    matching document's full source text as a fallback so every matching hit
    can show context around the term.
    """
    from .documents import _metadata_search_text

    metadata = document.metadata if isinstance(document.metadata, dict) else {}
    personal_tags = metadata.get("personal_tags") or []
    return _build_source_highlights({
        "extracted_text": document.extracted_text or "",
        "metadata_text": _metadata_search_text(metadata),
        "supplier": document.supplier or "",
        "title": document.title or "",
        "reference_number": document.reference_number or "",
        "file_name": document.file_name or "",
        "tags": [tag.name for tag in document.tags.all()],
        "personal_tags": personal_tags if isinstance(personal_tags, list) else [personal_tags],
    }, search_text)


def _clean_es_highlights(raw_highlights: dict[str, list[str] | str]) -> dict[str, str]:
    cleaned = {}
    for field, value in raw_highlights.items():
        fragments = value if isinstance(value, list) else [value]
        text = " ... ".join(str(fragment) for fragment in fragments if fragment)
        text = re.sub(r"(?i)<em>", "<mark>", text)
        text = re.sub(r"(?i)</em>", "</mark>", text)
        text = re.sub(r"\s+", " ", text).strip()
        if text:
            if not text.startswith("..."):
                text = f"... {text}"
            if not text.endswith("..."):
                text = f"{text} ..."
            cleaned[field] = text
    return cleaned


class DocumentSearchView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        from django.conf import settings

        if not getattr(settings, "ELASTICSEARCH_ENABLED", True):
            return self._db_search(request)

        from .documents import DocumentIndex

        data = request.data
        search_text = _as_text(data.get("search"))[:MAX_SEARCH_LENGTH]
        filters = _as_filter_dict(data.get("filters"))
        page = _parse_positive_int(data.get("page", 1), 1)
        page_size = _parse_positive_int(data.get("page_size", 20), 20, maximum=100)

        s = DocumentIndex.search()
        # Unclassified (bulk-staging) documents never surface in global search —
        # they live in the bulk-review queue. Mirrors the DB-fallback exclusion.
        s = s.exclude("term", document_type_code="UNCLASS")
        user = request.user
        # A "sees all documents" group member (e.g. an auditor) bypasses the
        # per-document involvement filter, exactly like the document list and the
        # DB-search fallback — otherwise search couldn't locate documents they
        # can legitimately view.
        if not user.has_admin_access and not user.sees_all_documents:
            s = s.filter("term", accessible_user_ids=str(user.id))

        # Personal documents are private to their owner. Nobody else — not even
        # admins or "sees all documents" groups — sees another user's personal
        # docs in search: keep a hit only if it is non-personal or owned by me.
        s = s.filter(
            "bool",
            should=[
                Q("term", is_self_upload=False),
                Q("term", uploaded_by_id=str(user.id)),
                Q("term", owned_by_id=str(user.id)),
            ],
            minimum_should_match=1,
        )

        if search_text:
            wildcard_query = _wildcard_query(search_text)
            s = s.query(
                Q(
                    "bool",
                    should=[
                        Q(
                            "multi_match",
                            query=search_text,
                            fields=SEARCH_TEXT_FIELDS,
                            type="phrase",
                            boost=10,
                        ),
                        Q(
                            "multi_match",
                            query=search_text,
                            fields=SEARCH_TEXT_FIELDS,
                            operator="and",
                            boost=4,
                        ),
                        Q(
                            "multi_match",
                            query=search_text,
                            fields=SEARCH_TEXT_FIELDS,
                            fuzziness=1,
                            prefix_length=2,
                            operator="and",
                            boost=0.5,
                        ),
                        *(
                            [
                                Q(
                                    "query_string",
                                    query=wildcard_query,
                                    fields=SEARCH_TEXT_FIELDS,
                                    default_operator="AND",
                                    analyze_wildcard=True,
                                    boost=2,
                                )
                            ]
                            if wildcard_query
                            else []
                        ),
                        Q("prefix", title={"value": search_text.lower(), "boost": 4}),
                        Q("prefix", reference_number={"value": search_text.lower(), "boost": 4}),
                        Q("prefix", supplier={"value": search_text.lower(), "boost": 3}),
                        Q("prefix", **{"tags": {"value": search_text.lower(), "boost": 3}}),
                        Q("prefix", **{"personal_tags": {"value": search_text.lower(), "boost": 3}}),
                    ],
                    minimum_should_match=1,
                )
            )

        if filters.get("document_type"):
            document_type = str(filters["document_type"]).strip()
            from django.db.models import Q as DQ
            from apps.documents.models import DocumentType

            type_query = DQ(name__iexact=document_type) | DQ(code__iexact=document_type)
            try:
                type_query |= DQ(id=UUID(document_type))
            except (ValueError, TypeError):
                pass
            resolved_type = DocumentType.objects.filter(type_query).first()
            type_names = {document_type}
            type_codes = {document_type.upper()}
            should_clauses = []
            if resolved_type:
                type_names.add(resolved_type.name)
                if resolved_type.code:
                    type_codes.add(resolved_type.code.upper())
                should_clauses.append(Q("term", document_type_id=str(resolved_type.id)))
                should_clauses.append(Q("term", **{"document_type_id.keyword": str(resolved_type.id)}))
            should_clauses.extend(Q("term", document_type=name) for name in type_names)
            should_clauses.extend(Q("term", **{"document_type.keyword": name}) for name in type_names)
            should_clauses.extend(Q("term", document_type_code=code) for code in type_codes)
            should_clauses.extend(Q("term", **{"document_type_code.keyword": code}) for code in type_codes)
            s = s.filter(
                "bool",
                should=should_clauses,
                minimum_should_match=1,
            )

        if filters.get("supplier"):
            supp_val = str(filters["supplier"]).strip()
            wildcard_supp = f"*{supp_val}*"
            s = s.filter(
                "bool",
                should=[
                    Q("match_phrase", supplier=supp_val),
                    Q("match_phrase_prefix", supplier=supp_val),
                    Q("wildcard", **{"supplier.keyword": {"value": wildcard_supp, "case_insensitive": True}}),
                    Q("wildcard", **{"supplier": {"value": wildcard_supp, "case_insensitive": True}}),
                    Q("term", **{"supplier.keyword": supp_val}),
                    Q("term", supplier=supp_val),
                ],
                minimum_should_match=1,
            )

        if filters.get("status"):
            # Match DocumentFilter / DocumentsPage: filter the document `status`
            # field only. Do NOT OR against workflow_status — that field is a
            # derived label and historically mapped "approved" → pending_approval
            # (substring "approve"), which leaked approved/rejected into Pending.
            statuses = _as_list(filters["status"])
            status_should = []
            for raw in statuses:
                token = str(raw or "").strip().lower()
                if not token:
                    continue
                if token.startswith("pending"):
                    status_should.append(Q("wildcard", status="*pending*"))
                    status_should.append(Q("wildcard", **{"status.keyword": "*pending*"}))
                else:
                    status_should.append(Q("term", status=token))
                    status_should.append(Q("term", **{"status.keyword": token}))
            if status_should:
                s = s.filter("bool", should=status_should, minimum_should_match=1)

        format_arg = filters.get("format") or filters.get("file_mime_type")
        if format_arg:
            mime_types = _expand_mime_types(format_arg)
            if mime_types:
                s = s.filter(
                    "bool",
                    should=[
                        Q("terms", file_mime_type=mime_types),
                        Q("terms", **{"file_mime_type.keyword": mime_types}),
                    ],
                    minimum_should_match=1,
                )

        if filters.get("currency"):
            curr = str(filters["currency"]).strip().upper()
            s = s.filter(
                "bool",
                should=[
                    Q("term", currency=curr),
                    Q("term", **{"currency.keyword": curr}),
                    Q("term", currency=curr.lower()),
                ],
                minimum_should_match=1,
            )

        if filters.get("is_self_upload") is not None:
            is_self_upload = _parse_bool(filters.get("is_self_upload"))
            if is_self_upload is not None:
                s = s.filter("term", is_self_upload=is_self_upload)

        if filters.get("date_from"):
            s = s.filter("range", document_date={"gte": filters["date_from"]})
        if filters.get("date_to"):
            date_to_val = str(filters["date_to"]).strip()
            s = s.filter("range", document_date={"lte": f"{date_to_val}||/d"})

        if filters.get("amount_min") is not None:
            try:
                s = s.filter("range", amount={"gte": float(filters["amount_min"])})
            except (ValueError, TypeError):
                pass
        if filters.get("amount_max") is not None:
            try:
                s = s.filter("range", amount={"lte": float(filters["amount_max"])})
            except (ValueError, TypeError):
                pass

        if filters.get("tags"):
            tags = _as_list(filters["tags"])
            s = s.filter(
                "bool",
                should=[
                    Q("terms", tags=tags),
                    Q("terms", **{"tags.keyword": tags}),
                ],
                minimum_should_match=1,
            )

        if filters.get("personal_tags"):
            personal_tags = _as_list(filters["personal_tags"])
            s = s.filter(
                "bool",
                should=[
                    Q("terms", personal_tags=personal_tags),
                    Q("terms", **{"personal_tags.keyword": personal_tags}),
                ],
                minimum_should_match=1,
            )

        ordering = _as_text(data.get("ordering"))
        sortable_fields = {
            "created_at": "created_at",
            "document_date": "document_date",
            "amount": "amount",
            "reference_number": "reference_number",
            "status": "status",
        }
        if ordering:
            sort_desc = ordering.startswith("-")
            sort_key = ordering[1:] if sort_desc else ordering
            sort_field = sortable_fields.get(sort_key)
            if sort_field:
                s = s.sort(f"-{sort_field}" if sort_desc else sort_field)
        elif not search_text:
            s = s.sort("-created_at")

        start = (page - 1) * page_size
        s = s[start : start + page_size]

        s = s.highlight(
            "title",
            "reference_number",
            "supplier",
            "file_name",
            "extracted_text",
            "metadata_text",
            "tags",
            "personal_tags",
            pre_tags=["<mark>"],
            post_tags=["</mark>"],
            fragment_size=240,
            number_of_fragments=2,
            order="score",
            require_field_match=False,
        )

        try:
            response = s.execute()
        except (ApiError, ESConnectionError, TransportError):
            return Response(
                {"detail": "Search service is temporarily unavailable."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        # Fetch the selected source fields from the database as a reliable
        # fallback for excerpts. Elasticsearch can return a match without a
        # highlight fragment when the occurrence is deep in a large field.
        from apps.documents.models import Document
        source_documents = Document.objects.filter(
            id__in=[hit.meta.id for hit in response.hits]
        ).only(
            "id", "metadata", "extracted_text", "supplier", "title",
            "reference_number", "file_name", "document_type_id",
        ).prefetch_related("tags").in_bulk()

        hits = []
        for hit in response.hits:
            highlight_dict = {}
            if hasattr(hit.meta, "highlight"):
                try:
                    highlight_dict = _clean_es_highlights(hit.meta.highlight.to_dict())
                except Exception:
                    highlight_dict = {}
            source_highlights = _build_source_highlights(hit, search_text) if search_text else {}
            try:
                hit_uuid = UUID(str(hit.meta.id))
            except (ValueError, TypeError):
                hit_uuid = hit.meta.id
            source_document = source_documents.get(hit_uuid) or source_documents.get(str(hit.meta.id)) or source_documents.get(hit.meta.id)
            if source_document and search_text:
                source_highlights.update(_build_document_highlights(source_document, search_text))
            # ES highlights reflect exact query matches and token boundaries;
            # source_highlights provide intermediate context fallback for any missing fields.
            highlight_dict = {**source_highlights, **highlight_dict}

            score = getattr(hit.meta, "score", 0)
            if score is None:
                score = 0
            try:
                score = round(score, 3)
            except (TypeError, ValueError):
                score = 0

            doc_type_id = getattr(hit, "document_type_id", "")
            if not doc_type_id and source_document and getattr(source_document, "document_type_id", None):
                doc_type_id = str(source_document.document_type_id)

            hits.append({
                "id": hit.meta.id,
                "score": score,
                "title": getattr(hit, "title", ""),
                "reference_number": getattr(hit, "reference_number", ""),
                "document_type": getattr(hit, "document_type", ""),
                "document_type_id": doc_type_id,
                "file_name": getattr(hit, "file_name", ""),
                "file_mime_type": getattr(hit, "file_mime_type", ""),
                "supplier": getattr(hit, "supplier", ""),
                "amount": getattr(hit, "amount", None),
                "currency": getattr(hit, "currency", ""),
                "status": getattr(hit, "status", ""),
                "document_date": _es_value(getattr(hit, "document_date", None)),
                "is_self_upload": getattr(hit, "is_self_upload", False),
                "tags": list(getattr(hit, "tags", []) or []),
                "personal_tags": list(getattr(hit, "personal_tags", []) or []),
                "highlights": highlight_dict,
            })

        return Response({
            "total": getattr(response.hits.total, "value", response.hits.total),
            "page": page,
            "page_size": page_size,
            "results": hits,
        })

    # ── Database fallback (ELASTICSEARCH_ENABLED=False) ──────────────────────
    def _db_search(self, request):
        """
        Elasticsearch-free search over the database. Covers the common case —
        free-text across title/reference/supplier/file name/OCR text/tags plus
        the structured filters — honouring the same per-user visibility rules as
        the document list, and returning the same response shape as the ES path.
        Ranking/fuzziness are not replicated; matches are date-ordered.
        """
        from django.db.models import Q as DQ
        from django.utils import timezone
        from apps.documents.models import Document, DocumentShare

        data = request.data
        search_text = _as_text(data.get("search"))[:MAX_SEARCH_LENGTH]
        filters = _as_filter_dict(data.get("filters"))
        page = _parse_positive_int(data.get("page", 1), 1)
        page_size = _parse_positive_int(data.get("page_size", 20), 20, maximum=100)
        user = request.user

        qs = (
            Document.objects
            .exclude(document_type__code="UNCLASS")
            .filter(deleted_at__isnull=True)
            .select_related("document_type")
            .prefetch_related("tags")
        )

        # Visibility — mirror DocumentViewSet involvement rules.
        if not user.has_admin_access and not user.sees_all_documents:
            shared = DocumentShare.objects.filter(
                recipient=user, revoked_at__isnull=True,
            ).filter(
                DQ(expires_at__isnull=True) | DQ(expires_at__gt=timezone.now())
            ).values("document_id")
            qs = qs.filter(
                DQ(uploaded_by=user) |
                DQ(owned_by=user) |
                DQ(workflow_instance__tasks__assigned_to=user) |
                DQ(signature_request__signers__signer=user) |
                DQ(id__in=shared)
            ).distinct()

        # Personal documents are private to their owner — even admins / "sees all
        # documents" groups don't see another user's personal docs in search.
        qs = qs.filter(DQ(is_self_upload=False) | DQ(uploaded_by=user) | DQ(owned_by=user))

        if search_text:
            qs = qs.filter(
                DQ(title__icontains=search_text) |
                DQ(reference_number__icontains=search_text) |
                DQ(supplier__icontains=search_text) |
                DQ(file_name__icontains=search_text) |
                DQ(extracted_text__icontains=search_text) |
                DQ(tags__name__icontains=search_text)
            ).distinct()

        if filters.get("document_type"):
            dt = str(filters["document_type"]).strip()
            # Accept the display name, stable type code, or id so old search
            # URLs and the type-code based filter use the same path.
            type_q = DQ(document_type__name__iexact=dt) | DQ(document_type__code__iexact=dt)
            try:
                type_q |= DQ(document_type_id=UUID(dt))
            except (ValueError, TypeError):
                pass
            qs = qs.filter(type_q)
        if filters.get("supplier"):
            qs = qs.filter(supplier__icontains=str(filters["supplier"]).strip())
        if filters.get("status"):
            # Same semantics as DocumentFilter.filter_status (status column only).
            status_q = DQ()
            for raw in _as_list(filters["status"]):
                token = str(raw or "").strip().lower()
                if not token:
                    continue
                if token.startswith("pending"):
                    status_q |= DQ(status__icontains="pending")
                else:
                    status_q |= DQ(status=token)
            if status_q:
                qs = qs.filter(status_q).distinct()
        format_arg = filters.get("format") or filters.get("file_mime_type")
        if format_arg:
            mime_types = _expand_mime_types(format_arg)
            if mime_types:
                qs = qs.filter(file_mime_type__in=mime_types)
        if filters.get("currency"):
            qs = qs.filter(currency__iexact=str(filters["currency"]).strip())
        if filters.get("is_self_upload") is not None:
            is_self = _parse_bool(filters.get("is_self_upload"))
            if is_self is not None:
                qs = qs.filter(is_self_upload=is_self)
        if filters.get("date_from"):
            qs = qs.filter(document_date__gte=filters["date_from"])
        if filters.get("date_to"):
            qs = qs.filter(document_date__lte=filters["date_to"])
        if filters.get("amount_min") is not None:
            try:
                qs = qs.filter(amount__gte=float(filters["amount_min"]))
            except (ValueError, TypeError):
                pass
        if filters.get("amount_max") is not None:
            try:
                qs = qs.filter(amount__lte=float(filters["amount_max"]))
            except (ValueError, TypeError):
                pass
        if filters.get("tags"):
            qs = qs.filter(tags__name__in=_as_list(filters["tags"])).distinct()

        ordering = _as_text(data.get("ordering"))
        sortable = {"created_at", "document_date", "amount", "reference_number", "status"}
        if ordering:
            desc = ordering.startswith("-")
            key = ordering[1:] if desc else ordering
            qs = qs.order_by(f"-{key}" if desc else key) if key in sortable else qs.order_by("-created_at")
        else:
            qs = qs.order_by("-created_at")

        total = qs.count()
        start = (page - 1) * page_size
        docs = list(qs[start:start + page_size])

        results = []
        for doc in docs:
            highlights = _build_document_highlights(doc, search_text) if search_text else {}
            meta = doc.metadata if isinstance(doc.metadata, dict) else {}
            personal_tags = meta.get("personal_tags") or []
            if not isinstance(personal_tags, list):
                personal_tags = [personal_tags]
            results.append({
                "id": str(doc.id),
                "score": 0,
                "title": doc.title or "",
                "reference_number": doc.reference_number or "",
                "document_type": doc.document_type.name if doc.document_type_id else "",
                "document_type_id": str(doc.document_type_id) if doc.document_type_id else "",
                "file_name": doc.file_name or "",
                "file_mime_type": doc.file_mime_type or "",
                "supplier": doc.supplier or "",
                "amount": float(doc.amount) if doc.amount is not None else None,
                "currency": doc.currency or "",
                "status": doc.status or "",
                "document_date": doc.document_date.isoformat() if doc.document_date else None,
                "is_self_upload": bool(doc.is_self_upload),
                "tags": [t.name for t in doc.tags.all()],
                "personal_tags": [str(t) for t in personal_tags],
                "highlights": highlights,
            })

        return Response({
            "total": total,
            "page": page,
            "page_size": page_size,
            "results": results,
        })
