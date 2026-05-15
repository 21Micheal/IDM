import { ChevronRight, Sparkles, CheckCircle, XCircle, AlertCircle } from "lucide-react";
import clsx from "clsx";
import type { DocumentType, MetadataField } from "@/types";
import type { BulkDocReviewState } from "./bulkUploadTypes";
import { getMetadataFieldKey } from "./bulkUploadUtils";
import OcrStatusBadge from "@/components/documents/OcrStatusBadge";

type Props = {
  state: BulkDocReviewState;
  documentType: DocumentType;
  onChange: (next: BulkDocReviewState) => void;
};

function FieldInput({
  label,
  value,
  onChange,
  type = "text",
  suggested,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  type?: string;
  suggested?: boolean;
}) {
  return (
    <div>
      <label className="label flex items-center gap-1.5">
        {label}
        {suggested && (
          <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold px-1.5 py-0.5 rounded-full bg-teal/15 text-teal border border-teal/25">
            <Sparkles className="w-2.5 h-2.5" /> OCR
          </span>
        )}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={clsx("input", suggested && "ring-1 ring-teal/40")}
      />
    </div>
  );
}

function metadataFieldsForType(documentType: DocumentType): MetadataField[] {
  return [...(documentType.metadata_fields ?? [])].sort((a, b) => a.order - b.order);
}

export default function BulkDocumentReviewCard({ state, documentType, onChange }: Props) {
  const fields = metadataFieldsForType(documentType);
  const setValue = (key: string, value: string) => {
    onChange({ ...state, values: { ...state.values, [key]: value } });
  };

  const isSuggested = (key: string) => state.suggestedScores[key] !== undefined;

  return (
    <div
      className={clsx(
        "rounded-xl border bg-card overflow-hidden transition-colors",
        state.rejected ? "border-destructive/40 opacity-80" : "border-border",
      )}
    >
      <button
        type="button"
        onClick={() => onChange({ ...state, expanded: !state.expanded })}
        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/40"
      >
        <ChevronRight
          className={clsx("w-4 h-4 text-muted-foreground transition-transform", state.expanded && "rotate-90")}
        />
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-foreground truncate">{state.fileName}</p>
          <p className="text-xs text-muted-foreground font-mono">{state.referenceNumber}</p>
        </div>
        <OcrStatusBadge
          status={
            state.ocrStatus === "pending"
            || state.ocrStatus === "processing"
            || state.ocrStatus === "done"
            || state.ocrStatus === "failed"
              ? state.ocrStatus
              : null
          }
        />
        {state.approved && !state.rejected && (
          <CheckCircle className="w-4 h-4 text-teal flex-shrink-0" />
        )}
        {state.rejected && (
          <XCircle className="w-4 h-4 text-destructive flex-shrink-0" />
        )}
      </button>

      {state.expanded && (
        <div className="px-4 pb-4 pt-1 border-t border-border space-y-4">
          {state.ocrStatus === "failed" && (
            <div className="flex items-start gap-2 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              OCR could not extract text — fill in fields manually.
            </div>
          )}

          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => onChange({ ...state, approved: true, rejected: false })}
              className={clsx(
                "flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors",
                state.approved && !state.rejected
                  ? "bg-teal text-teal-foreground border-teal"
                  : "border-border hover:bg-muted",
              )}
            >
              Include
            </button>
            <button
              type="button"
              onClick={() => onChange({ ...state, approved: false, rejected: true })}
              className={clsx(
                "flex-1 py-2 rounded-lg text-sm font-semibold border transition-colors",
                state.rejected
                  ? "bg-destructive/10 text-destructive border-destructive/30"
                  : "border-border hover:bg-muted",
              )}
            >
              Skip
            </button>
          </div>

          {!state.rejected && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <FieldInput
                label="Title"
                value={state.values.title ?? ""}
                onChange={(v) => setValue("title", v)}
                suggested={isSuggested("title")}
              />
              {fields.map((field) => {
                const key = getMetadataFieldKey(field);
                const path = [
                  "title", "supplier", "amount", "currency",
                  "document_date", "due_date", "quantity", "description", "uom",
                ].includes(key)
                  ? key
                  : `metadata.${key}`;
                const inputType =
                  field.field_type === "date" ? "date"
                  : field.field_type === "number" || field.field_type === "currency" ? "number"
                  : "text";
                if (field.field_type === "select") {
                  return (
                    <div key={field.id}>
                      <label className="label">{field.label}</label>
                      <select
                        className="input"
                        value={state.values[path] ?? ""}
                        onChange={(e) => setValue(path, e.target.value)}
                      >
                        <option value="">Select…</option>
                        {(field.select_options ?? []).map((opt) => (
                          <option key={opt} value={opt}>{opt}</option>
                        ))}
                      </select>
                    </div>
                  );
                }
                return (
                  <FieldInput
                    key={field.id}
                    label={field.label}
                    value={state.values[path] ?? ""}
                    onChange={(v) => setValue(path, v)}
                    type={inputType}
                    suggested={isSuggested(path)}
                  />
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
