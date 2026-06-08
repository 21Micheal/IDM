/**
 * BuiltTemplateFormModal
 *
 * Full-screen form experience for filling a "built" (builder-defined) template
 * before creating a document.
 *
 * Layout: header (template name + editable title + close) → scrollable TemplateForm
 *         → sticky footer (Cancel | Create Document)
 *
 * Field handling:
 *   • Text / number / select / boolean / table / signature  → sent as JSON in `values`
 *   • file / image fields  → collected as File objects and sent with the create
 *     request as form attachments. They are not document versions.
 *
 * Title persistence:
 *   • `initialTitle` is forwarded from the upload page title input so users don't
 *     have to retype what they already entered.
 */

import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { templatesAPI } from "@/services/api";
import { requiredFieldLabels } from "@/components/templates/TemplateForm";
import TemplateForm from "@/components/templates/TemplateForm";
import { toast } from "@/components/ui/vault-toast";
import { X, Loader2, CheckCircle, FileText, LayoutTemplate, Paperclip } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type DocumentTemplateOption = {
  id: string;
  name: string;
  description?: string;
  type: "built" | "uploaded";
  document_type?: string;
  document_type_id?: string;
  sections?: unknown[];
};

type Props = {
  template: DocumentTemplateOption;
  documentTypeId: string;
  documentTypeName?: string;
  initialTitle?: string;
  initialValues?: Record<string, unknown>;
  onClose: () => void;
};

// ── Helpers ───────────────────────────────────────────────────────────────────

/**
 * Split form values into:
 *   jsonValues  — safe to serialize as JSON (primitives, arrays, objects)
 *   fileEntries — [fieldKey, File] pairs that must be uploaded separately
 */
function splitValues(values: Record<string, unknown>): {
  jsonValues: Record<string, unknown>;
  fileEntries: Array<[string, File]>;
} {
  const jsonValues: Record<string, unknown> = {};
  const fileEntries: Array<[string, File]> = [];

  for (const [key, val] of Object.entries(values)) {
    if (val instanceof File) {
      fileEntries.push([key, val]);
      // Store filename as a placeholder so the PDF can still label the field
      jsonValues[key] = val.name;
    } else {
      jsonValues[key] = val;
    }
  }

  return { jsonValues, fileEntries };
}

// ── Main modal ────────────────────────────────────────────────────────────────

