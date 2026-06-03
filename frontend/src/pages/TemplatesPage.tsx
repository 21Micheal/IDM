/**
 * TemplatesPage.tsx — Enterprise document template management
 *
 * Features:
 *  - List view with document type filtering, search, type filter
 *  - Builder mode (redirects to TemplateBuilderV2)
 *  - FillModal: handles both "built" templates (structured form) and
 *    "uploaded" templates (placeholder key→value form)
 *  - Table fields fully fillable inline
 *  - Duplicate template action
 *  - Preview step before creating document
 *  - Usage stats on card
 */

import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  Plus, Upload, X, Eye, FileText, Trash2,
  ChevronRight, Paperclip, Loader2, Copy,
  Search, LayoutTemplate, Wand2, CheckCircle, ArrowLeft,
  FileOutput, Pencil, Building2,
} from "lucide-react";
import { toast } from "react-toastify";
import clsx from "clsx";
import { templatesAPI, documentTypesAPI, normalizeListResponse } from "@/services/api";
import type { DocumentType } from "@/types";
import TemplateBuilderV2 from "@/pages/TemplateBuilderV2";

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type FieldType =
  | "text" | "textarea" | "number" | "currency" | "date" | "datetime" | "time" | "boolean"
  | "select" | "image" | "file" | "signature" | "table" | "divider" | "heading"
  | "radio" | "checkbox" | "email" | "phone";

export interface TableColumn {
  id: string;
  key: string;
  label: string;
  required?: boolean;
  type?: "text" | "number" | "currency" | "date" | "select";
  options?: string[];
  width?: number;
}

export interface TemplateField {
  id: string;
  key: string;
  type: FieldType;
  label: string;
  placeholder?: string;
  help_text?: string;
  helpText?: string;
  required?: boolean;
  width?: number;
  colSpan?: number;
  options?: string[];
  columns?: TableColumn[];
  defaultValue?: string;
  minRows?: number;
}

export interface TemplateSection {
  id: string;
  title: string;
  description?: string;
  fields: TemplateField[];
}

