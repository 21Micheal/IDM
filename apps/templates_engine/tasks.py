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
        # Internal keys (`__sections_added`, `__document_id`) are metadata, not
        # form data — never mirror them onto the document.
        if str(key).startswith("__"):
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


def _decode_data_url_image(value):
    """Decode a ``data:image/...;base64,...`` URL (e.g. a signature) to raw
    bytes, or return None. Prevents dumping a giant base64 string into the doc."""
    if not isinstance(value, str) or not value.startswith("data:image"):
        return None
    try:
        import base64
        return base64.b64decode(value.split(",", 1)[1])
    except Exception:
        return None


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

def generate_built_pdf(template, values, sections=None) -> bytes:
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

    for section in (sections if sections is not None else template.sections):
        story.append(Paragraph(section["title"], h2_style))
        if section.get("description"):
            story.append(Paragraph(section["description"], label_style))
        story.append(Spacer(1, 4))

        for field in section.get("fields", []):
            ftype = field.get("type", "text")
            key = field.get("key", "")
            label = field.get("label", "")
            value = _display_value(values.get(key, ""))

            # Buttons are interactive only; never print them.
            if ftype == "button":
                continue

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

            if ftype == "signature":
                story.append(Paragraph(label, label_style))
                raw = _decode_data_url_image(value)
                if raw:
                    from reportlab.platypus import Image as RLImage
                    try:
                        img = RLImage(BytesIO(raw))
                        iw, ih = (img.imageWidth or 1), (img.imageHeight or 1)
                        w = min(60 * mm, doc.width)
                        img.drawWidth, img.drawHeight = w, w * ih / iw
                        story.append(img)
                    except Exception:
                        story.append(Paragraph("[signature]", value_style))
                else:
                    story.append(Paragraph("—", value_style))
                story.append(Spacer(1, 6))
                continue

            # Default field
            story.append(Paragraph(label, label_style))
            story.append(Paragraph(str(value) if value else "—", value_style))

    doc.build(story)
    return buf.getvalue()


def generate_built_docx(template, values, sections=None) -> bytes:
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

    for tmpl_section in (sections if sections is not None else template.sections):
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

            # Buttons are interactive only; never print them.
            if ftype == "button":
                continue

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

            if ftype == "signature":
                p = doc.add_paragraph()
                run_label = p.add_run(f"{label}: ")
                run_label.bold = True
                run_label.font.color.rgb = RGBColor(0x47, 0x55, 0x69)
                raw = _decode_data_url_image(value)
                if raw:
                    try:
                        from docx.shared import Inches
                        doc.add_picture(BytesIO(raw), width=Inches(2))
                    except Exception:
                        doc.add_paragraph("[signature]")
                continue

            p = doc.add_paragraph()
            run_label = p.add_run(f"{label}: ")
            run_label.bold = True
            run_label.font.color.rgb = RGBColor(0x47, 0x55, 0x69)
            p.add_run(str(value) if value else "")

    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


# ─── Document designer (WYSIWYG block layout) → DOCX ─────────────────────────

_TOKEN_RE = re.compile(r"\{\{([a-zA-Z0-9_.-]+)\}\}")
# User placeholders the admin marks for the recipient to fill when editing the
# generated document, e.g. [[Amount]]. Rendered as highlighted fill-in markers.
_PLACEHOLDER_RE = re.compile(r"\[\[([^\]]+)\]\]")


def _designer_add_text(paragraph, raw, values, *, size=None, color=None,
                       bold=None, italic=None, underline=None, font=None):
    """
    Emit runs into a paragraph for a designer text string. {{merge_fields}} are
    substituted to static text; [[user placeholders]] become highlighted runs the
    recipient fills in when editing the generated document.
    """
    from docx.shared import Pt
    from docx.enum.text import WD_COLOR_INDEX

    substituted = _subst_tokens(raw, values)
    if not substituted:
        return
    # re.split with a capture group yields: [text, label, text, label, ...] — the
    # odd indices are the placeholder labels.
    for i, part in enumerate(_PLACEHOLDER_RE.split(substituted)):
        if not part:
            continue
        run = paragraph.add_run(part)
        is_placeholder = i % 2 == 1
        if size:
            run.font.size = Pt(size)
        if font:
            run.font.name = font
        if bold is not None:
            run.bold = bold
        if italic is not None:
            run.italic = italic
        if underline is not None:
            run.underline = underline
        if is_placeholder:
            run.font.highlight_color = WD_COLOR_INDEX.YELLOW
        elif color is not None:
            run.font.color.rgb = color


def _subst_tokens(text, values, keep_page=False):
    """Replace {{key}} with values. When keep_page is True, leave {{page}} and
    {{pages}} intact so they can become Word page-number fields."""
    if not text:
        return ""

    def repl(m):
        key = m.group(1)
        if keep_page and key in ("page", "pages"):
            return m.group(0)
        val = values.get(key)
        return "" if val is None else str(val)

    return _TOKEN_RE.sub(repl, str(text))


def _designer_hex_to_rgb(hexstr, default="1F2933"):
    from docx.shared import RGBColor
    s = (hexstr or "").lstrip("#")
    if len(s) != 6:
        s = default
    try:
        return RGBColor(int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))
    except ValueError:
        return RGBColor(0x1F, 0x29, 0x33)


def _designer_font_family(css):
    if not css:
        return None
    first = css.split(",")[0].strip().strip("'\"")
    return first or None


def _designer_add_page_field(paragraph, instr):
    """Append a Word field (PAGE / NUMPAGES) to a paragraph."""
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), instr)
    run = OxmlElement("w:r")
    t = OxmlElement("w:t")
    t.text = "1"
    run.append(t)
    fld.append(run)
    paragraph._p.append(fld)


def _designer_band_runs(paragraph, text, values):
    """Render header/footer band text into a paragraph, turning {{page}} /
    {{pages}} into live Word fields and substituting other tokens."""
    rendered = _subst_tokens(text, values, keep_page=True)
    for part in re.split(r"(\{\{page\}\}|\{\{pages\}\})", rendered):
        if part == "{{page}}":
            _designer_add_page_field(paragraph, "PAGE")
        elif part == "{{pages}}":
            _designer_add_page_field(paragraph, "NUMPAGES")
        elif part:
            paragraph.add_run(part)


def _designer_clear_table_borders(table):
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn

    tblPr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "none")
        borders.append(el)
    tblPr.append(borders)


