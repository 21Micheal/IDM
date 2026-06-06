/**
 * TemplateForm — Finansys Unifi-style interactive renderer for a BUILT template.
 *
 * v2.0 — Full rewrite:
 *  - 12-column CSS grid with per-field colSpan (1–12) from builder
 *  - react-hook-form with full validation (required, regex, min/max, length)
 *  - Conditional visibility via visibleWhen rules
 *  - All field types: text, textarea, number, currency, date, datetime, time,
 *    email, phone, select, multi_select, radio, boolean, file, image, signature,
 *    reference, user, heading, divider, table
 *  - Table columns fully typed (currency symbol, select options, boolean, etc.)
 *  - Same public API as v1 — callers (UploadPage, DocumentDetailPage) need zero changes
 */
import { useState, useEffect, useRef } from "react";
import { useForm, Controller } from "react-hook-form";
import { AlertCircle, Pencil, Paperclip, Plus, Trash2 } from "lucide-react";
import type { ReactNode } from "react";

// ── Types ─────────────────────────────────────────────────────────────────────

type ColType =
  | "text" | "textarea" | "number" | "currency" | "date" | "datetime" | "time"
  | "select" | "boolean" | "email" | "phone" | "reference" | "user" | "file";

type Column = {
  id?: string; key?: string; label?: string; required?: boolean;
  type?: ColType | string; options?: string[]; currencySymbol?: string;
  tooltip?: string; additionalText?: string; readonly?: boolean; hidden?: boolean;
  defaultValue?: string;
};

type VisibleWhen = {
  fieldKey: string;
  operator: "equals" | "not_equals" | "is_empty" | "is_not_empty" | string;
  value?: string;
};

type Field = {
  id?: string; key?: string; type?: string; label?: string;
  placeholder?: string; help_text?: string; helpText?: string;
  required?: boolean; colSpan?: number; width?: number;
  options?: string[]; columns?: Column[]; minRows?: number;
  currencySymbol?: string; referenceSource?: string; tooltip?: string; regex?: string;
  min?: number; max?: number; minLength?: number; maxLength?: number;
  defaultValue?: string; readonly?: boolean; hidden?: boolean;
  visibleWhen?: VisibleWhen | null;
};

type Section = { id?: string; title?: string; description?: string; fields?: Field[] };

export type TemplateFormValues = Record<string, unknown>;

// ── Conditional visibility ────────────────────────────────────────────────────

function evalVisible(field: Field, values: TemplateFormValues, allFields: Field[]): boolean {
  if (!field.visibleWhen) return true;
  const rule = field.visibleWhen;
  const sib = allFields.find((f) => f.key === rule.fieldKey);
  if (!sib) return true;
  const v = values[sib.key ?? ""];
  const sv = v == null ? "" : String(v);
  switch (rule.operator) {
    case "equals":       return sv === (rule.value ?? "");
    case "not_equals":   return sv !== (rule.value ?? "");
    case "is_empty":     return sv.trim() === "";
    case "is_not_empty": return sv.trim() !== "";
    default:             return true;
  }
}

// ── Table column cell ─────────────────────────────────────────────────────────

function TableColInput({ col, value, onChange, readOnly }: {
  col: Column; value: string; onChange: (v: string) => void; readOnly?: boolean;
}) {
  const base = "w-full bg-transparent py-0.5 text-sm outline-none text-foreground placeholder:text-muted-foreground/50";
  if (col.hidden) return null;
  const type = (col.type ?? "text") as ColType;
  const dis = readOnly || col.readonly;

  switch (type) {
    case "select":
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} disabled={dis} className={base}>
          <option value="">—</option>
          {(col.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case "boolean":
      return <input type="checkbox" checked={value === "true"} disabled={dis} onChange={(e) => onChange(e.target.checked ? "true" : "false")} className="h-4 w-4 accent-primary" />;
    case "textarea":
      return <textarea rows={1} value={value} disabled={dis} onChange={(e) => onChange(e.target.value)} className={`${base} resize-none`} />;
    case "currency":
      return (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground flex-shrink-0">{col.currencySymbol ?? "KSh"}</span>
          <input type="number" step="0.01" value={value} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} placeholder="0.00" />
        </div>
      );
    case "number":
      return <input type="number" value={value} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "date":
      return <input type="date" value={value} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "datetime":
      return <input type="datetime-local" value={value} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "time":
      return <input type="time" value={value} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "email":
      return <input type="email" value={value} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "phone":
      return <input type="tel" value={value} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "reference":
    case "user":
      return (
        <select value={value} onChange={(e) => onChange(e.target.value)} disabled={dis} className={base}>
          <option value="">Select…</option>
          <option value="sample-1">Sample 1</option>
          <option value="sample-2">Sample 2</option>
        </select>
      );
    case "file":
      return <input type="file" disabled={dis} className="text-xs w-full" onChange={() => {}} />;
    default:
      return <input type="text" value={value} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
  }
}

