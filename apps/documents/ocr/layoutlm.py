"""
apps/documents/ocr/layoutlm.py  — v2

LayoutLMv3 inference module.

Changes from v1
───────────────
BUG FIXES
  • _get_layoutlm_extractor(): the outer guard `if _layoutlm_available is False`
    was present, but the inner lock block was missing the re-check after acquiring
    the lock.  Two threads racing on first call could both enter the
    initialisation block, downloading the model twice and leaving one thread
    with a stale reference.  Fixed with full double-checked locking.

  • LayoutLMExtractor.extract(): boxes were clamped with
      `if x2 <= x1: x2 = x1 + 1`
    but x1 and x2 were already clamped to 1000 BEFORE the check, so a word
    at the far right edge of the image (x1 = 1000) got x2 = 1000 and then
    x2 = 1001 — which is out-of-range for LayoutLM's 0-1000 coordinate space
    and caused silent inference errors.  Fixed: clamp AFTER degenerate-box
    correction, not before.

  • _decode_bio(): the "broken sequence" branch treated any I-* label that
    followed an O or a different B-* field as a new entity start, but only
    when the label started with "I-".  This caused multi-word field values
    on poorly-tokenised documents (e.g. "ACME\nLIMITED") to be split into
    two separate entities with the second one discarded (because its
    avg_conf was fine but _flush() had already cleared current_field).
    Fixed: the broken-sequence branch now starts a new field for I-* labels
    even when current_field is None.

  • _map_entities_to_fields(): when two raw labels mapped to the same
    canonical field (e.g. VENDOR_NAME and SUPPLIER both → "supplier"),
    the second one always won because the `if canonical not in out` guard
    was evaluated in iteration order, not confidence order.
    Fixed: keep the highest-confidence value per canonical field by
    checking entity confidence explicitly.

NEW: expanded label maps
  • All doc types now include QUANTITY, DESCRIPTION, UOM, UNIT_PRICE labels
    so admin-configured quantity/description/uom fields are populated by
    LayoutLM when the model detects them.
  • "delivery_note", "expense_claim", "quotation", "utility_bill", and
    "statement" doc types added (previously fell through to "general").
  • Admin field-map override now supports a wildcard "*" key applied to
    all doc types before the per-type override.

SETTINGS (additions)
  LAYOUTLMV3_ENABLED    bool  (default True)  — disable entirely to skip loading
  LAYOUTLMV3_MODEL      str   (default "Theivaprakasham/layoutlmv3-finetuned-invoice")
  LAYOUTLMV3_DEVICE     str   (default "auto")
  LAYOUTLMV3_CONFIDENCE float (default 0.85)  — entity acceptance threshold
  LAYOUTLMV3_MAX_LENGTH int   (default 512)
  LAYOUTLMV3_COMPILE    bool  (default False) — torch.compile on CUDA
  LAYOUTLMV3_FIELD_MAP  dict  — admin label overrides per doc type
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Optional, List, Dict, Any

import numpy as np
import torch
from django.conf import settings
from PIL import Image
from transformers import AutoProcessor, AutoModelForTokenClassification, LayoutLMForTokenClassification, LayoutLMTokenizer

logger = logging.getLogger(__name__)

# ── Singleton state ────────────────────────────────────────────────────────────

_layoutlm_extractor: Optional["LayoutLMExtractor"] = None
_layoutlm_lock       = threading.Lock()
_layoutlm_available: Optional[bool] = None


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class PageData:
    """One page image + the positioned words produced by the OCR engine."""
    image: Image.Image
    words: list[dict]   # {text, left, top, right, bottom, conf}


@dataclass
class _Entity:
    value:      str
    confidence: float
    raw_label:  str


# ── Public API ────────────────────────────────────────────────────────────────

def extract_with_layoutlm(pages_data: list['PageData'], doc_type: str = "general") -> dict:
    """
    Run LayoutLMv3 over one or more pages and return canonical field names.
    """
    extractor = _get_layoutlm_extractor()
    if extractor is None:
        return {}

    all_entities: dict[str, _Entity] = {}
    for page in pages_data:
        if not page.words:
            continue
        try:
            page_entities = extractor.extract(page.image, page.words)
            for label, ent in page_entities.items():
                if label not in all_entities or ent.confidence > all_entities[label].confidence:
                    all_entities[label] = ent
        except Exception:
            logger.exception("LayoutLMv3 extraction failed for a page")

    return _map_entities_to_fields(all_entities, doc_type)


# ── Model wrapper ─────────────────────────────────────────────────────────────

class LayoutLMExtractor:
    def __init__(self, processor, model, device: str):
        self.processor       = processor
        self.model           = model
        self.device          = device
        self.id2label        = model.config.id2label
        self.conf_threshold  = float(getattr(settings, "LAYOUTLMV3_CONFIDENCE", 0.85))
        self.max_length      = int(getattr(settings, "LAYOUTLMV3_MAX_LENGTH", 512))

    @classmethod
    def from_settings(cls) -> "LayoutLMExtractor":
        model_name = getattr(
            settings,
            "LAYOUTLMV3_MODEL",
            "Theivaprakasham/layoutlmv3-finetuned-invoice",
        )
        device_setting = getattr(settings, "LAYOUTLMV3_DEVICE", "auto")
        device = (
            ("cuda" if torch.cuda.is_available() else "cpu")
            if device_setting == "auto"
            else device_setting
        )

        logger.info("Loading LayoutLMv3 model %s on %s", model_name, device)
        processor = AutoProcessor.from_pretrained(model_name)
        model     = AutoModelForTokenClassification.from_pretrained(model_name)
        model.to(device)
        model.eval()

        if (
            hasattr(torch, "compile")
            and device.startswith("cuda")
            and getattr(settings, "LAYOUTLMV3_COMPILE", False)
        ):
            try:
                model = torch.compile(model, mode="reduce-overhead")
                logger.info("LayoutLMv3 torch.compile enabled")
            except Exception as exc:
                logger.warning("torch.compile failed: %s", exc)

        return cls(processor, model, device)

    def extract(self, image: Image.Image, words: list[dict]) -> dict[str, _Entity]:
        if not words:
            return {}

        width, height = image.size
        texts:  list[str]       = []
        boxes:  list[list[int]] = []

        for w in words:
            # v2 BUG FIX: clamp AFTER degenerate-box correction
            x1_raw = int(1000 * w.get("left",   0) / max(width,  1))
            y1_raw = int(1000 * w.get("top",    0) / max(height, 1))
            x2_raw = int(1000 * w.get("right",  w.get("left", 0) + w.get("width", 0)) / max(width,  1))
            y2_raw = int(1000 * w.get("bottom", w.get("top",  0) + w.get("height", 0)) / max(height, 1))

            # Fix degenerate boxes before clamping to 1000
            if x2_raw <= x1_raw:
                x2_raw = x1_raw + 1
            if y2_raw <= y1_raw:
                y2_raw = y1_raw + 1

            # Now clamp to valid LayoutLM range
            x1 = max(0, min(999, x1_raw))
            y1 = max(0, min(999, y1_raw))
            x2 = max(0, min(1000, x2_raw))
            y2 = max(0, min(1000, y2_raw))

            boxes.append([x1, y1, x2, y2])
            texts.append(w.get("text", ""))

        encoding = self.processor(
            images=image, 
            text=texts,
            boxes=boxes,
            return_tensors="pt",
            truncation=True,
            max_length=self.max_length,
            padding="max_length",
        )

        input_ids     = encoding["input_ids"].to(self.device)
        attention_mask = encoding["attention_mask"].to(self.device)
        bbox          = encoding["bbox"].to(self.device)
        pixel_values  = encoding["pixel_values"].to(self.device)

        with torch.no_grad():
            outputs = self.model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                bbox=bbox,
                pixel_values=pixel_values,
            )

        predictions = outputs.logits.argmax(dim=-1)[0].cpu().numpy()
        confidences = outputs.logits.softmax(dim=-1).max(dim=-1)[0][0].cpu().numpy()
        tokens      = self.processor.tokenizer.convert_ids_to_tokens(input_ids[0])
        attn        = attention_mask[0].cpu().numpy()

        return self._decode_bio(tokens, predictions, confidences, attn)

    def _decode_bio(
        self,
        tokens:      list[str],
        predictions: np.ndarray,
        confidences: np.ndarray,
        attn_mask:   np.ndarray,
    ) -> dict[str, _Entity]:
        id2label = self.id2label
        entities: dict[str, _Entity] = {}

        current_field:  Optional[str]   = None
        current_tokens: list[str]       = []
        current_confs:  list[float]     = []

        special = {
            self.processor.tokenizer.cls_token,
            self.processor.tokenizer.sep_token,
            self.processor.tokenizer.pad_token,
        }

        def _flush():
            nonlocal current_field, current_tokens, current_confs
            if current_field and current_tokens:
                avg_conf = float(np.mean(current_confs))
                raw = self.processor.tokenizer.convert_tokens_to_string(current_tokens)
                clean = (
                    raw.replace("▁", " ")
                    .replace("<s>", "")
                    .replace("</s>", "")
                    .strip()
                )
                logger.debug(
                    "LayoutLM: field=%s value='%s' conf=%.3f threshold=%.3f",
                    current_field, clean, avg_conf, self.conf_threshold,
                )
                if avg_conf >= self.conf_threshold and clean:
                    if (
                        current_field not in entities
                        or avg_conf > entities[current_field].confidence
                    ):
                        entities[current_field] = _Entity(
                            value=clean,
                            confidence=round(avg_conf, 4),
                            raw_label=current_field,
                        )
            current_field  = None
            current_tokens = []
            current_confs  = []

        for token, pred_id, conf in zip(tokens, predictions, attn_mask.__iter__()):
            # attn_mask is used to skip padding
            pass  # handled below

        for idx in range(len(tokens)):
            token   = tokens[idx]
            pred_id = int(predictions[idx])
            conf    = float(confidences[idx])
            attn    = int(attn_mask[idx])

            if attn == 0 or token in special:
                _flush()
                continue

            label = id2label.get(pred_id, "O")

            if label == "O":
                _flush()
                continue

            if label.startswith("B-"):
                _flush()
                current_field  = label[2:]
                current_tokens = [token]
                current_confs  = [conf]

            elif label.startswith("I-"):
                expected_field = label[2:]
                if current_field == expected_field:
                    # Continuation — append
                    current_tokens.append(token)
                    current_confs.append(conf)
                else:
                    # v2 BUG FIX: broken sequence — flush old and start new
                    # even when current_field is None (e.g. I-* after O)
                    _flush()
                    current_field  = expected_field
                    current_tokens = [token]
                    current_confs  = [conf]

            else:
                # Unexpected label format — flush and ignore
                _flush()

        _flush()
        return entities


# ── Singleton initialisation ───────────────────────────────────────────────────

def _get_layoutlm_extractor() -> Optional[LayoutLMExtractor]:
    global _layoutlm_extractor, _layoutlm_available

    # Fast path
    if _layoutlm_available is False:
        return None
    if _layoutlm_available is True and _layoutlm_extractor is not None:
        return _layoutlm_extractor

    with _layoutlm_lock:
        # v2 BUG FIX: re-check inside lock (double-checked locking)
        if _layoutlm_available is False:
            return None
        if _layoutlm_extractor is not None:
            return _layoutlm_extractor

        if not getattr(settings, "LAYOUTLMV3_ENABLED", True):
            _layoutlm_available = False
            return None

        try:
            _layoutlm_extractor = LayoutLMExtractor.from_settings()
            _layoutlm_available = True
            return _layoutlm_extractor
        except Exception as exc:
            logger.warning("LayoutLMv3 unavailable: %s", exc)
            _layoutlm_available = False
            return None


# ── Label mapping ─────────────────────────────────────────────────────────────

# Raw LayoutLM label → canonical extractor key, per document type.
# v2: expanded with quantity, description, uom and additional doc types.
_LABEL_MAP: dict[str, dict[str, str]] = {
    "invoice": {
        "INVOICE_NUMBER":   "reference_number",
        "INVOICE_DATE":     "document_date",
        "DATE":             "document_date",
        "DUE_DATE":         "due_date",
        "PAYMENT_DATE":     "due_date",
        "TOTAL":            "amount",
        "TOTAL_AMOUNT":     "amount",
        "GRAND_TOTAL":      "amount",
        "AMOUNT_DUE":       "amount",
        "SUBTOTAL":         "subtotal",
        "TAX":              "tax_amount",
        "VAT":              "tax_amount",
        "GST":              "tax_amount",
        "VENDOR_NAME":      "supplier",
        "SUPPLIER":         "supplier",
        "BILLER":           "supplier",
        "COMPANY_NAME":     "supplier",
        "ACCOUNT_CODE":     "account_code",
        "GL_CODE":          "account_code",
        "CURRENCY":         "currency",
        "PAYMENT_TERMS":    "payment_terms",
        "PO_REFERENCE":     "po_reference",
        "VENDOR_CODE":      "vendor_code",
        # v2 NEW
        "QUANTITY":         "quantity",
        "QTY":              "quantity",
        "DESCRIPTION":      "description",
        "PARTICULARS":      "description",
        "UOM":              "uom",
        "UNIT":             "uom",
        "UNIT_PRICE":       "unit_price",
    },
    "purchase_order": {
        "PO_NUMBER":        "reference_number",
        "ORDER_NUMBER":     "reference_number",
        "LPO_NUMBER":       "reference_number",
        "DATE":             "document_date",
        "ORDER_DATE":       "document_date",
        "DELIVERY_DATE":    "delivery_date",
        "TOTAL":            "amount",
        "VENDOR_NAME":      "supplier",
        "SUPPLIER":         "supplier",
        "VENDOR_CODE":      "vendor_code",
        "APPROVED_BY":      "approved_by",
        "ACCOUNT_CODE":     "account_code",
        "COST_CENTRE":      "cost_centre",
        "QUANTITY":         "quantity",
        "QTY":              "quantity",
        "DESCRIPTION":      "description",
        "UOM":              "uom",
        "UNIT":             "uom",
    },
    "receipt": {
        "RECEIPT_NUMBER":   "reference_number",
        "DATE":             "document_date",
        "TOTAL":            "amount",
        "VENDOR_NAME":      "supplier",
        "SUPPLIER":         "supplier",
        "PAYMENT_METHOD":   "payment_method",
        "TXN_REF":          "transaction_ref",
        "MPESA_REF":        "transaction_ref",
        "CHEQUE_NUMBER":    "transaction_ref",
    },
    "delivery_note": {
        "DELIVERY_NUMBER":  "reference_number",
        "DN_NUMBER":        "reference_number",
        "DATE":             "document_date",
        "DELIVERY_DATE":    "delivery_date",
        "VENDOR_NAME":      "supplier",
        "SUPPLIER":         "supplier",
        "PO_REFERENCE":     "po_reference",
        "QUANTITY":         "quantity",
        "DESCRIPTION":      "description",
        "UOM":              "uom",
    },
    "contract": {
        "CONTRACT_NUMBER":  "reference_number",
        "DATE":             "document_date",
        "EFFECTIVE_DATE":   "effective_date",
        "EXPIRY_DATE":      "expiry_date",
        "CONTRACT_VALUE":   "contract_value",
        "TOTAL":            "amount",
        "VENDOR_NAME":      "supplier",
        "SUPPLIER":         "supplier",
        "SIGNED_BY":        "signed_by",
        "SIGNED_DATE":      "signed_date",
    },
    "expense_claim": {
        "DATE":             "document_date",
        "TOTAL":            "amount",
        "VENDOR_NAME":      "supplier",
        "APPROVED_BY":      "approved_by",
        "COST_CENTRE":      "cost_centre",
        "DESCRIPTION":      "description",
        "PURPOSE":          "description",
    },
    "payment_voucher": {
        "VOUCHER_NUMBER":   "reference_number",
        "DATE":             "document_date",
        "TOTAL":            "amount",
        "PAYEE":            "supplier",
        "VENDOR_NAME":      "supplier",
        "PAYMENT_METHOD":   "payment_method",
        "TXN_REF":          "transaction_ref",
        "APPROVED_BY":      "approved_by",
    },
    "quotation": {
        "QUOTE_NUMBER":     "reference_number",
        "DATE":             "document_date",
        "EXPIRY_DATE":      "expiry_date",
        "TOTAL":            "amount",
        "VENDOR_NAME":      "supplier",
        "SUPPLIER":         "supplier",
        "QUANTITY":         "quantity",
        "DESCRIPTION":      "description",
        "UOM":              "uom",
    },
    "utility_bill": {
        "INVOICE_NUMBER":   "reference_number",
        "DATE":             "document_date",
        "DUE_DATE":         "due_date",
        "TOTAL":            "amount",
        "VENDOR_NAME":      "supplier",
        "ACCOUNT_CODE":     "account_code",
        "METER_NUMBER":     "account_code",
        "CUSTOMER_NUMBER":  "account_code",
    },
    "statement": {
        "DATE":             "document_date",
        "TOTAL":            "amount",
        "VENDOR_NAME":      "supplier",
        "ACCOUNT_CODE":     "account_code",
    },
    "general": {
        "DATE":             "document_date",
        "TOTAL":            "amount",
        "GRAND_TOTAL":      "amount",
        "VENDOR_NAME":      "supplier",
        "SUPPLIER":         "supplier",
        "TAX":              "tax_amount",
        "VAT":              "tax_amount",
        "QUANTITY":         "quantity",
        "DESCRIPTION":      "description",
        "UOM":              "uom",
    },
}


def _map_entities_to_fields(entities: dict[str, _Entity], doc_type: str) -> dict[str, str]:
    """
    Convert raw LayoutLM labels → canonical field names.

    v2 BUG FIX: when two labels map to the same canonical field, keep the
    highest-confidence entity (previously last-write-wins in iteration order).

    v2 NEW: support LAYOUTLMV3_FIELD_MAP["*"] as a wildcard applied to all
    doc types before the per-type override.
    """
    base_mapping   = _LABEL_MAP.get(doc_type, _LABEL_MAP["general"])
    general_mapping = _LABEL_MAP["general"]

    # Merge: general → doc-type-specific (doc-type wins on conflict)
    mapping = {**general_mapping, **base_mapping}

    # Admin overrides
    admin_map = getattr(settings, "LAYOUTLMV3_FIELD_MAP", {})
    if isinstance(admin_map, dict):
        # Wildcard override applied first
        if "*" in admin_map:
            mapping = {**mapping, **admin_map["*"]}
        # Doc-type-specific override applied second (highest priority)
        if doc_type in admin_map:
            mapping = {**mapping, **admin_map[doc_type]}

    # Build output keeping highest-confidence value per canonical field
    out_confidence: dict[str, float]  = {}
    out:            dict[str, str]    = {}

    for raw_label, ent in entities.items():
        canonical = mapping.get(raw_label)
        if not canonical:
            continue
        if canonical not in out or ent.confidence > out_confidence.get(canonical, 0.0):
            out[canonical]            = ent.value
            out_confidence[canonical] = ent.confidence

    return out


class LayoutLMProcessor:
    def __init__(self, model_name: str = "microsoft/layoutlm-base-uncased"):
        self.tokenizer = LayoutLMTokenizer.from_pretrained(model_name)
        self.model = LayoutLMForTokenClassification.from_pretrained(model_name)
        self.device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
        self.model.to(self.device)

    def predict(
        self,
        words: List[str],
        boxes: List[List[int]],  # Normalized boxes (0-1000)
        word_labels: List[str] = None,
    ) -> Dict[str, Any]:
        """Run LayoutLM inference on normalized words + boxes."""
        # Tokenize words and align boxes
        tokens = []
        token_boxes = []
        for word, box in zip(words, boxes):
            word_tokens = self.tokenizer.tokenize(word)
            tokens.extend(word_tokens)
            # Repeat the box for each subword token
            token_boxes.extend([box] * len(word_tokens))

        # Pad sequences
        inputs = self.tokenizer(
            " ".join(words),
            boxes=token_boxes,
            return_tensors="pt",
            padding="max_length",
            truncation=True,
            max_length=512,
        ).to(self.device)

        # Predict
        with torch.no_grad():
            outputs = self.model(**inputs)

        # Process predictions (simplified)
        predictions = torch.argmax(outputs.logits, dim=-1)
        predicted_labels = [
            self.model.config.id2label[p.item()] for p in predictions[0]
        ]

        return {
            "tokens": tokens,
            "boxes": token_boxes,
            "labels": predicted_labels,
        }

    def group_multi_word_fields(
        self, words: List[str], boxes: List[List[int]], labels: List[str]
    ) -> List[Dict[str, Any]]:
        """Group tokens into multi-word fields (e.g., 'Invoice Number: INV-2024-5001')."""
        fields = []
        current_field = {"text": "", "bbox": None, "label": None}

        for word, box, label in zip(words, boxes, labels):
            if label.startswith("B-"):
                # Start a new field
                if current_field["text"]:
                    fields.append(current_field)
                current_field = {
                    "text": word,
                    "bbox": box,
                    "label": label[2:],  # Remove B- prefix
                }
            elif label.startswith("I-"):
                # Continue the current field
                current_field["text"] += " " + word
                # Expand bbox to include the new word
                current_field["bbox"] = [
                    min(current_field["bbox"][0], box[0]),
                    min(current_field["bbox"][1], box[1]),
                    max(current_field["bbox"][2], box[2]),
                    max(current_field["bbox"][3], box[3]),
                ]
            else:
                # Not part of a field
                if current_field["text"]:
                    fields.append(current_field)
                current_field = {"text": "", "bbox": None, "label": None}

        if current_field["text"]:
            fields.append(current_field)

        return fields