export default function BuiltTemplateFormModal({
  template,
  documentTypeId,
  initialTitle,
  initialValues = {},
  onClose,
}: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Prefer whatever the user typed on the upload page, fall back to template name
  const [title, setTitle] = useState(
    (initialTitle ?? "").trim() || template.name
  );
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues);
  const [uploadingFiles, setUploadingFiles] = useState(false);

  const sections = (template.sections ?? []) as Array<{ title?: string; fields?: unknown[] }>;
  const isPending = uploadingFiles;

  const createMutation = useMutation({
    mutationFn: async () => {
      const { jsonValues, fileEntries } = splitValues(values);

      setUploadingFiles(fileEntries.length > 0);
      const request = fileEntries.length > 0
        ? templatesAPI.fillTemplateWithAttachments({
            template_id: template.id,
            values: jsonValues,
            output_format: "pdf",
            title: title.trim() || template.name,
            document_type_id: documentTypeId,
            draft_from_template: false,
            attachments: fileEntries.map(([fieldKey, file]) => ({ fieldKey, file })),
          })
        : templatesAPI.fillTemplate({
            template_id: template.id,
            values: jsonValues,
            output_format: "pdf",
            title: title.trim() || template.name,
            document_type_id: documentTypeId,
            draft_from_template: false,
          });

      const { data } = await request;
      setUploadingFiles(false);
      return data.document_id as string;
    },
    onSuccess: (docId) => {
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Document created from template.");
      navigate(`/documents/${docId}`);
    },
    onError: (err: any) => {
      setUploadingFiles(false);
      const msg = err?.response?.data?.detail || err?.response?.data?.values || "Could not create document.";
      toast.error(Array.isArray(msg) ? msg.join(", ") : String(msg));
    },
  });

  const handleCreate = () => {
    if (!title.trim()) {
      toast.error("Please enter a document title.");
      return;
    }
    // Validate required fields — skip File fields (they're already captured)
    const nonFileValues: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(values)) {
      nonFileValues[k] = v instanceof File ? v.name : v;
    }
    const missing = requiredFieldLabels(template.sections ?? [], nonFileValues);
    if (missing.length) {
      toast.error(`Please fill in: ${missing.join(", ")}`);
      return;
    }
    createMutation.mutate();
  };

  // Count pending file attachments for status display
  const fileCount = Object.values(values).filter((v) => v instanceof File).length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#EDEDED]">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex h-[60px] flex-shrink-0 items-center gap-4 border-b border-[#C8CDD2] bg-[#287EAD] px-5 pr-6 text-white">
        {/* Template identity */}
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded bg-white/20">
            <LayoutTemplate className="h-4 w-4" />
          </div>
          <div className="hidden sm:block">
            <p className="text-[10px] font-semibold text-white/60 uppercase tracking-widest leading-none mb-0.5">
              Fill Template
            </p>
            <h1 className="truncate text-sm font-bold leading-tight max-w-[180px]">
              {template.name}
            </h1>
          </div>
        </div>

        {/* Document title input — grows to fill */}
        <div className="flex flex-1 items-center gap-2 rounded border border-white/30 bg-white/10 px-3 py-1.5 min-w-0">
          <FileText className="h-3.5 w-3.5 flex-shrink-0 text-white/70" />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/50 outline-none"
            placeholder="Document title…"
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
        </div>

        {/* File count badge */}
        {fileCount > 0 && (
          <div className="flex-shrink-0 flex items-center gap-1.5 rounded border border-white/30 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white">
            <Paperclip className="h-3.5 w-3.5" />
            {fileCount} file{fileCount !== 1 ? "s" : ""}
          </div>
        )}

        {/* Close */}
        <button
          onClick={onClose}
          className="flex-shrink-0 rounded p-1.5 text-white/70 hover:bg-white/15 hover:text-white transition-colors"
          title="Cancel"
        >
          <X className="h-5 w-5" />
        </button>
      </div>

      {/* ── Sub-header — instructions ───────────────────────────────────────── */}
      <div className="flex-shrink-0 border-b border-[#C8CDD2] bg-white px-6 py-2.5">
        <p className="text-xs text-[#5E6870]">
          Complete all required fields — marked <span className="text-red-500 font-semibold">*</span>.
          {fileCount > 0 && (
            <span className="ml-2 text-[#287EAD] font-medium">
              {fileCount} file attachment{fileCount !== 1 ? "s" : ""} will be saved with the form.
            </span>
          )}
        </p>
      </div>

      {/* ── Scrollable form ─────────────────────────────────────────────────── */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {sections.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <LayoutTemplate className="h-12 w-12 text-[#AEB5BB] mb-4" />
            <p className="text-sm font-semibold text-[#1F2933]">No form sections defined</p>
            <p className="mt-1 text-xs text-[#5E6870] max-w-xs">
              Open this template in the Template Builder to add form fields.
            </p>
          </div>
        ) : (
          <TemplateForm
            sections={template.sections ?? []}
            values={values}
            onChange={(key, val) => setValues((prev) => ({ ...prev, [key]: val }))}
          />
        )}
      </div>

      {/* ── Sticky footer ───────────────────────────────────────────────────── */}
      <div className="flex-shrink-0 flex items-center justify-between border-t border-[#C8CDD2] bg-white px-6 py-4">
        <button
          onClick={onClose}
          className="px-5 py-2 text-sm font-semibold text-[#5E6870] hover:text-[#1F2933] border border-[#C8CDD2] bg-white hover:bg-[#F7F8F9] transition-colors rounded"
        >
          Cancel
        </button>
        <button
          onClick={handleCreate}
          disabled={isPending}
          className="flex items-center gap-2 rounded bg-[#287EAD] px-7 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] transition-colors disabled:opacity-60"
        >
          {isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {uploadingFiles ? "Uploading attachments…" : "Creating…"}
            </>
          ) : (
            <>
              <CheckCircle className="h-4 w-4" />
              Create Document
            </>
          )}
        </button>
      </div>
    </div>
  );
}
