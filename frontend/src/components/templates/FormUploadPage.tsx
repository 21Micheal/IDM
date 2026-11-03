/**
 * FormUploadPage  (formerly NewFormModal)
 *
 * Dedicated full-page route at /forms/new. Template picker matches the
 * requisition create flow; filling uses FormFillModal chrome (same as
 * NewRequisitionPage: sticky header, TemplateForm, floating actions).
 */

import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { documentTypesAPI, templatesAPI, normalizeListResponse } from "@/services/api";
import {
  Loader2,
  LayoutTemplate,
  ArrowRight,
  AlertTriangle,
  ArrowLeft,
  ClipboardList,
  FileText,
  CheckCircle2,
} from "lucide-react";
import { cn } from "@/lib/utils";
import FormFillModal from "@/components/templates/FormFillModal";

type DocumentTemplateOption = {
  id: string;
  name: string;
  description?: string;
  type: "built" | "uploaded";
  kind?: "form" | "document";
  document_type?: string;
  document_type_id?: string;
  sections?: unknown[];
  sunsystems?: { budget?: Record<string, unknown>; journal?: Record<string, unknown> } | null;
};

const IMPREST_MATCHERS = ["imprest"];
function isImprestDocType(t: any): boolean {
  const code = String(t?.code || "").toLowerCase();
  const name = String(t?.name || "").toLowerCase();
  return IMPREST_MATCHERS.some((m) => code.includes(m) || name.includes(m));
}
function isBuiltForm(t: DocumentTemplateOption): boolean {
  return t.type === "built" && t.kind !== "document";
}

/** Prop kept for backwards-compat when rendered via the route (onClose → navigate back). */
export default function NewFormModal({ onClose }: { onClose?: () => void }) {
  const navigate = useNavigate();
  const goBack = () => {
    if (onClose) {
      onClose();
      return;
    }
    navigate("/forms");
  };

  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [fillingTemplateId, setFillingTemplateId] = useState<string | null>(null);

  const { data: docTypes = [], isLoading: typesLoading } = useQuery({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<any>(data),
    staleTime: 5 * 60_000,
  });

  const imprestType = useMemo(() => docTypes.find(isImprestDocType) ?? null, [docTypes]);

  const { data: templates = [], isLoading: templatesLoading } = useQuery({
    queryKey: ["templates", "document-type", imprestType?.id],
    queryFn: () => templatesAPI.list({ document_type_id: imprestType!.id }).then((r) => r.data as unknown),
    select: (data) =>
      normalizeListResponse<DocumentTemplateOption>(data)
        .filter(isBuiltForm)
        .map((t) => ({ ...t, document_type_id: t.document_type_id || t.document_type })),
    enabled: Boolean(imprestType?.id),
    staleTime: 5 * 60_000,
  });

  // Single template → skip picker.
  useEffect(() => {
    if (templates.length === 1 && !fillingTemplateId) {
      setFillingTemplateId(templates[0].id);
    }
  }, [templates, fillingTemplateId]);

  const fillingTemplate =
    templates.find((t) => t.id === fillingTemplateId) ??
    (fillingTemplateId ? templates[0] : null);

  // ── Fill experience (requisition-style) ───────────────────────────────────
  if (fillingTemplate && imprestType) {
    return (
      <FormFillModal
        template={fillingTemplate}
        documentTypeId={imprestType.id}
        documentTypeName={imprestType.name}
        templates={templates}
        onSelectTemplate={(id) => setFillingTemplateId(id)}
        onClose={goBack}
      />
    );
  }

  // ── Template picker (aligned with NewRequisition empty/picker chrome) ─────
  const loading = typesLoading || (Boolean(imprestType) && templatesLoading);
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

  return (
    <div className="min-h-full bg-[#F0F2F5]">
      <div className="sticky top-0 z-10 border-b border-[#D9DDE2] bg-white shadow-sm">
        <div className="flex w-full items-center justify-between gap-4 px-6 py-3">
          <div className="flex min-w-0 items-center gap-3">
            <button
              type="button"
              onClick={goBack}
              className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-[#E4E7EB] bg-white text-[#5E6870] transition-colors hover:bg-[#F5F7F8] hover:text-[#1F2933]"
              title="Back to forms"
            >
              <ArrowLeft className="h-4 w-4" />
            </button>
            <div className="h-5 w-px flex-shrink-0 bg-[#E4E7EB]" />
            <div className="flex min-w-0 items-center gap-2">
              <ClipboardList className="h-4 w-4 flex-shrink-0 text-[#287EAD]" />
              <div className="min-w-0">
                <h1 className="truncate text-sm font-bold text-[#1F2933]">New Form</h1>
                <p className="truncate text-[11px] text-[#8C969E]">
                  Select an Imprest template to fill in
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>

      <div className="flex flex-1 items-start justify-center px-4 pt-10">
        <div className="w-full max-w-md overflow-hidden border border-[#C8CDD2] bg-white shadow-sm">
          <div className="border-b border-[#C8CDD2] bg-[#F5F7F8] px-5 py-3">
            <p className="text-sm font-bold text-[#1F2933]">Select a form template</p>
            <p className="mt-0.5 text-xs text-[#5E6870]">
              Choose the imprest form type you want to fill in.
            </p>
          </div>

          <div className="p-5">
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#5E6870]">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading templates…
              </div>
            ) : !imprestType ? (
              <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                <span>
                  No "Imprest" document type was found. Ask an admin to create one (Admin → Document
                  types).
                </span>
              </div>
            ) : templates.length === 0 ? (
              <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
                <AlertTriangle className="h-4 w-4 flex-shrink-0" />
                <span>
                  No form templates are configured for {imprestType.name} yet. Ask an admin to build
                  one in Admin → Templates.
                </span>
              </div>
            ) : (
              <div className="space-y-2">
                {templates.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setSelectedTemplateId(t.id)}
                    className={cn(
                      "flex w-full cursor-pointer items-start gap-3 border px-3 py-3 text-left transition-colors",
                      selectedTemplateId === t.id
                        ? "border-[#287EAD] bg-[#EEF6FB]"
                        : "border-[#C8CDD2] hover:bg-[#F5F7F8]",
                    )}
                  >
                    <FileText className="mt-0.5 h-4 w-4 flex-shrink-0 text-[#287EAD]" />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5 text-sm font-semibold text-[#1F2933]">
                        <LayoutTemplate className="h-3.5 w-3.5 text-[#287EAD]" /> {t.name}
                        {selectedTemplateId === t.id && (
                          <CheckCircle2 className="ml-auto h-3.5 w-3.5 text-[#287EAD]" />
                        )}
                      </span>
                      {t.description && (
                        <span className="mt-0.5 block text-xs text-[#5E6870]">{t.description}</span>
                      )}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="flex justify-end gap-2 border-t border-[#C8CDD2] px-5 py-3">
            <button
              type="button"
              onClick={goBack}
              className="border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => selectedTemplate && setFillingTemplateId(selectedTemplate.id)}
              disabled={!selectedTemplate}
              className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:cursor-not-allowed disabled:opacity-50"
            >
              Continue <ArrowRight className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
