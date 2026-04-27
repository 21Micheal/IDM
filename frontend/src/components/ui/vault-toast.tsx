import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  CheckCircle2,
  AlertTriangle,
  Info,
  XCircle,
  ShieldCheck,
  Loader2,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Indigo Vault — app-native custom toast system.
 *
 *  - Dark "vault header" strip with the app's sidebar gradient
 *  - Tone-coded left rail (success / error / warning / info / default)
 *  - Animated SVG progress ring around the icon (acts as auto-close timer)
 *  - Monospace "vault stamp" timestamp
 *  - Optional action button styled like the app's primary button
 */

type Tone = "success" | "error" | "warning" | "info" | "default";

const TONE_CONFIG: Record<
  Tone,
  {
    rail: string; // background of the left rail
    ring: string; // stroke color for the progress ring (raw hsl ref)
    iconBg: string;
    iconColor: string;
    label: string;
    Icon: typeof CheckCircle2;
  }
> = {
  success: {
    rail: "bg-teal",
    ring: "hsl(var(--teal))",
    iconBg: "bg-teal/15",
    iconColor: "text-teal",
    label: "Confirmed",
    Icon: CheckCircle2,
  },
  error: {
    rail: "bg-destructive",
    ring: "hsl(var(--destructive))",
    iconBg: "bg-destructive/15",
    iconColor: "text-destructive",
    label: "Action failed",
    Icon: XCircle,
  },
  warning: {
    rail: "bg-accent",
    ring: "hsl(var(--accent))",
    iconBg: "bg-accent/20",
    iconColor: "text-accent",
    label: "Heads up",
    Icon: AlertTriangle,
  },
  info: {
    rail: "bg-primary",
    ring: "hsl(var(--primary))",
    iconBg: "bg-primary/10",
    iconColor: "text-primary",
    label: "Notice",
    Icon: Info,
  },
  default: {
    rail: "bg-muted-foreground",
    ring: "hsl(var(--muted-foreground))",
    iconBg: "bg-muted",
    iconColor: "text-foreground",
    label: "Vault",
    Icon: ShieldCheck,
  },
};

