/**
 * FormFillModal
 *
 * Imprest / built-form creation UI — chrome and interaction model match
 * NewRequisitionPage (sticky header, TemplateForm cards, floating actions,
 * live template sync, signature placement, formula recompute).
 *
 * On success navigates into /forms/:id so the user lands on FormDetailPage.
 */

import { useEffect, useMemo, useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { documentsAPI, templatesAPI } from "@/services/api";
import TemplateForm, { requiredFieldLabels } from "@/components/templates/TemplateForm";
import { useAuthStore } from "@/store/authStore";
import BudgetBanner from "@/components/templates/BudgetBanner";
import { collectFormAttachments } from "@/components/templates/formAttachments";
import { applyFormulasAndDefaults, evaluateDynamicFormula } from "@/components/templates/formulas";
import { toast } from "@/components/ui/vault-toast";
import { cn } from "@/lib/utils";
import {
  ArrowLeft,
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  FileText,
  Loader2,
  RefreshCw,
  Save,
  Sparkles,
} from "lucide-react";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import SignaturePlacementModal, {
  FormTargetField,
  SignaturePlacementResult,
} from "@/components/signatures/SignaturePlacementModal";

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
  /** Sibling templates for the in-header picker (optional). */
  templates?: DocumentTemplateOption[];
  onSelectTemplate?: (templateId: string) => void;
  initialTitle?: string;
  initialValues?: Record<string, unknown>;
  onClose: () => void;
};

