"""
apps/documents/ocr/layoutlm.py

LayoutLMv3 inference module — feeds directly from PaddleOCR / Tesseract
positioned-word output.  Loaded once per Celery worker process (singleton).

Design decisions
────────────────
• Thread-safe lazy initialisation (identical pattern to PaddleOCR / spaCy).
• CPU-friendly by default (125 M params); opt-in CUDA via settings.
• Boxes are normalised 0-1000 and validated before inference.
• BIO post-processing groups sub-word tokens into clean entity strings.
• Per-document-type label mapping converts raw LayoutLM labels (INVOICE_NUMBER,
  TOTAL, …) into the canonical field names your regex extractor already uses
  (reference_number, amount, supplier, …).
"""
from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Optional

import numpy as np
import torch
from django.conf import settings
from PIL import Image
from transformers import AutoProcessor, AutoModelForTokenClassification

logger = logging.getLogger(__name__)

# ── Singleton state (one per worker process) ───────────────────────────────────
_layoutlm_extractor: Optional["LayoutLMExtractor"] = None
_layoutlm_lock = threading.Lock()
_layoutlm_available: Optional[bool] = None


# ── Data classes ──────────────────────────────────────────────────────────────

@dataclass
class PageData:
    """One page image + the positioned words produced by your OCR engine."""
    image: Image.Image
    words: list[dict]   # {"text": str, "left": int, "top": int,
                        #  "right": int, "bottom": int, "conf": float}


@dataclass
class _Entity:
    value: str
    confidence: float
    raw_label: str


# ── Public API ───────────────────────────────────────────────────────────────

