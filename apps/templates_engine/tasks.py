from io import BytesIO
from pathlib import Path
import tempfile
import os
import re
import logging
from decimal import Decimal, InvalidOperation

from apps.search.utils import SEARCH_INDEX_EXCEPTIONS

logger = logging.getLogger(__name__)


STANDARD_DOCUMENT_FIELDS = {"title", "supplier", "amount", "currency", "document_date", "due_date"}


def _stringish(value):
    if value is None:
        return ""
    if isinstance(value, (str, int, float, Decimal)):
        return str(value)
    return ""


def _form_values_for_metadata(values: dict) -> dict:
    metadata = {}
    for key, value in (values or {}).items():
        if key in STANDARD_DOCUMENT_FIELDS:
            continue
        if isinstance(value, dict) and value.get("storage_path"):
            continue
        metadata[key] = value
    return metadata


def _document_field_kwargs(values: dict) -> dict:
    fields = {}
    for key in ("supplier", "currency", "document_date", "due_date"):
        value = _stringish((values or {}).get(key)).strip()
        if value:
            fields[key] = value
    amount = _stringish((values or {}).get("amount")).replace(",", "").strip()
    if amount:
        try:
            fields["amount"] = Decimal(amount)
        except (InvalidOperation, ValueError):
            pass
    return fields


def _display_value(value):
    if isinstance(value, dict) and value.get("storage_path"):
        return value.get("name") or "Attached file"
    if isinstance(value, (list, dict)):
        return str(value)
    return value


# ─── Helpers ────────────────────────────────────────────────────────────────

def _replace_placeholder_in_paragraph(para, values: dict):
    """
    Replace {{key}} placeholders in a paragraph, handling the case where
    placeholders are split across multiple runs (common in Word).
    We stitch the full text, replace, then rewrite into the first run.
    """
    full_text = "".join(run.text for run in para.runs)
    if "{{" not in full_text:
        return

    def replacer(match):
        key = match.group(1)
        val = values.get(key)
        if val is None:
            return ""
        if isinstance(val, (list, dict)):
            return str(val)
        return str(val)

    new_text = re.sub(r"\{\{([a-zA-Z0-9_]+)\}\}", replacer, full_text)
    if new_text == full_text:
        return

    # Write into first run, clear the rest
    if para.runs:
        para.runs[0].text = new_text
        for run in para.runs[1:]:
            run.text = ""


# ─── Built template generators ───────────────────────────────────────────────

