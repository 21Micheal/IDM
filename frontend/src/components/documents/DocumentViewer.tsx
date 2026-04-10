import { useState, useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { documentsAPI } from "@/services/api";
import { Download, Loader2, ExternalLink } from "lucide-react";

interface Props {
  documentId: string;
}

export default function DocumentViewer({ documentId }: Props) {
  const iframeRef = useRef<HTMLIFrameElement>(null);

  const { data: preview, isLoading } = useQuery({
    queryKey: ["document-preview", documentId],
    queryFn: () => documentsAPI.previewUrl(documentId).then((r) => r.data),
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <Loader2 className="w-8 h-8 text-brand-500 animate-spin" />
      </div>
    );
  }

  if (!preview) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="font-medium text-gray-900 text-sm">Document preview</h3>
        <a
          href={preview.url}
          target="_blank"
          rel="noopener noreferrer"
          download={preview.viewer === "download"}
          className="btn-secondary text-xs px-3 py-1.5"
        >
          {preview.viewer === "download" ? (
            <><Download className="w-3.5 h-3.5" />Download</>
          ) : (
            <><ExternalLink className="w-3.5 h-3.5" />Open in new tab</>
          )}
        </a>
      </div>

      {preview.viewer === "pdfjs" && (
        <div className="rounded-lg overflow-hidden border border-gray-200 bg-gray-100" style={{ height: "700px" }}>
          <iframe
            ref={iframeRef}
            src={`/pdfjs/web/viewer.html?file=${encodeURIComponent(preview.url)}`}
            className="w-full h-full border-0"
            title="PDF Viewer"
          />
        </div>
      )}

      {preview.viewer === "google_docs" && (
        <div className="rounded-lg overflow-hidden border border-gray-200 bg-gray-100" style={{ height: "700px" }}>
          <iframe
            src={preview.url}
            className="w-full h-full border-0"
            title="Document Viewer"
          />
        </div>
      )}

      {preview.viewer === "download" && (
        <div className="rounded-lg border-2 border-dashed border-gray-200 p-10 text-center">
          <Download className="w-10 h-10 text-gray-300 mx-auto mb-3" />
          <p className="text-sm text-gray-500">Preview not available for this file type.</p>
          <a href={preview.url} download className="btn-primary mt-4 inline-flex">
            <Download className="w-4 h-4" /> Download file
          </a>
        </div>
      )}
    </div>
  );
}
