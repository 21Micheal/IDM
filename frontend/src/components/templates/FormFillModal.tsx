/**
 * FormFillModal
 *
 * Forms-area counterpart to components/templates/BuiltTemplateFormModal.
 * Nearly identical (same fill/attachment/validation flow) — the only
 * behavioural difference is that on success it lands the person on
 * `/forms/:id` (the new dedicated Forms detail page) instead of
 * `/documents/:id`, so a form created here stays inside the Forms area.
 *
 * This is intentionally a separate component rather than an edit to
 * BuiltTemplateFormModal so this pass doesn't touch existing files — once the
 * old Documents-side form handling is removed, the two can be collapsed back
 * into one (BuiltTemplateFormModal taking a `basePath` prop, e.g.).
 */

import { useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useNavigate } from "react-router-dom";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { templatesAPI } from "@/services/api";
import { requiredFieldLabels } from "@/components/templates/TemplateForm";
import { useAuthStore } from "@/store/authStore";
import TemplateForm from "@/components/templates/TemplateForm";
import BudgetBanner from "@/components/templates/BudgetBanner";
import { collectFormAttachments } from "@/components/templates/formAttachments";
import { toast } from "@/components/ui/vault-toast";
import { X, Loader2, CheckCircle, FileText, LayoutTemplate, Paperclip } from "lucide-react";

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
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const currentUser = useAuthStore((s) => s.user);

  const [title, setTitle] = useState((initialTitle ?? "").trim() || template.name);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues);
  const [uploadingFiles, setUploadingFiles] = useState(false);

  const sections = (template.sections ?? []) as Array<{ title?: string; fields?: unknown[] }>;
  const isPending = uploadingFiles;

  const createMutation = useMutation({
    mutationFn: async () => {
      const { jsonValues, attachments } = collectFormAttachments(values);

      setUploadingFiles(attachments.length > 0);
      const request = attachments.length > 0
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
    onSuccess: (docId) => {
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Form created.");
      navigate(`/forms/${docId}`);
    },
    onError: (err: any) => {
      setUploadingFiles(false);
      toast.error(extractApiError(err, "Could not create the form."));
    },
  });

  const handleCreate = () => {
    if (!title.trim()) {
      toast.error("Please enter a form title.");
      return;
    }
    const { jsonValues } = collectFormAttachments(values);
    const missing = requiredFieldLabels(template.sections ?? [], jsonValues, {
      groupNames: currentUser?.group_names ?? [],
      isAdmin: Boolean(currentUser?.has_admin_access || currentUser?.is_staff),
    });
    if (missing.length) {
      toast.error(`Please fill in: ${missing.join(", ")}`);
      return;
    }
    createMutation.mutate();
  };

  const fileCount = collectFormAttachments(values).attachments.length;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-[#EDEDED]">
      <div className="flex h-[60px] flex-shrink-0 items-center gap-4 border-b border-[#C8CDD2] bg-[#287EAD] px-5 pr-6 text-white">
        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded bg-white/20">
            <LayoutTemplate className="h-4 w-4" />
          </div>
          <div className="hidden sm:block">
            <p className="text-[10px] font-semibold text-white/60 uppercase tracking-widest leading-none mb-0.5">
              New Form
            </p>
            <h1 className="truncate text-sm font-bold leading-tight max-w-[180px]">{template.name}</h1>
          </div>
        </div>

        <div className="flex flex-1 items-center gap-2 rounded border border-white/30 bg-white/10 px-3 py-1.5 min-w-0">
          <FileText className="h-3.5 w-3.5 flex-shrink-0 text-white/70" />
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="min-w-0 flex-1 bg-transparent text-sm text-white placeholder:text-white/50 outline-none"
            placeholder="Form title…"
            onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          />
        </div>

        {fileCount > 0 && (
          <div className="flex-shrink-0 flex items-center gap-1.5 rounded border border-white/30 bg-white/10 px-2.5 py-1 text-xs font-semibold text-white">
            <Paperclip className="h-3.5 w-3.5" />
            {fileCount} file{fileCount !== 1 ? "s" : ""}
          </div>
        )}

        <button onClick={onClose} className="flex-shrink-0 rounded p-1.5 text-white/70 hover:bg-white/15 hover:text-white transition-colors" title="Cancel">
          <X className="h-5 w-5" />
        </button>
      </div>

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
          <div className="space-y-4">
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
            />
          </div>
        )}
      </div>

      <div className="flex-shrink-0 flex items-center justify-between border-t border-[#C8CDD2] bg-white px-6 py-4">
        <button onClick={onClose} className="px-5 py-2 text-sm font-semibold text-[#5E6870] hover:text-[#1F2933] border border-[#C8CDD2] bg-white hover:bg-[#F7F8F9] transition-colors rounded">
          Cancel
        </button>
        <button onClick={handleCreate} disabled={isPending}
          className="flex items-center gap-2 rounded bg-[#287EAD] px-7 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] transition-colors disabled:opacity-60">
          {isPending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {uploadingFiles ? "Uploading attachments…" : "Creating…"}
            </>
          ) : (
            <>
              <CheckCircle className="h-4 w-4" />
              Create Form
            </>
          )}
        </button>
      </div>
    </div>
  );
}