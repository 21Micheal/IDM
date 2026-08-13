/**
 * FormFillModal
 *
 * Forms-area counterpart to components/templates/BuiltTemplateFormModal.
 * Nearly identical (same fill/attachment/validation flow) — the only
 * behavioural difference is that on success it stays in the Forms area
 * rather than navigating to /forms/:id.
 *
 * Two footer actions replace the old "Create Form" button:
 *
 *  • "Save as draft"  — creates the document in draft state, no validation
 *    gate (matches FormDetailPage's own "Save draft" behaviour so partial
 *    forms can be saved and completed later).
 *
 *  • "Start workflow" — validates required fields, creates the document,
 *    then immediately submits it for approval. If the submit call fails the
 *    document exists in draft state and the user can retry from the list.
 *
 * This is intentionally a separate component rather than an edit to
 * BuiltTemplateFormModal so this pass doesn't touch existing files — once the
 * old Documents-side form handling is removed, the two can be collapsed back
 * into one (BuiltTemplateFormModal taking a `basePath` prop, e.g.).
 */

import { useEffect, useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI, templatesAPI } from "@/services/api";
import { requiredFieldLabels } from "@/components/templates/TemplateForm";
import { useAuthStore } from "@/store/authStore";
import TemplateForm from "@/components/templates/TemplateForm";
import BudgetBanner from "@/components/templates/BudgetBanner";
import { collectFormAttachments } from "@/components/templates/formAttachments";
import { toast } from "@/components/ui/vault-toast";
import { X, Loader2, Send, Save, FileText, LayoutTemplate, Paperclip } from "lucide-react";
import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";

type DocumentTemplateOption = {
  id: string;
  name: string;
  description?: string;
  type: "built" | "uploaded";
  document_type?: string;
  document_type_id?: string;
  sections?: unknown[];
  sunsystems?: { budget?: Record<string, unknown>; journal?: Record<string, unknown> } | null;
};

type Props = {
  template: DocumentTemplateOption;
  documentTypeId: string;
  documentTypeName?: string;
  initialTitle?: string;
  initialValues?: Record<string, unknown>;
  onClose: () => void;
};

