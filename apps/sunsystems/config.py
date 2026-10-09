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
from copy import deepcopy


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

    Stage mappings inherit the parent config's ``enabled`` flag when not
    explicitly set on the stage object.
    """
    # Dynamic stages track generated requisition-stage Imprest journals and
    # LPO PurchaseOrders through the existing posting/retry surface.
    if int(stage) >= 1000:
        purpose = "imprest_retirement" if int(stage) >= 30000 else "imprest_request" if int(stage) >= 20000 else "lpo"
        postings = (
            get_imprest_retirement_postings(document) if purpose == "imprest_retirement"
            else get_imprest_request_postings(document) if purpose == "imprest_request"
            else get_purchase_order_postings(document)
        )
        offset = 30000 if purpose == "imprest_retirement" else 20000 if purpose == "imprest_request" else 1000
        index = int(stage) - offset
        if 0 <= index < len(postings):
            return postings[index]["mapping"]
        return None

    cfg = get_journal_config(document)
    if not cfg:
        return None
    parent_enabled = bool(cfg.get("enabled"))
    for s in _get_stages(cfg):
        if int(s.get("stage", 1)) == stage:
            mapping = dict(s)
            if "enabled" not in mapping and parent_enabled:
                mapping["enabled"] = True
            return mapping
    return None


def get_all_stages(document) -> list[dict]:
    """Return all stage dicts defined for this document, ordered by stage number."""
    cfg = get_journal_config(document)
    if not cfg:
        return []
    return sorted(_get_stages(cfg), key=lambda s: int(s.get("stage", 1)))


def get_purchase_order_postings(document) -> list[dict]:
    """Return table + transaction/product-group PO requests for a workflow stage."""
    config = get_sunsystems_config(document).get("purchase_order")
    if not isinstance(config, dict) or not config.get("enabled"):
        # Backward-compatible templates nested their PO mapping under journal.
        legacy = get_journal_config(document) or {}
        if not legacy.get("enabled") or str(legacy.get("component") or "").lower() != "purchaseorder":
            return []
        config = legacy
    from .mapping import expand_purchase_order_postings

    mapping_config = deepcopy(config)
    _apply_analysis_panel_mapping(mapping_config, document)
    # Separate PO profiles do not carry the builder's shared UI defaults.
    # Preserve them here so line-level blanks can fall back to the configured
    # order quantity (and other legacy UI defaults) during SSC compilation.
    ui_config = get_sunsystems_config(document).get("ui")
    if isinstance(ui_config, dict):
        mapping_config.setdefault("ui", deepcopy(ui_config))
    form = ((getattr(document, "metadata", None) or {}).get("form") or {})
    expanded = expand_purchase_order_postings(
        mapping_config,
        get_form_values(document),
        lpo_documents=form.get("lpo_documents") or [],
    )
    return [
        {
            "stage": 1000 + index,
            "label": "LPO / " + (item.get("_posting_label") or f"Purchase Order {index + 1}"),
            "mapping": item,
        }
        for index, item in enumerate(expanded)
    ]


def get_imprest_request_postings(document) -> list[dict]:
    """Build balanced Ledger Import postings for CAS_IMPREST table rows.

    The PurchaseOrder profile remains the source of common field bindings
    (description, currency, date, analysis, business unit, and requisition
    reference). Each qualifying row produces a debit/credit pair for its line
    amount, so the journal total is the sum of CAS_IMPREST rows only.
    """
    config = get_sunsystems_config(document).get("purchase_order")
    if not isinstance(config, dict) or not config.get("enabled"):
        legacy = get_journal_config(document) or {}
        if not legacy.get("enabled") or str(legacy.get("component") or "").lower() != "purchaseorder":
            return []
        config = legacy

    config = deepcopy(config)
    _apply_analysis_panel_mapping(config, document)
    from .mapping import _po_line_specs, _po_line_amount, resolve_amount, resolve_value

    po = config.get("purchase_order") or {}
    values = get_form_values(document)
    sunsystems = get_sunsystems_config(document)
    ui = sunsystems.get("ui") if isinstance(sunsystems.get("ui"), dict) else {}
    imprest_groups: dict[str, dict] = {}
    for spec in _po_line_specs(po):
        table_key = str(spec.get("repeat_over") or "")
        if not table_key or not spec.get("imprest_request_transaction_type"):
            continue
        rows = values.get(table_key)
        if not isinstance(rows, list):
            continue
        expected_type = str(spec["imprest_request_transaction_type"]).strip().casefold()
        group = imprest_groups.setdefault(table_key, {"spec": spec, "rows": []})
        for row in rows:
            if not isinstance(row, dict) or not any(value not in (None, "", [], {}) for value in row.values()):
                continue
            actual_type = resolve_value(spec.get("purchase_transaction_type"), values, row).strip().casefold()
            if actual_type == expected_type:
                group["rows"].append(row)

    postings = []
    for table_key, group in imprest_groups.items():
        spec = group["spec"]
        rows = group["rows"]
        if not rows:
            continue
        supplier_spec = po.get("supplier_code")
        supplier_fallback = po.get("supplier_code_fallback")
        lines = []
        for row in rows:
            quantity = resolve_amount(spec.get("quantity") or {"const": "1"}, values, row)
            unit_price = resolve_amount(spec.get("unit_price"), values, row)
            amount = _po_line_amount(spec, values, row, quantity, unit_price)
            if amount <= 0:
                continue
            # The Imprest table has its own debit/counter-account source
            # controls. Prefer those over the PO line's account binding, which
            # may intentionally be a fixed fallback for LPO posting.
            debit_account = (
                spec.get("imprest_request_account")
                or spec.get("account_code")
                or spec.get("account")
                or po.get("account_code")
            )
            # Supplier table selectors should resolve against this same row;
            # scalar supplier mappings and their configured fallbacks remain
            # shared with the PurchaseOrder profile.
            credit_account = spec.get("imprest_request_counter_account") or supplier_spec
            if not resolve_value(credit_account, values, row):
                row_supplier = None
                for candidate_spec in (supplier_spec, supplier_fallback):
                    if isinstance(candidate_spec, dict) and isinstance(candidate_spec.get("sources"), list):
                        row_supplier = next(
                            (candidate for candidate in candidate_spec["sources"] if candidate.get("table") == table_key),
                            None,
                        )
                        if row_supplier:
                            break
                if row_supplier:
                    credit_account = {"row_field": row_supplier.get("row_field")}
                else:
                    credit_account = po.get("supplier_code_default") or supplier_fallback or supplier_spec

            def row_spec(value_spec):
                if isinstance(value_spec, dict) and value_spec.get("table") == table_key and value_spec.get("row_field"):
                    return {"row_field": value_spec["row_field"]}
                return value_spec

            def row_value(value_spec):
                return resolve_value(row_spec(value_spec), values, row)

            common = {
                "amount": {"const": str(amount)},
                "currency": {"const": row_value(spec.get("currency") or po.get("currency") or config.get("currency"))},
                "date": {"const": row_value(spec.get("date") or po.get("date") or config.get("date"))},
                "description": {"const": row_value(spec.get("description") or po.get("comment") or po.get("description"))},
            }
            analysis = {}
            for slot, po_analysis in (po.get("analysis") or {}).items():
                code = po_analysis.get("code") if isinstance(po_analysis, dict) else po_analysis
                if code is not None:
                    analysis[str(slot)] = {"const": row_value(code)}
            for slot, code in (spec.get("analysis") or {}).items():
                analysis[str(slot)] = {"const": row_value(code)}
            if analysis:
                common["analysis"] = analysis
            lines.extend([
                {**common, "account": {"const": row_value(debit_account)}, "dc": "D"},
                {**common, "account": {"const": row_value(credit_account)}, "dc": "C"},
            ])

        if not lines:
            continue
        parameters = {
            "JournalType": ui.get("journalType") or "FGJ",
            "PostingType": "2",
            "AllowBalTran": "1",
            "AllowPostToSuspended": "N",
            "LoadOnly": "N",
            "PostProvisional": "N",
            "PostToHold": "N",
            "ReportingAccount": "999",
            "ReportErrorsOnly": "Y",
            "SuppressSubstitutedMessages": "Y",
            "SuspenseAccount": "999",
            "TransactionAmountAccount": "999",
        }
        parameters.update(config.get("parameters") or {})
        parameters.update(spec.get("imprest_request_parameters") or {})
        parameters["JournalType"] = str(parameters.get("JournalType") or ui.get("journalType") or "FGJ").strip()
        parameters["PostingType"] = str(parameters.get("PostingType") or ui.get("postingType") or "2").strip()

        journal = {
            "enabled": True,
            "component": "Journal",
            "method": "Import",
            "context": deepcopy(config.get("context") or {}),
            "parameters": parameters,
            "reference": {"const": resolve_value(po.get("second_reference") or po.get("reference"), values)},
            "validate_balance": True,
            "lines": lines,
        }
        postings.append({
            "stage": 20000 + len(postings),
            "label": f"Imprest request / {spec.get('table_label') or table_key}",
            "mapping": journal,
        })
    return postings


def _apply_analysis_panel_mapping(mapping: dict, document) -> dict:
    """Make the configured Analysis Codes panel authoritative for PO slots.

    Older templates may also contain a single-dimension external field (such
    as Cost Centre) that overwrote a panel slot when the builder compiled the
    mapping. Rebuild the PO analysis bindings from the saved panel definition
    so LPO and both Imprest paths all resolve the same configured slot values.
    """
    if not isinstance(mapping, dict):
        return mapping
    meta = getattr(document, "metadata", None) or {}
    form = meta.get("form") if isinstance(meta.get("form"), dict) else {}
    sections = form.get("sections") if isinstance(form.get("sections"), list) else []
    panel = next(
        (
            field for section in sections if isinstance(section, dict)
            for field in section.get("fields", []) if isinstance(field, dict)
            and field.get("type") == "external"
            and (field.get("external") or {}).get("source") == "analysis_codes"
            and (field.get("external") or {}).get("mode") != "single"
        ),
        None,
    )
    if not panel:
        return mapping

    external = panel.get("external") or {}
    slots = external.get("slots")
    if not isinstance(slots, list) or len(slots) != 10:
        slots = ["04", "05", "06", "03", "08", "09", "10", "11", "07", "12"]
    field_key = panel.get("key")
    ui = get_sunsystems_config(document).get("ui") or {}
    po = mapping.get("purchase_order")
    if not isinstance(po, dict):
        po = mapping
    analysis = {
        str(index): {"category": {"const": str(dimension)}, "code": {"field": field_key, "key": str(index)}}
        for index, dimension in enumerate(slots, start=1)
    }
    # Keep the explicit, system-wide Analysis 10 override when configured.
    if str(ui.get("analysis10Code") or "").strip():
        current = analysis["10"]
        if str(ui.get("analysis10Category") or "").strip():
            current["category"] = {"const": str(ui["analysis10Category"]).strip()}
        current["code"] = {"const": str(ui["analysis10Code"]).strip()}
    po["analysis"] = analysis
    return mapping


def get_imprest_retirement_postings(document) -> list[dict]:
    """Build retirement ledger imports from the form's retirement table rules.

    Retirement rules live on the retirement table's amount column, separately
    from the PO/request profiles. Reuse the request journal's common context,
    parameters, reference, date, description and analysis bindings, then replace
    its lines with the configured exact/under/over reconciliation.
    """
    meta = getattr(document, "metadata", None) or {}
    form = meta.get("form") if isinstance(meta.get("form"), dict) else {}
    sections = form.get("sections") if isinstance(form.get("sections"), list) else []
    values = get_form_values(document)
    po_postings = get_imprest_request_postings(document)
    po_config = get_sunsystems_config(document).get("purchase_order") or {}
    po = po_config.get("purchase_order") if isinstance(po_config, dict) else {}
    if not isinstance(po, dict):
        po = {}

    # Prefer the exact common ledger bindings already resolved for the
    # Imprest request. This keeps retirement in sync with the shared PO config.
    request_mapping = po_postings[0]["mapping"] if po_postings else None
    base_line = (request_mapping or {}).get("lines", [{}])[0]
    if not isinstance(base_line, dict):
        base_line = {}

    postings: list[dict] = []
    for section in sections:
        if not isinstance(section, dict):
            continue
        for table in section.get("fields") or []:
            if not isinstance(table, dict) or table.get("type") != "table":
                continue
            if table.get("workflowRole") != "retirement_expenses":
                continue
            columns = table.get("columns") if isinstance(table.get("columns"), list) else []
            amount_column = next((c for c in columns if (c.get("sunsystems") or {}).get("role") == "line_amount"), None)
            retirement = (amount_column or {}).get("sunsystems", {}).get("retirement")
            rows = values.get(table.get("key"))
            if not isinstance(retirement, dict) or not retirement.get("enabled") or not isinstance(rows, list) or not rows:
                continue

            account_column = next((c for c in columns if (c.get("sunsystems") or {}).get("role") == "account_code"), None)
            supplier_column = next((c for c in columns if (c.get("sunsystems") or {}).get("role") == "supplier_code"), None)
            first_row = next((row for row in rows if isinstance(row, dict) and any(v not in (None, "", [], {}) for v in row.values())), {})

            def scenario_account(line: dict) -> dict:
                source = str(line.get("accountSource") or "manual").strip().lower()
                col = account_column if source == "account_code" else supplier_column if source == "supplier_code" else None
                if col:
                    return {"const": str(first_row.get(col.get("key")) or "")}
                return {"const": str(line.get("account") or "")}

            scenarios = {}
            for scenario_name in ("exact", "under", "over"):
                configured = retirement.get(scenario_name) or {}
                scenarios[scenario_name] = {
                    "lines": [
                        {
                            "account": scenario_account(line),
                            "dc": line.get("dc") or "D",
                            "amount_source": line.get("amountSource") or "spent",
                        }
                        for line in configured.get("lines", [])
                        if isinstance(line, dict)
                    ]
                }

            issued_amount: dict = {"const": "0"}
            if str(retirement.get("issuedAmountMode") or "field") == "imprest_request_total" or not retirement.get("issuedAmountField"):
                for spec in (po.get("lines") or []):
                    request_table = str(spec.get("repeat_over") or "")
                    transaction_type = str(spec.get("imprest_request_transaction_type") or "").strip()
                    if not request_table or not transaction_type:
                        continue
                    amount_spec = spec.get("amount") or spec.get("unit_price") or spec.get("quantity")
                    amount_column_key = amount_spec.get("row_field") if isinstance(amount_spec, dict) else None
                    type_spec = spec.get("purchase_transaction_type")
                    match_column_key = type_spec.get("row_field") if isinstance(type_spec, dict) else None
                    if amount_column_key and match_column_key:
                        issued_amount = {
                            "sum_matching_rows": {
                                "table": request_table,
                                "amount_column": amount_column_key,
                                "match_column": match_column_key,
                                "values": [transaction_type],
                            }
                        }
                        break
            elif retirement.get("issuedAmountField"):
                issued_amount = {"field": retirement["issuedAmountField"]}

            retirement_line = {
                "retirement": {
                    "issued_amount": issued_amount,
                    "spent_amount": {"table": table.get("key"), "column": amount_column.get("key")},
                    "scenarios": scenarios,
                }
            }
            currency_column = next(
                (c for c in columns if (c.get("sunsystems") or {}).get("role") == "currency" or str(c.get("label") or "").strip().casefold() == "currency"),
                None,
            )
            line_defaults = {key: base_line[key] for key in ("currency", "date", "description", "analysis") if key in base_line}
            if currency_column:
                line_defaults["currency"] = {"const": str(first_row.get(currency_column.get("key")) or "")}
            retirement_line.update(line_defaults)
            postings.append({
                "stage": 30000 + len(postings),
                "label": f"Imprest retirement / {table.get('label') or table.get('key')}",
                "mapping": {
                    "enabled": True,
                    "component": "Journal",
                    "method": "Import",
                    "context": deepcopy((request_mapping or {}).get("context") or po_config.get("context") or {}),
                    "parameters": deepcopy((request_mapping or {}).get("parameters") or {}),
                    "reference": deepcopy((request_mapping or {}).get("reference") or po.get("second_reference") or po.get("reference") or {"const": getattr(document, "reference_number", "")}),
                    "validate_balance": True,
                    "lines": [retirement_line],
                },
            })
    return postings


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

    ss_mapping = deepcopy(ss_mapping)
    ui = ss_mapping.get("ui") if isinstance(ss_mapping.get("ui"), dict) else {}
    analysis10_code = str(ui.get("analysis10Code") or "").strip()
    analysis10_category = str(ui.get("analysis10Category") or "").strip()
    if analysis10_code:
        # The explicit Analysis 10 control in the builder is a posting config
        # override. Older saved templates may still have a dynamic Analysis 10
        # binding to the form's analysis panel, so apply the latest UI override
        # when refreshing a document for retry.
        for profile_key in ("purchase_order", "journal"):
            profile = ss_mapping.get(profile_key)
            if not isinstance(profile, dict):
                continue
            po = profile.get("purchase_order")
            if not isinstance(po, dict) and str(profile.get("component") or "").lower() == "purchaseorder":
                po = profile
            if not isinstance(po, dict):
                continue
            analysis = po.get("analysis")
            analysis = dict(analysis) if isinstance(analysis, dict) else {}
            current = analysis.get("10")
            slot = dict(current) if isinstance(current, dict) else {}
            if analysis10_category:
                slot["category"] = {"const": analysis10_category}
            slot["code"] = {"const": analysis10_code}
            analysis["10"] = slot
            po["analysis"] = analysis

    meta["sunsystems"] = ss_mapping
    document.metadata = meta
    type(document).objects.filter(pk=document.pk).update(metadata=meta)
    return True


def journal_posting_enabled(document) -> bool:
    cfg = get_journal_config(document)
    po_cfg = get_sunsystems_config(document).get("purchase_order")
    return bool((cfg and cfg.get("enabled")) or (isinstance(po_cfg, dict) and po_cfg.get("enabled")))


def post_triggers(document) -> dict[str, int]:
    """Return a mapping of {outcome_string: stage_number} for all enabled stages.

    When stages share the same ``post_on`` value (e.g. both use ``"approved"``
    in a phase-based flow), the lowest-numbered stage wins in this dict.
    Use :func:`find_stage_to_post` for the live workflow-hook dispatch path.
    """
    cfg = get_journal_config(document)
    if not cfg or not cfg.get("enabled"):
        return {}
    result: dict[str, int] = {}
    for s in sorted(_get_stages(cfg), key=lambda x: int(x.get("stage", 1))):
        trigger = str(s.get("post_on") or "approved").strip()
        stage_num = int(s.get("stage", 1))
        # First (lowest) stage wins per trigger key.
        result.setdefault(trigger, stage_num)
    return result


def find_stage_to_post(document, outcome: str) -> int | None:
    """Return the stage number to post for ``outcome``, or None.

    Handles the phase-based imprest case where multiple stages share the same
    ``post_on`` value (e.g. both Stage 1 and Stage 2 fire on ``"approved"``):
    it skips stages that are already POSTED and returns the first unposted one.
    Called by the workflow hook after each approval outcome.
    """
    cfg = get_journal_config(document)
    if not cfg or not cfg.get("enabled"):
        return None

    try:
        from .models import JournalPosting, JournalPostingStatus
        posted = set(
            JournalPosting.objects
            .filter(document=document, status=JournalPostingStatus.POSTED)
            .values_list("stage", flat=True)
        )
    except Exception:  # pragma: no cover - DB not ready during tests
        posted = set()

    for s in sorted(_get_stages(cfg), key=lambda x: int(x.get("stage", 1))):
        trigger = str(s.get("post_on") or "approved").strip()
        stage_num = int(s.get("stage", 1))
        if trigger == outcome and stage_num not in posted:
            return stage_num
    return None


def find_stages_to_post(document, outcomes: list[str]) -> list[int]:
    """Return every unposted journal stage whose trigger is in outcomes."""
    cfg = get_journal_config(document)
    if not cfg or not cfg.get("enabled"):
        return []
    try:
        from .models import JournalPosting, JournalPostingStatus
        posted = set(JournalPosting.objects.filter(
            document=document, status=JournalPostingStatus.POSTED,
        ).values_list("stage", flat=True))
    except Exception:
        posted = set()
    triggers = {str(outcome).strip() for outcome in outcomes}
    return [
        int(stage.get("stage", 1))
        for stage in sorted(_get_stages(cfg), key=lambda item: int(item.get("stage", 1)))
        if str(stage.get("post_on") or "approved").strip() in triggers
        and int(stage.get("stage", 1)) not in posted
    ]


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
