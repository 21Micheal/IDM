/**
 * InvoiceAttachmentsPanel
 *
 * Shown in FormDetailPage at the RFQ stage AFTER full approval (rfq_approved).
 * Compact, minimal design:
 *  - Existing attachments: inline thumbnail chips (icon · name · size · download)
 *  - Manual upload: a single small blue button (no wide dropzone)
 *  - Auto-ingested: compact inline list rows with an "Attach" button
 */
import { useCallback, useRef, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { documentsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import { cn } from "@/lib/utils";
import {
  Loader2, Paperclip, Upload, FileText, CheckCircle2,
  Inbox, Download, X,
} from "lucide-react";
import { format } from "date-fns";

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatBytes(b: number) {
  if (b < 1024) return `${b} B`;
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`;
  return `${(b / 1024 / 1024).toFixed(1)} MB`;
}

function fileExtColor(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "text-red-500";
  if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) return "text-violet-500";
  if (["xls", "xlsx", "csv"].includes(ext)) return "text-emerald-600";
  if (["doc", "docx"].includes(ext)) return "text-blue-500";
  return "text-[#287EAD]";
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
  metadata?: { ingestion?: { sender_email?: string; subject?: string } };
}

interface Props {
  documentId: string;
  supplierCodes?: string[];
  existingAttachments?: AttachmentDescriptor[];
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
  const [pendingFiles, setPendingFiles] = useState<
    { id: string; file: File; progress: "uploading" | "done" | "error" }[]
  >([]);

  // ── Query: recently ingested docs ────────────────────────────────────────────
  const { data: ingestedDocs = [], isLoading: loadingIngested } = useQuery<IngestedDoc[]>({
    queryKey: ["ingested-docs-recent", documentId],
    queryFn: async () => {
      const res = await documentsAPI.list({ is_form: false, ordering: "-created_at", page_size: 30 });
      const all: IngestedDoc[] = res.data?.results ?? res.data ?? [];
      return all.filter((d) => d.metadata?.ingestion || supplierCodes.length === 0);
    },
    staleTime: 30_000,
    retry: false,
  });

  // ── Mutation: attach ingested doc ────────────────────────────────────────────
  const attachIngestedMutation = useMutation({
    mutationFn: async (doc: IngestedDoc) => {
      setAttachingId(doc.id);
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

  // ── Manual upload ────────────────────────────────────────────────────────────
  const uploadFiles = useCallback(
    async (files: FileList | File[]) => {
      const arr = Array.from(files);
      if (arr.length === 0) return;

      const entries = arr.map((file) => ({
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

      setTimeout(() => {
        setPendingFiles((prev) => prev.filter((p) => p.progress !== "done"));
      }, 3000);
    },
    [documentId, qc, onAttached]
  );

  // ── Render ────────────────────────────────────────────────────────────────────
  return (
    <div className="border border-[#C8CDD2] bg-white shadow-sm">
      {/* Header */}
      <div className="flex items-center justify-between gap-3 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2.5">
        <div className="flex items-center gap-2 min-w-0">
          <Inbox className="h-4 w-4 text-[#287EAD] shrink-0" />
          <div className="min-w-0">
            <p className="text-xs font-bold text-[#1F2933]">Supplier Quotations &amp; Invoices</p>
            <p className="text-[11px] text-[#8C969E]">Received from suppliers following RFQ notifications</p>
          </div>
        </div>

        {/* Upload button — compact, right-aligned */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          className="inline-flex shrink-0 items-center gap-1.5 bg-[#287EAD] px-3 py-1.5 text-[11px] font-semibold text-white hover:bg-[#206D99] transition-colors"
        >
          <Upload className="h-3 w-3" />
          Attach files
        </button>
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept=".pdf,.png,.jpg,.jpeg,.gif,.webp,.doc,.docx,.xls,.xlsx,.csv"
          className="hidden"
          onChange={(e) => e.target.files && uploadFiles(e.target.files)}
        />
      </div>

      <div className="p-3 space-y-3">
        {/* ── Existing Attachments — inline thumbnail chips ── */}
        {existingAttachments.length > 0 && (
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#8C969E]">
              Attached ({existingAttachments.length})
            </p>
            <div className="flex flex-wrap gap-2">
              {existingAttachments.map((att, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1.5 border border-[#E4E7EB] bg-[#F8FAFB] px-2.5 py-1.5 text-xs max-w-[220px]"
                  title={att.name}
                >
                  <FileText className={cn("h-3.5 w-3.5 shrink-0", fileExtColor(att.name))} />
                  <span className="truncate text-[#1F2933] font-medium flex-1 min-w-0">{att.name}</span>
                  {att.file_size && (
                    <span className="text-[10px] text-[#8C969E] shrink-0">{formatBytes(att.file_size)}</span>
                  )}
                  {att.url && (
                    <a
                      href={att.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="shrink-0 text-[#8C969E] hover:text-[#287EAD] transition-colors"
                      title="Download"
                    >
                      <Download className="h-3 w-3" />
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ── Upload progress chips ── */}
        {pendingFiles.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {pendingFiles.map((p) => (
              <div
                key={p.id}
                className={cn(
                  "flex items-center gap-1.5 border px-2.5 py-1.5 text-xs",
                  p.progress === "done"
                    ? "border-emerald-200 bg-emerald-50"
                    : p.progress === "error"
                    ? "border-red-200 bg-red-50"
                    : "border-[#E4E7EB] bg-white"
                )}
              >
                {p.progress === "uploading" && <Loader2 className="h-3 w-3 animate-spin text-[#287EAD] shrink-0" />}
                {p.progress === "done" && <CheckCircle2 className="h-3 w-3 text-emerald-500 shrink-0" />}
                {p.progress === "error" && <X className="h-3 w-3 text-red-500 shrink-0" />}
                <span className={cn(
                  "truncate max-w-[140px]",
                  p.progress === "done" ? "text-emerald-700" : p.progress === "error" ? "text-red-700" : "text-[#1F2933]"
                )}>
                  {p.file.name}
                </span>
                {p.progress !== "uploading" && (
                  <button
                    type="button"
                    onClick={() => setPendingFiles((prev) => prev.filter((x) => x.id !== p.id))}
                    className="shrink-0 text-[#8C969E] hover:text-[#1F2933]"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
            ))}
          </div>
        )}

        {/* ── Auto-ingested suggestions ── */}
        {(loadingIngested || ingestedDocs.length > 0) && (
          <div>
            <p className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[#8C969E]">
              From email ingestion
            </p>
            {loadingIngested ? (
              <div className="flex items-center gap-2 py-2 text-xs text-[#8C969E]">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking ingested emails…
              </div>
            ) : (
              <div className="space-y-1">
                {ingestedDocs.slice(0, 6).map((doc) => (
                  <div
                    key={doc.id}
                    className="flex items-center gap-2 border border-[#E4E7EB] bg-white px-3 py-1.5 hover:border-[#287EAD]/40 hover:bg-[#F8FCFF] transition-colors"
                  >
                    <FileText className={cn("h-3.5 w-3.5 shrink-0", fileExtColor(doc.file_name || doc.title))} />
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-xs font-medium text-[#1F2933]">{doc.file_name || doc.title}</p>
                      <p className="text-[10px] text-[#8C969E]">
                        {doc.metadata?.ingestion?.sender_email ? `${doc.metadata.ingestion.sender_email} · ` : ""}
                        {format(new Date(doc.created_at), "dd MMM yyyy HH:mm")}
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => attachIngestedMutation.mutate(doc)}
                      disabled={attachingId === doc.id}
                      className={cn(
                        "inline-flex shrink-0 items-center gap-1 px-2 py-1 text-[11px] font-semibold transition-colors",
                        attachingId === doc.id
                          ? "cursor-not-allowed bg-[#EEF6FB] text-[#287EAD] opacity-60"
                          : "bg-[#287EAD]/10 text-[#287EAD] hover:bg-[#287EAD] hover:text-white"
                      )}
                    >
                      {attachingId === doc.id ? <Loader2 className="h-3 w-3 animate-spin" /> : <Paperclip className="h-3 w-3" />}
                      Attach
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Empty state */}
        {existingAttachments.length === 0 && pendingFiles.length === 0 && !loadingIngested && ingestedDocs.length === 0 && (
          <p className="py-2 text-xs text-[#8C969E]">
            No supplier documents attached yet. Use the <strong>Attach files</strong> button to upload quotations or invoices received from suppliers.
          </p>
        )}
      </div>
    </div>
  );
}
