/**
 * components/documents/OcrStatusBadge.tsx
 *
 * Displays the current OCR pipeline state as a small inline badge.
 * Used in DocumentListPage rows, DocumentDetailPage sidebar, and
 * anywhere else the document's ocr_status needs surfacing.
 *
 * Props
 * ─────
 * status   — "pending" | "processing" | "done" | "failed" | null | undefined
 * showDone — when false (default) the "done" state renders nothing;
 *            the absence of a badge means OCR is complete and transparent.
 *            Set showDone=true on the detail page where explicit confirmation helps.
 * className — optional extra classes
 */

import { Clock, Loader2, ScanLine, AlertCircle } from "lucide-react";

type OcrStatus = "pending" | "processing" | "done" | "failed" | null | undefined;

interface Props {
  status: OcrStatus;
  showDone?: boolean;
  className?: string;
}

const CONFIG: Record<
  "pending" | "processing" | "done" | "failed",
  {
    label: string;
    containerClass: string;
    iconClass: string;
    Icon: React.ElementType;
    spin?: boolean;
  }
> = {
  pending: {
    label: "OCR pending",
    containerClass: "bg-gray-100 text-gray-600 border-gray-200",
    iconClass: "text-gray-400",
    Icon: Clock,
  },
  processing: {
    label: "Extracting text…",
    containerClass: "bg-blue-50 text-blue-700 border-blue-200",
    iconClass: "text-blue-500",
    Icon: Loader2,
    spin: true,
  },
  done: {
    label: "Text extracted",
    containerClass: "bg-green-50 text-green-700 border-green-200",
    iconClass: "text-green-500",
    Icon: ScanLine,
  },
  failed: {
    label: "OCR failed",
    containerClass: "bg-red-50 text-red-600 border-red-200",
    iconClass: "text-red-400",
    Icon: AlertCircle,
  },
};

export default function OcrStatusBadge({
  status,
  showDone = false,
  className = "",
}: Props) {
  if (!status) return null;
  if (status === "done" && !showDone) return null;

  const cfg = CONFIG[status];
  if (!cfg) return null;

  const { label, containerClass, iconClass, Icon, spin } = cfg;

  return (
    <span
      title={label}
      className={`inline-flex items-center gap-1.5 text-xs font-medium px-2 py-0.5 rounded-full border ${containerClass} ${className}`}
    >
      <Icon className={`w-3 h-3 flex-shrink-0 ${iconClass} ${spin ? "animate-spin" : ""}`} />
      {label}
    </span>
  );
}
