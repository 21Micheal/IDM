"""
apps/documents/requisition_reports.py

Comprehensive financial reporting for Requisition Forms.
Extracts line items with:
- Activity code (Dimension 10 / Activity)
- Description (Line item description / Activity description)
- Account code (GL Account Code)
- Amount (Financial line amount)
- Journal number (SunSystems posted journal reference)
- Additional financial context (Department, Requisition #, Cost Centre, Status, Date)
"""
import csv
import io
import re
from typing import Any, Dict, List, Optional
from django.db.models import QuerySet


def _to_float(value: Any) -> float:
    if value is None or value == "":
        return 0.0
    try:
        cleaned = re.sub(r"[^\d.-]", "", str(value).strip())
        if not cleaned or cleaned in ("-", "."):
            return 0.0
        return float(cleaned)
    except (ValueError, TypeError):
        return 0.0


def _text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, (dict, list)):
        return ""
    return str(value).strip()


def extract_document_requisition_lines(doc: Any) -> List[Dict[str, Any]]:
    """
    Extract line items from a requisition form document.
    """
    metadata = doc.metadata if isinstance(doc.metadata, dict) else {}
    form = metadata.get("form") if isinstance(metadata.get("form"), dict) else {}
    values = form.get("values") if isinstance(form.get("values"), dict) else {}
    sections = form.get("sections") if isinstance(form.get("sections"), list) else []

    # Map SunSystems journal postings for this document
    postings = list(doc.journal_postings.all()) if hasattr(doc, "journal_postings") else []
    doc_journal_numbers = [p.journal_number for p in postings if p.journal_number]
    primary_jnl = ", ".join(sorted(set(doc_journal_numbers))) if doc_journal_numbers else ""
    
    # Determine journal status
    primary_status = "unposted"
    if any(p.status == "posted" for p in postings):
        primary_status = "posted"
    elif any(p.status == "failed" for p in postings):
        primary_status = "failed"
    elif any(p.status == "pending" for p in postings):
        primary_status = "pending"

    # Context fields
    doc_ref = doc.reference_number or doc.title or f"REQ-{str(doc.id)[:8]}"
    doc_title = doc.title or ""
    doc_status = str(doc.status or "draft").lower()
    doc_date = doc.created_at.strftime("%Y-%m-%d") if doc.created_at else ""
    
    dept_name = ""
    if hasattr(doc, "uploaded_by") and doc.uploaded_by and getattr(doc.uploaded_by, "department", None):
        dept_name = doc.uploaded_by.department.name or ""
    if not dept_name and hasattr(doc, "department_name"):
        dept_name = doc.department_name or ""
    if not dept_name:
        dept_name = _text(values.get("department") or values.get("uploader_department") or "")

    requester_name = ""
    if hasattr(doc, "uploaded_by") and doc.uploaded_by:
        requester_name = doc.uploaded_by.get_full_name() or doc.uploaded_by.email or ""

    global_currency = _text(doc.currency or values.get("currency") or "USD").upper()
    top_activity_desc = _text(
        values.get("activity_description_hnni")
        or values.get("activity_description")
        or values.get("description")
        or ""
    )

    lines: List[Dict[str, Any]] = []

    # Look through sections and table fields
    for section in sections:
        fields = section.get("fields") if isinstance(section, dict) and isinstance(section.get("fields"), list) else []
        for field in fields:
            if not isinstance(field, dict) or field.get("type") != "table":
                continue

            table_key = field.get("key")
            if not table_key:
                continue

            rows = values.get(table_key)
            if not isinstance(rows, list) or not rows:
                continue

            cols = field.get("columns") or []
            if not isinstance(cols, list):
                cols = []

            # Identify relevant column roles/types
            budget_col = next((c for c in cols if c.get("type") in ("budget_line", "budget")), None)
            activity_col = next((c for c in cols if (c.get("external") or {}).get("dimension") == "10" or re.search(r"activity.*code", c.get("label", ""), re.I) or re.search(r"activity.*code", c.get("key", ""), re.I)), None)
            activity_desc_col = next((c for c in cols if re.search(r"activity.*desc", c.get("label", ""), re.I) or re.search(r"activity.*desc", c.get("key", ""), re.I)), None)
            account_col = next((c for c in cols if (c.get("sunsystems") or {}).get("role") == "account_code" or re.search(r"account.*code", c.get("label", ""), re.I) or re.search(r"account.*code", c.get("key", ""), re.I)), None)
            dsa_account_col = next((c for c in cols if (c.get("sunsystems") or {}).get("role") == "dsa_account_code"), None)
            cost_centre_col = next((c for c in cols if (c.get("external") or {}).get("dimension") == "05" or re.search(r"cost.*centre", c.get("label", ""), re.I) or re.search(r"cost.*centre", c.get("key", ""), re.I)), None)
            
            # Prioritize description column (exact "Description" label or sunsystems role)
            desc_col = next((c for c in cols if (c.get("sunsystems") or {}).get("role") == "description" or c.get("label", "").strip().lower() == "description" or re.search(r"^description", c.get("key", ""), re.I)), None)
            if not desc_col:
                desc_col = next((c for c in cols if re.search(r"description|item.*desc|category", c.get("label", ""), re.I)), None)

            # Amount column
            amt_col = next((c for c in cols if (c.get("sunsystems") or {}).get("role") == "line_amount" or re.search(r"lpo.*amount|actual.*amount|actual.*spend|total.*estimated", c.get("key", ""), re.I) or re.search(r"actual.*spend|total.*amount|gross.*val", c.get("label", ""), re.I)), None)
            if not amt_col:
                amt_col = next((c for c in cols if re.search(r"estimated.*amount|estimated.*cost|amount|total", c.get("label", ""), re.I) or c.get("type") == "currency"), None)

            curr_col = next((c for c in cols if (c.get("sunsystems") or {}).get("role") == "currency" or re.search(r"currency", c.get("label", ""), re.I)), None)

            is_financial_table = bool(
                budget_col
                or account_col
                or activity_col
                or field.get("workflowRole") in ("requisition_lines", "rfq_required_lines", "retirement_expenses")
                or any(re.search(r"amount|budget|cost|price|account", c.get("label", ""), re.I) for c in cols)
            )

            # Only process tables that have financial / requisition line data
            if not is_financial_table:
                continue

            for idx, r in enumerate(rows):
                if not isinstance(r, dict):
                    continue

                budget_obj = r.get(budget_col.get("key")) if budget_col else {}
                if not isinstance(budget_obj, dict):
                    budget_obj = {}

                # 1. Activity Code (Dimension 10)
                act_code = _text(
                    budget_obj.get("10")
                    or (r.get(activity_col.get("key")) if activity_col else "")
                    or values.get("activity_code")
                    or ""
                )

                # 2. Activity Description
                act_desc = _text(
                    budget_obj.get("10_description")
                    or budget_obj.get("10_name")
                    or (r.get(activity_desc_col.get("key")) if activity_desc_col else "")
                    or top_activity_desc
                )

                # 3. Account Code
                acct_code = _text(
                    budget_obj.get("dsa_account_code")
                    or (r.get(dsa_account_col.get("key")) if dsa_account_col else "")
                    or budget_obj.get("account_code")
                    or (r.get(account_col.get("key")) if account_col else "")
                    or values.get("request_a_c_reference")
                    or values.get("account_code")
                    or ""
                )

                # 4. Cost Centre (Dimension 05)
                cost_centre = _text(
                    budget_obj.get("05_description")
                    or budget_obj.get("05_name")
                    or budget_obj.get("05")
                    or (r.get(cost_centre_col.get("key")) if cost_centre_col else "")
                    or ""
                )

                # 5. Line Description
                line_desc = _text(
                    (r.get(desc_col.get("key")) if desc_col else "")
                    or r.get("description")
                    or r.get("description_vuy3")
                    or r.get("item_description")
                    or r.get("category_breakdown_kzi6")
                    or act_desc
                    or doc_title
                )

                # 6. Amount
                raw_amt = r.get(amt_col.get("key")) if amt_col else None
                if raw_amt is None:
                    raw_amt = (
                        r.get("total_estimated_amount_75ud")
                        or r.get("lpo_amount")
                        or r.get("actual_amount_ejna")
                        or r.get("actual_spend_2hcm")
                        or r.get("gross_value_6r7k")
                        or r.get("estimated_amount_ajld")
                        or r.get("estimated_cost_3ybl")
                        or r.get("amount")
                    )
                amount = _to_float(raw_amt)

                # Currency
                row_currency = _text((r.get(curr_col.get("key")) if curr_col else "") or global_currency or "USD").upper()

                # Skip completely blank lines where amount is 0 and no codes exist
                if not act_code and not acct_code and amount == 0 and not line_desc:
                    continue

                line_id = f"{doc.id}_{table_key}_{idx}"

                lines.append({
                    "id": line_id,
                    "document_id": str(doc.id),
                    "document_reference": doc_ref,
                    "document_title": doc_title,
                    "document_status": doc_status,
                    "date": doc_date,
                    "department": dept_name or "—",
                    "requester": requester_name or "—",
                    "table_name": field.get("label") or table_key,
                    "activity_code": act_code or "—",
                    "activity_description": act_desc or "—",
                    "account_code": acct_code or "—",
                    "cost_centre": cost_centre or "—",
                    "description": line_desc or "—",
                    "amount": amount,
                    "currency": row_currency,
                    "journal_number": primary_jnl or "—",
                    "journal_status": primary_status,
                })

    # If no lines were in tables, but top-level requisition has financial fields
    if not lines and (values.get("amount") or values.get("total_travel_gross") or values.get("total_imprest_gross")):
        top_amt = _to_float(values.get("total_travel_gross") or values.get("total_imprest_gross") or values.get("amount") or doc.amount)
        lines.append({
            "id": f"{doc.id}_main_0",
            "document_id": str(doc.id),
            "document_reference": doc_ref,
            "document_title": doc_title,
            "document_status": doc_status,
            "date": doc_date,
            "department": dept_name or "—",
            "requester": requester_name or "—",
            "table_name": "Main Requisition",
            "activity_code": _text(values.get("activity_code") or "—"),
            "activity_description": top_activity_desc or "—",
            "account_code": _text(values.get("request_a_c_reference") or values.get("account_code") or "—"),
            "cost_centre": "—",
            "description": top_activity_desc or doc_title or "Requisition",
            "amount": top_amt,
            "currency": global_currency,
            "journal_number": primary_jnl or "—",
            "journal_status": primary_status,
        })

    return lines


