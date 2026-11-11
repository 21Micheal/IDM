"""Generate a CASSOA payment voucher after an over-expenditure retirement posts."""
from __future__ import annotations

import logging
import json
from pathlib import Path
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.utils import timezone

logger = logging.getLogger(__name__)

PAYMENT_VOUCHER_DOC_TYPE_CODE = "PV"


def _retirement_stages(document) -> set[int]:
    """Return the configured journal stages that complete retirement."""
    from apps.sunsystems.config import get_imprest_retirement_postings, get_journal_config, _get_stages

    stages = {
        int(item["stage"])
        for item in get_imprest_retirement_postings(document)
        if item.get("stage") is not None
    }
    if stages:
        return stages
    config = get_journal_config(document)
    if not config or not config.get("enabled"):
        return set()
    return {
        int(item.get("stage", 1))
        for item in _get_stages(config)
        if int(item.get("stage", 1)) == 2
    }


def _find_template_and_type():
    from apps.documents.models import DocumentType
    from apps.templates_engine.models import DocumentTemplate

    doc_type = DocumentType.objects.filter(code=PAYMENT_VOUCHER_DOC_TYPE_CODE).first()
    if doc_type is None:
        # A client may already have created a "Payment Voucher" document type
        # with a different code. Reuse it instead of trying to create the same
        # globally unique name again (which would raise IntegrityError).
        doc_type = DocumentType.objects.filter(name__iexact="Payment Voucher").first()
    if doc_type is None:
        try:
            # Keep creation in a savepoint so a concurrent insert or a unique
            # name conflict does not poison the caller's voucher transaction.
            with transaction.atomic():
                doc_type, _ = DocumentType.objects.get_or_create(
                    code=PAYMENT_VOUCHER_DOC_TYPE_CODE,
                    defaults={
                        "name": "Payment Voucher",
                        "reference_prefix": "PV",
                        "title_field": "filename",
                        "description": "Payment vouchers generated for imprest retirement over-expenditure.",
                    },
                )
        except IntegrityError:
            # Another request may have inserted the type while this one was
            # creating it. Resolve by either unique identifier before failing.
            doc_type = DocumentType.objects.filter(code=PAYMENT_VOUCHER_DOC_TYPE_CODE).first()
            if doc_type is None:
                doc_type = DocumentType.objects.filter(name__iexact="Payment Voucher").first()
            if doc_type is None:
                raise
    templates = DocumentTemplate.objects.filter(type="built", kind="document")
    template = templates.filter(document_type=doc_type).order_by("-updated_at").first()
    if template is None and doc_type is not None:
        # Seed the first-party template when no client-customized voucher exists.
        # Operators can still import/edit the matching public JSON in the designer.
        design_path = Path(__file__).parent / "templates" / "payment-voucher-eac-cassoa.json"
        try:
            design = json.loads(design_path.read_text(encoding="utf-8"))
            template = DocumentTemplate.objects.create(
                name="EAC CASSOA Payment Voucher",
                description=design.get("description", ""),
                type="built", kind="document", document_type=doc_type,
                category="finance", tags=design.get("tags", []), design=design,
            )
        except (OSError, ValueError):
            logger.exception("Could not load the built-in EAC CASSOA Payment Voucher design")
    return template, doc_type


