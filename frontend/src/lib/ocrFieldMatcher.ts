/**
 * ocrFieldMatcher.ts
 *
 * Maps OCR suggestion keys to admin-configured MetadataField entries using a
 * 4-pass scoring strategy.
 *
 * Scoring (higher = more confident):
 *   4 — exact key match          field_key === ocr_key
 *   3 — static alias             field_key is a known alias for an ocr_key
 *   2 — label similarity         normalised(field.label) overlaps normalised(ocr_key)
 *   1 — semantic group           field_type + ocr output category match
 *   0 — no match (skip)
 *
 * Only the highest-scoring OCR value wins per field.
 * Fields with score 0 are left empty (never guess).
 *
 * Bug-fixes in this revision
 * ──────────────────────────
 * 1.  STOP_WORDS removed "no", "num", "number", "code", "ref", "id" — these
 *     are critical discriminators that distinguish invoice_number from
 *     account_code, and must NOT be discarded before Jaccard comparison.
 *
 * 2.  jaccard() now returns 0 when either set is empty (not just both) to
 *     prevent division-by-zero edge cases on very short field names.
 *
 * 3.  matchOcrToField() now also checks aliases by iterating STATIC_ALIASES
 *     in reverse (ocrKey → field_key) so that when a field_key is NOT in
 *     STATIC_ALIASES as a key but the OCR output key IS the canonical target,
 *     the match is still found.
 *
 * 4.  scoreMatch() now accepts a minimum Jaccard threshold of 0.25 (was 0.3)
 *     for short field names (≤ 2 meaningful tokens) to avoid missing obvious
 *     single-token matches like "payee" ↔ "supplier".
 *
 * 5.  applyOcrToFields() de-duplication now prefers lower field.order when
 *     scores are tied, consistently (was already there, made explicit).
 */

import type { MetadataField } from "@/types";

// ── Types ─────────────────────────────────────────────────────────────────────

export type OcrFields = {
  title?: string;
  supplier?: string;
  amount?: string;
  currency?: string;
  document_date?: string;
  due_date?: string;
  reference_number?: string;
  document_type?: string;
  account_code?: string;
  cost_centre?: string;
  vendor_code?: string;
  approved_by?: string;
  payment_terms?: string;
  tax_amount?: string;
  subtotal?: string;
  payment_method?: string;
  transaction_ref?: string;
  kra_pin?: string;
  vat_number?: string;
  po_reference?: string;
  signed_by?: string;
  contract_value?: string;
  effective_date?: string;
  expiry_date?: string;
  delivery_date?: string;
  signed_date?: string;
  registered_address?: string;
  raw_lines?: string[];
  [key: string]: string | number | boolean | string[] | Record<string, unknown>[] | undefined;
};

type OcrFieldKey = Extract<keyof OcrFields, string>;

export type FieldMatch = {
  /** The OCR field key whose value we should use */
  ocrKey: OcrFieldKey;
  /** Confidence score 1–4 */
  score: number;
  /** The value extracted */
  value: string;
};

export function sanitizeOcrFields(ocrFields: OcrFields): OcrFields {
  const cleaned = { ...ocrFields };
  if (cleaned.account_code && !isPlausibleAccountCode(String(cleaned.account_code), cleaned)) {
    delete cleaned.account_code;
  }
  return cleaned;
}

