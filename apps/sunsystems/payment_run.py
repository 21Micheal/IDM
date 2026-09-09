from __future__ import annotations

from django.utils import timezone

from .client import SunSystemsClient, SunSystemsConfig, SunSystemsError
from .models import PaymentRun, PaymentRunStatus, effective_connection


def sunsystems_error_messages(response_xml: str) -> list[str]:
    import xml.etree.ElementTree as ET

    try:
        root = ET.fromstring(response_xml or "<SSC/>")
    except ET.ParseError:
        return []

    messages = []
    
    # Check for PaymentRun specific errors (which may be in different structure)
    payment_run = root.find(".//PaymentRun")
    if payment_run is not None:
        status = payment_run.get("status", "").lower()
        # Only treat as error if status is explicitly error/failed
        if status == "error" or status == "failed":
            # Check for OutputDetails/MessageText
            output_details = payment_run.find(".//OutputDetails")
            if output_details is not None:
                message_text = output_details.findtext("MessageText")
                if message_text and message_text.strip():
                    messages.append(message_text.strip())
        
        # Check for error status even if not explicitly marked as error
        if status != "success" and status != "":
            messages.append(f"PaymentRun status: {status}")
    
    # Check for standard Errors/Error structure
    for err in root.findall(".//Errors/Error"):
        desc = (
            err.findtext("Description")
            or err.findtext("Message")
            or err.findtext("Text")
            or "Unknown error"
        )
        if desc and desc.strip():
            messages.append(desc.strip())
    
    # Check for application-level errors (like the NO DATA SELECTED error)
    for app in root.findall(".//Application"):
        component = app.findtext("Component")
        method = app.findtext("Method")
        message = app.findtext("Message")
        message_number = app.findtext("MessageNumber")
        user_text = app.findtext("UserText")
        
        if user_text and user_text.strip():
            error_msg = user_text.strip()
            if message_number:
                error_msg = f"{error_msg} (Error {message_number})"
            if component:
                error_msg = f"{component}: {error_msg}"
            messages.append(error_msg)
        elif message and message.strip():
            error_msg = message.strip()
            if message_number:
                error_msg = f"{error_msg} (Error {message_number})"
            if component:
                error_msg = f"{component}: {error_msg}"
            messages.append(error_msg)
    
    return messages


def payment_run_dates(run_date=None):
    if run_date is None:
        run_date = timezone.localdate()
    return {
        "run_date": run_date,
        "ddmmyyyy": run_date.strftime("%d%m%Y"),
        "post_period": f"{run_date.month:03d}{run_date.year}",
        "ddmmyy": run_date.strftime("%d%m%y"),
    }


def build_payment_process_payload(run: PaymentRun) -> str:
    from xml.sax.saxutils import escape

    dates = payment_run_dates(run.run_date)

    def x(value) -> str:
        return escape(str(value or ""), {'"': "&quot;", "'": "&apos;"})

    payment_ref = x(run.payment_reference)
    business_unit = x(run.business_unit)
    return f"""<SSC>
<SunSystemsContext>
<BusinessUnit>{business_unit}</BusinessUnit>
</SunSystemsContext>
<Payload>
<PaymentRun>
<VSsrfmscAcp_AcpPayBaseDate>{dates["ddmmyyyy"]}</VSsrfmscAcp_AcpPayBaseDate>
<VSsrfmscAcp_AcpPayDate>{dates["ddmmyyyy"]}</VSsrfmscAcp_AcpPayDate>
<VSsrfmscAcp_AcpDiscBaseDate>{dates["ddmmyyyy"]}</VSsrfmscAcp_AcpDiscBaseDate>
<PostPeriod>
<PostPeriod>{dates["post_period"]}</PostPeriod>
</PostPeriod>
<BankPayments>
<ZzGeneric_Datetime>{dates["ddmmyyyy"]}</ZzGeneric_Datetime>
</BankPayments>
<VSsrfmscAcp_AcpDiscAcntCr>{x(run.discount_account_credit)}</VSsrfmscAcp_AcpDiscAcntCr>
<VSsrfmscAcp_AcpBankDetailsCode>{x(run.bank_details_code)}</VSsrfmscAcp_AcpBankDetailsCode>
<VSsrfmscAcp_AcpBankRef>{payment_ref}</VSsrfmscAcp_AcpBankRef>
<VSsrfmscAcp_AcpLdgPayRef>{payment_ref}</VSsrfmscAcp_AcpLdgPayRef>
<VSsrfmscAcp_AcpSelectionFrom3>F</VSsrfmscAcp_AcpSelectionFrom3>
<VSsrfmscAcp_AcpSelectionTo3>F</VSsrfmscAcp_AcpSelectionTo3>
<VSsrfmscAcp_AcpProfileCode>{x(run.profile_code)}</VSsrfmscAcp_AcpProfileCode>
<VSsrfmscAcp_AcpSelectionFrom1>.</VSsrfmscAcp_AcpSelectionFrom1>
<VSsrfmscAcp_AcpSelectionTo1>.</VSsrfmscAcp_AcpSelectionTo1>
<VSsrfmscAcp_AcpSelectionFrom2>.</VSsrfmscAcp_AcpSelectionFrom2>
<VSsrfmscAcp_AcpSelectionTo2>.</VSsrfmscAcp_AcpSelectionTo2>
<AdditionalParameters>
<ClearPrevious>Y</ClearPrevious>
<ClearPreviousBank>Y</ClearPreviousBank>
</AdditionalParameters>
<DocumentFormat>
<DocumentFormatCode>{x(run.document_format_code)}</DocumentFormatCode>
<LanguageCode>1</LanguageCode>
<Store>Y</Store>
</DocumentFormat>
<PostTransactions>
<ValidationRoutine_ValidationRoutine>Y</ValidationRoutine_ValidationRoutine>
</PostTransactions>
</PaymentRun>
</Payload>
</SSC>"""


