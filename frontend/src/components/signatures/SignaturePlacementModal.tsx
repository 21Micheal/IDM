/**
 * SignaturePlacementModal — reusable PDF signing surface.
 *
 * Renders the document's PDF, lets the signer drag their saved e-signature onto
 * the page, and returns the placement. Used by workflow approval signing
 * (WorkflowActionPanel) and the ad-hoc "Request signature" flow.
 */
import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import clsx from "clsx";
import { documentsAPI, profileAPI } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import type { PDFDocumentProxy } from "pdfjs-dist";

const pdfWorkerPath = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
const pdfjsImportPromise = import("pdfjs-dist");

export type SignaturePlacement = {
  page_number: number;
  x_percent: number;
  y_percent: number;
  width_percent?: number;
};

export default function SignaturePlacementModal({
  documentId,
  documentTitle,
  documentRef,
  note,
  confirmLabel = "Confirm signature",
  onCancel,
  onConfirm,
  isSubmitting,
}: {
  documentId: string;
  documentTitle?: string;
  documentRef?: string;
  note?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (placement: SignaturePlacement) => void;
  isSubmitting: boolean;
}) {
  const token = useAuthStore((s) => s.accessToken);
  const [hostEl, setHostEl] = useState<HTMLDivElement | null>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.2);
  const [pageSize, setPageSize] = useState({ width: 0, height: 0 });
  const [pos, setPos] = useState({ x: 62, y: 72 });
  const [dragging, setDragging] = useState(false);
  const [error, setError] = useState("");

  const { data: preview } = useQuery({
    queryKey: ["signature-placement-preview", documentId],
    queryFn: () => documentsAPI.previewUrl(documentId).then((r) => r.data),
  });

  const { data: savedSignature } = useQuery<any>({
    queryKey: ["profile-signature"],
    queryFn: () => profileAPI.getSignature().then((r) => r.data.signature ?? null),
  });

  useEffect(() => {
    let cancelled = false;
    let loadingTask: { promise: Promise<PDFDocumentProxy>; destroy?: () => void } | null = null;
    setPdfDoc(null);
    setTotalPages(0);
    setPageSize({ width: 0, height: 0 });
    const previewUrl = preview?.url;
    if (!previewUrl || preview.viewer !== "pdfjs") return;

    pdfjsImportPromise
      .then((pdfjsLib) => {
        if (cancelled) return Promise.reject(new Error("cancelled"));
        pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerPath;
        loadingTask = pdfjsLib.getDocument({
          url: previewUrl,
          withCredentials: true,
          httpHeaders: token ? { Authorization: `Bearer ${token}` } : {},
        });
        return loadingTask.promise;
      })
      .then((loaded) => {
        if (cancelled) return;
        setPdfDoc(loaded);
        setTotalPages(loaded.numPages);
        setCurrentPage(1);
      })
      .catch((err) => {
        if (!cancelled && err?.message !== "cancelled") setError("Failed to load PDF for signing.");
      });

    return () => {
      cancelled = true;
      loadingTask?.destroy?.();
    };
  }, [preview?.url, preview?.viewer, token]);

  useEffect(() => {
    if (!pdfDoc || !hostEl) return;
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | null = null;
    hostEl.innerHTML = "";
    setPageSize({ width: 0, height: 0 });

    pdfDoc.getPage(currentPage).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      canvas.className = "block shadow-sm bg-white";
      hostEl.innerHTML = "";
      hostEl.appendChild(canvas);
      setPageSize({ width: viewport.width, height: viewport.height });
      renderTask = page.render({ canvasContext: canvas.getContext("2d")!, viewport });
      renderTask.promise.catch((err) => {
        if (!cancelled && err?.name !== "RenderingCancelledException") setError("Failed to render PDF page.");
      });
    });

    return () => {
      cancelled = true;
      renderTask?.cancel?.();
    };
  }, [pdfDoc, hostEl, currentPage, scale]);

  const clampPosition = (nextX: number, nextY: number) =>
    setPos({ x: Math.max(0, Math.min(76, nextX)), y: Math.max(0, Math.min(90, nextY)) });

  const onDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging || !hostEl || !pageSize.width || !pageSize.height) return;
    const rect = hostEl.getBoundingClientRect();
    const x = ((event.clientX - rect.left) / rect.width) * 100 - 12;
    const y = ((event.clientY - rect.top) / rect.height) * 100 - 4;
    clampPosition(x, y);
  };

  const confirm = () => {
    if (preview?.viewer !== "pdfjs") {
      setError("Only PDF documents can be signed.");
      return;
    }
    onConfirm({
      page_number: currentPage,
      x_percent: Number(pos.x.toFixed(3)),
      y_percent: Number(pos.y.toFixed(3)),
      width_percent: 24,
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/55 p-4">
      <div className="flex max-h-[92vh] w-full max-w-6xl flex-col overflow-hidden rounded-xl bg-background shadow-2xl">
        <div className="flex items-center justify-between gap-4 border-b border-border px-5 py-4">
          <div>
            <h3 className="text-base font-semibold text-foreground">Place signature</h3>
            <p className="text-xs text-muted-foreground">Drag your signature to the signing line, then confirm.</p>
          </div>
          <button onClick={onCancel} className="btn-secondary text-sm">Cancel</button>
        </div>

        <div className="grid min-h-0 flex-1 grid-cols-1 lg:grid-cols-[1fr_320px]">
          <div className="min-h-0 overflow-auto bg-[#EDEDED] p-4">
            <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-background px-3 py-2">
              <div className="flex items-center gap-2">
                <button onClick={() => setCurrentPage((p) => Math.max(1, p - 1))} disabled={currentPage <= 1} className="btn-secondary px-2 py-1">‹</button>
                <span className="text-sm text-foreground">Page {currentPage} of {totalPages || "..."}</span>
                <button onClick={() => setCurrentPage((p) => Math.min(totalPages, p + 1))} disabled={!totalPages || currentPage >= totalPages} className="btn-secondary px-2 py-1">›</button>
              </div>
              <div className="flex items-center gap-2">
                <button onClick={() => setScale((s) => Math.max(0.7, s - 0.1))} className="btn-secondary px-2 py-1">-</button>
                <span className="w-12 text-center text-xs text-muted-foreground">{Math.round(scale * 100)}%</span>
                <button onClick={() => setScale((s) => Math.min(2, s + 0.1))} className="btn-secondary px-2 py-1">+</button>
              </div>
            </div>

            <div className="relative mx-auto w-fit">
              <div ref={setHostEl} className="relative" />
              {pageSize.width > 0 && (
                <div
                  role="button"
                  tabIndex={0}
                  onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDragging(true); }}
                  onPointerMove={onDrag}
                  onPointerUp={() => setDragging(false)}
                  onPointerCancel={() => setDragging(false)}
                  className={clsx(
                    "absolute z-10 flex cursor-grab items-center justify-center rounded border-2 border-primary bg-primary/10 shadow-sm backdrop-blur-sm",
                    dragging && "cursor-grabbing ring-4 ring-primary/20"
                  )}
                  style={{ left: `${pos.x}%`, top: `${pos.y}%`, width: "24%", height: "8%" }}
                >
                  {savedSignature?.image_data ? (
                    <img src={savedSignature.image_data} alt="" className="max-h-full max-w-full object-contain" />
                  ) : (
                    <span className="text-xs font-semibold text-primary">Signature</span>
                  )}
                </div>
              )}
            </div>
          </div>

          <div className="space-y-4 border-t border-border p-5 lg:border-l lg:border-t-0">
            <div className="rounded-lg border border-border bg-muted/20 p-4">
              <p className="text-sm font-semibold text-foreground">Confirmation</p>
              <p className="mt-2 text-sm text-muted-foreground">
                You are signing <span className="font-medium text-foreground">{documentTitle || "this document"}</span>{" "}
                {documentRef && <span className="font-medium text-foreground">{documentRef}</span>}.
              </p>
              <p className="mt-2 text-sm text-muted-foreground">
                Your signature will be embedded on page {currentPage}. This action is recorded and cannot be undone.
              </p>
              {note && <p className="mt-2 text-xs text-muted-foreground">{note}</p>}
            </div>
            {!savedSignature?.image_data && (
              <p className="text-xs text-amber-600">
                You don't have a saved e-signature yet. Add one in Profile → E-Signature first.
              </p>
            )}
            {error && <p className="text-sm text-destructive">{error}</p>}
            <button onClick={confirm} disabled={isSubmitting || !pageSize.width} className="w-full btn-primary justify-center">
              {isSubmitting && <Loader2 className="h-4 w-4 animate-spin" />}
              {confirmLabel}
            </button>
            <button onClick={onCancel} className="w-full btn-secondary justify-center">Back</button>
          </div>
        </div>
      </div>
    </div>
  );
}
