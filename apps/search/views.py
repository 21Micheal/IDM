"""Search API views."""
from __future__ import annotations

import re
from collections.abc import Iterable

from rest_framework.views import APIView
from rest_framework.response import Response
from rest_framework.permissions import IsAuthenticated
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
        from .documents import DocumentIndex

        data = request.data
        search_text = data.get("search", "").strip()
        filters = data.get("filters", {}) or {}
        page = max(1, int(data.get("page", 1)))
        page_size = min(100, int(data.get("page_size", 20)))

        s = DocumentIndex.search()
        user = request.user
        if not user.has_admin_access:
            from apps.documents.models import Document
            from django.db.models import Q as DjangoQ

            accessible_ids = (
                Document.objects
                .filter(
                    DjangoQ(uploaded_by=user)
                    | DjangoQ(
                        workflow_instance__tasks__assigned_to=user,
                        workflow_instance__tasks__status__in=[
                            "pending", "in_progress", "held", "returned",
                        ],
                    )
                )
                .values_list("id", flat=True)
                .distinct()
            )
            s = s.filter("ids", values=[str(doc_id) for doc_id in accessible_ids])

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

        if filters.get("status"):
            statuses = filters["status"]
            if isinstance(statuses, str):
                statuses = [statuses]
            s = s.filter("terms", status=statuses)

        if filters.get("is_self_upload") is not None:
            s = s.filter("term", is_self_upload=bool(filters["is_self_upload"]))

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
            tags = filters["tags"]
            if isinstance(tags, str):
                tags = [tags]
            s = s.filter("terms", tags=tags)

        if filters.get("personal_tags"):
            personal_tags = filters["personal_tags"]
            if isinstance(personal_tags, str):
                personal_tags = [personal_tags]
            s = s.filter("terms", personal_tags=personal_tags)

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

        response = s.execute()

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

            hits.append({
                "id": hit.meta.id,
                "score": round(getattr(hit.meta, "score", 0), 3),
                "title": getattr(hit, "title", ""),
                "reference_number": getattr(hit, "reference_number", ""),
                "document_type": getattr(hit, "document_type", ""),
                "file_name": getattr(hit, "file_name", ""),
                "file_mime_type": getattr(hit, "file_mime_type", ""),
                "supplier": getattr(hit, "supplier", ""),
                "amount": getattr(hit, "amount", None),
                "status": getattr(hit, "status", ""),
                "document_date": getattr(hit, "document_date", None),
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
