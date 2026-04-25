"""Helpers for making Elasticsearch indexing failures easier to diagnose."""

from __future__ import annotations

from typing import Any


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
