/**
 * Visibility / editability rule operators for the live form (TemplateForm).
 *
 * Mirrors match_operator() in apps/templates_engine/conditions.py and the
 * operator set offered by the builder (TemplateBuilderV2.tsx OPERATOR_GROUPS),
 * so a rule behaves identically in the builder Preview, on the live form and
 * on the server.
 *
 * equals / not_equals keep their original EXACT comparison. Every other
 * operator compares trimmed and case-insensitively; numbers compare
 * numerically, everything else (incl. ISO dates) by code point.
 */

export const KNOWN_OPERATORS = new Set([
  "equals", "not_equals", "is_empty", "is_not_empty",
  "greater_than", "greater_or_equal", "less_than", "less_or_equal",
  "between", "not_between",
  "contains", "not_contains", "starts_with", "ends_with",
  "in_list", "not_in_list", "is_true", "is_false",
]);

/** Negative operators must hold for EVERY candidate row; positive ones for ANY. */
const NEGATIVE_OPERATORS = new Set([
  "not_equals", "is_empty", "not_contains", "not_in_list", "not_between", "is_false",
]);

const NUM_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const TRUTHY_TEXT = new Set(["true", "yes", "1", "on", "checked"]);

export const isKnownOperator = (op: string | undefined): boolean => KNOWN_OPERATORS.has(op ?? "");
export const isNegativeOperator = (op: string | undefined): boolean => NEGATIVE_OPERATORS.has(op ?? "");

function ruleNum(s: string): number | null {
  const t = s.trim();
  return t !== "" && NUM_RE.test(t) ? Number(t) : null;
}

function ruleCompare(sv: string, rhs: string): number {
  const a = ruleNum(sv), b = ruleNum(rhs);
  if (a !== null && b !== null) return a > b ? 1 : a < b ? -1 : 0;
  const x = sv.trim(), y = rhs.trim();
  return x > y ? 1 : x < y ? -1 : 0;
}

/** Does one candidate value `sv` satisfy `operator` against `expected`? */
export function matchOperator(operator: string | undefined, sv: string, expected: string | undefined): boolean {
  const exp = expected ?? "";
  const target = exp.trim();
  const lower = sv.trim().toLowerCase();
  const tl = target.toLowerCase();
  const nonblank = sv.trim() !== "";
  switch (operator) {
    case "equals": return sv === exp;
    case "not_equals": return sv !== exp;
    case "is_empty": return !nonblank;
    case "is_not_empty": return nonblank;
    case "greater_than": return nonblank && ruleCompare(sv, target) > 0;
    case "greater_or_equal": return nonblank && ruleCompare(sv, target) >= 0;
    case "less_than": return nonblank && ruleCompare(sv, target) < 0;
    case "less_or_equal": return nonblank && ruleCompare(sv, target) <= 0;
    case "between":
    case "not_between": {
      const parts = exp.split(",");
      const lo = (parts[0] ?? "").trim(), hi = (parts[1] ?? "").trim();
      const inside = nonblank && ruleCompare(sv, lo) >= 0 && ruleCompare(sv, hi) <= 0;
      return operator === "between" ? inside : !inside;
    }
    case "contains": return tl !== "" && lower.includes(tl);
    case "not_contains": return tl === "" || !lower.includes(tl);
    case "starts_with": return lower.startsWith(tl);
    case "ends_with": return lower.endsWith(tl);
    case "in_list":
    case "not_in_list": {
      const listed = exp.split(",").map((v) => v.trim().toLowerCase()).filter(Boolean);
      return operator === "in_list" ? listed.includes(lower) : !listed.includes(lower);
    }
    case "is_true": return TRUTHY_TEXT.has(lower);
    case "is_false": return !TRUTHY_TEXT.has(lower);
    default: return true; // unknown operator — never hide/lock on it
  }
}