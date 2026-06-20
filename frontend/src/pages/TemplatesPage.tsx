/**
 * TemplatesPage.tsx — Admin configuration for document templates (config only).
 *
 * This page is where admins CONFIGURE templates — the same role the document-types
 * admin page plays. Template USAGE (selecting + filling to create a document)
 * lives on the UploadPage, not here.
 *
 * Features:
 *  - List view with document-type filtering, search, type filter
 *  - Builder mode for "built" templates (TemplateBuilderV2)
 *  - Upload / edit "uploaded" Office templates (replace file, re-detect placeholders)
 *  - Read-only preview (verify a template's configuration)
 *  - Duplicate / delete
 */

import { useState, useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Plus, Upload, X, Eye, FileText, Trash2,
  Loader2, Copy, Search, LayoutTemplate, Wand2,
  Pencil, Building2,
} from "lucide-react";
import { toast } from "react-toastify";
import clsx from "clsx";
import { templatesAPI, documentTypesAPI, normalizeListResponse } from "@/services/api";
import type { DocumentType } from "@/types";
import TemplateBuilderV2 from "@/pages/TemplateBuilderV2";
import DocumentTemplateDesigner, {
  type DocumentTemplate as DesignerTemplate,
  type EditableDocumentTemplate,
} from "@/pages/TemplateDesigner";
import TemplatePreview from "@/components/templates/TemplatePreview";

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
  /** Sub-kind for type="built": interactive form vs WYSIWYG document layout. */
  kind?: "form" | "document";
  /** For kind="document": the designer block layout ({page,theme,header,footer,blocks}). */
  design?: Record<string, unknown>;
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
// Designer (document-kind) adapters — the WYSIWYG designer uses a flat shape
// (page/theme/header/footer/blocks at top level); the backend nests those under
// `design` and uses document_type / kind. These translate between the two.
// ─────────────────────────────────────────────────────────────────────────────

function designerToBackend(dt: DesignerTemplate): Record<string, unknown> {
  return {
    id: dt.id,
    name: dt.name,
    description: dt.description ?? "",
    type: "built",
    kind: "document",
    category: dt.category ?? "other",
    tags: dt.tags ?? [],
    document_type: dt.document_type_id,
    design: { page: dt.page, theme: dt.theme, header: dt.header, footer: dt.footer, blocks: dt.blocks },
    placeholders: dt.placeholders ?? [],
  };
}

function backendToDesigner(row: Template): EditableDocumentTemplate {
  const design = (row.design ?? {}) as Partial<DesignerTemplate>;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    category: row.category,
    tags: row.tags,
    document_type_id: row.document_type_id || row.document_type,
    page: design.page,
    theme: design.theme,
    header: design.header,
    footer: design.footer,
    blocks: design.blocks,
    placeholders: row.placeholders,
  } as EditableDocumentTemplate;
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
// UploadTemplateModal
// ─────────────────────────────────────────────────────────────────────────────

