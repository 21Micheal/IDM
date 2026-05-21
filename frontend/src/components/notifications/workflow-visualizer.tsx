import { AlertCircle, Check, Clock, Loader2, User } from "lucide-react";
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

function stepIcon(status: WorkflowStep["status"], isActive: boolean) {
  if (status === "completed") return <Check className="h-5 w-5" />;
  if (status === "rejected") return <AlertCircle className="h-5 w-5" />;
  if (status === "in-progress" || isActive) return <Loader2 className="h-5 w-5 animate-spin" />;
  return <Clock className="h-5 w-5" />;
}

function stepClasses(status: WorkflowStep["status"], isActive: boolean) {
  if (status === "completed") {
    return {
      icon: "border-teal/40 bg-teal/10 text-teal",
      card: "border-teal/25 bg-teal/5",
      line: "bg-teal/40",
      badge: "bg-teal/10 text-teal border-teal/25",
    };
  }
  if (status === "rejected") {
    return {
      icon: "border-destructive/40 bg-destructive/10 text-destructive",
      card: "border-destructive/30 bg-destructive/5",
      line: "bg-border",
      badge: "bg-destructive/10 text-destructive border-destructive/25",
    };
  }
  if (status === "in-progress" || isActive) {
    return {
      icon: "border-primary/40 bg-primary/10 text-primary",
      card: "border-primary/30 bg-primary/5",
      line: "bg-border",
      badge: "bg-primary/10 text-primary border-primary/25",
    };
  }
  return {
    icon: "border-border bg-muted text-muted-foreground",
    card: "border-border bg-card",
    line: "bg-border",
    badge: "bg-muted text-muted-foreground border-border",
  };
}

function statusLabel(status: WorkflowStep["status"]) {
  switch (status) {
    case "completed":
      return "Approved";
    case "rejected":
      return "Rejected";
    case "in-progress":
      return "In progress";
    default:
      return "Pending";
  }
}

export function WorkflowVisualizer({
  steps,
  currentStep,
  documentTitle,
  submittedBy,
  submittedDate,
  isLoading = false,
}: WorkflowVisualizerProps) {
  const approved = steps.filter((step) => step.status === "completed").length;
  const active = steps.filter((step, index) => step.status === "in-progress" || index === currentStep).length;
  const rejected = steps.filter((step) => step.status === "rejected").length;

  if (isLoading) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 text-center">
        <Loader2 className="mx-auto h-6 w-6 animate-spin text-primary" />
        <p className="mt-2 text-sm text-muted-foreground">Loading workflow…</p>
      </div>
    );
  }

  if (steps.length === 0) {
    return (
      <div className="rounded-lg border border-border bg-card p-5 text-sm text-muted-foreground">
        Workflow details are not available for this notification.
      </div>
    );
  }

  return (
    <div className="space-y-5">
      {(documentTitle || submittedBy || submittedDate) && (
        <div className="rounded-lg border border-border bg-card p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Document</p>
          {documentTitle && <p className="mt-1 font-medium text-foreground">{documentTitle}</p>}
          <div className="mt-3 grid grid-cols-1 gap-3 text-sm sm:grid-cols-2">
            {submittedBy && (
              <div>
                <p className="text-xs text-muted-foreground">Submitted by</p>
                <p className="mt-0.5 text-foreground">{submittedBy}</p>
              </div>
            )}
            {submittedDate && (
              <div>
                <p className="text-xs text-muted-foreground">Submitted on</p>
                <p className="mt-0.5 text-foreground">{submittedDate}</p>
              </div>
            )}
          </div>
        </div>
      )}

      <div>
        <h3 className="mb-4 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          Approval workflow
        </h3>
        <div className="space-y-3">
          {steps.map((step, index) => {
            const isActive = index === currentStep;
            const styles = stepClasses(step.status, isActive);

            return (
              <div key={step.id} className="relative">
                {index < steps.length - 1 && (
                  <div className={clsx("absolute left-5 top-12 h-[calc(100%+0.75rem)] w-0.5", styles.line)} />
                )}

                <div className={clsx("relative rounded-lg border p-4 transition-colors", styles.card)}>
                  <div className="flex items-start gap-3">
                    <div className={clsx("z-10 flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full border-2", styles.icon)}>
                      {stepIcon(step.status, isActive)}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div>
                          <h4 className="font-medium text-foreground">{step.name}</h4>
                          <p className="mt-1 flex items-center gap-1.5 text-sm text-muted-foreground">
                            <User className="h-3.5 w-3.5" />
                            {step.approver || "Unassigned"}
                          </p>
                        </div>
                        <span className={clsx("rounded-full border px-2 py-1 text-xs font-semibold", styles.badge)}>
                          {statusLabel(step.status)}
                        </span>
                      </div>

                      {step.completedAt && (
                        <p className="mt-2 text-xs text-muted-foreground">
                          {step.status === "rejected" ? "Rejected" : "Approved"} on {step.completedAt}
                        </p>
                      )}

                      {step.comment && (
                        <div
                          className={clsx(
                            "mt-3 rounded-md border px-3 py-2 text-xs",
                            step.status === "rejected"
                              ? "border-destructive/20 bg-destructive/5 text-destructive"
                              : "border-border bg-background text-muted-foreground",
                          )}
                        >
                          <span className="font-semibold">
                            {step.status === "rejected" ? "Rejection comment: " : "Comment: "}
                          </span>
                          {step.comment}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className="rounded-lg border border-border bg-card p-4">
        <h4 className="mb-3 text-sm font-semibold text-foreground">Status summary</h4>
        <div className="grid grid-cols-3 gap-3 text-center">
          <div>
            <p className="text-2xl font-semibold text-teal">{approved}</p>
            <p className="mt-1 text-xs text-muted-foreground">Approved</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-primary">{active}</p>
            <p className="mt-1 text-xs text-muted-foreground">In progress</p>
          </div>
          <div>
            <p className="text-2xl font-semibold text-destructive">{rejected}</p>
            <p className="mt-1 text-xs text-muted-foreground">Rejected</p>
          </div>
        </div>
      </div>
    </div>
  );
}
