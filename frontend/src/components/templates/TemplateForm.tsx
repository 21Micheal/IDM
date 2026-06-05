/**
 * TemplateForm — interactive, in-app renderer for a BUILT template's form.
 *
 * Built templates are forms, not files: they are filled inside the app and never
 * handed to an external editor. This component renders the editable form from a
 * template's section/field schema and reports value changes to the caller, which
 * owns the values map. Reused on the upload page (fill) and, later, the document
 * detail page (view/edit).
 *
 * Types are permissive so callers can pass loosely-typed schema (sections: unknown[]).
 */
import type { ReactNode } from "react";

type Column = { id?: string; key?: string; label?: string; required?: boolean; type?: string; options?: string[] };
type Field = {
  id?: string;
  key?: string;
  type?: string;
  label?: string;
  placeholder?: string;
  help_text?: string;
  helpText?: string;
  required?: boolean;
  colSpan?: number;
  width?: number;
  options?: string[];
  columns?: Column[];
  minRows?: number;
};
type Section = { id?: string; title?: string; description?: string; fields?: Field[] };

export type TemplateFormValues = Record<string, unknown>;

const inputCls = "input";

function TableField({ field, value, onChange }: {
  field: Field;
  value: Record<string, string>[];
  onChange: (rows: Record<string, string>[]) => void;
}) {
  const cols = field.columns ?? [];
  const rows = Array.isArray(value) && value.length > 0
    ? value
    : Array.from({ length: field.minRows ?? 1 }, () => ({} as Record<string, string>));

  const update = (i: number, key: string, val: string) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, [key]: val } : r)));
  const addRow = () => onChange([...rows, {}]);
  const removeRow = (i: number) => onChange(rows.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      <label className="mb-1 block text-xs font-semibold text-foreground">{field.label}</label>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {cols.map((c, i) => (
                <th key={c.id ?? i} className="border-r border-border/60 px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground last:border-0">
                  {c.label}{c.required && <span className="ml-0.5 text-red-500">*</span>}
                </th>
              ))}
              <th className="w-8 px-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-b border-border/50 last:border-0">
                {cols.map((c, ci) => {
                  const key = c.key ?? `col_${ci}`;
                  return (
                    <td key={c.id ?? ci} className="border-r border-border/40 px-2 py-1 last:border-0">
                      {c.type === "select" && c.options ? (
                        <select value={row[key] ?? ""} onChange={(e) => update(ri, key, e.target.value)}
                                className="w-full bg-transparent text-sm outline-none">
                          <option value="">—</option>
                          {c.options.map((o) => <option key={o} value={o}>{o}</option>)}
                        </select>
                      ) : (
                        <input
                          type={c.type === "number" || c.type === "currency" ? "number" : c.type === "date" ? "date" : "text"}
                          value={row[key] ?? ""}
                          onChange={(e) => update(ri, key, e.target.value)}
                          className="w-full bg-transparent py-0.5 text-sm outline-none"
                          placeholder={c.type === "currency" ? "0.00" : ""}
                        />
                      )}
                    </td>
                  );
                })}
                <td className="px-1 text-center">
                  {rows.length > 1 && (
                    <button type="button" onClick={() => removeRow(ri)}
                            className="text-muted-foreground hover:text-red-500" title="Remove row">×</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button type="button" onClick={addRow}
              className="text-xs font-semibold text-primary hover:text-primary/80">+ Add row</button>
    </div>
  );
}

function FormField({ field, value, onChange }: {
  field: Field;
  value: unknown;
  onChange: (val: unknown) => void;
}) {
  const type = field.type ?? "text";
  const label = field.label ?? field.key ?? "Field";
  const help = field.help_text ?? field.helpText;
  const span = (field.colSpan ?? field.width ?? 6) >= 8 ? "sm:col-span-2" : "sm:col-span-1";

  if (type === "divider") return <hr className="my-1 border-border sm:col-span-2" />;
  if (type === "heading")
    return <h4 className="border-b border-border pb-1 pt-2 text-sm font-bold text-foreground sm:col-span-2">{label}</h4>;
  if (type === "table")
    return (
      <div className="sm:col-span-2">
        <TableField field={field} value={Array.isArray(value) ? (value as Record<string, string>[]) : []} onChange={onChange} />
      </div>
    );

  if (type === "boolean" || type === "checkbox") {
    return (
      <label className={`flex items-center gap-2.5 text-sm text-foreground ${span}`}>
        <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)}
               className="h-4 w-4 rounded border-border text-primary" />
        {label}{field.required && <span className="text-red-500">*</span>}
      </label>
    );
  }

  let control: ReactNode;
  switch (type) {
    case "textarea":
      control = <textarea value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} rows={3} placeholder={field.placeholder} className={`${inputCls} resize-y`} />;
      break;
    case "select":
    case "multi_select":
      control = (
        <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputCls}>
          <option value="">Select an option…</option>
          {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
      break;
    case "radio":
      control = (
        <div className="flex flex-col gap-1.5 pt-1">
          {(field.options ?? []).map((o) => (
            <label key={o} className="flex items-center gap-2 text-sm text-foreground">
              <input type="radio" name={field.key} value={o} checked={value === o} onChange={() => onChange(o)} className="h-4 w-4 text-primary" />{o}
            </label>
          ))}
        </div>
      );
      break;
    case "currency":
      control = (
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">KSh</span>
          <input type="number" step="0.01" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder="0.00" className={`${inputCls} pl-12`} />
        </div>
      );
      break;
    case "number":   control = <input type="number" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} className={inputCls} />; break;
    case "date":     control = <input type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputCls} />; break;
    case "datetime": control = <input type="datetime-local" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputCls} />; break;
    case "time":     control = <input type="time" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={inputCls} />; break;
    case "email":    control = <input type="email" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? "name@company.com"} className={inputCls} />; break;
    case "phone":    control = <input type="tel" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? "+254 700 000000"} className={inputCls} />; break;
    default:         control = <input type="text" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} className={inputCls} />;
  }

  return (
    <div className={span}>
      <label className="mb-1.5 block text-xs font-semibold text-foreground">
        {label}{field.required && <span className="ml-1 text-red-500">*</span>}
        {help && <span className="ml-2 text-[11px] font-normal text-muted-foreground">{help}</span>}
      </label>
      {control}
    </div>
  );
}

