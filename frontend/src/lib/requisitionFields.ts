export type SupplierAccount = { account_code: string; description: string };

type FormField = {
  key?: string;
  type?: string;
  sunsystems?: { role?: string };
  columns?: { key?: string; sunsystems?: { role?: string } }[];
};

const toNumber = (raw: unknown): number | null => {
  if (raw === null || raw === undefined || raw === "") return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;
  const cleaned = String(raw).replace(/[^0-9.\-]/g, "");
  if (!cleaned || cleaned === "-" || cleaned === ".") return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
};

const norm = (value: unknown) => String(value ?? "").trim().toLowerCase();

function getFormParts(doc: any): { values: Record<string, unknown>; fields: FormField[] } {
  const form = doc?.metadata?.form ?? {};
  const formValues = form.values;
  const summaryValues = doc?.form_summary?.values;
  const values = formValues && Object.keys(formValues).length > 0
    ? formValues
    : summaryValues && typeof summaryValues === "object"
      ? summaryValues
      : {};
  const sections = Array.isArray(form.sections) ? form.sections : [];
  const fields = sections.flatMap((section: any) =>
    Array.isArray(section?.fields) ? section.fields as FormField[] : [],
  );
  return { values, fields };
}

/** Resolve the requisition amount from its configured journal amount binding. */
export function getReqAmount(doc: any): number | null {
  const { values, fields } = getFormParts(doc);

  for (const field of fields) {
    if (field.type === "table" || field.sunsystems?.role !== "journal_amount" || !field.key) continue;
    const amount = toNumber(values[field.key]);
    if (amount !== null) return amount;
  }

  for (const field of fields) {
    if (field.type !== "table" || !field.key) continue;
    const amountColumn = field.columns?.find((column) => column.sunsystems?.role === "line_amount");
    const rows = values[field.key];
    if (!amountColumn?.key || !Array.isArray(rows)) continue;
    const amounts = rows
      .map((row: any) => toNumber(row?.[amountColumn.key!]))
      .filter((amount: number | null): amount is number => amount !== null);
    if (amounts.length > 0) return amounts.reduce((sum: number, amount: number) => sum + amount, 0);
  }
  return null;
}

/** Resolve SunSystems supplier account values to readable supplier names. */
export function getReqSupplier(doc: any, accounts: SupplierAccount[] = []): string {
  const { values, fields } = getFormParts(doc);
  const byCode = new Map(accounts.map((account) => [norm(account.account_code), account.description]));

  const lookup = (code: unknown): string => {
    const text = String(code ?? "").trim();
    return text ? byCode.get(norm(text)) || text : "";
  };

  const namesOf = (value: unknown): string[] => {
    if (value === null || value === undefined || value === "") return [];
    if (Array.isArray(value)) return value.flatMap(namesOf);
    if (typeof value === "string" || typeof value === "number") {
      return String(value).split(",").map(lookup).filter(Boolean);
    }
    if (typeof value === "object") {
      const item = value as Record<string, unknown>;
      const name = item.description ?? item.name ?? item.label;
      if (typeof name === "string" && name.trim()) return [name.trim()];
      return [lookup(item.account_code ?? item.code ?? item.id)].filter(Boolean);
    }
    return [];
  };

  const supplierKeys = fields
    .filter((field) => field.type === "sunsystems_account" && field.key)
    .map((field) => field.key!);
  const candidates = supplierKeys.length
    ? supplierKeys.map((key) => values[key])
    : [values.supplier, values.supplier_name, doc?.supplier];
  return Array.from(new Set(candidates.flatMap(namesOf))).join(", ") || "—";
}