def extract_with_layoutlm(pages_data: list[PageData], doc_type: str = "general") -> dict:
    """
    Run LayoutLMv3 over one or more pages and return canonical field names.

    Multi-page strategy: keep the highest-confidence entity per raw label.
    Mapping layer then converts raw labels (INVOICE_NUMBER → reference_number,
    etc.) per document type.
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
        self.processor = processor
        self.model = model
        self.device = device
        self.id2label = model.config.id2label
        self.conf_threshold = float(getattr(settings, "LAYOUTLMV3_CONFIDENCE", 0.85))
        self.max_length = int(getattr(settings, "LAYOUTLMV3_MAX_LENGTH", 512))

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
        model = AutoModelForTokenClassification.from_pretrained(model_name)
        model.to(device)
        model.eval()

        # PyTorch 2 compile on CUDA — optional speed-up
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
        texts: list[str] = []
        boxes: list[list[int]] = []

        for w in words:
            x1 = max(0, min(1000, int(1000 * w["left"] / width)))
            y1 = max(0, min(1000, int(1000 * w["top"] / height)))
            x2 = max(0, min(1000, int(1000 * w["right"] / width)))
            y2 = max(0, min(1000, int(1000 * w["bottom"] / height)))
            # Prevent degenerate boxes
            if x2 <= x1:
                x2 = x1 + 1
            if y2 <= y1:
                y2 = y1 + 1
            boxes.append([x1, y1, x2, y2])
            texts.append(w["text"])

        encoding = self.processor(
            image,
            text=texts,
            boxes=boxes,
            return_tensors="pt",
            truncation=True,
            max_length=self.max_length,
            padding="max_length",
        )

        input_ids = encoding["input_ids"].to(self.device)
        attention_mask = encoding["attention_mask"].to(self.device)
        bbox = encoding["bbox"].to(self.device)
        pixel_values = encoding["pixel_values"].to(self.device)

        with torch.no_grad():
            outputs = self.model(
                input_ids=input_ids,
                attention_mask=attention_mask,
                bbox=bbox,
                pixel_values=pixel_values,
            )

        predictions = outputs.logits.argmax(dim=-1)[0].cpu().numpy()
        confidences = outputs.logits.softmax(dim=-1).max(dim=-1)[0][0].cpu().numpy()
        tokens = self.processor.tokenizer.convert_ids_to_tokens(input_ids[0])
        attn = attention_mask[0].cpu().numpy()

        return self._decode_bio(tokens, predictions, confidences, attn)

    def _decode_bio(self, tokens, predictions, confidences, attn_mask) -> dict[str, _Entity]:
        id2label = self.id2label
        entities: dict[str, _Entity] = {}

        current_field: Optional[str] = None
        current_tokens: list[str] = []
        current_confs: list[float] = []

        special = {
            self.processor.tokenizer.cls_token,
            self.processor.tokenizer.sep_token,
            self.processor.tokenizer.pad_token,
        }

        def _flush():
            nonlocal current_field, current_tokens, current_confs
            if current_field and current_tokens:
                avg_conf = float(np.mean(current_confs))
                # Debug: Log all detected entities before filtering
                raw = self.processor.tokenizer.convert_tokens_to_string(current_tokens)
                clean = (
                    raw.replace("▁", " ")
                    .replace("<s>", "")
                    .replace("</s>", "")
                    .strip()
                )
                logger.debug(
                    "LayoutLM detected: field=%s, value='%s', conf=%.3f, threshold=%.3f",
                    current_field, clean, avg_conf, self.conf_threshold
                )
                if avg_conf >= self.conf_threshold:
                    if current_field not in entities or avg_conf > entities[current_field].confidence:
                        entities[current_field] = _Entity(value=clean, confidence=round(avg_conf, 4), raw_label=current_field)
                current_field = None
                current_tokens = []
                current_confs = []

        for idx, (token, pred_id, conf) in enumerate(zip(tokens, predictions, confidences)):
            if attn_mask[idx] == 0 or token in special:
                _flush()
                continue

            label = id2label.get(pred_id, "O")
            if label == "O":
                _flush()
                continue

            if label.startswith("B-"):
                _flush()
                current_field = label[2:]
                current_tokens = [token]
                current_confs = [conf]
            elif label.startswith("I-") and current_field == label[2:]:
                current_tokens.append(token)
                current_confs.append(conf)
            else:
                # Broken sequence — flush and optionally start new if I-*
                _flush()
                if label.startswith("I-"):
                    current_field = label[2:]
                    current_tokens = [token]
                    current_confs = [conf]

        _flush()
        return entities


# ── Initialisation ────────────────────────────────────────────────────────────

def _get_layoutlm_extractor() -> Optional[LayoutLMExtractor]:
    global _layoutlm_extractor, _layoutlm_available
    if _layoutlm_available is False:
        return None
    if _layoutlm_extractor is not None:
        return _layoutlm_extractor

    with _layoutlm_lock:
        if _layoutlm_extractor is not None:
            return _layoutlm_extractor
        if _layoutlm_available is False:
            return None
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
_LABEL_MAP: dict[str, dict[str, str]] = {
    "invoice": {
        "INVOICE_NUMBER": "reference_number",
        "INVOICE_DATE":   "document_date",
        "DATE":           "document_date",
        "DUE_DATE":       "due_date",
        "TOTAL":          "amount",
        "SUBTOTAL":       "subtotal",
        "TAX":            "tax_amount",
        "GST":            "tax_amount",
        "VENDOR_NAME":    "supplier",
        "SUPPLIER":       "supplier",
        "BILLER":         "supplier",
        "ACCOUNT_CODE":   "account_code",
        "CURRENCY":       "currency",
    },
    "purchase_order": {
        "PO_NUMBER":      "reference_number",
        "ORDER_NUMBER":   "reference_number",
        "DATE":           "document_date",
        "TOTAL":          "amount",
        "VENDOR_NAME":    "supplier",
        "SUPPLIER":       "supplier",
        "VENDOR_CODE":    "vendor_code",
    },
    "receipt": {
        "RECEIPT_NUMBER": "reference_number",
        "DATE":           "document_date",
        "TOTAL":          "amount",
        "VENDOR_NAME":    "supplier",
        "SUPPLIER":       "supplier",
        "PAYMENT_METHOD": "payment_method",
    },
    "general": {
        "DATE":           "document_date",
        "TOTAL":          "amount",
        "VENDOR_NAME":    "supplier",
        "SUPPLIER":       "supplier",
        "TAX":            "tax_amount",
    },
}


def _map_entities_to_fields(entities: dict[str, _Entity], doc_type: str) -> dict:
    """
    Convert raw LayoutLM labels to the canonical field names used across
    your DMS (reference_number, amount, supplier, …).
    """
    mapping = _LABEL_MAP.get(doc_type, _LABEL_MAP["general"])

    # Allow admins to inject custom mappings via Django settings without touching code
    admin_map = getattr(settings, "LAYOUTLMV3_FIELD_MAP", {})
    if isinstance(admin_map, dict) and doc_type in admin_map:
        mapping = {**mapping, **admin_map[doc_type]}

    out: dict[str, str] = {}
    for raw_label, ent in entities.items():
        canonical = mapping.get(raw_label)
        if not canonical:
            continue
        # Keep highest confidence per canonical field
        if canonical not in out:
            out[canonical] = ent.value
    return out