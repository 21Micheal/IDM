import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { Download, ExternalLink, Loader2, X, FileText } from "lucide-react";
import { documentsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import LpoPdfPreview from "@/components/documents/LpoPdfPreview";

function normalizeApiFileUrl(url?: string | null): string | undefined {
  if (!url) return undefined;
  try {
    const parsed = new URL(url, window.location.origin);
    if (parsed.pathname.startsWith("/api/")) {
      return new URL(`${parsed.pathname}${parsed.search}${parsed.hash}`, window.location.origin).toString();
    }
  } catch {
    // Keep non-API and malformed URLs unchanged so callers can report errors.
  }
  return url;
}

export interface PaymentVoucherPreviewModalProps {
  voucherId: string;
  reference?: string;
  kind?: string;
  requisitionId?: string;
  requisitionRef?: string;
  onClose: () => void;
}

export default function PaymentVoucherPreviewModal({
  voucherId,
  reference,
  kind,
  requisitionId,
  requisitionRef,
  onClose,
}: PaymentVoucherPreviewModalProps) {
  const [downloading, setDownloading] = useState(false);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [onClose]);

  const previewQuery = useQuery({
    queryKey: ["payment-voucher-pdf", voucherId],
    queryFn: async () => {
      const { data } = await documentsAPI.previewUrl(voucherId);
      return { ...data, url: normalizeApiFileUrl(data.url) ?? data.url };
    },
    enabled: Boolean(voucherId),
    refetchInterval: (query) => (query.state.data?.viewer === "processing" ? 1_500 : false),
  });

  const pdfUrl = previewQuery.data?.viewer === "pdfjs" ? previewQuery.data.url : null;

  const handleDownload = async () => {
    if (!voucherId) return;
    setDownloading(true);
    try {
      const response = await documentsAPI.downloadAsPdf(voucherId);
      const blobUrl = URL.createObjectURL(new Blob([response.data], { type: "application/pdf" }));
      const link = document.createElement("a");
      link.href = blobUrl;
      link.download = `Payment_Voucher_${kind ? `${kind.toUpperCase()}_` : ""}${reference || "PV"}.pdf`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(blobUrl), 1_000);
    } catch {
      toast.error("Could not download the payment voucher PDF. Please check your permissions and retry.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[250] flex items-center justify-center bg-black/60 p-3 sm:p-6 backdrop-blur-xs"
      role="dialog"
      aria-modal="true"
      aria-label={`Payment Voucher ${reference || "document"}`}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="flex max-h-[94vh] w-full max-w-5xl flex-col overflow-hidden border border-[#AEB5BB] bg-white shadow-2xl rounded-none">
        {/* Header */}
        <div className="flex items-center justify-between gap-3 border-b border-[#C8CDD1] bg-[#F5F7F8] px-4 py-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center bg-[#287EAD]/10 text-[#0A4D68]">
              <FileText className="h-4 w-4 text-[#287EAD]" />
            </div>
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="truncate text-sm font-bold text-[#1F2933]">
                  Payment Voucher {reference ? `— ${reference}` : ""}
                </h2>
                {kind === "imprest" && (
                  <span className="inline-block bg-[#C5E6F5] text-[#0A4D68] text-[10px] px-1.5 py-0.5 font-bold uppercase tracking-wider">
                    DSA / Imprest Advance
                  </span>
                )}
                {kind === "retirement" && (
                  <span className="inline-block bg-indigo-100 text-indigo-900 text-[10px] px-1.5 py-0.5 font-bold uppercase tracking-wider">
                    Retirement Over-expenditure / Claim
                  </span>
                )}
              </div>
              <p className="truncate text-xs text-[#5E6870]">
                {requisitionRef
                  ? `${kind === "imprest" ? "Imprest advance voucher" : kind === "retirement" ? "Retirement claim voucher" : "Generated"} for Requisition ${requisitionRef}`
                  : "Official Payment Voucher"}
              </p>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-2">
            {requisitionId && (
              <Link
                to={`/${requisitionId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 border border-[#287EAD] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#EEF6FB] transition-colors rounded-none"
                title="Open parent requisition in new tab"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                <span className="hidden sm:inline">Open Requisition</span>
              </Link>
            )}

            <button
              type="button"
              onClick={() => void handleDownload()}
              disabled={downloading}
              className="inline-flex items-center gap-1.5 border border-[#287EAD] bg-[#287EAD] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1E6F99] transition-colors rounded-none disabled:opacity-50"
            >
              {downloading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              <span>{downloading ? "Downloading…" : "Download PDF"}</span>
            </button>

            <button
              type="button"
              aria-label="Close"
              onClick={onClose}
              className="border border-[#C8CDD2] bg-white p-1.5 text-[#35434D] hover:bg-[#E9EEF1] transition-colors rounded-none"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
        </div>

        {/* PDF Viewer Body */}
        <div className="min-h-[50vh] flex-1 bg-[#E9EEF1] flex flex-col overflow-hidden">
          {pdfUrl ? (
            <LpoPdfPreview
              url={pdfUrl}
              title={`Payment Voucher ${reference || "PV"}`}
              canPrint={true}
              onPrint={() => documentsAPI.filePrintEvent(voucherId).then(() => undefined)}
            />
          ) : previewQuery.isError || previewQuery.data?.preview_status === "failed" ? (
            <div className="flex h-[50vh] flex-col items-center justify-center gap-2 px-6 text-center text-sm text-[#5E6870]">
              <p>{previewQuery.data?.preview_error || "Could not load the payment voucher PDF. Please retry."}</p>
              <button
                type="button"
                onClick={() => void previewQuery.refetch()}
                className="border border-[#AEB5BB] bg-white px-3 py-2 text-xs font-semibold text-[#1F2933] hover:bg-[#F5F7F8] rounded-none"
              >
                Retry preview
              </button>
            </div>
          ) : (
            <div className="flex h-[50vh] flex-col items-center justify-center gap-3 px-6 text-center text-sm text-[#46545E]">
              <Loader2 className="h-6 w-6 animate-spin text-[#287EAD]" />
              <p>Loading payment voucher document…</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
