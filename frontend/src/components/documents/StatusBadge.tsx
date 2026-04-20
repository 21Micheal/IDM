import clsx from "clsx";

/**
 * Indigo Vault — semantic status pill.
 * Uses HSL design tokens (teal, accent, destructive, muted, secondary, primary).
 * No raw Tailwind palette colors.
 */

type Tone =
  | "neutral"   // draft / void
  | "info"      // archived / informational
  | "warning"   // pending review / pending approval / in workflow
  | "success"   // approved
  | "danger"    // rejected
  | "primary";  // generic emphasis

const TONE: Record<Tone, string> = {
  neutral: "bg-muted text-muted-foreground border border-border",
  info:    "bg-secondary text-secondary-foreground border border-border",
  warning: "bg-accent/15 text-accent-foreground border border-accent/30",
  success: "bg-teal/15 text-teal border border-teal/30",
  danger:  "bg-destructive/10 text-destructive border border-destructive/30",
  primary: "bg-primary/10 text-primary border border-primary/20",
};

const KNOWN: Record<string, { label: string; tone: Tone }> = {
  draft:            { label: "Draft",            tone: "neutral" },
  pending_review:   { label: "Pending Review",   tone: "warning" },
  pending_approval: { label: "Pending Approval", tone: "warning" },
  on_hold:          { label: "On Hold",          tone: "warning" },
  returned:         { label: "Returned for Review", tone: "warning" },
  approved:         { label: "Approved",         tone: "success" },
  active:           { label: "Active",           tone: "success" },
  enabled:          { label: "Enabled",          tone: "success" },
  completed:        { label: "Completed",        tone: "success" },
  rejected:         { label: "Rejected",         tone: "danger" },
  inactive:         { label: "Inactive",         tone: "neutral" },
  disabled:         { label: "Disabled",         tone: "neutral" },
  archived:         { label: "Archived",         tone: "info" },
  void:             { label: "Void",             tone: "neutral" },
};

export default function StatusBadge({ status }: { status: string }) {
  const key = status?.toLowerCase?.().replace(/\s+/g, "_") ?? "";

  if (key in KNOWN) {
    const { label, tone } = KNOWN[key];
    return (
      <span className={clsx("badge", TONE[tone])}>
        <span
          className={clsx(
            "mr-1.5 h-1.5 w-1.5 rounded-full",
            tone === "success"  && "bg-teal",
            tone === "warning"  && "bg-accent",
            tone === "danger"   && "bg-destructive",
            tone === "neutral"  && "bg-muted-foreground/60",
            tone === "info"     && "bg-secondary-foreground/60",
            tone === "primary"  && "bg-primary",
          )}
        />
        {label}
      </span>
    );
  }

  // Free-form workflow step label (e.g. "Pending Finance Review") → warning tone
  return (
    <span className={clsx("badge", TONE.warning)}>
      <span className="mr-1.5 h-1.5 w-1.5 rounded-full bg-accent" />
      {status}
    </span>
  );
}
