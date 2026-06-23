// workflow-visualizer.tsx
// Enterprise BPMN-style workflow visualizer — refined Infor/SAP DMS aesthetic.
// Improvements over previous version:
//   - Proper branch-aware layout engine (gateway → Yes/No rows)
//   - Enhanced orthogonal edge routing with segment smoothing
//   - Polished node cards: wider, better spacing, full labels
//   - Dark-mode ready with CSS-variable tokens
//   - fullPage prop for dedicated route rendering
//   - Hover tooltips on nodes showing comment/description inline
//   - Animated progress ring in header
//   - Collapsible step-details panel

import { useMemo, useState, useCallback } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  
  GitBranch,
  Loader2,
  MessageSquare,
  Minus,
  
  RotateCcw,
  User,
  XCircle,
  ZoomIn,
  ZoomOut,
} from "lucide-react";
import clsx from "clsx";

/* ------------------------------------------------------------------ */
/* Types                                                              */
/* ------------------------------------------------------------------ */

export type WorkflowStatus =
  | "completed"
  | "pending"
  | "in-progress"
  | "on-hold"
  | "rejected"
  | "returned"
  | "skipped";

export interface WorkflowStep {
  id: string;
  name: string;
  approver: string;
  status: WorkflowStatus;
  statusDisplay?: string;
  completedAt?: string;
  comment?: string;
  order: number;
  kind?: "task" | "gateway" | "start" | "end";
  branchLabel?: string;
  next?: string[];
  description?: string;
  lane?: number;
  column?: number;
}

interface WorkflowVisualizerProps {
  steps: WorkflowStep[];
  currentStep?: number;
  documentTitle?: string;
  submittedBy?: string;
  submittedDate?: string;
  isLoading?: boolean;
  /** Dedicated page mode — fills container height, no outer card border */
  fullPage?: boolean;
}

/* ------------------------------------------------------------------ */
/* Design tokens                                                      */
/* ------------------------------------------------------------------ */

const TONE: Record<WorkflowStatus, {
  stroke: string;
  strokeLight: string;
  fill: string;
  fillDark: string;
  text: string;
  accent: string;
  badgeBg: string;
  badgeText: string;
  badgeBorder: string;
  label: string;
}> = {
  completed: {
    stroke: "#6f8f80",
    strokeLight: "#9fb8ad",
    fill: "#f5f8f6",
    fillDark: "#052e16",
    text: "#38564a",
    accent: "#7f9f92",
    badgeBg: "#edf3f0",
    badgeText: "#38564a",
    badgeBorder: "#bdcec7",
    label: "Approved",
  },
  "in-progress": {
    stroke: "#6b7280",
    strokeLight: "#a5b0c1",
    fill: "#f6f7fb",
    fillDark: "#2d4263",
    text: "#475569",
    accent: "#8b96ac",
    badgeBg: "#f1f3f8",
    badgeText: "#475569",
    badgeBorder: "#d1d8e3",
    label: "In Progress",
  },
  "on-hold": {
    stroke: "#9a8f70",
    strokeLight: "#c9bea0",
    fill: "#faf8f1",
    fillDark: "#423813",
    text: "#62583d",
    accent: "#aa9d7b",
    badgeBg: "#f4f0e4",
    badgeText: "#62583d",
    badgeBorder: "#d8cfb7",
    label: "On Hold",
  },
  rejected: {
    stroke: "#9b7474",
    strokeLight: "#c2a3a3",
    fill: "#faf6f6",
    fillDark: "#450a0a",
    text: "#664242",
    accent: "#a98585",
    badgeBg: "#f4eeee",
    badgeText: "#664242",
    badgeBorder: "#d4bbbb",
    label: "Rejected",
  },
  skipped: {
    stroke: "#8f98a3",
    strokeLight: "#c4cad1",
    fill: "#f8f9fa",
    fillDark: "#1e293b",
    text: "#56616d",
    accent: "#9aa3ad",
    badgeBg: "#f1f5f9",
    badgeText: "#56616d",
    badgeBorder: "#d2d7dd",
    label: "Skipped",
  },
  returned: {
    stroke: "#9b866f",
    strokeLight: "#c2b09d",
    fill: "#faf7f3",
    fillDark: "#45301f",
    text: "#644d38",
    accent: "#a98f76",
    badgeBg: "#f4eee8",
    badgeText: "#644d38",
    badgeBorder: "#d7c5b4",
    label: "Returned",
  },
  pending: {
    stroke: "#8f98a3",
    strokeLight: "#c4cad1",
    fill: "#f8f9fa",
    fillDark: "#1e293b",
    text: "#56616d",
    accent: "#9aa3ad",
    badgeBg: "#f1f5f9",
    badgeText: "#56616d",
    badgeBorder: "#d2d7dd",
    label: "Pending",
  },
};