def _designer_merge_values(values, *, user, reference_number, title):
    """
    Resolve a designer ("document") template's merge fields. These templates are
    NOT filled by the user with placeholders — their {{tokens}} auto-populate
    from the acting user, the current date, the assigned reference, the document
    title, and any document-type metadata the user supplied at upload.

    User-supplied values (the document-type metadata) take precedence; the
    context defaults below only fill tokens that were left blank. Advanced
    sources (per-field formulas, document references) are a later enhancement.
    """
    from django.utils import timezone
    from apps.documents.form_formulas import resolve_formula

    resolved = dict(values or {})
    now = timezone.localtime()

    # Canonical formula vocabulary — shared with the form builder so the same
    # formula keys resolve identically in both. The designer's "formula picker"
    # inserts these keys directly.
    formula = {
        key: resolve_formula(key, user=user, reference_number=reference_number, now=now)
        for key in (
            "current_user", "current_user_email", "current_user_department",
            "today", "now", "reference_number",
        )
    }

    # Organization identity from DMS settings (auto-fills company merge fields).
    org_name = org_address = ""
    try:
        from apps.documents.models import DMSSettings
        settings_row = DMSSettings.objects.first()
        if settings_row:
            org_name = settings_row.organization_name or ""
            org_address = settings_row.organization_address or ""
    except Exception:
        pass

    defaults = {
        # Canonical formula keys.
        **formula,
        # Friendly aliases (and designer-specific fields) → same resolved values.
        "author_name": formula["current_user"],
        "author_email": formula["current_user_email"],
        "user_name": formula["current_user"],
        "prepared_by": formula["current_user"],
        "department": formula["current_user_department"],
        "document_date": formula["today"],
        "date": formula["today"],
        "document_no": reference_number,
        "document_number": reference_number,
        "company_name": org_name,
        "company_address": org_address,
        "organization_name": org_name,
        "document_title": title,
        "title": title,
    }
    for key, value in defaults.items():
        current = resolved.get(key)
        if value and (current is None or (isinstance(current, str) and not current.strip())):
            resolved[key] = value

    # ── Document references ───────────────────────────────────────────────────
    # A value picked from a related document ({id,label,source}) resolves to its
    # label for {{key}}, and pulls common fields for {{key__field}} — e.g.
    # {{related_po}}, {{related_po__supplier}}, {{related_po__reference_number}}.
    from apps.documents.form_attachments import is_reference_value
    from apps.documents.models import Document as _RefDoc
    for key, val in list(resolved.items()):
        if not is_reference_value(val):
            continue
        resolved[key] = val.get("label", "") or ""
        ref_id = val.get("id")
        if not ref_id:
            continue
        try:
            ref_doc = _RefDoc.objects.filter(pk=ref_id).first()
        except Exception:
            ref_doc = None
        if not ref_doc:
            continue
        # Authoritative label from the referenced document (don't trust the client).
        resolved[key] = (
            f"{ref_doc.title} ({ref_doc.reference_number})"
            if ref_doc.reference_number else (ref_doc.title or "")
        )
        amt = getattr(ref_doc, "amount", None)
        dd = getattr(ref_doc, "document_date", None)
        resolved[f"{key}__reference_number"] = ref_doc.reference_number or ""
        resolved[f"{key}__title"] = ref_doc.title or ""
        resolved[f"{key}__supplier"] = getattr(ref_doc, "supplier", "") or ""
        resolved[f"{key}__amount"] = str(amt) if amt is not None else ""
        resolved[f"{key}__currency"] = getattr(ref_doc, "currency", "") or ""
        resolved[f"{key}__document_date"] = dd.strftime("%d %b %Y") if dd else ""
        for mk, mv in (getattr(ref_doc, "metadata", None) or {}).items():
            if isinstance(mv, (str, int, float)):
                resolved.setdefault(f"{key}__{mk}", str(mv))

    return resolved


def _design_element_to_block(el: dict) -> dict | None:
    """Map one v2 designer element to the legacy block dict the DOCX renderer
    understands. Returns None for element types with no printable output."""
    if not isinstance(el, dict):
        return None
    etype = el.get("type")
    style = el.get("style") or {}

    if etype == "heading":
        return {"type": "heading", "text": el.get("text", ""),
                "level": el.get("level", 2), **style}
    if etype in ("text", "note"):
        return {"type": "paragraph", "text": el.get("text", ""), **style}
    if etype in ("bulleted_list", "numbered_list"):
        return {"type": etype, "items": el.get("items") or []}
    if etype == "field_group":
        pairs = [
            {"label": f.get("label", ""), "value": f.get("value", "")}
            for f in (el.get("fields") or [])
        ]
        return {"type": "key_value", "pairs": pairs} if pairs else None
    if etype == "data_table":
        cols = [
            {"key": c.get("key", ""), "label": c.get("label", "")}
            for c in (el.get("columns") or [])
        ]
        if not cols:
            return None
        source = el.get("sourceKey")
        return {
            "type": "data_table",
            "columns": cols,
            "bound": bool(source),
            "sourceKey": source or "",
            "rows": el.get("staticRows") or [],
            "fillRows": el.get("previewRows") or 3,
            "bordered": True,
        }
    if etype == "divider":
        return {"type": "divider"}
    if etype == "spacer":
        return {"type": "spacer", "height": el.get("height", 24)}
    if etype == "box":
        return {"type": "spacer", "height": style.get("minHeight", 24)}
    if etype == "image":
        return {
            "type": "image",
            "src": el.get("src", ""),
            "alt": el.get("alt", ""),
            "width": el.get("width") or 160,
        }
    if etype == "signature_group":
        sigs = [
            {
                "role": s.get("role", ""),
                "nameToken": s.get("name", ""),
                "dateToken": s.get("date", ""),
            }
            for s in (el.get("signatories") or [])
        ]
        return {"type": "signature", "signatories": sigs} if sigs else None
    return None


def _design_pages_to_legacy_blocks(design: dict) -> list[dict]:
    """Flatten a v2 designer layout (pages -> rows -> cells -> elements) into the
    legacy block list ``generate_designer_docx`` renders. Flow layout loses the
    exact grid geometry, but preserves order, text, groups, tables and page
    breaks so the generated DOCX is a faithful, editable approximation."""
    blocks: list[dict] = []
    pages = design.get("pages") or []
    for page_index, page in enumerate(pages):
        if page_index:
            blocks.append({"type": "page_break"})
        for row in (page.get("rows") or []):
            for cell in (row.get("columns") or []):
                for el in (cell.get("elements") or []):
                    converted = _design_element_to_block(el)
                    if converted:
                        blocks.append(converted)
        for item in (page.get("floating") or []):
            converted = _design_element_to_block((item or {}).get("element") or {})
            if converted:
                blocks.append(converted)
    return blocks


def _design_band_to_legacy(band: dict | None) -> dict:
    """Normalise a v2 designer header/footer PageBand into the legacy
    ``{enabled, content:{left,center,right}}`` shape the renderer expects."""
    if not isinstance(band, dict):
        return {"enabled": False, "content": {}}
    if band.get("content"):
        return band
    parts: list[str] = []
    for row in (band.get("rows") or []):
        texts: list[str] = []
        for cell in (row.get("columns") or []):
            for el in (cell.get("elements") or []):
                if el.get("type") in ("text", "note", "heading"):
                    text = str(el.get("text") or "").strip()
                    if text:
                        texts.append(text)
        joined = "  ".join(texts)
        if joined:
            parts.append(joined)
    content = {"left": "  ".join(parts)} if parts else {}
    return {"enabled": bool(band.get("enabled", True)) and bool(parts), "content": content}


