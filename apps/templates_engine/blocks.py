"""Runtime helpers for on-demand sections, buttons and linked tables.

Mirrors ``frontend/src/lib/formBlocks.ts``. Keep ``active_sections`` ordering
identical to ``activeSections`` on the client: a section that lands in a
different place on the server than the client would validate or output the
wrong fields.

Contract (see the builder brief):
  - Added sections live in the form values under ``__sections_added`` (an array
    of section ids, in click order). No schema change.
  - ``metadata.form.sections`` keeps ALL sections raw; only the effective
    sections drive calculation, validation and output.
  - An ``embed`` table reference is materialised into a plain ``table`` field
    from its saved snapshot — the server never fetches the source template.
"""
from __future__ import annotations

SECTION_KEY = "__sections_added"


def added_section_ids(values) -> list[str]:
    """The ids in ``__sections_added``, tolerant of junk, de-duplicated."""
    if not isinstance(values, dict):
        return []
    raw = values.get(SECTION_KEY)
    items = []
    if isinstance(raw, list):
        items = raw
    elif isinstance(raw, str) and raw.strip():
        import json

        try:
            parsed = json.loads(raw)
            items = parsed if isinstance(parsed, list) else raw.split(",")
        except (ValueError, TypeError):
            items = raw.split(",")
    out: list[str] = []
    for value in items:
        if isinstance(value, str):
            sid = value.strip()
        elif value is None:
            sid = ""
        else:
            sid = str(value).strip()
        if sid and sid not in out:
            out.append(sid)
    return out


def _clone_columns(columns) -> list:
    """Borrowed columns keep ids/keys but lose SunSystems bindings."""
    out = []
    for column in columns or []:
        if isinstance(column, dict):
            out.append({k: v for k, v in column.items() if k != "sunsystems"})
        else:
            out.append(column)
    return out


def materialize_sections(sections, row_pickers_as_text: bool = False) -> list[dict]:
    """Rewrite linked tables into ordinary fields. Never mutates the input."""
    out: list[dict] = []
    for section in sections or []:
        if not isinstance(section, dict):
            out.append(section)
            continue
        fields = []
        for field in section.get("fields") or []:
            if not isinstance(field, dict):
                fields.append(field)
                continue
            ref = field.get("tableRef")
            if field.get("type") != "reference" or field.get("referenceSource") != "table" or not ref:
                fields.append(dict(field))
                continue
            if ref.get("mode") == "embed":
                snapshot = ref.get("snapshot") or {}
                fields.append({
                    **field,
                    "type": "table",
                    "columns": _clone_columns(snapshot.get("columns") or []),
                    "minRows": field.get("minRows") or snapshot.get("minRows") or 1,
                    "colSpan": 12,
                    "width": 12,
                })
            elif row_pickers_as_text:
                new_field = dict(field)
                new_field["type"] = "text"
                new_field.pop("referenceSource", None)
                new_field.pop("tableRef", None)
                fields.append(new_field)
            else:
                fields.append(dict(field))
        out.append({**section, "fields": fields})
    return out


def _placement_anchor(sections, section_id: str) -> str:
    for section in sections or []:
        if not isinstance(section, dict):
            continue
        for field in section.get("fields") or []:
            if not isinstance(field, dict):
                continue
            button = field.get("button") or {}
            if (
                field.get("type") == "button"
                and button.get("action") == "add_block"
                and button.get("targetSectionId") == section_id
            ):
                if button.get("placement") == "below_button":
                    return section.get("id") or ""
                if button.get("placement") == "after_section":
                    return button.get("anchorSectionId") or ""
                return ""
    return ""


def active_sections(sections, values) -> list[dict]:
    """Normal sections plus the added on-demand ones, in the derived order.

    ``end_of_form`` appends; ``below_button`` follows the button's section;
    ``after_section`` follows ``anchorSectionId``; several blocks after the same
    anchor stack in click order. A missing anchor falls back to the end.
    """
    list_ = [s for s in (sections or []) if isinstance(s, dict)]
    ids = added_section_ids(values)
    by_id = {s.get("id") or "": s for s in list_}
    out = [s for s in list_ if not s.get("onDemand")]
    for sid in ids:
        section = by_id.get(sid)
        if not section or not section.get("onDemand"):
            continue
        if any(existing.get("id") == section.get("id") for existing in out):
            continue
        anchor = _placement_anchor(list_, sid)
        index = next((i for i, existing in enumerate(out) if existing.get("id") == anchor), -1) if anchor else -1
        if index < 0:
            out.append(section)
            continue
        at = index + 1
        while at < len(out) and out[at].get("onDemand"):
            at += 1
        out.insert(at, section)
    return out


def prune_inactive_values(sections, values) -> dict:
    """Drop values owned only by on-demand sections that were not added, and
    normalise ``__sections_added`` to known on-demand ids.

    A key owned by a normal section is never pruned (key collisions keep the
    value). Returns a new dict; the input is not mutated.
    """
    out = dict(values or {})
    known_on_demand = {
        s.get("id") for s in (sections or [])
        if isinstance(s, dict) and s.get("onDemand") and s.get("id")
    }
    normalized = [sid for sid in added_section_ids(out) if sid in known_on_demand]
    active = set(normalized)

    keep: set[str] = set()
    drop: set[str] = set()
    for section in sections or []:
        if not isinstance(section, dict):
            continue
        on_demand = bool(section.get("onDemand"))
        for field in section.get("fields") or []:
            if not isinstance(field, dict):
                continue
            key = field.get("key")
            if not key:
                continue
            if on_demand and not (section.get("id") in active):
                drop.add(key)
            else:
                keep.add(key)
    for key in drop - keep:
        out.pop(key, None)
    if normalized:
        out[SECTION_KEY] = normalized
    else:
        out.pop(SECTION_KEY, None)
    return out


def effective_sections(sections, values) -> list[dict]:
    """Prune-aware, materialised sections: the ones the server must act on."""
    return active_sections(materialize_sections(sections, row_pickers_as_text=True), values)