def _verify_lines_paid(run: PaymentRun, config: "SunSystemsConfig") -> tuple[bool, str]:
    """Query SunSystems to confirm every line in the run now carries AllocationMarker=P.

    Returns (all_paid: bool, detail: str).
    ``all_paid`` is True only when every journal line is found and shows
    AllocationMarker = "P".  Any network error, parse failure, or unconfirmed
    line returns False so the caller keeps the run in PROCESSING state.
    """
    import xml.etree.ElementTree as ET

    lines = run.lines  # list of dicts stored at submission time
    if not lines:
        # No line data recorded – can't verify; treat conservatively.
        return False, "No line data available on the payment run record to verify against SunSystems."

    # Build one Journal/Query per JournalNumber so the filter stays simple.
    journal_numbers = sorted({str(l.get("journal_number", "")).strip() for l in lines if l.get("journal_number")})
    if not journal_numbers:
        return False, "Journal numbers missing from payment run lines."

    jnl_csv = ",".join(journal_numbers)
    business_unit = run.business_unit or "PK1"
    budget_code   = run.budget_code   or "A"

    # Single filter: AllocationMarker=P AND JournalNumber IN (...)
    # Two items → safe to use AND expression.
    if len(journal_numbers) == 1:
        filter_xml = (
            f'<Filter>'
            f'<Item name="/Ledger/Line/JournalNumber" operator="IN" value="{jnl_csv}"/>'
            f'</Filter>'
        )
    else:
        filter_xml = (
            f'<Filter><Expr operator="AND">'
            f'<Item name="/Ledger/Line/JournalNumber" operator="IN" value="{jnl_csv}"/>'
            f'<Item name="/Ledger/Line/AllocationMarker" operator="IN" value="P"/>'
            f'</Expr></Filter>'
        )

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
        <JournalNumber>.</JournalNumber>
        <JournalLineNumber>.</JournalLineNumber>
        <AllocationMarker>.</AllocationMarker>
      </Line>
    </Ledger>
  </Select>
