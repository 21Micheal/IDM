/**
 * Comprehensive PDF editor — public surface.
 *
 *   npm i pdf-lib pdfjs-dist clsx lucide-react
 *
 * import PdfEditor from "@/components/pdf-editor";
 */
export { default } from "./PdfEditor";
export { default as PdfEditor } from "./PdfEditor";
export { default as PageOrganizer } from "./components/PageOrganizer";
export { default as AnnotationCanvas } from "./components/AnnotationCanvas";
export { default as SidePanel } from "./components/SidePanel";
export * from "./types";
export {
  assemble, exportDocument, mergeDocuments, splitDocument, imagesToPdf,
  compressLite, loadSource, pagesForSource, parseRanges, downloadBytes,
} from "./pdfEngine";
export { renderPage, rasterizeAll, evictRenderCache } from "./pdfRender";