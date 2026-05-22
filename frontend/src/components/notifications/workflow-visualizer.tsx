// workflow-visualizer.tsx
// Comprehensive workflow visualizer: horizontal flow chart on desktop,
// vertical timeline on mobile. Includes status summary, connecting lines,
// color-coded steps, approver info, timestamps and comments.
import {
  AlertCircle,
  Check,
  CheckCircle2,
  Clock,
  Hourglass,
  Loader2,
  MessageSquare,
  User,
  XCircle,
} from "lucide-react";
import clsx from "clsx";

export interface WorkflowStep {
  id: string;
  name: string;
  approver: string;
  status: "completed" | "pending" | "in-progress" | "rejected";
  completedAt?: string;
  comment?: string;
  order: number;
}

interface WorkflowVisualizerProps {
  steps: WorkflowStep[];
  currentStep: number;
  documentTitle?: string;
  submittedBy?: string;
  submittedDate?: string;
  isLoading?: boolean;
}

type StatusTone = {
  ring: string;
  bg: string;
  fg: string;
  badge: string;
  line: string;
  dot: string;
  label: string;
};

const STATUS_TONES: Record<WorkflowStep["status"], StatusTone> = {
  completed: {
    ring: "ring-emerald-500/40 border-emerald-500",
    bg: "bg-emerald-500 text-white",
    fg: "text-emerald-700 dark:text-emerald-300",
    badge:
      "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-300 dark:border-emerald-900/50",
    line: "bg-emerald-500",
    dot: "bg-emerald-500",
    label: "Approved",
  },
  "in-progress": {
    ring: "ring-blue-500/40 border-blue-500",
    bg: "bg-blue-500 text-white",
    fg: "text-blue-700 dark:text-blue-300",
    badge:
      "bg-blue-50 text-blue-700 border-blue-200 dark:bg-blue-950/40 dark:text-blue-300 dark:border-blue-900/50",
    line: "bg-blue-500",
    dot: "bg-blue-500",
    label: "In Progress",
  },
  rejected: {
    ring: "ring-red-500/40 border-red-500",
    bg: "bg-red-500 text-white",
    fg: "text-red-700 dark:text-red-300",
    badge:
      "bg-red-50 text-red-700 border-red-200 dark:bg-red-950/40 dark:text-red-300 dark:border-red-900/50",
    line: "bg-red-500",
    dot: "bg-red-500",
    label: "Rejected",
  },
  pending: {
    ring: "ring-transparent border-border",
    bg: "bg-muted text-muted-foreground",
    fg: "text-muted-foreground",
    badge: "bg-muted text-muted-foreground border-border",
    line: "bg-border",
    dot: "bg-muted-foreground/40",
    label: "Pending",
  },
};

function StatusIcon({ status, className }: { status: WorkflowStep["status"]; className?: string }) {
  if (status === "completed") return <Check className={clsx("h-5 w-5", className)} />;
  if (status === "rejected") return <XCircle className={clsx("h-5 w-5", className)} />;
  if (status === "in-progress") return <Loader2 className={clsx("h-5 w-5 animate-spin", className)} />;
  return <Clock className={clsx("h-5 w-5", className)} />;
}