export default function FormFillModal({
  template,
  documentTypeId,
  initialTitle,
  initialValues = {},
  onClose,
}: Props) {
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);

  const [title, setTitle] = useState((initialTitle ?? "").trim() || template.name);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues);
  const [uploadingFiles, setUploadingFiles] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  // Required fields flagged by the last "Start workflow" attempt — shown inline
  // (a toast with a long list is unreadable and disappears).
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const dirty = Object.keys(values).length > 0 || title.trim() !== template.name;

  // Esc closes the modal, but never silently throws away typed answers.
  const requestClose = () => {
    if (dirty && !window.confirm("Discard this form? Your answers will be lost.")) return;
    onClose();
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") requestClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const sections = (template.sections ?? []) as Array<{ title?: string; fields?: unknown[] }>;

  // ── Core create mutation ───────────────────────────────────────────────────
  // Returns the new document id. onSuccess is deliberately left empty here —
  // callers (handleSaveAsDraft / handleStartWorkflow) take responsibility for
  // toasting and closing so they can chain the submit call when needed.
  const createMutation = useMutation({
    mutationFn: async () => {
      const { jsonValues, attachments } = collectFormAttachments(values);

      setUploadingFiles(attachments.length > 0);
      const request =
        attachments.length > 0
          ? templatesAPI.fillTemplateWithAttachments({
              template_id: template.id,
              values: jsonValues,
              output_format: "pdf",
              title: title.trim() || template.name,
              document_type_id: documentTypeId,
              draft_from_template: false,
              attachments,
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
    onError: (err: any) => {
      setUploadingFiles(false);
      setSubmitting(false);
      toast.error(extractApiError(err, "Could not create the form."));
    },
  });

  // ── Save as draft ──────────────────────────────────────────────────────────
  // No validation gate — partial forms are allowed (mirrors FormDetailPage's
  // own "Save draft" which also skips required-field checks).
  const handleSaveAsDraft = async () => {
    if (!title.trim()) {
      toast.error("Please enter a form title.");
      return;
    }
    try {
      await createMutation.mutateAsync();
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Form saved as draft.");
      onClose();
    } catch {
      // error already toasted by createMutation.onError
    }
  };

  // ── Start workflow ─────────────────────────────────────────────────────────
  // Validates required fields, creates the document, then immediately submits
  // it for approval. If submit fails the form lands in draft — the user can
  // retry from the forms list.
  const handleStartWorkflow = async () => {
    if (!title.trim()) {
      toast.error("Please enter a form title.");
      return;
    }
    const { jsonValues } = collectFormAttachments(values);
    const missing = requiredFieldLabels(
      template.sections ?? [],
      jsonValues,
      {
        groupNames: currentUser?.group_names ?? [],
        isAdmin: Boolean(currentUser?.has_admin_access || currentUser?.is_staff),
      },
    );
    if (missing.length) {
      setMissingFields(missing);
      toast.error(`${missing.length} required field${missing.length === 1 ? "" : "s"} still need${missing.length === 1 ? "s" : ""} attention.`);
      return;
    }
    setMissingFields([]);

    setSubmitting(true);
    try {
      const docId = await createMutation.mutateAsync();
      try {
        await documentsAPI.submit(docId);
        queryClient.invalidateQueries({ queryKey: ["forms"] });
        queryClient.invalidateQueries({ queryKey: ["documents"] });
        toast.success("Workflow started — form submitted for approval.");
        onClose();
      } catch (submitErr: any) {
        // Document was created but submission failed — leave it as draft
        // so the user can retry from the forms list.
        queryClient.invalidateQueries({ queryKey: ["forms"] });
        queryClient.invalidateQueries({ queryKey: ["documents"] });
        toast.warn(
          "Form saved, but workflow could not be started. Open it from the list to retry.",
        );
        onClose();
      }
    } catch {
      // create itself failed — already toasted
    } finally {
      setSubmitting(false);
    }
  };

  const fileCount = collectFormAttachments(values).attachments.length;
  const isCreating = createMutation.isPending || uploadingFiles;
  const isPending = isCreating || submitting;

  return (
    <div className="flex h-full flex-col bg-white">
      {/* ── Portal into Layout's blue bar ── */}
      <WorkspaceCommandBar
        actions={
          <button
            onClick={requestClose}
            disabled={isPending}
            className="flex-shrink-0 p-1.5 text-white/70 hover:bg-white/15 hover:text-white transition-colors disabled:opacity-40"
            title="Cancel"
          >
            <X className="h-5 w-5" />
          </button>
        }
      >
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center bg-white/20">
            <LayoutTemplate className="h-4 w-4" />
          </div>
          <div className="hidden sm:block">
            <p className="text-[10px] font-semibold text-white/60 uppercase tracking-widest leading-none mb-0.5">New Form</p>
            <h1 className="truncate text-sm font-bold leading-tight max-w-[180px]">{template.name}</h1>
          </div>
        </div>

        {/* Inline title input */}
        <div className="flex flex-1 items-center gap-2 border border-white/30 bg-white/10 px-3 py-1.5 min-w-0 max-w-xs">
          <FileText className="h-3.5 w-3.5 flex-shrink-0 text-white/70" />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/50 outline-none"
            placeholder="Form title…"
            onKeyDown={(e) => { if (e.key === "Enter") e.preventDefault(); }}
          />
        </div>

        {fileCount > 0 && (
          <div className="flex-shrink-0 flex items-center gap-1.5 border border-white/30 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white">
            <Paperclip className="h-3.5 w-3.5" />
            {fileCount} file{fileCount !== 1 ? "s" : ""}
          </div>
        )}
      </WorkspaceCommandBar>

      {/* ── Sub-header hint ── */}
      <div className="flex-shrink-0 border-b border-[#C8CDD2] bg-[#F5F7F8] px-6 py-2.5">
        <p className="text-xs text-[#3D454D]">
          Complete all required fields — marked <span className="text-red-600 font-bold">*</span>.
          {fileCount > 0 && (
            <span className="ml-2 text-[#287EAD] font-semibold">
              {fileCount} file attachment{fileCount !== 1 ? "s" : ""} will be saved with the form.
            </span>
          )}
        </p>
      </div>

      {/* ── Form body ── */}
      <div className="flex-1 overflow-y-auto bg-white px-6 py-6">
        {sections.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-24 text-center">
            <LayoutTemplate className="h-12 w-12 text-[#AEB5BB] mb-4" />
            <p className="text-sm font-semibold text-[#1F2933]">No form sections defined</p>
            <p className="mt-1 text-xs text-[#5E6870] max-w-xs">
              Open this template in the Template Builder to add form fields.
            </p>
          </div>
        ) : (
          <div className="space-y-4">
            {missingFields.length > 0 && (
              <div className="border border-red-200 bg-red-50 px-4 py-3">
                <p className="text-xs font-bold text-red-800">
                  {missingFields.length} required field{missingFields.length === 1 ? "" : "s"} to complete
                </p>
                <ul className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-red-800">
                  {missingFields.map((m) => <li key={m} className="list-inside list-disc">{m}</li>)}
                </ul>
              </div>
            )}
            {Boolean((template.sunsystems?.budget as any)?.enabled) && (
              <BudgetBanner
                values={values}
                templateId={template.id}
                mapping={template.sunsystems?.budget ?? null}
                sections={template.sections ?? []}
                enabled
              />
            )}
            <TemplateForm
              sections={template.sections ?? []}
              values={values}
              onChange={(key, val) => setValues((prev) => ({ ...prev, [key]: val }))}
              documentStatus="draft"
            />
          </div>
        )}
      </div>

      {/* ── Footer actions ── */}
      <div className="flex-shrink-0 flex items-center justify-between border-t border-[#C8CDD2] bg-white px-6 py-4">
        <button
          onClick={requestClose}
          disabled={isPending}
          className="px-5 py-2 text-sm font-semibold text-[#5E6870] hover:text-[#1F2933] border border-[#C8CDD2] bg-white hover:bg-[#F7F8F9] transition-colors disabled:opacity-50"
        >
          Cancel
        </button>

        <div className="flex items-center gap-2">
          {/* Save as draft — no required-field gate */}
          <button
            onClick={handleSaveAsDraft}
            disabled={isPending}
            className="flex items-center gap-2 border border-[#AEB5BB] bg-white px-5 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6] transition-colors disabled:opacity-50"
          >
            {isCreating && !submitting ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            Save as draft
          </button>

          {/* Start workflow — validates then create + submit */}
          <button
            onClick={handleStartWorkflow}
            disabled={isPending}
            className="flex items-center gap-2 bg-[#287EAD] px-7 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] transition-colors disabled:opacity-60"
          >
            {submitting || (isCreating && submitting) ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                {uploadingFiles ? "Uploading…" : "Starting…"}
              </>
            ) : (
              <>
                <Send className="h-4 w-4" />
                Start workflow
              </>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}