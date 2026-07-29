import { useEffect, useState, type ReactNode } from "react";
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
 * App-native custom toast system.
 *
 *  - Compact enterprise notification cards
 *  - Tone-coded left rail and icon treatment
 *  - Quiet bottom progress line for auto-close timing
 *  - Optional action button styled like the DMS command surfaces
 */

type Tone = "success" | "error" | "warning" | "info" | "default";

const TONE_CONFIG: Record<
  Tone,
  {
    progress: string;
    iconBg: string;
    iconColor: string;
    border: string;
    header: string;
    label: string;
    Icon: typeof CheckCircle2;
  }
> = {
  success: {
    progress: "bg-[#16836B]",
    iconBg: "bg-[#E8F5F1]",
    iconColor: "text-[#16836B]",
    border: "border-[#D4EAE7]",
    header: "text-[#16836B]",
    label: "Success",
    Icon: CheckCircle2,
  },
  error: {
    progress: "bg-[#B42318]",
    iconBg: "bg-[#FCEEEE]",
    iconColor: "text-[#B42318]",
    border: "border-[#F0D5D1]",
    header: "text-[#B42318]",
    label: "Action failed",
    Icon: XCircle,
  },
  warning: {
    progress: "bg-[#A15C00]",
    iconBg: "bg-[#FFF3DA]",
    iconColor: "text-[#A15C00]",
    border: "border-[#FDE8C4]",
    header: "text-[#A15C00]",
    label: "Attention",
    Icon: AlertTriangle,
  },
  info: {
    progress: "bg-[#287EAD]",
    iconBg: "bg-[#EEF6FB]",
    iconColor: "text-[#287EAD]",
    border: "border-[#D4E9F4]",
    header: "text-[#287EAD]",
    label: "Notice",
    Icon: Info,
  },
  default: {
    progress: "bg-[#5E6870]",
    iconBg: "bg-[#F1F3F4]",
    iconColor: "text-[#3F474F]",
    border: "border-[#E1E5E8]",
    header: "text-[#3F474F]",
    label: "Notification",
    Icon: ShieldCheck,
  },
};

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

function ToastProgress({
  duration,
  loading,
  progressClass,
}: {
  duration: number;
  loading?: boolean;
  progressClass: string;
}) {
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (loading || !Number.isFinite(duration) || duration <= 0) return;
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const elapsed = now - start;
      const pct = Math.min(elapsed / duration, 1);
      setProgress(pct);
      if (pct < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [duration, loading]);

  return (
    <div className="absolute inset-x-0 bottom-0 h-0.5 bg-[#E1E5E8]">
      <div
        className={cn("h-full transition-[width] duration-75 ease-linear", progressClass)}
        style={{ width: loading ? "100%" : `${Math.max(0, 100 - progress * 100)}%` }}
      />
    </div>
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
        "group pointer-events-auto relative flex w-[390px] max-w-[92vw] overflow-hidden",
        "border bg-white text-[#1F2933]",
        cfg.border,
        "shadow-[0_18px_42px_-24px_rgba(31,41,51,0.55)]",
        "animate-in slide-in-from-right-4 fade-in-0 duration-300",
      )}
    >
      <div className="relative flex flex-1 flex-col">
        {/* Body */}
        <div className="flex items-start gap-3 px-4 py-3 pb-3">
          <div
            className={cn(
              "flex h-9 w-9 shrink-0 items-center justify-center",
              cfg.iconBg,
            )}
          >
            {loading ? (
              <Loader2 className={cn("h-4 w-4 animate-spin", cfg.iconColor)} />
            ) : (
              <Icon className={cn("h-4 w-4", cfg.iconColor)} />
            )}
          </div>

          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold leading-snug text-[#1F2933]">
              {title}
            </p>
            {description && (
              <p className="mt-1 text-xs leading-snug text-[#5E6870]">
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
                className="mt-2 inline-flex items-center border border-[#287EAD] bg-white px-2.5 py-1 text-xs font-semibold text-[#287EAD] transition-colors hover:bg-[#EEF6FB]"
              >
                {action.label}
              </button>
            )}
          </div>

          <button
            type="button"
            onClick={onDismiss}
            aria-label="Dismiss notification"
            className="flex h-6 w-6 shrink-0 items-center justify-center text-[#94A3B8] opacity-70 transition-all hover:opacity-100 hover:text-[#1F2933]"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="absolute inset-x-0 bottom-0 h-0.5">
          <ToastProgress duration={duration} loading={loading} progressClass={cfg.progress} />
          {loading && (
            <div
              className={cn(
                "h-full w-1/2 animate-pulse",
                cfg.progress,
              )}
            />
          )}
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