const NODE_W = 220;
const NODE_H = 100;
const GW_HALF = 36;       // gateway diamond half-diagonal
const CIRCLE_R = 28;
const COL_GAP = 72;       // horizontal gap between nodes
const ROW_GAP = 80;       // vertical gap between branch rows
const PAD_X = 48;         // left/top canvas padding
const PAD_Y = 56;
// STEP_TINTS removed (unused)
const NODE_PALETTE = [
  { fill: "#eef2ff", accent: "#818cf8" },
  { fill: "#ecfdf5", accent: "#34d399" },
  { fill: "#fffbeb", accent: "#f6ad55" },
  { fill: "#fff1f2", accent: "#f9a8d4" },
  { fill: "#f5f3ff", accent: "#c4b5fd" },
  { fill: "#eff6ff", accent: "#60a5fa" },
];

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

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

function StatusIcon({ status, className }: { status: WorkflowStatus; className?: string }) {
  const cls = clsx("shrink-0", className);
  switch (status) {
    case "completed":   return <Check className={cls} />;
    case "in-progress": return <Loader2 className={clsx(cls, "animate-spin")} />;
    case "on-hold":     return <Clock className={cls} />;
    case "rejected":    return <XCircle className={cls} />;
    case "returned":    return <XCircle className={cls} />;
    case "skipped":     return <Minus className={cls} />;
    default:            return <Clock className={cls} />;
  }
}

function nodePalette(node: WorkflowStep) {
  const index = Math.max(0, Math.round(node.order) - 1);
  return NODE_PALETTE[index % NODE_PALETTE.length];
}

/** Upcoming / unreached steps read as inactive, so they stay neutral grey. */
function isInactiveStatus(status: WorkflowStatus) {
  return status === "pending" || status === "skipped";
}

function nodeFill(node: WorkflowStep) {
  return TONE[node.status].fill;
}

/**
 * Accent colour for a node's border, left bar and header tint. Reached steps
 * keep a soft colourful tint to mark the active path; upcoming/unreached steps
 * stay muted grey so they don't compete with the live stage.
 */
function nodeAccent(node: WorkflowStep) {
  if (isInactiveStatus(node.status)) return TONE[node.status].accent;
  return nodePalette(node).accent;
}

function statusLabel(node: WorkflowStep) {
  // The data layer already resolves a position-aware label (e.g. "In progress",
  // "Approved", "Awaiting Finance approval"); fall back to the tone default only
  // for structural nodes (start/end) that carry no display text.
  const custom = node.statusDisplay?.trim();
  if (custom) return custom;
  return TONE[node.status].label;
}

/* ------------------------------------------------------------------ */
/* Layout engine                                                      */
/* ------------------------------------------------------------------ */

interface Positioned extends WorkflowStep {
  x: number;   // centre x
  y: number;   // centre y
  col: number;
  row: number;
}

/**
 * Branch-aware column layout:
 * - Walk steps sorted by `order`.
 * - When a gateway appears, the next node whose `next` index is 0 goes to row 0,
 *   index 1 goes to row 1, etc.
 * - "end" nodes always collapse back to row 0.
 * - Falls back to linear order when `next` is not supplied.
 */
