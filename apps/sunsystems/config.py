"""
apps/sunsystems/config.py

Helpers for reading the SunSystems integration configuration off a document.

A form template carries a ``sunsystems`` config block (journal mapping + budget
mapping + optional connection override). At fill time it is **snapshotted** onto
the created document's ``metadata.sunsystems`` so posting/budget checks depend on
the document alone and survive later template edits. These helpers are the one
place that knows that layout.
"""
from __future__ import annotations


def get_sunsystems_config(document) -> dict:
    meta = getattr(document, "metadata", None) or {}
    cfg = meta.get("sunsystems")
    return cfg if isinstance(cfg, dict) else {}


def get_journal_mapping(document) -> dict | None:
    mapping = get_sunsystems_config(document).get("journal")
    return mapping if isinstance(mapping, dict) else None


def get_budget_mapping(document) -> dict | None:
    mapping = get_sunsystems_config(document).get("budget")
    return mapping if isinstance(mapping, dict) else None


def get_connection_override(document) -> dict:
    conn = get_sunsystems_config(document).get("connection")
    return conn if isinstance(conn, dict) else {}


def get_form_values(document) -> dict:
    """The filled form's structured values (header fields + table arrays)."""
    meta = getattr(document, "metadata", None) or {}
    form = meta.get("form")
    if isinstance(form, dict) and isinstance(form.get("values"), dict):
        return form["values"]
    return {}


def journal_posting_enabled(document) -> bool:
    mapping = get_journal_mapping(document)
    return bool(mapping and mapping.get("enabled"))


def post_trigger(document, default: str = "approved") -> str:
    """Workflow outcome on which the journal should post (e.g. "approved")."""
    mapping = get_journal_mapping(document) or {}
    value = mapping.get("post_on") or default
    return str(value)


def redact_connection(conn: dict | None) -> dict:
    """Mask secrets before returning a connection to the browser."""
    out = dict(conn or {})
    for key in ("password",):
        if out.get(key):
            out[key] = "********"
    return out
