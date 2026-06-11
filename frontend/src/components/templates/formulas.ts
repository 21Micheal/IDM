/**
 * Auto-fill formulas for built-template form fields.
 *
 * A field can declare a `formula` (e.g. "current_user", "now"). The value is
 * filled automatically instead of being typed. Formulas are evaluated:
 *   • client-side at fill time for an instant preview (this module), and
 *   • server-side authoritatively at create (apps/documents/form_formulas.py),
 *     which freezes the value — `created_by`/`now`/reference capture the moment
 *     of submission and don't change when the form is later edited.
 *
 * Keep the keys in sync with apps/documents/form_formulas.py.
 */

type FormulaUser = {
  full_name?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  email?: string | null;
  department_name?: string | null;
  department?: { name?: string } | null;
} | null | undefined;

export type FormulaContext = { user?: FormulaUser; now?: Date };

export type FormulaDef = {
  key: string;
  label: string;
  /** Resolved only by the server (left blank in the client preview). */
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
    evaluate: (ctx) => (ctx.user?.email || ""),
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

// Friendly aliases for formula keys stored on older/loose schemas.
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

/** Client preview value for a field's formula, or undefined if not resolvable / server-only. */
export function evaluateFormula(formula: string | undefined, ctx: FormulaContext): string | undefined {
  const def = resolveFormula(formula);
  if (!def || def.serverOnly) return undefined;
  const value = def.evaluate(ctx);
  return value || undefined;
}

export function formulaLabel(formula: string | undefined): string {
  return resolveFormula(formula)?.label ?? "";
}

/** Builder dropdown options (value "" = none). */
export const FORMULA_OPTIONS: Array<{ value: string; label: string }> = [
  { value: "", label: "None (manual entry)" },
  ...Object.values(FORMULAS).map((f) => ({ value: f.key, label: f.label })),
];