def generate_built_pdf(template, values) -> bytes:
    """Generate PDF from built template using reportlab."""
    from reportlab.platypus import (
        SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable,
    )
    from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
    from reportlab.lib.pagesizes import A4
    from reportlab.lib import colors
    from reportlab.lib.units import mm

    buf = BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4,
        topMargin=20*mm, bottomMargin=20*mm,
        leftMargin=20*mm, rightMargin=20*mm,
    )
    styles = getSampleStyleSheet()

    # Custom styles
    title_style = ParagraphStyle(
        "DocTitle", parent=styles["Title"],
        fontSize=18, spaceAfter=6, textColor=colors.HexColor("#1e293b"),
    )
    h2_style = ParagraphStyle(
        "SecHeading", parent=styles["Heading2"],
        fontSize=12, textColor=colors.HexColor("#334155"),
        spaceBefore=12, spaceAfter=4,
    )
    label_style = ParagraphStyle(
        "FieldLabel", parent=styles["Normal"],
        fontSize=9, textColor=colors.HexColor("#64748b"),
        spaceAfter=1,
    )
    value_style = ParagraphStyle(
        "FieldValue", parent=styles["Normal"],
        fontSize=10, textColor=colors.HexColor("#0f172a"),
        spaceAfter=8,
    )
    h_field_style = ParagraphStyle(
        "FieldHeading", parent=styles["Heading3"],
        fontSize=11, textColor=colors.HexColor("#1e293b"),
        spaceBefore=8, spaceAfter=4,
    )

    story = []
    story.append(Paragraph(template.name, title_style))
    story.append(HRFlowable(width="100%", thickness=1, color=colors.HexColor("#e2e8f0")))
    story.append(Spacer(1, 8))

    for section in template.sections:
        story.append(Paragraph(section["title"], h2_style))
        if section.get("description"):
            story.append(Paragraph(section["description"], label_style))
        story.append(Spacer(1, 4))

        for field in section.get("fields", []):
            ftype = field.get("type", "text")
            key = field.get("key", "")
            label = field.get("label", "")
            value = _display_value(values.get(key, ""))

            if ftype == "divider":
                story.append(HRFlowable(width="100%", thickness=0.5, color=colors.HexColor("#e2e8f0")))
                story.append(Spacer(1, 4))
                continue

            if ftype == "heading":
                story.append(Paragraph(label, h_field_style))
                continue

            if ftype == "boolean":
                checked = "☑" if value else "☐"
                story.append(Paragraph(f"{checked}  {label}", value_style))
                continue

            if ftype == "table":
                rows = value if isinstance(value, list) and value else []
                cols = field.get("columns", [])
                if rows and cols:
                    header = [col["label"] for col in cols]
                    tdata = [header] + [
                        [str(row.get(col["key"], "")) for col in cols]
                        for row in rows
                    ]
                    col_width = (doc.width) / len(cols)
                    t = Table(tdata, colWidths=[col_width]*len(cols), repeatRows=1)
                    t.setStyle(TableStyle([
                        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f5f9")),
                        ("TEXTCOLOR",  (0, 0), (-1, 0), colors.HexColor("#334155")),
                        ("FONTNAME",   (0, 0), (-1, 0), "Helvetica-Bold"),
                        ("FONTSIZE",   (0, 0), (-1, 0), 9),
                        ("FONTSIZE",   (0, 1), (-1, -1), 9),
                        ("GRID",       (0, 0), (-1, -1), 0.5, colors.HexColor("#e2e8f0")),
                        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f8fafc")]),
                        ("TOPPADDING",  (0, 0), (-1, -1), 5),
                        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                        ("LEFTPADDING", (0, 0), (-1, -1), 6),
                    ]))
                    story.append(Paragraph(label, label_style))
                    story.append(t)
                    story.append(Spacer(1, 6))
                continue

            # Default field
            story.append(Paragraph(label, label_style))
            story.append(Paragraph(str(value) if value else "—", value_style))

    doc.build(story)
    return buf.getvalue()


