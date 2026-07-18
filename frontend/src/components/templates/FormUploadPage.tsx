/**
 * NewFormModal
 *
 * Replaces the earlier dedicated FormUploadPage — forms only ever come from
 * one document type (Imprest) today, so a full page with a document-type
 * picker + live preview was overkill. This is just: find the Imprest
 * document type, list its built form templates, let the person pick one
 * (auto-skipped when there's only one), then hand off straight to
 * FormFillModal to actually fill and create it.
 *
 * NOTE: matching "Imprest" is done by document-type code/name today (see
 * IMPREST_MATCHERS below) since there's no first-class "this document type
 * is a form type" flag on DocumentType yet. Once the backend wiring pass
 * adds one, swap this for a real filter instead of a name guess.
 */

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { documentTypesAPI, templatesAPI, normalizeListResponse } from "@/services/api";
import { X, Loader2, LayoutTemplate, ArrowRight, AlertTriangle } from "lucide-react";
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

export default function NewFormModal({ onClose }: { onClose: () => void }) {
  const [selectedTemplateId, setSelectedTemplateId] = useState("");
  const [fillingTemplate, setFillingTemplate] = useState<DocumentTemplateOption | null>(null);

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
    select: (data) => normalizeListResponse<DocumentTemplateOption>(data)
      .filter(isBuiltForm)
      .map((t) => ({ ...t, document_type_id: t.document_type_id || t.document_type })),
    enabled: Boolean(imprestType?.id),
    staleTime: 5 * 60_000,
  });

  // The common case — exactly one imprest form template — skips the picker
  // entirely and goes straight to filling it.
  useEffect(() => {
    if (templates.length === 1 && !fillingTemplate) {
      setFillingTemplate(templates[0]);
    }
  }, [templates, fillingTemplate]);

  if (fillingTemplate && imprestType) {
    return (
      <FormFillModal
        template={fillingTemplate}
        documentTypeId={imprestType.id}
        documentTypeName={imprestType.name}
        onClose={onClose}
      />
    );
  }

  const loading = typesLoading || (Boolean(imprestType) && templatesLoading);
  const selectedTemplate = templates.find((t) => t.id === selectedTemplateId) ?? null;

  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md overflow-hidden border border-[#C8CDD2] bg-white shadow-2xl">
        <div className="flex items-start justify-between border-b border-[#1E6F99] bg-[#287EAD] px-5 py-3 text-white">
          <div>
            <p className="text-sm font-semibold">New Form</p>
            <p className="mt-0.5 text-xs text-white/75">Select the imprest form to fill in.</p>
          </div>
          <button onClick={onClose} className="mt-0.5 flex-shrink-0 p-1.5 text-white/70 hover:text-white">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-[#5E6870]">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading templates…
            </div>
          ) : !imprestType ? (
            <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span>No "Imprest" document type was found. Ask an admin to create one (Admin → Document types).</span>
            </div>
          ) : templates.length === 0 ? (
            <div className="flex items-start gap-3 border border-amber-200 bg-amber-50 px-3 py-3 text-xs text-amber-800">
              <AlertTriangle className="h-4 w-4 flex-shrink-0" />
              <span>No form templates are configured for {imprestType.name} yet. Ask an admin to build one in Admin → Templates.</span>
            </div>
          ) : (
            <div className="space-y-2">
              {templates.map((t) => (
                <label
                  key={t.id}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 border px-3 py-2.5 transition-colors",
                    selectedTemplateId === t.id ? "border-[#287EAD] bg-[#EEF6FB]" : "border-[#C8CDD2] hover:bg-[#F5F7F8]",
                  )}
                >
                  <input
                    type="radio"
                    name="imprest-template"
                    className="mt-1 accent-[#287EAD]"
                    checked={selectedTemplateId === t.id}
                    onChange={() => setSelectedTemplateId(t.id)}
                  />
                  <span className="min-w-0">
                    <span className="flex items-center gap-1.5 text-sm font-semibold text-[#1F2933]">
                      <LayoutTemplate className="h-3.5 w-3.5 text-[#287EAD]" /> {t.name}
                    </span>
                    {t.description && <span className="mt-0.5 block text-xs text-[#5E6870]">{t.description}</span>}
                  </span>
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex justify-end gap-2 border-t border-[#C8CDD2] px-5 py-3">
          <button onClick={onClose} className="border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">
            Cancel
          </button>
          <button
            onClick={() => selectedTemplate && setFillingTemplate(selectedTemplate)}
            disabled={!selectedTemplate}
            className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:cursor-not-allowed disabled:opacity-50"
          >
            Continue <ArrowRight className="h-4 w-4" />
          </button>
        </div>
      </div>
    </div>
  );
}