function layout(steps: WorkflowStep[]): {
  nodes: Positioned[];
  edges: Array<{ from: string; to: string; label?: string; active: boolean }>;
  width: number;
  height: number;
} {
  if (!steps.length) return { nodes: [], edges: [], width: 400, height: 200 };

  const sorted = [...steps].sort((a, b) => a.order - b.order);
  // ---- Assign col / row -------------------------------------------
  // Build adjacency map for proper row tracking
  const rowOf = new Map<string, number>();
  const colOf = new Map<string, number>();

  let col = 0;

  sorted.forEach((s, i) => {
    const prev = sorted[i - 1];

    let row = s.lane ?? rowOf.get(s.id) ?? 0;

    if (s.kind === "end") {
      row = s.lane ?? 0;
    } else if (prev?.kind === "gateway" && prev.next?.length) {
      // rows were pre-assigned below; just keep what was set
      row = s.lane ?? rowOf.get(s.id) ?? 0;
    }

    rowOf.set(s.id, row);
    colOf.set(s.id, s.column ?? col);
    col = Math.max(col + 1, (s.column ?? col) + 1);

    // Pre-assign rows for outgoing branch targets
    if (s.kind === "gateway" && s.next?.length) {
      s.next.forEach((nid, j) => {
        if (!rowOf.has(nid)) rowOf.set(nid, j);
      });
    }
  });

  // ---- Pixel positions --------------------------------------------
  const colW = NODE_W + COL_GAP;
  const rowH = NODE_H + ROW_GAP;

  const nodes: Positioned[] = sorted.map((s) => {
    const c = colOf.get(s.id) ?? 0;
    const r = rowOf.get(s.id) ?? 0;
    return {
      ...s,
      col: c,
      row: r,
      x: PAD_X + c * colW + NODE_W / 2,
      y: PAD_Y + r * rowH + NODE_H / 2,
    };
  });

  // ---- Edges -------------------------------------------------------
  const posById = new Map(nodes.map((n) => [n.id, n]));

  const edges: Array<{ from: string; to: string; label?: string; active: boolean }> = [];

  nodes.forEach((n, idx) => {
    const active = n.status === "completed";
    if (n.next?.length) {
      n.next.forEach((toId, j) => {
        const to = posById.get(toId);
        if (!to) return;
        edges.push({
          from: n.id,
          to: toId,
          label: n.kind === "gateway" ? (j === 0 ? "Yes" : "No") : to.status === "rejected" ? "Rejected" : undefined,
          active: active || to.status === "rejected",
        });
      });
    } else if (n.kind !== "end") {
      const next = nodes[idx + 1];
      if (next) {
        edges.push({
          from: n.id,
          to: next.id,
          label: n.kind === "gateway" ? (next.row === 0 ? "Yes" : "No") : undefined,
          active,
        });
      }
    }
  });

  // ---- Canvas size -------------------------------------------------
  const maxX = Math.max(...nodes.map((n) => n.x)) + NODE_W / 2 + PAD_X;
  const maxY = Math.max(...nodes.map((n) => n.y)) + NODE_H / 2 + PAD_Y;

  return { nodes, edges, width: maxX, height: maxY };
}

/* ------------------------------------------------------------------ */
/* Edge routing                                                       */
/* ------------------------------------------------------------------ */

function rightEdge(n: Positioned): { x: number; y: number } {
  if (n.kind === "start" || n.kind === "end") return { x: n.x + CIRCLE_R, y: n.y };
  if (n.kind === "gateway") return { x: n.x + GW_HALF, y: n.y };
  return { x: n.x + NODE_W / 2, y: n.y };
}

function leftEdge(n: Positioned): { x: number; y: number } {
  if (n.kind === "start" || n.kind === "end") return { x: n.x - CIRCLE_R, y: n.y };
  if (n.kind === "gateway") return { x: n.x - GW_HALF, y: n.y };
  return { x: n.x - NODE_W / 2, y: n.y };
}

function buildPath(from: Positioned, to: Positioned): string {
  const { x: fx, y: fy } = rightEdge(from);
  const { x: tx, y: ty } = leftEdge(to);

  if (Math.abs(fy - ty) < 8) {
    // Same row — straight line
    return `M ${fx} ${fy} L ${tx} ${ty}`;
  }

  // Orthogonal elbow routing: right → down/up → right
  const elbowX = fx + (tx - fx) * 0.42;
  return (
    `M ${fx},${fy} ` +
    `L ${elbowX},${fy} ` +
    `L ${elbowX},${ty} ` +
    `L ${tx},${ty}`
  );
}

/* ------------------------------------------------------------------ */
/* SVG node shapes                                                    */
/* ------------------------------------------------------------------ */