def generate_built_docx(template, values) -> bytes:
    """Generate DOCX from built template using python-docx."""
    from docx import Document
    from docx.shared import Pt, RGBColor, Cm
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement

    doc = Document()

    # Set margins
    for section in doc.sections:
        section.top_margin = Cm(2)
        section.bottom_margin = Cm(2)
        section.left_margin = Cm(2.5)
        section.right_margin = Cm(2.5)

    # Title
    title_para = doc.add_heading(template.name, 0)
    title_para.alignment = WD_ALIGN_PARAGRAPH.LEFT

    for tmpl_section in template.sections:
        doc.add_heading(tmpl_section["title"], 1)
        if tmpl_section.get("description"):
            desc_para = doc.add_paragraph(tmpl_section["description"])
            desc_para.runs[0].font.color.rgb = RGBColor(0x64, 0x74, 0x8b)
            desc_para.runs[0].font.size = Pt(9)

        for field in tmpl_section.get("fields", []):
            ftype = field.get("type", "text")
            key = field.get("key", "")
            label = field.get("label", "")
            value = _display_value(values.get(key, ""))

            if ftype == "divider":
                p = doc.add_paragraph()
                pPr = p._p.get_or_add_pPr()
                pBdr = OxmlElement("w:pBdr")
                bottom = OxmlElement("w:bottom")
                bottom.set(qn("w:val"), "single")
                bottom.set(qn("w:sz"), "6")
                bottom.set(qn("w:space"), "1")
                bottom.set(qn("w:color"), "E2E8F0")
                pBdr.append(bottom)
                pPr.append(pBdr)
                continue

            if ftype == "heading":
                doc.add_heading(label, 3)
                continue

            if ftype == "boolean":
                p = doc.add_paragraph()
                p.add_run("☑ " if value else "☐ ").bold = True
                p.add_run(label)
                continue

            if ftype == "table":
                rows = value if isinstance(value, list) and value else []
                cols = field.get("columns", [])
                if rows and cols:
                    lp = doc.add_paragraph()
                    lp.add_run(label + ":").bold = True
                    table = doc.add_table(rows=1, cols=len(cols))
                    table.style = "Table Grid"
                    hdr_cells = table.rows[0].cells
                    for i, col in enumerate(cols):
                        hdr_cells[i].text = col["label"]
                        for run in hdr_cells[i].paragraphs[0].runs:
                            run.bold = True
                    for row_data in rows:
                        row_cells = table.add_row().cells
                        for i, col in enumerate(cols):
                            row_cells[i].text = str(row_data.get(col["key"], ""))
                    doc.add_paragraph()
                continue

            p = doc.add_paragraph()
            run_label = p.add_run(f"{label}: ")
            run_label.bold = True
            run_label.font.color.rgb = RGBColor(0x47, 0x55, 0x69)
            p.add_run(str(value) if value else "")

    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ─── Uploaded template fillers ───────────────────────────────────────────────

def fill_docx_template(template, values) -> bytes:
    """
    Fill uploaded DOCX template with placeholder values.
    Handles placeholders split across runs by stitching paragraph text.
    """
    from docx import Document

    doc = Document(template.file.path)

    def process_para(para):
        _replace_placeholder_in_paragraph(para, values)

    # Body paragraphs
    for para in doc.paragraphs:
        process_para(para)

    # Tables
    for table in doc.tables:
        for row in table.rows:
            for cell in row.cells:
                for para in cell.paragraphs:
                    process_para(para)

    # Headers & footers
    for section in doc.sections:
        for hf in [section.header, section.footer]:
            if hf:
                for para in hf.paragraphs:
                    process_para(para)

    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


def fill_xlsx_template(template, values) -> bytes:
    """Fill uploaded XLSX template with placeholder values."""
    import openpyxl
    import re

    wb = openpyxl.load_workbook(template.file.path)

    def replace_cell(cell):
        if cell.value and isinstance(cell.value, str) and "{{" in cell.value:
            def replacer(m):
                key = m.group(1)
                val = values.get(key, "")
                return str(val) if val is not None else ""
            cell.value = re.sub(r"\{\{([a-zA-Z0-9_]+)\}\}", replacer, cell.value)

    for ws in wb.worksheets:
        for row in ws.iter_rows():
            for cell in row:
                replace_cell(cell)

    buf = BytesIO()
    wb.save(buf)
    return buf.getvalue()


def docx_to_pdf(docx_bytes: bytes) -> bytes:
    """Convert DOCX to PDF using LibreOffice headless."""
    from apps.documents.tasks import _convert_office_source_to_pdf_bytes

    with tempfile.NamedTemporaryFile(suffix=".docx", delete=False) as f:
        f.write(docx_bytes)
        tmp_path = f.name
    try:
        return _convert_office_source_to_pdf_bytes(
            Path(tmp_path), soffice_bin="libreoffice", timeout=60
        )
    finally:
        os.unlink(tmp_path)


def xlsx_to_pdf(xlsx_bytes: bytes) -> bytes:
    """Convert XLSX to PDF using LibreOffice headless."""
    from apps.documents.tasks import _convert_office_source_to_pdf_bytes

    with tempfile.NamedTemporaryFile(suffix=".xlsx", delete=False) as f:
        f.write(xlsx_bytes)
        tmp_path = f.name
    try:
        return _convert_office_source_to_pdf_bytes(
            Path(tmp_path), soffice_bin="libreoffice", timeout=60
        )
    finally:
        os.unlink(tmp_path)


