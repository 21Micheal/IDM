import { Check, Clock, XCircle, Minus, Loader2 } from "lucide-react";
import type { WorkflowStep, WorkflowStatus } from "../notifications/workflow-visualizer";

const STATUS_TONE: Record<WorkflowStatus, {
  text: string;
  icon: React.ReactNode;
}> = {
  completed: {
    text: "#15803d", // green-700
    icon: <Check className="h-3.5 w-3.5" />,
  },
  "in-progress": {
    text: "#2563eb", // blue-600
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
  },
  "on-hold": {
    text: "#b45309", // amber-700
    icon: <Clock className="h-3.5 w-3.5" />,
  },
  rejected: {
    text: "#b91c1c", // red-700
    icon: <XCircle className="h-3.5 w-3.5" />,
  },
  skipped: {
    text: "#64748b", // slate-500
    icon: <Minus className="h-3.5 w-3.5" />,
  },
  returned: {
    text: "#9a3412", // orange-800
    icon: <XCircle className="h-3.5 w-3.5" />,
  },
  pending: {
    text: "#64748b", // slate-500
    icon: <Clock className="h-3.5 w-3.5" />,
  },
};

function formatTime(iso: string) {
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

interface ApprovalStagesTableProps {
  steps: WorkflowStep[];
  isLoading?: boolean;
  phase?: "request" | "retirement" | string | null;
}

export function ApprovalStagesTable({ steps = [], isLoading, phase }: ApprovalStagesTableProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 border border-dashed border-[#C8CDD2] bg-[#F5F7F8] p-6 text-sm text-[#5E6870]">
        <Loader2 className="h-4 w-4 animate-spin text-[#287EAD]" />
        Loading approval stages…
      </div>
    );
  }

  if (!steps.length) {
    return null;
  }

  // Filter out structural nodes (start, end, gateway) - only show task nodes
  const taskSteps = steps.filter((s) => !s.kind || s.kind === "task");

  return (
    <div className="border border-[#C8CDD2] bg-[#FAFAFA] shadow-sm">
      {/* Title bar — clean, light */}
      <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-white px-3 py-2">
        <div className="flex items-center gap-2">
          <p className="text-xs font-bold text-[#1F2933] uppercase tracking-wide">
            {phase === "retirement" ? "Retirement Approval Stages" : "Request Approval Stages"}
          </p>
          <span className="rounded-full bg-[#F1F5F9] px-2 py-0.5 text-[10px] font-semibold text-[#475569]">
            {taskSteps.length} stage{taskSteps.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          {/* Medium gray header — matching the screenshot's softer tone */}
          <thead>
            <tr className="bg-[#5D6369]">
              <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-white">
                Stage
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-white">
                Approver
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-white">
                Status
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-white">
                Completed
              </th>
              <th className="px-3 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-white">
                Comment
              </th>
            </tr>
          </thead>

          <tbody>
            {taskSteps.map((step, index) => {
              const tone = STATUS_TONE[step.status];
              return (
                <tr
                  key={step.id}
                  className="border-b border-[#E5E7EB] last:border-b-0 bg-white hover:bg-[#F9FAFB] transition-colors"
                >
                  <td className="px-3 py-2.5 text-[#111827]">
                    <div className="flex items-center gap-1.5">
                      <span className="font-medium">{step.name}</span>
                      <span className="text-xs text-[#6B7280]">#{index + 1}</span>
                    </div>
                  </td>
                  <td className="px-3 py-2.5 text-[#374151]">
                    {step.approver || "Unassigned"}
                  </td>
                  <td className="px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
                      <span style={{ color: tone.text }}>{tone.icon}</span>
                      <span style={{ color: tone.text }}>
                        {step.statusDisplay || step.status}
                      </span>
                    </span>
                  </td>
                  <td className="px-3 py-2.5 text-[#6B7280]">
                    {step.completedAt ? formatTime(step.completedAt) : "—"}
                  </td>
                  <td
                    className="max-w-xs truncate px-3 py-2.5 text-[#6B7280]"
                    title={step.comment}
                  >
                    {step.comment || "—"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}