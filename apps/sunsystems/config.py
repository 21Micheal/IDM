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


def _remap_saved_table_keys(mapping: dict, document, values: dict | None = None) -> dict:
    """Bind refreshed mappings to the table keys saved with a submitted form.

    A retry refreshes mapping config from the current template, but the filled
    document intentionally retains the form schema and value keys it was
    submitted with. If a table was renamed in the builder, its generated
    suffix remains stable while its label-derived prefix changes (for example
    ``travel_requisition_ab12`` to ``ticket_ab12``). Remap only references
    whose target key is absent from submitted values and has one unambiguous
    saved-table suffix match.
    """
    if not isinstance(mapping, dict):
        return mapping
    values = values if isinstance(values, dict) else get_form_values(document)
    meta = getattr(document, "metadata", None) or {}
    form = meta.get("form") if isinstance(meta.get("form"), dict) else {}
    saved_tables = {
        str(field.get("key"))
        for section in form.get("sections") or [] if isinstance(section, dict)
        for field in section.get("fields") or []
        if isinstance(field, dict) and field.get("type") == "table" and field.get("key")
    }
    value_tables = {
        key for key, value in values.items()
        if isinstance(key, str) and isinstance(value, list)
    }
    available = saved_tables & value_tables
    aliases: dict[str, str] = {}

    def visit(value):
        if isinstance(value, dict):
            for key, child in list(value.items()):
                if key in {"repeat_over", "table"} and isinstance(child, str) and child not in value_tables:
                    suffix = child.rsplit("_", 1)[-1]
                    candidates = [table_key for table_key in available if table_key.rsplit("_", 1)[-1] == suffix]
                    if len(candidates) == 1:
                        aliases[child] = candidates[0]
                        value[key] = candidates[0]
                    elif child in aliases:
                        value[key] = aliases[child]
                else:
                    visit(child)
        elif isinstance(value, list):
            for child in value:
                visit(child)

    visit(mapping)
    return mapping


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
    _apply_po_line_amount_columns(mapping_config, document)
    # Separate PO profiles do not carry the builder's shared UI defaults.
    # Preserve them here so line-level blanks can fall back to the configured
    # order quantity (and other legacy UI defaults) during SSC compilation.
    ui_config = get_sunsystems_config(document).get("ui")
    if isinstance(ui_config, dict):
        mapping_config.setdefault("ui", deepcopy(ui_config))
    values = get_form_values(document)
    _remap_saved_table_keys(mapping_config, document, values)
    form = ((getattr(document, "metadata", None) or {}).get("form") or {})
    expanded = expand_purchase_order_postings(
        mapping_config,
        values,
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


def _apply_po_line_amount_columns(mapping: dict, document) -> dict:
    """Use each table's current Line amount role as its PO transaction value.

    The form schema is authoritative for line amounts. This also fixes older
    saved PO profiles whose amount binding predates a column being mapped to
    the Line amount role.
    """
    po = mapping.get("purchase_order") if isinstance(mapping, dict) else None
    if not isinstance(po, dict):
        return mapping
    form = ((getattr(document, "metadata", None) or {}).get("form") or {})
    tables = {
        str(field.get("key")): field
        for section in form.get("sections") or [] if isinstance(section, dict)
        for field in section.get("fields") or []
        if isinstance(field, dict) and field.get("type") == "table" and field.get("key")
    }
    for spec in po.get("lines") or []:
        if not isinstance(spec, dict):
            continue
        table = tables.get(str(spec.get("repeat_over") or ""))
        if not table:
            continue
        columns = [column for column in table.get("columns") or [] if isinstance(column, dict)]
        amount_column = next((column for column in columns if ((column.get("sunsystems") or {}).get("role") or "").strip().lower() == "travel_line_amount" and column.get("key")), None)
        if not amount_column:
            amount_column = next((column for column in columns if ((column.get("sunsystems") or {}).get("role") or "").strip().lower() == "line_amount" and column.get("key")), None)
        if amount_column:
            spec["amount"] = {"row_field": amount_column["key"]}
    return mapping


def get_imprest_request_postings(document) -> list[dict]:
    """Build balanced Ledger Import postings for General / Imprest table rows.

    The PurchaseOrder profile remains the source of common field bindings
    (description, currency, date, analysis, business unit, and requisition
    reference). Each populated row produces a debit/credit pair for its line
    amount; the table itself is exclusively the Imprest request source.
    """
    sunsystems = get_sunsystems_config(document)
    config = sunsystems.get("imprest_request")
    if not isinstance(config, dict) or not config.get("enabled"):
        config = sunsystems.get("purchase_order")
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
    _remap_saved_table_keys(config, document, values)
    po = config.get("purchase_order") or {}
    # The Imprest profile can intentionally have no PurchaseOrder line specs;
    # it only carries the separate Imprest request table/account settings. The
    # shared analysis bindings live on the main LPO profile, so use that as the
    # authoritative source (and apply the configured Analysis Codes panel to
    # it as well).
    lpo_mapping = deepcopy(sunsystems.get("purchase_order") or {})
    _apply_analysis_panel_mapping(lpo_mapping, document)
    _remap_saved_table_keys(lpo_mapping, document, values)
    lpo_po = lpo_mapping.get("purchase_order") or {}
    # Imprest request postings share the requisition's Analysis Dimensions with
    # the LPO. Those bindings are often row-scoped on the LPO line spec (for
    # example, a Budget Line column), so resolving po.analysis against an
    # Imprest itinerary row silently produced empty values and the journal
    # builder substituted '#'. Resolve the configured LPO analysis against its
    # own source row once, then reuse those codes for every Imprest line. The
    # Imprest table still supplies its own account code independently.
    shared_analysis: dict[str, str] = {}
    analysis_specs = []
    if isinstance(lpo_po.get("analysis"), dict):
        analysis_specs.append((lpo_po.get("analysis"), None))
    for po_line_spec in _po_line_specs(lpo_po):
        line_analysis = po_line_spec.get("analysis")
        if not isinstance(line_analysis, dict):
            continue
        source_rows = values.get(str(po_line_spec.get("repeat_over") or ""))
        source_row = next(
            (
                candidate for candidate in (source_rows if isinstance(source_rows, list) else [])
                if isinstance(candidate, dict)
                and any(value not in (None, "", [], {}) for value in candidate.values())
            ),
            None,
        )
        analysis_specs.append((line_analysis, source_row))
    for analysis_spec, source_row in analysis_specs:
        for slot, slot_spec in analysis_spec.items():
            if str(slot) in shared_analysis:
                continue
            code_spec = slot_spec.get("code") if isinstance(slot_spec, dict) else slot_spec
            code = resolve_value(code_spec, values, source_row)
            # '#' is SunSystems' Not Analysed marker. Treat it as missing here
            # so a populated row-level LPO binding can supply the same slot.
            if code and code.strip() != "#":
                shared_analysis[str(slot)] = code
    sunsystems = get_sunsystems_config(document)
    ui = sunsystems.get("ui") if isinstance(sunsystems.get("ui"), dict) else {}
    imprest_groups: dict[str, dict] = {}
    request_specs = po.get("imprest_request_lines")
    if not isinstance(request_specs, list):
        # Backwards compatibility for mappings saved before Imprest lines were
        # separated from the PurchaseOrder profile.
        request_specs = [
            spec for spec in _po_line_specs(po)
            if isinstance(spec, dict) and spec.get("imprest_request_transaction_type")
        ]
    for spec in request_specs:
        table_key = str(spec.get("repeat_over") or "")
        if not table_key:
            continue
        rows = values.get(table_key)
        if not isinstance(rows, list):
            continue
        group = imprest_groups.setdefault(table_key, {"spec": spec, "rows": []})
        for row in rows:
            if not isinstance(row, dict) or not any(value not in (None, "", [], {}) for value in row.values()):
                continue
            include_if = spec.get("include_if")
            if isinstance(include_if, dict) and not resolve_value(include_if, values, row).strip():
                continue
            exclude_if = spec.get("exclude_if")
            if isinstance(exclude_if, dict) and resolve_value(exclude_if, values, row).strip():
                continue
            group["rows"].append(row)

    postings = []
    for table_key, group in imprest_groups.items():
        spec = group["spec"]
        rows = group["rows"]
        if not rows:
            continue
        supplier_spec = po.get("supplier_code")
        supplier_fallback = po.get("supplier_code_fallback")
        # The Imprest amount is the table column explicitly mapped as
        # SunSystems "Line amount". Do not reconstruct it from quantity ×
        # unit price: the form may calculate VAT/gross totals in that column.
        line_amount_key = None
        table_columns = []
        dsa_amount_column = None
        form = (getattr(document, "metadata", None) or {}).get("form") or {}
        for section in form.get("sections") or []:
            for field in section.get("fields") or []:
                if field.get("type") != "table" or field.get("key") != table_key:
                    continue
                columns = [column for column in field.get("columns") or [] if isinstance(column, dict)]
                table_columns = columns
                explicit_dsa_amount = next((column for column in columns if str(((column.get("sunsystems") or {}).get("role") or "")).strip().lower() == "dsa_line_amount"), None)
                dsa_amount_column = explicit_dsa_amount
                has_travel_amount = any(str(((column.get("sunsystems") or {}).get("role") or "")).strip().lower() == "travel_line_amount" for column in columns)
                for column in columns:
                    role = str(((column.get("sunsystems") or {}).get("role") or "")).strip().lower()
                    if role == "dsa_line_amount" or (role == "line_amount" and not has_travel_amount and not explicit_dsa_amount):
                        line_amount_key = column.get("key")
                        break
                break
            if line_amount_key:
                break
        lines = []
        for row in rows:
            quantity = resolve_amount(spec.get("quantity") or {"const": "1"}, values, row)
            unit_price = resolve_amount(spec.get("unit_price"), values, row)
            amount = (
                resolve_amount({"row_field": line_amount_key}, values, row)
                if line_amount_key else _po_line_amount(spec, values, row, quantity, unit_price)
            )
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
            credit_account = spec.get("imprest_request_counter_account")
            if not credit_account and isinstance(dsa_amount_column, dict):
                # Older document snapshots can predate compilation of the
                # amount column's counter-account settings into the posting
                # spec. Read the saved column config directly so retries still
                # honor its configured counter account instead of silently
                # using the supplier as the ledger counter account.
                amount_sunsystems = dsa_amount_column.get("sunsystems") or {}
                counter_source = str(amount_sunsystems.get("counterAccountSource") or "manual").strip().lower()
                if counter_source == "manual" and amount_sunsystems.get("counterAccount"):
                    credit_account = {"const": str(amount_sunsystems["counterAccount"]).strip()}
                elif counter_source == "account_code":
                    dsa_account_column = next(
                        (column for column in table_columns if str(((column.get("sunsystems") or {}).get("role") or "")).strip().lower() == "dsa_account_code"),
                        None,
                    )
                    budget_line_column = next(
                        (column for column in table_columns if column.get("type") == "budget_line" or str(((column.get("sunsystems") or {}).get("role") or "")).strip().lower() == "budget_line"),
                        None,
                    )
                    if dsa_account_column:
                        credit_account = {"row_field": dsa_account_column.get("key")}
                    elif budget_line_column:
                        credit_account = {"row_field": budget_line_column.get("key"), "key": "dsa_account_code"}
                elif counter_source == "supplier_code":
                    credit_account = supplier_spec
            credit_account = credit_account or supplier_spec
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
                    credit_account = supplier_fallback or supplier_spec

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
            analysis = {
                slot: {"const": code}
                for slot, code in shared_analysis.items()
            }
            # In a merged Ticket/DSA table the budget-line analysis belongs to
            # each source row. Resolve those shared dimensions from the DSA
            # row itself, while retaining LPO analysis as the legacy fallback.
            row_analysis = spec.get("analysis") if isinstance(spec.get("analysis"), dict) else {}
            for slot, slot_spec in row_analysis.items():
                # Builder mappings are saved in either the normalized
                # {"code": ValueSpec} shape or the compact ValueSpec shape
                # (for example {"row_field": "budget_line", "key": "04"}).
                # Do not treat every dict as normalized: doing so turns a
                # compact mapping into None and silently falls back to '#'.
                code_spec = (
                    slot_spec.get("code", slot_spec)
                    if isinstance(slot_spec, dict)
                    else slot_spec
                )
                code = resolve_value(code_spec, values, row).strip()
                if code and code != "#":
                    analysis[str(slot)] = {"const": code}
            if analysis:
                common["analysis"] = analysis
            lines.extend([
                {
                    **common,
                    "account": {"const": row_value(debit_account)},
                    "dc": str(spec.get("imprest_request_dc") or "D").upper(),
                },
                {
                    **common,
                    "account": {"const": row_value(credit_account)},
                    "dc": str(spec.get("imprest_request_counter_dc") or ("C" if str(spec.get("imprest_request_dc") or "D").upper() == "D" else "D")).upper(),
                },
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


def has_imprest_request_lines(document) -> bool:
    """Whether an Imprest request was entered and needs its approval lane.

    The request intent may be captured in a separate Imprest request table,
    while the approver enters/finalizes the actual posted amount in the
    General / Imprest itinerary table. Therefore either a populated itinerary
    line or a positive currency/amount value in another Imprest-enabled table
    starts the lane.
    """
    from decimal import Decimal, InvalidOperation

    meta = getattr(document, "metadata", None) or {}
    form = meta.get("form") if isinstance(meta.get("form"), dict) else {}
    values = get_form_values(document)
    for section in form.get("sections") or []:
        if not isinstance(section, dict):
            continue
        for field in section.get("fields") or []:
            if not isinstance(field, dict) or field.get("type") != "table":
                continue
            columns = [column for column in field.get("columns") or [] if isinstance(column, dict)]
            rows = values.get(field.get("key"))
            if not isinstance(rows, list):
                continue
            dsa_account_column = next(
                (column for column in columns if str(((column.get("sunsystems") or {}).get("role") or "")).strip().lower() == "dsa_account_code"),
                None,
            )
            budget_line_column = next(
                (column for column in columns if (column.get("type") == "budget_line" or ((column.get("sunsystems") or {}).get("role") == "budget_line")) and ((column.get("budgetLine") or {}).get("dsaAccountCodes") or [])),
                None,
            )
            if dsa_account_column or budget_line_column:
                dsa_key = dsa_account_column.get("key") if dsa_account_column else budget_line_column.get("key")
                nested_dsa = not dsa_account_column
                amount_column = next((column for column in columns if str(((column.get("sunsystems") or {}).get("role") or "")).strip().lower() == "dsa_line_amount"), None)
                has_travel_amount = any(str(((column.get("sunsystems") or {}).get("role") or "")).strip().lower() == "travel_line_amount" for column in columns)
                if not amount_column and not has_travel_amount:
                    amount_column = next((column for column in columns if str(((column.get("sunsystems") or {}).get("role") or "")).strip().lower() == "line_amount"), None)
                amount_key = amount_column.get("key") if amount_column else None
                for row in rows:
                    budget_value = row.get(dsa_key) if isinstance(row, dict) else None
                    if nested_dsa and isinstance(budget_value, dict):
                        dsa_value = budget_value.get("dsa_account_code")
                    else:
                        dsa_value = budget_value
                    if not isinstance(row, dict) or not str(dsa_value or "").strip():
                        continue
                    if amount_key:
                        try:
                            if Decimal(str(row.get(amount_key) or "0").replace(",", "").strip()) > 0:
                                return True
                        except (InvalidOperation, ValueError):
                            continue
                # The merged table's DSA account column determines which
                # rows enter the request lane. Ticket-only rows do not.
                continue
            itinerary_table = field.get("workflowRole") == "rfq_required_lines"
            imprest_enabled = bool(
                (field.get("sunsystems") or {}).get("imprestRequest", {}).get("enabled")
            )
            if not itinerary_table and not imprest_enabled:
                continue
            for row in rows:
                if not isinstance(row, dict):
                    continue
                # A separate request table signals intent through its
                # positive requested amount. Its default item/currency values
                # alone must not start an Imprest workflow.
                if not itinerary_table:
                    for column in columns:
                        key = column.get("key")
                        if not key or str(column.get("type") or "").lower() not in {"currency", "number"}:
                            continue
                        raw = row.get(key)
                        if raw in (None, "", [], {}):
                            continue
                        try:
                            if Decimal(str(raw).replace(",", "").strip()) > 0:
                                return True
                        except (InvalidOperation, ValueError):
                            continue
                    continue

                # The actual amount can be entered by the approver after the
                # lane starts. A populated itinerary line is sufficient;
                # an entirely empty/default-only row still skips the lane.
                for column in columns:
                    key = column.get("key")
                    role = str(((column.get("sunsystems") or {}).get("role") or "")).strip().lower()
                    if not key or role == "quantity":
                        continue
                    raw = row.get(key)
                    if raw in (None, "", [], {}):
                        continue
                    if role == "line_amount":
                        try:
                            if Decimal(str(raw).replace(",", "").strip()) > 0:
                                return True
                        except (InvalidOperation, ValueError):
                            continue
                        continue
                    default = column.get("defaultValue", column.get("default_value"))
                    if default not in (None, "") and str(raw).strip() == str(default).strip():
                        continue
                    return True
    return False


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
    sunsystems = get_sunsystems_config(document)
    po_config = sunsystems.get("imprest_request")
    if not isinstance(po_config, dict) or not po_config.get("enabled"):
        po_config = sunsystems.get("purchase_order")
    if not isinstance(po_config, dict):
        po_config = {}
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

            supplier_column = next((c for c in columns if (c.get("sunsystems") or {}).get("role") == "supplier_code"), None)
            first_row = next((row for row in rows if isinstance(row, dict) and any(v not in (None, "", [], {}) for v in row.values())), {})
            # The reconciliation table does not need a duplicate Account Code
            # column. When a retirement scenario line is configured to use an
            # account-code source, reuse the debit account already resolved by
            # the Imprest request mapping. Manual scenario accounts remain
            # available for counterpart/clearing accounts.
            request_debit_account = base_line.get("account")

            def scenario_account(line: dict) -> dict:
                source = str(line.get("accountSource") or "manual").strip().lower()
                col = supplier_column if source == "supplier_code" else None
                if col:
                    return {"const": str(first_row.get(col.get("key")) or "")}
                if source == "account_code" and request_debit_account:
                    return deepcopy(request_debit_account)
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
                request_specs = po.get("imprest_request_lines") or po.get("lines") or []
                for spec in request_specs:
                    request_table = str(spec.get("repeat_over") or "")
                    if not request_table:
                        continue
                    amount_spec = spec.get("amount") or spec.get("unit_price") or spec.get("quantity")
                    amount_column_key = amount_spec.get("row_field") if isinstance(amount_spec, dict) else None
                    if amount_column_key:
                        include_if = spec.get("include_if")
                        if isinstance(include_if, dict) and include_if.get("row_field"):
                            issued_amount = {
                                "sum_nonempty_rows": {
                                    "table": request_table,
                                    "amount_column": amount_column_key,
                                    "match_spec": include_if,
                                }
                            }
                        else:
                            issued_amount = {
                                "sum_rows": {
                                    "table": request_table,
                                    "amount_column": amount_column_key,
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
                row_currency = str(first_row.get(currency_column.get("key")) or "").strip()
                # The retirement table may have a currency column that the
                # user leaves blank. In that case retain the currency already
                # resolved from the Imprest request / PO mapping instead of
                # emitting an empty CurrencyCode to SunSystems.
                if row_currency:
                    line_defaults["currency"] = {"const": row_currency}
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
        values = dict(form["values"])
    else:
        values = {}
    # Reference is generated by the document service, not entered in the
    # requisition form. Expose it to mapping specs without colliding with a
    # user-defined field key.
    values["__reference_number"] = getattr(document, "reference_number", "") or ""
    return values


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
