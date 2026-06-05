"""Helpers for making Elasticsearch indexing failures easier to diagnose."""

from __future__ import annotations

from typing import Any


def _build_search_index_exceptions() -> tuple:
    """
    All Elasticsearch/transport errors that the synchronous index signal can raise
    during a document write — whether ES is read-only (BulkIndexError),
    unreachable (ConnectionError), timing out, or returning an API error.

    Document writes catch these so persistence never fails just because search
    indexing did; indexing catches up later (signals re-fire / reindex job).
    """
    collected: list[type] = []
    try:
        from elasticsearch.helpers import BulkIndexError
        collected.append(BulkIndexError)
    except Exception:  # pragma: no cover - import guard
        pass
    try:
        # elastic_transport is the transport layer for elasticsearch>=8; ConnectionError
        # and ConnectionTimeout subclass TransportError.
        from elastic_transport import TransportError
        collected.append(TransportError)
    except Exception:  # pragma: no cover
        pass
    try:
        # API-level errors (and, on older clients, the common base class).
        from elasticsearch import ApiError
        collected.append(ApiError)
    except Exception:  # pragma: no cover
        pass
    try:
        from elasticsearch.exceptions import ElasticsearchException
        collected.append(ElasticsearchException)
    except Exception:  # pragma: no cover
        pass
    return tuple(dict.fromkeys(collected)) or (Exception,)


# Tuple usable directly in `except SEARCH_INDEX_EXCEPTIONS:` clauses.
SEARCH_INDEX_EXCEPTIONS = _build_search_index_exceptions()


def summarize_bulk_index_error(exc: Exception) -> str:
    """
    Return a concise, operator-friendly summary for BulkIndexError payloads.

    We keep this intentionally short because the raw bulk error can include the
    entire document body, which makes logs noisy and obscures the actual cause.
    """
    errors = getattr(exc, "errors", None)
    if not isinstance(errors, list) or not errors:
        return str(exc)

    reasons: list[str] = []
    for item in errors:
        if not isinstance(item, dict):
            continue
        for action in item.values():
            if not isinstance(action, dict):
                continue
            reason = _extract_error_reason(action)
            if reason and reason not in reasons:
                reasons.append(reason)

    if not reasons:
        return str(exc)
    return "; ".join(reasons)


def _extract_error_reason(action: dict[str, Any]) -> str | None:
    error = action.get("error")
    if not isinstance(error, dict):
        return None

    error_type = str(error.get("type") or "").strip()
    reason = str(error.get("reason") or "").strip()

    if error_type == "cluster_block_exception" and "read-only-allow-delete" in reason:
        return (
            "Elasticsearch index is read-only because disk usage crossed the "
            "flood-stage watermark. Free disk space and clear the block before retrying."
        )

    if error_type and reason:
        return f"{error_type}: {reason}"
    return reason or error_type or None