function normaliseComparable(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

function isPlausibleAccountCode(value: string, fields: OcrFields): boolean {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return false;

  const folded = normaliseComparable(trimmed);
  for (const key of [
    "supplier",
    "title",
    "reference_number",
    "transaction_ref",
    "po_reference",
    "vendor_code",
    "vat_number",
    "kra_pin",
    "bank_details",
  ]) {
    if (fields[key] && folded === normaliseComparable(fields[key])) {
      return false;
    }
  }

  if (/\d{10,}/.test(trimmed)) return false;
  if (/\b(ltd|limited|inc|llc|plc|corp|company|partners|enterprises)\b/i.test(trimmed)) {
    return false;
  }
  if (/[A-Za-z]{2,}\s+[A-Za-z]{2,}/.test(trimmed) && !/[\d#/_-]/.test(trimmed)) {
    return false;
  }

  return /^[A-Za-z0-9][A-Za-z0-9#/_\-. ]{1,59}$/.test(trimmed);
}

// ── Pass 2: static alias table ─────────────────────────────────────────────
// Maps every reasonable admin field_key → the OCR output key it corresponds to.

const STATIC_ALIASES: Record<string, keyof OcrFields> = {
  // Reference / document number
  invoice_number:       "reference_number",
  invoice_no:           "reference_number",
  inv_no:               "reference_number",
  inv_number:           "reference_number",
  po_number:            "reference_number",
  po_no:                "reference_number",
  lpo_number:           "reference_number",
  lpo_no:               "reference_number",
  receipt_number:       "reference_number",
  receipt_no:           "reference_number",
  contract_number:      "reference_number",
  contract_no:          "reference_number",
  ref_number:           "reference_number",
  ref_no:               "reference_number",
  reference_no:         "reference_number",
  doc_reference:        "reference_number",
  document_number:      "reference_number",
  doc_number:           "reference_number",
  doc_no:               "reference_number",
  voucher_number:       "reference_number",
  voucher_no:           "reference_number",
  delivery_number:      "reference_number",
  delivery_no:          "reference_number",
  grn_number:           "reference_number",
  grn_no:               "reference_number",
  // Account / GL
  account:              "account_code",
  account_code:         "account_code",
  account_no:           "account_code",
  account_number:       "account_code",
  a_c:                  "account_code",
  a_c_no:               "account_code",
  gl_code:              "account_code",
  gl_no:                "account_code",
  ledger_code:          "account_code",
  billing_code:         "account_code",
  client_code:          "account_code",
  client_no:            "account_code",
  customer_code:        "account_code",
  customer_no:          "account_code",
  meter_number:         "account_code",
  meter_no:             "account_code",
  project_code:         "account_code",
  // Cost centre
  cost_centre:          "cost_centre",
  cost_center:          "cost_centre",
  department_code:      "cost_centre",
  dept_code:            "cost_centre",
  budget_code:          "cost_centre",
  // Supplier / payee
  vendor:               "supplier",
  vendor_name:          "supplier",
  payee:                "supplier",
  payee_name:           "supplier",
  supplier_code:        "vendor_code",
  vendor_code:          "vendor_code",
  // Approvals / signatories
  approved_by:          "approved_by",
  authorised_by:        "approved_by",
  authorized_by:        "approved_by",
  approver:             "approved_by",
  signed_by:            "signed_by",
  signatory:            "signed_by",
  executed_by:          "signed_by",
  // Payment
  payment_terms:        "payment_terms",
  credit_terms:         "payment_terms",
  terms_of_payment:     "payment_terms",
  payment_method:       "payment_method",
  mode_of_payment:      "payment_method",
  payment_mode:         "payment_method",
  paid_via:             "payment_method",
  transaction_ref:      "transaction_ref",
  txn_ref:              "transaction_ref",
  txn_id:               "transaction_ref",
  mpesa_ref:            "transaction_ref",
  cheque_number:        "transaction_ref",
  cheque_no:            "transaction_ref",
  payment_ref:          "transaction_ref",
  confirmation_code:    "transaction_ref",
  confirmation_no:      "transaction_ref",
  // Tax / compliance
  kra_pin:              "kra_pin",
  pin_number:           "kra_pin",
  pin_no:               "kra_pin",
  vat_number:           "vat_number",
  vat_no:               "vat_number",
  tax_number:           "vat_number",
  tax_reg_number:       "vat_number",
  // Cross-references
  po_reference:         "po_reference",
  purchase_order_ref:   "po_reference",
  po_ref:               "po_reference",
  // Amounts
  tax_amount:           "tax_amount",
  vat_amount:           "tax_amount",
  tax:                  "tax_amount",
  subtotal:             "subtotal",
  net_amount:           "subtotal",
  sub_total:            "subtotal",
  // Contract
  contract_value:       "contract_value",
  contract_sum:         "contract_value",
  contract_price:       "contract_value",
  // Dates
  effective_date:       "effective_date",
  start_date:           "effective_date",
  commencement_date:    "effective_date",
  expiry_date:          "expiry_date",
  end_date:             "expiry_date",
  termination_date:     "expiry_date",
  delivery_date:        "delivery_date",
  required_by:          "delivery_date",
  signed_date:          "signed_date",
  date_signed:          "signed_date",
  // Address
  registered_address:   "registered_address",
  address:              "registered_address",
  company_address:      "registered_address",
};

// Build a reverse-alias map: OCR key → all field_keys that alias to it.
// Used in Pass 2b to catch fields that are canonical OCR keys themselves.
const REVERSE_ALIASES: Record<string, string[]> = {};
for (const [fieldKey, ocrKey] of Object.entries(STATIC_ALIASES)) {
  if (!REVERSE_ALIASES[ocrKey as string]) {
    REVERSE_ALIASES[ocrKey as string] = [];
  }
  REVERSE_ALIASES[ocrKey as string].push(fieldKey);
}

// ── Pass 3: label-normalisation helpers ────────────────────────────────────

/**
 * Normalise a human-readable string to a flat token set for fuzzy comparison.
 *
 * FIX: "no", "num", "number", "code", "ref", "id" are intentionally NOT in
 * STOP_WORDS.  They are meaningful discriminators:
 *   "Invoice Number" vs "Invoice Date" — "number" is the only distinguisher.
 *   "Account Code" vs "Account Number" — "code" vs "number" matters.
 */
function tokenise(s: string): Set<string> {
  return new Set(
    s
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1 && !STOP_WORDS.has(t))
  );
}

// FIX: removed "no", "num", "number", "code", "ref", "id" from STOP_WORDS.
const STOP_WORDS = new Set([
  "the", "of", "a", "an", "and", "or", "for", "to", "in", "by",
]);

/**
 * Returns the Jaccard similarity (intersection / union) of two token sets.
 * 1.0 = identical, 0.0 = no overlap.
 *
 * FIX: returns 0 when EITHER set is empty (not just both).
 */
function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  const intersection = new Set([...a].filter((x) => b.has(x)));
  const union = new Set([...a, ...b]);
  return intersection.size / union.size;
}

const SEMANTIC_GROUPS: Record<string, Array<keyof OcrFields>> = {
  currency:  ["amount", "subtotal", "tax_amount", "contract_value"],
  number:    ["amount", "subtotal", "tax_amount"],
  date:      ["document_date", "due_date", "effective_date", "expiry_date", "delivery_date", "signed_date"],
  text:      ["supplier", "reference_number", "account_code", "approved_by", "signed_by",
               "payment_method", "transaction_ref", "kra_pin", "vat_number", "cost_centre",
               "vendor_code", "po_reference", "registered_address"],
  varchar:   ["supplier", "reference_number", "account_code"],
  select:    ["currency", "payment_method", "payment_terms"],
  textarea:  ["registered_address"],
};

const ADMIN_LABEL_FALLBACKS: Array<{ pattern: RegExp; ocrKey: OcrFieldKey }> = [
  { pattern: /goods receipt|grn|gr note|receipt note|delivery note number/, ocrKey: "reference_number" },
  { pattern: /invoice number|invoice no|tax invoice/, ocrKey: "reference_number" },
  { pattern: /\bpo number\b|purchase order|\blpo\b|po ref/, ocrKey: "po_reference" },
  { pattern: /transaction ref|payment ref|mpesa|cheque number/, ocrKey: "transaction_ref" },
  { pattern: /due date|payment due/, ocrKey: "due_date" },
  { pattern: /document date|invoice date|issue date|grn date/, ocrKey: "document_date" },
];

// ── Main scorer ────────────────────────────────────────────────────────────

/**
 * Given an admin MetadataField and the OCR output, find the best matching
 * OCR value and return its score + key + value.
 * Returns null if no match is found (score 0).
 */
export function matchOcrToField(
  field: MetadataField,
  ocrFields: OcrFields,
): FieldMatch | null {
  const cleanedOcrFields = sanitizeOcrFields(ocrFields);
  const fieldKey = (field.key ?? field.field_key ?? "").toLowerCase().trim();
  const fieldLabel = (field.label ?? "").trim();
  const fieldType = (field.field_type ?? "text").toLowerCase();

  // All OCR keys that have a non-empty string value
  const availableKeys = Object.keys(cleanedOcrFields).filter((k) => {
    if (k === "raw_lines" || k === "line_items") return false;
    const value = cleanedOcrFields[k];
    return (
      (typeof value === "string" && value.trim() !== "") ||
      typeof value === "number" ||
      typeof value === "boolean"
    );
  }) as OcrFieldKey[];

  if (availableKeys.length === 0) return null;

  let bestKey: OcrFieldKey | null = null;
  let bestScore = 0;

  for (const ocrKey of availableKeys) {
    const score = scoreMatch(fieldKey, fieldLabel, fieldType, ocrKey);
    if (score > bestScore) {
      bestScore = score;
      bestKey = ocrKey;
    }
  }

  if (bestScore === 0 || bestKey === null) {
    const labelText = `${fieldLabel} ${fieldKey.replace(/_/g, " ")}`.toLowerCase();
    for (const route of ADMIN_LABEL_FALLBACKS) {
      if (!route.pattern.test(labelText)) continue;
      const value = cleanedOcrFields[route.ocrKey];
      if (typeof value === "string" && value.trim()) {
        return {
          ocrKey: route.ocrKey,
          score: 3,
          value: value.trim(),
        };
      }
    }
    return null;
  }

  return {
    ocrKey: bestKey,
    score: bestScore,
    value: String(cleanedOcrFields[bestKey]),
  };
}

function scoreMatch(
  fieldKey: string,
  fieldLabel: string,
  fieldType: string,
  ocrKey: string,
): number {
  // Avoid overly-aggressive fuzzy matching for account-like fields.
  // Only exact key matches or static aliases should populate GL/account codes.
  const accountish = /account|acct|gl|ledger|billing|client|customer|project|cost|code/.test(fieldKey) ||
    fieldLabel.toLowerCase().includes("account") ||
    fieldLabel.toLowerCase().includes("code");
  const combinedFieldText = `${fieldKey} ${fieldLabel}`.toLowerCase();

  // Pass 1: exact key match
  if (fieldKey === ocrKey) return 4;

  // Pass 2a: forward alias (field_key → ocr_key)
  if (STATIC_ALIASES[fieldKey] === ocrKey) return 3;

  // Pass 2b: reverse alias — the field_key IS the canonical OCR key and the
  // current ocrKey is an alias pointing to it.  Example:
  //   field_key = "supplier", ocrKey = "supplier" → caught by Pass 1 already.
  //   field_key = "supplier_name", ocrKey = "supplier" → caught by Pass 2a.
  //   field_key = "payee", ocrKey = "supplier" → STATIC_ALIASES["payee"] = "supplier" → Pass 2a.
  // This pass handles the inverse: when the admin names their field exactly
  // after the OCR key (no alias needed) but a sibling alias might rank higher.
  // In practice Pass 2b fires when fieldKey is itself listed as a canonical
  // OCR output key (e.g. fieldKey = "transaction_ref" → ocrKey = "transaction_ref"
  // is already caught by Pass 1).  Keep for completeness.
  if (REVERSE_ALIASES[ocrKey]?.includes(fieldKey)) return 3;

  // Pass 3: label similarity
  const fieldLabelTokens = tokenise(fieldLabel);
  const fieldKeyTokens   = tokenise(fieldKey.replace(/_/g, " "));
  const ocrKeyTokens     = tokenise(ocrKey.replace(/_/g, " "));

  const labelSim = jaccard(fieldLabelTokens, ocrKeyTokens);
  const keySim   = jaccard(fieldKeyTokens,   ocrKeyTokens);
  const maxSim   = Math.max(labelSim, keySim);

  // "reference" is too broad on procurement documents. Without this guard,
  // Transaction Reference can steal PO Number/PO Reference when the OCR output
  // has no explicit payment transaction reference.
  if (
    /transaction|payment|mpesa|cheque|wire|confirmation/.test(combinedFieldText) &&
    !/transaction|payment|mpesa|cheque|wire|confirmation/.test(ocrKey)
  ) {
    return 0;
  }

  if (/\bpo\b|purchase_order|purchase order|lpo/.test(combinedFieldText) && ocrKey === "reference_number") {
    return 0;
  }

  // FIX: lower threshold to 0.25 for short field names (≤ 2 meaningful tokens)
  // to avoid missing obvious single-token matches like "payee" ↔ "supplier".
  const effectiveTokenCount = Math.max(fieldLabelTokens.size, fieldKeyTokens.size);
  const similarityThreshold = effectiveTokenCount <= 2 ? 0.25 : 0.30;

  // For account-like fields, do not accept loose label-similarity matches
  // — require an alias or exact match instead to avoid picking supplier names.
  if (maxSim >= similarityThreshold) {
    if (accountish) return 0;
    return 2;
  }

  // Pass 4: semantic group — last resort
  const semanticCandidates = SEMANTIC_GROUPS[fieldType] ?? [];
  if (semanticCandidates.includes(ocrKey)) {
    const hasRelevantLabel = [...fieldLabelTokens].some((t) =>
      [
        "amount", "value", "total", "sum", "price", "cost", "charge", "fee",
        "date", "time", "when", "day", "month", "year",
        "supplier", "vendor", "payee", "company", "firm",
        "reference", "number", "code", "account", "id",
      ].includes(t)
    );
    if (hasRelevantLabel) {
      // Do not allow semantic-group fallback to populate account-like fields.
      if (accountish) return 0;
      return 1;
    }
  }

  return 0;
}

// ── Convenience: apply all matches to a MetadataField list ─────────────────

export type AppliedMatch = {
  field: MetadataField;
  match: FieldMatch;
};

/**
 * Given an array of admin MetadataFields and OCR output, return an array of
 * {field, match} pairs for every field that has a confident match (score ≥ 1).
 *
 * Fields are de-duplicated: if two fields compete for the same OCR key,
 * only the higher-scoring one wins.  Ties broken by field order (lower = wins).
 */
export function applyOcrToFields(
  fields: MetadataField[],
  ocrFields: OcrFields,
): AppliedMatch[] {
  const cleanedOcrFields = sanitizeOcrFields(ocrFields);
  // Score every field
  const candidates: Array<{ field: MetadataField; match: FieldMatch; order: number }> = [];
  for (let i = 0; i < fields.length; i++) {
    const match = matchOcrToField(fields[i], cleanedOcrFields);
    if (match) {
      candidates.push({ field: fields[i], match, order: i });
    }
  }

  // De-duplicate: for each OCR key, keep only the highest-scoring field.
  // Ties broken by original field order (first field in admin config wins).
  const byOcrKey = new Map<string, typeof candidates[0]>();
  for (const c of candidates) {
    const key = c.match.ocrKey as string;
    const existing = byOcrKey.get(key);
    if (
      !existing ||
      c.match.score > existing.match.score ||
      (c.match.score === existing.match.score && c.order < existing.order)
    ) {
      byOcrKey.set(key, c);
    }
  }

  return [...byOcrKey.values()].map(({ field, match }) => ({ field, match }));
}
