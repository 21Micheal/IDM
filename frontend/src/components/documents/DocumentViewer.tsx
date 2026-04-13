/**
 * DocumentViewer.tsx
 *
 * Renders documents inline:
 *  - PDF  → PDF.js canvas renderer (page-by-page, no iframe)
 *  - DOCX/XLSX → Google Docs Viewer iframe
 *  - Other     → download prompt
 *
 * PDF.js is loaded from the pdfjs-dist npm package so no separate
 * static file download is needed. The worker is loaded from the same
 * package via a Vite asset URL.
 */
import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { documentsAPI } from "@/services/api";
import {
  Download, Loader2, ExternalLink, ChevronLeft,
  ChevronRight, ZoomIn, ZoomOut, RotateCw,
} from "lucide-react";

// ── PDF.js setup ──────────────────────────────────────────────────────────────
// Import from npm package — Vite handles the worker URL automatically
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

// Point the worker at the same version shipped with pdfjs-dist
// Vite resolves this as a static asset URL at build time
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// ── Types ─────────────────────────────────────────────────────────────────────
interface PreviewData {
  viewer: "pdfjs" | "google_docs" | "download";
  url: string;
}

// ── PDF renderer ──────────────────────────────────────────────────────────────
function PdfViewer({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.3);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const renderTaskRef = useRef<ReturnType<PDFPageProxy["render"]> | null>(null);

  // Load document once URL is available
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    const loadingTask = pdfjsLib.getDocument({
      url,
      // Credentials are needed for cookies/JWT if your media is protected
      withCredentials: true,
    });

    loadingTask.promise
      .then((doc) => {
        if (cancelled) return;
        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setCurrentPage(1);
        setLoading(false);
      })
      .catch((err) => {
        if (cancelled) return;
        console.error("PDF load error:", err);
        setError("Failed to load PDF. The file may be corrupted or inaccessible.");
        setLoading(false);
      });

    return () => {
      cancelled = true;
      loadingTask.destroy();
    };
  }, [url]);

  // Render current page whenever page/scale/rotation changes
  useEffect(() => {
    if (!pdfDoc || !containerRef.current) return;

    const container = containerRef.current;
    let cancelled = false;

    // Cancel any in-progress render
    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
    }

    pdfDoc.getPage(currentPage).then((page) => {
      if (cancelled) return;

      const viewport = page.getViewport({ scale, rotation });

      // Reuse or create canvas
      let canvas = container.querySelector("canvas");
      if (!canvas) {
        canvas = document.createElement("canvas");
        canvas.className = "mx-auto shadow-sm";
        container.innerHTML = "";
        container.appendChild(canvas);
      }

      const ctx = canvas.getContext("2d")!;
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      const renderTask = page.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = renderTask;

      renderTask.promise.catch((err) => {
        // Ignore cancellation errors
        if (err?.name !== "RenderingCancelledException") {
          console.error("Render error:", err);
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, currentPage, scale, rotation]);

  const zoomIn  = () => setScale((s) => Math.min(3, parseFloat((s + 0.2).toFixed(1))));
  const zoomOut = () => setScale((s) => Math.max(0.5, parseFloat((s - 0.2).toFixed(1))));
  const rotate  = () => setRotation((r) => (r + 90) % 360);

  const goTo = useCallback(
    (page: number) => setCurrentPage(Math.max(1, Math.min(totalPages, page))),
    [totalPages]
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
        <p className="text-sm text-gray-500">Loading PDF…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-48 gap-3 text-center px-4">
        <p className="text-red-500 text-sm font-medium">{error}</p>
        <a href={url} download className="btn-secondary text-sm">
          <Download className="w-4 h-4" /> Download instead
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 bg-gray-100 border border-gray-200 rounded-t-lg px-3 py-2">
        {/* Page controls */}
        <div className="flex items-center gap-1">
          <button
            onClick={() => goTo(currentPage - 1)}
            disabled={currentPage <= 1}
            className="btn-secondary px-2 py-1 disabled:opacity-40"
            title="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-1.5 px-2">
            <input
              type="number"
              value={currentPage}
              min={1}
              max={totalPages}
              onChange={(e) => goTo(Number(e.target.value))}
              className="w-12 text-center text-sm border border-gray-300 rounded px-1 py-0.5"
            />
            <span className="text-sm text-gray-500">/ {totalPages}</span>
          </div>
          <button
            onClick={() => goTo(currentPage + 1)}
            disabled={currentPage >= totalPages}
            className="btn-secondary px-2 py-1 disabled:opacity-40"
            title="Next page"
          >
            <ChevronRight className="w-4 h-4" />
          </button>
        </div>

        {/* Zoom + rotate */}
        <div className="flex items-center gap-1">
          <button onClick={zoomOut} className="btn-secondary px-2 py-1" title="Zoom out">
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-xs text-gray-600 w-12 text-center">
            {Math.round(scale * 100)}%
          </span>
          <button onClick={zoomIn} className="btn-secondary px-2 py-1" title="Zoom in">
            <ZoomIn className="w-4 h-4" />
          </button>
          <button onClick={rotate} className="btn-secondary px-2 py-1 ml-1" title="Rotate">
            <RotateCw className="w-4 h-4" />
          </button>
        </div>

        {/* Download */}
        <a href={url} download className="btn-secondary text-xs px-2 py-1">
          <Download className="w-3.5 h-3.5" /> Download
        </a>
      </div>

      {/* Canvas container */}
      <div
        className="overflow-auto bg-gray-200 border border-t-0 border-gray-200 rounded-b-lg"
        style={{ maxHeight: "75vh" }}
      >
        <div className="p-4" ref={containerRef} />
      </div>
    </div>
  );
}

// ── Main DocumentViewer ───────────────────────────────────────────────────────
interface Props {
  documentId: string;
}

export default function DocumentViewer({ documentId }: Props) {
  const { data: preview, isLoading, isError } = useQuery<PreviewData>({
    queryKey: ["document-preview", documentId],
    queryFn: () => documentsAPI.previewUrl(documentId).then((r) => r.data),
    staleTime: 1000 * 60 * 10, // 10 min — URL won't change often
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-48">
        <Loader2 className="w-7 h-7 text-brand-500 animate-spin" />
      </div>
    );
  }

  if (isError || !preview) {
    return (
      <div className="flex items-center justify-center h-48">
        <p className="text-sm text-red-500">Could not load document preview.</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-gray-900 text-sm">Document preview</h3>
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary text-xs px-3 py-1.5"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Open in new tab
        </a>
      </div>

      {/* PDF */}
      {preview.viewer === "pdfjs" && <PdfViewer url={preview.url} />}

      {/* Office documents via Google Docs Viewer */}
      {preview.viewer === "google_docs" && (
        <div
          className="rounded-lg overflow-hidden border border-gray-200"
          style={{ height: "75vh" }}
        >
          <iframe
            src={preview.url}
            className="w-full h-full border-0"
            title="Document viewer"
            sandbox="allow-scripts allow-same-origin allow-popups"
          />
        </div>
      )}

      {/* Unsupported type — download only */}
      {preview.viewer === "download" && (
        <div className="rounded-lg border-2 border-dashed border-gray-200 p-10 text-center">
          <Download className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500 mb-4">
            Preview not available for this file type.
          </p>
          <a href={preview.url} download className="btn-primary inline-flex">
            <Download className="w-4 h-4" /> Download file
          </a>
        </div>
      )}
    </div>
  );
}
