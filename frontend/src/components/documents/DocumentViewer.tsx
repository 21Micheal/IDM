/**
 * DocumentViewer.tsx
 *
 * Handles document preview with proper authentication support.
 * - PDF: Uses PDF.js with JWT token in headers
 * - Office files: Google Docs Viewer
 * - Others: Download prompt
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { documentsAPI } from "../../services/api";
import { useAuthStore } from "@/store/authStore";
import {
  Download, Loader2, ExternalLink, ChevronLeft,
  ChevronRight, ZoomIn, ZoomOut, RotateCw,
} from "lucide-react";

// ── PDF.js setup ──────────────────────────────────────────────────────────────
import * as pdfjsLib from "pdfjs-dist";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  "pdfjs-dist/build/pdf.worker.min.mjs",
  import.meta.url
).toString();

// ── Types ─────────────────────────────────────────────────────────────────────
interface PreviewData {
  viewer: "pdfjs" | "google_docs" | "download";
  url: string;
  mime?: string;
}

// ── PDF Renderer Component ────────────────────────────────────────────────────
function PdfViewer({ url }: { url: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [scale, setScale] = useState(1.3);
  const [rotation, setRotation] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const renderTaskRef = useRef<any>(null);

  const accessToken = useAuthStore((state) => state.accessToken);

  // Load PDF with authentication
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");

    const loadingTask = pdfjsLib.getDocument({
      url,
      withCredentials: true,
      httpHeaders: {
        Authorization: `Bearer ${accessToken || ""}`,
      },
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
        setError(
          err?.status === 403
            ? "You do not have permission to view this document."
            : "Failed to load PDF. The file may be corrupted or inaccessible."
        );
        setLoading(false);
      });

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        renderTaskRef.current.cancel();
      }
      loadingTask.destroy();
    };
  }, [url, accessToken]);

  // Render current page
  useEffect(() => {
    if (!pdfDoc || !containerRef.current) return;

    const container = containerRef.current;
    let cancelled = false;

    if (renderTaskRef.current) {
      renderTaskRef.current.cancel();
    }

    pdfDoc.getPage(currentPage).then((page) => {
      if (cancelled) return;

      const viewport = page.getViewport({ scale, rotation });

      let canvas = container.querySelector("canvas") as HTMLCanvasElement;
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
        if (err?.name !== "RenderingCancelledException") {
          console.error("Render error:", err);
        }
      });
    });

    return () => {
      cancelled = true;
    };
  }, [pdfDoc, currentPage, scale, rotation]);

  const zoomIn = () => setScale((s) => Math.min(3, parseFloat((s + 0.2).toFixed(1))));
  const zoomOut = () => setScale((s) => Math.max(0.5, parseFloat((s - 0.2).toFixed(1))));
  const rotate = () => setRotation((r) => (r + 90) % 360);

  const goTo = useCallback(
    (page: number) => setCurrentPage(Math.max(1, Math.min(totalPages, page))),
    [totalPages]
  );

  if (loading) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-3">
        <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
        <p className="text-sm text-gray-500">Loading PDF...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-4 text-center px-4">
        <p className="text-red-500 text-sm font-medium">{error}</p>
        <a
          href={url}
          download
          className="btn-secondary inline-flex items-center gap-2"
        >
          <Download className="w-4 h-4" /> Download File Instead
        </a>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 bg-gray-100 border border-gray-200 rounded-t-lg px-3 py-2">
        <div className="flex items-center gap-1">
          <button
            onClick={() => goTo(currentPage - 1)}
            disabled={currentPage <= 1}
            className="btn-secondary px-2 py-1 disabled:opacity-40"
            title="Previous page"
          >
            <ChevronLeft className="w-4 h-4" />
          </button>
          <div className="flex items-center gap-1.5 px-2 text-sm">
            <input
              type="number"
              value={currentPage}
              min={1}
              max={totalPages}
              onChange={(e) => goTo(Number(e.target.value))}
              className="w-12 text-center border border-gray-300 rounded px-1 py-0.5"
            />
            <span className="text-gray-500">/ {totalPages}</span>
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

        <a href={url} download className="btn-secondary text-xs px-3 py-1">
          <Download className="w-3.5 h-3.5" /> Download
        </a>
      </div>

      {/* Canvas Container */}
      <div
        className="overflow-auto bg-gray-200 border border-t-0 border-gray-200 rounded-b-lg p-4"
        style={{ maxHeight: "75vh" }}
      >
        <div ref={containerRef} className="mx-auto" />
      </div>
    </div>
  );
}

// ── Main DocumentViewer Component ─────────────────────────────────────────────
interface Props {
  documentId: string;
}

export default function DocumentViewer({ documentId }: Props) {
  const { data: preview, isLoading, isError } = useQuery<PreviewData>({
    queryKey: ["document-preview", documentId],
    queryFn: () => documentsAPI.previewUrl(documentId).then((r) => r.data),
    staleTime: 1000 * 60 * 10, // 10 minutes
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
      </div>
    );
  }

  if (isError || !preview) {
    return (
      <div className="flex items-center justify-center h-64 text-red-500">
        Could not load document preview.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-gray-900">Document Preview</h3>
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          className="btn-secondary text-xs px-3 py-1.5 flex items-center gap-1.5"
        >
          <ExternalLink className="w-3.5 h-3.5" /> Open in New Tab
        </a>
      </div>

      {/* PDF Viewer */}
      {preview.viewer === "pdfjs" && <PdfViewer url={preview.url} />}

      {/* Google Docs Viewer for Office files */}
      {preview.viewer === "google_docs" && (
        <div className="rounded-lg overflow-hidden border border-gray-200" style={{ height: "75vh" }}>
          <iframe
            src={preview.url}
            className="w-full h-full border-0"
            title="Document viewer"
            sandbox="allow-scripts allow-same-origin allow-popups"
          />
        </div>
      )}

      {/* Fallback for unsupported formats */}
      {preview.viewer === "download" && (
        <div className="rounded-lg border-2 border-dashed border-gray-200 p-12 text-center">
          <Download className="w-12 h-12 text-gray-300 mx-auto mb-4" />
          <p className="text-gray-600 mb-2">Preview not available for this file type.</p>
          <a
            href={preview.url}
            download
            className="btn-primary inline-flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Download File
          </a>
        </div>
      )}
    </div>
  );
}