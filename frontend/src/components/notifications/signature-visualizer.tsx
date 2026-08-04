/**
 * SignatureRequestVisualizer
 *
 * Renders the progress of an ad-hoc signature request as a visual step-chain
 * (sequential signing) or a signer grid (any-order signing).
 *
 * Design matches the WorkflowVisualizer enterprise aesthetic:
 *   • Blue header with progress ring
 *   • Collapsible diagram + step-details panels
 *   • Square corners, Squire color tokens
 */

import { useState, useMemo } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  FileSignature,
  Loader2,
  MessageSquare,
  Users,
  XCircle,
} from "lucide-react";
import clsx from "clsx";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export interface SignerRow {
  id: string;
  signer: { full_name: string; email?: string };
  order: number;
  status: "pending" | "signed" | "declined";
  signed_at?: string | null;
  decline_reason?: string;
}

export interface SignatureRequestData {
  id: string;
  document_title?: string;
  requested_by?: { full_name: string; email?: string };
  ordered: boolean;
  message?: string;
  status: "pending" | "completed" | "declined" | "cancelled";
  created_at?: string;
  completed_at?: string | null;
  signers: SignerRow[];
  progress?: { signed: number; total: number };
}

interface SignatureRequestVisualizerProps {
  data: SignatureRequestData;
  fullPage?: boolean;
}

/* ------------------------------------------------------------------ */
/* Design tokens                                                      */
/* ------------------------------------------------------------------ */

type SignerStatus = "pending" | "signed" | "declined";

const STATUS_TONE: Record<
  SignerStatus,
  {
    border: string;
    bg: string;
    text: string;
    badgeBg: string;
    badgeText: string;
    badgeBorder: string;
    iconBg: string;
    label: string;
  }