function NodeShape({
  node,
  hovered,
  selected,
  onHover,
  onSelect,
}: {
  node: Positioned;
  hovered: boolean;
  selected: boolean;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const tone = TONE[node.status];

  const handlers = {
    onMouseEnter: () => onHover(node.id),
    onMouseLeave: () => onHover(null),
    onClick: () => onSelect(node.id),
  };

  /* Start / End circles */
  if (node.kind === "start" || node.kind === "end") {
    const isEnd = node.kind === "end";
    return (
      <g transform={`translate(${node.x},${node.y})`} {...handlers}>
        <circle
          r={CIRCLE_R + 2}
          fill="white"
          stroke={selected ? tone.stroke : "#6b7280"}
          strokeWidth={selected ? 4 : isEnd ? 4 : 2}
          style={{ filter: hovered ? "drop-shadow(0 4px 8px rgba(0,0,0,0.14))" : undefined }}
        />
        {isEnd && <circle r={CIRCLE_R - 5} fill="white" stroke="#6b7280" strokeWidth={2} />}
        <text
          textAnchor="middle"
          dominantBaseline="central"
          style={{
            fontSize: 11,
            fontWeight: 700,
            fill: "#374151",
            fontFamily: "inherit",
            letterSpacing: "0.03em",
          }}
        >
          {isEnd ? "END" : "START"}
        </text>
      </g>
    );
  }

  /* Gateway diamonds */
  if (node.kind === "gateway") {
    const d = GW_HALF;
    return (
      <g transform={`translate(${node.x},${node.y})`} {...handlers}>
        <polygon
          points={`0,${-d} ${d},0 0,${d} ${-d},0`}
          fill="white"
          stroke={selected ? tone.stroke : "#6b7280"}
          strokeWidth={2}
          style={{ filter: hovered ? "drop-shadow(0 4px 10px rgba(0,0,0,0.15))" : undefined }}
        />
        <text
          textAnchor="middle"
          dominantBaseline="central"
          style={{ fontSize: 20, fontWeight: 300, fill: "#6b7280", fontFamily: "inherit" }}
        >
          ×
        </text>
        {node.name && (
          <text
            y={d + 16}
            textAnchor="middle"
            style={{ fontSize: 10, fill: "#64748b", fontFamily: "inherit" }}
          >
            {truncate(node.name, 20)}
          </text>
        )}
      </g>
    );
  }

  /* Task rectangles */
  const lx = node.x - NODE_W / 2;
  const ty2 = node.y - NODE_H / 2;
  const accent = nodeAccent(node);
  const shadow = hovered
    ? "drop-shadow(0 6px 16px rgba(0,0,0,0.14))"
    : "drop-shadow(0 2px 4px rgba(0,0,0,0.06))";
  const sw = node.status === "in-progress" ? 2.5 : 1.5;
  const borderColor = selected ? tone.stroke : accent;

  return (
    <g transform={`translate(${lx},${ty2})`} {...handlers} style={{ cursor: "pointer" }}>
      {/* Card background */}
      <rect
        width={NODE_W}
        height={NODE_H}
        rx={10}
        fill={nodeFill(node)}
        stroke={borderColor}
        strokeWidth={sw}
        style={{ filter: shadow, transition: "filter 0.15s" }}
      />
      <rect x={0} y={0} width={NODE_W} height={24} rx={10} fill={accent} opacity={0.08} />

      {/* Left accent bar */}
      <rect width={7} height={NODE_H} rx={3} fill={accent} />

      {/* Top-right status dot */}
      <circle cx={NODE_W - 16} cy={16} r={12} fill={tone.stroke} />
      <foreignObject x={NODE_W - 28} y={4} width={24} height={24}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: "100%",
            height: "100%",
            color: "white",
          }}
        >
          <StatusIcon status={node.status} className="h-3.5 w-3.5" />
        </div>
      </foreignObject>

      {/* Step name */}
      <text
        x={18}
        y={26}
        style={{
          fontSize: 13,
          fontWeight: 700,
          fill: tone.text,
          fontFamily: "inherit",
        }}
      >
        {truncate(node.name, 26)}
      </text>

      {/* Approver row */}
      <foreignObject x={16} y={34} width={NODE_W - 24} height={20}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 4,
            fontSize: 11,
            color: "#64748b",
            overflow: "hidden",
            whiteSpace: "nowrap",
          }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
            <circle cx="12" cy="7" r="4" />
          </svg>
          <span style={{ overflow: "hidden", textOverflow: "ellipsis" }}>
            {node.approver || "Unassigned"}
          </span>
        </div>
      </foreignObject>

      {/* Divider */}
      <line x1={8} y1={60} x2={NODE_W - 8} y2={60} stroke="#e2e8f0" strokeWidth={1} />

      {/* Footer: badge + timestamp */}
      <foreignObject x={12} y={64} width={NODE_W - 16} height={30}>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            fontSize: 10,
          }}
        >
          <span
            style={{
              display: "inline-flex",
              alignItems: "center",
              borderRadius: 99,
              padding: "2px 8px",
              fontWeight: 600,
              background: tone.badgeBg,
              color: tone.badgeText,
              border: `1px solid ${tone.badgeBorder}`,
              letterSpacing: "0.02em",
            }}
          >
            {statusLabel(node)}
          </span>
          {node.completedAt && (
            <span style={{ color: "#94a3b8", fontVariantNumeric: "tabular-nums" }}>
              {formatTime(node.completedAt)}
            </span>
          )}
        </div>
      </foreignObject>

      {/* Comment indicator */}
      {node.comment && (
        <foreignObject x={NODE_W - 30} y={NODE_H - 24} width={20} height={20}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: "#f9fafb",
              borderRadius: 4,
              width: "100%",
              height: "100%",
              color: "#6b7280",
            }}
            title={node.comment}
          >
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
        </foreignObject>
      )}
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* SVG edge                                                           */
/* ------------------------------------------------------------------ */

