"""
apps/sunsystems/views.py

API surface for the SunSystems integration:

  POST /api/v1/sunsystems/budget-check/
  POST /api/v1/sunsystems/journal-preview/
  GET  /api/v1/sunsystems/postings/                           admin list (all docs)
  GET  /api/v1/sunsystems/postings/<doc_id>/                 per-document postings
  POST /api/v1/sunsystems/postings/<doc_id>/retry/           retry a failed posting
  POST /api/v1/sunsystems/payment-run/                       query ledger lines
  POST /api/v1/sunsystems/amend-markers/                     update allocation markers
  GET  /api/v1/sunsystems/payment-runs/                      admin list of payment runs
  GET  /api/v1/sunsystems/accounts/                          supplier accounts
  GET/PUT /api/v1/sunsystems/connection/                     admin connection config
  POST /api/v1/sunsystems/connection/test/
"""
from __future__ import annotations

from rest_framework import permissions, status
from rest_framework.permissions import IsAuthenticated
from rest_framework.response import Response
from rest_framework.views import APIView


class IsAdminAccess(permissions.BasePermission):
    """Allow only users with administrative access (mirrors RequireAdmin)."""

    def has_permission(self, request, view):
        return bool(
            request.user
            and request.user.is_authenticated
            and getattr(request.user, "has_admin_access", False)
        )

from .budget import check_budget
from .client import (
    SunSystemsClient,
    SunSystemsConfig,
    SunSystemsError,
    build_executor_envelope,
    clear_client_cache,
    default_connection_from_settings,
)
from .config import (
    get_budget_mapping,
    get_connection_override,
    get_form_values,
    get_journal_mapping,
    redact_connection,
)
from .crypto import encrypt_secret
from .mapping import MappingError, build_sunsystems_ssc
from .models import (
    JournalPosting,
    JournalPostingStatus,
    PaymentRun,
    PaymentRunStatus,
    SunSystemsConnection,
    effective_connection,
    stored_connection,
)
from .payment_run import (
    build_payment_process_payload,
    payment_run_dates,
    process_payment_run,
    sunsystems_error_messages,
)
from .serializers import (
    BudgetCheckRequestSerializer,
    ConnectionSerializer,
    JournalPreviewRequestSerializer,
    JournalPostingSerializer,
    PaymentRunSerializer,
)


def _budget_mapping_and_conn(data: dict):
    """Resolve (budget_mapping, values, connection) from the request.

    Priority: an inline mapping (builder preview) → a template's snapshot → a
    saved document's snapshot. Values come from the request, else the document.
    """
    mapping = data.get("mapping")
    values = data.get("values") or {}
    connection: dict = {}

    document_id = data.get("document_id")
    template_id = data.get("template_id")

    if mapping is None and template_id:
        from apps.templates_engine.models import DocumentTemplate
        tmpl = DocumentTemplate.objects.filter(pk=template_id).first()
        if tmpl:
            ss = tmpl.sunsystems if isinstance(tmpl.sunsystems, dict) else {}
            mapping = ss.get("budget")
            connection = ss.get("connection") or {}

    if (mapping is None or not values) and document_id:
        from apps.documents.models import Document
        doc = Document.objects.filter(pk=document_id).first()
        if doc:
            if mapping is None:
                mapping = get_budget_mapping(doc)
            if not values:
                values = get_form_values(doc)
            if not connection:
                connection = get_connection_override(doc)

    return mapping, values, connection


class BudgetCheckView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = BudgetCheckRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        mapping, values, connection = _budget_mapping_and_conn(serializer.validated_data)
        result = check_budget(mapping=mapping, values=values, connection=connection)
        return Response(result.to_dict())