function UploadTemplateModal({
  onClose,
  onDone,
  documentTypes,
  editing,
}: {
  onClose: () => void;
  onDone: () => void;
  documentTypes: DocumentType[];
  editing?: Template | null;
}) {
  const qc = useQueryClient();
  const isEdit = Boolean(editing);
  const [file, setFile]     = useState<File | null>(null);
  const [name, setName]     = useState(editing?.name ?? "");
  const [desc, setDesc]     = useState(editing?.description ?? "");
  const [documentTypeId, setDocumentTypeId] = useState(editing?.document_type_id || editing?.document_type || "");
  const [isDrag, setIsDrag] = useState(false);
  const [showCreateType, setShowCreateType] = useState(false);

  const uploadMutation = useMutation({
    mutationFn: () => {
      const fd = new FormData();
      // On edit the file is optional — only sent when the admin picks a new one.
      if (file) fd.append("file", file);
      fd.append("name", name || file?.name.replace(/\.[^.]+$/, "") || editing?.name || "Template");
      fd.append("description", desc);
      fd.append("type", "uploaded");
      fd.append("document_type", documentTypeId);
      return isEdit ? templatesAPI.update(editing!.id!, fd) : templatesAPI.create(fd);
    },
    onSuccess: () => {
      toast.success(isEdit
        ? (file ? "Template updated — placeholders re-detected." : "Template updated.")
        : "Template uploaded — placeholders auto-detected.");
      qc.invalidateQueries({ queryKey: ["templates"] });
      onDone();
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.file ?? (isEdit ? "Update failed" : "Upload failed");
      toast.error(typeof msg === "string" ? msg : (isEdit ? "Update failed" : "Upload failed"));
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
            <p className="text-sm font-semibold">{isEdit ? "Edit Office template" : "Upload Office template"}</p>
            <p className="mt-0.5 text-xs text-white/75">
              {isEdit
                ? "Update details, or replace the Office file to change its layout/placeholders."
                : "Attach an Office file and bind it to a document type."}
            </p>
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
            <input id="template-file-input" type="file" accept=".docx,.doc,.xlsx,.xls,.pptx,.ppt" className="hidden"
                   onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }} />
            {file ? (
              <div className="space-y-1">
                <FileText className="mx-auto h-8 w-8 text-[#287EAD]" />
                <p className="text-sm font-semibold text-[#1F2933]">{file.name}</p>
                <p className="text-xs text-slate-400">{(file.size / 1024).toFixed(1)} KB · new file</p>
              </div>
            ) : isEdit ? (
              <div className="space-y-1">
                <FileText className="mx-auto h-8 w-8 text-[#5E6870]" />
                <p className="text-sm font-semibold text-[#1F2933]">{editing?.file_name || "Current file"}</p>
                <p className="text-xs text-slate-400">Drop a new DOCX/XLSX/PPTX to replace it, or leave as-is</p>
              </div>
            ) : (
              <div className="space-y-2">
                <Upload className="w-8 h-8 text-slate-300 mx-auto" />
                <p className="text-sm text-slate-500">Drop a DOCX, XLSX or PPTX file here</p>
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
          <button onClick={() => uploadMutation.mutate()} disabled={(!isEdit && !file) || !documentTypeId || uploadMutation.isPending}
                  className="flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50">
            {uploadMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : isEdit ? <Pencil className="w-4 h-4" /> : <Upload className="w-4 h-4" />}
            {isEdit ? "Save changes" : "Upload template"}
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
        <button type="button" onClick={onPreview} title="Preview" className="block max-w-full text-left">
          <span className="block truncate text-sm font-semibold text-[#287EAD]">{template.name}</span>
          <span className="mt-0.5 block truncate text-xs text-[#5E6870]">{template.description || "No description"}</span>
        </button>
      </td>
      <td className="px-4 py-3 text-sm text-[#1F2933]">{typeLabel}</td>
      <td className="px-4 py-3 text-sm text-[#1F2933]">
        {template.type === "uploaded" ? "Office" : template.kind === "document" ? "Document" : "Builder"}
      </td>
      <td className="px-4 py-3 text-sm text-[#1F2933]">
        {template.type === "uploaded"
          ? `${template.placeholders?.length ?? 0} placeholders`
          : template.kind === "document"
            ? `${(template.design?.blocks as unknown[] | undefined)?.length ?? 0} blocks / ${template.placeholders?.length ?? 0} fields`
            : `${sectionCount} sections / ${fieldCount} fields`}
      </td>
      <td className="px-4 py-3 text-sm text-[#1F2933]">{template.use_count ?? 0}</td>
      <td className="px-4 py-3 text-right">
        <div className="inline-flex items-center gap-1">
          <button type="button" onClick={onPreview} title="Preview" className="p-1.5 text-[#5E6870] hover:text-[#287EAD]">
            <Eye className="h-4 w-4" />
          </button>
          <button type="button" onClick={onEdit} title={template.type === "built" ? "Edit in builder" : "Edit Office template"}
                  className="p-1.5 text-[#5E6870] hover:text-[#287EAD]">
            <Pencil className="h-4 w-4" />
          </button>
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
// PreviewModal — read-only look at a template before using it
// ─────────────────────────────────────────────────────────────────────────────

function PreviewModal({ template, onClose }: {
  template: Template;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center">
      <div className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden border border-[#C8CDD2] bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-[#1E6F99] bg-[#287EAD] px-5 py-3 text-white">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{template.name}</p>
            <p className="mt-0.5 text-xs text-white/75">
              {template.type === "uploaded" ? "Office template" : "Builder form"}
              {(template.document_type_name || template.document_type_code) ? ` · ${template.document_type_name || template.document_type_code}` : ""}
            </p>
          </div>
          <button onClick={onClose} className="flex-shrink-0 text-white/70 hover:text-white"><X className="h-5 w-5" /></button>
        </div>

        <div className="flex-1 overflow-y-auto bg-[#F7FAFC] p-5">
          <TemplatePreview template={template} />
        </div>

        <div className="flex items-center justify-between gap-3 border-t border-[#C8CDD2] px-5 py-3">
          {template.type === "uploaded" && template.file_url ? (
            <a href={template.file_url} target="_blank" rel="noreferrer"
               className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#287EAD] hover:underline">
              <FileText className="h-3.5 w-3.5" /> Open source file
            </a>
          ) : <span />}
          <button onClick={onClose}
                  className="border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Main TemplatesPage
// ─────────────────────────────────────────────────────────────────────────────

type PageMode = "list" | "builder" | "designer";

export default function TemplatesPage() {
  const qc       = useQueryClient();
  const [mode, setMode]               = useState<PageMode>("list");
  const [editTarget, setEditTarget]   = useState<Template | undefined>(undefined);
  const [previewTarget, setPreviewTarget]       = useState<Template | null>(null);
  const [editUploadTarget, setEditUploadTarget] = useState<Template | null>(null);
  const [showUpload, setShowUpload]   = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [typeFilter, setTypeFilter]   = useState<"all" | "built" | "uploaded">("all");
  const [docTypeFilter, setDocTypeFilter] = useState<string>("all");

  // ── Data ────────────────────────────────────────────────────────────────

  const { data: templates, isLoading } = useQuery<Template[]>({
    queryKey: ["templates"],
    queryFn: () => templatesAPI.list().then((r) => {
      const raw = r.data.results ?? r.data;
      return raw.map((template: Template & { file?: string }) => ({
        ...template,
        document_type_id: template.document_type_id || template.document_type,
        file_url: template.file_url ?? template.file,
      }));
    }),
  });

  const { data: docTypes = [] } = useQuery<unknown, Error, DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<DocumentType>(data),
  });

  const saveMutation = useMutation({
    // Accepts either a form-builder Template or a designer (document-kind)
    // template; the designer shape is translated to the backend's `design` form.
    mutationFn: (params: { template: Template | DesignerTemplate; stayOpen?: boolean }) => {
      const { template } = params;
      const isDesigner = (template as { kind?: string }).kind === "document";
      const payload = isDesigner
        ? designerToBackend(template as DesignerTemplate)
        : { ...template, document_type: (template as Template).document_type_id };
      return template.id
        ? templatesAPI.update(template.id, payload)
        : templatesAPI.create(payload);
    },
    onSuccess: (_, variables) => {
      toast.success("Template saved");
      qc.invalidateQueries({ queryKey: ["templates"] });
      if (!variables?.stayOpen) {
        setMode("list");
        setEditTarget(undefined);
      }
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
        onSave={(tpl, stayOpen) => saveMutation.mutate({ template: tpl as unknown as Template, stayOpen })}
        onCancel={() => { setMode("list"); setEditTarget(undefined); }}
        isSaving={saveMutation.isPending}
      />
    );
  }

  if (mode === "designer") {
    return (
      <DocumentTemplateDesigner
        initial={editTarget ? backendToDesigner(editTarget) : null}
        documentTypes={docTypes.map((t) => ({ id: t.id, name: t.name, code: t.code }))}
        onSave={(tpl, stayOpen) => saveMutation.mutate({ template: tpl, stayOpen })}
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
            Upload Office
          </button>
          <button
            type="button"
            onClick={() => { setEditTarget(undefined); setMode("designer"); }}
            className="inline-flex items-center gap-2 border border-white/25 px-3 py-2 text-sm font-semibold text-white hover:bg-white/10"
            title="Design a document layout (WYSIWYG) that renders to an editable file"
          >
            <FileText className="h-4 w-4" />
            New Document
          </button>
          <button
            type="button"
            onClick={() => { setEditTarget(undefined); setMode("builder"); }}
            className="inline-flex items-center gap-2 border border-white/25 px-3 py-2 text-sm font-semibold text-white hover:bg-white/10"
            title="Build an interactive data-entry form"
          >
            <Plus className="h-4 w-4" />
            New Form
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
                        onPreview={() => setPreviewTarget(template)}
                        onEdit={() => {
                          if (template.type === "built" && template.kind === "document") {
                            setEditTarget(template);
                            setMode("designer");
                          } else if (template.type === "built") {
                            setEditTarget(template);
                            setMode("builder");
                          } else {
                            setEditUploadTarget(template);
                          }
                        }}
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
      {previewTarget && (
        <PreviewModal
          template={previewTarget}
          onClose={() => setPreviewTarget(null)}
        />
      )}
      {showUpload && (
        <UploadTemplateModal
          documentTypes={docTypes}
          onClose={() => setShowUpload(false)}
          onDone={() => setShowUpload(false)}
        />
      )}
      {editUploadTarget && (
        <UploadTemplateModal
          documentTypes={docTypes}
          editing={editUploadTarget}
          onClose={() => setEditUploadTarget(null)}
          onDone={() => setEditUploadTarget(null)}
        />
      )}
    </div>
  );
}