def _voucher_values(document, retirement: dict, posting, requisitioner) -> dict | None:
    from apps.sunsystems.config import get_form_values
    from apps.sunsystems.mapping import classify_retirement, resolve_value

    values = get_form_values(document)
    classified = classify_retirement(retirement, values)
    if classified.get("scenario") != "over" or Decimal(classified.get("variance") or 0) <= Decimal("0.005"):
        return None

    spent = retirement.get("spent_amount") or {}
    table_key = spent.get("table")
    table_rows = values.get(table_key) if table_key else []
    currency = str(getattr(document, "currency", "") or "").strip()
    line_date = ""
    sunsystems = ((getattr(document, "metadata", {}) or {}).get("sunsystems") or {})
    ui_config = sunsystems.get("ui") if isinstance(sunsystems.get("ui"), dict) else {}
    period = str(ui_config.get("accountingPeriod") or "").strip()
    metadata_form = (getattr(document, "metadata", {}) or {}).get("form") or {}
    for section in metadata_form.get("sections") or []:
        for field in section.get("fields") or []:
            if field.get("key") != table_key:
                continue
            columns = field.get("columns") or []
            currency_column = next((column for column in columns
                                    if (column.get("sunsystems") or {}).get("role") == "currency"
                                    or str(column.get("label") or "").strip().casefold() == "currency"), None)
            date_column = next((column for column in columns
                                if str(column.get("label") or "").strip().casefold() in ("date", "expense date", "transaction date")), None)
            if currency_column and isinstance(table_rows, list):
                currency = next((str(row.get(currency_column.get("key")) or "").strip()
                                 for row in table_rows if isinstance(row, dict)
                                 and row.get(currency_column.get("key"))), currency)
            first_row = next((row for row in table_rows if isinstance(row, dict)), {}) if isinstance(table_rows, list) else {}
            if date_column:
                line_date = str(first_row.get(date_column.get("key")) or "").strip()
            break

    person_name = ""
    if requisitioner:
        person_name = requisitioner.get_full_name().strip() or requisitioner.get_username()
    today = timezone.localdate().strftime("%d-%m-%Y")
    from apps.sunsystems.models import JournalPosting, JournalPostingStatus
    stage_numbers = _retirement_stages(document)
    references = list(JournalPosting.objects.filter(
        document=document, stage__in=stage_numbers,
        status=JournalPostingStatus.POSTED,
    ).exclude(journal_number="").order_by("stage").values_list("journal_number", flat=True))
    journal_reference = ", ".join(dict.fromkeys(str(value).strip() for value in references if value))
    journal_reference = journal_reference or str(getattr(posting, "journal_number", "") or "").strip()
    # The expense description column is not necessarily the configured ledger
    # description source. The same mapped description used for the imprest
    # posting is the authoritative description on the voucher too.
    description_spec = None
    for config_key in ("purchase_order", "imprest_request"):
        profile = sunsystems.get(config_key)
        if not isinstance(profile, dict):
            continue
        po_config = profile.get("purchase_order") if isinstance(profile.get("purchase_order"), dict) else profile
        if not isinstance(po_config, dict):
            continue
        description_spec = po_config.get("comment") or po_config.get("description")
        if description_spec:
            break
    description = resolve_value(description_spec, values).strip() if description_spec else ""
    description = description or str(classified.get("description") or "Imprest retirement over-expenditure").strip()

    # The refund is charged to the account configured for the debit variance
    # line in the over-expenditure scenario (issued - spent is negative).
    account_code = ""
    for line in ((retirement.get("scenarios") or {}).get("over") or {}).get("lines") or []:
        if not isinstance(line, dict):
            continue
        amount_source = str(line.get("amount_source") or "spent").strip().lower()
        if amount_source == "variance" and str(line.get("dc") or "D").strip().upper() == "D":
            account_code = resolve_value(line.get("account"), values).strip()
            if account_code:
                break
    return {
        "voucher_payment_to": person_name,
        "voucher_account_code": account_code,
        "voucher_name": person_name,
        "voucher_date": today,
        "voucher_period": period,
        "voucher_line_date": line_date or today,
        "voucher_reference": journal_reference or document.reference_number,
        "voucher_description": description,
        "voucher_currency": currency,
        "voucher_amount": f'{Decimal(classified["variance"]):.2f}',
        "voucher_total": f'{Decimal(classified["variance"]):.2f}',
        "voucher_lines": [{
            "period": period,
            "date": line_date or today,
            "reference": journal_reference or document.reference_number,
            "description": description,
            "currency": currency,
            "amount": f'{Decimal(classified["variance"]):.2f}',
        }],
        # The caller passes the requisitioner as the template's current user so
        # its Prepared By formula resolves to this person's name.
    }


