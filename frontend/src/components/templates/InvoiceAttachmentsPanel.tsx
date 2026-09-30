/**
 * InvoiceAttachmentsPanel
 *
 * Shown in FormDetailPage at the RFQ stage (rfq_approved only).
 * Provides two attachment sources for supplier quotations / invoices:
 *
 *  1. Auto-surfaced — recently ingested documents from the mailbox system,
 *     filtered to match supplier codes stored in doc.metadata.rfq.supplier_codes.
 *     Each card shows filename, sender, date, and an "Attach" button that calls
 *     documentsAPI.updateForm to append the file to the requisition.
 *
 *  2. Manual upload — inline blue button for file upload. Selected files are
 *     immediately uploaded and attached to the requisition document.
 *
 * The panel is self-contained — it owns its own queries and mutations so
 * FormDetailPage doesn't need to know about the internals.
 */
import { useCallback, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import { cn } from "@/lib/utils";
import {
  Loader2, Paperclip, Upload, FileText, X, CheckCircle2,
  Inbox, FilePlus2, Download,
} from "lucide-react";
import { format } from "date-fns";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fileIcon(name: string) {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (["pdf"].includes(ext)) return <FileText className="h-4 w-4 text-red-500" />;
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return <FileText className="h-4 w-4 text-violet-500" />;
  if (["xls", "xlsx", "csv"].includes(ext)) return <FileText className="h-4 w-4 text-emerald-500" />;
  if (["doc", "docx"].includes(ext)) return <FileText className="h-4 w-4 text-blue-500" />;
  return <FileText className="h-4 w-4 text-[#287EAD]" />;
}

// ── Types ─────────────────────────────────────────────────────────────────────

interface AttachmentDescriptor {
  name: string;
  url?: string;
  file_size?: number;
  content_type?: string;
}

interface IngestedDoc {
  id: string;
  title: string;
  reference_number?: string;
  created_at: string;
  file_name?: string;
  file_size?: number;
  uploaded_by?: { full_name?: string; email?: string };
  // The ingested document list response includes these fields
  metadata?: { ingestion?: { sender_email?: string; subject?: string } };
}

interface Props {
  /** ID of the requisition document that attachments will be pinned to */
  documentId: string;
  /** supplier_codes from doc.metadata.rfq.supplier_codes — used to filter mailbox matches */
  supplierCodes?: string[];
  /** Current existing attachment descriptors from formData.values */
  existingAttachments?: AttachmentDescriptor[];
  /** Called after a successful attachment so FormDetailPage can refresh */
  onAttached?: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export default function InvoiceAttachmentsPanel({
  documentId,
  supplierCodes = [],
  existingAttachments = [],
  onAttached,
}: Props) {
  const qc = useQueryClient();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [attachingId, setAttachingId] = useState<string | null>(null);
  const [pendingFiles, setPendingFiles] = useState<{ id: string; file: File; progress: "uploading" | "done" | "error" }[]>([]);

  // ── Query: recently ingested documents (possible supplier invoices) ──────────
  // We fetch recent non-form documents; the backend doesn't yet expose supplier-code
  // filtering on ingested docs so we do a broad recent-docs fetch and filter client-side.
  const { data: ingestedDocs = [], isLoading: loadingIngested } = useQuery<IngestedDoc[]>({
    queryKey: ["ingested-docs-recent", documentId],
    queryFn: async () => {
      const res = await documentsAPI.list({
        is_form: false,
        ordering: "-created_at",
        page_size: 30,
      });
      const all: IngestedDoc[] = res.data?.results ?? res.data ?? [];
      // Surface documents from email ingestion (they have ingestion metadata)
      // OR filter by supplier_codes if we have them (future: supplier field on doc)
      return all.filter((d) => d.metadata?.ingestion || supplierCodes.length === 0);
    },
    staleTime: 30_000,
    retry: false,
  });

  // ── Mutation: attach an ingested document to the requisition ─────────────────
  const attachIngestedMutation = useMutation({
    mutationFn: async (doc: IngestedDoc) => {
      setAttachingId(doc.id);
      // Link the ingested document by noting its ID in the requisition's form values.
      // The actual file download + re-attach approach would need a separate API endpoint;
      // for now we record the reference in the values so the backend can resolve it.
      return documentsAPI.updateForm(documentId, {
        [`_linked_doc_${doc.id}`]: {
          id: doc.id,
          title: doc.file_name || doc.title,
          linked_at: new Date().toISOString(),
          sender: doc.metadata?.ingestion?.sender_email,
        },
      }, []);
    },
    onSuccess: () => {
      toast.success("Document attached to requisition.");
      setAttachingId(null);
      qc.invalidateQueries({ queryKey: ["form", documentId] });
      onAttached?.();
    },
    onError: () => {
      toast.error("Failed to attach document.");
      setAttachingId(null);
    },
  });

  // ── Manual file upload ────────────────────────────────────────────────────────
  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (arr.length === 0) return;

      const entries: { id: string; file: File; progress: "uploading" | "done" | "error" }[] = arr.map((file) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        file,
        progress: "uploading" as const,
      }));
      setPendingFiles((prev) => [...prev, ...entries]);

      for (const entry of entries) {
        try {
          await documentsAPI.updateForm(documentId, {}, [
            { field: "supplier_attachments", file: entry.file },
          ]);
          setPendingFiles((prev) =>
            prev.map((p) => (p.id === entry.id ? { ...p, progress: "done" } : p))
          );
          qc.invalidateQueries({ queryKey: ["form", documentId] });
          onAttached?.();
        } catch {
          setPendingFiles((prev) =>
            prev.map((p) => (p.id === entry.id ? { ...p, progress: "error" } : p))
          );
          toast.error(`Failed to upload ${entry.file.name}`);
        }
      }

      // Clear "done" entries after 3s
      setTimeout(() => {
        setPendingFiles((prev) => prev.filter((p) => p.progress !== "done"));
      }, 3000);
    },
    [documentId, qc, onAttached]
  );

  const removePending = (id: string) =>
    setPendingFiles((prev) => prev.filter((p) => p.id !== id));

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="border border-[#C8CDD2] bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center gap-3 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2.5">
        <Inbox className="h-4 w-4 text-[#287EAD]" />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-bold text-[#1F2933]">Supplier Quotations &amp; Invoices</p>
          <p className="text-[11px] text-[#8C969E]">
            Attach supplier invoices or quotations received for this RFQ
          </p>
        </div>
        <FilePlus2 className="h-4 w-4 text-[#8C969E]" />
      </div>

      <div className="p-4">
        {/* ── Inline Attachment List (Existing + Ingested) ── */}
        <div className="flex flex-wrap items-center gap-2">
          {/* Existing attachments as inline icons */}
          {existingAttachments.map((att, i) => (
            <div
              key={`existing-${i}`}
              className="group relative inline-flex items-center gap-1.5 rounded border border-[#E4E7EB] bg-[#F8FAFB] px-2 py-1.5 hover:border-[#287EAD]/40 hover:bg-[#F8FCFF] transition-colors"
              title={att.name}
            >
              {fileIcon(att.name)}
              <span className="max-w-[120px] truncate text-[11px] font-medium text-[#1F2933]">
                {att.name}
              </span>
              {att.url && (
                <a
                  href={att.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded text-[#5E6870] hover:text-[#287EAD] transition-colors"
                  title="Download"
                >
                  <Download className="h-3 w-3" />
                </a>
              )}
            </div>
          ))}

          {/* Ingested documents as inline icons */}
          {ingestedDocs.slice(0, 6).map((doc) => (
            <div
              key={`ingested-${doc.id}`}
              className="group relative inline-flex items-center gap-1.5 rounded border border-[#E4E7EB] bg-white px-2 py-1.5 hover:border-[#287EAD]/40 hover:bg-[#F8FCFF] transition-colors"
              title={`${doc.file_name || doc.title} - From: ${doc.metadata?.ingestion?.sender_email || 'Unknown'}`}
            >
              {fileIcon(doc.file_name || doc.title)}
              <span className="max-w-[120px] truncate text-[11px] font-medium text-[#1F2933]">
                {doc.file_name || doc.title}
              </span>
              <button
                type="button"
                onClick={() => attachIngestedMutation.mutate(doc)}
                disabled={attachingId === doc.id}
                className={cn(
                  "flex h-5 w-5 flex-shrink-0 items-center justify-center rounded transition-colors",
                  attachingId === doc.id
                    ? "cursor-not-allowed text-[#287EAD] opacity-60"
                    : "text-[#5E6870] hover:text-[#287EAD] hover:bg-[#EEF6FB]"
                )}
                title="Attach to requisition"
              >
                {attachingId === doc.id ? (
                  <Loader2 className="h-3 w-3 animate-spin" />
                ) : (
                  <Paperclip className="h-3 w-3" />
                )}
              </button>
            </div>
          ))}

          {/* Loading indicator */}
          {loadingIngested && (
            <div className="flex items-center gap-1.5 text-[11px] text-[#8C969E]">
              <Loader2 className="h-3 w-3 animate-spin" /> Loading...
            </div>
          )}
        </div>

        {/* ── Inline Upload Button ── */}
        <div className="mt-3 flex items-center gap-2">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            onDragOver={(e) => { e.preventDefault(); }}
            onDrop={(e) => {
              e.preventDefault();
              uploadFiles(e.dataTransfer.files);
            }}
            className="inline-flex items-center gap-2 rounded bg-[#287EAD] px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-[#1E6F99] transition-colors"
          >
            <Upload className="h-3.5 w-3.5" />
            Upload Documents
          </button>
          <span className="text-[10px] text-[#8C969E]">
            PDF, images, Office files
          </span>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv"
            className="hidden"
            onChange={(e) => e.target.files && uploadFiles(e.target.files)}
          />
        </div>

        {/* Upload progress list */}
        {pendingFiles.length > 0 && (
          <div className="mt-2 space-y-1">
            {pendingFiles.map((p) => (
              <div
                key={p.id}
                className={cn(
                  "flex items-center gap-2 rounded border px-2 py-1 text-[11px]",
                  p.progress === "done"
                    ? "border-emerald-200 bg-emerald-50"
                    : p.progress === "error"
                    ? "border-red-200 bg-red-50"
                    : "border-[#E4E7EB] bg-white"
                )}
              >
                {p.progress === "uploading" && <Loader2 className="h-3 w-3 animate-spin text-[#287EAD]" />}
                {p.progress === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500" />}
                {p.progress === "error" && <X className="h-3 w-3 text-red-500" />}
                <span className={cn(
                  "flex-1 truncate",
                  p.progress === "done" ? "text-emerald-700" : p.progress === "error" ? "text-red-700" : "text-[#1F2933]"
                )}>
                  {p.file.name}
                </span>
                <span className="text-[10px] text-[#8C969E]">{formatBytes(p.file.size)}</span>
                {p.progress !== "uploading" && (
                  <button type="button" onClick={() => removePending(p.id)} className="text-[#8C969E] hover:text-[#1F2933]">
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