# ─── Main entry ─────────────────────────────────────────────────────────────

def generate_document_from_template_sync(template, values, fmt, title, user, type_id):
    """Generate a document from a template synchronously."""
    from apps.documents.models import Document, DocumentStatus
    from apps.documents.serializers import _generate_unique_reference
    from apps.documents.form_attachments import descriptors_to_names
    from django.core.files.base import ContentFile
    import hashlib

    is_xlsx = template.file_name.endswith((".xlsx", ".xls")) if template.file_name else False

    if template.type == "built":
        # The stored form.values keeps structured attachment descriptors and
        # reference {id,label} objects; the rendered file shows display strings.
        render_values = descriptors_to_names(values)
        if fmt == "pdf":
            content = generate_built_pdf(template, render_values)
            filename = f"{title}.pdf"
            content_type = "application/pdf"
        else:
            content = generate_built_docx(template, render_values)
            filename = f"{title}.docx"
            content_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

    else:  # uploaded
        if is_xlsx:
            xlsx_content = fill_xlsx_template(template, values)
            if fmt == "pdf":
                content = xlsx_to_pdf(xlsx_content)
                filename = f"{title}.pdf"
                content_type = "application/pdf"
            else:
                content = xlsx_content
                filename = f"{title}.xlsx"
                content_type = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        else:
            docx_content = fill_docx_template(template, values)
            if fmt == "pdf":
                content = docx_to_pdf(docx_content)
                filename = f"{title}.pdf"
                content_type = "application/pdf"
            else:
                content = docx_content
                filename = f"{title}.docx"
                content_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

    checksum = hashlib.sha256(content).hexdigest()
    reference_number = _generate_unique_reference(template.document_type)

    doc_metadata = {
        "template_id": str(template.id),
        "template_name": template.name,
        **_form_values_for_metadata(values),
    }
    if template.type == "built":
        # Built templates are interactive forms: store the schema snapshot + the
        # entered values so the document IS the filled form and can be re-rendered
        # / edited in-app (no external editor). The generated file is just a view.
        doc_metadata["form"] = {
            "template_id": str(template.id),
            "sections": template.sections,
            "values": values,
        }

    create_kwargs = dict(
        title=title,
        reference_number=reference_number,
        file=ContentFile(content, name=filename),
        file_name=filename,
        file_size=len(content),
        file_mime_type=content_type,
        checksum=checksum,
        uploaded_by=user,
        owned_by=user,
        document_type_id=type_id,
        is_self_upload=False,
        status=DocumentStatus.DRAFT,
        metadata=doc_metadata,
        **_document_field_kwargs(values),
        # A template-generated document is the starting point, not a user version.
        # It stays unversioned (v0 → shows as "—") until the user first edits it,
        # at which point the first save becomes version 1.
        current_version=0,
    )
    try:
        doc = Document.objects.create(**create_kwargs)
    except SEARCH_INDEX_EXCEPTIONS:
        # Elasticsearch is read-only (e.g. disk flood-stage). The row is already
        # committed; fetch it so document creation still succeeds. Indexing will
        # catch up once ES recovers.
        logger.warning(
            "Template document %s saved but realtime indexing failed (ES read-only).",
            reference_number,
        )
        doc = Document.objects.get(reference_number=reference_number)

    if doc.is_office_doc():
        try:
            from apps.documents.tasks import generate_document_preview

            Document.objects.filter(id=doc.id, preview_status="").update(
                preview_status="pending"
            )
            generate_document_preview.delay(str(doc.id))
        except Exception:
            pass
    try:
        from apps.search.indexing import schedule_document_search_pipeline

        schedule_document_search_pipeline(
            str(doc.id),
            reextract_content=True,
            index_immediately=True,
        )
    except Exception:
        pass
    return doc