function formatDate(dateString?: string) {
  if (!dateString) return null;
  return new Date(dateString).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function WorkflowVisualizer({
  steps,
  currentStep,
  documentTitle,
  submittedBy,
  submittedDate,
  isLoading = false,
}: WorkflowVisualizerProps) {
  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-10">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (steps.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-muted/30 p-6 text-center text-sm text-muted-foreground">
        <AlertCircle className="mx-auto mb-2 h-5 w-5" />
        Workflow details not available
      </div>
    );
  }

  const counts = {
    completed: steps.filter((s) => s.status === "completed").length,
    inProgress: steps.filter((s) => s.status === "in-progress").length,
    rejected: steps.filter((s) => s.status === "rejected").length,
    pending: steps.filter((s) => s.status === "pending").length,
  };
  const progressPercent = Math.round((counts.completed / steps.length) * 100);

  return (
    <div className="space-y-5">
      {/* Document Header */}
      {(documentTitle || submittedBy || submittedDate) && (
        <div className="space-y-2 rounded-lg border border-border bg-card p-4">
          {documentTitle && (
            <p className="text-sm font-semibold text-foreground">{documentTitle}</p>
          )}
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
            {submittedBy && (
              <div className="flex items-center gap-1.5">
                <User className="h-3.5 w-3.5" />
                <span>Submitted by {submittedBy}</span>
              </div>
            )}
            {submittedDate && (
              <div className="flex items-center gap-1.5">
                <Clock className="h-3.5 w-3.5" />
                <span>{submittedDate}</span>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Status Summary Cards */}
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <SummaryCard
          label="Approved"
          count={counts.completed}
          icon={CheckCircle2}
          tone="text-emerald-600 dark:text-emerald-400"
          bg="bg-emerald-50 dark:bg-emerald-950/30 border-emerald-100 dark:border-emerald-900/40"
        />
        <SummaryCard
          label="In Progress"
          count={counts.inProgress}
          icon={Loader2}
          spin
          tone="text-blue-600 dark:text-blue-400"
          bg="bg-blue-50 dark:bg-blue-950/30 border-blue-100 dark:border-blue-900/40"
        />
        <SummaryCard
          label="Pending"
          count={counts.pending}
          icon={Hourglass}
          tone="text-muted-foreground"
          bg="bg-muted/40 border-border"
        />
        <SummaryCard
          label="Rejected"
          count={counts.rejected}
          icon={XCircle}
          tone="text-red-600 dark:text-red-400"
          bg="bg-red-50 dark:bg-red-950/30 border-red-100 dark:border-red-900/40"
        />
      </div>

      {/* Progress Bar */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium text-foreground">Overall Progress</span>
          <span className="text-muted-foreground">
            {counts.completed} of {steps.length} steps complete · {progressPercent}%
          </span>
        </div>
        <div className="h-2 overflow-hidden rounded-full bg-muted">
          <div
            className={clsx(
              "h-full rounded-full transition-all duration-500",
              counts.rejected > 0
                ? "bg-gradient-to-r from-emerald-500 via-blue-500 to-red-500"
                : "bg-gradient-to-r from-emerald-500 to-blue-500",
            )}
            style={{ width: `${Math.max(progressPercent, counts.inProgress > 0 ? 5 : 0)}%` }}
          />
        </div>
      </div>

      {/* Horizontal Flow Chart (desktop) */}
      <div className="hidden md:block">
        <div className="rounded-xl border border-border bg-card p-5">
          <div className="mb-4 flex items-center justify-between">
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Approval Flow
            </h4>
            <span className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {steps.length} {steps.length === 1 ? "stage" : "stages"}
            </span>
          </div>

          <div className="overflow-x-auto pb-2">
            <div
              className="grid items-start gap-0"
              style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(160px, 1fr))` }}
            >
              {steps.map((step, index) => {
                const tone = STATUS_TONES[step.status];
                const isCurrent = index === currentStep;
                const nextTone = index < steps.length - 1 ? STATUS_TONES[steps[index + 1].status] : null;
                const connectorActive =
                  step.status === "completed" && nextTone && steps[index + 1].status !== "pending";
                return (
                  <div key={step.id} className="relative flex flex-col items-center">
                    {/* Connector to next node */}
                    {index < steps.length - 1 && (
                      <div className="absolute left-1/2 top-6 h-0.5 w-full">
                        <div
                          className={clsx(
                            "h-full w-full transition-colors",
                            connectorActive ? tone.line : "bg-border",
                          )}
                        />
                      </div>
                    )}

                    {/* Node */}
                    <div
                      className={clsx(
                        "relative z-10 flex h-12 w-12 items-center justify-center rounded-full border-2 ring-4 transition-all",
                        tone.ring,
                        tone.bg,
                        isCurrent && "shadow-lg shadow-blue-500/20",
                      )}
                    >
                      <StatusIcon status={step.status} />
                    </div>

                    {/* Step order */}
                    <span className="mt-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                      Step {step.order || index + 1}
                    </span>

                    {/* Card */}
                    <div className="mt-2 w-full px-2">
                      <div
                        className={clsx(
                          "rounded-lg border bg-background p-3 text-center transition-colors",
                          isCurrent && "border-blue-300 bg-blue-50 dark:border-blue-800 dark:bg-blue-950/20",
                          !isCurrent && step.status === "in-progress" && "border-blue-300 dark:border-blue-800",
                          step.status === "rejected" && "border-red-300 dark:border-red-800",
                          step.status === "completed" && "border-emerald-200 dark:border-emerald-900/60",
                          !isCurrent && step.status === "pending" && "border-border",
                        )}
                      >
                        <p className="truncate text-sm font-semibold text-foreground" title={step.name}>
                          {step.name}
                        </p>
                        <span
                          className={clsx(
                            "mt-1.5 inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                            tone.badge,
                          )}
                        >
                          {tone.label}
                        </span>
                        <div className="mt-2 flex items-center justify-center gap-1 text-xs text-muted-foreground">
                          <User className="h-3 w-3" />
                          <span className="truncate" title={step.approver}>{step.approver}</span>
                        </div>
                        {step.completedAt && (
                          <p className="mt-1 text-[10px] text-muted-foreground">
                            {formatDate(step.completedAt)}
                          </p>
                        )}
                        {step.comment && (
                          <div
                            className={clsx(
                              "mt-2 flex items-start gap-1.5 rounded-md border p-2 text-left text-[11px] leading-relaxed",
                              step.status === "rejected"
                                ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300"
                                : "border-border bg-muted/40 text-muted-foreground",
                            )}
                          >
                            <MessageSquare className="mt-0.5 h-3 w-3 flex-shrink-0" />
                            <span className="line-clamp-3">{step.comment}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Vertical Timeline (mobile) */}
      <div className="md:hidden">
        <div className="rounded-xl border border-border bg-card p-4">
          <h4 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Approval Flow
          </h4>
          <ol className="space-y-1">
            {steps.map((step, index) => {
              const tone = STATUS_TONES[step.status];
              const isCurrent = index === currentStep;
              const isLast = index === steps.length - 1;
              const connectorActive = step.status === "completed";
              return (
                <li key={step.id} className="relative flex gap-3">
                  {/* Vertical connector */}
                  {!isLast && (
                    <span
                      className={clsx(
                        "absolute left-[19px] top-10 h-[calc(100%-1rem)] w-0.5",
                        connectorActive ? tone.line : "bg-border",
                      )}
                    />
                  )}
                  <div
                    className={clsx(
                      "relative z-10 mt-0.5 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border-2 ring-4",
                      tone.ring,
                      tone.bg,
                      isCurrent && "shadow-lg shadow-blue-500/20",
                    )}
                  >
                    <StatusIcon status={step.status} className="h-4 w-4" />
                  </div>
                  <div className="flex-1 pb-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="text-sm font-semibold text-foreground">{step.name}</p>
                      <span
                        className={clsx(
                          "rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide",
                          tone.badge,
                        )}
                      >
                        {tone.label}
                      </span>
                    </div>
                    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
                      <User className="h-3 w-3" />
                      <span>{step.approver}</span>
                    </div>
                    {step.completedAt && (
                      <p className="mt-1 text-xs text-muted-foreground">{formatDate(step.completedAt)}</p>
                    )}
                    {step.comment && (
                      <div
                        className={clsx(
                          "mt-2 flex items-start gap-1.5 rounded-md border p-2 text-xs leading-relaxed",
                          step.status === "rejected"
                            ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/40 dark:bg-red-950/30 dark:text-red-300"
                            : "border-border bg-muted/40 text-muted-foreground",
                        )}
                      >
                        <MessageSquare className="mt-0.5 h-3 w-3 flex-shrink-0" />
                        <div>
                          <p className="font-semibold">
                            {step.status === "rejected" ? "Rejection reason" : "Comment"}
                          </p>
                          <p className="mt-0.5">{step.comment}</p>
                        </div>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
          </ol>
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
        <LegendDot className="bg-emerald-500" label="Approved" />
        <LegendDot className="bg-blue-500" label="In Progress" />
        <LegendDot className="bg-muted-foreground/40" label="Pending" />
        <LegendDot className="bg-red-500" label="Rejected" />
        {currentStep >= 0 && currentStep < steps.length && (
          <span className="ml-auto text-xs text-foreground">
            Awaiting: <span className="font-semibold">{steps[currentStep].approver}</span>
          </span>
        )}
      </div>
    </div>
  );
}

function SummaryCard({
  label,
  count,
  icon: Icon,
  tone,
  bg,
  spin = false,
}: {
  label: string;
  count: number;
  icon: React.ComponentType<{ className?: string }>;
  tone: string;
  bg: string;
  spin?: boolean;
}) {
  return (
    <div className={clsx("flex items-center gap-3 rounded-lg border px-3 py-2.5", bg)}>
      <div className={clsx("flex h-8 w-8 items-center justify-center rounded-md bg-background/60", tone)}>
        <Icon className={clsx("h-4 w-4", spin && count > 0 && "animate-spin")} />
      </div>
      <div className="min-w-0">
        <p className={clsx("text-lg font-semibold leading-none", tone)}>{count}</p>
        <p className="mt-0.5 text-[11px] font-medium text-muted-foreground">{label}</p>
      </div>
    </div>
  );
}

function LegendDot({ className, label }: { className: string; label: string }) {
  return (
    <div className="flex items-center gap-1.5">
      <span className={clsx("h-2 w-2 rounded-full", className)} />
      <span>{label}</span>
    </div>
  );
}