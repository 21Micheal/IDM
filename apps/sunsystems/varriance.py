"""
apps/sunsystems/variance.py

Computes the imprest retirement variance (issued/requested vs. actually
spent) for DISPLAY — the Forms report table's "Variance" column and the
form's own detail page. Deliberately separate from journal.py/mapping.py:
this is read-only (no XML, no posting, no side effects beyond the optional
persistence helper in builder_workflow.sync_retirement_variance) — just "what
would classify_retirement say about this document's CURRENT form values
right now".

Safe to call at any point in a form's lifecycle. Returns None when there's
nothing to classify yet (no retirement mapping configured on this template,
or no form values saved yet).
"""
from __future__ import annotations

from .config import _get_stages, get_form_values, get_journal_config
from .mapping import classify_retirement, resolve_amount, _amount_str


def _resolve_retirement_source_config(document) -> dict:
    """The journal config to read the retirement mapping FROM — the live
    template's current config when available, else the document's own
    frozen snapshot. See the module docstring above for why "live template"
    is the right choice for a read-only/display computation like this one."""
    meta = getattr(document, "metadata", None) or {}
    form = meta.get("form") if isinstance(meta.get("form"), dict) else {}
    template_id = form.get("template_id") or meta.get("template_id")
    if template_id:
        try:
            from apps.templates_engine.models import DocumentTemplate

            template = DocumentTemplate.objects.filter(pk=template_id).first()
            ss = getattr(template, "sunsystems", None) if template else None
            if isinstance(ss, dict) and isinstance(ss.get("journal"), dict):
                return ss["journal"]
        except Exception:
            pass
    # No template_id, template deleted, or templates_engine unavailable —
    # fall back to whatever this document itself snapshotted at creation.
    return get_journal_config(document) or {}


def _find_retirement_mapping(document) -> dict | None:
    """Return the first configured `retirement` line spec across all posting
    stages for this document's (live-template-preferred) journal config.
    There is normally at most one (stage 2 / "Retirement"), but this doesn't
    assume a stage number — it just looks for whichever stage's `lines`
    includes a `retirement` entry."""
    cfg = _resolve_retirement_source_config(document)
    if not cfg:
        return None
    for stage in _get_stages(cfg):
        for line_spec in stage.get("lines") or []:
            if isinstance(line_spec, dict) and line_spec.get("retirement"):
                return line_spec["retirement"]
    return None


def compute_retirement_variance(document) -> dict | None:
    """Return a JSON-safe variance summary for `document`, or None if this
    form has no retirement mapping configured (a request-only form, or a
    template whose Retirement panel was never wired up) or has no form
    values yet.

    Shape:
        {
          "scenario": "exact" | "under" | "over",
          "kind": "under" | "over" | None,   # None for "exact" — no badge to show
          "amount": "0.00",                  # |spent - issued|, always non-negative
          "issued": "0.00",
          "spent": "0.00",
        }

    `kind` / `amount` are exactly what FormsPage.tsx's getFormVariance() and
    FormDetailPage already read off `metadata.form.retirement_variance` — no
    frontend change needed once this is wired up to persist.
    """
    retirement = _find_retirement_mapping(document)
    if not retirement:
        return None

    values = get_form_values(document)
    if not values:
        return None

    classified = classify_retirement(retirement, values)
    scenario = classified["scenario"]

    return {
        "scenario": scenario,
        "kind": scenario if scenario in ("under", "over") else None,
        "amount": _amount_str(classified["variance"]),
        "issued": _amount_str(classified["issued"]),
        "spent": _amount_str(classified["spent"]),
    }


def get_requested_amount(document) -> str | None:
    """Resolve "the amount requested/issued for this imprest" straight from
    the form's own values, using the field the retirement mapping's
    `issued_amount` spec names — the only place in the mapping schema this
    amount is identified by an admin, so it's authoritative rather than a
    guessed field-name.

    Available from the REQUEST phase onward — unlike
    compute_retirement_variance() above, this doesn't depend on the
    retirement "spent" table having any rows yet (that table is normally
    only fillable once the form reaches the retirement step). Returns None
    when there's no retirement mapping configured at all (nothing names
    which field this is) or no form values saved yet.
    """
    retirement = _find_retirement_mapping(document)
    if not retirement:
        return None
    values = get_form_values(document)
    if not values:
        return None
    issued_spec = retirement.get("issued_amount") or {}
    return _amount_str(resolve_amount(issued_spec, values))