> = {
  signed: {
    border: "#6f8f80",
    bg: "#f5f8f6",
    text: "#38564a",
    badgeBg: "#edf3f0",
    badgeText: "#38564a",
    badgeBorder: "#bdcec7",
    iconBg: "#6f8f80",
    label: "Signed",
  },
  pending: {
    border: "#8f98a3",
    bg: "#f8f9fa",
    text: "#56616d",
    badgeBg: "#f1f5f9",
    badgeText: "#56616d",
    badgeBorder: "#d2d7dd",
    iconBg: "#8f98a3",
    label: "Pending",
  },
  declined: {
    border: "#9b7474",
    bg: "#faf6f6",
    text: "#664242",
    badgeBg: "#f4eeee",
    badgeText: "#664242",
    badgeBorder: "#d4bbbb",
    iconBg: "#9b7474",
    label: "Declined",
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function formatTime(iso?: string | null) {
  if (!iso) return "";
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

function initials(name: string) {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/* ------------------------------------------------------------------ */
/* Progress ring (reused from WorkflowVisualizer aesthetic)           */
/* ------------------------------------------------------------------ */

function ProgressRing({ pct, size = 48 }: { pct: number; size?: number }) {
  const r = (size - 8) / 2;
  const circ = 2 * Math.PI * r;
  const dash = (pct / 100) * circ;
  return (
    <svg width={size} height={size} className="shrink-0 -rotate-90">
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth={5} />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke="#ffffff"
        strokeWidth={5}
        strokeLinecap="round"
        strokeDasharray={`${dash} ${circ}`}
        style={{ transition: "stroke-dasharray 0.6s ease" }}
      />
      <text
        x={size / 2}
        y={size / 2}
        textAnchor="middle"
        dominantBaseline="central"
        style={{
          fontSize: 11,
          fontWeight: 700,
          fill: "#ffffff",
          transform: "rotate(90deg)",
          transformOrigin: "50% 50%",
          fontFamily: "inherit",
        }}
      >
        {pct}%
      </text>
    </svg>
  );
}

/* ------------------------------------------------------------------ */
/* Status icon                                                        */
/* ------------------------------------------------------------------ */

function StatusIcon({ status, size = 16 }: { status: SignerStatus; size?: number }) {
  const cls = `h-${size === 16 ? 4 : 3} w-${size === 16 ? 4 : 3} text-white shrink-0`;
  switch (status) {
    case "signed":   return <Check className={cls} />;
    case "declined": return <XCircle className={cls} />;
    default:         return <Clock className={cls} />;
  }
}

/* ------------------------------------------------------------------ */
/* Signer Card                                                        */
/* ------------------------------------------------------------------ */

function SignerCard({
  signer,
  index,
  isActive,
  isSelected,
  showOrder,
  onClick,
}: {
  signer: SignerRow;
  index: number;
  isActive: boolean;
  isSelected: boolean;
  showOrder: boolean;
  onClick: () => void;
}) {
  const tone = STATUS_TONE[signer.status];

  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left transition-all"
      style={{
        border: `${isSelected ? 2.5 : 1.5}px solid ${isSelected ? "#287EAD" : tone.border}`,
        background: tone.bg,
        outline: isActive ? `2px solid #287EAD33` : undefined,
        outlineOffset: 2,
        cursor: "pointer",
      }}
    >
      {/* Header strip */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{ borderBottom: `1px solid ${tone.badgeBorder}` }}
      >
        {/* Initials avatar */}
        <div
          className="flex h-7 w-7 shrink-0 items-center justify-center text-[11px] font-bold text-white"
          style={{ background: tone.iconBg }}
        >
          {initials(signer.signer.full_name)}
        </div>

        {/* Name */}
        <div className="min-w-0 flex-1">
          <p
            className="truncate text-[13px] font-semibold"
            style={{ color: tone.text }}
          >
            {signer.signer.full_name}
          </p>
          {signer.signer.email && (
            <p className="truncate text-[10px]" style={{ color: "#94a3b8" }}>
              {signer.signer.email}
            </p>
          )}
        </div>

        {/* Status icon badge */}
        <div
          className="flex h-6 w-6 shrink-0 items-center justify-center"
          style={{ background: tone.iconBg }}
        >
          <StatusIcon status={signer.status} />
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-between px-3 py-1.5">
        <span
          className="inline-flex items-center px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide"
          style={{
            background: tone.badgeBg,
            color: tone.badgeText,
            border: `1px solid ${tone.badgeBorder}`,
          }}
        >
          {signer.status === "pending" && isActive ? "Signing now" : tone.label}
        </span>
        {showOrder && (
          <span className="text-[10px] font-semibold" style={{ color: "#94a3b8" }}>
            #{index + 1}
          </span>
        )}
        {signer.signed_at && (
          <span className="text-[10px] tabular-nums" style={{ color: "#94a3b8" }}>
            {formatTime(signer.signed_at)}
          </span>
        )}
      </div>
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Sequential (ordered) diagram                                       */
/* ------------------------------------------------------------------ */

function SequentialDiagram({
  signers,
  selectedId,
  onSelect,
}: {
  signers: SignerRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  // Determine the "active" signer — the first pending in sequence
  const activeId = signers.find((s) => s.status === "pending")?.id ?? null;

  return (
    <div className="flex items-start gap-0 overflow-x-auto py-4 pl-4 pr-8">
      {/* START node */}
      <div className="flex shrink-0 flex-col items-center gap-1">
        <div className="flex h-10 w-10 items-center justify-center rounded-full border-2 border-[#6b7280] bg-white text-[10px] font-bold text-[#374151]">
          START
        </div>
      </div>

      {signers.map((s, i) => {
        const prevDone = i === 0 || signers[i - 1].status === "signed";
        const lineActive = i === 0
          ? true
          : signers[i - 1].status === "signed";

        return (
          <div key={s.id} className="flex shrink-0 items-center">
            {/* Connector arrow */}
            <div className="flex items-center">
              <div
                className="h-0.5 w-8 shrink-0"
                style={{
                  background: lineActive ? "#6f8f80" : "#c4cad1",
                  backgroundImage: lineActive
                    ? undefined
                    : "repeating-linear-gradient(90deg,#c4cad1 0,#c4cad1 5px,transparent 5px,transparent 9px)",
                }}
              />
              <div
                className="h-0 w-0"
                style={{
                  borderTop: "5px solid transparent",
                  borderBottom: "5px solid transparent",
                  borderLeft: `7px solid ${lineActive ? "#6f8f80" : "#c4cad1"}`,
                }}
              />
            </div>

            {/* Signer card */}
            <div className="w-48 shrink-0">
              <SignerCard
                signer={s}
                index={i}
                isActive={s.id === activeId}
                isSelected={s.id === selectedId}
                showOrder={true}
                onClick={() => onSelect(s.id)}
              />
            </div>
          </div>
        );
      })}

      {/* Final arrow + END node */}
      <div className="flex items-center">
        {signers.length > 0 && (
          <>
            <div
              className="h-0.5 w-8 shrink-0"
              style={{
                background: signers[signers.length - 1].status === "signed" ? "#6f8f80" : "#c4cad1",
              }}
            />
            <div
              className="h-0 w-0"
              style={{
                borderTop: "5px solid transparent",
                borderBottom: "5px solid transparent",
                borderLeft: `7px solid ${signers[signers.length - 1].status === "signed" ? "#6f8f80" : "#c4cad1"}`,
              }}
            />
          </>
        )}
        <div className="flex shrink-0 flex-col items-center gap-1">
          <div
            className={clsx(
              "flex h-10 w-10 items-center justify-center rounded-full border-[3px] bg-white text-[10px] font-bold",
              signers.every((s) => s.status === "signed")
                ? "border-[#6f8f80] text-[#38564a]"
                : "border-[#6b7280] text-[#374151]",
            )}
          >
            END
          </div>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Any-order (parallel) grid                                          */
/* ------------------------------------------------------------------ */

function ParallelGrid({
  signers,
  selectedId,
  onSelect,
}: {
  signers: SignerRow[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 p-4 sm:grid-cols-3 lg:grid-cols-4">
      {signers.map((s, i) => (
        <SignerCard
          key={s.id}
          signer={s}
          index={i}
          isActive={s.status === "pending"}
          isSelected={s.id === selectedId}
          showOrder={false}
          onClick={() => onSelect(s.id)}
        />
      ))}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Zoom-style button (reused pattern)                                 */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* Main component                                                     */
/* ------------------------------------------------------------------ */

export function SignatureRequestVisualizer({
  data,
  fullPage = false,
}: SignatureRequestVisualizerProps) {
  const [diagramOpen, setDiagramOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [selectedSignerId, setSelectedSignerId] = useState<string | null>(null);

  const signers = useMemo(
    () => [...(data.signers ?? [])].sort((a, b) => a.order - b.order),
    [data.signers],
  );

  const signed = data.progress?.signed ?? signers.filter((s) => s.status === "signed").length;
  const total  = data.progress?.total  ?? signers.length;
  const pct    = total > 0 ? Math.round((signed / total) * 100) : 0;

  const activeId = data.ordered
    ? signers.find((s) => s.status === "pending")?.id ?? null
    : null;

  const selectedSigner =
    (selectedSignerId ? signers.find((s) => s.id === selectedSignerId) : undefined) ??
    (activeId ? signers.find((s) => s.id === activeId) : undefined) ??
    signers[0];

  /* ── Overall status banner ────────────────────────────── */
  const overallBanner = (() => {
    if (data.status === "completed") {
      return { text: "All signatures collected", bg: "#edf3f0", border: "#bdcec7", text2: "#38564a" };
    }
    if (data.status === "declined") {
      return { text: "Signature request declined", bg: "#f4eeee", border: "#d4bbbb", text2: "#664242" };
    }
    if (data.status === "cancelled") {
      return { text: "Signature request cancelled", bg: "#f1f5f9", border: "#d2d7dd", text2: "#56616d" };
    }
    return null;
  })();

  return (
    <div
      className={clsx(
        "w-full overflow-hidden border border-[#C8CDD2] bg-white shadow-sm",
        fullPage && "flex h-full flex-col border-[#C8CDD2] shadow-none",
      )}
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4 border-b border-[#206D99] bg-[#287EAD] px-5 py-4 text-white">
        {/* Icon */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-white/25 bg-white/10 text-white">
          <FileSignature className="h-5 w-5" />
        </div>

        {/* Title block */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-[15px] font-bold tracking-tight text-white">
              {data.document_title ?? "Signature Request"}
            </h3>
            <span
              className={clsx(
                "shrink-0 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider",
                data.ordered ? "bg-violet-600/80 text-white" : "bg-white/20 text-white",
              )}
            >
              {data.ordered ? "Sequential" : "Any Order"}
            </span>
          </div>
          <p className="mt-0.5 text-xs text-white/75">
            {data.requested_by && (
              <>
                Requested by{" "}
                <span className="font-semibold text-white">{data.requested_by.full_name}</span>
              </>
            )}
            {data.created_at && (
              <> · <span>{formatTime(data.created_at)}</span></>
            )}
          </p>
        </div>

        {/* Progress ring */}
        <div className="flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/65">Signatures</p>
            <p className="text-base font-black text-white">
              {signed}/{total}
            </p>
          </div>
          <ProgressRing pct={pct} />
        </div>
      </div>

      {/* ── Banner ──────────────────────────────────────────────── */}
      {overallBanner && (
        <div
          className="flex items-center gap-2 px-5 py-2 text-sm font-semibold"
          style={{
            background: overallBanner.bg,
            borderBottom: `1px solid ${overallBanner.border}`,
            color: overallBanner.text2,
          }}
        >
          {data.status === "completed" && <Check className="h-4 w-4" />}
          {data.status === "declined" && <XCircle className="h-4 w-4" />}
          {data.status === "cancelled" && <Clock className="h-4 w-4" />}
          {overallBanner.text}
          {data.completed_at && (
            <span className="font-normal opacity-70">— {formatTime(data.completed_at)}</span>
          )}
        </div>
      )}

      {/* ── Optional message from requester ─────────────────────── */}
      {data.message && (
        <div className="flex items-start gap-2 border-b border-[#C8CDD2] bg-[#FAFBFC] px-5 py-2.5 text-xs text-[#5E6870]">
          <MessageSquare className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span className="italic">{data.message}</span>
        </div>
      )}

      {/* ── Diagram section ─────────────────────────────────────── */}
      <div className="border-t border-[#C8CDD2]">
        <div className="flex items-center justify-between bg-[#F5F7F8] px-4 py-2">
          <button
            type="button"
            onClick={() => setDiagramOpen((v) => !v)}
            className="inline-flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-widest text-[#5E6870] transition hover:text-[#1F2933]"
          >
            {diagramOpen ? (
              <ChevronDown className="h-3.5 w-3.5" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5" />
            )}
            {data.ordered ? "Signing Order" : "Signers"}
          </button>

          <div className="flex items-center gap-1.5">
            <Users className="h-3.5 w-3.5 text-[#5E6870]" />
            <span className="text-[11px] font-semibold text-[#5E6870]">
              {total} signer{total !== 1 ? "s" : ""}
            </span>
          </div>
        </div>

        {diagramOpen && (
          <div
            className="border-t border-[#C8CDD2] overflow-auto"
            style={{
              background:
                "radial-gradient(circle, rgba(31,41,51,0.06) 1px, transparent 1px)",
              backgroundSize: "20px 20px",
              backgroundColor: "#EDEDED",
              minHeight: 120,
              maxHeight: fullPage ? undefined : 300,
            }}
          >
            {data.ordered ? (
              <SequentialDiagram
                signers={signers}
                selectedId={selectedSigner?.id ?? null}
                onSelect={setSelectedSignerId}
              />
            ) : (
              <ParallelGrid
                signers={signers}
                selectedId={selectedSigner?.id ?? null}
                onSelect={setSelectedSignerId}
              />
            )}
          </div>
        )}
      </div>

      {/* ── Signer Details panel ─────────────────────────────────── */}
      <div className="border-t border-[#C8CDD2]">
        <button
          type="button"
          onClick={() => setDetailsOpen((v) => !v)}
          className="flex w-full items-center justify-between bg-white px-4 py-3 text-left transition hover:bg-[#F5F7F8]"
        >
          <div className="flex items-center gap-2">
            {detailsOpen ? (
              <ChevronDown className="h-3.5 w-3.5 text-[#5E6870]" />
            ) : (
              <ChevronRight className="h-3.5 w-3.5 text-[#5E6870]" />
            )}
            <span className="text-[11px] font-bold uppercase tracking-widest text-[#5E6870]">
              Signer Details
            </span>
          </div>
          <span className="border border-[#C8CDD2] bg-[#F5F7F8] px-2.5 py-0.5 text-[11px] font-semibold text-[#5E6870]">
            {selectedSigner?.signer.full_name ?? "No signer selected"}
          </span>
        </button>

        {detailsOpen && selectedSigner && (
          <div className="px-4 pb-4">
            <div className="border border-[#C8CDD2] bg-[#F5F7F8] p-4">
              <div className="flex items-start gap-3">
                {/* Avatar */}
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center text-sm font-bold text-white"
                  style={{ background: STATUS_TONE[selectedSigner.status].iconBg }}
                >
                  {initials(selectedSigner.signer.full_name)}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold text-[#1F2933]">
                      {selectedSigner.signer.full_name}
                    </h4>
                    <span
                      className="inline-flex items-center border px-2 py-0.5 text-[10px] font-bold"
                      style={{
                        background: STATUS_TONE[selectedSigner.status].badgeBg,
                        color: STATUS_TONE[selectedSigner.status].badgeText,
                        borderColor: STATUS_TONE[selectedSigner.status].badgeBorder,
                      }}
                    >
                      {selectedSigner.status === "pending" && selectedSigner.id === activeId
                        ? "Signing now"
                        : STATUS_TONE[selectedSigner.status].label}
                    </span>
                    {data.ordered && (
                      <span className="border border-[#C8CDD2] bg-white px-1.5 py-0.5 text-[10px] font-semibold text-[#5E6870]">
                        Signer #{signers.findIndex((s) => s.id === selectedSigner.id) + 1}
                      </span>
                    )}
                  </div>

                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#5E6870]">
                    {selectedSigner.signer.email && (
                      <span>{selectedSigner.signer.email}</span>
                    )}
                    {selectedSigner.signed_at && (
                      <span className="inline-flex items-center gap-1">
                        <Check className="h-3 w-3" />
                        Signed {formatTime(selectedSigner.signed_at)}
                      </span>
                    )}
                    {selectedSigner.status === "pending" && !selectedSigner.signed_at && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {selectedSigner.id === activeId
                          ? "Awaiting signature now"
                          : data.ordered
                          ? "Awaiting previous signer"
                          : "Pending signature"}
                      </span>
                    )}
                  </div>

                  {selectedSigner.decline_reason && (
                    <div className="mt-3 flex items-start gap-1.5 border border-[#d4bbbb] bg-[#faf6f6] px-2.5 py-2 text-xs text-[#664242]">
                      <XCircle className="mt-0.5 h-3 w-3 shrink-0" />
                      <span>
                        <span className="font-semibold">Declined: </span>
                        {selectedSigner.decline_reason}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Loading / empty states (exported for use in the page)             */
/* ------------------------------------------------------------------ */

export function SignatureVisualizerSkeleton() {
  return (
    <div className="flex min-h-[20rem] items-center justify-center gap-2 border border-dashed border-[#C8CDD2] bg-[#F5F7F8] text-sm text-[#5E6870]">
      <Loader2 className="h-4 w-4 animate-spin text-[#287EAD]" />
      Loading signature details…
    </div>
  );
}

export function SignatureVisualizerEmpty() {
  return (
    <div className="flex min-h-[20rem] items-center justify-center border border-dashed border-[#C8CDD2] bg-[#F5F7F8] text-sm text-[#5E6870]">
      No signature request found for this document.
    </div>
  );
}
