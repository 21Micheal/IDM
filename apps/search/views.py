"""Search API views."""
from __future__ import annotations

import re
from collections.abc import Iterable
from datetime import date, datetime

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

_TOKEN_RE = re.compile(r"[\w-]+", re.UNICODE)
_ES_HIGHLIGHT_TAG_RE = re.compile(r"</?em>")
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


def _sentence_around_match(text: str, match_index: int, max_length: int = 260) -> str:
    if match_index < 0:
        return ""

    before = text.rfind(".", 0, match_index)
    before = max(before, text.rfind("!", 0, match_index), text.rfind("?", 0, match_index), text.rfind("\n", 0, match_index))
    start = before + 1 if before != -1 else 0

    after_candidates = [
        index for index in (
            text.find(".", match_index),
            text.find("!", match_index),
            text.find("?", match_index),
            text.find("\n", match_index),
        )
        if index != -1
    ]
    end = min(after_candidates) + 1 if after_candidates else len(text)

    if end - start > max_length:
        half_context = max_length // 2
        start = max(0, match_index - half_context)
        end = min(len(text), match_index + half_context)

    snippet = re.sub(r"\s+", " ", text[start:end]).strip()
    if start > 0:
        snippet = f"... {snippet}"
    if end < len(text):
        snippet = f"{snippet} ..."
    return snippet


def _build_source_highlights(hit, search_text: str) -> dict[str, str]:
    terms = _search_terms(search_text)
    if not terms and not search_text.strip():
        return {}

    highlights: dict[str, str] = {}
    for field in SEARCH_SNIPPET_FIELDS:
        source_text = _as_searchable_text(getattr(hit, field, ""))
        if not source_text:
            continue

        match_index = _find_match_index(source_text, search_text, terms)
        if match_index == -1:
            continue

        snippet = _sentence_around_match(source_text, match_index)
        if snippet:
            highlights[field] = snippet

    return highlights


def _clean_es_highlights(raw_highlights: dict[str, list[str] | str]) -> dict[str, str]:
    cleaned = {}
    for field, value in raw_highlights.items():
        fragments = value if isinstance(value, list) else [value]
        text = " ... ".join(str(fragment) for fragment in fragments if fragment)
        text = _ES_HIGHLIGHT_TAG_RE.sub("", text)
        if text:
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
        user = request.user
        # A "sees all documents" group member (e.g. an auditor) bypasses the
        # per-document involvement filter, exactly like the document list and the
        # DB-search fallback — otherwise search couldn't locate documents they
        # can legitimately view.
        if not user.has_admin_access and not user.sees_all_documents:
            s = s.filter("term", accessible_user_ids=str(user.id))

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
                            boost=4,
                        ),
                        Q(
                            "multi_match",
                            query=search_text,
                            fields=SEARCH_TEXT_FIELDS,
                            operator="and",
                        ),
                        Q(
                            "multi_match",
                            query=search_text,
                            fields=SEARCH_TEXT_FIELDS,
                            fuzziness="AUTO",
                            operator="and",
                        ),
                        *(
                            [
                                Q(
                                    "query_string",
                                    query=wildcard_query,
                                    fields=SEARCH_TEXT_FIELDS,
                                    default_operator="AND",
                                    analyze_wildcard=True,
                                )
                            ]
                            if wildcard_query
                            else []
                        ),
                        Q("prefix", title=search_text.lower()),
                        Q("prefix", reference_number=search_text.lower()),
                        Q("prefix", supplier=search_text.lower()),
                        Q("prefix", **{"tags": search_text.lower()}),
                        Q("prefix", **{"personal_tags": search_text.lower()}),
                    ],
                    minimum_should_match=1,
                )
            )

        if filters.get("document_type"):
            s = s.filter("term", document_type=filters["document_type"])

        if filters.get("supplier"):
            s = s.query("match_phrase_prefix", supplier=filters["supplier"])

        if filters.get("status"):
            statuses = _as_list(filters["status"])
            s = s.filter(
                "bool",
                should=[
                    Q("terms", status=statuses),
                    Q("terms", workflow_status=statuses),
                ],
                minimum_should_match=1,
            )

        if filters.get("file_mime_type"):
            mime_types = _as_list(filters["file_mime_type"])
            s = s.filter("terms", file_mime_type=mime_types)

        if filters.get("currency"):
            s = s.filter("term", currency=str(filters["currency"]).upper())

        if filters.get("is_self_upload") is not None:
            is_self_upload = _parse_bool(filters.get("is_self_upload"))
            if is_self_upload is not None:
                s = s.filter("term", is_self_upload=is_self_upload)

        if filters.get("date_from"):
            s = s.filter("range", document_date={"gte": filters["date_from"]})
        if filters.get("date_to"):
            s = s.filter("range", document_date={"lte": filters["date_to"]})

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
            s = s.filter("terms", tags=tags)

        if filters.get("personal_tags"):
            personal_tags = _as_list(filters["personal_tags"])
            s = s.filter("terms", personal_tags=personal_tags)

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
            "extracted_text",
            "metadata_text",
            "tags",
            "personal_tags",
            fragment_size=180,
            number_of_fragments=2,
            boundary_scanner="sentence",
            order="score",
            require_field_match=True,
        )

        try:
            response = s.execute()
        except (ApiError, ESConnectionError, TransportError):
            return Response(
                {"detail": "Search service is temporarily unavailable."},
                status=status.HTTP_503_SERVICE_UNAVAILABLE,
            )

        hits = []
        for hit in response.hits:
            highlight_dict = {}
            if hasattr(hit.meta, "highlight"):
                try:
                    highlight_dict = _clean_es_highlights(hit.meta.highlight.to_dict())
                except Exception:
                    highlight_dict = {}
            source_highlights = _build_source_highlights(hit, search_text) if search_text else {}
            highlight_dict = {**highlight_dict, **source_highlights}

            score = getattr(hit.meta, "score", 0)
            if score is None:
                score = 0
            try:
                score = round(score, 3)
            except (TypeError, ValueError):
                score = 0

            hits.append({
                "id": hit.meta.id,
                "score": score,
                "title": getattr(hit, "title", ""),
                "reference_number": getattr(hit, "reference_number", ""),
                "document_type": getattr(hit, "document_type", ""),
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
            dt = filters["document_type"]
            qs = qs.filter(DQ(document_type__name=dt) | DQ(document_type_id=str(dt)))
        if filters.get("supplier"):
            qs = qs.filter(supplier__icontains=filters["supplier"])
        if filters.get("status"):
            qs = qs.filter(status__in=_as_list(filters["status"]))
        if filters.get("file_mime_type"):
            qs = qs.filter(file_mime_type__in=_as_list(filters["file_mime_type"]))
        if filters.get("currency"):
            qs = qs.filter(currency=str(filters["currency"]).upper())
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

        terms = [t for t in search_text.split() if t] if search_text else []
        results = []
        for doc in docs:
            highlights = {}
            if search_text:
                for field, text in (("extracted_text", doc.extracted_text), ("title", doc.title)):
                    if not text:
                        continue
                    idx = _find_match_index(text, search_text, terms)
                    if idx != -1:
                        highlights[field] = [_sentence_around_match(text, idx)]
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