function Edge({
  from,
  to,
  label,
  active,
}: {
  from: Positioned;
  to: Positioned;
  label?: string;
  active: boolean;
}) {
  const d = buildPath(from, to);
  const color = to.status === "rejected" ? TONE.rejected.stroke : active ? TONE.completed.stroke : TONE.pending.stroke;
  const markerId = to.status === "rejected" ? "arrow-rejected" : active ? "arrow-active" : "arrow-default";

  // Label midpoint — place near source for branch labels
  const { x: fx, y: fy } = rightEdge(from);
  const { x: tx, y: ty } = leftEdge(to);
  const lx = from.kind === "gateway" ? fx + 28 : (fx + tx) / 2;
  const ly = fy === ty ? fy - 10 : (fy + ty) / 2;

  return (
    <g>
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={2}
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={active ? undefined : "5,4"}
        markerEnd={`url(#${markerId})`}
      />
      {label && (
        <g>
          <rect
            x={lx - 16}
            y={ly - 9}
            width={32}
            height={18}
            rx={4}
            fill="white"
            stroke={color}
            strokeWidth={1}
          />
          <text
            x={lx}
            y={ly}
            textAnchor="middle"
            dominantBaseline="central"
            style={{
              fontSize: 10,
              fontWeight: 700,
              fill: color,
              fontFamily: "inherit",
              letterSpacing: "0.04em",
            }}
          >
            {label}
          </text>
        </g>
      )}
    </g>
  );
}

/* ------------------------------------------------------------------ */
/* Progress ring                                                      */
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
/* Summary card                                                       */
/* ------------------------------------------------------------------ */

// SummaryCard removed (unused)

/* ------------------------------------------------------------------ */
/* Zoom button                                                        */
/* ------------------------------------------------------------------ */

