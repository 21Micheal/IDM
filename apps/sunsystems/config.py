"""
apps/sunsystems/config.py

Helpers for reading the SunSystems integration configuration off a document.

A form template carries a ``sunsystems`` config block (journal mapping + budget
mapping + optional connection override). At fill time it is **snapshotted** onto
the created document's ``metadata.sunsystems`` so posting/budget checks depend on
the document alone and survive later template edits. These helpers are the one
place that knows that layout.

Multi-stage mapping shape
-------------------------
A template can define multiple posting stages via a ``stages`` list::

    {
      "enabled": true,
      "stages": [
        {
          "stage": 1,
          "label": "Advance",
          "post_on": "approved",
          "component": "Journal", "method": "Import",
          "context": {...}, "parameters": {...},
          "lines": [...]
        },
        {
          "stage": 2,
          "label": "Retirement",
          "post_on": "retirement_approved",
          "lines": [...]
        }
      ]
    }

Legacy (single-stage) mappings that have no ``stages`` key are treated as stage 1
transparently, preserving backwards compatibility.
"""
from __future__ import annotations


def get_sunsystems_config(document) -> dict:
    meta = getattr(document, "metadata", None) or {}
    cfg = meta.get("sunsystems")
    return cfg if isinstance(cfg, dict) else {}


def get_journal_config(document) -> dict | None:
    """Return the raw journal config block (may contain ``stages`` list or be a
    flat legacy mapping)."""
    mapping = get_sunsystems_config(document).get("journal")
    return mapping if isinstance(mapping, dict) else None


def _get_stages(journal_cfg: dict) -> list[dict]:
    """Return the list of stage dicts from a journal config.

    Wraps a legacy flat mapping (no ``stages`` key) into a one-element list so
    the rest of the code never needs to branch on the schema version.
    """
    stages = journal_cfg.get("stages")
    if isinstance(stages, list) and stages:
        return [s for s in stages if isinstance(s, dict)]
    # Legacy: the entire mapping *is* stage 1.
    return [dict(journal_cfg, stage=1)]


def get_journal_mapping(document, stage: int = 1) -> dict | None:
    """Return the resolved mapping for ``stage`` (1-based), or None.

    For a legacy flat mapping (no ``stages`` array), stage 1 returns the mapping
    itself and any other stage returns None.
    """
    cfg = get_journal_config(document)
    if not cfg:
        return None
    for s in _get_stages(cfg):
        if int(s.get("stage", 1)) == stage:
            return s
    return None


def get_all_stages(document) -> list[dict]:
    """Return all stage dicts defined for this document, ordered by stage number."""
    cfg = get_journal_config(document)
    if not cfg:
        return []
    return sorted(_get_stages(cfg), key=lambda s: int(s.get("stage", 1)))


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


def refresh_sunsystems_config_from_template(document) -> bool:
    """Refresh a form document's SunSystems mapping from its current template.

    Documents snapshot the mapping at creation time for audit/reproducibility.
    A retry is different: it often follows a deliberate integration fix in the
    template/builder, so it should rebuild the payload from the latest mapping.
    The filled form values remain untouched.
    """
    meta = dict(getattr(document, "metadata", None) or {})
    form = meta.get("form") if isinstance(meta.get("form"), dict) else {}
    template_id = form.get("template_id") or meta.get("template_id")
    if not template_id:
        return False

    try:
        from apps.templates_engine.models import DocumentTemplate

        template = DocumentTemplate.objects.filter(pk=template_id).first()
    except Exception:  # pragma: no cover - defensive import/db guard
        return False

    ss_mapping = getattr(template, "sunsystems", None) if template else None
    if not isinstance(ss_mapping, dict) or not ss_mapping:
        return False

    meta["sunsystems"] = ss_mapping
    document.metadata = meta
    type(document).objects.filter(pk=document.pk).update(metadata=meta)
    return True


def journal_posting_enabled(document) -> bool:
    cfg = get_journal_config(document)
    return bool(cfg and cfg.get("enabled"))


def post_triggers(document) -> dict[str, int]:
    """Return a mapping of {outcome_string: stage_number} for all enabled stages.

    Example: ``{"approved": 1, "retirement_approved": 2}``

    The workflow hook calls this to find which stage (if any) to fire when a
    particular workflow outcome lands.
    """
    cfg = get_journal_config(document)
    if not cfg or not cfg.get("enabled"):
        return {}
    result: dict[str, int] = {}
    for s in _get_stages(cfg):
        trigger = str(s.get("post_on") or "approved").strip()
        stage_num = int(s.get("stage", 1))
        result[trigger] = stage_num
    return result


def post_trigger(document, default: str = "approved") -> str:
    """Legacy single-trigger accessor (stage 1 only). Kept for backwards compat."""
    mapping = get_journal_mapping(document, stage=1) or {}
    value = mapping.get("post_on") or default
    return str(value)


def redact_connection(conn: dict | None) -> dict:
    """Mask secrets before returning a connection to the browser."""
    out = dict(conn or {})
    for key in ("password",):
        if out.get(key):
            out[key] = "********"
    return out
