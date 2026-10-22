/**
 * formulas.ts — Auto-fill and dynamic formula engine for built-template form fields.
 *
 * Supports:
 *   • Standard system formulas (current_user, current_user_email, current_user_department, today, now, reference_number)
 *   • Dynamic conditional expressions: IF(condition, true_val, false_val)
 *   • Nested IF conditions
 *   • Regex condition matching: REGEX_MATCH(field, "pattern"), field =~ /pattern/, field !~ /pattern/
 *   • Dynamic math / calculation: =[qty] * [unit_price] or [fieldA] + [fieldB]
 *   • Field variable binding: {field_key} or [field_key]
 *   • Contextual evaluation (user, date, current form values)
 */

export type FormulaUser = {
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  department_name?: string | null;
  department?: { name?: string } | null;
} | null | undefined;

export type FormulaContext = {
  user?: FormulaUser;
  now?: Date;
  values?: Record<string, unknown>;
};

export type FormulaDef = {
  key: string;
  label: string;
  serverOnly?: boolean;
  evaluate: (ctx: FormulaContext) => string;
};

function userName(user: FormulaUser): string {
  if (!user) return "";
  return (
    (user.full_name || "").trim() ||
    `${user.first_name ?? ""} ${user.last_name ?? ""}`.trim() ||
    (user.email || "")
  );
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function fmtDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fmtDateTime(d: Date): string {
  return `${fmtDate(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const FORMULAS: Record<string, FormulaDef> = {
  current_user: {
    key: "current_user",
    label: "Current user — name",
    evaluate: (ctx) => userName(ctx.user),
  },
  current_user_email: {
    key: "current_user_email",
    label: "Current user — email",
    evaluate: (ctx) => ctx.user?.email || "",
  },
  current_user_department: {
    key: "current_user_department",
    label: "Current user — department",
    evaluate: (ctx) => ctx.user?.department_name || ctx.user?.department?.name || "",
  },
  now: {
    key: "now",
    label: "Current date & time",
    evaluate: (ctx) => fmtDateTime(ctx.now ?? new Date()),
  },
  today: {
    key: "today",
    label: "Current date",
    evaluate: (ctx) => fmtDate(ctx.now ?? new Date()),
  },
  reference_number: {
    key: "reference_number",
    label: "Document reference number",
    serverOnly: true,
    evaluate: () => "", // assigned by the server on create
  },
};

const ALIASES: Record<string, string> = {
  created_by: "current_user",
  created_by_email: "current_user_email",
  department: "current_user_department",
  now_time: "now",
  date: "today",
};

export function resolveFormula(formula: string | undefined): FormulaDef | undefined {
  if (!formula) return undefined;
  const key = formula.trim().toLowerCase();
  return FORMULAS[key] ?? FORMULAS[ALIASES[key] ?? ""];
}

/**
 * Advanced formula evaluator supporting IF conditions, regex tests, math, and field interpolation.
 */
export function evaluateDynamicFormula(
  formula: string | undefined,
  values: Record<string, unknown> = {},
  ctx: FormulaContext = {}
): string | number | undefined {
  if (!formula || typeof formula !== "string") return undefined;
  const trimmed = formula.trim();

  // 1. Check built-in static formulas
  const staticDef = resolveFormula(trimmed);
  if (staticDef) {
    if (staticDef.serverOnly) return undefined;
    return staticDef.evaluate(ctx);
  }

  // 2. Parse dynamic / expression formulas
  let expr = trimmed;
  if (expr.startsWith("=")) expr = expr.slice(1).trim();

  function resolveFieldValue(name: string): unknown {
    const cleanKey = name.replace(/^[\{\[]|[\}\]]$/g, "").trim();
    const val = values[cleanKey];
    if (val === undefined || val === null) return "";
    return val;
  }

  function parseAndEval(str: string): any {
    str = str.trim();

    // Check for IF(condition, true_result, false_result)
    const ifMatch = str.match(/^IF\s*\((.*)\)$/is);
    if (ifMatch) {
      const inner = ifMatch[1];
      const args: string[] = [];
      let depth = 0;
      let inQuote: string | null = null;
      let current = "";

      for (let i = 0; i < inner.length; i++) {
        const c = inner[i];
        if (inQuote) {
          current += c;
          if (c === inQuote && inner[i - 1] !== "\\") inQuote = null;
        } else if (c === '"' || c === "'") {
          inQuote = c;
          current += c;
        } else if (c === "(") {
          depth++;
          current += c;
        } else if (c === ")") {
          depth--;
          current += c;
        } else if (c === "," && depth === 0) {
          args.push(current.trim());
          current = "";
        } else {
          current += c;
        }
      }
      if (current) args.push(current.trim());

      if (args.length >= 2) {
        const condResult = evalCondition(args[0]);
        if (condResult) {
          return parseAndEval(args[1]);
        } else {
          return args[2] !== undefined ? parseAndEval(args[2]) : "";
        }
      }
    }

    // Substitute field variables: {key} or [key]
    const interpolated = str.replace(/(\{[a-zA-Z0-9_]+\}|\[[a-zA-Z0-9_]+\])/g, (m) => {
      const v = resolveFieldValue(m);
      if (typeof v === "number") return String(v);
      if (!isNaN(Number(v)) && v !== "" && typeof v !== "boolean") return String(Number(v));
      return JSON.stringify(String(v));
    });

    // Check if it is a pure arithmetic expression (e.g. 5 * 20 + 3)
    if (/^[\d\s\+\-\*\/\.\(\)]+$/.test(interpolated)) {
      try {
        const res = Function('"use strict"; return (' + interpolated + ");")();
        if (typeof res === "number" && !isNaN(res)) return Number(res.toFixed(4));
      } catch {
        // Fall back to string if calculation fails
      }
    }

    // Strip wrapping literal quotes if plain string
    if (
      (interpolated.startsWith('"') && interpolated.endsWith('"')) ||
      (interpolated.startsWith("'") && interpolated.endsWith("'"))
    ) {
      return interpolated.slice(1, -1);
    }

    return interpolated;
  }

  function evalCondition(condStr: string): boolean {
    const s = condStr.trim();

    // 1. REGEX_MATCH(field, "pattern") or REGEX(val, pattern)
    const regexFuncMatch = s.match(/(?:REGEX_MATCH|REGEX|REGEXP)\s*\(\s*(.*?)\s*,\s*["'](.*?)["']\s*\)/i);
    if (regexFuncMatch) {
      const val = String(parseAndEval(regexFuncMatch[1]));
      const pattern = regexFuncMatch[2];
      try {
        const re = new RegExp(pattern);
        return re.test(val);
      } catch {
        return false;
      }
    }

    // 2. Regex comparison operator: field =~ /pattern/ or field !~ /pattern/
    const reOperatorMatch = s.match(/(.+?)\s*(=~|!~)\s*\/(.+?)\/([gimsuy]*)/);
    if (reOperatorMatch) {
      const leftVal = String(parseAndEval(reOperatorMatch[1]));
      const op = reOperatorMatch[2];
      try {
        const re = new RegExp(reOperatorMatch[3], reOperatorMatch[4]);
        const matched = re.test(leftVal);
        return op === "=~" ? matched : !matched;
      } catch {
        return false;
      }
    }

    // 3. General comparison with field interpolation
    const withValues = s.replace(/(\{[a-zA-Z0-9_]+\}|\[[a-zA-Z0-9_]+\])/g, (m) => {
      const v = resolveFieldValue(m);
      if (typeof v === "number") return String(v);
      if (!isNaN(Number(v)) && v !== "" && typeof v !== "boolean") return String(Number(v));
      return JSON.stringify(String(v));
    });

    try {
      const res = Function('"use strict"; return Boolean(' + withValues + ");")();
      return Boolean(res);
    } catch {
      return false;
    }
  }

  const result = parseAndEval(expr);
  return result !== undefined && result !== null ? result : undefined;
}

/** Legacy client preview evaluator preserved for backwards compatibility */
export function evaluateFormula(formula: string | undefined, ctx: FormulaContext): string | undefined {
  const result = evaluateDynamicFormula(formula, ctx.values ?? {}, ctx);
  return result != null ? String(result) : undefined;
}

export function formulaLabel(formula: string | undefined): string {
  return resolveFormula(formula)?.label ?? "";
}

/**
 * Applies schema default values and evaluates formulas (built-ins + IF / regex expressions)
 * while preserving user-entered values across live template updates.
 */
export function applyFormulasAndDefaults(
  sections: unknown[] | undefined,
  currentValues: Record<string, unknown>,
  ctx: FormulaContext,
  options: { preserveUserValues?: boolean } = { preserveUserValues: true }
): Record<string, unknown> {
  const updated: Record<string, unknown> = { ...currentValues };
  const secList = (sections ?? []) as Array<{ fields?: Array<Record<string, any>> }>;

  // Phase 1: Set default values for empty/untouched fields
  for (const s of secList) {
    for (const f of s.fields ?? []) {
      const key = f.key ?? f.id;
      if (!key) continue;
      const cur = updated[key];
      const empty = cur == null || (typeof cur === "string" && cur.trim() === "");
      if (empty && f.defaultValue != null && f.defaultValue !== "") {
        updated[key] = f.defaultValue;
      }
    }
  }

  // Phase 2: Compute formula fields
  for (const s of secList) {
    for (const f of s.fields ?? []) {
      const key = f.key ?? f.id;
      if (!key) continue;
      const formulaExpr = f.formula || f.calculation;
      if (!formulaExpr) continue;

      const isUserEdited = options.preserveUserValues && currentValues[key] !== undefined && !f.computed_only;
      // Evaluate if formula field is empty, computed_only, or dynamic expression
      if (!isUserEdited || formulaExpr.startsWith("=") || formulaExpr.toUpperCase().includes("IF(")) {
        const computed = evaluateDynamicFormula(formulaExpr, updated, ctx);
        if (computed !== undefined && computed !== "") {
          updated[key] = computed;
        }
      }
    }
  }

  return updated;
}

export const FORMULA_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "None (manual entry)" },
  ...Object.values(FORMULAS).map((f) => ({ value: f.key, label: f.label })),
];