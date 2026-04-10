import clsx from "clsx";
import type { DocumentStatus } from "@/types";

const config: Record<DocumentStatus, { label: string; cls: string }> = {
  draft:            { label: "Draft",            cls: "bg-gray-100 text-gray-700" },
  pending_review:   { label: "Pending Review",   cls: "bg-yellow-100 text-yellow-700" },
  pending_approval: { label: "Pending Approval", cls: "bg-amber-100 text-amber-700" },
  approved:         { label: "Approved",         cls: "bg-green-100 text-green-700" },
  rejected:         { label: "Rejected",         cls: "bg-red-100 text-red-700" },
  archived:         { label: "Archived",         cls: "bg-blue-100 text-blue-700" },
  void:             { label: "Void",             cls: "bg-gray-100 text-gray-500" },
};

export default function StatusBadge({ status }: { status: DocumentStatus }) {
  const { label, cls } = config[status] ?? { label: status, cls: "bg-gray-100 text-gray-600" };
  return <span className={clsx("badge", cls)}>{label}</span>;
}
