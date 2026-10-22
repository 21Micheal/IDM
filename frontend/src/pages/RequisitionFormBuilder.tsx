/**
 * RequisitionFormBuilder.tsx
 * 
 * Wrapper around TemplateBuilderV2 for the requisitions deployment.
 * Handles document type loading, template saving, and provides the builder
 * with necessary props for creating requisition forms.
 */

import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "react-toastify";
import TemplateBuilderV2 from "@/pages/TemplateBuilderV2";
import { templatesAPI, documentTypesAPI } from "@/services/api";
import type { Template } from "@/pages/TemplatesPage";

export default function RequisitionFormBuilder() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  // Load document types
  const { data: documentTypes = [] } = useQuery({
    queryKey: ["document-types"],
    queryFn: async () => {
      const res = await documentTypesAPI.list();
      // Handle different response structures
      const types = res.data?.results || res.data || [];
      return Array.isArray(types) ? types : [];
    },
  });

  // Save template mutation
  const saveMutation = useMutation({
    mutationFn: (template: Template) => {
      const payload = {
        name: template.name,
        description: template.description || "",
        type: "built",
        kind: "form",
        document_type: template.document_type_id,
        sections: template.sections,
        tags: template.tags || [],
      };
      
      if (template.id) {
        return templatesAPI.update(template.id, payload);
      } else {
        return templatesAPI.create(payload);
      }
    },
    onSuccess: () => {
      toast.success("Template saved successfully");
      qc.invalidateQueries({ queryKey: ["templates"] });
      navigate("/admin/templates");
    },
    onError: (err: any) => {
      const msg = err?.response?.data?.detail || "Failed to save template";
      toast.error(msg);
    },
  });

  const handleSave = (template: Template, stayOpen?: boolean) => {
    saveMutation.mutate(template);
  };

  const handleCancel = () => {
    navigate("/");
  };

  return (
    <TemplateBuilderV2
      initial={null}
      documentTypes={documentTypes}
      onSave={handleSave}
      onCancel={handleCancel}
      isSaving={saveMutation.isPending}
    />
  );
}
