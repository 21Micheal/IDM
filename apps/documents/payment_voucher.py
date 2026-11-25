"""Generate CASSOA payment vouchers after Imprest posting and retirement."""
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
                        "description": "Payment vouchers generated for Imprest advances and retirement refunds.",
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


def _payment_voucher_signatory_values(document, posting, requisitioner, *, include_later_approvals=False) -> dict:
    """Resolve the voucher's Finance, Executive Director, and receipt signers.

    Imprest vouchers are created by a posting task, which may run after the
    workflow action that triggered it. Resolve the approved request-phase
    actors from the task audit trail and limit candidates to approvals recorded
    no later than this posting. This avoids accidentally using retirement or
    later procurement approvers on the advance voucher.
    """
    from apps.workflows.models import WorkflowTaskAction
    from apps.documents.lpo import _approval_signature_data, _form_signature_data, _user_name

    cutoff = timezone.now() if include_later_approvals else getattr(posting, "posted_at", None)
    if cutoff is None:
        cutoff = getattr(posting, "updated_at", None) or getattr(posting, "created_at", None)
    actions = WorkflowTaskAction.objects.filter(
        task__workflow_instance__document=document,
        task__execution_lane="main",
        action="approved",
        actor__isnull=False,
    ).select_related("actor", "task__step", "task__step__assignee_group").order_by("created_at")

    finance_action = executive_action = None
    for action in actions:
        if cutoff and action.created_at and action.created_at > cutoff:
            continue
        step = action.task.step
        group_name = getattr(getattr(step, "assignee_group", None), "name", "") or ""
        role_name = getattr(action.actor, "job_description", "") or ""
        search = " ".join((str(step.name or ""), str(group_name), str(role_name))).casefold()
        if "executive director" in search:
            executive_action = action
        elif "finance" in search:
            finance_action = action

    def signer(action, signature_markers):
        if action is None:
            return {
                "name": "", "role": "", "date": "",
                "signature": _form_signature_data(document, signature_markers),
            }
        actor = action.actor
        signature = _approval_signature_data(actor, action=action)
        if not signature:
            signature = _form_signature_data(document, signature_markers)
        return {
            "name": _user_name(actor),
            "role": str(getattr(actor, "job_description", "") or action.task.step.name or "").strip(),
            "date": timezone.localtime(action.created_at).strftime("%d-%m-%Y") if action.created_at else "",
            "signature": signature,
        }

    received_date = timezone.localdate().strftime("%d-%m-%Y")
    received_name = _user_name(requisitioner)
    if not received_name and requisitioner:
        received_name = requisitioner.get_username()
    received_signature = _approval_signature_data(requisitioner)
    if not received_signature:
        received_signature = _form_signature_data(document, ("requisitioner", "requester", "received_by"))
    received = {
        "name": received_name,
        "role": str(getattr(requisitioner, "job_description", "") or "Requisitioner").strip(),
        "date": received_date,
        "signature": received_signature,
    }
    values = {}
    for slot, detail in (
        ("prepared_by", signer(finance_action, ("finance", "prepared_by"))),
        ("approved_by", signer(executive_action, ("executive", "director", "approved_by"))),
        ("received_by", received),
    ):
        for key, value in detail.items():
            values[f"{slot}.{key}"] = value
    return values


def _template_with_payment_voucher_signatories(template):
    """Apply signatory mappings to existing saved PV templates at render time."""
    import copy

    design = getattr(template, "design", None)
    if not isinstance(design, dict):
        return template
    design = copy.deepcopy(design)
    mappings = {
        "pv-prepared": ("Prepared By", "prepared_by"),
        "pv-approved": ("Approved By", "approved_by"),
        "pv-received": ("Received By", "received_by"),
    }

    def walk(value):
        if isinstance(value, dict):
            if value.get("type") == "signature_group" and value.get("id") == "pv-signatories":
                value.setdefault("style", {})["signatureAfterDate"] = True
                for signature in value.get("signatories") or []:
                    mapping = mappings.get(str(signature.get("id") or ""))
                    if mapping:
                        role, slot = mapping
                        signature.update({
                            "role": role,
                            "name": "{{" + slot + ".name}}",
                            "date": "{{" + slot + ".date}}",
                            "signature": "{{" + slot + ".signature}}",
                        })
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for child in value:
                walk(child)

    walk(design)
    rendered_template = copy.copy(template)
    rendered_template.design = design
    return rendered_template


