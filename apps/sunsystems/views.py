"""
apps/sunsystems/views.py

API surface for the SunSystems integration:

  POST /api/v1/sunsystems/budget-check/         live budget availability
  POST /api/v1/sunsystems/journal-preview/      the exact <SSC> XML to be posted
  GET  /api/v1/sunsystems/postings/<doc_id>/    journal posting status
  POST /api/v1/sunsystems/postings/<doc_id>/retry/   re-attempt a failed posting
  POST /api/v1/sunsystems/payment-run/          query ledger lines (Journal/Query)
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
    SunSystemsConnection,
    effective_connection,
    stored_connection,
)
from .serializers import (
    BudgetCheckRequestSerializer,
    ConnectionSerializer,
    JournalPreviewRequestSerializer,
    JournalPostingSerializer,
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


class PaymentRunView(APIView):
    """Query SunSystems ledger lines for a payment run.

    POST /api/v1/sunsystems/payment-run/

    Request body (all fields optional — defaults mirror the test script):
        account_codes      list[str] | str  comma-separated or list   e.g. ["64001","71001"]
        allocation_markers list[str] | str  e.g. ["W"]  (unallocated)
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

        raw_markers = data.get("allocation_markers", "W")
        if isinstance(raw_markers, list):
            allocation_markers = ",".join(str(m) for m in raw_markers if m)
        else:
            allocation_markers = str(raw_markers).strip() or "W"

        journal_number_gt = str(data.get("journal_number_gt", "0")).strip() or "0"

        business_unit = str(data.get("business_unit") or config.business_unit or "PK1")
        budget_code = str(data.get("budget_code") or config.budget_code or "A")

        # ── Build filter expressions ──────────────────────────────────────────
        filter_items = []
        if account_codes:
            filter_items.append(
                f'<Item name="/Ledger/Line/AccountCode" operator="IN" value="{account_codes}"/>'
            )
        filter_items.append(
            f'<Item name="/Ledger/Line/JournalNumber" operator="GT" value="{journal_number_gt}"/>'
        )
        if allocation_markers:
            filter_items.append(
                f'<Item name="/Ledger/Line/AllocationMarker" operator="IN" value="{allocation_markers}"/>'
            )

        filter_xml = (
            '<Filter><Expr operator="AND">' + "".join(filter_items) + "</Expr></Filter>"
            if filter_items else ""
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

        return Response({"ok": True, "lines": lines, "count": len(lines)})
