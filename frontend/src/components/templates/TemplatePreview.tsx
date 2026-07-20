/**
 * TemplatePreview — read-only visual preview of a document template.
 *
 * Used wherever a user picks a template and needs to confirm they chose the
 * right one (upload page "Template source" panel, fill modal, etc.).
 *
 *  - built templates    → renders the actual form layout (sections + fields)
 *                         read-only, NOT a PDF conversion.
 *  - uploaded templates → a file card plus the {{placeholders}} that will be
 *                         filled, so users recognise the Office file.
 *
 * Types are intentionally permissive so callers can pass loosely-typed
 * template data (e.g. sections typed as unknown[]).
 */
import { FileText } from "lucide-react";
import clsx from "clsx";
import type { ReactNode } from "react";

type PreviewColumn = { id?: string; key?: string; label?: string; type?: string };
type PreviewField = {
  id?: string;
  key?: string;
  type?: string;
  label?: string;
  placeholder?: string;
  required?: boolean;
  colSpan?: number;
  width?: number;
  options?: string[];
  columns?: PreviewColumn[];
  minRows?: number;
  hidden?: boolean;
  visibleWhen?: VisibleWhen | null;
};
type PreviewSection = {
  id?: string;
  title?: string;
  description?: string;
  fields?: PreviewField[];
  hidden?: boolean;
  visibleWhen?: VisibleWhen | null;
};
export type PreviewTemplate = {
  name: string;
  type: "built" | "uploaded";
  description?: string;
  file_name?: string;
  file_url?: string;
  placeholders?: string[];
  sections?: unknown[];
};

type ConditionOperator = "equals" | "not_equals" | "is_empty" | "is_not_empty" | string;

type VisibilityCondition = {
  source?: "field" | "process_step";
  fieldKey?: string;
  operator: ConditionOperator;
  value?: string;
};

type VisibleWhen =
  | { combinator?: "and" | "or"; conditions?: VisibilityCondition[] }
  | { fieldKey: string; operator: ConditionOperator; value?: string };

function ruleConditions(vw?: VisibleWhen | null): { combinator: "and" | "or"; conditions: VisibilityCondition[] } | null {
  if (!vw || typeof vw !== "object") return null;
  const obj = vw as Record<string, unknown>;
  if (Array.isArray(obj.conditions)) {
    return { combinator: obj.combinator === "or" ? "or" : "and", conditions: obj.conditions as VisibilityCondition[] };
  }
  if (typeof obj.fieldKey === "string") {
    return { combinator: "and", conditions: [{ source: "field", fieldKey: obj.fieldKey as string, operator: obj.operator as ConditionOperator, value: obj.value as string | undefined }] };
  }
  return null;
}

function evalCondition(c: VisibilityCondition, values: Record<string, unknown>, allFields: PreviewField[], processStep: string): boolean {
  let sv: string;
  if (c.source === "process_step") {
    sv = processStep;
  } else {
    const sib = allFields.find((f) => f.key === c.fieldKey);
    if (!sib) return true;
    const v = values[sib.key ?? ""];
    sv = v == null ? "" : String(v);
  }
  switch (c.operator) {
    case "equals":       return sv === (c.value ?? "");
    case "not_equals":   return sv !== (c.value ?? "");
    case "is_empty":     return sv.trim() === "";
    case "is_not_empty": return sv.trim() !== "";
    default:             return true;
  }
}

function evalVisible(
  item: { hidden?: boolean; visibleWhen?: VisibleWhen | null },
  values: Record<string, unknown>,
  allFields: PreviewField[],
  processStep = "draft",
): boolean {
  if (item.hidden) return false;
  const g = ruleConditions(item.visibleWhen);
  if (!g || g.conditions.length === 0) return true;
  const results = g.conditions.map((c) => evalCondition(c, values, allFields, processStep));
  return g.combinator === "or" ? results.some(Boolean) : results.every(Boolean);
}