def _journal_mapping_and_values(data: dict):
    """Resolve (journal_mapping, values, connection) for a payload preview.

    Same precedence as the budget resolver: inline mapping (builder) → template
    snapshot → saved document snapshot; values from the request else the document.
    """
    mapping = data.get("mapping")
    values = data.get("values") or {}
    connection: dict = {}
    stage = data.get("stage", 1)

    document_id = data.get("document_id")
    template_id = data.get("template_id")

    if mapping is None and template_id:
        from apps.templates_engine.models import DocumentTemplate
        tmpl = DocumentTemplate.objects.filter(pk=template_id).first()
        if tmpl:
            ss = tmpl.sunsystems if isinstance(tmpl.sunsystems, dict) else {}
            mapping = ss.get("journal")
            connection = ss.get("connection") or {}

    if (mapping is None or not values) and document_id:
        from apps.documents.models import Document
        doc = Document.objects.filter(pk=document_id).first()
        if doc:
            if mapping is None:
                mapping = get_journal_mapping(doc, stage=stage)
            if not values:
                values = get_form_values(doc)
            if not connection:
                connection = get_connection_override(doc)

    return mapping, values, connection


class JournalPreviewView(APIView):
    """Compile and return the exact ``<SSC>`` journal XML (and full SOAP request)
    that would be posted, so it can be reviewed/exported without tracing each
    field's mapping by hand. Balance is reported but not enforced — the preview
    always renders, even for a not-yet-balanced journal."""

    permission_classes = [IsAuthenticated]

    def post(self, request):
        serializer = JournalPreviewRequestSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        mapping, values, connection = _journal_mapping_and_values(serializer.validated_data)

        if not mapping or not mapping.get("enabled"):
            return Response({
                "ok": False, "enabled": False,
                "error": "Journal posting is not configured for this form.",
            })

        config = SunSystemsConfig.from_mapping(effective_connection(connection))
        try:
            build = build_sunsystems_ssc(
                {**mapping, "validate_balance": False},  # preview always renders
                values,
                business_unit_default=config.business_unit,
                budget_code_default=config.budget_code,
                pretty=True,
            )
        except MappingError as exc:
            return Response({"ok": False, "enabled": True, "error": str(exc)})

        soap_xml = build_executor_envelope(
            "{{SECURITY_TOKEN}}", build.component, build.method, build.ssc_xml, config=config
        )
        return Response({
            "ok": True,
            "enabled": True,
            "component": build.component,
            "method": build.method,
            "business_unit": config.business_unit,
            "ssc_xml": build.ssc_xml,
            "soap_xml": soap_xml,
            "line_count": build.line_count,
            "debit_total": str(build.debit_total),
            "credit_total": str(build.credit_total),
            "balanced": build.balanced,
            "warnings": build.warnings,
            "error": None,
        })


_MASKED = "********"


class SunSystemsConnectionView(APIView):
    """Read / update the admin-configured SunSystems Connect connection.

    GET returns the saved connection (password redacted), the effective
    connection (env defaults folded in), and the env defaults — so the admin
    sees what is actually in force. PUT saves a partial update; a masked/blank
    password is treated as "unchanged".
    """

    permission_classes = [IsAdminAccess]

    def get(self, request):
        row = SunSystemsConnection.get_solo()
        effective = effective_connection()
        return Response({
            "connection": redact_connection(stored_connection()),
            "effective": redact_connection(effective),
            "env_defaults": redact_connection(default_connection_from_settings()),
            "has_password": bool(effective.get("password")),
            "updated_at": row.updated_at,
        })

    def put(self, request):
        serializer = ConnectionSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        row = SunSystemsConnection.get_solo()
        conn = dict(row.connection or {})
        clear_password = serializer.validated_data.pop("clear_password", False)
        if clear_password:
            conn.pop("password", None)
        for key, value in serializer.validated_data.items():
            # A masked/blank password means "leave the stored one as-is".
            if key == "password":
                if clear_password or value in ("", _MASKED):
                    continue
                value = encrypt_secret(value)  # encrypt at rest
            conn[key] = value
        row.connection = conn
        row.updated_by = request.user
        row.save(update_fields=["connection", "updated_by", "updated_at"])
        clear_client_cache()
        return Response({
            "connection": redact_connection(conn),
            "effective": redact_connection(effective_connection()),
        })


class SunSystemsTestConnectionView(APIView):
    """Validate a connection by acquiring a SecurityProvider token. Tests the
    posted connection (merged over the saved + env layers) so an admin can try
    settings before saving; a masked password falls back to the stored one."""

    permission_classes = [IsAdminAccess]

    def post(self, request):
        override = dict(request.data.get("connection") or {})
        clear_password = bool(override.pop("clear_password", False))
        if override.get("password") in ("", _MASKED):
            override.pop("password", None)
        connection = effective_connection(override)
        if clear_password:
            connection["password"] = default_connection_from_settings().get("password", "")
        config = SunSystemsConfig.from_mapping(connection)
        try:
            result = SunSystemsClient(config).test_connection()
            return Response({"ok": True, **result})
        except SunSystemsError as exc:
            return Response({"ok": False, "detail": str(exc)})


