/**
 * FormUploadPage (formerly NewFormModal)
 *
 * Dedicated full-page route at /forms/new.
 * Automatically loads the first available form template (or template_id query param),
 * with in-header template switcher, document-width card (max-w-[1100px]), and floating action buttons,
 * matching NewRequisitionPage styling and width.
 */

import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { templatesAPI } from "@/services/api";
import {
  Loader2,
  ArrowLeft,
  FileText,
} from "lucide-react";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
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

/** Prop kept for backwards-compat when rendered via the route (onClose → navigate back). */
export default function NewFormModal({ onClose }: { onClose?: () => void }) {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const preselectedTemplateId = searchParams.get("template_id");

  const goBack = () => {
    if (onClose) {
      onClose();
      return;
    }
    navigate("/forms");
  };

  const [fillingTemplateId, setFillingTemplateId] = useState<string | null>(preselectedTemplateId || null);

  const { data: templates = [], isLoading: templatesLoading } = useQuery({
    queryKey: ["templates", "built-forms"],
    queryFn: async () => {
      const res = await templatesAPI.list({ type: "built" });
      const all = res.data?.results || res.data || [];
      return Array.isArray(all)
        ? (all.filter((t: any) => t.type === "built" && t.kind !== "document") as DocumentTemplateOption[])
        : [];
    },
    ...QUERY_SHORT_STALE,
    refetchOnMount: "always",
  });

  // Auto-select first template (or preselected from URL)
  useEffect(() => {
    if (!fillingTemplateId && templates.length > 0) {
      if (preselectedTemplateId && templates.some((t) => t.id === preselectedTemplateId)) {
        setFillingTemplateId(preselectedTemplateId);
      } else {
        setFillingTemplateId(templates[0].id);
      }
    }
  }, [templates, fillingTemplateId, preselectedTemplateId]);

  if (templatesLoading) {
    return (
      <div className="flex h-full min-h-[60vh] items-center justify-center bg-[#F0F2F5]">
        <Loader2 className="h-8 w-8 animate-spin text-[#287EAD]" />
      </div>
    );
  }

  if (templates.length === 0) {
    return (
      <div className="flex h-full min-h-[60vh] items-center justify-center bg-[#F0F2F5] p-6">
        <div className="w-full max-w-md rounded-lg border border-[#D9DEE3] bg-white p-8 shadow-sm">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-lg bg-amber-50">
              <FileText className="h-5 w-5 text-amber-500" />
            </div>
            <div>
              <h2 className="text-base font-bold text-[#1F2933]">No Form Templates Available</h2>
              <p className="mt-1.5 text-sm text-[#5E6870]">
                Ask an administrator to configure a form template.
              </p>
            </div>
          </div>
          <button
            onClick={goBack}
            className="mt-6 inline-flex items-center gap-2 rounded-lg bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] transition-colors"
          >
            <ArrowLeft className="h-4 w-4" /> Go back
          </button>
        </div>
      </div>
    );
  }

  const fillingTemplate =
    templates.find((t) => t.id === fillingTemplateId) ?? templates[0];

  return (
    <FormFillModal
      template={fillingTemplate}
      documentTypeId={fillingTemplate.document_type_id || fillingTemplate.document_type || ""}
      documentTypeName={fillingTemplate.name}
      templates={templates}
      onSelectTemplate={(id) => setFillingTemplateId(id)}
      onClose={goBack}
    />
  );
}
