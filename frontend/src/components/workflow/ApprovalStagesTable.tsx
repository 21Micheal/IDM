import { Check, Clock, Loader2, XCircle, Minus } from "lucide-react";
import type { WorkflowStep, WorkflowStatus } from "../notifications/workflow-visualizer";

const STATUS_TONE: Record<WorkflowStatus, {
  bg: string;
  text: string;
  border: string;
  icon: React.ReactNode;
}> = {
  completed: {
    bg: "#edf3f0",
    text: "#38564a",
    border: "#bdcec7",
    icon: <Check className="h-3.5 w-3.5" />,
  },
  "in-progress": {
    bg: "#f1f3f8",
    text: "#475569",
    border: "#d1d8e3",
    icon: <Loader2 className="h-3.5 w-3.5 animate-spin" />,
  },
  "on-hold": {
    bg: "#f4f0e4",
    text: "#62583d",
    border: "#d8cfb7",
    icon: <Clock className="h-3.5 w-3.5" />,
  },
  rejected: {
    bg: "#f4eeee",
    text: "#664242",
    border: "#d4bbbb",
    icon: <XCircle className="h-3.5 w-3.5" />,
  },
  skipped: {
    bg: "#f1f5f9",
    text: "#56616d",
    border: "#d2d7dd",
    icon: <Minus className="h-3.5 w-3.5" />,
  },
  returned: {
    bg: "#f4eee8",
    text: "#644d38",
    border: "#d7c5b4",
    icon: <XCircle className="h-3.5 w-3.5" />,
  },
  pending: {
    bg: "#f1f5f9",
    text: "#56616d",
    border: "#d2d7dd",
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
    return (
      <div className="flex items-center justify-center border border-dashed border-[#C8CDD2] bg-[#F5F7F8] p-6 text-sm text-[#5E6870]">
        No approval stages to display.
      </div>
    );
  }

  // Filter out structural nodes (start, end, gateway) - only show task nodes
  const taskSteps = steps.filter((s) => !s.kind || s.kind === "task");

  return (
    <div className="border border-[#C8CDD2] bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2.5">
        <div className="flex items-center gap-2">
          <p className="text-sm font-bold text-[#1F2933]">
            {phase === "retirement" ? "Retirement Approval Stages" : "Request Approval Stages"}
          </p>
          <span className="text-xs text-[#5E6870]">
            {taskSteps.length} stage{taskSteps.length !== 1 ? "s" : ""}
          </span>
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-[#C8CDD2] bg-[#F5F7F8]">
              <th className="px-4 py-2 text-left font-semibold text-[#1F2933]">Stage</th>
              <th className="px-4 py-2 text-left font-semibold text-[#1F2933]">Approver</th>
              <th className="px-4 py-2 text-left font-semibold text-[#1F2933]">Status</th>
              <th className="px-4 py-2 text-left font-semibold text-[#1F2933]">Completed</th>
              <th className="px-4 py-2 text-left font-semibold text-[#1F2933]">Comment</th>
            </tr>
          </thead>
          <tbody>
            {taskSteps.map((step, index) => {
              const tone = STATUS_TONE[step.status];
              return (
                <tr key={step.id} className="border-b border-[#C8CDD2] hover:bg-[#F5F7F8]">
                  <td className="px-4 py-3 text-[#1F2933]">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{step.name}</span>
                      <span className="text-xs text-[#5E6870]">#{index + 1}</span>
                    </div>
                  </td>
                  <td className="px-4 py-3 text-[#5E6870]">
                    {step.approver || "Unassigned"}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className="inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold"
                      style={{
                        backgroundColor: tone.bg,
                        color: tone.text,
                        border: `1px solid ${tone.border}`,
                      }}
                    >
                      {tone.icon}
                      {step.statusDisplay || step.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-[#5E6870]">
                    {step.completedAt ? formatTime(step.completedAt) : "-"}
                  </td>
                  <td className="px-4 py-3 text-[#5E6870] max-w-xs truncate" title={step.comment}>
                    {step.comment || "-"}
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