class JournalPostingDetailView(APIView):
    permission_classes = [IsAuthenticated]

    def get(self, request, document_id):
        """Return all posting stages for a document, ordered by stage number."""
        postings = JournalPosting.objects.filter(document_id=document_id).order_by("stage")
        if not postings.exists():
            return Response(
                {"status": "none", "detail": "No journal postings for this document yet."},
                status=status.HTTP_404_NOT_FOUND,
            )
        return Response(JournalPostingSerializer(postings, many=True).data)


class JournalPostingRetryView(APIView):
    permission_classes = [IsAuthenticated]

    def post(self, request, document_id):
        from apps.documents.models import Document

        doc = Document.objects.filter(pk=document_id).first()
        if not doc:
            return Response({"detail": "Document not found."}, status=status.HTTP_404_NOT_FOUND)

        # Accept an explicit stage; default to 1 for backwards compat.
        stage = int((request.data or {}).get("stage") or 1)

        posting = JournalPosting.objects.filter(document=doc, stage=stage).first()
        if posting and posting.status == JournalPostingStatus.POSTED:
            return Response(
                {"detail": f"Stage {stage} is already posted.",
                 **JournalPostingSerializer(posting).data},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # Re-run synchronously so the caller gets the outcome immediately.
        # A retry intentionally refreshes the mapping from the current template
        # first, so builder/code fixes affect the next payload.
        from .config import refresh_sunsystems_config_from_template
        refreshed = refresh_sunsystems_config_from_template(doc)
        from .journal import post_journal_for_document
        posting = post_journal_for_document(doc, stage=stage, actor=request.user)
        code = status.HTTP_200_OK if posting.status == JournalPostingStatus.POSTED else status.HTTP_502_BAD_GATEWAY
        return Response(
            {**JournalPostingSerializer(posting).data, "mapping_refreshed": refreshed},
            status=code,
        )


class JournalPostingListView(APIView):
    """Admin-wide list of journal postings across all documents.

    GET /api/v1/sunsystems/postings/?status=failed&limit=100

    Query params:
        status  (optional) filter by status: pending, posting, posted, failed, skipped
        limit   (optional, default 100, max 500)
    """

    permission_classes = [IsAdminAccess]

    def get(self, request):
        status_filter = str(request.query_params.get("status") or "").strip()
        limit = min(int(request.query_params.get("limit") or 100), 500)

        qs = (
            JournalPosting.objects
            .select_related("document", "posted_by")
            .order_by("-updated_at")
        )
        if status_filter:
            qs = qs.filter(status=status_filter)

        postings = qs[:limit]
        data = []
        for p in postings:
            row = JournalPostingSerializer(p).data
            # Attach lightweight document context so the UI can link/identify.
            row["document_reference"] = (
                getattr(p.document, "reference_number", None) or str(p.document_id)
                if p.document_id else None
            )
            row["document_title"] = (
                getattr(p.document, "title", None) or ""
                if p.document_id else ""
            )
            data.append(row)

        return Response({"ok": True, "postings": data, "count": len(data)})


def _sunsystems_error_messages(response_xml: str) -> list[str]:
    return sunsystems_error_messages(response_xml)


def _payment_run_dates():
    return payment_run_dates()


def _next_payment_reference(prefix: str = "PAY") -> tuple[str, int, object]:
    from django.db.models import Max

    dates = _payment_run_dates()
    max_sequence = (
        PaymentRun.objects
        .filter(run_date=dates["run_date"], reference_prefix=prefix)
        .aggregate(Max("daily_sequence"))
        .get("daily_sequence__max")
        or 0
    )
    sequence = int(max_sequence) + 1
    return f"{prefix}{dates['ddmmyy']}{sequence:04d}", sequence, dates["run_date"]


def _create_payment_run_from_marked_lines(*, request, data, business_unit, budget_code, lines):
    from decimal import Decimal, InvalidOperation
    from django.db import IntegrityError, transaction

    reference_prefix = str(data.get("reference_prefix") or "PAY").strip() or "PAY"
    required_approvals = int(data.get("required_approvals") or 2)
    bank_details_code = str(data.get("bank_details_code") or "52100").strip()
    discount_account_credit = str(data.get("discount_account_credit") or "999").strip()
    profile_code = str(data.get("profile_code") or "BANK").strip()
    document_format_code = str(data.get("document_format_code") or "AGP1").strip()

    total = Decimal("0")
    currencies = []
    for line in lines:
        try:
            total += Decimal(str(line.get("transaction_amount") or "0"))
        except (InvalidOperation, TypeError):
            pass
        currency = str(line.get("currency_code") or "").strip()
        if currency and currency not in currencies:
            currencies.append(currency)

    for attempt in range(5):
        try:
            with transaction.atomic():
                payment_reference, sequence, run_date = _next_payment_reference(reference_prefix)
                return PaymentRun.objects.create(
                    payment_reference=payment_reference,
                    reference_prefix=reference_prefix,
                    run_date=run_date,
                    daily_sequence=sequence,
                    business_unit=business_unit,
                    budget_code=budget_code,
                    required_approvals=required_approvals,
                    line_count=len(lines),
                    total_amount=total,
                    currency_codes=currencies,
                    lines=lines,
                    bank_details_code=bank_details_code,
                    discount_account_credit=discount_account_credit,
                    profile_code=profile_code,
                    document_format_code=document_format_code,
                    submitted_by=request.user,
                )
        except IntegrityError:
            if attempt == 4:
                raise


def _build_payment_process_payload(run: PaymentRun) -> str:
    return build_payment_process_payload(run)


class PaymentRunView(APIView):
    """Query SunSystems ledger lines for a payment run.

    POST /api/v1/sunsystems/payment-run/

    Request body (all fields optional — defaults mirror the test script):
        account_codes      list[str] | str  comma-separated or list   e.g. ["64001","71001"]
        allocation_markers list[str] | str  e.g. ["W"]  (unallocated = blank or W)
        journal_number_gt  int | str        e.g. 10
        business_unit      str              e.g. "PK1"
        budget_code        str              e.g. "A"

    Response:
        { lines: [ { account_code, accounting_period, transaction_date,
                     journal_number, journal_line_number, transaction_reference,
                     description, base_amount, conversion_rate, currency_code,
                     transaction_amount, debit_credit, allocation_marker,
                     account_description } ], count: int }
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        import xml.etree.ElementTree as ET
        data = request.data or {}

        # ── Resolve connection ────────────────────────────────────────────────
        conn = effective_connection()
        config = SunSystemsConfig.from_mapping(conn)

        # ── Filter params ─────────────────────────────────────────────────────
        raw_accounts = data.get("account_codes", "")
        if isinstance(raw_accounts, list):
            account_codes = ",".join(str(a) for a in raw_accounts if a)
        else:
            account_codes = str(raw_accounts).strip()

        raw_markers = data.get("allocation_markers", "")
        if isinstance(raw_markers, list):
            marker_tokens = [str(m).strip() for m in raw_markers if str(m).strip()]
        else:
            marker_tokens = [t.strip() for t in str(raw_markers).split(",") if t.strip()]

        # SunSystems Account Allocation shows "Not Allocated" for lines whose
        # Journal AllocationMarker is blank (or occasionally "W"). Filtering the
        # SSC query with IN "W" therefore misses the blank-marker lines that
        # operators actually mean by "unallocated". Detect that intent here and
        # post-filter after Journal/Query instead.
        unallocated_tokens = {"W", "UNALLOCATED", "BLANK", "__BLANK__"}
        marker_upper = {t.upper() for t in marker_tokens}
        filter_unallocated_only = bool(marker_tokens) and marker_upper <= unallocated_tokens
        allocation_markers = ",".join(marker_tokens)

        journal_number_gt = str(data.get("journal_number_gt", "") or "").strip()

        business_unit = str(data.get("business_unit") or config.business_unit or "PK1")
        budget_code = str(data.get("budget_code") or config.budget_code or "A")

        # ── Build filter expressions ──────────────────────────────────────────
        filter_items = []
        if account_codes:
            filter_items.append(
                f'<Item name="/Ledger/Line/AccountCode" operator="IN" value="{account_codes}"/>'
            )
        if journal_number_gt:
            filter_items.append(
                f'<Item name="/Ledger/Line/JournalNumber" operator="GT" value="{journal_number_gt}"/>'
            )
        if allocation_markers and not filter_unallocated_only:
            filter_items.append(
                f'<Item name="/Ledger/Line/AllocationMarker" operator="IN" value="{allocation_markers}"/>'
            )

        if not filter_items:
            # No filters at all — return everything for the given business unit.
            filter_xml = ""
        elif len(filter_items) == 1:
            # A single <Item> must NOT be wrapped in <Expr operator="AND"> —
            # SunSystems raises "Index 1 out of bounds for length 1" when AND
            # has fewer than 2 operands.
            filter_xml = f"<Filter>{filter_items[0]}</Filter>"
        else:
            filter_xml = (
                '<Filter><Expr operator="AND">'
                + "".join(filter_items)
                + "</Expr></Filter>"
            )


        # ── Build full SSC payload ────────────────────────────────────────────
        ssc_payload = f"""<SSC>
  <ErrorContext/>
  <User/>
  <SunSystemsContext>
    <BusinessUnit>{business_unit}</BusinessUnit>
    <BudgetCode>{budget_code}</BudgetCode>
  </SunSystemsContext>
  <Payload>
    {filter_xml}
    <Select>
      <Ledger>
        <Line>
          <AccountCode>.</AccountCode>
          <AccountingPeriod>.</AccountingPeriod>
          <TransactionDate>.</TransactionDate>
          <JournalNumber>.</JournalNumber>
          <JournalLineNumber>.</JournalLineNumber>
          <TransactionReference>.</TransactionReference>
          <Description>.</Description>
          <BaseAmount>.</BaseAmount>
          <ConversionRate>.</ConversionRate>
          <CurrencyCode>.</CurrencyCode>
          <TransactionAmount>.</TransactionAmount>
          <DebitCredit>.</DebitCredit>
          <AllocationMarker>.</AllocationMarker>
          <Accounts>
            <Description>.</Description>
          </Accounts>
        </Line>
      </Ledger>
    </Select>
  </Payload>
</SSC>"""

        # ── Execute ───────────────────────────────────────────────────────────
        try:
            client = SunSystemsClient(config)
            response_xml = client.execute("Journal", "Query", ssc_payload)
        except SunSystemsError as exc:
            return Response(
                {"ok": False, "error": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        # ── Parse response XML ────────────────────────────────────────────────
        lines = []

        def _text(el_root, tag: str) -> str:
            el = el_root.find(tag)
            return (el.text or "").strip() if el is not None else ""

        try:
            root = ET.fromstring(response_xml or "<SSC/>")
            for line_el in root.findall(".//Ledger/Line"):
                account_desc_el = line_el.find("Accounts/Description")
                account_desc = (account_desc_el.text or "").strip() if account_desc_el is not None else ""

                lines.append({
                    "account_code":          _text(line_el, "AccountCode"),
                    "accounting_period":     _text(line_el, "AccountingPeriod"),
                    "transaction_date":      _text(line_el, "TransactionDate"),
                    "journal_number":        _text(line_el, "JournalNumber"),
                    "journal_line_number":   _text(line_el, "JournalLineNumber"),
                    "transaction_reference": _text(line_el, "TransactionReference"),
                    "description":           _text(line_el, "Description"),
                    "base_amount":           _text(line_el, "BaseAmount"),
                    "conversion_rate":       _text(line_el, "ConversionRate"),
                    "currency_code":         _text(line_el, "CurrencyCode"),
                    "transaction_amount":    _text(line_el, "TransactionAmount"),
                    "debit_credit":          _text(line_el, "DebitCredit"),
                    "allocation_marker":     _text(line_el, "AllocationMarker"),
                    "account_description":   account_desc,
                })
        except ET.ParseError as exc:
            return Response(
                {"ok": False, "error": f"Could not parse SunSystems response: {exc}"},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        if filter_unallocated_only:
            # Match SunSystems "Not Allocated": blank/whitespace marker, plus literal W.
            lines = [
                line for line in lines
                if (line.get("allocation_marker") or "").strip().upper() in ("", "W")
            ]

        # ── Idempotency: mark lines already in an active payment run ──────────
        # Query PaymentRun records for this BU/budget that are NOT rejected
        # so we can flag lines the user has already submitted.  This prevents
        # double-submission even if SunSystems still shows the old marker.
        # Only rejected and never-submitted transactions are selectable.
        # Pending approval, failed, approved, processing, and paid transactions are blocked.
        submitted_keys: dict[tuple[str, str], dict] = {}
        active_runs = (
            PaymentRun.objects
            .filter(business_unit=business_unit, budget_code=budget_code)
            .exclude(status=PaymentRunStatus.REJECTED)
            .only("payment_reference", "status", "lines")
        )
        for run in active_runs:
            for ln in (run.lines or []):
                key = (
                    str(ln.get("journal_number",      "")).strip(),
                    str(ln.get("journal_line_number", "")).strip(),
                )
                if key[0] and key[1] and key not in submitted_keys:
                    submitted_keys[key] = {
                        "payment_reference":   run.payment_reference,
                        "existing_run_status": run.status,
                    }

        for line in lines:
            key = (line["journal_number"], line["journal_line_number"])
            info = submitted_keys.get(key)
            line["already_submitted"]      = info is not None
            line["existing_payment_ref"]   = info["payment_reference"]   if info else None
            line["existing_run_status"]    = info["existing_run_status"] if info else None

        return Response({"ok": True, "lines": lines, "count": len(lines)})


class AmendMarkerView(APIView):
    """Update allocation markers for a set of ledger lines.

    POST /api/v1/sunsystems/amend-markers/

    Request body:
        lines: [
            {
                journal_number:      str   e.g. "28"
                journal_line_number: str   e.g. "1"
                payment_marker:      str   e.g. "F"
            },
            ...
        ]
        business_unit: str  (optional — falls back to configured value)
        budget_code:   str  (optional — falls back to configured value)

    Response (success):
        { ok: true, processed: int, response_xml: str }

    Response (error):
        { ok: false, error: str, response_xml: str }
    """

    permission_classes = [IsAuthenticated]

    def post(self, request):
        import xml.etree.ElementTree as ET

        data = request.data or {}

        lines = data.get("lines", [])
        if not lines:
            return Response(
                {"ok": False, "error": "No lines provided."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        # ── Resolve connection ────────────────────────────────────────────────
        conn = effective_connection()
        config = SunSystemsConfig.from_mapping(conn)

        business_unit = str(data.get("business_unit") or config.business_unit or "PK1")
        budget_code = str(data.get("budget_code") or config.budget_code or "A")

        # ── Idempotency: mark lines already in an active payment run ──────────
        # Query PaymentRun records for this BU/budget that are NOT rejected
        # so we can flag lines the user has already submitted.  This prevents
        # double-submission even if SunSystems still shows the old marker.
        # Only rejected and never-submitted transactions are selectable.
        # Pending approval, failed, approved, processing, and paid transactions are blocked.
        submitted_keys: dict[tuple[str, str], dict] = {}
        active_runs = (
            PaymentRun.objects
            .filter(business_unit=business_unit, budget_code=budget_code)
            .exclude(status=PaymentRunStatus.REJECTED)
            .only("payment_reference", "status", "lines")
        )
        for run in active_runs:
            for ln in (run.lines or []):
                key = (
                    str(ln.get("journal_number",      "")).strip(),
                    str(ln.get("journal_line_number", "")).strip(),
                )
                if key[0] and key[1] and key not in submitted_keys:
                    submitted_keys[key] = {
                        "payment_reference":   run.payment_reference,
                        "existing_run_status": run.status,
                    }

        # Check each line in the request against already-submitted lines
        duplicate_lines = []
        for line in lines:
            jnl     = str(line.get("journal_number",      "")).strip()
            jnl_ln  = str(line.get("journal_line_number", "")).strip()
            key = (jnl, jnl_ln)
            if key in submitted_keys:
                duplicate_lines.append({
                    "journal_number": jnl,
                    "journal_line_number": jnl_ln,
                    "payment_reference": submitted_keys[key]["payment_reference"],
                    "existing_run_status": submitted_keys[key]["existing_run_status"],
                })

        if duplicate_lines:
            return Response(
                {
                    "ok": False,
                    "error": f"{len(duplicate_lines)} line(s) already submitted to payment run {duplicate_lines[0]['payment_reference']}. Duplicate submissions are not allowed.",
                    "duplicate_lines": duplicate_lines,
                },
                status=status.HTTP_409_CONFLICT,
            )

        # ── Build <AllocationMarkers> blocks ───────────────────────────────────
        markers_xml_parts = []
        for line in lines:
            jnl     = str(line.get("journal_number",      "")).strip()
            jnl_ln  = str(line.get("journal_line_number", "")).strip()
            marker  = str(line.get("payment_marker",      "F")).strip()
            if not jnl or not jnl_ln:
                continue
            markers_xml_parts.append(
                f"    <AllocationMarkers>\n"
                f"      <JournalLineNumber>{jnl_ln}</JournalLineNumber>\n"
                f"      <JournalNumber>{jnl}</JournalNumber>\n"
                f"      <Actions>\n"
                f"        <AllocationMarker>{marker}</AllocationMarker>\n"
                f"      </Actions>\n"
                f"    </AllocationMarkers>"
            )

        if not markers_xml_parts:
            return Response(
                {"ok": False, "error": "No valid lines to process (missing journal number or line number)."},
                status=status.HTTP_400_BAD_REQUEST,
            )

        ssc_payload = (
            "<SSC>\n"
            "  <ErrorContext>\n"
            "    <ErrorOutput>1</ErrorOutput>\n"
            "    <ErrorThreshold>0</ErrorThreshold>\n"
            "  </ErrorContext>\n"
            f"  <SunSystemsContext>\n"
            f"    <BusinessUnit>{business_unit}</BusinessUnit>\n"
            f"    <BudgetCode>{budget_code}</BudgetCode>\n"
            "  </SunSystemsContext>\n"
            "  <Payload>\n"
            + "\n".join(markers_xml_parts) + "\n"
            "  </Payload>\n"
            "</SSC>"
        )

        # ── Execute ───────────────────────────────────────────────────────────
        try:
            client = SunSystemsClient(config)
            response_xml = client.execute("AllocationMarkerUpdate", "AmendMarker", ssc_payload)
        except SunSystemsError as exc:
            return Response(
                {"ok": False, "error": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        # ── Parse response for SunSystems-level errors ──────────────────────────
        msgs = _sunsystems_error_messages(response_xml)
        if msgs:
            return Response(
                {"ok": False, "error": " | ".join(msgs), "response_xml": response_xml},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        payment_run = _create_payment_run_from_marked_lines(
            request=request,
            data=data,
            business_unit=business_unit,
            budget_code=budget_code,
            lines=lines,
        )
        workflow_error = None
        try:
            from apps.workflows.services import WorkflowError, WorkflowService
            WorkflowService.start_payment_run(payment_run, request.user)
            payment_run.refresh_from_db()
            # Persist builder approval-step count on the run for legacy consumers.
            workflow = getattr(payment_run, "workflow_instance", None)
            if workflow and workflow.template_id:
                approval_steps = workflow.template.steps.filter(step_type="approval").count()
                if approval_steps and payment_run.required_approvals != approval_steps:
                    payment_run.required_approvals = approval_steps
                    payment_run.save(update_fields=["required_approvals", "updated_at"])
        except WorkflowError as exc:
            workflow_error = str(exc)
            payment_run.status = PaymentRunStatus.FAILED
            payment_run.error = workflow_error
            payment_run.save(update_fields=["status", "error", "updated_at"])

        return Response({
            "ok": True,
            "processed": len(markers_xml_parts),
            "response_xml": response_xml,
            "workflow_error": workflow_error,
            "payment_run": PaymentRunSerializer(payment_run).data,
        })


class PaymentRunApproveView(APIView):
    """Legacy endpoint kept for URL compatibility; workflow tasks own approval."""

    permission_classes = [IsAuthenticated]

    def post(self, request, payment_run_id):
        run = PaymentRun.objects.filter(pk=payment_run_id).first()
        if not run:
            return Response({"detail": "Payment run not found."}, status=status.HTTP_404_NOT_FOUND)
        return Response(
            {"detail": "Payment run approvals are handled through Workflow tasks."},
            status=status.HTTP_410_GONE,
        )


class PaymentRunListView(APIView):
    """List recent payment-run batches for approval and processing."""

    permission_classes = [IsAuthenticated]

    def get(self, request):
        status_filter = str(request.query_params.get("status") or "").strip()
        qs = (
            PaymentRun.objects
            .select_related(
                "submitted_by",
                "processed_by",
                "workflow_instance",
                "workflow_instance__template",
            )
            .prefetch_related(
                "approvals",
                "workflow_instance__template__steps",
                "workflow_instance__tasks__step",
            )
            .order_by("-submitted_at")
        )
        if status_filter:
            qs = qs.filter(status=status_filter)
        return Response({
            "ok": True,
            "payment_runs": PaymentRunSerializer(qs[:50], many=True).data,
        })


class PaymentRunProcessView(APIView):
    """Run the final SunSystems PaymentRun/Process call after approval."""

    permission_classes = [IsAuthenticated]

    def post(self, request, payment_run_id):
        run = PaymentRun.objects.filter(pk=payment_run_id).first()
        if not run:
            return Response({"detail": "Payment run not found."}, status=status.HTTP_404_NOT_FOUND)
        try:
            run = process_payment_run(run, actor=request.user)
        except SunSystemsError as exc:
            return Response(
                {"ok": False, "error": str(exc), "payment_run": PaymentRunSerializer(run).data},
                status=status.HTTP_502_BAD_GATEWAY,
            )
        return Response({"ok": True, "payment_run": PaymentRunSerializer(run).data})


class AccountsQueryView(APIView):
    """Return supplier accounts from SunSystems (Accounts/Query, AccountType=1).

    GET /api/v1/sunsystems/accounts/?business_unit=PK1

    Optional query params:
        business_unit   override the configured default
        account_type    default 1 (Creditors/Suppliers); pass 0 for all

    Response:
        { accounts: [{ account_code, account_type, description }] }
    """

    permission_classes = [IsAuthenticated]

    def get(self, request):
        import xml.etree.ElementTree as ET

        conn = effective_connection()
        config = SunSystemsConfig.from_mapping(conn)

        business_unit = str(
            request.query_params.get("business_unit") or config.business_unit or "PK1"
        )
        account_type = str(request.query_params.get("account_type", "1")).strip()

        # Build filter — omit if account_type is blank (return all)
        if account_type:
            filter_xml = (
                f'<Filter>'
                f'<Item name="/Accounts/AccountType" operator="EQU" value="{account_type}"/>'
                f'</Filter>'
            )
        else:
            filter_xml = ""

        ssc_payload = (
            "<SSC>\n"
            "  <ErrorContext/>\n"
            "  <User/>\n"
            f"  <SunSystemsContext>\n"
            f"    <BusinessUnit>{business_unit}</BusinessUnit>\n"
            "  </SunSystemsContext>\n"
            "  <Payload>\n"
            f"    {filter_xml}\n"
            "    <Select>\n"
            "      <Accounts>\n"
            "        <AccountCode>.</AccountCode>\n"
            "        <AccountType>.</AccountType>\n"
            "        <Description>.</Description>\n"
            "      </Accounts>\n"
            "    </Select>\n"
            "  </Payload>\n"
            "</SSC>"
        )

        try:
            client = SunSystemsClient(config)
            response_xml = client.execute("Accounts", "Query", ssc_payload)
        except SunSystemsError as exc:
            return Response(
                {"ok": False, "error": str(exc)},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        accounts = []
        try:
            root = ET.fromstring(response_xml or "<SSC/>")
            for acct in root.findall(".//Accounts"):
                code = (acct.findtext("AccountCode") or "").strip()
                if not code:
                    continue
                accounts.append({
                    "account_code":  code,
                    "account_type":  (acct.findtext("AccountType") or "").strip(),
                    "description":   (acct.findtext("Description") or "").strip(),
                })
        except ET.ParseError as exc:
            return Response(
                {"ok": False, "error": f"Could not parse SunSystems response: {exc}"},
                status=status.HTTP_502_BAD_GATEWAY,
            )

        return Response({"ok": True, "accounts": accounts, "count": len(accounts)})