def generate_designer_docx(design, values) -> bytes:
    """
    Render a WYSIWYG document-designer template (block layout) to an editable
    DOCX, substituting {{tokens}} from `values`. Faithful-but-approximate to the
    on-screen designer; the output follows the normal Office editing lifecycle.
    """
    from docx import Document
    from docx.shared import Pt, Mm, RGBColor
    from docx.enum.text import WD_ALIGN_PARAGRAPH
    from docx.enum.section import WD_ORIENT
    from docx.oxml.ns import qn
    from docx.oxml import OxmlElement

    design = design or {}
    theme = design.get("theme", {}) or {}
    page = design.get("page", {}) or {}
    blocks = design.get("blocks", []) or []
    if not blocks and isinstance(design.get("pages"), list) and design["pages"]:
        blocks = _design_pages_to_legacy_blocks(design)

    body_font = _designer_font_family(theme.get("fontFamily")) or "Calibri"
    heading_font = _designer_font_family(theme.get("headingFamily")) or body_font
    base_px = theme.get("baseFontSize") or 13
    base_pt = max(8, round(float(base_px) * 0.75))
    text_rgb = _designer_hex_to_rgb(theme.get("textColor"), "1F2933")
    heading_rgb = _designer_hex_to_rgb(theme.get("headingColor"), "0F2A3A")
    accent_rgb = _designer_hex_to_rgb(theme.get("accentColor"), "287EAD")

    px_to_pt = lambda px, fallback: max(8, round(float(px) * 0.75)) if px else fallback

    doc = Document()

    # Base style
    normal = doc.styles["Normal"]
    normal.font.name = body_font
    normal.font.size = Pt(base_pt)
    normal.font.color.rgb = text_rgb

    ALIGN = {
        "left": WD_ALIGN_PARAGRAPH.LEFT, "center": WD_ALIGN_PARAGRAPH.CENTER,
        "right": WD_ALIGN_PARAGRAPH.RIGHT, "justify": WD_ALIGN_PARAGRAPH.JUSTIFY,
    }

    # ── Page setup ──────────────────────────────────────────────────────────
    PAGE_DIMS = {"A4": (210, 297), "Letter": (216, 279), "Legal": (216, 356)}
    w_mm, h_mm = PAGE_DIMS.get(page.get("size", "A4"), (210, 297))
    margin = page.get("margin", {}) or {}
    for section in doc.sections:
        if page.get("orientation") == "landscape":
            section.orientation = WD_ORIENT.LANDSCAPE
            section.page_width, section.page_height = Mm(h_mm), Mm(w_mm)
        else:
            section.page_width, section.page_height = Mm(w_mm), Mm(h_mm)
        section.top_margin = Mm(margin.get("top", 20))
        section.bottom_margin = Mm(margin.get("bottom", 20))
        section.left_margin = Mm(margin.get("left", 18))
        section.right_margin = Mm(margin.get("right", 18))

    # ── Header / footer bands (left / center / right) ───────────────────────
    def render_band(band, container):
        if not band or not band.get("enabled"):
            return
        content = band.get("content", {}) or {}
        table = container.add_table(rows=1, cols=3, width=Mm(w_mm - margin.get("left", 18) - margin.get("right", 18)))
        _designer_clear_table_borders(table)
        cells = table.rows[0].cells
        for cell, (slot, align) in zip(cells, (("left", "left"), ("center", "center"), ("right", "right"))):
            para = cell.paragraphs[0]
            para.alignment = ALIGN[align]
            _designer_band_runs(para, content.get(slot, ""), values)

    section = doc.sections[0]
    render_band(_design_band_to_legacy(design.get("header")), section.header)
    render_band(_design_band_to_legacy(design.get("footer")), section.footer)

    # ── Blocks ──────────────────────────────────────────────────────────────
    def add_text(paragraph, raw, **style):
        _designer_add_text(paragraph, raw, values, **style)

    for b in blocks:
        btype = b.get("type")
        align = ALIGN.get(b.get("align", "left"), WD_ALIGN_PARAGRAPH.LEFT)

        if btype == "heading":
            level = b.get("level", 2)
            size = px_to_pt(b.get("fontSize"), {1: 18, 2: 14, 3: 12}.get(level, 14))
            p = doc.add_paragraph()
            p.alignment = align
            add_text(p, b.get("text", ""), size=size, font=heading_font, bold=True,
                     color=_designer_hex_to_rgb(b.get("color")) if b.get("color") else heading_rgb)

        elif btype in ("paragraph", "quote"):
            p = doc.add_paragraph()
            p.alignment = align
            add_text(p, b.get("text", ""), size=px_to_pt(b.get("fontSize"), None),
                     color=_designer_hex_to_rgb(b.get("color")) if b.get("color") else None,
                     bold=b.get("bold"), italic=b.get("italic") or (btype == "quote"),
                     underline=b.get("underline"))

        elif btype in ("bulleted_list", "numbered_list"):
            style = "List Bullet" if btype == "bulleted_list" else "List Number"
            for item in b.get("items", []) or []:
                p = doc.add_paragraph(style=style)
                add_text(p, item)

        elif btype == "key_value":
            pairs = b.get("pairs", []) or []
            if pairs:
                table = doc.add_table(rows=len(pairs), cols=2)
                _designer_clear_table_borders(table)
                for i, pair in enumerate(pairs):
                    lc, vc = table.rows[i].cells
                    add_text(lc.paragraphs[0], pair.get("label", ""), bold=True)
                    add_text(vc.paragraphs[0], pair.get("value", ""))

        elif btype == "data_table":
            cols = b.get("columns", []) or []
            if cols:
                if b.get("bound"):
                    # Bound to a collection if one was supplied (one row per
                    # record); otherwise emit blank fillable rows for the user to
                    # complete when editing the generated document.
                    source = values.get(b.get("sourceKey") or "")
                    if isinstance(source, list) and source:
                        rows = [
                            [str((rec or {}).get(c.get("key", ""), "")) for c in cols]
                            for rec in source
                        ]
                    else:
                        n = max(1, int(b.get("fillRows") or 3))
                        rows = [["" for _ in cols] for _ in range(n)]
                else:
                    rows = b.get("rows", []) or []
                table = doc.add_table(rows=1, cols=len(cols))
                table.style = "Table Grid" if b.get("bordered", True) else "Light List"
                for i, col in enumerate(cols):
                    cell = table.rows[0].cells[i]
                    run = cell.paragraphs[0].add_run(col.get("label", ""))
                    run.bold = True
                for row in rows:
                    cells = table.add_row().cells
                    for i, _col in enumerate(cols):
                        val = row[i] if i < len(row) else ""
                        add_text(cells[i].paragraphs[0], val)

        elif btype == "two_column":
            table = doc.add_table(rows=1, cols=2)
            _designer_clear_table_borders(table)
            lc, rc = table.rows[0].cells
            add_text(lc.paragraphs[0], b.get("left", ""))
            add_text(rc.paragraphs[0], b.get("right", ""))

        elif btype == "divider":
            p = doc.add_paragraph()
            pPr = p._p.get_or_add_pPr()
            pBdr = OxmlElement("w:pBdr")
            bottom = OxmlElement("w:bottom")
            bottom.set(qn("w:val"), "single")
            bottom.set(qn("w:sz"), "6")
            bottom.set(qn("w:space"), "1")
            bottom.set(qn("w:color"), "C8CDD2")
            pBdr.append(bottom)
            pPr.append(pBdr)

        elif btype == "spacer":
            p = doc.add_paragraph()
            p.paragraph_format.space_after = Pt(px_to_pt(b.get("height", 24), 18))

        elif btype == "page_break":
            doc.add_page_break()

        elif btype == "signature":
            sigs = b.get("signatories", []) or []
            if sigs:
                # Lay out up to 3 signatories per row, wrapping into more rows for
                # additional approvers. Each cell: role, a signing line, then the
                # Name/Date fields (which may be {{auto-fill}}, [[placeholders]] or
                # plain text).
                per_row = 3
                for start in range(0, len(sigs), per_row):
                    chunk = sigs[start:start + per_row]
                    table = doc.add_table(rows=1, cols=len(chunk))
                    _designer_clear_table_borders(table)
                    for i, s in enumerate(chunk):
                        cell = table.rows[0].cells[i]
                        cell.paragraphs[0].add_run(s.get("role", "")).bold = True
                        cell.add_paragraph()  # signing space
                        cell.add_paragraph().add_run("_______________________")
                        lbl = cell.add_paragraph().add_run("Signature")
                        lbl.italic = True
                        lbl.font.size = Pt(8)
                        if s.get("nameToken"):
                            p = cell.add_paragraph()
                            p.add_run("Name: ").bold = True
                            add_text(p, s.get("nameToken"))
                        if s.get("dateToken"):
                            p = cell.add_paragraph()
                            p.add_run("Date: ").bold = True
                            add_text(p, s.get("dateToken"))
                    doc.add_paragraph()  # spacing between signatory rows

        elif btype in ("image", "logo"):
            # Admin-uploaded images arrive as base64 data URLs embedded in the
            # template; decode and embed them. Fall back to a light text marker
            # for a missing/URL-only source.
            from docx.shared import Emu
            raw_img = _decode_data_url_image(b.get("src"))
            width_px = b.get("width") or 160
            emu_width = Emu(int(float(width_px) / 96 * 914400))  # 96 px/inch

            def _place_image(paragraph):
                if raw_img:
                    try:
                        paragraph.add_run().add_picture(BytesIO(raw_img), width=emu_width)
                        return
                    except Exception:
                        pass
                add_text(paragraph, _subst_tokens(b.get("alt", ""), values) or ("Logo" if btype == "logo" else "Image"), italic=True)

            side = b.get("float") or "none"
            if side in ("left", "right"):
                # Side-by-side: borderless 1×2 table — image in one cell, the
                # `beside` content in the other. This is the Word-native way to
                # place text alongside an image (docx has no CSS float/wrap).
                table = doc.add_table(rows=1, cols=2)
                _designer_clear_table_borders(table)
                img_mm = min(w_mm - margin.get("left", 18) - margin.get("right", 18) - 10,
                             max(10, float(width_px) / 96 * 25.4))
                img_cell, text_cell = table.rows[0].cells
                if side == "right":
                    img_cell, text_cell = text_cell, img_cell
                img_cell.width = Mm(img_mm)
                _place_image(img_cell.paragraphs[0])
                add_text(text_cell.paragraphs[0], b.get("beside", ""))
            else:
                p = doc.add_paragraph()
                p.alignment = align
                _place_image(p)

    buf = BytesIO()
    doc.save(buf)
    return buf.getvalue()


