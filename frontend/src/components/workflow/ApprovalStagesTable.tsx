import { Fragment, useEffect, useMemo, useState } from "react";
import { Check, Clock, ChevronDown, ChevronRight, XCircle, Minus, Loader2 } from "lucide-react";
import type { WorkflowStep, WorkflowStatus } from "../notifications/workflow-visualizer";
import { PHASE_LABELS, PROCUREMENT_PHASE_ORDER } from "../notifications/workflow-data";

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
  phase?: "request" | "retirement" | "requisition" | "rfq" | "lpo" | "payment_run" | string | null;
}

export function ApprovalStagesTable({ steps = [], isLoading, phase }: ApprovalStagesTableProps) {
  const [shownEarlierPhases, setShownEarlierPhases] = useState<Set<string>>(new Set());

  // Always start collapsed when the document moves to a new phase.
  useEffect(() => {
    setShownEarlierPhases(new Set());
  }, [phase]);

  const taskSteps = useMemo(
    () => steps.filter((step) => !step.kind || step.kind === "task"),
    [steps],
  );

  const phaseRank = (value?: string) => {
    if (!value) return -1;
    const index = PROCUREMENT_PHASE_ORDER.indexOf(value as (typeof PROCUREMENT_PHASE_ORDER)[number]);
    return index;
  };

  const currentPhase =
    phase && phaseRank(phase) >= 0 ? (phase as string) : null;
  const phased = Boolean(currentPhase && taskSteps.some((step) => step.phase));

  const phaseCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const step of taskSteps) {
      if (step.phase) counts.set(step.phase, (counts.get(step.phase) ?? 0) + 1);
    }
    return counts;
  }, [taskSteps]);

  // Earlier procurement phases available behind a toggle (requisition before
  // rfq, requisition + rfq before lpo).  Later phases are never shown here.
  const earlierPhases = phased
    ? PROCUREMENT_PHASE_ORDER.filter(
        (name) =>
          name !== currentPhase
          && (phaseCounts.get(name) ?? 0) > 0
          && phaseRank(name) < phaseRank(currentPhase ?? undefined),
      )
    : [];

  const visibleSteps = useMemo(() => {
    if (!phased) return [...taskSteps].sort((a, b) => a.order - b.order);
    const currentRank = phaseRank(currentPhase ?? undefined);
    return taskSteps
      .filter((step) => {
        const rank = phaseRank(step.phase);
        if (rank < 0 || rank > currentRank) return false;
        return step.phase === currentPhase || shownEarlierPhases.has(step.phase ?? "");
      })
      .sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase) || a.order - b.order);
  }, [taskSteps, phased, currentPhase, shownEarlierPhases]);

  const rows = useMemo(() => {
    const counters: Record<string, number> = {};
    let previousPhase: string | undefined;
    return visibleSteps.map((step) => {
      const key = step.phase ?? "_";
      counters[key] = (counters[key] ?? 0) + 1;
      const startGroup = phased && shownEarlierPhases.size > 0 && step.phase !== previousPhase;
      previousPhase = step.phase;
      return { step, number: counters[key], startGroup };
    });
  }, [visibleSteps, phased, shownEarlierPhases]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 border border-dashed border-[#C8CDD2] bg-[#F5F7F8] p-6 text-sm text-[#5E6870]">
        <Loader2 className="h-4 w-4 animate-spin text-[#287EAD]" />
        Loading approval stages…
      </div>
    );
  }

  if (!taskSteps.length) {
    return null;
  }

  const toggleEarlier = (name: string) => {
    setShownEarlierPhases((previous) => {
      const next = new Set(previous);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  return (
    <div className="border border-[#C8CDD2] bg-[#FAFAFA] shadow-sm">
      {/* Title bar — clean, light */}
      <div className="flex items-center justify-between gap-2 border-b border-[#C8CDD2] bg-white px-3 py-2">
        <div className="flex items-center gap-2 min-w-0">
          <p className="text-xs font-bold text-[#1F2933] uppercase tracking-wide truncate">
            {(() => {
              switch (phase) {
                case "requisition": return "Requisition Approval Stages";
                case "rfq":         return "RFQ Approval Stages";
                case "lpo":         return "LPO Approval Stages";
                case "retirement":  return "Retirement Approval Stages";
                case "payment_run": return "Payment Run Approval Stages";
                default:            return "Approval Stages";
              }
            })()}
          </p>
          <span className="rounded-full bg-[#F1F5F9] px-2 py-0.5 text-[10px] font-semibold text-[#475569] shrink-0">
            {visibleSteps.length} stage{visibleSteps.length !== 1 ? "s" : ""}
          </span>
        </div>

        {earlierPhases.length > 0 && (
          <div className="flex items-center gap-1.5 flex-wrap justify-end">
            {earlierPhases.map((name) => {
              const open = shownEarlierPhases.has(name);
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggleEarlier(name)}
                  className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold transition-colors ${
                    open
                      ? "border-[#287EAD] bg-[#EAF4FA] text-[#1E6F99]"
                      : "border-[#C8CDD2] bg-white text-[#5E6870] hover:bg-[#F5F7F8]"
                  }`}
                  title={open ? `Hide ${PHASE_LABELS[name] ?? name} stages` : `Show ${PHASE_LABELS[name] ?? name} stages`}
                >
                  {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
                  {open ? "Hide" : "Show"} {PHASE_LABELS[name] ?? name}
                  <span className="text-[#94A3B8]">({phaseCounts.get(name) ?? 0})</span>
                </button>
              );
            })}
          </div>
        )}
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
            {rows.length === 0 && (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-center text-xs text-[#5E6870]">
                  No stages for this phase.
                </td>
              </tr>
            )}
            {rows.map(({ step, number, startGroup }) => {
              const tone = STATUS_TONE[step.status];
              return (
                <Fragment key={step.id}>
                  {startGroup && (
                    <tr className="bg-[#EEF2F6]">
                      <td colSpan={5} className="px-3 py-1.5 text-[10px] font-bold uppercase tracking-wider text-[#475569]">
                        {PHASE_LABELS[step.phase ?? ""] ?? step.phase} stage
                      </td>
                    </tr>
                  )}
                  <tr className="border-b border-[#E5E7EB] last:border-b-0 bg-white hover:bg-[#F9FAFB] transition-colors">
                    <td className="px-3 py-2.5 text-[#111827]">
                      <div className="flex items-center gap-1.5">
                        <span className="font-medium">{step.name}</span>
                        <span className="text-xs text-[#6B7280]">#{number}</span>
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
                </Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