@transaction.atomic
def generate_payment_voucher_for_retirement(document, posting, actor=None):
    """Create one linked payment voucher once all retirement journals are posted.

    Returns ``None`` for non-retirement/incomplete postings or exact/underspent
    retirements. The first successful over-expenditure creates the built-in PV
    type and template if the client has not customized them already.
    """
    from apps.documents.models import Document, DocumentRelationship
    from apps.sunsystems.models import JournalPosting, JournalPostingStatus
    from apps.sunsystems.variance import _find_retirement_mapping

    stage = int(getattr(posting, "stage", 0) or 0)
    stages = _retirement_stages(document)
    if not stages or stage not in stages:
        return None
    posted_stages = set(JournalPosting.objects.filter(
        document=document, stage__in=stages, status=JournalPostingStatus.POSTED,
    ).values_list("stage", flat=True))
    if not stages.issubset(posted_stages):
        return None

    locked = Document.objects.select_for_update().get(pk=document.pk)
    metadata = dict(locked.metadata or {})
    form_meta = dict(metadata.get("form") or {})
    existing_id = form_meta.get("payment_voucher_document_id")
    if existing_id:
        existing = Document.objects.filter(pk=existing_id).first()
        if existing:
            return existing
    # Recover the linked voucher if the source metadata update was interrupted.
    existing = Document.objects.filter(
        incoming_relationships__source_document=locked,
        incoming_relationships__relation_type=DocumentRelationship.RelationType.REFERENCES,
        document_type__code=PAYMENT_VOUCHER_DOC_TYPE_CODE,
        metadata__payment_voucher__source_document_id=str(locked.pk),
    ).first()
    if existing:
        form_meta["payment_voucher_document_id"] = str(existing.pk)
        metadata["form"] = form_meta
        locked.metadata = metadata
        locked.save(update_fields=["metadata", "updated_at"])
        return existing

    retirement = _find_retirement_mapping(locked)
    if not retirement:
        return None
    requisitioner = getattr(locked, "uploaded_by", None)
    render_values = _voucher_values(locked, retirement, posting, requisitioner)
    if render_values is None:
        return None
    template, doc_type = _find_template_and_type()
    if template is None or doc_type is None:
        logger.warning("No Payment Voucher template or PV document type configured for %s", locked.pk)
        return None

    from apps.documents.serializers import _generate_unique_reference
    from apps.templates_engine.tasks import generate_document_from_template_sync

    user = requisitioner or actor or locked.owned_by
    if user is None:
        logger.warning("Cannot create Payment Voucher for %s without a user", locked.pk)
        return None
    reference = _generate_unique_reference(doc_type)
    title = f"Payment Voucher — {locked.reference_number}"
    voucher = generate_document_from_template_sync(
        template, render_values, fmt="pdf", title=title, user=user,
        type_id=doc_type.id, reference_number=reference,
    )
    voucher_metadata = dict(voucher.metadata or {})
    voucher_metadata["payment_voucher"] = {
        "source_document_id": str(locked.pk),
        "source_reference": locked.reference_number,
        "journal_reference": str(getattr(posting, "journal_number", "") or ""),
        "retirement_stages": sorted(stages),
        "amount": render_values["voucher_total"],
        "currency": render_values["voucher_currency"],
    }
    voucher.metadata = voucher_metadata
    voucher.save(update_fields=["metadata", "updated_at"])
    DocumentRelationship.objects.get_or_create(
        source_document=locked,
        target_document=voucher,
        relation_type=DocumentRelationship.RelationType.REFERENCES,
        defaults={"created_by": user, "note": "Payment voucher generated for retirement over-expenditure"},
    )
    form_meta["payment_voucher_document_id"] = str(voucher.pk)
    form_meta["payment_voucher_reference"] = voucher.reference_number
    metadata["form"] = form_meta
    locked.metadata = metadata
    locked.save(update_fields=["metadata", "updated_at"])
    return voucher