def generate_designer_pdf(design, values) -> bytes:
    """Render a designer document directly with ReportLab, without LibreOffice."""
    if isinstance((design or {}).get("pages"), list) and design.get("pages"):
        return _generate_designer_pdf_v2(design, values)

    from xml.sax.saxutils import escape as xml_escape
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_JUSTIFY, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4, letter, legal, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.platypus import (
        HRFlowable, Image as RLImage, PageBreak, Paragraph, SimpleDocTemplate,
        Spacer, Table, TableStyle,
    )

    design = design or {}
    theme = design.get("theme") or {}
    page = design.get("page") or {}
    blocks = design.get("blocks") or []
    if not blocks and isinstance(design.get("pages"), list) and design["pages"]:
        blocks = _design_pages_to_legacy_blocks(design)

    page_size = {"A4": A4, "Letter": letter, "Legal": legal}.get(page.get("size", "A4"), A4)
    if page.get("orientation") == "landscape":
        page_size = landscape(page_size)
    margin = page.get("margin") or {}
    left = float(margin.get("left", 18)) * mm
    right = float(margin.get("right", 18)) * mm
    top = float(margin.get("top", 20)) * mm
    bottom = float(margin.get("bottom", 20)) * mm
    content_width = page_size[0] - left - right

    def color(value, fallback):
        candidate = str(value or fallback).lstrip("#")
        if len(candidate) != 6:
            candidate = fallback.lstrip("#")
        try:
            return colors.HexColor(f"#{candidate}")
        except (TypeError, ValueError):
            return colors.HexColor(f"#{fallback.lstrip('#')}")

    body_color = color(theme.get("textColor"), "1F2933")
    heading_color = color(theme.get("headingColor"), "0F2A3A")
    accent_color = color(theme.get("accentColor"), "287EAD")
    px_to_pt = lambda value, fallback: max(8, round(float(value) * 0.75)) if value else fallback
    styles = getSampleStyleSheet()
    body_style = ParagraphStyle(
        "DesignerBody", parent=styles["Normal"], fontName="Helvetica",
        fontSize=px_to_pt(theme.get("baseFontSize"), 10), textColor=body_color,
        leading=px_to_pt(theme.get("baseFontSize"), 10) * 1.3,
    )
    heading_style = ParagraphStyle(
        "DesignerHeading", parent=body_style, fontName="Helvetica-Bold",
        fontSize=14, leading=17, textColor=heading_color, spaceBefore=6, spaceAfter=4,
    )
    alignments = {"left": TA_LEFT, "center": TA_CENTER, "right": TA_RIGHT, "justify": TA_JUSTIFY}

    def para(text, style=None, **kwargs):
        rendered = xml_escape(_subst_tokens(text or "", values), {"'": "&#39;", '"': "&quot;"})
        rendered = rendered.replace("\n", "<br/>")
        return Paragraph(rendered, style or body_style, **kwargs)

    story = []
    for block in blocks:
        if not isinstance(block, dict):
            continue
        kind = block.get("type")
        alignment = alignments.get(block.get("align", "left"), TA_LEFT)
        if kind == "heading":
            level = int(block.get("level") or 2)
            size = px_to_pt(block.get("fontSize"), {1: 18, 2: 14, 3: 12}.get(level, 14))
            style = ParagraphStyle(
                f"DesignerH{level}", parent=heading_style, fontSize=size,
                leading=size * 1.2, alignment=alignment,
                textColor=color(block.get("color"), "0F2A3A"),
            )
            story.extend([para(block.get("text"), style), Spacer(1, 3)])
        elif kind in ("paragraph", "quote"):
            size = px_to_pt(block.get("fontSize"), body_style.fontSize)
            style = ParagraphStyle(
                "DesignerQuote" if kind == "quote" else "DesignerParagraph",
                parent=body_style,
                fontName=("Helvetica-BoldOblique" if block.get("bold") and (block.get("italic") or kind == "quote")
                          else "Helvetica-Bold" if block.get("bold")
                          else "Helvetica-Oblique" if block.get("italic") or kind == "quote"
                          else "Helvetica"),
                fontSize=size, leading=size * 1.3, alignment=alignment,
                textColor=color(block.get("color"), "1F2933"),
                spaceAfter=6,
            )
            story.append(para(block.get("text"), style))
        elif kind in ("bulleted_list", "numbered_list"):
            list_style = ParagraphStyle("DesignerList", parent=body_style, leftIndent=14, firstLineIndent=-10)
            for index, item in enumerate(block.get("items") or [], start=1):
                bullet = "•" if kind == "bulleted_list" else f"{index}."
                story.append(para(item, list_style, bulletText=bullet))
        elif kind == "key_value":
            rows = []
            for pair in block.get("pairs") or []:
                label = para(pair.get("label", ""), ParagraphStyle("KVLabel", parent=body_style, fontName="Helvetica-Bold"))
                value = para(pair.get("value", ""))
                rows.append([label, value])
            if rows:
                label_width = min(45 * mm, content_width * 0.4)
                table = Table(rows, colWidths=[label_width, content_width - label_width], hAlign="LEFT")
                table.setStyle(TableStyle([
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 4),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                    ("TOPPADDING", (0, 0), (-1, -1), 4),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ]))
                story.extend([table, Spacer(1, 6)])
        elif kind == "data_table":
            columns = block.get("columns") or []
            if columns:
                if block.get("bound"):
                    source = values.get(block.get("sourceKey") or "")
                    rows = [
                        [record.get(column.get("key", ""), "") for column in columns]
                        for record in source if isinstance(record, dict)
                    ] if isinstance(source, list) else []
                    if not rows:
                        rows = [[""] * len(columns) for _ in range(max(1, int(block.get("fillRows") or 3)))]
                else:
                    rows = block.get("rows") or []
                data = [[para(column.get("label", ""), ParagraphStyle("TableHeader", parent=body_style, fontName="Helvetica-Bold", textColor=colors.white)) for column in columns]]
                data.extend([
                    [para(cell) for cell in (row if isinstance(row, list) else [])[:len(columns)]]
                    + [para("")] * max(0, len(columns) - len(row if isinstance(row, list) else []))
                    for row in rows
                ])
                table = Table(data, colWidths=[content_width / len(columns)] * len(columns), repeatRows=1, hAlign="LEFT")
                table.setStyle(TableStyle([
                    ("BACKGROUND", (0, 0), (-1, 0), accent_color),
                    ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#CBD5E1")),
                    ("VALIGN", (0, 0), (-1, -1), "TOP"),
                    ("LEFTPADDING", (0, 0), (-1, -1), 5),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                    ("TOPPADDING", (0, 0), (-1, -1), 5),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ]))
                story.extend([table, Spacer(1, 8)])
        elif kind == "two_column":
            table = Table([[para(block.get("left", "")), para(block.get("right", ""))]], colWidths=[content_width / 2] * 2)
            table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 4)]))
            story.extend([table, Spacer(1, 6)])
        elif kind == "divider":
            story.extend([HRFlowable(width="100%", thickness=0.7, color=color(block.get("color"), "C8CDD2")), Spacer(1, 5)])
        elif kind == "spacer":
            story.append(Spacer(1, max(0, float(block.get("height", 24))) * 0.75))
        elif kind == "page_break":
            story.append(PageBreak())
        elif kind == "signature":
            signatories = block.get("signatories") or []
            if signatories:
                rows = []
                for start in range(0, len(signatories), 3):
                    row = []
                    for signatory in signatories[start:start + 3]:
                        lines = [para(signatory.get("role", ""), heading_style), Spacer(1, 20), para("_______________________"), para("Signature")]
                        if signatory.get("nameToken"):
                            lines.append(para(f"Name: {signatory['nameToken']}"))
                        if signatory.get("dateToken"):
                            lines.append(para(f"Date: {signatory['dateToken']}"))
                        row.append(lines)
                    rows.append(row + [[]] * (3 - len(row)))
                table = Table(rows, colWidths=[content_width / 3] * 3)
                table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP")]))
                story.extend([table, Spacer(1, 8)])
        elif kind in ("image", "logo"):
            raw = _decode_data_url_image(block.get("src"))
            if raw:
                try:
                    image = RLImage(BytesIO(raw))
                    width = min(float(block.get("width") or 160) * 0.75, 120 * mm)
                    ratio = image.imageHeight / max(image.imageWidth, 1)
                    image.drawWidth, image.drawHeight = width, width * ratio
                    story.append(image)
                except Exception:
                    story.append(para(block.get("alt") or "Image", body_style))
            else:
                story.append(para(block.get("alt") or ("Logo" if kind == "logo" else "Image"), body_style))

    header = _design_band_to_legacy(design.get("header"))
    footer = _design_band_to_legacy(design.get("footer"))

    def draw_band(canv, band, y):
        if not band.get("enabled"):
            return
        content = band.get("content") or {}
        canv.saveState()
        canv.setFillColor(body_color)
        canv.setFont("Helvetica", 8)
        width, _height = page_size
        for slot, x, align in (("left", left, "left"), ("center", width / 2, "center"), ("right", width - right, "right")):
            text = _subst_tokens(content.get(slot, ""), {**values, "page": canv.getPageNumber(), "pages": ""})
            if align == "center":
                canv.drawCentredString(x, y, text)
            elif align == "right":
                canv.drawRightString(x, y, text)
            else:
                canv.drawString(x, y, text)
        canv.restoreState()

    def on_page(canv, _doc):
        draw_band(canv, header, page_size[1] - 10 * mm)
        draw_band(canv, footer, 8 * mm)

    buf = BytesIO()
    pdf = SimpleDocTemplate(buf, pagesize=page_size, leftMargin=left, rightMargin=right, topMargin=top, bottomMargin=bottom)
    pdf.build(story or [Spacer(1, 1)], onFirstPage=on_page, onLaterPages=on_page)
    return buf.getvalue()