function PreviewField({ field, isBuiltTemplate }: { field: PreviewField; isBuiltTemplate: boolean }) {
  const box = `w-full ${isBuiltTemplate ? "border border-slate-200 bg-slate-50" : "rounded border border-slate-200 bg-slate-50"} px-2.5 py-1.5 text-xs text-slate-400`;
  const type = field.type ?? "text";
  const label = field.label ?? field.key ?? "Field";

  if (type === "divider") return <hr className="col-span-2 my-1 border-slate-200" />;
  if (type === "heading")
    return <div className="col-span-2 border-b border-slate-100 pb-1 pt-1 text-xs font-bold text-slate-700">{label}</div>;

  const span = (field.colSpan ?? field.width ?? 6) >= 8 ? "col-span-2" : "col-span-1";

  if (type === "table") {
    const cols = field.columns ?? [];
    return (
      <div className="col-span-2 space-y-1">
        <div className="text-[11px] font-semibold text-slate-500">{label}</div>
        <div className="overflow-hidden rounded border border-slate-200">
          <div className="flex bg-slate-100">
            {cols.map((c, i) => (
              <div key={c.id ?? i} className="flex-1 truncate border-r border-slate-200 px-2 py-1 text-[10px] font-semibold text-slate-500 last:border-0">{c.label}</div>
            ))}
          </div>
          {Array.from({ length: Math.min(field.minRows ?? 2, 2) }).map((_, r) => (
            <div key={r} className="flex border-t border-slate-100">
              {cols.map((c, i) => <div key={c.id ?? i} className="flex-1 border-r border-slate-100 px-2 py-1.5 text-[10px] text-slate-300 last:border-0">—</div>)}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (type === "boolean" || type === "checkbox") {
    return (
      <label className={clsx(span, "flex items-center gap-2 text-xs text-slate-500")}>
        <span className="h-3.5 w-3.5 rounded border border-slate-300 bg-white" />{label}
      </label>
    );
  }

  let control: ReactNode;
  switch (type) {
    case "textarea": control = <div className={clsx(box, "h-12")}>{field.placeholder || "Long text…"}</div>; break;
    case "select":
    case "multi_select":
    case "radio":    control = <div className={clsx(box, "flex items-center justify-between")}><span>{field.options?.[0] ?? "Select…"}</span><span>▾</span></div>; break;
    case "currency": control = <div className={box}>KSh 0.00</div>; break;
    case "file":
    case "image":    control = <div className={clsx(box, "text-center")}>Attach file</div>; break;
    case "signature":control = <div className={clsx(box, "flex h-10 items-center justify-center")}>Signature</div>; break;
    default:         control = <div className={box}>{field.placeholder || " "}</div>;
  }

  return (
    <div className={span}>
      <div className="mb-1 text-[11px] font-semibold text-slate-500">
        {label}{field.required && <span className="ml-0.5 text-red-400">*</span>}
      </div>
      {control}
    </div>
  );
}

export default function TemplatePreview({ template, values = {}, processStep }: { template: PreviewTemplate; values?: Record<string, unknown>; processStep?: string }) {
  const sections = (Array.isArray(template.sections) ? template.sections : []) as PreviewSection[];
  const allFields = sections.flatMap((section) => section.fields ?? []);
  const visibleSections = processStep
    ? sections
        .filter((section) => evalVisible(section, values, allFields, processStep))
        .map((section) => ({
          ...section,
          fields: (section.fields ?? []).filter((field) => evalVisible(field, values, allFields, processStep)),
        }))
        .filter((section) => (section.fields ?? []).length > 0)
    : sections;

  if (template.type === "uploaded") {
    const ext = (template.file_name?.split(".").pop() || "").toUpperCase();
    const count = template.placeholders?.length ?? 0;
    const isPdf = ext === "PDF";
    return (
      <div className="space-y-4">
        {template.file_url && isPdf ? (
          <div className="border border-slate-200 bg-white p-4">
            <iframe
              src={`${template.file_url}#toolbar=1&navpanes=0&scrollbar=1&view=FitV`}
              className="h-[400px] w-full bg-white"
              title="Template preview"
            />
          </div>
        ) : (
          <div className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white p-4">
            <div className="flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-lg bg-[#EEF6FB] text-[#287EAD]">
              <FileText className="h-6 w-6" />
            </div>
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold text-slate-800">{template.file_name || template.name}</p>
              <p className="text-xs text-slate-400">{ext || "Office"} template · {count} placeholder{count !== 1 ? "s" : ""}</p>
            </div>
          </div>
        )}
        {count > 0 && (
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">Placeholders</p>
            <div className="flex flex-wrap gap-1.5">
              {template.placeholders!.map((p) => (
                <span key={p} className="rounded-full bg-slate-100 px-2.5 py-1 font-mono text-[11px] text-slate-600">{`{{${p}}}`}</span>
              ))}
            </div>
          </div>
        )}
        <p className="text-xs text-slate-400">The generated document keeps the exact layout of this Office file — the placeholders above are replaced with the values you enter.</p>
      </div>
    );
  }

  const isBuiltTemplate = template.type === "built";
  return (
    <div className="space-y-5">
      {visibleSections.map((section, si) => (
        <div key={section.id ?? si}>
          <div className="mb-2">
            <h4 className="text-sm font-bold text-slate-700">{section.title ?? `Section ${si + 1}`}</h4>
            {section.description && <p className="text-[11px] text-slate-400">{section.description}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            {(section.fields ?? []).map((f, fi) => <PreviewField key={f.id ?? fi} field={f} isBuiltTemplate={isBuiltTemplate} />)}
          </div>
        </div>
      ))}
      {sections.length === 0 && (
        <p className="text-xs text-slate-400">This template has no fields to preview yet.</p>
      )}
    </div>
  );
}
