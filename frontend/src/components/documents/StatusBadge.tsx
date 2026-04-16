import clsx from "clsx";

// Known fixed statuses
const KNOWN: Record<string, { label: string; cls: string }> = {
  draft:            { label: "Draft",            cls: "bg-gray-100 text-gray-700" },
  pending_review:   { label: "Pending Review",   cls: "bg-yellow-100 text-yellow-700" },
  pending_approval: { label: "Pending Approval", cls: "bg-amber-100 text-amber-700" },
  approved:         { label: "Approved",         cls: "bg-green-100 text-green-700" },
  rejected:         { label: "Rejected",         cls: "bg-red-100 text-red-700" },
  archived:         { label: "Archived",         cls: "bg-blue-100 text-blue-700" },
  void:             { label: "Void",             cls: "bg-gray-100 text-gray-400" },
};

export default function StatusBadge({ status }: { status: string }) {
  // Known status — use predefined colours
  if (status in KNOWN) {
    const { label, cls } = KNOWN[status];
    return <span className={clsx("badge", cls)}>{label}</span>;
  }

  // Free-form workflow step label (e.g. "Pending Finance Review")
  // Show in amber to indicate "in workflow"
  return (
    <span className="badge bg-amber-50 text-amber-700 border border-amber-200">
      {status}
    </span>
  );
}