def _generate_designer_pdf_v2(design, values) -> bytes:
    """Render v2 page rows and columns without flattening the designer layout."""
    from xml.sax.saxutils import escape as xml_escape
    from reportlab.lib import colors
    from reportlab.lib.enums import TA_CENTER, TA_LEFT, TA_RIGHT
    from reportlab.lib.pagesizes import A4, letter, legal, landscape
    from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
    from reportlab.lib.units import mm
    from reportlab.lib.utils import ImageReader
    from reportlab.platypus import (
        HRFlowable, Image as RLImage, KeepTogether, PageBreak, Paragraph,
        SimpleDocTemplate, Spacer, Table, TableStyle,
    )

    page = design.get("page") or {}
    theme = design.get("theme") or {}
    pages = design.get("pages") or []
    page_size = {"A4": A4, "Letter": letter, "Legal": legal}.get(page.get("size", "A4"), A4)
    if page.get("orientation") == "landscape":
        page_size = landscape(page_size)
    margin = page.get("margin") or {}
    left = float(margin.get("left", 18)) * mm
    right = float(margin.get("right", 18)) * mm
    top = float(margin.get("top", 20)) * mm
    bottom = float(margin.get("bottom", 20)) * mm
    content_width = page_size[0] - left - right
    styles = getSampleStyleSheet()
    text_color = colors.HexColor(str(theme.get("textColor", "#1F2933")))
    heading_color = colors.HexColor(str(theme.get("headingColor", "#0F2A3A")))
    accent = colors.HexColor(str(theme.get("accentColor", "#287EAD")))
    base_size = max(8, round(float(theme.get("baseFontSize", 13)) * .75))
    align_map = {"left": TA_LEFT, "center": TA_CENTER, "right": TA_RIGHT}

    def as_color(value, fallback):
        fallback_color = fallback if isinstance(fallback, colors.Color) else colors.HexColor(str(fallback))
        if not value:
            return fallback_color
        try:
            return colors.HexColor(str(value))
        except (TypeError, ValueError):
            return fallback_color

    def para(raw, *, style=None, element=None):
        element = element or {}
        estyle = element.get("style") or {}
        size = max(7, round(float(estyle.get("fontSize", base_size / .75)) * .75))
        bold, italic = bool(estyle.get("bold")), bool(estyle.get("italic"))
        font = "Helvetica-BoldOblique" if bold and italic else "Helvetica-Bold" if bold else "Helvetica-Oblique" if italic else "Helvetica"
        if style is None:
            style = ParagraphStyle(
                "DesignerV2", parent=styles["Normal"], fontName=font,
                fontSize=size, leading=size * float(theme.get("lineHeight", 1.25)),
                textColor=as_color(estyle.get("color"), text_color),
                alignment=align_map.get(estyle.get("textAlign"), TA_LEFT),
                spaceBefore=float(estyle.get("marginTop", 0)) * .75,
                spaceAfter=float(estyle.get("marginBottom", 2)) * .75,
            )
        rendered = xml_escape(_subst_tokens(str(raw or ""), values), {"'": "&#39;", '"': "&quot;"}).replace("\n", "<br/>")
        if estyle.get("underline"):
            rendered = f"<u>{rendered}</u>"
        return Paragraph(rendered or "&#160;", style)

    def render_element(element, available_width):
        kind = element.get("type")
        style = element.get("style") or {}
        if kind in ("text", "note", "heading"):
            text = element.get("text", "")
            if kind == "heading":
                level = int(element.get("level") or 2)
                size = max(9, round(float(style.get("fontSize", {1: 24, 2: 18, 3: 16}.get(level, 18))) * .75))
                pstyle = ParagraphStyle(
                    f"DesignerV2Heading{level}", parent=styles["Normal"], fontName="Helvetica-Bold",
                    fontSize=size, leading=size * 1.2, textColor=as_color(style.get("color"), heading_color),
                    alignment=align_map.get(style.get("textAlign"), TA_LEFT),
                    spaceBefore=float(style.get("marginTop", 0)) * .75,
                    spaceAfter=float(style.get("marginBottom", 4)) * .75,
                )
                return [para(text, style=pstyle)]
            return [para(text, element=element)]
        if kind == "field_group":
            fields = element.get("fields") or []
            label_width = min(float(element.get("labelWidth") or 120) * .75, available_width * .45)
            rows = [[para(field.get("label", ""), element={"style": {"bold": bool(field.get("boldLabel"))}}),
                     para(field.get("value", ""), element={"style": {"bold": bool(field.get("boldValue"))}})] for field in fields]
            table = Table(rows, colWidths=[label_width, max(10, available_width - label_width)], hAlign="LEFT")
            table.setStyle(TableStyle([("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 4), ("TOPPADDING", (0, 0), (-1, -1), 2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2)]))
            return [table]
        if kind == "data_table":
            columns = element.get("columns") or []
            if not columns:
                return []
            source = values.get(element.get("sourceKey") or "")
            rows = [[record.get(column.get("key", ""), "") for column in columns] for record in source if isinstance(record, dict)] if isinstance(source, list) else []
            if not rows and not element.get("sourceKey"):
                rows = element.get("staticRows") or []
            if not rows and element.get("sourceKey"):
                rows = [[""] * len(columns) for _ in range(max(1, int(element.get("previewRows") or 2)))]
            widths = [available_width * max(1, float(column.get("width") or 1)) / sum(max(1, float(c.get("width") or 1)) for c in columns) for column in columns]
            header_bg = as_color(element.get("headerBackground"), accent)
            header_color = as_color(element.get("headerColor"), "#FFFFFF")
            header_style = ParagraphStyle("DesignerV2TableHeader", parent=styles["Normal"], fontName="Helvetica-Bold", fontSize=max(7, base_size - 1), leading=base_size, textColor=header_color)
            data = [[para(column.get("label", ""), style=header_style) for column in columns]]
            data.extend([[para(row[i] if i < len(row) else "") for i in range(len(columns))] for row in rows])
            summaries = element.get("summaries") or []
            summary_spans = []
            for summary in summaries:
                values_for_summary = summary.get("values") or []
                default_span = max(1, len(columns) - len(values_for_summary))
                span = max(1, min(len(columns), int(summary.get("labelSpan") or default_span)))
                summary_row = [para(summary.get("label", ""), element={"style": {"bold": bool(summary.get("bold", True)), "textAlign": "right"}})]
                if span > 1:
                    summary_row.extend([""] * (span - 1))
                summary_row.extend(para(value, element={"style": {"bold": bool(summary.get("bold", True))}}) for value in values_for_summary)
                summary_row.extend([""] * max(0, len(columns) - len(summary_row)))
                data.append(summary_row[:len(columns)])
                summary_spans.append((len(data) - 1, span))
            table = Table(data, colWidths=widths, repeatRows=1, hAlign="LEFT")
            pad = max(1, float(element.get("cellPadding", 4)) * .75)
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), header_bg),
                ("TEXTCOLOR", (0, 0), (-1, 0), header_color),
                ("GRID", (0, 0), (-1, -1), float((element.get("style") or {}).get("borderWidth", 1)) * .35, as_color((element.get("style") or {}).get("borderColor"), "#475569")),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), pad), ("RIGHTPADDING", (0, 0), (-1, -1), pad),
                ("TOPPADDING", (0, 0), (-1, -1), pad), ("BOTTOMPADDING", (0, 0), (-1, -1), pad),
            ] + [("SPAN", (0, row_index), (span - 1, row_index)) for row_index, span in summary_spans if span > 1]))
            return [table]
        if kind in ("bulleted_list", "numbered_list"):
            mark = "•" if kind == "bulleted_list" else None
            return [Paragraph(xml_escape(_subst_tokens(str(item), values)), styles["Normal"], bulletText=mark) for item in (element.get("items") or [])]
        if kind in ("image", "logo"):
            raw = _decode_data_url_image(element.get("src"))
            if raw:
                image = RLImage(BytesIO(raw))
                max_width = min(float(element.get("width") or 120) * .75, available_width)
                ratio = image.imageHeight / max(image.imageWidth, 1)
                image.drawWidth, image.drawHeight = max_width, max_width * ratio
                return [image]
            return [para(element.get("alt") or "")]
        if kind == "signature_group":
            signatures = element.get("signatories") or []
            rows = []
            for signature in signatures:
                role = f"{signature.get('step')}. " if signature.get("step") else ""
                rows.append([para(role + str(signature.get("role") or ""), element={"style": {"bold": True}}), para(""), para("")])
                rows.append([para(_subst_tokens(str(signature.get("name") or ""), values)), para(""), para("Date: " + _subst_tokens(str(signature.get("date") or ""), values))])
            if not rows:
                return []
            table = Table(rows, colWidths=[available_width * .42, available_width * .12, available_width * .46])
            table.setStyle(TableStyle([("SPAN", (0, i), (2, i)) for i in range(0, len(rows), 2)] + [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), 2), ("RIGHTPADDING", (0, 0), (-1, -1), 2)]))
            return [table]
        if kind == "divider":
            return [HRFlowable(width="100%", thickness=float(style.get("borderWidth", 1)), color=as_color(style.get("borderColor"), "#94A3B8"))]
        if kind in ("spacer", "box"):
            return [Spacer(1, float(element.get("height") or style.get("minHeight") or 12) * .75)]
        return []

    story = []
    for page_index, page_spec in enumerate(pages):
        if page_index:
            story.append(PageBreak())
        for row in page_spec.get("rows") or []:
            cells = row.get("columns") or []
            if not cells:
                continue
            row_gap = float(row.get("gap", 0)) * .75
            weights = [max(1, float(cell.get("width") or 1)) for cell in cells]
            gaps_total = row_gap * (len(cells) - 1)
            widths = [(content_width - gaps_total) * weight / sum(weights) for weight in weights]
            rendered_cells = []
            for cell, width in zip(cells, widths):
                flowables = []
                for element in cell.get("elements") or []:
                    flowables.extend(render_element(element, width))
                rendered_cells.append(flowables or [Spacer(1, 1)])
            table = Table([rendered_cells], colWidths=widths, hAlign="LEFT")
            commands = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LEFTPADDING", (0, 0), (-1, -1), row_gap / 2), ("RIGHTPADDING", (0, 0), (-1, -1), row_gap / 2)]
            for index, cell in enumerate(cells):
                valign = {"center": "MIDDLE", "end": "BOTTOM"}.get(cell.get("verticalAlign"), "TOP")
                commands.append(("VALIGN", (index, 0), (index, 0), valign))
                pad = float(cell.get("padding", 0)) * .75
                commands.extend([("TOPPADDING", (index, 0), (index, 0), pad), ("BOTTOMPADDING", (index, 0), (index, 0), pad)])
                if cell.get("background"):
                    commands.append(("BACKGROUND", (index, 0), (index, 0), as_color(cell.get("background"), "#FFFFFF")))
                if cell.get("borderWidth"):
                    bw = float(cell.get("borderWidth")) * .5
                    bc = as_color(cell.get("borderColor"), "#CBD5E1")
                    commands.extend((edge, (index, 0), (index, 0), bw, bc) for edge in ("BOX",))
            table.setStyle(TableStyle(commands))
            if row.get("marginTop"):
                story.append(Spacer(1, float(row["marginTop"]) * .75))
            story.append(KeepTogether(table) if row.get("keepTogether") else table)
            if row.get("marginBottom"):
                story.append(Spacer(1, float(row["marginBottom"]) * .75))

    def band_row_heights(band):
        if not band or not band.get("enabled"):
            return []
        heights = []
        for row in band.get("rows") or []:
            cells = row.get("columns") or []
            weights = [max(1, float(cell.get("width") or 1)) for cell in cells]
            cell_widths = [content_width * weight / max(1, sum(weights)) for weight in weights]
            row_height = max(float(row.get("minHeight") or 12) * .75, 12)
            for cell, cell_width in zip(cells, cell_widths):
                for element in cell.get("elements") or []:
                    kind = element.get("type")
                    if kind in ("text", "note", "heading"):
                        raw = _subst_tokens(str(element.get("text") or ""), {**values, "page": 1, "pages": len(pages)})
                        style = element.get("style") or {}
                        font_size = max(6, float(style.get("fontSize", 10)) * .75)
                        font = "Helvetica-Bold" if kind == "heading" or style.get("bold") else "Helvetica"
                        text_style = ParagraphStyle(
                            "BandMeasure", parent=styles["Normal"], fontName=font,
                            fontSize=font_size, leading=font_size * 1.15,
                            textColor=as_color(style.get("color"), text_color),
                            alignment=align_map.get(style.get("textAlign"), TA_CENTER),
                        )
                        paragraph = Paragraph(xml_escape(raw).replace("\n", "<br/>"), text_style)
                        _, height = paragraph.wrap(max(1, cell_width - 4), 10000)
                        row_height = max(row_height, height + 4)
                    elif kind in ("image", "logo"):
                        image_data = _decode_data_url_image(element.get("src"))
                        if image_data:
                            reader = ImageReader(BytesIO(image_data))
                            image_width, image_height = reader.getSize()
                            width = min(float(element.get("width") or 80) * .75, 60, max(1, cell_width - 4))
                            row_height = max(row_height, width * image_height / max(image_width, 1) + 4)
            heights.append(row_height)
        return heights

    def draw_band(canv, band, y_top, *, border_below=False):
        if not band or not band.get("enabled"):
            return
        canv.saveState()
        usable = content_width
        y = y_top
        logo_widths = {}
        row_heights = band_row_heights(band)
        for row, row_height in zip(band.get("rows") or [], row_heights):
            cells = row.get("columns") or []
            weights = [max(1, float(cell.get("width") or 1)) for cell in cells]
            x = left
            for cell, weight in zip(cells, weights):
                cell_width = usable * weight / max(1, sum(weights))
                for element in cell.get("elements") or []:
                    kind = element.get("type")
                    if kind in ("text", "note", "heading"):
                        raw = _subst_tokens(str(element.get("text") or ""), {**values, "page": canv.getPageNumber(), "pages": len(pages)})
                        font_size = max(6, float((element.get("style") or {}).get("fontSize", 10)) * .75)
                        style = element.get("style") or {}
                        font = "Helvetica-Bold" if kind == "heading" or style.get("bold") else "Helvetica"
                        text_style = ParagraphStyle(
                            "BandText", parent=styles["Normal"], fontName=font,
                            fontSize=font_size, leading=font_size * 1.15,
                            textColor=as_color(style.get("color"), text_color),
                            alignment=align_map.get(style.get("textAlign"), TA_CENTER),
                        )
                        paragraph = Paragraph(xml_escape(raw).replace("\n", "<br/>"), text_style)
                        _, text_height = paragraph.wrap(max(1, cell_width - 4), row_height)
                        paragraph.drawOn(canv, x + 2, y - text_height + 2)
                    elif kind in ("image", "logo"):
                        raw = _decode_data_url_image(element.get("src"))
                        if raw:
                            source_key = element.get("src") or ""
                            width = logo_widths.setdefault(source_key, min(float(element.get("width") or 80) * .75, 60))
                            width = min(width, max(1, cell_width - 4))
                            image = ImageReader(BytesIO(raw))
                            iw, ih = image.getSize()
                            height = width * ih / max(iw, 1)
                            canv.drawImage(image, x + (cell_width - width) / 2, y - height, width=width, height=height, preserveAspectRatio=True, mask="auto")
                x += cell_width
            y -= row_height
        if band.get("border"):
            canv.setStrokeColor(accent)
            canv.setLineWidth(.6)
            border_y = y - 4 if border_below else y_top - 4
            canv.line(left, border_y, page_size[0] - right, border_y)
        canv.restoreState()

    header, footer = design.get("header") or {}, design.get("footer") or {}
    if header.get("enabled"):
        # Keep body content below the actual logo/text height, with a small gap.
        top = max(top, 8 * mm + sum(band_row_heights(header)) + 8 * mm)

    def on_page(canv, _doc):
        watermark = design.get("watermark") or {}
        if watermark.get("enabled") and watermark.get("value"):
            canv.saveState()
            try:
                opacity = float(watermark.get("opacity", .15))
                canv.setFillAlpha(opacity / 100 if opacity > 1 else opacity)
            except (AttributeError, TypeError, ValueError):
                pass
            canv.translate(page_size[0] / 2, page_size[1] / 2)
            canv.rotate(float(watermark.get("rotation", -25)))
            mark = _subst_tokens(str(watermark["value"]), values)
            if watermark.get("kind") == "image":
                raw = _decode_data_url_image(mark)
                if raw:
                    image = ImageReader(BytesIO(raw))
                    width = min(float(watermark.get("width", 500)) * .75, page_size[0] * .8)
                    iw, ih = image.getSize()
                    height = width * ih / max(iw, 1)
                    canv.drawImage(image, -width / 2, -height / 2, width=width, height=height, preserveAspectRatio=True, mask="auto")
            else:
                canv.setFillColor(accent)
                canv.setFont("Helvetica-Bold", min(48, page_size[0] / 9))
                canv.drawCentredString(0, 0, mark)
            canv.restoreState()
        draw_band(canv, header, page_size[1] - 8 * mm, border_below=True)
        draw_band(canv, footer, 12 * mm)

    buffer = BytesIO()
    pdf = SimpleDocTemplate(buffer, pagesize=page_size, leftMargin=left, rightMargin=right, topMargin=top, bottomMargin=bottom)
    pdf.build(story or [Spacer(1, 1)], onFirstPage=on_page, onLaterPages=on_page)
    return buffer.getvalue()


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