function formatStamp(d: Date) {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${hh}:${mm}:${ss}`;
}

interface VaultToastCardProps {
  id: string | number;
  tone: Tone;
  title: ReactNode;
  description?: ReactNode;
  duration: number;
  loading?: boolean;
  onDismiss: () => void;
  action?: { label: string; onClick: () => void };
}

function ProgressRing({
  duration,
  color,
  loading,
}: {
  duration: number;
  color: string;
  loading?: boolean;
}) {
  const RADIUS = 18;
  const CIRC = 2 * Math.PI * RADIUS;
  const [offset, setOffset] = useState(0);

  useEffect(() => {
    if (loading) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = now - start;
      const pct = Math.min(elapsed / duration, 1);
      setOffset(CIRC * pct);
      if (pct < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duration, loading, CIRC]);

  return (
    <svg
      className="absolute inset-0 -rotate-90"
      viewBox="0 0 44 44"
      width={44}
      height={44}
    >
      <circle
        cx={22}
        cy={22}
        r={RADIUS}
        fill="none"
        stroke="hsl(var(--border))"
        strokeWidth={2}
      />
      {!loading && (
        <circle
          cx={22}
          cy={22}
          r={RADIUS}
          fill="none"
          stroke={color}
          strokeWidth={2}
          strokeLinecap="round"
          strokeDasharray={CIRC}
          strokeDashoffset={offset}
          style={{ transition: "stroke-dashoffset 80ms linear" }}
        />
      )}
    </svg>
  );
}

function VaultToastCard({
  id,
  tone,
  title,
  description,
  duration,
  loading,
  onDismiss,
  action,
}: VaultToastCardProps) {
  const cfg = TONE_CONFIG[tone];
  const Icon = cfg.Icon;
  const stampRef = useRef(formatStamp(new Date()));

  useEffect(() => {
    if (loading || !Number.isFinite(duration) || duration <= 0) return;
    const timeoutId = window.setTimeout(() => {
      dismissToast(id);
    }, duration);
    return () => window.clearTimeout(timeoutId);
  }, [duration, id, loading]);

  return (
    <div
      role="status"
      className={cn(
        "group pointer-events-auto relative flex w-[380px] max-w-[92vw] overflow-hidden",
        "rounded-xl border border-border bg-card text-card-foreground",
        "shadow-[0_10px_40px_-12px_hsl(222_47%_13%/0.35)]",
        "animate-in slide-in-from-right-4 fade-in-0 duration-300",
      )}
    >
      {/* Tone rail */}
      <div className={cn("w-1 shrink-0", cfg.rail)} />

      <div className="flex flex-1 flex-col">
        {/* Vault header strip */}
        <div
          className="flex items-center justify-between px-3 py-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground"
          style={{ background: "var(--gradient-sidebar)" }}
        >
          <span className="flex items-center gap-1.5">
            <span
              className={cn("h-1.5 w-1.5 rounded-full", cfg.rail)}
              aria-hidden
            />
            {cfg.label}
          </span>
          <span className="font-mono text-[10px] tracking-wider text-sidebar-foreground/70">
            VLT · {stampRef.current}
          </span>
        </div>

        {/* Body */}
        <div className="flex items-start gap-3 px-3 py-3">
          {/* Icon with progress ring */}
          <div className="relative h-11 w-11 shrink-0">
            <ProgressRing
              duration={duration}
              color={cfg.ring}
              loading={loading}
            />
            <div
              className={cn(
                "absolute inset-[5px] flex items-center justify-center rounded-full",
                cfg.iconBg,
              )}
            >
              {loading ? (
                <Loader2
                  className={cn("h-4 w-4 animate-spin", cfg.iconColor)}
                />
              ) : (
                <Icon className={cn("h-4 w-4", cfg.iconColor)} />
              )}
            </div>
          </div>

          {/* Text */}
          <div className="min-w-0 flex-1 pt-0.5">
            <p className="text-sm font-semibold leading-snug text-foreground">
              {title}
            </p>
            {description && (
              <p className="mt-0.5 text-[13px] leading-snug text-muted-foreground">
                {description}
              </p>
            )}
            {action && (
              <button
                type="button"
                onClick={() => {
                  action.onClick();
                  onDismiss();
                }}
                className="mt-2 inline-flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90"
              >
                {action.label}
              </button>
            )}
          </div>

          {/* Close */}
          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss notification"
            className="-mr-1 -mt-1 flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-all hover:bg-muted hover:text-foreground group-hover:opacity-100"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    </div>
  );
}

/* ----------------------------- Public toaster ----------------------------- */

type ToastId = string | number;

interface VaultToastRecord extends VaultToastOptions {
  id: ToastId;
  tone: Tone;
  title: ReactNode;
  duration: number;
  loading?: boolean;
}

const DEFAULT_DURATION = 4500;
let nextToastId = 1;
let toastStore: VaultToastRecord[] = [];
const toastListeners = new Set<(toasts: VaultToastRecord[]) => void>();

function emitToastStore() {
  const snapshot = [...toastStore];
  toastListeners.forEach((listener) => listener(snapshot));
}

function subscribeToToastStore(listener: (toasts: VaultToastRecord[]) => void) {
  toastListeners.add(listener);
  listener([...toastStore]);
  return () => {
    toastListeners.delete(listener);
  };
}

function upsertToast(record: VaultToastRecord) {
  const existingIndex = toastStore.findIndex((toast) => toast.id === record.id);
  if (existingIndex >= 0) {
    toastStore = toastStore.map((toast, index) => (index === existingIndex ? record : toast));
  } else {
    toastStore = [record, ...toastStore];
  }
  emitToastStore();
  return record.id;
}

function dismissToast(id?: ToastId) {
  toastStore = id === undefined
    ? []
    : toastStore.filter((toast) => toast.id !== id);
  emitToastStore();
}

export function VaultToaster() {
  const [toasts, setToasts] = useState<VaultToastRecord[]>(toastStore);

  useEffect(() => subscribeToToastStore(setToasts), []);

  return (
    <div className="pointer-events-none fixed inset-x-0 top-0 z-[120] flex justify-end p-4 sm:p-5">
      <div className="flex w-full max-w-[420px] flex-col gap-2">
        {toasts.slice(0, 4).map((toast) => (
          <VaultToastCard
            key={toast.id}
            id={toast.id}
            tone={toast.tone}
            title={toast.title}
            description={toast.description}
            duration={toast.duration}
            loading={toast.loading}
            action={toast.action}
            onDismiss={() => dismissToast(toast.id)}
          />
        ))}
      </div>
    </div>
  );
}

/* --------------------------------- API ----------------------------------- */

interface VaultToastOptions {
  description?: ReactNode;
  duration?: number;
  action?: { label: string; onClick: () => void };
  id?: ToastId;
}

function show(tone: Tone, title: ReactNode, opts: VaultToastOptions = {}) {
  const duration = opts.duration ?? DEFAULT_DURATION;
  const id = opts.id ?? nextToastId++;
  return upsertToast({
    id,
    tone,
    title,
    description: opts.description,
    duration,
    action: opts.action,
  });
}

function loading(title: ReactNode, opts: VaultToastOptions = {}) {
  const id = opts.id ?? nextToastId++;
  return upsertToast({
    id,
    tone: "info",
    title,
    description: opts.description,
    duration: Infinity,
    loading: true,
    action: opts.action,
  });
}

interface PromiseMessages<T> {
  loading: ReactNode;
  success: ReactNode | ((data: T) => ReactNode);
  error: ReactNode | ((err: unknown) => ReactNode);
}

function promise<T>(p: Promise<T>, msgs: PromiseMessages<T>) {
  const id = loading(msgs.loading);
  p.then(
    (data) => {
      vaultToast.success(
        typeof msgs.success === "function"
          ? (msgs.success as (d: T) => ReactNode)(data)
          : msgs.success,
        { id },
      );
    },
    (err) => {
      vaultToast.error(
        typeof msgs.error === "function"
          ? (msgs.error as (e: unknown) => ReactNode)(err)
          : msgs.error,
        { id },
      );
    },
  );
  return p;
}

export const vaultToast = {
  success: (title: ReactNode, opts?: VaultToastOptions) =>
    show("success", title, opts),
  error: (title: ReactNode, opts?: VaultToastOptions) =>
    show("error", title, opts),
  warning: (title: ReactNode, opts?: VaultToastOptions) =>
    show("warning", title, opts),
  info: (title: ReactNode, opts?: VaultToastOptions) =>
    show("info", title, opts),
  message: (title: ReactNode, opts?: VaultToastOptions) =>
    show("default", title, opts),
  loading,
  promise,
  dismiss: dismissToast,
};

export const toast = {
  success: vaultToast.success,
  error: vaultToast.error,
  warning: vaultToast.warning,
  warn: vaultToast.warning,
  info: vaultToast.info,
  message: vaultToast.message,
  loading: vaultToast.loading,
  promise: vaultToast.promise,
  dismiss: vaultToast.dismiss,
};

export type { VaultToastOptions };
