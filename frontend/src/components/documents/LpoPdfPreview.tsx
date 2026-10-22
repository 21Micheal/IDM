import { useEffect, useRef, useState } from "react";
import type { PDFDocumentProxy } from "pdfjs-dist";
import { ChevronLeft, ChevronRight, Loader2, Printer, ZoomIn, ZoomOut } from "lucide-react";
import { useAuthStore } from "@/store/authStore";

const pdfWorkerPath = new URL("pdfjs-dist/build/pdf.worker.min.mjs", import.meta.url).toString();
const pdfjsImportPromise = import("pdfjs-dist");

async function printPdf(pdf: PDFDocumentProxy, title: string) {
  const pages: string[] = [];
  for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
    const page = await pdf.getPage(pageNumber);
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    await page.render({ canvasContext: canvas.getContext("2d")!, viewport }).promise;
    pages.push(canvas.toDataURL("image/png"));
  }

  const frame = document.createElement("iframe");
  frame.title = `Print ${title}`;
  frame.style.position = "fixed";
  frame.style.left = "-10000px";
  frame.style.width = "100vw";
  frame.style.height = "100vh";
  frame.style.border = "0";
  document.body.appendChild(frame);
  const printDocument = frame.contentDocument;
  if (!printDocument) {
    frame.remove();
    throw new Error("Could not prepare the print view.");
  }

  printDocument.open();
  printDocument.write(`<!doctype html><html><head><title></title><style>
    @page { size: auto; margin: 12mm; }
    html, body { margin: 0; padding: 0; }
    img { display: block; width: 100%; height: auto; page-break-after: always; }
    img:last-child { page-break-after: auto; }
  </style></head><body>${pages.map((src) => `<img src="${src}">`).join("")}</body></html>`);
  printDocument.title = title;
  printDocument.close();

  await Promise.all(Array.from(printDocument.images).map((image) =>
    image.complete ? Promise.resolve() : new Promise<void>((resolve) => {
      image.onload = () => resolve();
      image.onerror = () => resolve();
    }),
  ));
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  window.setTimeout(() => frame.remove(), 60_000);
}

export default function LpoPdfPreview({
  url,
  title,
  canPrint,
  onPrint,
}: {
  url: string;
  title: string;
  canPrint: boolean;
  onPrint: () => Promise<void>;
}) {
  const token = useAuthStore((state) => state.accessToken);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [printing, setPrinting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    let loadingTask: { promise: Promise<PDFDocumentProxy>; destroy?: () => void } | null = null;
    setLoading(true);
    setError("");
    setPdf(null);

    pdfjsImportPromise
      .then((pdfjs) => {
        if (cancelled) throw new Error("cancelled");
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerPath;
        loadingTask = pdfjs.getDocument({
          url,
          withCredentials: true,
          httpHeaders: token ? { Authorization: `Bearer ${token}` } : {},
        });
        return loadingTask.promise;
      })
      .then((loaded) => {
        if (cancelled) return;
        setPdf(loaded);
        setPageNumber(1);
        setLoading(false);
      })
      .catch((loadError) => {
        if (!cancelled && loadError?.message !== "cancelled") {
          setError("Could not load the LPO preview.");
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
      loadingTask?.destroy?.();
    };
  }, [url, token]);

  useEffect(() => {
    if (!pdf || !canvasRef.current) return;
    let cancelled = false;
    const canvas = canvasRef.current;
    let renderTask: { promise: Promise<void>; cancel?: () => void } | null = null;
    pdf.getPage(pageNumber).then((page) => {
      if (cancelled) return;
      const viewport = page.getViewport({ scale });
      canvas.width = viewport.width;
      canvas.height = viewport.height;
      renderTask = page.render({ canvasContext: canvas.getContext("2d")!, viewport });
      return renderTask.promise;
    }).catch((renderError) => {
      if (!cancelled && renderError?.name !== "RenderingCancelledException") {
        setError("Could not render the LPO page.");
      }
    });
    return () => {
      cancelled = true;
      renderTask?.cancel?.();
    };
  }, [pdf, pageNumber, scale]);

  const handlePrint = async () => {
    if (!pdf || !canPrint || printing) return;
    setPrinting(true);
    try {
      await onPrint();
      await printPdf(pdf, title);
    } catch {
      setError("Could not prepare the LPO for printing.");
    } finally {
      setPrinting(false);
    }
  };

  if (loading) return <div className="flex h-[60vh] items-center justify-center"><Loader2 className="h-7 w-7 animate-spin text-[#287EAD]" /></div>;
  if (error && !pdf) return <div className="flex h-[60vh] items-center justify-center px-6 text-center text-sm text-rose-700">{error}</div>;

  return (
    <div className="flex h-full min-h-[50vh] flex-col">
      <div className="flex items-center justify-between gap-2 border-b border-[#C8CDD2] bg-[#50545A] px-3 py-2 text-white">
        <div className="flex items-center gap-2">
          <button type="button" aria-label="Previous page" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => Math.max(1, page - 1))} className="border border-white/20 bg-white/10 p-1.5 disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
          <span className="min-w-16 text-center text-xs">{pageNumber} / {pdf?.numPages ?? 0}</span>
          <button type="button" aria-label="Next page" disabled={!pdf || pageNumber >= pdf.numPages} onClick={() => setPageNumber((page) => Math.min(pdf?.numPages ?? page, page + 1))} className="border border-white/20 bg-white/10 p-1.5 disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
        </div>
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Zoom out" onClick={() => setScale((value) => Math.max(0.6, +(value - 0.15).toFixed(2)))} className="border border-white/20 bg-white/10 p-1.5"><ZoomOut className="h-4 w-4" /></button>
          <span className="w-12 text-center text-xs">{Math.round(scale * 100)}%</span>
          <button type="button" aria-label="Zoom in" onClick={() => setScale((value) => Math.min(2.2, +(value + 0.15).toFixed(2)))} className="border border-white/20 bg-white/10 p-1.5"><ZoomIn className="h-4 w-4" /></button>
          {canPrint && <button type="button" disabled={!pdf || printing} onClick={() => void handlePrint()} className="ml-2 inline-flex items-center gap-1.5 border border-white/20 bg-white/10 px-2.5 py-1.5 text-xs font-semibold disabled:opacity-50"><Printer className="h-3.5 w-3.5" />{printing ? "Preparing…" : "Print"}</button>}
        </div>
      </div>
      <div className="flex-1 overflow-auto bg-[#E9EEF1] p-4">
        <canvas ref={canvasRef} className="mx-auto h-auto max-w-full bg-white shadow-sm" />
        {error && <p className="py-2 text-center text-xs text-rose-700">{error}</p>}
      </div>
    </div>
  );
}