def build_requisition_report(queryset: QuerySet, params: Dict[str, Any]) -> Dict[str, Any]:
    """
    Build a complete report dataset from the document queryset according to filter parameters.
    """
    search = _text(params.get("search")).lower()
    start_date = _text(params.get("start_date"))
    end_date = _text(params.get("end_date"))
    filter_account = _text(params.get("account_code")).strip().lower()
    filter_activity = _text(params.get("activity_code")).strip().lower()
    filter_status = _text(params.get("status")).strip().lower()
    filter_dept = _text(params.get("department")).strip().lower()
    has_journal = str(params.get("has_journal", "")).strip().lower() in ("true", "1", "yes")

    all_lines: List[Dict[str, Any]] = []

    # Metadata tracking for filter dropdowns
    available_accounts = set()
    available_activities = set()
    available_departments = set()
    available_statuses = set()

    for doc in queryset:
        extracted = extract_document_requisition_lines(doc)
        for line in extracted:
            # Track filter options
            if line["account_code"] and line["account_code"] != "—":
                available_accounts.add(line["account_code"])
            if line["activity_code"] and line["activity_code"] != "—":
                available_activities.add(line["activity_code"])
            if line["department"] and line["department"] != "—":
                available_departments.add(line["department"])
            if line["document_status"]:
                available_statuses.add(line["document_status"])

            # Filter checks
            if filter_status and line["document_status"] != filter_status:
                continue
            if filter_dept and line["department"].lower() != filter_dept:
                continue
            if filter_account and filter_account not in line["account_code"].lower():
                continue
            if filter_activity and filter_activity not in line["activity_code"].lower():
                continue
            if has_journal and (not line["journal_number"] or line["journal_number"] == "—"):
                continue

            # Date filtering
            line_date = line.get("date") or ""
            if start_date and line_date and line_date < start_date:
                continue
            if end_date and line_date and line_date > end_date:
                continue

            # Search term check across multiple attributes
            if search:
                haystack = " ".join([
                    line["activity_code"],
                    line["activity_description"],
                    line["description"],
                    line["account_code"],
                    line["journal_number"],
                    line["document_reference"],
                    line["department"],
                    line["requester"],
                ]).lower()
                if search not in haystack:
                    continue

            all_lines.append(line)

    # Aggregations
    total_amount = sum(item["amount"] for item in all_lines)
    posted_lines = [item for item in all_lines if item["journal_number"] and item["journal_number"] != "—"]
    posted_amount = sum(item["amount"] for item in posted_lines)

    # Group by Activity Code
    by_activity_map: Dict[str, Dict[str, Any]] = {}
    for line in all_lines:
        code = line["activity_code"]
        if code not in by_activity_map:
            by_activity_map[code] = {
                "activity_code": code,
                "activity_description": line["activity_description"] if line["activity_description"] != "—" else "",
                "line_count": 0,
                "total_amount": 0.0,
                "posted_amount": 0.0,
                "currency": line["currency"],
            }
        entry = by_activity_map[code]
        entry["line_count"] += 1
        entry["total_amount"] += line["amount"]
        if line["journal_number"] != "—":
            entry["posted_amount"] += line["amount"]
        if not entry["activity_description"] and line["activity_description"] != "—":
            entry["activity_description"] = line["activity_description"]

    by_activity = sorted(
        by_activity_map.values(),
        key=lambda x: (x["total_amount"], x["line_count"]),
        reverse=True,
    )

    # Group by Account Code
    by_account_map: Dict[str, Dict[str, Any]] = {}
    for line in all_lines:
        code = line["account_code"]
        if code not in by_account_map:
            by_account_map[code] = {
                "account_code": code,
                "line_count": 0,
                "total_amount": 0.0,
                "posted_amount": 0.0,
                "currency": line["currency"],
            }
        entry = by_account_map[code]
        entry["line_count"] += 1
        entry["total_amount"] += line["amount"]
        if line["journal_number"] != "—":
            entry["posted_amount"] += line["amount"]

    by_account = sorted(
        by_account_map.values(),
        key=lambda x: (x["total_amount"], x["line_count"]),
        reverse=True,
    )

    summary = {
        "total_amount": round(total_amount, 2),
        "total_lines": len(all_lines),
        "posted_amount": round(posted_amount, 2),
        "posted_lines": len(posted_lines),
        "distinct_activities": len(by_activity_map),
        "distinct_accounts": len(by_account_map),
    }

    filter_options = {
        "accounts": sorted(list(available_accounts)),
        "activities": sorted(list(available_activities)),
        "departments": sorted(list(available_departments)),
        "statuses": sorted(list(available_statuses)),
    }

    return {
        "summary": summary,
        "lines": all_lines,
        "by_activity": by_activity,
        "by_account": by_account,
        "filter_options": filter_options,
    }


def generate_requisition_report_csv(report_data: Dict[str, Any]) -> str:
    """
    Format the report lines into a CSV string.
    """
    output = io.StringIO()
    # Write UTF-8 BOM for Microsoft Excel compatibility
    output.write("\ufeff")
    writer = csv.writer(output)

    # Header Row
    writer.writerow([
        "Requisition Ref",
        "Date",
        "Department",
        "Requester",
        "Activity Code",
        "Activity Description",
        "Description",
        "Account Code",
        "Cost Centre",
        "Amount",
        "Currency",
        "Journal Number",
        "Journal Status",
        "Requisition Status",
    ])

    for line in report_data.get("lines", []):
        writer.writerow([
            line.get("document_reference", ""),
            line.get("date", ""),
            line.get("department", ""),
            line.get("requester", ""),
            line.get("activity_code", ""),
            line.get("activity_description", ""),
            line.get("description", ""),
            line.get("account_code", ""),
            line.get("cost_centre", ""),
            f"{line.get('amount', 0.0):.2f}",
            line.get("currency", "USD"),
            line.get("journal_number", ""),
            line.get("journal_status", ""),
            line.get("document_status", ""),
        ])

    return output.getvalue()