def _voucher_values(document, retirement: dict, posting, requisitioner) -> dict | None:
    from apps.sunsystems.config import get_form_values
    from apps.sunsystems.mapping import classify_retirement, resolve_value

    values = get_form_values(document)
    classified = classify_retirement(retirement, values)
    scenario_name = str(classified.get("scenario") or "").strip().lower()
    if scenario_name not in {"under", "over"} or Decimal(classified.get("variance") or 0) <= Decimal("0.005"):
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
    description = description or str(classified.get("description") or "Imprest retirement variance").strip()

    # Use the account configured for the debit variance line in the matching
    # retirement scenario. The scenario mapping distinguishes returned funds
    # (under) from reimbursement (over), while the voucher amount stays the
    # absolute variance in either case.
    account_code = ""
    scenario_lines = ((retirement.get("scenarios") or {}).get(scenario_name) or {}).get("lines") or []
    for line in scenario_lines:
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
        **_payment_voucher_signatory_values(document, posting, requisitioner),
    }


@transaction.atomic
def generate_payment_voucher_for_retirement(document, posting, actor=None):
    """Create one linked payment voucher once all retirement journals are posted.

    Returns ``None`` for non-retirement/incomplete postings or exact-spend
    retirements. Both under- and over-expenditure create a voucher for the
    absolute variance, using the debit variance account configured for the
    matching scenario.
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
        metadata__payment_voucher__source_document_id=str(locked.pk),
        metadata__payment_voucher__kind="retirement",
    ).order_by("created_at").first()
    if existing:
        form_meta["payment_voucher_document_id"] = str(existing.pk)
        form_meta["payment_voucher_reference"] = existing.reference_number
        form_meta["retirement_payment_voucher_status"] = "generated"
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
        _template_with_payment_voucher_signatories(template), render_values,
        fmt="pdf", title=title, user=user,
        type_id=doc_type.id, reference_number=reference,
    )
    voucher_metadata = dict(voucher.metadata or {})
    voucher_metadata["payment_voucher"] = {
        "kind": "retirement",
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
        defaults={"created_by": user, "note": "Payment voucher generated for retirement variance"},
    )
    form_meta["payment_voucher_document_id"] = str(voucher.pk)
    form_meta["payment_voucher_reference"] = voucher.reference_number
    form_meta["retirement_payment_voucher_status"] = "generated"
    metadata["form"] = form_meta
    locked.metadata = metadata
    locked.save(update_fields=["metadata", "updated_at"])
    return voucher


@transaction.atomic
def generate_payment_voucher_for_imprest(document, posting, actor=None, *, force_refresh=False):
    """Create the advance DSA voucher after every Imprest journal is posted."""
    from decimal import Decimal, InvalidOperation
    from apps.documents.models import Document, DocumentRelationship
    from apps.sunsystems.config import get_imprest_request_postings, get_sunsystems_config
    from apps.sunsystems.models import JournalPosting, JournalPostingStatus

    requested = get_imprest_request_postings(document)
    stages = {int(item["stage"]) for item in requested}
    stage = int(getattr(posting, "stage", 0) or 0)
    if not stages or stage not in stages:
        return None
    posted = set(JournalPosting.objects.filter(
        document=document, stage__in=stages, status=JournalPostingStatus.POSTED,
    ).values_list("stage", flat=True))
    if not stages.issubset(posted):
        return None

    locked = Document.objects.select_for_update().get(pk=document.pk)
    metadata = dict(locked.metadata or {})
    form_meta = dict(metadata.get("form") or {})
    existing_id = form_meta.get("imprest_payment_voucher_document_id")
    refresh_target = None
    if existing_id:
        existing = Document.objects.filter(pk=existing_id).first()
        if existing:
            if not force_refresh:
                return existing
            refresh_target = existing
    existing = Document.objects.filter(
        incoming_relationships__source_document=locked,
        incoming_relationships__relation_type=DocumentRelationship.RelationType.REFERENCES,
        metadata__payment_voucher__source_document_id=str(locked.pk),
        metadata__payment_voucher__kind="imprest",
    ).order_by("created_at").first()
    if existing and not refresh_target and not force_refresh:
        form_meta["imprest_payment_voucher_document_id"] = str(existing.pk)
        form_meta["imprest_payment_voucher_reference"] = existing.reference_number
        form_meta["imprest_payment_voucher_status"] = "generated"
        metadata["form"] = form_meta
        locked.metadata = metadata
        locked.save(update_fields=["metadata", "updated_at"])
        return existing
    if existing and not refresh_target:
        refresh_target = existing
        form_meta["imprest_payment_voucher_document_id"] = str(existing.pk)

    debit_lines = []
    for item in requested:
        for line in ((item.get("mapping") or {}).get("lines") or []):
            if not isinstance(line, dict) or str(line.get("dc") or "D").upper() != "D":
                continue
            amount_spec = line.get("amount")
            account_spec = line.get("account")
            try:
                amount = Decimal(str(amount_spec.get("const") if isinstance(amount_spec, dict) else amount_spec or "0"))
            except (InvalidOperation, TypeError, ValueError):
                continue
            account = str(account_spec.get("const") if isinstance(account_spec, dict) else account_spec or "").strip()
            if amount > 0:
                debit_lines.append((amount, account, line))
    total_dsa = sum((amount for amount, _, _ in debit_lines), Decimal("0"))
    if total_dsa <= 0 or not debit_lines:
        raise RuntimeError("No positive DSA debit lines were found in the posted Imprest mapping.")
    account_codes = {account for _, account, _ in debit_lines if account}
    if not account_codes:
        raise RuntimeError("No DSA account code was resolved from the posted Imprest mapping.")
    if len(account_codes) != 1:
        raise RuntimeError("The DSA Payment Voucher requires one configured DSA account code across its posted lines.")

    sunsystems = get_sunsystems_config(locked)
    ui = sunsystems.get("ui") if isinstance(sunsystems.get("ui"), dict) else {}
    first_line = debit_lines[0][2]
    requisitioner = getattr(locked, "uploaded_by", None)
    person_name = requisitioner.get_full_name().strip() if requisitioner else ""
    person_name = person_name or (requisitioner.get_username() if requisitioner else "")
    today = timezone.localdate().strftime("%d-%m-%Y")
    period = str(ui.get("accountingPeriod") or "").strip()
    description_spec = first_line.get("description")
    from apps.sunsystems.mapping import resolve_value
    from apps.sunsystems.config import get_form_values
    description = resolve_value(description_spec, get_form_values(locked)).strip()
    def const_value(line, key, default=""):
        spec = line.get(key)
        return str(spec.get("const") or default) if isinstance(spec, dict) else str(spec or default)

    currency = const_value(first_line, "currency", locked.currency or "").strip()
    reference = ", ".join(dict.fromkeys(
        str(value).strip() for value in JournalPosting.objects.filter(
            document=locked, stage__in=stages, status=JournalPostingStatus.POSTED,
        ).exclude(journal_number="").order_by("stage").values_list("journal_number", flat=True) if value
    )) or str(locked.reference_number or "")
    render_values = {
        "voucher_payment_to": person_name,
        "voucher_account_code": next(iter(account_codes)),
        "voucher_name": person_name,
        "voucher_date": today,
        "voucher_period": period,
        "voucher_line_date": const_value(first_line, "date", today),
        "voucher_reference": reference,
        "voucher_description": description or const_value(first_line, "description", "Imprest DSA payment"),
        "voucher_currency": currency,
        "voucher_amount": f"{total_dsa:.2f}",
        "voucher_total": f"{total_dsa:.2f}",
        "voucher_lines": [{
            "period": period,
            "date": const_value(line, "date", today),
            "reference": reference,
            "description": const_value(line, "description", description),
            "currency": const_value(line, "currency", currency),
            "amount": f"{amount:.2f}",
        } for amount, _, line in debit_lines],
        **_payment_voucher_signatory_values(
            locked, posting, requisitioner, include_later_approvals=force_refresh,
        ),
    }
    template, doc_type = _find_template_and_type()
    if template is None or doc_type is None:
        raise RuntimeError("No Payment Voucher template or PV document type is configured.")
    from apps.documents.serializers import _generate_unique_reference
    from apps.templates_engine.tasks import generate_document_from_template_sync
    user = requisitioner or actor or locked.owned_by
    if user is None:
        raise RuntimeError("Cannot create the Imprest Payment Voucher without a user.")
    rendered_voucher = generate_document_from_template_sync(
        _template_with_payment_voucher_signatories(template), render_values,
        fmt="pdf", title=f"Imprest Payment Voucher — {locked.reference_number}",
        user=user, type_id=doc_type.id, reference_number=_generate_unique_reference(doc_type),
    )
    voucher = rendered_voucher
    if refresh_target:
        from django.core.files.base import ContentFile
        rendered_voucher.file.open("rb")
        rendered_bytes = rendered_voucher.file.read()
        rendered_voucher.file.close()
        refresh_target.file.delete(save=False)
        refresh_target.file.save(rendered_voucher.file_name, ContentFile(rendered_bytes), save=False)
        refresh_target.title = rendered_voucher.title
        refresh_target.file_name = rendered_voucher.file_name
        refresh_target.file_size = rendered_voucher.file_size
        refresh_target.file_mime_type = rendered_voucher.file_mime_type
        refresh_target.checksum = rendered_voucher.checksum
        refresh_target.metadata = rendered_voucher.metadata
        refresh_target.amount = rendered_voucher.amount
        refresh_target.currency = rendered_voucher.currency
        refresh_target.document_date = rendered_voucher.document_date
        refresh_target.due_date = rendered_voucher.due_date
        refresh_target.save(update_fields=[
            "file", "title", "file_name", "file_size", "file_mime_type", "checksum",
            "metadata", "amount", "currency", "document_date", "due_date", "updated_at",
        ])
        rendered_voucher.file.delete(save=False)
        rendered_voucher.delete()
        voucher = refresh_target
    voucher_metadata = dict(voucher.metadata or {})
    voucher_metadata["payment_voucher"] = {
        "kind": "imprest", "source_document_id": str(locked.pk),
        "source_reference": locked.reference_number, "journal_reference": reference,
        "imprest_stages": sorted(stages), "amount": f"{total_dsa:.2f}", "currency": currency,
    }
    voucher.metadata = voucher_metadata
    voucher.save(update_fields=["metadata", "updated_at"])
    DocumentRelationship.objects.get_or_create(
        source_document=locked, target_document=voucher,
        relation_type=DocumentRelationship.RelationType.REFERENCES,
        defaults={"created_by": user, "note": "Payment voucher generated for the Imprest DSA advance"},
    )
    form_meta["imprest_payment_voucher_document_id"] = str(voucher.pk)
    form_meta["imprest_payment_voucher_reference"] = voucher.reference_number
    form_meta["imprest_payment_voucher_status"] = "generated"
    form_meta.pop("imprest_payment_voucher_error", None)
    metadata["form"] = form_meta
    locked.metadata = metadata
    locked.save(update_fields=["metadata", "updated_at"])
    return voucher


def refresh_imprest_payment_voucher_for_request_approval(document, *, actor=None):
    """Refresh an existing DSA voucher after a later Request approval signs it."""
    from apps.documents.models import Document
    from apps.sunsystems.config import get_imprest_request_postings
    from apps.sunsystems.models import JournalPosting, JournalPostingStatus

    form = ((getattr(document, "metadata", None) or {}).get("form") or {})
    voucher_id = form.get("imprest_payment_voucher_document_id")
    if not voucher_id or not Document.objects.filter(pk=voucher_id).exists():
        return None
    stages = {int(item["stage"]) for item in get_imprest_request_postings(document) if item.get("stage") is not None}
    if not stages:
        return None
    posting = JournalPosting.objects.filter(
        document=document, stage__in=stages, status=JournalPostingStatus.POSTED,
    ).order_by("-posted_at", "-updated_at").first()
    if not posting:
        return None
    return generate_payment_voucher_for_imprest(
        document, posting, actor=actor, force_refresh=True,
    )