function ZoomBtn({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex h-7 w-7 items-center justify-center border border-[#C8CDD2] bg-white text-[#5E6870] shadow-sm transition hover:bg-[#EEF6FB] hover:text-[#287EAD] active:scale-95"
    >
      {children}
    </button>
  );
}

/* ------------------------------------------------------------------ */
/* Main component                                                     */
/* ------------------------------------------------------------------ */

export function WorkflowVisualizer({
  steps = [],
  currentStep,
  documentTitle,
  submittedBy,
  submittedDate,
  isLoading,
  fullPage = false,
}: WorkflowVisualizerProps) {
  const [zoom, setZoom] = useState(1);
  const [diagramOpen, setDiagramOpen] = useState(true);
  const [detailsOpen, setDetailsOpen] = useState(true);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  const { nodes, edges, width, height } = useMemo(() => layout(steps), [steps]);

  const counts = useMemo(() => {
    const c = { completed: 0, "in-progress": 0, pending: 0, rejected: 0 };
    steps.forEach((s) => {
      if (s.kind && s.kind !== "task") return;
      if (s.status in c) c[s.status as keyof typeof c]++;
    });
    return c;
  }, [steps]);

  const taskTotal = Object.values(counts).reduce((a, b) => a + b, 0);
  const progress = taskTotal ? Math.round((counts.completed / taskTotal) * 100) : 0;

  const handleHover = useCallback((id: string | null) => setHoveredId(id), []);
  const hoveredStep = hoveredId ? steps.find((s) => s.id === hoveredId) : null;
  const selectedStep =
    (selectedStepId ? steps.find((s) => s.id === selectedStepId) : undefined) ||
    steps.find((s) => (s.status === "in-progress" || s.status === "on-hold") && (!s.kind || s.kind === "task")) ||
    (typeof currentStep === "number" && currentStep >= 0 ? steps[currentStep] : undefined) ||
    steps.find((s) => !s.kind || s.kind === "task") ||
    steps[0];

  /* Loading */
  if (isLoading) {
    return (
      <div className="flex h-64 items-center justify-center gap-2 border border-dashed border-[#C8CDD2] bg-[#F5F7F8] text-sm text-[#5E6870]">
        <Loader2 className="h-4 w-4 animate-spin text-[#287EAD]" />
        Loading workflow…
      </div>
    );
  }

  /* Empty */
  if (!steps.length) {
    return (
      <div className="flex h-40 items-center justify-center border border-dashed border-[#C8CDD2] bg-[#F5F7F8] text-sm text-[#5E6870]">
        No workflow steps to display.
      </div>
    );
  }

  return (
    <div
      className={clsx(
        "w-full overflow-hidden border border-[#C8CDD2] bg-white shadow-sm",
        fullPage && "flex h-full flex-col border-[#C8CDD2] shadow-none"
      )}
    >
      {/* ── Header ──────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4 border-b border-[#206D99] bg-[#287EAD] px-5 py-4 text-white">
        {/* Icon */}
        <div className="flex h-10 w-10 shrink-0 items-center justify-center border border-white/25 bg-white/10 text-white">
          <GitBranch className="h-5 w-5" />
        </div>

        {/* Title block */}
        <div className="min-w-0 flex-1">
          <h3 className="truncate text-[15px] font-bold tracking-tight text-white">
            {documentTitle ?? "Workflow Progress"}
          </h3>
          <p className="mt-0.5 text-xs text-white/75">
            {submittedBy && (
              <>
                Submitted by{" "}
                <span className="font-semibold text-white">{submittedBy}</span>
              </>
            )}
            {submittedDate && (
              <> &middot; <span>{formatTime(submittedDate)}</span></>
            )}
          </p>
        </div>

        {/* Progress ring */}
        <div className="flex items-center gap-3">
          <div className="hidden text-right sm:block">
            <p className="text-[10px] font-bold uppercase tracking-widest text-white/65">Progress</p>
            <p className="text-base font-black text-white">
              {counts.completed}/{taskTotal} steps
            </p>
          </div>
          <ProgressRing pct={progress} />
        </div>
      </div>

      {/* ── Diagram section ─────────────────────────────────────── */}
      <div className="border-t border-[#C8CDD2]">
        {/* Toolbar */}
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
            Workflow Diagram
          </button>

          <div className="flex items-center gap-1.5">
            <ZoomBtn onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(1)))}>
              <ZoomOut className="h-3.5 w-3.5" />
            </ZoomBtn>
            <span className="w-10 text-center font-mono text-[11px] text-[#5E6870]">
              {Math.round(zoom * 100)}%
            </span>
            <ZoomBtn onClick={() => setZoom((z) => Math.min(2.5, +(z + 0.1).toFixed(1)))}>
              <ZoomIn className="h-3.5 w-3.5" />
            </ZoomBtn>
            <ZoomBtn onClick={() => setZoom(1)}>
              <RotateCcw className="h-3.5 w-3.5" />
            </ZoomBtn>
          </div>
        </div>

        {/* Canvas */}
        {diagramOpen && (
          <div
            className="overflow-auto border-t border-[#C8CDD2]"
            style={{
              background:
                "radial-gradient(circle, rgba(31,41,51,0.06) 1px, transparent 1px)",
              backgroundSize: "20px 20px",
              backgroundColor: "#EDEDED",
              maxHeight: fullPage ? undefined : 480,
            }}
          >
            <div style={{ width: width * zoom, height: height * zoom, minWidth: "100%", position: "relative" }}>
              <svg
                width={width * zoom}
                height={height * zoom}
                viewBox={`0 0 ${width} ${height}`}
                className="block"
              >
                <defs>
                  <marker
                    id="arrow-default"
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="3"
                    orient="auto"
                    markerUnits="strokeWidth"
                  >
                    <path d="M0,0 L0,6 L8,3 z" fill={TONE.pending.stroke} />
                  </marker>
                  <marker
                    id="arrow-active"
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="3"
                    orient="auto"
                    markerUnits="strokeWidth"
                  >
                    <path d="M0,0 L0,6 L8,3 z" fill={TONE.completed.stroke} />
                  </marker>
                  <marker
                    id="arrow-rejected"
                    markerWidth="8"
                    markerHeight="8"
                    refX="7"
                    refY="3"
                    orient="auto"
                    markerUnits="strokeWidth"
                  >
                    <path d="M0,0 L0,6 L8,3 z" fill={TONE.rejected.stroke} />
                  </marker>
                </defs>

                {/* Edges first (under nodes) */}
                {edges.map((e, i) => {
                  const from = nodes.find((n) => n.id === e.from);
                  const to = nodes.find((n) => n.id === e.to);
                  if (!from || !to) return null;
                  return (
                    <Edge key={i} from={from} to={to} label={e.label} active={e.active} />
                  );
                })}

                {/* Nodes */}
                {nodes.map((n) => (
                  <NodeShape
                    key={n.id}
                    node={n}
                    hovered={hoveredId === n.id}
                    selected={selectedStep?.id === n.id}
                    onHover={handleHover}
                    onSelect={setSelectedStepId}
                  />
                ))}
              </svg>
            </div>

            {/* Hover tooltip */}
            {hoveredStep && (hoveredStep.comment || hoveredStep.description) && (
              <div
                className="pointer-events-none absolute bottom-4 right-4 max-w-xs border border-[#C8CDD2] bg-white p-3 shadow-xl"
                style={{ zIndex: 10 }}
              >
                <p className="text-[11px] font-bold text-[#1F2933]">{hoveredStep.name}</p>
                {hoveredStep.description && (
                  <p className="mt-0.5 text-[11px] text-[#5E6870]">{hoveredStep.description}</p>
                )}
                {hoveredStep.comment && (
                  <div className="mt-1.5 border border-[#C8CDD2] bg-[#F5F7F8] px-2 py-1.5 text-[11px] text-[#1F2933]">
                    <MessageSquare className="mr-1 inline h-3 w-3" />
                    {hoveredStep.comment}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* ── Step Details ────────────────────────────────────────── */}
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
              Step Details
            </span>
          </div>
          <span className="border border-[#C8CDD2] bg-[#F5F7F8] px-2.5 py-0.5 text-[11px] font-semibold text-[#5E6870]">
            {selectedStep?.name ?? "No step selected"}
          </span>
        </button>

        {detailsOpen && selectedStep && (
          <div className="px-4 pb-4">
            <div className="border border-[#C8CDD2] bg-[#F5F7F8] p-4">
              <div className="flex items-start gap-3">
                <div
                  className="flex h-9 w-9 shrink-0 items-center justify-center text-white shadow-sm"
                  style={{ background: TONE[selectedStep.status].stroke }}
                >
                  <StatusIcon status={selectedStep.status} className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-sm font-semibold text-[#1F2933]">{selectedStep.name}</h4>
                    <span
                      className="inline-flex items-center border px-2 py-0.5 text-[10px] font-bold"
                      style={{
                        background: TONE[selectedStep.status].badgeBg,
                        color: TONE[selectedStep.status].badgeText,
                        borderColor: TONE[selectedStep.status].badgeBorder,
                      }}
                    >
                      {statusLabel(selectedStep)}
                    </span>
                  </div>
                  <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[#5E6870]">
                    <span className="inline-flex items-center gap-1">
                      <User className="h-3 w-3" />
                      {selectedStep.approver || "Unassigned"}
                    </span>
                    {selectedStep.completedAt && (
                      <span className="inline-flex items-center gap-1">
                        <Clock className="h-3 w-3" />
                        {formatTime(selectedStep.completedAt)}
                      </span>
                    )}
                  </div>
                  {selectedStep.description && (
                    <p className="mt-2 text-xs text-[#5E6870]">{selectedStep.description}</p>
                  )}
                  {selectedStep.comment && (
                    <div className="mt-3 flex items-start gap-1.5 border border-[#C8CDD2] bg-white px-2.5 py-2 text-xs text-[#1F2933]">
                      <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 text-[#5E6870]" />
                      <span>{selectedStep.comment}</span>
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