def _replace_placeholder_in_pptx_paragraph(para, values: dict):
    """
    Replace {{key}} placeholders in a python-pptx paragraph, stitching text
    across runs (PowerPoint, like Word, often splits a placeholder over several
    runs). The merged text is written back into the first run; the rest cleared.
    """
    runs = para.runs
    if not runs:
        return
    full_text = "".join(run.text for run in runs)
    if "{{" not in full_text:
        return

    def replacer(match):
        val = values.get(match.group(1))
        return "" if val is None else str(val)

    new_text = re.sub(r"\{\{([a-zA-Z0-9_]+)\}\}", replacer, full_text)
    if new_text == full_text:
        return
    runs[0].text = new_text
    for run in runs[1:]:
        run.text = ""


def fill_pptx_template(template, values) -> bytes:
    """Fill an uploaded PPTX template with placeholder values."""
    from pptx import Presentation

    prs = Presentation(template.file.path)
    for slide in prs.slides:
        for shape in slide.shapes:
            if shape.has_text_frame:
                for para in shape.text_frame.paragraphs:
                    _replace_placeholder_in_pptx_paragraph(para, values)
            if shape.has_table:
                for row in shape.table.rows:
                    for cell in row.cells:
                        for para in cell.text_frame.paragraphs:
                            _replace_placeholder_in_pptx_paragraph(para, values)

    buf = BytesIO()
    prs.save(buf)
    return buf.getvalue()