export default function TemplateForm({ sections, values, onChange, readOnly = false }: {
  sections: unknown[];
  values: TemplateFormValues;
  onChange: (key: string, value: unknown) => void;
  readOnly?: boolean;
}) {
  const list = (Array.isArray(sections) ? sections : []) as Section[];
  return (
    <div className={`space-y-6 ${readOnly ? "pointer-events-none opacity-90" : ""}`}>
      {list.map((section, si) => (
        <div key={section.id ?? si}>
          <div className="mb-3">
            <h3 className="text-sm font-bold text-foreground">{section.title ?? `Section ${si + 1}`}</h3>
            {section.description && <p className="mt-0.5 text-xs text-muted-foreground">{section.description}</p>}
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            {(section.fields ?? []).map((f, fi) => (
              <FormField
                key={f.id ?? fi}
                field={f}
                value={values[f.key ?? ""]}
                onChange={(val) => f.key && onChange(f.key, val)}
              />
            ))}
          </div>
        </div>
      ))}
      {list.length === 0 && <p className="text-sm text-muted-foreground">This form has no fields.</p>}
    </div>
  );
}

/** Collect required field keys (incl. nothing for layout/table) for validation. */
export function requiredFieldLabels(sections: unknown[], values: TemplateFormValues): string[] {
  const list = (Array.isArray(sections) ? sections : []) as Section[];
  const missing: string[] = [];
  for (const s of list) {
    for (const f of s.fields ?? []) {
      const type = f.type ?? "text";
      if (!f.required || type === "divider" || type === "heading" || type === "table") continue;
      const v = values[f.key ?? ""];
      const empty = v === undefined || v === null || (typeof v === "string" && v.trim() === "") || (typeof v === "boolean" && v === false);
      if (empty) missing.push(f.label ?? f.key ?? "Field");
    }
  }
  return missing;
}