export default function FormFillModal({
  template: initialTemplate,
  documentTypeId,
  templates = [],
  onSelectTemplate,
  initialTitle,
  initialValues = {},
  onClose,
}: Props) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const user = useAuthStore((s) => s.user);

  const [selectedTemplateId, setSelectedTemplateId] = useState(initialTemplate.id);
  const [title, setTitle] = useState((initialTitle ?? "").trim() || initialTemplate.name);
  const [values, setValues] = useState<Record<string, unknown>>(() => initialValues);
  const [formDirty, setFormDirty] = useState(false);
  const [missingFields, setMissingFields] = useState<string[]>([]);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [isSigningOpen, setIsSigningOpen] = useState(false);
  const [targetSignatureField, setTargetSignatureField] = useState<string | null>(null);
  const [uploadingFiles, setUploadingFiles] = useState(false);

  useEffect(() => {
    setSelectedTemplateId(initialTemplate.id);
    setTitle((initialTitle ?? "").trim() || initialTemplate.name);
  }, [initialTemplate.id, initialTemplate.name, initialTitle]);

  // Live template sync (same 30s cadence as NewRequisitionPage).
  const {
    data: selectedTemplate,
    isLoading: loadingTemplate,
    isFetching: refreshingTemplate,
  } = useQuery({
    queryKey: ["template", selectedTemplateId],
    queryFn: () => templatesAPI.get(selectedTemplateId).then((r) => r.data),
    enabled: Boolean(selectedTemplateId),
    ...QUERY_SHORT_STALE,
    refetchInterval: 30_000,
  });

  const template = selectedTemplate ?? initialTemplate;
  const sections = (template.sections ?? []) as Array<{ title?: string; fields?: Array<Record<string, any>> }>;

  // Apply defaults / formulas while preserving user-edited values.
  useEffect(() => {
    if (!template?.sections) return;
    setValues((prev) =>
      applyFormulasAndDefaults(
        template.sections as any,
        Object.keys(prev).length ? prev : initialValues,
        { user, now: new Date(), values: prev },
        { preserveUserValues: true },
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [template?.sections, user]);

  const requestClose = () => {
    if (formDirty && !window.confirm("Discard this form? Your answers will be lost.")) return;
    onClose();
  };

  const selectTemplate = (templateId: string) => {
    if (templateId === selectedTemplateId) {
      setTemplatePickerOpen(false);
      return;
    }
    if (formDirty && !window.confirm("Switch template? Unsaved answers will be cleared.")) {
      setTemplatePickerOpen(false);
      return;
    }
    const next = templates.find((t) => t.id === templateId);
    setSelectedTemplateId(templateId);
    setTitle(next?.name || "New Form");
    setValues({});
    setFormDirty(false);
    setMissingFields([]);
    setTemplatePickerOpen(false);
    onSelectTemplate?.(templateId);
  };

  const handleFieldChange = (key: string, value: unknown) => {
    setFormDirty(true);
    setValues((prev) => {
      const nextValues = { ...prev, [key]: value };
      for (const s of sections) {
        for (const f of s.fields ?? []) {
          const fKey = f.key ?? f.id;
          if (!fKey || fKey === key) continue;
          const formula = f.formula || f.calculation;
          if (formula && (String(formula).startsWith("=") || String(formula).toUpperCase().includes("IF("))) {
            const recomputed = evaluateDynamicFormula(formula, nextValues, { user, values: nextValues });
            if (recomputed !== undefined && recomputed !== "") {
              nextValues[fKey] = recomputed;
            }
          }
        }
      }
      return nextValues;
    });
  };

  const detectedFormFields: FormTargetField[] = useMemo(() => {
    const list: FormTargetField[] = [];
    for (const s of sections) {
      for (const f of s.fields ?? []) {
        const k = f.key ?? f.id;
        if (!k) continue;
        const label = f.label || k;
        if (/signature|sign|sig/i.test(k) || f.type === "signature") {
          list.push({ key: k, label: `${label} (Signature)`, kind: "signature" });
        } else if (/date/i.test(k) || f.type === "date") {
          list.push({ key: k, label: `${label} (Date)`, kind: "date" });
        } else if (/signer|signed_by|authorizer|requester/i.test(k)) {
          list.push({ key: k, label: `${label} (Name)`, kind: "text" });
        }
      }
    }
    return list;
  }, [sections]);

  const formTitle = () =>
    (typeof values.title === "string" && values.title.trim())
      || title.trim()
      || (template.name ? `Form — ${template.name}` : "Form");

  const createDocument = async (asDraft: boolean) => {
    const { jsonValues, attachments } = collectFormAttachments(values);
    setUploadingFiles(attachments.length > 0);
    try {
      const payload = {
        template_id: selectedTemplateId,
        values: jsonValues,
        output_format: "pdf" as const,
        title: formTitle(),
        document_type_id: documentTypeId || template.document_type_id || template.document_type,
        draft_from_template: asDraft,
        attachments,
      };
      const { data } = await templatesAPI.fillTemplateWithAttachments(payload);
      return (data.document_id || data.id) as string;
    } finally {
      setUploadingFiles(false);
    }
  };

  const saveDraftMutation = useMutation({
    mutationFn: async () => createDocument(true),
    onSuccess: (docId) => {
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Form saved as draft.");
      setFormDirty(false);
      navigate(docId ? `/forms/${docId}` : "/forms");
    },
    onError: (err: any) => {
      toast.error(extractApiError(err, "Could not save the form."));
    },
  });

  const submitMutation = useMutation({
    mutationFn: async () => {
      const { jsonValues } = collectFormAttachments(values);
      const missing = requiredFieldLabels(
        template.sections ?? [],
        jsonValues,
        {
          groupNames: user?.group_names ?? [],
          isAdmin: Boolean(user?.has_admin_access || user?.is_staff),
          canEditConditionalSections: true,
        },
        "submit",
      );
      if (missing.length) {
        setMissingFields(missing);
        toast.error(
          `${missing.length} required field${missing.length === 1 ? "" : "s"} still need${missing.length === 1 ? "s" : ""} attention.`,
        );
        throw new Error("validation");
      }
      setMissingFields([]);
      const docId = await createDocument(false);
      try {
        await documentsAPI.submit(docId);
      } catch (submitErr) {
        // Document exists as draft — open it so the user can retry submit.
        queryClient.invalidateQueries({ queryKey: ["forms"] });
        toast.warn("Form saved, but workflow could not be started. Open it to retry.");
        navigate(`/forms/${docId}`);
        throw submitErr;
      }
      return docId;
    },
    onSuccess: (docId) => {
      queryClient.invalidateQueries({ queryKey: ["forms"] });
      queryClient.invalidateQueries({ queryKey: ["documents"] });
      toast.success("Workflow started — form submitted for approval.");
      setFormDirty(false);
      navigate(`/forms/${docId}`);
    },
    onError: (err: any) => {
      if (err?.message === "validation") return;
      // submit-after-create failure already navigated + toasted
      if (err?.response || err?.message?.includes?.("workflow")) return;
      toast.error(extractApiError(err, "Could not create the form."));
    },
  });

  const handleApplySignature = (fieldValues: Record<string, unknown>, result: SignaturePlacementResult) => {
    setValues((prev) => {
      const next = { ...prev, ...fieldValues };
      if (result.signatureImage && !Object.keys(fieldValues).some((k) => /signature/i.test(k))) {
        next.signature = result.signatureImage;
      }
      return next;
    });
    setFormDirty(true);
    setIsSigningOpen(false);
    toast.success("Signature and date stamp applied to the form.");
  };

  const isPending = saveDraftMutation.isPending || submitMutation.isPending || uploadingFiles;
  const pickerTemplates = templates.length > 0 ? templates : [initialTemplate];

  return (
    <div className="min-h-full bg-[#F0F2F5] pb-20">
      {/* ── Top Navigation Bar (matches NewRequisitionPage) ── */}
      <div className="sticky top-0 z-10 border-b border-[#D9DDE2] bg-white shadow-sm">
        <div className="flex w-full items-center justify-between gap-4 px-6 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={requestClose}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-[#E4E7EB] bg-white text-[#5E6870] transition-colors hover:bg-[#F5F7F8] hover:text-[#1F2933]"
              title="Back to forms"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="h-5 w-px flex-shrink-0 bg-[#E4E7EB]" />
            <div className="flex min-w-0 items-center gap-2">
              <ClipboardList className="h-4 w-4 flex-shrink-0 text-[#287EAD]" />
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="truncate text-sm font-bold text-[#1F2933]">
                    {template.name || "New Form"}
                  </h1>
                  {refreshingTemplate && (
                    <span className="flex flex-shrink-0 items-center gap-1 rounded-full bg-[#EEF6FB] px-2 py-0.5 text-[10px] font-medium text-[#287EAD]">
                      <RefreshCw className="h-2.5 w-2.5 animate-spin" /> Syncing
                    </span>
                  )}
                </div>
                <p className="truncate text-[11px] text-[#8C969E]">
                  Requested by{" "}
                  {user?.first_name
                    ? `${user.first_name} ${user.last_name ?? ""}`.trim()
                    : user?.email ?? "—"}
                </p>
              </div>
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-3">
            <span className="inline-flex items-center gap-1.5 rounded border border-[#C8CDD2] bg-[#F5F7F8] px-2.5 py-1 text-[11px] font-semibold text-[#5E6870]">
              <span className="h-1.5 w-1.5 rounded-full bg-slate-400" />
              Draft
            </span>
            {pickerTemplates.length > 1 && (
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setTemplatePickerOpen((o) => !o)}
                  className="flex h-8 items-center gap-2 rounded-lg border border-[#E4E7EB] bg-white px-3 text-xs font-medium text-[#1F2933] transition-colors hover:bg-[#F5F7F8]"
                >
                  <FileText className="h-3.5 w-3.5 text-[#287EAD]" />
                  <span className="max-w-[160px] truncate">{template.name || "Select template"}</span>
                  <ChevronDown className="h-3.5 w-3.5 text-[#5E6870]" />
                </button>
                {templatePickerOpen && (
                  <div className="absolute right-0 top-full z-50 mt-1 w-64 border border-[#D9DDE2] bg-white shadow-lg">
                    {pickerTemplates.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => selectTemplate(t.id)}
                        className={cn(
                          "flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm hover:bg-[#F5F7F8]",
                          selectedTemplateId === t.id
                            ? "bg-[#EEF6FB] font-semibold text-[#287EAD]"
                            : "text-[#1F2933]",
                        )}
                      >
                        <FileText className="h-3.5 w-3.5 flex-shrink-0 text-[#287EAD]" />
                        <span className="truncate">{t.name}</span>
                        {selectedTemplateId === t.id && <CheckCircle2 className="ml-auto h-3.5 w-3.5" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      <div className="form-fill-shell px-4 py-5 sm:px-6 lg:px-8">
        <div className="mx-auto w-full max-w-[1800px]">
          {missingFields.length > 0 && (
            <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-4">
              <div className="flex items-center gap-2 text-xs font-bold text-amber-900">
                <AlertCircle className="h-4 w-4 text-amber-600" />
                Please complete the following required fields before submitting:
              </div>
              <ul className="mt-2 list-inside list-disc space-y-0.5 text-xs text-amber-800">
                {missingFields.map((f) => (
                  <li key={f}>{f}</li>
                ))}
              </ul>
            </div>
          )}

          {loadingTemplate && !selectedTemplate ? (
            <div className="flex h-64 items-center justify-center rounded-lg border border-[#D9DEE3] bg-white shadow-sm">
              <div className="flex flex-col items-center gap-3">
                <Loader2 className="h-6 w-6 animate-spin text-[#287EAD]" />
                <p className="text-xs text-[#5E6870]">Loading form template…</p>
              </div>
            </div>
          ) : sections.length === 0 ? (
            <div className="flex h-64 flex-col items-center justify-center rounded-lg border border-[#D9DEE3] bg-white shadow-sm">
              <FileText className="mb-3 h-8 w-8 text-[#C1C7CD]" />
              <p className="text-sm font-semibold text-[#1F2933]">No form sections defined</p>
              <p className="mt-1 max-w-xs text-center text-xs text-[#5E6870]">
                Open this template in the Template Builder to add form fields.
              </p>
            </div>
          ) : (
            <div className="form-renderer space-y-5">
              {Boolean((template.sunsystems?.budget as any)?.enabled) && (() => {
                const budgetMeta = (template.sunsystems?.budget ?? {}) as Record<string, any>;
                const amountField = budgetMeta.amount_field as string | undefined;
                const amount = amountField ? (values[amountField] ?? 0) : 0;
                return (
                  <div className="mb-4">
                    <BudgetBanner
                      amount={amount as number | string}
                      budget={budgetMeta.limit ?? budgetMeta.budget ?? null}
                      currency={budgetMeta.currency ?? undefined}
                      accountCode={budgetMeta.account_code ?? undefined}
                    />
                  </div>
                );
              })()}
              <TemplateForm
                sections={template.sections ?? []}
                values={values}
                validationIssues={missingFields}
                onChange={handleFieldChange}
                readOnly={false}
                documentStatus="draft"
                onLaunchSignatureModal={(fieldKey?: string) => {
                  if (fieldKey && typeof fieldKey === "string") {
                    setTargetSignatureField(fieldKey);
                  } else {
                    const firstSig = detectedFormFields.find((f) => f.kind === "signature");
                    setTargetSignatureField(firstSig ? firstSig.key : "signature");
                  }
                  setIsSigningOpen(true);
                }}
              />
            </div>
          )}
        </div>
      </div>

      {/* Floating actions */}
      {!loadingTemplate && sections.length > 0 && (
        <div className="fixed bottom-6 right-6 z-40 flex items-center gap-2">
          <button
            type="button"
            onClick={requestClose}
            disabled={isPending}
            className="h-9 rounded-lg border border-[#E4E7EB] bg-white px-4 text-xs font-semibold text-[#5E6870] shadow-sm transition-colors hover:bg-[#F5F7F8] hover:text-[#1F2933] disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => saveDraftMutation.mutate()}
            disabled={isPending}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#287EAD] bg-white px-4 text-xs font-semibold text-[#287EAD] shadow-sm transition-colors hover:bg-[#EEF6FB] disabled:opacity-50"
          >
            {saveDraftMutation.isPending || (uploadingFiles && !submitMutation.isPending) ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Save className="h-3.5 w-3.5" />
            )}
            Save Draft
          </button>
          <button
            type="button"
            onClick={() => submitMutation.mutate()}
            disabled={isPending}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#287EAD] px-5 text-xs font-semibold text-white shadow-sm transition-colors hover:bg-[#1E6F99] disabled:opacity-50"
          >
            {submitMutation.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Sparkles className="h-3.5 w-3.5" />
            )}
            Start workflow
          </button>
        </div>
      )}

      {isSigningOpen && (
        <SignaturePlacementModal
          mode="form"
          documentTitle={template.name || "Form Authorization"}
          signerName={`${user?.first_name ?? ""} ${user?.last_name ?? ""}`.trim()}
          formFields={detectedFormFields}
          targetFieldKey={targetSignatureField}
          onCancel={() => {
            setIsSigningOpen(false);
            setTargetSignatureField(null);
          }}
          onConfirm={(result) => {
            if (result.formFieldValues && Object.keys(result.formFieldValues).length > 0) {
              handleApplySignature(result.formFieldValues, result);
            } else if (result.signatureImage && targetSignatureField) {
              handleApplySignature({ [targetSignatureField]: result.signatureImage }, result);
            }
            setIsSigningOpen(false);
            setTargetSignatureField(null);
          }}
          onApplyToForm={(fields, rawResult) => {
            handleApplySignature(fields, rawResult);
            setIsSigningOpen(false);
            setTargetSignatureField(null);
          }}
        />
      )}

      {templatePickerOpen && (
        <div className="fixed inset-0 z-40" onClick={() => setTemplatePickerOpen(false)} />
      )}
    </div>
  );
}