// ── Table field ───────────────────────────────────────────────────────────────

function TableField({ field, value, onChange, readOnly }: {
  field: Field;
  value: Record<string, string>[];
  onChange: (rows: Record<string, string>[]) => void;
  readOnly?: boolean;
}) {
  const cols = (field.columns ?? []).filter((c) => !c.hidden);
  const emptyRow = (): Record<string, string> => {
    const r: Record<string, string> = {};
    cols.forEach((c) => { if (c.defaultValue && c.key) r[c.key] = c.defaultValue; });
    return r;
  };
  const [rows, setRows] = useState<Record<string, string>[]>(() =>
    Array.isArray(value) && value.length > 0
      ? value
      : Array.from({ length: field.minRows ?? 1 }, emptyRow)
  );

  const update = (ri: number, key: string, val: string) => {
    const next = rows.map((r, i) => i === ri ? { ...r, [key]: val } : r);
    setRows(next); onChange(next);
  };
  const addRow = () => { const next = [...rows, emptyRow()]; setRows(next); onChange(next); };
  const removeRow = (i: number) => { const next = rows.filter((_, idx) => idx !== i); setRows(next); onChange(next); };

  return (
    <div className="col-span-12 space-y-2">
      <div className="text-xs font-semibold text-foreground">
        {field.label}
        {field.required && <span className="ml-1 text-red-500">*</span>}
        {(field.helpText ?? field.help_text) && (
          <span className="ml-2 font-normal text-muted-foreground">{field.helpText ?? field.help_text}</span>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {cols.map((col, i) => (
                <th key={col.id ?? i} title={col.tooltip}
                    className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground border-r border-border/50 last:border-0 whitespace-nowrap">
                  {col.label}{col.required && <span className="text-red-400 ml-0.5">*</span>}
                  {col.additionalText && <div className="text-[10px] font-normal opacity-70">{col.additionalText}</div>}
                </th>
              ))}
              {!readOnly && <th className="w-8" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-b border-border/40 last:border-0 hover:bg-muted/20 transition-colors">
                {cols.map((col, ci) => {
                  const key = col.key ?? `col_${ci}`;
                  return (
                    <td key={col.id ?? ci} className="px-2 py-1.5 border-r border-border/30 last:border-0">
                      <TableColInput col={col} value={row[key] ?? ""} onChange={(v) => update(ri, key, v)} readOnly={readOnly} />
                    </td>
                  );
                })}
                {!readOnly && (
                  <td className="px-1 text-center">
                    {rows.length > 1 && (
                      <button type="button" onClick={() => removeRow(ri)} className="p-0.5 text-muted-foreground hover:text-red-500 transition-colors rounded">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <button type="button" onClick={addRow} className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors">
          <Plus className="h-3.5 w-3.5" /> Add row
        </button>
      )}
    </div>
  );
}

// ── Single form field ─────────────────────────────────────────────────────────

const inp = "input";
const errCls = "mt-1 flex items-center gap-1 text-xs text-red-500";

function FormField({ field, control, errors, onChangeCb, readOnly, allValues }: {
  field: Field;
  control: any;
  errors: Record<string, any>;
  onChangeCb: (key: string, val: unknown) => void;
  readOnly?: boolean;
  allValues: TemplateFormValues;
}) {
  const key  = field.key ?? field.id ?? "";
  const type = field.type ?? "text";
  const label = field.label ?? key;
  const help  = field.helpText ?? field.help_text;
  const span  = Math.min(12, Math.max(1, field.colSpan ?? field.width ?? 6));
  const style = { gridColumn: `span ${span} / span ${span}` };
  const dis   = readOnly || field.readonly;
  const err   = errors[key]?.message as string | undefined;

  if (field.hidden) return null;

  // Layout-only elements
  if (type === "heading") return (
    <div style={{ gridColumn: "span 12 / span 12" }}>
      <h4 className="border-b border-border pb-1.5 pt-2 text-sm font-bold text-foreground">{label}</h4>
    </div>
  );
  if (type === "divider") return <div style={{ gridColumn: "span 12 / span 12" }}><hr className="border-border" /></div>;

  // Table handled separately (needs full width + local state)
  if (type === "table") return (
    <TableField
      field={field}
      value={Array.isArray(allValues[key]) ? (allValues[key] as Record<string, string>[]) : []}
      onChange={(rows) => onChangeCb(key, rows)}
      readOnly={readOnly}
    />
  );

  // Validation rules
  const rules: Record<string, any> = {};
  if (field.required && !readOnly && type !== "boolean" && type !== "checkbox")
    rules.required = `${label} is required`;
  if (field.regex)
    rules.pattern = { value: new RegExp(field.regex), message: "Invalid format" };
  if (field.minLength !== undefined)
    rules.minLength = { value: field.minLength, message: `Minimum ${field.minLength} characters` };
  if (field.maxLength !== undefined)
    rules.maxLength = { value: field.maxLength, message: `Maximum ${field.maxLength} characters` };
  if (field.min !== undefined)
    rules.min = { value: field.min, message: `Minimum value: ${field.min}` };
  if (field.max !== undefined)
    rules.max = { value: field.max, message: `Maximum value: ${field.max}` };

  // Checkbox / boolean — inline label layout
  if (type === "boolean" || type === "checkbox") {
    return (
      <div style={style}>
        <Controller control={control} name={key} render={({ field: f }) => (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground">
            <input type="checkbox" checked={Boolean(f.value)} disabled={dis}
              className="h-4 w-4 rounded border-border accent-primary"
              onChange={(e) => { f.onChange(e.target.checked); onChangeCb(key, e.target.checked); }} />
            {label}
            {field.required && <span className="text-red-500">*</span>}
          </label>
        )} />
      </div>
    );
  }

  // Shared label element
  const labelEl = (
    <label className="mb-1.5 block text-xs font-semibold text-foreground">
      {label}
      {field.required && <span className="ml-1 text-red-500">*</span>}
      {field.tooltip && <span className="ml-1 cursor-help text-muted-foreground" title={field.tooltip}>(?)</span>}
      {help && <span className="ml-2 font-normal text-muted-foreground">{help}</span>}
    </label>
  );

  // Static / non-interactive types
  if (type === "signature") {
    return (
      <div style={style}>
        {labelEl}
        <div className="flex h-16 items-center justify-center rounded-lg border-2 border-dashed border-border text-sm text-muted-foreground">
          <Pencil className="mr-2 h-4 w-4" /> Click to sign
        </div>
      </div>
    );
  }
  if (type === "file" || type === "image") {
    return (
      <div style={style}>
        {labelEl}
        <div className="flex items-center justify-center rounded-lg border-2 border-dashed border-border bg-muted/20 p-4">
          <label className="flex cursor-pointer flex-col items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors">
            <Paperclip className="h-5 w-5" />
            <span>Click to {type === "image" ? "upload image" : "attach file"}</span>
            <input type="file" accept={type === "image" ? "image/*" : undefined} disabled={dis} className="sr-only" onChange={() => {}} />
          </label>
        </div>
      </div>
    );
  }

  // All other types via Controller
  let control_el: ReactNode;
  switch (type) {
    case "textarea":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <textarea {...f} value={String(f.value ?? "")} disabled={dis} placeholder={field.placeholder}
            rows={4} className={`${inp} resize-y`}
            onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }} />
        )} />
      );
      break;

    case "select":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <select {...f} value={String(f.value ?? "")} disabled={dis} className={inp}
            onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }}>
            <option value="">{field.placeholder ?? "Select an option…"}</option>
            {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )} />
      );
      break;

    case "multi_select":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <select multiple value={Array.isArray(f.value) ? f.value as string[] : []} disabled={dis}
            className={`${inp} h-auto min-h-[80px] py-2`}
            onChange={(e) => {
              const sel = Array.from(e.target.selectedOptions).map((o) => o.value);
              f.onChange(sel); onChangeCb(key, sel);
            }}>
            {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )} />
      );
      break;

    case "radio":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <div className="flex flex-col gap-2 pt-1">
            {(field.options ?? []).map((o) => (
              <label key={o} className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground">
                <input type="radio" value={o} checked={f.value === o} disabled={dis} className="h-4 w-4 accent-primary"
                  onChange={() => { f.onChange(o); onChangeCb(key, o); }} />
                {o}
              </label>
            ))}
          </div>
        )} />
      );
      break;

    case "currency":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
              {field.currencySymbol ?? "KSh"}
            </span>
            <input type="number" step="0.01" value={String(f.value ?? "")} disabled={dis}
              placeholder="0.00" min={field.min} max={field.max}
              className={`${inp} pl-14`}
              onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }} />
          </div>
        )} />
      );
      break;

    case "reference":
    case "user":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <select {...f} value={String(f.value ?? "")} disabled={dis} className={inp}
            onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }}>
            <option value="">Select {field.referenceSource ?? "…"}</option>
            <option value="sample-1">Sample 1</option>
            <option value="sample-2">Sample 2</option>
          </select>
        )} />
      );
      break;

    default: {
      // text, number, email, phone, date, datetime, time
      const htmlType =
        type === "number" ? "number"
        : type === "email" ? "email"
        : type === "phone" ? "tel"
        : type === "date" ? "date"
        : type === "datetime" ? "datetime-local"
        : type === "time" ? "time"
        : "text";
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <input type={htmlType} value={String(f.value ?? "")} disabled={dis}
            placeholder={field.placeholder} min={field.min} max={field.max}
            maxLength={field.maxLength} className={inp}
            onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }} />
        )} />
      );
    }
  }

  return (
    <div style={style}>
      {labelEl}
      {control_el}
      {err && (
        <p className={errCls}><AlertCircle className="h-3 w-3 flex-shrink-0" />{err}</p>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function TemplateForm({ sections, values, onChange, readOnly = false }: {
  sections: unknown[];
  values: TemplateFormValues;
  onChange: (key: string, value: unknown) => void;
  readOnly?: boolean;
}) {
  const list = (Array.isArray(sections) ? sections : []) as Section[];
  const allFields = list.flatMap((s) => s.fields ?? []);

  // Derive a stable key from section IDs so we can detect template changes
  const sectionsKey = list.map((s) => s.id ?? "").join("|");
  const prevKeyRef = useRef(sectionsKey);

  const { control, formState: { errors }, reset, watch } = useForm<TemplateFormValues>({
    defaultValues: values,
    mode: "onBlur",
  });

  // When a different template is loaded (sections change), reset the form
  useEffect(() => {
    if (prevKeyRef.current !== sectionsKey) {
      prevKeyRef.current = sectionsKey;
      reset({});
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sectionsKey]);

  // Keep a live snapshot of form values for conditional visibility
  const liveValues = watch();

  if (list.length === 0) {
    return <p className="text-sm text-muted-foreground">This form has no fields.</p>;
  }

  return (
    <div className={`space-y-6 ${readOnly ? "pointer-events-none opacity-90" : ""}`}>
      {list.map((section, si) => {
        const visibleFields = (section.fields ?? []).filter((f) =>
          evalVisible(f, liveValues as TemplateFormValues, allFields)
        );
        return (
          <div key={section.id ?? si} className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            {/* Section header */}
            <div className="border-b border-border bg-muted/40 px-5 py-3">
              <h3 className="text-sm font-bold text-foreground">{section.title ?? `Section ${si + 1}`}</h3>
              {section.description && (
                <p className="mt-0.5 text-xs text-muted-foreground">{section.description}</p>
              )}
            </div>
            {/* Fields — 12-column grid */}
            <div className="p-5 grid grid-cols-12 gap-x-4 gap-y-5">
              {visibleFields.map((f, fi) => (
                <FormField
                  key={f.id ?? fi}
                  field={f}
                  control={control}
                  errors={errors as Record<string, any>}
                  onChangeCb={onChange}
                  readOnly={readOnly}
                  allValues={liveValues as TemplateFormValues}
                />
              ))}
              {visibleFields.length === 0 && (
                <p className="col-span-12 text-sm text-muted-foreground">No fields in this section.</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Validation helper (unchanged signature) ───────────────────────────────────

/** Returns labels of required fields that are missing or fail basic validation. */
export function requiredFieldLabels(sections: unknown[], values: TemplateFormValues): string[] {
  const list = (Array.isArray(sections) ? sections : []) as Section[];
  const missing: string[] = [];
  for (const s of list) {
    for (const f of s.fields ?? []) {
      const type = f.type ?? "text";
      if (type === "divider" || type === "heading") continue;
      const key = f.key ?? "";
      const v   = values[key];
      if (f.required) {
        const empty =
          v === undefined || v === null ||
          (typeof v === "string" && v.trim() === "") ||
          (typeof v === "boolean" && !v) ||
          (Array.isArray(v) && v.length === 0);
        if (empty) { missing.push(f.label ?? key); continue; }
      }
      // Regex validation
      if (f.regex && typeof v === "string" && v) {
        try {
          if (!new RegExp(f.regex).test(v)) missing.push(`${f.label ?? key} (invalid format)`);
        } catch { /* bad regex — skip */ }
      }
    }
  }
  return missing;
}