export interface Template {
  id?: string;
  name: string;
  description?: string;
  type: "built" | "uploaded";
  category?: string;
  tags?: string[];
  document_type?: string;
  document_type_id?: string;
  document_type_name?: string;
  document_type_code?: string;
  file_name?: string;
  file_url?: string;
  placeholders?: string[];
  created_at?: string;
  updated_at?: string;
  created_by?: { full_name: string };
  use_count?: number;
  sections: TemplateSection[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// CreateDocTypeModal — quick inline creation of a document type
// ─────────────────────────────────────────────────────────────────────────────

function toDocTypeCode(name: string): string {
  return name
    .toUpperCase()
    .trim()
    .replace(/\s+/g, "_")
    .replace(/[^A-Z0-9_]/g, "")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "");
}

function CreateDocTypeModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (type: DocumentType) => void;
}) {
  const qc = useQueryClient();
  const [name, setName]             = useState("");
  const [code, setCode]             = useState("");
  const [refPrefix, setRefPrefix]   = useState("");
  const [refPadding, setRefPadding] = useState(5);
  const [description, setDescription] = useState("");

  const iCls =
    "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] " +
    "outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

  const createMutation = useMutation({
    mutationFn: () =>
      documentTypesAPI.create({
        name,
        code,
        reference_prefix: refPrefix,
        reference_padding: refPadding,
        description,
        metadata_mode: "admin_defined",
        is_personal_type: false,
        metadata_fields: [],
        relationship_rules: [],
      }),
    onSuccess: ({ data }) => {
      toast.success(`Document type "${name}" created.`);
      qc.invalidateQueries({ queryKey: ["document-types"] });
      onCreated(data as DocumentType);
    },
    onError: (err: any) => {
      const d = err?.response?.data;
      const msg = d
        ? Object.entries(d as Record<string, unknown>)
            .map(([f, m]) => `${f}: ${Array.isArray(m) ? m.join(", ") : String(m)}`)
            .join(" | ")
        : "Failed to create document type.";
      toast.error(msg);
    },
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md border border-[#C8CDD2] bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-[#1E6F99] bg-[#287EAD] px-5 py-3 text-white">
          <div>
            <div className="flex items-center gap-2">
              <Building2 className="h-4 w-4 text-white/90" />
              <p className="font-semibold">Create document type</p>
            </div>
            <p className="mt-1 text-xs text-white/75">Metadata fields and relationships can be added later from Admin Document Types.</p>
          </div>
          <button onClick={onClose} className="mt-0.5 flex-shrink-0 text-white/70 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-4 p-5">

          {/* Display name */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870] mb-1.5">
              Display name <span className="text-red-500 normal-case font-normal">*</span>
            </label>
            <input
              value={name}
              onChange={(e) => { setName(e.target.value); setCode(toDocTypeCode(e.target.value)); }}
              placeholder="e.g. Supplier Invoice"
              autoFocus
              className={iCls}
            />
            <p className="mt-1.5 text-[11px] text-[#8C969E]">Human-readable name shown throughout the system</p>
          </div>

          {/* Code */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870] mb-1.5">
              Code <span className="text-red-500 normal-case font-normal">*</span>
            </label>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, ""))}
              placeholder="e.g. INV"
              className={`${iCls} font-mono`}
            />
            <p className="mt-1.5 text-[11px] text-[#8C969E]">Unique short system identifier — auto-filled from name, editable</p>
          </div>

          {/* Reference prefix */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870] mb-1.5">
              Reference prefix <span className="text-red-500 normal-case font-normal">*</span>
            </label>
            <input
              value={refPrefix}
              onChange={(e) => setRefPrefix(e.target.value.toUpperCase().replace(/\s+/g, "").replace(/[^A-Z0-9]/g, ""))}
              placeholder="e.g. INV"
              className={`${iCls} font-mono tracking-widest uppercase`}
            />
            <p className="mt-1.5 text-[11px] text-[#8C969E]">
              Prefix for auto-generated document IDs —{" "}
              <span className="font-mono font-semibold">INV</span> → <span className="font-mono">INV-00001</span>,{" "}
              <span className="font-mono font-semibold">PO</span> → <span className="font-mono">PO-00001</span>
            </p>
          </div>

          {/* Reference padding */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870] mb-1.5">Reference padding</label>
            <input
              type="number" min={3} max={8} value={refPadding}
              onChange={(e) => setRefPadding(Math.max(3, Math.min(8, Number(e.target.value))))}
              className={iCls}
            />
            <p className="mt-1.5 text-[11px] text-[#8C969E]">Digits in the numeric part of IDs (3–8) — 5 → 00001 · 4 → 0001</p>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[#5E6870] mb-1.5">
              Description <span className="normal-case font-normal text-[#8C969E]">(optional)</span>
            </label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={2}
              className="w-full resize-none border border-[#AEB5BB] bg-white px-3 py-2 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-[#C8CDD2] px-5 py-3">
          <button onClick={onClose}
                  className="border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">
            Cancel
          </button>
          <button
            onClick={() => createMutation.mutate()}
            disabled={!name.trim() || !code.trim() || !refPrefix.trim() || createMutation.isPending}
            className="flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50">
            {createMutation.isPending
              ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating…</>
              : <><Plus className="w-4 h-4" /> Create type</>}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TableFillField — line-items table in fill mode
// ─────────────────────────────────────────────────────────────────────────────

function TableFillField({ field, value, onChange }: {
  field: TemplateField;
  value: Record<string, string>[];
  onChange: (v: Record<string, string>[]) => void;
}) {
  const cols = field.columns ?? [];
  const rows = Array.isArray(value) && value.length > 0 ? value : Array.from({ length: field.minRows ?? 2 }, () => ({}));

  const update = (rowIdx: number, key: string, val: string) =>
    onChange(rows.map((r, i) => i === rowIdx ? { ...r, [key]: val } : r) as Record<string, string>[]);
  const addRow = () => onChange([...rows, {} as Record<string, string>]);
  const removeRow = (idx: number) => onChange(rows.filter((_, i) => i !== idx) as Record<string, string>[]);

  return (
    <div className="col-span-2 space-y-2">
      <label className="block text-xs font-semibold text-slate-600 mb-1.5">{field.label}</label>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        <table className="w-full text-xs min-w-full">
          <thead>
            <tr className="border-b border-slate-200 bg-slate-50">
              {cols.map((col) => (
                <th key={col.id} className="px-3 py-2.5 text-left text-[11px] font-semibold text-slate-500 border-r border-slate-100 last:border-0 whitespace-nowrap">
                  {col.label}{col.required && <span className="text-red-400 ml-0.5">*</span>}
                </th>
              ))}
              <th className="w-8 px-1" />
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIdx) => (
              <tr key={rowIdx} className="border-b border-slate-100 last:border-0 hover:bg-slate-50/50 transition-colors">
                {cols.map((col) => (
                  <td key={col.id} className="px-2 py-1.5 border-r border-slate-100 last:border-0">
                    {col.type === "select" && col.options ? (
                      <select value={(row as Record<string, string>)[col.key] ?? ""}
                              onChange={(e) => update(rowIdx, col.key, e.target.value)}
                              className="w-full bg-transparent text-xs outline-none text-slate-700 min-w-[80px]">
                        <option value="">—</option>
                        {col.options.map((o) => <option key={o} value={o}>{o}</option>)}
                      </select>
                    ) : (
                      <input
                        type={
                          col.type === "number" || col.type === "currency" ? "number" :
                          col.type === "date" ? "date" : "text"
                        }
                        value={(row as Record<string, string>)[col.key] ?? ""}
                        onChange={(e) => update(rowIdx, col.key, e.target.value)}
                        className="w-full bg-transparent text-xs outline-none text-slate-700 placeholder:text-slate-300 py-0.5 min-w-[60px]"
                        placeholder={col.type === "currency" ? "0.00" : ""}
                      />
                    )}
                  </td>
                ))}
                <td className="px-1 text-center">
                  {rows.length > 1 && (
                    <button onClick={() => removeRow(rowIdx)}
                            className="text-slate-300 hover:text-red-400 transition-colors p-0.5 rounded">
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button onClick={addRow}
              className="flex items-center gap-1.5 text-xs font-semibold text-indigo-600 hover:text-indigo-800 transition-colors py-1">
        <Plus className="h-3.5 w-3.5" /> Add row
      </button>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FillField — single field renderer in fill mode
// ─────────────────────────────────────────────────────────────────────────────

function FillField({ field, value, onChange }: {
  field: TemplateField;
  value: unknown;
  onChange: (v: unknown) => void;
}) {
  const iCls =
    "w-full border border-[#AEB5BB] bg-white px-3 py-2 text-sm text-[#1F2933] " +
    "outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD] placeholder:text-slate-300";

  if (field.type === "divider") return <hr className="border-slate-200 col-span-2" />;
  if (field.type === "heading") {
    return (
      <h3 className="col-span-2 text-sm font-bold text-slate-800 pt-2 pb-1 border-b border-slate-100">
        {field.label}
      </h3>
    );
  }
  if (field.type === "table") {
    return (
      <TableFillField
        field={field}
        value={Array.isArray(value) ? value as Record<string, string>[] : []}
        onChange={onChange}
      />
    );
  }

  const widthCls = (field.colSpan ?? field.width ?? 6) >= 8 ? "col-span-2" : "col-span-1";

  const renderInput = () => {
    switch (field.type) {
      case "textarea":
        return (
          <textarea value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}
                    rows={3} placeholder={field.placeholder} className={iCls} />
        );
      case "boolean":
      case "checkbox":
        return (
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input type="checkbox" checked={Boolean(value)} onChange={(e) => onChange(e.target.checked)}
                   className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-400" />
            <span className="text-sm text-slate-700">{field.label}</span>
          </label>
        );
      case "select":
        return (
          <select value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={iCls}>
            <option value="">Select an option…</option>
            {(field.options ?? []).map((opt) => <option key={opt} value={opt}>{opt}</option>)}
          </select>
        );
      case "radio":
        return (
          <div className="flex flex-col gap-2">
            {(field.options ?? []).map((opt) => (
              <label key={opt} className="flex items-center gap-2.5 cursor-pointer">
                <input type="radio" value={opt} checked={value === opt}
                       onChange={() => onChange(opt)}
                       className="w-4 h-4 text-indigo-600 border-slate-300 focus:ring-indigo-400" />
                <span className="text-sm text-slate-700">{opt}</span>
              </label>
            ))}
          </div>
        );
      case "date":
        return <input type="date" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={iCls} />;
      case "datetime":
        return <input type="datetime-local" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={iCls} />;
      case "time":
        return <input type="time" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} className={iCls} />;
      case "number":
        return <input type="number" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder} className={iCls} />;
      case "currency":
        return (
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-slate-400">KSh</span>
            <input type="number" step="0.01" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}
                   placeholder="0.00" className={clsx(iCls, "pl-12")} />
          </div>
        );
      case "email":
        return <input type="email" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? "name@company.com"} className={iCls} />;
      case "phone":
        return <input type="tel" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} placeholder={field.placeholder ?? "+254 700 000000"} className={iCls} />;
      case "image":
      case "file":
        return (
          <label className="flex h-20 cursor-pointer flex-col items-center justify-center border-2 border-dashed border-[#AEB5BB] hover:border-[#287EAD] hover:bg-[#F7FAFC]">
            <Paperclip className="w-4 h-4 text-slate-300 mb-1" />
            <span className="text-xs text-slate-400">Click to attach</span>
            <input type="file" className="hidden" onChange={(e) => onChange(e.target.files?.[0])} />
          </label>
        );
      case "signature":
        return (
          <div className="flex h-16 cursor-pointer items-center justify-center border-2 border-dashed border-[#AEB5BB] hover:border-[#287EAD] hover:bg-[#F7FAFC]">
            <Pencil className="w-4 h-4 text-slate-300 mr-2" />
            <span className="text-xs text-slate-400">Click to sign</span>
          </div>
        );
      default:
        return (
          <input type="text" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)}
                 placeholder={field.placeholder} className={iCls} />
        );
    }
  };

  return (
    <div className={widthCls}>
      {!["boolean", "checkbox", "table"].includes(field.type) && (
        <label className="block text-xs font-semibold text-slate-600 mb-1.5">
          {field.label}
          {field.required && <span className="text-red-500 ml-1">*</span>}
          {(field.help_text || field.helpText) && (
            <span className="font-normal text-slate-400 ml-2 text-[11px]">{field.help_text ?? field.helpText}</span>
          )}
        </label>
      )}
      {renderInput()}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UploadedTemplateFillForm — simple key→value form for uploaded templates
// ─────────────────────────────────────────────────────────────────────────────

function UploadedTemplateFillForm({ placeholders, values, onChange }: {
  placeholders: string[];
  values: Record<string, unknown>;
  onChange: (key: string, val: string) => void;
}) {
  const iCls =
    "w-full border border-[#AEB5BB] bg-white px-3 py-2 text-sm text-[#1F2933] " +
    "outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

  if (!placeholders.length) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-slate-400">
        <Wand2 className="w-8 h-8 mb-3 opacity-30" />
        <p className="text-sm">No placeholders detected in this template.</p>
        <p className="text-xs mt-1">The document will be generated as-is.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-2 gap-4">
      {placeholders.map((key) => (
        <div key={key}>
          <label className="block text-xs font-semibold text-slate-600 mb-1.5">
            {key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase())}
            <span className="font-normal text-slate-400 ml-2 font-mono text-[10px]">{`{{${key}}}`}</span>
          </label>
          <input
            type="text"
            value={String(values[key] ?? "")}
            onChange={(e) => onChange(key, e.target.value)}
            placeholder={`Enter ${key.replace(/_/g, " ")}`}
            className={iCls}
          />
        </div>
      ))}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// FillModal
// ─────────────────────────────────────────────────────────────────────────────

type FillStep = "fill" | "output";

function FillModal({ template, onClose, onSaved }: {
  template: Template;
  onClose: () => void;
  onSaved: (documentId: string) => void;
}) {
  const [step, setStep]               = useState<FillStep>("fill");
  const [values, setValues]           = useState<Record<string, unknown>>({});
  const [outputFormat, setOutputFormat] = useState<"pdf" | "docx">("pdf");
  const [docTitle, setDocTitle]       = useState(`${template.name} — ${new Date().toLocaleDateString("en-KE")}`);
  const [docType, setDocType] = useState(template.document_type_id || template.document_type || "");

  const { data: docTypes } = useQuery<DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => normalizeListResponse<DocumentType>(r.data as unknown)),
  });

  const saveMutation = useMutation({
    mutationFn: () =>
      templatesAPI.fillTemplate({
        template_id:      template.id!,
        values,
        output_format:    outputFormat,
        title:            docTitle,
        document_type_id: docType || undefined,
      }),
    onSuccess: ({ data }) => {
      toast.success("Document created from template");
      onSaved(data.document_id);
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail ?? err?.response?.data?.values ?? "Failed to create document";
      toast.error(typeof msg === "string" ? msg : JSON.stringify(msg));
    },
  });

  const validateFill = (): boolean => {
    if (template.type === "built") {
      const allFields = template.sections.flatMap((s) => s.fields);
      const missing = allFields.filter(
        (f) => f.required && !["divider", "heading"].includes(f.type) && !values[f.key]
      );
      if (missing.length) {
        toast.error(`Please fill in: ${missing.map((f) => f.label).join(", ")}`);
        return false;
      }
    }
    return true;
  };

  const isXlsx = template.file_name?.endsWith(".xlsx") || template.file_name?.endsWith(".xls");

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="flex max-h-[90vh] w-full max-w-3xl flex-col overflow-hidden border border-[#C8CDD2] bg-white shadow-2xl">

        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#1E6F99] bg-[#287EAD] px-5 py-3 text-white">
          <div className="flex items-center gap-3 min-w-0">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{template.name}</p>
              <div className="flex items-center gap-2 mt-0.5">
                <button onClick={() => setStep("fill")}
                        className={clsx("text-xs", step === "fill" ? "font-semibold text-white" : "text-white/65")}>
                  1. Fill fields
                </button>
                <ChevronRight className="h-3 w-3 text-white/55" />
                <span className={clsx("text-xs", step === "output" ? "font-semibold text-white" : "text-white/65")}>
                  2. Output options
                </span>
              </div>
            </div>
          </div>
          <button onClick={onClose} className="flex-shrink-0 text-white/70 hover:text-white">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Fill step */}
        {step === "fill" && (
          <>
            <div className="flex-1 overflow-y-auto p-6 space-y-6">
              {template.type === "uploaded" ? (
                <UploadedTemplateFillForm
                  placeholders={template.placeholders ?? []}
                  values={values}
                  onChange={(key, val) => setValues((prev) => ({ ...prev, [key]: val }))}
                />
              ) : (
                template.sections.map((section) => (
                  <div key={section.id}>
                    <div className="mb-4">
                      <h3 className="font-bold text-slate-800 text-sm">{section.title}</h3>
                      {section.description && (
                        <p className="text-xs text-slate-400 mt-0.5">{section.description}</p>
                      )}
                    </div>
                    <div className="grid grid-cols-2 gap-4">
                      {section.fields.map((field) => (
                        <FillField key={field.id} field={field}
                          value={values[field.key]}
                          onChange={(v) => setValues((prev) => ({ ...prev, [field.key]: v }))} />
                      ))}
                    </div>
                  </div>
                ))
              )}
            </div>
            <div className="flex items-center justify-between gap-3 border-t border-[#C8CDD2] px-5 py-3">
              <p className="text-xs text-slate-400">
                {template.type === "uploaded"
                  ? `${template.placeholders?.length ?? 0} placeholder${template.placeholders?.length !== 1 ? "s" : ""} to fill`
                  : `${template.sections.flatMap((s) => s.fields).filter((f) => f.required).length} required fields`}
              </p>
              <div className="flex gap-3">
                <button onClick={onClose}
                        className="border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">
                  Cancel
                </button>
                <button onClick={() => { if (validateFill()) setStep("output"); }}
                        className="flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99]">
                  Next: Output options <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </>
        )}

        {/* Output step */}
        {step === "output" && (
          <>
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">Document title</label>
                <input value={docTitle} onChange={(e) => setDocTitle(e.target.value)}
                       className="h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]" />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-1.5">
                  Document type <span className="font-normal text-slate-400">(optional)</span>
                </label>
                <select value={docType} onChange={(e) => setDocType(e.target.value)}
                        className="h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]">
                  <option value="">— None —</option>
                  {docTypes?.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-600 mb-2">Output format</label>
                <div className="grid grid-cols-2 gap-3">
                  {([
                    { value: "pdf",  label: "PDF",        icon: FileText,   desc: "Read-only · best for sharing & archiving", disabled: false },
                    { value: "docx", label: isXlsx ? "XLSX" : "Word",
                      icon: FileOutput, desc: isXlsx ? "Editable in Excel / LibreOffice" : "Editable in Word / LibreOffice", disabled: false },
                  ] as const).map(({ value, label, icon: Icon, desc }) => (
                    <button key={value} onClick={() => setOutputFormat(value as "pdf" | "docx")}
                            className={clsx(
                              "flex items-start gap-3 border-2 p-4 text-left transition-all",
                              outputFormat === value
                                ? "border-[#287EAD] bg-[#EEF6FB]"
                                : "border-[#C8CDD2] hover:border-[#287EAD]"
                            )}>
                      <Icon className={clsx("w-5 h-5 mt-0.5 flex-shrink-0", outputFormat === value ? "text-[#287EAD]" : "text-slate-400")} />
                      <div className="min-w-0">
                        <p className={clsx("text-sm font-bold", outputFormat === value ? "text-[#1F2933]" : "text-slate-700")}>{label}</p>
                        <p className="text-xs text-slate-400 mt-0.5 leading-snug">{desc}</p>
                      </div>
                      {outputFormat === value && <CheckCircle className="w-4 h-4 text-[#287EAD] ml-auto flex-shrink-0 mt-0.5" />}
                    </button>
                  ))}
                </div>
              </div>
            </div>

            <div className="flex justify-between gap-3 border-t border-[#C8CDD2] px-5 py-3">
              <button onClick={() => setStep("fill")}
                      className="flex items-center gap-2 border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">
                <ArrowLeft className="w-4 h-4" /> Back
              </button>
              <button
                onClick={() => saveMutation.mutate()}
                disabled={!docTitle.trim() || saveMutation.isPending}
                className="flex items-center gap-2 bg-[#287EAD] px-5 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50">
                {saveMutation.isPending
                  ? <><Loader2 className="w-4 h-4 animate-spin" /> Creating…</>
                  : <><FileOutput className="w-4 h-4" /> Create document</>}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// UploadTemplateModal
// ─────────────────────────────────────────────────────────────────────────────

function UploadTemplateModal({
  onClose,
  onDone,
  documentTypes,
}: {
  onClose: () => void;
  onDone: () => void;
  documentTypes: DocumentType[];
}) {
  const qc = useQueryClient();
  const [file, setFile]     = useState<File | null>(null);
  const [name, setName]     = useState("");
  const [desc, setDesc]     = useState("");
  const [documentTypeId, setDocumentTypeId] = useState("");
  const [isDrag, setIsDrag] = useState(false);
  const [showCreateType, setShowCreateType] = useState(false);

  const uploadMutation = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      fd.append("file", file!);
      fd.append("name", name || file!.name.replace(/\.[^.]+$/, ""));
      fd.append("description", desc);
      fd.append("type", "uploaded");
      fd.append("document_type", documentTypeId);
      return templatesAPI.create(fd);
    },
    onSuccess: () => {
      toast.success("Template uploaded — placeholders auto-detected.");
      qc.invalidateQueries({ queryKey: ["templates"] });
      onDone();
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.file ?? "Upload failed";
      toast.error(typeof msg === "string" ? msg : "Upload failed");
    },
  });

  const handleFile = (f: File) => {
    setFile(f);
    if (!name) setName(f.name.replace(/\.[^.]+$/, ""));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-xl border border-[#C8CDD2] bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-[#1E6F99] bg-[#287EAD] px-5 py-3 text-white">
          <div>
            <p className="text-sm font-semibold">Upload Office template</p>
            <p className="mt-0.5 text-xs text-white/75">Attach an Office file and bind it to a document type.</p>
          </div>
          <button onClick={onClose} className="text-white/70 hover:text-white"><X className="h-5 w-5" /></button>
        </div>

        <div className="space-y-4 p-5">
          {/* Drop zone */}
          <div
            onDragOver={(e) => { e.preventDefault(); setIsDrag(true); }}
            onDragLeave={() => setIsDrag(false)}
            onDrop={(e) => { e.preventDefault(); setIsDrag(false); const f = e.dataTransfer.files[0]; if (f) handleFile(f); }}
            className={clsx(
              "cursor-pointer border-2 border-dashed p-8 text-center transition-colors",
              isDrag ? "border-[#287EAD] bg-[#EEF6FB]" : "border-[#AEB5BB] hover:border-[#287EAD] hover:bg-[#F7FAFC]"
            )}
            onClick={() => document.getElementById("template-file-input")?.click()}
          >
            <input id="template-file-input" type="file" accept=".docx,.xlsx,.doc,.xls" className="hidden"
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            {file ? (
              <div className="space-y-1">
                <FileText className="mx-auto h-8 w-8 text-[#287EAD]" />
                <p className="text-sm font-semibold text-[#1F2933]">{file.name}</p>
                <p className="text-xs text-slate-400">{(file.size / 1024).toFixed(1)} KB</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Upload className="w-8 h-8 text-slate-300 mx-auto" />
                <p className="text-sm text-slate-500">Drop a DOCX or XLSX file here</p>
                <p className="text-xs text-slate-400">
                  Use <code className="bg-slate-100 px-1.5 rounded text-slate-600">{"{{field_name}}"}</code> in your document for auto-detected placeholders
                </p>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">Template name</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
                   className="h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]"
                   placeholder="e.g. Payment Voucher" />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">Document type</label>
            <div className="flex gap-2">
              <select value={documentTypeId} onChange={(e) => setDocumentTypeId(e.target.value)}
                      className="h-9 flex-1 border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]">
                <option value="">Select document type</option>
                {documentTypes.map((type) => <option key={type.id} value={type.id}>{type.name}</option>)}
              </select>
              <button
                type="button"
                onClick={() => setShowCreateType(true)}
                title="Create new document type"
                className="flex items-center gap-1.5 whitespace-nowrap border border-[#AEB5BB] bg-white px-3 py-2 text-xs font-semibold text-[#1F2933] hover:border-[#287EAD] hover:bg-[#EEF6FB] hover:text-[#287EAD]">
                <Plus className="w-3.5 h-3.5" /> New type
              </button>
            </div>
          </div>

          {showCreateType && (
            <CreateDocTypeModal
              onClose={() => setShowCreateType(false)}
              onCreated={(type) => {
                setDocumentTypeId(type.id);
                setShowCreateType(false);
              }}
            />
          )}

          <div>
            <label className="block text-xs font-semibold text-slate-600 mb-1.5">Description <span className="font-normal text-slate-400">(optional)</span></label>
            <textarea value={desc} onChange={(e) => setDesc(e.target.value)} rows={2}
                      className="w-full border border-[#AEB5BB] bg-white px-3 py-2 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]" />
          </div>

          <div className="flex items-start gap-2 border border-[#C8CDD2] bg-[#F7FAFC] p-3 text-xs text-[#5E6870]">
            <Wand2 className="w-4 h-4 flex-shrink-0 mt-0.5" />
            <span>
              Placeholders like <code className="bg-amber-100 px-1 rounded">{"{{supplier_name}}"}</code> are auto-detected.
              Users will fill them in when using the template.
            </span>
          </div>
        </div>

        <div className="flex justify-end gap-3 border-t border-[#C8CDD2] px-5 py-3">
          <button onClick={onClose}
                  className="border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">
            Cancel
          </button>
          <button onClick={() => uploadMutation.mutate()} disabled={!file || !documentTypeId || uploadMutation.isPending}
                  className="flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50">
            {uploadMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
            Upload template
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// TemplateRow
// ─────────────────────────────────────────────────────────────────────────────

function TemplateRow({ template, onPreview, onEdit, onDelete, onDuplicate }: {
  template: Template;
  onPreview: () => void; onEdit: () => void; onDelete: () => void; onDuplicate: () => void;
}) {
  const fieldCount   = template.sections?.flatMap((s) => s.fields).length ?? 0;
  const sectionCount = template.sections?.length ?? 0;
  const typeLabel    = template.document_type_name || template.document_type_code || "No document type";

  return (
    <tr className="border-b border-[#D3D7DA] bg-white hover:bg-[#F7FAFC]">
      <td className="w-[34%] px-4 py-3">
        <button type="button" onClick={onPreview} className="block max-w-full text-left">
          <span className="block truncate text-sm font-semibold text-[#287EAD]">{template.name}</span>
          <span className="mt-0.5 block truncate text-xs text-[#5E6870]">{template.description || "No description"}</span>
        </button>
      </td>
      <td className="px-4 py-3 text-sm text-[#1F2933]">{typeLabel}</td>
      <td className="px-4 py-3 text-sm text-[#1F2933]">{template.type === "uploaded" ? "Office" : "Builder"}</td>
      <td className="px-4 py-3 text-sm text-[#1F2933]">
        {template.type === "built"
          ? `${sectionCount} sections / ${fieldCount} fields`
          : `${template.placeholders?.length ?? 0} placeholders`}
      </td>
      <td className="px-4 py-3 text-sm text-[#1F2933]">{template.use_count ?? 0}</td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex items-center gap-1">
          <button type="button" onClick={onPreview} title="Preview" className="p-1.5 text-[#5E6870] hover:text-[#287EAD]">
            <Eye className="h-4 w-4" />
          </button>
          {template.type === "built" && (
            <button type="button" onClick={onEdit} title="Edit" className="p-1.5 text-[#5E6870] hover:text-[#287EAD]">
              <Pencil className="h-4 w-4" />
            </button>
          )}
          <button type="button" onClick={onDuplicate} title="Copy" className="p-1.5 text-[#5E6870] hover:text-[#287EAD]">
            <Copy className="h-4 w-4" />
          </button>
          <button type="button" onClick={onDelete} title="Delete" className="p-1.5 text-[#5E6870] hover:text-red-700">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main TemplatesPage
// ─────────────────────────────────────────────────────────────────────────────

type PageMode = "list" | "builder";

export default function TemplatesPage() {
  const qc       = useQueryClient();
  const navigate = useNavigate();

  const [mode, setMode]               = useState<PageMode>("list");
  const [editTarget, setEditTarget]   = useState<Template | undefined>(undefined);
  const [fillTarget, setFillTarget]   = useState<Template | null>(null);
  const [showUpload, setShowUpload]   = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter]   = useState<"all" | "built" | "uploaded">("all");
  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");

  // ── Data ────────────────────────────────────────────────────────────────

  const { data: templates, isLoading } = useQuery<Template[]>({
    queryKey: ["templates"],
    queryFn: () => templatesAPI.list().then((r) => {
      const raw = r.data.results ?? r.data;
      return raw.map((template: Template) => ({
        ...template,
        document_type_id: template.document_type_id || template.document_type,
      }));
    }),
  });

  const { data: docTypes = [] } = useQuery<unknown, Error, DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<DocumentType>(data),
  });

  const saveMutation = useMutation({
    mutationFn: (template: Template) => {
      const payload = {
        ...template,
        document_type: template.document_type_id,
      };
      return template.id
        ? templatesAPI.update(template.id, payload)
        : templatesAPI.create(payload);
    },
    onSuccess: () => {
      toast.success("Template saved");
      qc.invalidateQueries({ queryKey: ["templates"] });
      setMode("list");
      setEditTarget(undefined);
    },
    onError: () => toast.error("Failed to save template"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => templatesAPI.delete(id),
    onSuccess: () => { toast.success("Template deleted"); qc.invalidateQueries({ queryKey: ["templates"] }); },
    onError: () => toast.error("Failed to delete template"),
  });

  const duplicateMutation = useMutation({
    mutationFn: (id: string) => templatesAPI.duplicate(id),
    onSuccess: () => { toast.success("Template duplicated"); qc.invalidateQueries({ queryKey: ["templates"] }); },
    onError: () => toast.error("Failed to duplicate template"),
  });

  // ── Filtered list ───────────────────────────────────────────────────────

  const filtered = useMemo(() => {
    return (templates ?? []).filter((t) => {
      const matchesSearch = !searchQuery
        || t.name.toLowerCase().includes(searchQuery.toLowerCase())
        || t.description?.toLowerCase().includes(searchQuery.toLowerCase())
        || (t.tags ?? []).some((g) => g.includes(searchQuery.toLowerCase()));
      const matchesType = typeFilter === "all" || t.type === typeFilter;
      const templateDocType = t.document_type_id || t.document_type;
      const matchesDocType  = docTypeFilter === "all" || templateDocType === docTypeFilter;
      return matchesSearch && matchesType && matchesDocType;
    });
  }, [templates, searchQuery, typeFilter, docTypeFilter]);

  const docTypeCounts = useMemo(() => {
    const counts: Record<string, number> = { all: templates?.length ?? 0 };
    (templates ?? []).forEach((t) => {
      const key = t.document_type_id || t.document_type || "unassigned";
      counts[key] = (counts[key] ?? 0) + 1;
    });
    return counts;
  }, [templates]);

  // ── Builder mode ────────────────────────────────────────────────────────

  if (mode === "builder") {
    return (
      <TemplateBuilderV2
        initial={editTarget}
        documentTypes={docTypes}
        onSave={(tpl) => saveMutation.mutate(tpl)}
        onCancel={() => { setMode("list"); setEditTarget(undefined); }}
        isSaving={saveMutation.isPending}
      />
    );
  }

  // ── List mode ────────────────────────────────────────────────────────────

  return (
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#EDEDED] text-[#1F2933]">
      <div className="flex h-[69px] items-center justify-between bg-[#287EAD] px-5 pr-8 text-white">
        <div>
          <h1 className="text-xl font-semibold">Document Templates</h1>
          <p className="mt-0.5 text-xs text-white/75">Create and maintain document-type templates for upload workflows.</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowUpload(true)}
            className="inline-flex items-center gap-2 border border-white/25 px-3 py-2 text-sm font-semibold text-white hover:bg-white/10"
          >
            <Upload className="h-4 w-4" />
            Upload Template
          </button>
          <button
            type="button"
            onClick={() => { setEditTarget(undefined); setMode("builder"); }}
            className="inline-flex items-center gap-2 border border-white/25 px-3 py-2 text-sm font-semibold text-white hover:bg-white/10"
          >
            <Plus className="h-4 w-4" />
            New Template
          </button>
        </div>
      </div>

      <div className="grid min-h-[calc(100vh-7.8rem)] grid-cols-[290px_1fr]">
        <aside className="border-r border-[#C8CDD2] bg-[#F6F7F8]">
          <div className="border-b border-[#C8CDD2] p-3">
            <button
              type="button"
              onClick={() => setDocTypeFilter("all")}
              className={clsx(
                "flex w-full items-center justify-between border px-3 py-2 text-left text-sm",
                docTypeFilter === "all" ? "border-[#287EAD] bg-[#348FBE] font-semibold text-white" : "border-[#C8CDD2] bg-white text-[#1F2933] hover:bg-[#EEF3F7]",
              )}
            >
              <span className="flex items-center gap-2"><LayoutTemplate className="h-4 w-4" /> All templates</span>
              <span>{docTypeCounts.all ?? 0}</span>
            </button>
          </div>
          <div className="divide-y divide-[#D3D7DA]">
            {docTypes.map((type) => {
              const count = docTypeCounts[type.id] ?? 0;
              const active = docTypeFilter === type.id;
              return (
                <button
                  key={type.id}
                  type="button"
                  onClick={() => setDocTypeFilter(type.id)}
                  className={clsx(
                    "block w-full px-4 py-3 text-left text-sm",
                    active ? "bg-[#348FBE] font-semibold text-white" : "bg-[#F6F7F8] text-[#1F2933] hover:bg-white",
                  )}
                >
                  <span className="block truncate">{type.name}</span>
                  <span className={clsx("mt-1 block text-xs", active ? "text-white/80" : "text-[#5E6870]")}>
                    {type.code} · {count} template{count === 1 ? "" : "s"}
                  </span>
                </button>
              );
            })}
          </div>
        </aside>

        <main className="min-w-0 p-5 pr-8">
          <div className="border border-[#C8CDD2] bg-white">
            <div className="flex min-h-[58px] items-center justify-between gap-3 border-b border-[#C8CDD2] px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <div className="flex h-9 w-[320px] items-center gap-2 border border-[#C8CDD2] bg-white px-2">
                  <Search className="h-4 w-4 text-[#5E6870]" />
                  <input
                    value={searchQuery}
                    onChange={(event) => setSearchQuery(event.target.value)}
                    placeholder="Search templates or tags"
                    className="h-full min-w-0 flex-1 bg-transparent text-sm outline-none"
                  />
                </div>
                <div className="flex border border-[#C8CDD2]">
                  {(["all", "built", "uploaded"] as const).map((filter) => (
                    <button
                      key={filter}
                      type="button"
                      onClick={() => setTypeFilter(filter)}
                      className={clsx(
                        "border-r border-[#C8CDD2] px-3 py-2 text-xs font-semibold last:border-r-0",
                        typeFilter === filter ? "bg-[#EEF6FB] text-[#287EAD]" : "bg-white text-[#5E6870] hover:bg-[#F7F8F9]",
                      )}
                    >
                      {filter === "all" ? "All" : filter === "built" ? "Builder" : "Office"}
                    </button>
                  ))}
                </div>
              </div>
              <p className="text-sm text-[#5E6870]">
                <span className="font-semibold text-[#1F2933]">{filtered.length}</span> matching templates
              </p>
            </div>

            {isLoading ? (
              <div className="p-6 text-sm text-[#5E6870]">Loading templates...</div>
            ) : filtered.length === 0 ? (
              <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
                <LayoutTemplate className="mb-3 h-10 w-10 text-[#8C969E]" />
                <p className="text-sm font-semibold text-[#1F2933]">No templates found</p>
                <p className="mt-1 text-sm text-[#5E6870]">Create a builder template or upload an Office template for this document type.</p>
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[920px] border-collapse text-left">
                  <thead>
                    <tr className="border-b border-[#C8CDD2] bg-[#4E535B] text-xs font-semibold text-white">
                      <th className="px-4 py-3">Template</th>
                      <th className="px-4 py-3">Document Type</th>
                      <th className="px-4 py-3">Source</th>
                      <th className="px-4 py-3">Structure</th>
                      <th className="px-4 py-3">Uses</th>
                      <th className="px-4 py-3 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((template) => (
                      <TemplateRow
                        key={template.id}
                        template={template}
                        onPreview={() => setFillTarget(template)}
                        onEdit={() => { setEditTarget(template); setMode("builder"); }}
                        onDuplicate={() => duplicateMutation.mutate(template.id!)}
                        onDelete={() => {
                          if (confirm(`Delete "${template.name}"? This cannot be undone.`)) {
                            deleteMutation.mutate(template.id!);
                          }
                        }}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </main>
      </div>

      {/* Modals */}
      {fillTarget && (
        <FillModal template={fillTarget} onClose={() => setFillTarget(null)}
                   onSaved={(docId) => { setFillTarget(null); navigate(`/documents/${docId}`); }} />
      )}
      {showUpload && (
        <UploadTemplateModal
          documentTypes={docTypes}
          onClose={() => setShowUpload(false)}
          onDone={() => setShowUpload(false)}
        />
      )}
    </div>
  );
}