</Payload>
</SSC>"""

    try:
        response_xml = SunSystemsClient(config).execute("Journal", "Query", ssc_payload)
    except SunSystemsError as exc:
        return False, f"Verification query failed: {exc}"

    try:
        root = ET.fromstring(response_xml or "<SSC/>")
    except ET.ParseError as exc:
        return False, f"Verification response parse error: {exc}"

    # Build a set of (journal_number, journal_line_number) that SunSystems
    # confirmed with AllocationMarker=P.
    confirmed: set[tuple[str, str]] = set()
    for line_el in root.findall(".//Line"):
        marker = (line_el.findtext("AllocationMarker") or "").strip().upper()
        if marker == "P":
            jnl    = (line_el.findtext("JournalNumber")     or "").strip()
            jnl_ln = (line_el.findtext("JournalLineNumber") or "").strip()
            if jnl and jnl_ln:
                confirmed.add((jnl, jnl_ln))

    # Every submitted line must appear in the confirmed set.
    unconfirmed = []
    for l in lines:
        key = (str(l.get("journal_number", "")).strip(), str(l.get("journal_line_number", "")).strip())
        if key not in confirmed:
            unconfirmed.append(f"Jnl {key[0]} Line {key[1]}")

    if unconfirmed:
        detail = (
            f"{len(unconfirmed)} of {len(lines)} line(s) not yet confirmed as Paid in SunSystems: "
            + ", ".join(unconfirmed[:10])
            + (" …" if len(unconfirmed) > 10 else "")
        )
        return False, detail

    return True, f"All {len(lines)} line(s) confirmed as AllocationMarker=P in SunSystems."


def _lines_with_paid_markers(lines) -> list:
    """Return a copy of stored lines with allocation/payment markers set to P."""
    updated = []
    for line in lines or []:
        if not isinstance(line, dict):
            updated.append(line)
            continue
        copy = dict(line)
        copy["allocation_marker"] = "P"
        copy["payment_marker"] = "P"
        updated.append(copy)
    return updated


def process_payment_run(run: PaymentRun, *, actor=None) -> PaymentRun:
    """Execute the SunSystems PaymentRun/Process call, then verify payment.

    The run is marked PAID **only** when a follow-up Journal/Query confirms
    that every submitted line now carries AllocationMarker=P in SunSystems.
    If the process call succeeds but verification fails, the run stays in
    PROCESSING so it can be retried or investigated without data corruption.
    
    Also allows retry for runs stuck in PROCESSING state due to errors.
    Also allows retry for REJECTED runs (will transition to APPROVED status first).
    """
    if run.status == PaymentRunStatus.PAID:
        return run
    
    # If REJECTED, transition to APPROVED status first (restarting the flow)
    if run.status == PaymentRunStatus.REJECTED:
        run.status = PaymentRunStatus.APPROVED
        run.error = ""
        run.save(update_fields=["status", "error", "updated_at"])
    
    if run.status not in (PaymentRunStatus.APPROVED, PaymentRunStatus.FAILED, PaymentRunStatus.PROCESSING):
        raise SunSystemsError("Payment run must be approved, rejected, failed, or processing before final payment.")

    ssc_payload = build_payment_process_payload(run)
    run.status = PaymentRunStatus.PROCESSING
    run.request_xml = ssc_payload
    run.error = ""
    run.save(update_fields=["status", "request_xml", "error", "updated_at"])

    config = SunSystemsConfig.from_mapping(effective_connection())

    # ── Step 1: Execute PaymentRun/Process ───────────────────────────────────
    try:
        response_xml = SunSystemsClient(config).execute("PaymentRun", "Process", ssc_payload)
    except SunSystemsError as exc:
        run.status = PaymentRunStatus.FAILED
        run.error = str(exc)
        run.save(update_fields=["status", "error", "updated_at"])
        raise

    process_errors = sunsystems_error_messages(response_xml)
    if process_errors:
        run.status = PaymentRunStatus.FAILED
        run.response_xml = response_xml
        run.error = " | ".join(process_errors)
        run.save(update_fields=["status", "response_xml", "error", "updated_at"])
        raise SunSystemsError(run.error)

    # Record the process response before verification so it is never lost.
    run.response_xml = response_xml
    run.save(update_fields=["response_xml", "updated_at"])

    # ── Step 2: Verify AllocationMarker=P in SunSystems ─────────────────────
    # The PaymentRun/Process call posts the payment batch in SunSystems, but
    # SunSystems may return a success response before the underlying ledger
    # lines are actually marked P (Paid).  We re-query the exact journal lines
    # and confirm the marker before considering the run settled.
    all_paid, verify_detail = _verify_lines_paid(run, config)

    if not all_paid:
        # Keep PROCESSING so the Celery task can be retried (or an operator
        # can trigger PaymentRunProcessView manually after investigation).
        run.error = f"PaymentRun/Process accepted by SunSystems but payment not yet confirmed: {verify_detail}"
        run.save(update_fields=["error", "updated_at"])
        raise SunSystemsError(run.error)

    # ── Step 3: Mark as PAID ─────────────────────────────────────────────────
    # Persist the post-payment marker so snapshots no longer show the
    # submit-time F (or other) marker after SunSystems has confirmed P.
    run.status = PaymentRunStatus.PAID
    run.lines = _lines_with_paid_markers(run.lines)
    run.error = ""
    run.processed_by = actor
    run.processed_at = timezone.now()
    run.save(update_fields=["status", "lines", "error", "processed_by", "processed_at", "updated_at"])
    return run