def pptx_to_pdf(pptx_bytes: bytes) -> bytes:
    """Convert PPTX to PDF using LibreOffice headless."""
    from apps.documents.tasks import _convert_office_source_to_pdf_bytes

    with tempfile.NamedTemporaryFile(suffix=".pptx", delete=False) as f:
        f.write(pptx_bytes)
        tmp_path = f.name
    try:
        return _convert_office_source_to_pdf_bytes(
            Path(tmp_path), soffice_bin="libreoffice", timeout=60
        )
    finally:
        os.unlink(tmp_path)


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

def generate_document_from_template_sync(template, values, fmt, title, user, type_id, reference_number=None):
    """Generate a document from a template synchronously.

    ``reference_number`` lets a caller that must know the number *before*
    rendering (e.g. the LPO generator embedding it in the document body) reserve
    it up front instead of having one issued inside this function.
    """
    from apps.documents.models import Document, DocumentStatus
    from apps.documents.serializers import _generate_unique_reference
    from apps.documents.form_attachments import descriptors_to_names
    from apps.documents.form_formulas import apply_formulas
    from django.core.files.base import ContentFile
    import hashlib

    is_xlsx = template.file_name.endswith((".xlsx", ".xls")) if template.file_name else False
    is_pptx = template.file_name.endswith((".pptx", ".ppt")) if template.file_name else False
    kind = getattr(template, "kind", "form") or "form"

    # Reserve the reference up front so a `reference_number` formula can use it.
    reference_number = reference_number or _generate_unique_reference(template.document_type)

    if template.type == "built" and kind == "document":
        # WYSIWYG document designer: merge fields auto-populate from the user,
        # date, reference and the document-type metadata — the user fills no
        # placeholders. Render the block layout to an editable DOCX (or PDF on
        # request) so the result follows the normal Office lifecycle.
        merge_values = _designer_merge_values(
            values, user=user, reference_number=reference_number, title=title
        )
        render_values = descriptors_to_names(merge_values)
        if fmt == "pdf":
            content = generate_designer_pdf(template.design, render_values)
            filename = f"{title}.pdf"
            content_type = "application/pdf"
        else:
            docx_content = generate_designer_docx(template.design, render_values)
            content = docx_content
            filename = f"{title}.docx"
            content_type = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"

    elif template.type == "built":
        # Only the sections that are actually part of this form (normal plus
        # the on-demand blocks in `__sections_added`) drive formulas, calc and
        # the rendered file. Linked tables are materialised here from their
        # snapshots, so the generators only ever see plain tables.
        from apps.templates_engine.blocks import effective_sections, prune_inactive_values

        values = prune_inactive_values(template.sections, values)
        eff = effective_sections(template.sections, values)
        # Freeze auto-fill formula values authoritatively (creator, submit time,
        # assigned reference) into the stored form values.
        values = apply_formulas(
            values, eff, user=user, reference_number=reference_number
        )
        # Freeze calculated fields (e.g. "total_days * daily_rate") the same
        # way — computed server-side from the (now formula-frozen) values so
        # the stored document and the rendered file always agree, regardless
        # of what the client last had on screen.
        from apps.templates_engine.conditions import compute_calculated_values
        values = compute_calculated_values(eff, values)
        # The stored form.values keeps structured attachment descriptors and
        # reference {id,label} objects; the rendered file shows display strings.
        render_values = descriptors_to_names(values)
        if fmt == "pdf":
            content = generate_built_pdf(template, render_values, sections=eff)
            filename = f"{title}.pdf"
            content_type = "application/pdf"
        else:
            content = generate_built_docx(template, render_values, sections=eff)
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
        elif is_pptx:
            pptx_content = fill_pptx_template(template, values)
            if fmt == "pdf":
                content = pptx_to_pdf(pptx_content)
                filename = f"{title}.pdf"
                content_type = "application/pdf"
            else:
                content = pptx_content
                filename = f"{title}.pptx"
                content_type = "application/vnd.openxmlformats-officedocument.presentationml.presentation"
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

    doc_metadata = {
        "template_id": str(template.id),
        "template_name": template.name,
        **_form_values_for_metadata(values),
    }
    if template.type == "built" and kind == "form":
        # Built FORM templates are interactive forms: store the schema snapshot +
        # the entered values so the document IS the filled form and can be
        # re-rendered / edited in-app (no external editor). The generated file is
        # just a view. Designer ("document") templates render a static editable
        # file instead and follow the normal Office lifecycle — no form snapshot.
        doc_metadata["form"] = {
            "template_id": str(template.id),
            "workflow_type": template.workflow_type,
            # Procurement stage gating config, snapshotted so runtime decisions
            # survive later template edits (see is_travel_requisition).
            "requisition_type_field": getattr(template, "requisition_type_field", "") or "",
            "travel_type_value": getattr(template, "travel_type_value", "Travel") or "Travel",
            "sections": template.sections,
            "values": values,
        }
        # Snapshot the SunSystems integration mapping (journal/budget) onto the
        # document so budget checks and journal posting depend on the document
        # alone and survive later template edits. See apps/sunsystems/config.py.
        ss_mapping = getattr(template, "sunsystems", None)
        if isinstance(ss_mapping, dict) and ss_mapping:
            doc_metadata["sunsystems"] = ss_mapping

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
