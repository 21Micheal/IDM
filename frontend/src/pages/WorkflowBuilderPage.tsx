import {
  useState, useCallback, useRef, useMemo, useEffect,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { workflowAPI, documentTypesAPI, groupsAPI, normalizeListResponse } from "@/services/api";
import {
  Plus, Trash2, Save, GitBranch, Loader2, X,
  Settings2, AlertCircle,
  Clock, CheckCircle2,
  Search, MoreVertical,
  FolderTree, LayoutTemplate, Check,
  User, UsersRound, Users,
  Edit3, Play, Flag,
  ZoomIn, ZoomOut, Maximize2, Move,
} from "lucide-react";
import { toast } from "react-toastify";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────
type AssigneeType = "group_any" | "group_all" | "group_specific";

interface WorkflowStep {
  id?: string;
  order: number;
  name: string;
  status_label: string;
  assignee_type: AssigneeType;
  assignee_group: string | null;
  assignee_group_name?: string;
  assignee_user: string | null;
  assignee_user_name?: string;
  sla_hours: number;
  allow_resubmit: boolean;
  allow_approve: boolean;
  allow_reject: boolean;
  allow_return: boolean;
  instructions: string;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  category?: string;
  is_active: boolean;
  steps: WorkflowStep[];
  step_count: number;
  created_by?: { id: string; full_name: string; email: string };
  created_at?: string;
  updated_at?: string;
}

interface DocumentType {
  id: string;
  name: string;
  code: string;
  reference_prefix: string;
  workflow_template: string | null;
  category?: string;
  is_active: boolean;
  description?: string;
}

interface WorkflowRule {
  id: string;
  document_type: string;
  document_type_name: string;
  template: string;
  template_name: string;
  amount_threshold: string;
  currency: string;
  label: string;
  is_active: boolean;
}

interface AppUser { id: string; full_name: string; email: string; job_description?: string; }
interface Group { id: string; name: string; description?: string; member_count?: number; }
interface GroupMembershipApiItem {
  user?: AppUser;
  id?: string;
  full_name?: string;
  email?: string;
  job_description?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const ASSIGNEE_MODES: { value: AssigneeType; label: string; description: string; Icon: typeof Users }[] = [
  { value: "group_any", label: "Any member", description: "Single approver from group", Icon: Users },
  { value: "group_all", label: "All members", description: "Consensus required", Icon: UsersRound },
  { value: "group_specific", label: "Specific member", description: "Designated approver", Icon: User },
];

const GROUP_COLORS = [
  "#3b82f6", "#10b981", "#8b5cf6", "#f59e0b",
  "#ef4444", "#06b6d4", "#6366f1", "#14b8a6"
];

const getGroupColor = (id: string | null | undefined) => {
  if (!id) return "#94a3b8";
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  return GROUP_COLORS[hash % GROUP_COLORS.length];
};

const CURRENCIES = ["USD", "EUR", "GBP", "KES", "ZAR", "NGN", "GHS", "AED", "INR", "JPY", "CAD", "AUD", "CHF", "CNY"];
const STATUS_PRESETS = [
  "Draft", "Pending Approval", "Pending Finance Review", "Pending Senior Review",
  "Pending Board Approval", "Pending Legal Review", "Awaiting Sign-off",
  "Under Review", "Conditional Approval", "Rejected", "Approved", "Archived",
];

function blankStep(): WorkflowStep {
  return {
    order: 0, name: "", status_label: "Pending Approval",
    assignee_type: "group_any", assignee_group: null, assignee_user: null,
    sla_hours: 48, allow_resubmit: true, allow_approve: true, allow_reject: true, allow_return: true, instructions: "",
  };
}

function stepToPayload(step: WorkflowStep): Partial<WorkflowStep> {
  const { assignee_user_name, assignee_group_name, ...rest } = step as any;
  // Ensure assignee_user is only sent for types that allow it
  if (rest.assignee_type !== "group_specific") {
    rest.assignee_user = null;
  }
  return rest;
}

function formatApiError(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = formatApiError(item);
      if (message) return message;
    }
    return null;
  }
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of ["detail", "non_field_errors", "steps", "name"]) {
      if (key in record) {
        const message = formatApiError(record[key]);
        if (message) return message;
      }
    }
    for (const nested of Object.values(record)) {
      const message = formatApiError(nested);
      if (message) return message;
    }
  }
  return null;
}

// ── Atoms ─────────────────────────────────────────────────────────────────────
const inp = "input";

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-xs font-medium text-foreground mb-1.5">
      {children}{required && <span className="text-destructive ml-0.5">*</span>}
    </label>
  );
}

// ── Step Edit Side Panel ──────────────────────────────────────────────────────
function StepEditPanel({
  step,
  index,
  total,
  groups,
  onChange,
  onClose,
  onDelete,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  groups: Group[];
  onChange: (patch: Partial<WorkflowStep>) => void;
  onClose: () => void;
  onDelete: () => void;
}) {
  const needsGroupMember = step.assignee_type === "group_specific";

  const { data: groupMembers = [], isLoading: membersLoading } = useQuery<AppUser[]>({
    queryKey: ["group-members", step.assignee_group],
    queryFn: async () => {
      const r = await groupsAPI.members(step.assignee_group!);
      const raw: GroupMembershipApiItem[] = r.data?.results ?? r.data ?? [];
      return raw.map((item) => item?.user ?? item).filter((u): u is AppUser => Boolean(u?.id && u?.email));
    },
    enabled: !!step.assignee_group && needsGroupMember,
  });

  const color = getGroupColor(step.assignee_group);

  return (
    <aside className="w-[420px] flex-shrink-0 flex flex-col bg-card border border-border rounded-xl shadow-elegant overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border bg-muted/40">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-sm font-bold shadow-sm"
            style={{ backgroundColor: color }}
          >
            {index + 1}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Edit step {index + 1}</h3>
            <p className="text-xs text-muted-foreground">Step {index + 1} of {total}</p>
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={onDelete}
            title="Delete step"
            className="p-2 rounded-lg text-muted-foreground hover:bg-destructive/10 hover:text-destructive transition-colors"
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button
            onClick={onClose}
            title="Close"
            className="p-2 rounded-lg text-muted-foreground hover:bg-muted transition-colors"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5 space-y-5">
        <div>
          <Label required>Step name</Label>
          <input
            value={step.name}
            onChange={e => onChange({ name: e.target.value })}
            className={inp}
            placeholder="e.g. Finance Manager Review"
          />
        </div>

        <div>
          <Label>Document status while pending</Label>
          <input
            list={`status-${index}`}
            value={step.status_label}
            onChange={e => onChange({ status_label: e.target.value })}
            className={inp}
            placeholder="Status label"
          />
          <datalist id={`status-${index}`}>
            {STATUS_PRESETS.map(p => <option key={p} value={p} />)}
          </datalist>
        </div>

        <div className="grid grid-cols-1 gap-4 p-4 rounded-lg bg-muted/40 border border-border">
          <div>
            <Label required>Approver group</Label>
            <select
              value={step.assignee_group ?? ""}
              onChange={e => {
                const id = e.target.value || null;
                const g = groups.find(x => x.id === id);
                onChange({
                  assignee_group: id,
                  assignee_group_name: g?.name,
                  assignee_user: null,
                  assignee_user_name: undefined,
                });
              }}
              className={inp}
            >
              <option value="">Select group</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
          </div>

          <div>
            <Label required>Assignment mode</Label>
            <select
              value={step.assignee_type}
              onChange={e => {
                const next = e.target.value as AssigneeType;
                onChange({
                  assignee_type: next,
                  assignee_user: next === "group_specific" ? step.assignee_user : null,
                  assignee_user_name: next === "group_specific" ? step.assignee_user_name : undefined,
                });
              }}
              className={inp}
            >
              {ASSIGNEE_MODES.map(m => (
                <option key={m.value} value={m.value}>{m.label} — {m.description}</option>
              ))}
            </select>
          </div>

          {needsGroupMember && (
            <div>
              <Label required>Specific member</Label>
              <select
                value={step.assignee_user ?? ""}
                onChange={e => {
                  const id = e.target.value || null;
                  const u = groupMembers.find(x => x.id === id);
                  onChange({ assignee_user: id, assignee_user_name: u?.full_name });
                }}
                disabled={!step.assignee_group || membersLoading}
                className={inp}
              >
                <option value="">{membersLoading ? "Loading members..." : "Select member"}</option>
                {groupMembers.map(u => (
                  <option key={u.id} value={u.id}>{u.full_name}</option>
                ))}
              </select>
              {!step.assignee_group && (
                <p className="text-[11px] text-muted-foreground mt-1">Pick a group first</p>
              )}
            </div>
          )}
        </div>

        <div>
          <Label>SLA (hours)</Label>
          <div className="flex items-center gap-3">
            <input
              type="range"
              min={1}
              max={168}
              value={step.sla_hours}
              onChange={e => onChange({ sla_hours: Number(e.target.value) })}
              className="flex-1 accent-primary"
            />
            <input
              type="number"
              min={1}
              max={720}
              value={step.sla_hours}
              onChange={e => onChange({ sla_hours: Math.max(1, Number(e.target.value)) })}
              className={clsx(inp, "w-20 text-center")}
            />
          </div>
          <p className="text-[11px] text-muted-foreground mt-1">
            ≈ {Math.floor(step.sla_hours / 24)}d {step.sla_hours % 24}h
          </p>
        </div>

        <div>
          <Label>Approver actions</Label>
          <div className="grid grid-cols-3 gap-2">
            <button
              type="button"
              onClick={() => onChange({ allow_approve: !step.allow_approve })}
              className={clsx(
                "px-3 py-2 rounded-lg text-xs font-medium transition-colors border",
                step.allow_approve
                  ? "bg-teal/15 text-teal border-teal/40"
                  : "bg-muted text-muted-foreground border-border"
              )}
            >
              ✓ Approve
            </button>
            <button
              type="button"
              onClick={() => onChange({ allow_reject: !step.allow_reject })}
              className={clsx(
                "px-3 py-2 rounded-lg text-xs font-medium transition-colors border",
                step.allow_reject
                  ? "bg-destructive/15 text-destructive border-destructive/40"
                  : "bg-muted text-muted-foreground border-border"
              )}
            >
              ✗ Reject
            </button>
            <button
              type="button"
              onClick={() => onChange({ allow_return: !step.allow_return })}
              className={clsx(
                "px-3 py-2 rounded-lg text-xs font-medium transition-colors border",
                step.allow_return
                  ? "bg-accent/20 text-accent-foreground border-accent/50"
                  : "bg-muted text-muted-foreground border-border"
              )}
            >
              ↩ Return
            </button>
          </div>
        </div>

        <div>
          <Label>Instructions for approver</Label>
          <textarea
            value={step.instructions}
            onChange={e => onChange({ instructions: e.target.value })}
            rows={4}
            className={clsx(inp, "resize-none")}
            placeholder="Guidelines for the approver..."
          />
        </div>
      </div>
    </aside>
  );
}

// ── Flowchart Editor (pan / zoom / drag) ─────────────────────────────────────
interface NodePos { x: number; y: number; }

const NODE_W = 260;
const NODE_H = 138;
const ANCHOR_W = 180;
const ANCHOR_H = 64;

function defaultPositions(stepCount: number): NodePos[] {
  const positions: NodePos[] = [];
  // start at (0,0); steps below
  for (let i = 0; i < stepCount; i++) {
    positions.push({ x: 0, y: (i + 1) * (NODE_H + 80) });
  }
  return positions;
}

function FlowchartEditor({
  steps,
  groups,
  selectedIndex,
  onSelectIndex,
  onStepsChange,
  onAddStep,
}: {
  steps: WorkflowStep[];
  groups: Group[];
  selectedIndex: number | null;
  onSelectIndex: (i: number | null) => void;
  onStepsChange: (steps: WorkflowStep[]) => void;
  onAddStep: () => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Pan / zoom transform
  const [transform, setTransform] = useState({ x: 80, y: 40, k: 1 });
  // Per-step node positions, keyed by index
  const [positions, setPositions] = useState<NodePos[]>(() => defaultPositions(steps.length));

  // Keep positions array in sync with step count (preserves existing layout)
  useEffect(() => {
    setPositions(prev => {
      if (prev.length === steps.length) return prev;
      if (steps.length > prev.length) {
        const next = [...prev];
        for (let i = prev.length; i < steps.length; i++) {
          const last = next[next.length - 1];
          next.push(last
            ? { x: last.x, y: last.y + NODE_H + 80 }
            : { x: 0, y: NODE_H + 80 });
        }
        return next;
      }
      return prev.slice(0, steps.length);
    });
  }, [steps.length]);

  // Drag state for nodes
  const dragRef = useRef<{ kind: "node" | "pan" | null; index?: number; startX: number; startY: number; orig: NodePos | { x: number; y: number } }>({
    kind: null, startX: 0, startY: 0, orig: { x: 0, y: 0 },
  });

  const onPointerDownNode = (i: number, e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      kind: "node",
      index: i,
      startX: e.clientX,
      startY: e.clientY,
      orig: { ...positions[i] },
    };
  };

  const onPointerDownCanvas = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    onSelectIndex(null);
    dragRef.current = {
      kind: "pan",
      startX: e.clientX,
      startY: e.clientY,
      orig: { x: transform.x, y: transform.y },
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d.kind) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (d.kind === "node" && d.index !== undefined) {
      const next = [...positions];
      next[d.index] = {
        x: (d.orig as NodePos).x + dx / transform.k,
        y: (d.orig as NodePos).y + dy / transform.k,
      };
      setPositions(next);
    } else if (d.kind === "pan") {
      setTransform(t => ({ ...t, x: (d.orig as NodePos).x + dx, y: (d.orig as NodePos).y + dy }));
    }
  };

  const onPointerUp = () => {
    dragRef.current = { kind: null, startX: 0, startY: 0, orig: { x: 0, y: 0 } };
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const rect = wrapperRef.current?.getBoundingClientRect();
    if (!rect) return;
    const mx = e.clientX - rect.left;
    const my = e.clientY - rect.top;
    const delta = -e.deltaY * 0.0015;
    setTransform(t => {
      const newK = Math.min(2, Math.max(0.4, t.k * (1 + delta)));
      const ratio = newK / t.k;
      return {
        k: newK,
        x: mx - (mx - t.x) * ratio,
        y: my - (my - t.y) * ratio,
      };
    });
  };

  const zoomBy = (factor: number) => {
    setTransform(t => {
      const newK = Math.min(2, Math.max(0.4, t.k * factor));
      return { ...t, k: newK };
    });
  };

  const fitView = () => {
    if (!wrapperRef.current || steps.length === 0) {
      setTransform({ x: 80, y: 40, k: 1 });
      return;
    }
    const rect = wrapperRef.current.getBoundingClientRect();
    const xs = positions.map(p => p.x);
    const ys = positions.map(p => p.y);
    const minX = Math.min(0, ...xs) - NODE_W / 2 - 40;
    const maxX = Math.max(0, ...xs) + NODE_W / 2 + 40;
    const minY = -ANCHOR_H - 40;
    const maxY = Math.max(...ys, 0) + NODE_H + ANCHOR_H + 40;
    const w = maxX - minX;
    const h = maxY - minY;
    const k = Math.min(rect.width / w, rect.height / h, 1.2);
    setTransform({
      x: rect.width / 2 - ((minX + maxX) / 2) * k,
      y: rect.height / 2 - ((minY + maxY) / 2) * k,
      k,
    });
  };

  // Compute connection lines (straight orthogonal-ish curve)
  const connections = useMemo(() => {
    const lines: { id: string; d: string }[] = [];
    // Anchors
    const startCenter = { x: 0, y: 0 };
    const startBottom = { x: startCenter.x, y: startCenter.y + ANCHOR_H / 2 };

    const stepTop = (p: NodePos) => ({ x: p.x, y: p.y - NODE_H / 2 });
    const stepBottom = (p: NodePos) => ({ x: p.x, y: p.y + NODE_H / 2 });

    if (steps.length > 0) {
      const t = stepTop(positions[0]);
      lines.push({ id: "start", d: bezierPath(startBottom, t) });
      for (let i = 0; i < steps.length - 1; i++) {
        lines.push({
          id: `s-${i}`,
          d: bezierPath(stepBottom(positions[i]), stepTop(positions[i + 1])),
        });
      }
      const last = positions[positions.length - 1];
      const lastY = positions.reduce((m, p) => Math.max(m, p.y), 0);
      const endTop = { x: last.x, y: lastY + NODE_H + 80 };
      lines.push({ id: "end", d: bezierPath(stepBottom(last), { x: endTop.x, y: endTop.y - ANCHOR_H / 2 }) });
    }
    return lines;
  }, [positions, steps.length]);

  // Compute SVG viewbox-ish bounds for the inner content
  const bounds = useMemo(() => {
    const xs = positions.map(p => p.x);
    const ys = positions.map(p => p.y);
    const minX = Math.min(-ANCHOR_W, ...xs.map(x => x - NODE_W / 2)) - 200;
    const maxX = Math.max(ANCHOR_W, ...xs.map(x => x + NODE_W / 2)) + 200;
    const minY = -ANCHOR_H - 200;
    const lastY = positions.reduce((m, p) => Math.max(m, p.y), 0);
    const maxY = lastY + NODE_H + ANCHOR_H + 200;
    return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
  }, [positions]);

  const lastY = positions.reduce((m, p) => Math.max(m, p.y), 0);
  const endX = positions.length ? positions[positions.length - 1].x : 0;
  const endY = positions.length ? lastY + NODE_H + 80 : NODE_H + 80;

  return (
    <div className="relative flex-1 overflow-hidden bg-muted/30 rounded-xl border border-border">
      {/* Toolbar */}
      <div className="absolute top-3 right-3 z-10 flex items-center gap-1 bg-card border border-border rounded-lg shadow-sm p-1">
        <button onClick={() => zoomBy(1.2)} title="Zoom in" className="p-1.5 rounded hover:bg-muted">
          <ZoomIn className="w-4 h-4 text-muted-foreground" />
        </button>
        <button onClick={() => zoomBy(0.83)} title="Zoom out" className="p-1.5 rounded hover:bg-muted">
          <ZoomOut className="w-4 h-4 text-muted-foreground" />
        </button>
        <span className="px-2 text-xs text-muted-foreground tabular-nums w-12 text-center">
          {Math.round(transform.k * 100)}%
        </span>
        <button onClick={fitView} title="Fit to view" className="p-1.5 rounded hover:bg-muted">
          <Maximize2 className="w-4 h-4 text-muted-foreground" />
        </button>
      </div>

      <div className="absolute top-3 left-3 z-10 flex items-center gap-2 bg-card border border-border rounded-lg shadow-sm px-3 py-1.5">
        <Move className="w-3.5 h-3.5 text-muted-foreground" />
        <span className="text-[11px] text-muted-foreground">Drag canvas to pan • Drag nodes to rearrange • ⌘/Ctrl + scroll to zoom</span>
      </div>

      <div
        ref={wrapperRef}
        className="absolute inset-0 cursor-grab active:cursor-grabbing select-none"
        style={{
          backgroundImage:
            "radial-gradient(hsl(var(--border)) 1px, transparent 1px)",
          backgroundSize: `${24 * transform.k}px ${24 * transform.k}px`,
          backgroundPosition: `${transform.x}px ${transform.y}px`,
        }}
        onPointerDown={onPointerDownCanvas}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
        onWheel={onWheel}
      >
        <div
          className="absolute top-0 left-0"
          style={{
            transform: `translate(${transform.x}px, ${transform.y}px) scale(${transform.k})`,
            transformOrigin: "0 0",
          }}
        >
          {/* SVG layer (sized to bounds) */}
          <svg
            style={{
              position: "absolute",
              left: bounds.minX,
              top: bounds.minY,
              width: bounds.w,
              height: bounds.h,
              pointerEvents: "none",
              overflow: "visible",
            }}
          >
            <defs>
              <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="hsl(var(--muted-foreground))" />
              </marker>
            </defs>
            <g transform={`translate(${-bounds.minX} ${-bounds.minY})`}>
              {connections.map(c => (
                <path
                  key={c.id}
                  d={c.d}
                  fill="none"
                  stroke="hsl(var(--muted-foreground))"
                  strokeWidth={1.8}
                  strokeOpacity={0.7}
                  markerEnd="url(#wf-arrow)"
                />
              ))}
            </g>
          </svg>

          {/* Start anchor */}
          <div
            className="absolute"
            style={{
              left: -ANCHOR_W / 2,
              top: -ANCHOR_H / 2,
              width: ANCHOR_W,
              height: ANCHOR_H,
            }}
          >
            <div className="w-full h-full bg-card border-2 border-teal/50 rounded-2xl flex items-center gap-2 px-4 shadow-sm">
              <div className="w-8 h-8 rounded-lg bg-teal/15 flex items-center justify-center">
                <Play className="w-4 h-4 text-teal" />
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">Start</p>
                <p className="text-xs font-semibold text-foreground">Submitted</p>
              </div>
            </div>
          </div>

          {/* Step nodes */}
          {steps.map((step, i) => {
            const pos = positions[i] ?? { x: 0, y: (i + 1) * (NODE_H + 80) };
            const color = getGroupColor(step.assignee_group);
            const mode = ASSIGNEE_MODES.find(m => m.value === step.assignee_type);
            const isSelected = selectedIndex === i;
            const ModeIcon = mode?.Icon ?? Users;
            return (
              <div
                key={step.id || `n-${i}`}
                className={clsx(
                  "absolute group",
                  isSelected && "z-20"
                )}
                style={{
                  left: pos.x - NODE_W / 2,
                  top: pos.y - NODE_H / 2,
                  width: NODE_W,
                  height: NODE_H,
                }}
                onPointerDown={(e) => onPointerDownNode(i, e)}
                onClick={(e) => { e.stopPropagation(); onSelectIndex(i); }}
              >
                <div
                  className={clsx(
                    "w-full h-full rounded-2xl bg-card border-2 p-3 cursor-grab active:cursor-grabbing transition-all",
                    isSelected
                      ? "border-accent shadow-elegant ring-4 ring-accent/15"
                      : "border-border shadow-sm hover:shadow-md hover:border-foreground/20"
                  )}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold"
                        style={{ backgroundColor: color }}
                      >
                        {i + 1}
                      </div>
                      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                        Step {i + 1}
                      </span>
                    </div>
                    <Edit3 className="w-3.5 h-3.5 text-muted-foreground opacity-0 group-hover:opacity-100" />
                  </div>

                  <p className={clsx(
                    "text-sm font-semibold truncate mb-2",
                    step.name ? "text-foreground" : "text-muted-foreground italic"
                  )}>
                    {step.name || "Click to configure"}
                  </p>

                  <div className="flex items-center gap-1.5 mb-2">
                    <div
                      className="w-5 h-5 rounded flex items-center justify-center"
                      style={{ backgroundColor: `${color}22` }}
                    >
                      <ModeIcon className="w-3 h-3" style={{ color }} />
                    </div>
                    <p className="text-[11px] text-muted-foreground truncate flex-1">
                      {step.assignee_group_name || "No group"}
                      {step.assignee_user_name && ` · ${step.assignee_user_name}`}
                    </p>
                  </div>

                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1">
                      <Clock className="w-3 h-3 text-muted-foreground" />
                      <span className="text-[10px] text-muted-foreground">
                        {step.sla_hours < 24 ? `${step.sla_hours}h` : `${Math.floor(step.sla_hours / 24)}d`}
                      </span>
                    </div>
                    <div className="flex items-center gap-1">
                      {step.allow_approve && <span className="w-1.5 h-1.5 rounded-full bg-teal" title="Approve" />}
                      {step.allow_reject && <span className="w-1.5 h-1.5 rounded-full bg-destructive" title="Reject" />}
                      {step.allow_return && <span className="w-1.5 h-1.5 rounded-full bg-accent" title="Return" />}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}

          {/* End anchor */}
          <div
            className="absolute"
            style={{
              left: endX - ANCHOR_W / 2,
              top: endY - ANCHOR_H / 2,
              width: ANCHOR_W,
              height: ANCHOR_H,
            }}
          >
            <div className="w-full h-full bg-card border-2 border-primary/40 rounded-2xl flex items-center gap-2 px-4 shadow-sm">
              <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center">
                <Flag className="w-4 h-4 text-primary" />
              </div>
              <div>
                <p className="text-[10px] font-semibold text-muted-foreground uppercase tracking-wider">End</p>
                <p className="text-xs font-semibold text-foreground">Approved</p>
              </div>
            </div>
          </div>

          {/* Add-step floating button — placed near end */}
          <div
            className="absolute"
            style={{
              left: endX + ANCHOR_W / 2 + 20,
              top: endY - 18,
            }}
          >
            <button
              onClick={(e) => { e.stopPropagation(); onAddStep(); }}
              className="flex items-center gap-2 px-3 py-2 bg-card border-2 border-dashed border-border rounded-xl text-xs font-medium text-muted-foreground hover:border-accent hover:text-accent-foreground hover:bg-accent/10 transition-all shadow-sm"
            >
              <Plus className="w-3.5 h-3.5" /> Add step
            </button>
          </div>

          {/* Empty state */}
          {steps.length === 0 && (
            <div
              className="absolute"
              style={{ left: -120, top: NODE_H }}
            >
              <button
                onClick={(e) => { e.stopPropagation(); onAddStep(); }}
                className="flex flex-col items-center gap-3 px-8 py-6 bg-card border-2 border-dashed border-border rounded-2xl hover:border-accent hover:bg-accent/5 transition-all group"
              >
                <div className="w-12 h-12 rounded-xl bg-muted flex items-center justify-center group-hover:bg-accent/15">
                  <Plus className="w-6 h-6 text-muted-foreground group-hover:text-accent" />
                </div>
                <div className="text-center">
                  <p className="text-sm font-medium text-foreground">Add first approval step</p>
                  <p className="text-xs text-muted-foreground mt-1">Click to start building your workflow</p>
                </div>
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// Cubic bezier between two points (mostly vertical or horizontal flow).
function bezierPath(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dy = b.y - a.y;
  const dx = b.x - a.x;
  // Vertical-ish flow: control points pulled vertically
  if (Math.abs(dy) >= Math.abs(dx)) {
    const cy = Math.max(40, Math.abs(dy) * 0.4);
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + cy}, ${b.x} ${b.y - cy}, ${b.x} ${b.y}`;
  }
  const cx = Math.max(40, Math.abs(dx) * 0.4);
  return `M ${a.x} ${a.y} C ${a.x + cx} ${a.y}, ${b.x - cx} ${b.y}, ${b.x} ${b.y}`;
}

// ── Routing Rules Panel ───────────────────────────────────────────────────────
function RoutingRulesPanel({ templateId, docTypes }: {
  templateId: string;
  docTypes: DocumentType[];
}) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    document_type: "",
    amount_threshold: "0",
    currency: "USD",
    label: "",
  });

  const { data: rules, isLoading } = useQuery<WorkflowRule[]>({
    queryKey: ["workflow-rules", templateId],
    queryFn: () => workflowAPI.listRules({ template: templateId }).then(r => r.data.results ?? r.data),
  });

  const createRule = useMutation({
    mutationFn: () => workflowAPI.createRule({
      ...form,
      template: templateId,
      // ensure numeric threshold sent
      amount_threshold: form.amount_threshold || "0",
    }),
    onSuccess: () => {
      toast.success("Routing rule created");
      qc.invalidateQueries({ queryKey: ["workflow-rules", templateId] });
      setShowAdd(false);
      setForm({ document_type: "", amount_threshold: "0", currency: "USD", label: "" });
    },
    onError: (err: any) => {
      const message = formatApiError(err?.response?.data) || "Failed to create rule";
      toast.error(message);
    },
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => workflowAPI.deleteRule(id),
    onSuccess: () => {
      toast.success("Rule removed");
      qc.invalidateQueries({ queryKey: ["workflow-rules", templateId] });
    },
    onError: () => toast.error("Failed to remove rule"),
  });

  const sortedRules = useMemo(
    () => [...(rules ?? [])].sort((a, b) => Number(a.amount_threshold) - Number(b.amount_threshold)),
    [rules]
  );

  // Group rules by document type for clearer reading
  const grouped = useMemo(() => {
    const map = new Map<string, { name: string; rules: WorkflowRule[] }>();
    for (const rule of sortedRules) {
      const key = rule.document_type;
      if (!map.has(key)) map.set(key, { name: rule.document_type_name, rules: [] });
      map.get(key)!.rules.push(rule);
    }
    return Array.from(map.entries());
  }, [sortedRules]);

  // All active doc types are eligible — routing rules can override the
  // primary template assignment for amount thresholds.
  const eligibleDocTypes = docTypes.filter(dt => dt.is_active);

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h3 className="font-semibold text-foreground text-base flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-muted-foreground" />
            Amount-based routing rules
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            When a document is submitted, the highest matching threshold wins.
            Use <span className="font-mono">0</span> for a catch-all (default) rule.
          </p>
        </div>
        {!showAdd && (
          <button onClick={() => setShowAdd(true)} className="btn-primary text-xs px-3 py-1.5">
            <Plus className="w-3.5 h-3.5" /> Add rule
          </button>
        )}
      </div>

      {showAdd && (
        <div className="rounded-xl border-2 border-accent/40 bg-accent/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground">New routing rule</h4>
            <button onClick={() => setShowAdd(false)} className="p-1 rounded hover:bg-muted">
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label required>Document type</Label>
              <select
                value={form.document_type}
                onChange={e => setForm(f => ({ ...f, document_type: e.target.value }))}
                className={inp}
              >
                <option value="">Select document type</option>
                {eligibleDocTypes.map(dt => (
                  <option key={dt.id} value={dt.id}>
                    {dt.name}{dt.workflow_template === templateId ? " (primary)" : ""}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-muted-foreground mt-1">
                Routing rules take precedence over the primary template when their threshold matches.
              </p>
            </div>
            <div>
              <Label required>Minimum amount</Label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.amount_threshold}
                onChange={e => setForm(f => ({ ...f, amount_threshold: e.target.value }))}
                className={inp}
                placeholder="0"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {Number(form.amount_threshold) === 0 ? "Catch-all (default)" : `Triggers at ≥ ${Number(form.amount_threshold).toLocaleString()} ${form.currency}`}
              </p>
            </div>
            <div>
              <Label>Currency</Label>
              <select
                value={form.currency}
                onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}
                className={inp}
              >
                {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <Label>Label (optional)</Label>
              <input
                value={form.label}
                onChange={e => setForm(f => ({ ...f, label: e.target.value }))}
                className={inp}
                placeholder="e.g., High-value transactions"
              />
            </div>
          </div>
          <div className="flex gap-2 pt-2">
            <button
              onClick={() => createRule.mutate()}
              disabled={!form.document_type || createRule.isPending}
              className="btn-primary text-xs"
            >
              {createRule.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Create rule
            </button>
            <button onClick={() => setShowAdd(false)} className="btn-secondary text-xs">
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="space-y-2">
          {[1, 2].map(i => <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />)}
        </div>
      )}

      {!isLoading && grouped.length === 0 && !showAdd && (
        <div className="text-center py-12 bg-muted/40 rounded-xl border border-dashed border-border">
          <Settings2 className="w-12 h-12 mx-auto mb-3 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground">No routing rules yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            Add rules to route documents of a given type to this template once they cross an amount threshold.
          </p>
          <button onClick={() => setShowAdd(true)} className="btn-secondary text-xs mt-4">
            <Plus className="w-3.5 h-3.5" /> Add your first rule
          </button>
        </div>
      )}

      {grouped.length > 0 && (
        <div className="space-y-4">
          {grouped.map(([docTypeId, { name, rules: docRules }]) => (
            <div key={docTypeId} className="rounded-xl border border-border bg-card overflow-hidden">
              <div className="flex items-center justify-between px-4 py-2.5 bg-muted/40 border-b border-border">
                <div className="flex items-center gap-2">
                  <FolderTree className="w-3.5 h-3.5 text-muted-foreground" />
                  <p className="text-sm font-semibold text-foreground">{name}</p>
                </div>
                <span className="text-[11px] text-muted-foreground">
                  {docRules.length} rule{docRules.length !== 1 ? "s" : ""}
                </span>
              </div>
              <div className="divide-y divide-border">
                {docRules.map((rule, idx) => {
                  const threshold = Number(rule.amount_threshold);
                  const isCatchAll = threshold === 0;
                  return (
                    <div key={rule.id} className="flex items-center gap-3 px-4 py-3 group hover:bg-muted/30">
                      <div className={clsx(
                        "w-7 h-7 rounded-full flex items-center justify-center text-[11px] font-bold shrink-0",
                        isCatchAll ? "bg-muted text-muted-foreground" : "bg-accent/20 text-accent-foreground"
                      )}>
                        {idx + 1}
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium text-foreground">
                            {isCatchAll
                              ? "Default (catch-all)"
                              : `≥ ${threshold.toLocaleString()} ${rule.currency}`}
                          </p>
                          {rule.label && (
                            <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                              {rule.label}
                            </span>
                          )}
                        </div>
                      </div>
                      <button
                        onClick={() => deleteRule.mutate(rule.id)}
                        disabled={deleteRule.isPending}
                        title="Remove rule"
                        className="opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-destructive rounded-lg hover:bg-destructive/10 transition-colors"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ── Template Editor ───────────────────────────────────────────────────────────
function TemplateEditor({
  template,
  docType = null,
  onSaved,
  allTemplates,
  docTypes,
}: {
  template: WorkflowTemplate | null;
  docType?: DocumentType | null;
  onSaved: (t: WorkflowTemplate, isNew: boolean) => void;
  allTemplates?: WorkflowTemplate[];
  docTypes?: DocumentType[];
}) {
  const qc = useQueryClient();
  const [name, setName] = useState(template?.name ?? (docType ? `${docType.name} Workflow` : "New Template"));
  const [description, setDescription] = useState(template?.description ?? "");
  const [steps, setSteps] = useState<WorkflowStep[]>(() =>
    template?.steps?.slice().sort((a, b) => a.order - b.order).map((s) => ({ ...s })) ?? []
  );
  const [isDirty, setIsDirty] = useState(!template);
  const [activeTab, setActiveTab] = useState<"flow" | "rules">("flow");

  const { data: groups } = useQuery<Group[]>({
    queryKey: ["groups-all"],
    queryFn: () => groupsAPI.list().then((r: any) => r.data.results ?? r.data),
  });

  const saveMutation = useMutation({
    mutationFn: (payload: { name: string; description: string; steps: Partial<WorkflowStep>[] }) =>
      template
        ? workflowAPI.updateTemplate(template.id, payload)
        : workflowAPI.createTemplate(payload),
    onSuccess: async ({ data }) => {
      toast.success(template ? "Template saved" : "Template created");
      setIsDirty(false);

      if (!template && docType) {
        try {
          await documentTypesAPI.update(docType.id, { workflow_template: data.id });
          toast.success(`Template assigned to ${docType.name}`);
        } catch {
          toast.warning("Template created but could not link to document type");
        }
      }

      qc.invalidateQueries({ queryKey: ["workflow-templates"] });
      qc.invalidateQueries({ queryKey: ["document-types"] });
      onSaved(data, !template);
    },
    onError: (err: any) => {
      const message = formatApiError(err?.response?.data) || "Save failed";
      toast.error(message);
    },
  });

  const handleStepsChange = useCallback((newSteps: WorkflowStep[]) => {
    setSteps(newSteps.map((s, i) => ({ ...s, order: i + 1 })));
    setIsDirty(true);
  }, []);

  const handleSave = () => {
    if (!name.trim()) { toast.error("Template name is required"); return; }
    if (steps.length === 0) { toast.error("Add at least one approval step"); return; }
    for (const s of steps) {
      if (!s.name.trim()) { toast.error(`Step ${s.order} needs a name`); return; }
      if (!s.assignee_group) { toast.error(`"${s.name}" needs a group`); return; }
      if (s.assignee_type === "group_specific" && !s.assignee_user) {
        toast.error(`"${s.name}" needs a specific group member`); return;
      }
      if (!s.allow_approve && !s.allow_reject && !s.allow_return) {
        toast.error(`"${s.name}" must have at least one approver action enabled`); return;
      }
    }

    saveMutation.mutate({
      name: name.trim(),
      description: description.trim(),
      is_active: template ? template.is_active : true,
      steps: steps.map(stepToPayload),
    });
  };

  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);

  const handleAddStep = useCallback(() => {
    const newStep = { ...blankStep(), order: steps.length + 1 };
    const next = [...steps, newStep];
    setSteps(next);
    setIsDirty(true);
    setSelectedStepIndex(next.length - 1);
  }, [steps]);

  const handleDeleteStep = useCallback((index: number) => {
    const next = steps.filter((_, i) => i !== index).map((s, i) => ({ ...s, order: i + 1 }));
    setSteps(next);
    setIsDirty(true);
    setSelectedStepIndex(null);
  }, [steps]);

  const handlePatchStep = useCallback((index: number, patch: Partial<WorkflowStep>) => {
    const next = [...steps];
    next[index] = { ...next[index], ...patch };
    setSteps(next);
    setIsDirty(true);
  }, [steps]);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0 gap-4">
        <div className="flex-1 min-w-0">
          <input
            value={name}
            onChange={e => { setName(e.target.value); setIsDirty(true); }}
            className="text-lg font-bold text-foreground bg-transparent border-0 outline-none w-full p-0 focus:ring-0"
            placeholder="Template name..."
          />
          <input
            value={description}
            onChange={e => { setDescription(e.target.value); setIsDirty(true); }}
            className="text-sm text-muted-foreground bg-transparent border-0 outline-none w-full p-0 mt-1 focus:ring-0"
            placeholder="Description (optional)"
          />
          {docType && (
            <span className="inline-flex items-center gap-1 mt-2 text-xs font-medium text-accent-foreground bg-accent/20 px-2 py-1 rounded-md">
              {docType.name}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {template && (
            <div className="flex bg-muted rounded-lg p-1">
              <button
                onClick={() => setActiveTab("flow")}
                className={clsx(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                  activeTab === "flow" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Workflow
              </button>
              <button
                onClick={() => setActiveTab("rules")}
                className={clsx(
                  "px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                  activeTab === "rules" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                Routing rules
              </button>
            </div>
          )}
          {isDirty && (
            <span className="text-[11px] text-accent-foreground bg-accent/20 px-2 py-1 rounded-md">Unsaved</span>
          )}
          <button onClick={handleSave} disabled={saveMutation.isPending} className="btn-primary text-sm">
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save
          </button>
        </div>
      </div>

      {/* Content */}
      {activeTab === "flow" || !template ? (
        <div className="flex-1 min-h-0 flex gap-4">
          <FlowchartEditor
            steps={steps}
            groups={groups ?? []}
            selectedIndex={selectedStepIndex}
            onSelectIndex={setSelectedStepIndex}
            onStepsChange={handleStepsChange}
            onAddStep={handleAddStep}
          />
          {selectedStepIndex !== null && steps[selectedStepIndex] && (
            <StepEditPanel
              step={steps[selectedStepIndex]}
              index={selectedStepIndex}
              total={steps.length}
              groups={groups ?? []}
              onChange={(patch) => handlePatchStep(selectedStepIndex, patch)}
              onClose={() => setSelectedStepIndex(null)}
              onDelete={() => handleDeleteStep(selectedStepIndex)}
            />
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0">
          {template && docTypes && (
            <RoutingRulesPanel templateId={template.id} docTypes={docTypes} />
          )}
        </div>
      )}
    </div>
  );
}

// ── Document Type Detail Modal ────────────────────────────────────────────────
function DocTypeDetailModal({
  docType, onClose, onAssignTemplate, onCreateTemplate, templates, isLoading,
}: {
  docType: DocumentType;
  onClose: () => void;
  onAssignTemplate: (templateId: string) => void;
  onCreateTemplate: () => void;
  templates?: WorkflowTemplate[];
  isLoading?: boolean;
}) {
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>(docType.workflow_template || "");
  const activeTemplates = templates?.filter(t => t.is_active) ?? [];
  const currentPrimaryTemplate = activeTemplates.find(t => t.id === docType.workflow_template);

  const handleAssign = () => {
    if (selectedTemplateId && selectedTemplateId !== docType.workflow_template) {
      onAssignTemplate(selectedTemplateId);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-card rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b">
          <div>
            <h2 className="text-lg font-bold text-foreground">{docType.name}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Code: {docType.code} · Prefix: {docType.reference_prefix}</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg">
            <X className="w-5 h-5 text-muted-foreground" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto">
          <div className={clsx(
            "mb-6 p-4 rounded-xl border",
            docType.workflow_template ? "bg-teal/10 border-teal/30" : "bg-accent/10 border-accent/30"
          )}>
            <div className="flex items-start gap-3">
              {docType.workflow_template ? (
                <CheckCircle2 className="w-5 h-5 text-teal mt-0.5" />
              ) : (
                <AlertCircle className="w-5 h-5 text-accent-foreground mt-0.5" />
              )}
              <div>
                <p className="text-sm font-medium text-foreground">
                  {docType.workflow_template ? "Primary Template Assigned" : "No Primary Template"}
                </p>
                {currentPrimaryTemplate && (
                  <p className="text-xs text-muted-foreground mt-1">{currentPrimaryTemplate.name}</p>
                )}
              </div>
            </div>
          </div>

          <div className="mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-foreground">Available Templates</h3>
              <button onClick={onCreateTemplate} className="text-xs font-medium text-accent-foreground hover:text-accent-foreground">
                + Create New
              </button>
            </div>

            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => <div key={i} className="h-20 bg-muted rounded-xl animate-pulse" />)}
              </div>
            ) : activeTemplates.length > 0 ? (
              <div className="space-y-2 max-h-[40vh] overflow-y-auto">
                {activeTemplates.map(template => {
                  const isCurrentPrimary = template.id === docType.workflow_template;
                  const isSelected = selectedTemplateId === template.id;
                  return (
                    <div
                      key={template.id}
                      onClick={() => setSelectedTemplateId(template.id)}
                      className={clsx(
                        "p-4 rounded-xl border-2 cursor-pointer transition-all",
                        isSelected ? "border-accent/50 bg-accent/10" : "border-border hover:border-foreground/20",
                        isCurrentPrimary && !isSelected && "border-teal/50 bg-teal/10"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-sm text-foreground">{template.name}</p>
                          {template.description && (
                            <p className="text-xs text-muted-foreground mt-0.5">{template.description}</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2">
                          {isCurrentPrimary && (
                            <span className="text-xs text-teal bg-teal/15 px-2 py-0.5 rounded-full">Primary</span>
                          )}
                          {isSelected && (
                            <div className="w-5 h-5 rounded-full bg-accent flex items-center justify-center">
                              <Check className="w-3 h-3 text-white" />
                            </div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-12 bg-muted/40 rounded-xl">
                <LayoutTemplate className="w-12 h-12 mx-auto mb-3 text-muted-foreground/60" />
                <p className="text-sm text-muted-foreground">No templates available</p>
                <button onClick={onCreateTemplate} className="mt-3 text-sm text-accent-foreground hover:underline">
                  + Create your first template
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-3 p-5 border-t bg-muted/40">
          <button
            onClick={handleAssign}
            disabled={!selectedTemplateId || selectedTemplateId === docType.workflow_template}
            className={clsx(
              "flex-1 px-4 py-2.5 rounded-xl font-medium transition-colors",
              !selectedTemplateId || selectedTemplateId === docType.workflow_template
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-primary text-white hover:bg-primary/90"
            )}
          >
            Set as Primary Template
          </button>
          <button onClick={onClose} className="btn-secondary">
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────
export default function WorkflowBuilderPage() {
  const qc = useQueryClient();
  const [selectedDocType, setSelectedDocType] = useState<DocumentType | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<"doctypes" | "templates">("doctypes");
  const [search, setSearch] = useState("");
  const [showDetailModal, setShowDetailModal] = useState<DocumentType | null>(null);
  const [creatingForDocType, setCreatingForDocType] = useState<DocumentType | null>(null);

  const { data: docTypes, isLoading: dtLoading } = useQuery<unknown, Error, DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<DocumentType>(data),
  });

  const { data: allTemplates, isLoading: templatesLoading } = useQuery<WorkflowTemplate[]>({
    queryKey: ["workflow-templates"],
    queryFn: () => workflowAPI.listTemplates().then(r => r.data.results ?? r.data as WorkflowTemplate[]),
  });

  const effectiveTemplateId = editingTemplateId || selectedDocType?.workflow_template || null;

  const {
    data: fetchedTemplate,
    isFetching: templateFetching,
    isLoading: templateLoading,
  } = useQuery<WorkflowTemplate | null>({
    queryKey: ["workflow-template", effectiveTemplateId],
    queryFn: async () => {
      if (!effectiveTemplateId) return null;
      const response = await workflowAPI.getTemplate(effectiveTemplateId);
      return response.data;
    },
    enabled: !!effectiveTemplateId,
    staleTime: 1000 * 60 * 5,
  });

  const handleDocTypeClick = (dt: DocumentType) => {
    setSelectedDocType(dt);
    setEditingTemplateId(null);
    setCreatingForDocType(null);
  };

  const handleTemplateClick = (t: WorkflowTemplate) => {
    setEditingTemplateId(t.id);
    setSelectedDocType(null);
    setCreatingForDocType(null);
  };

  const handleAssignTemplate = useCallback(async (docTypeId: string, templateId: string) => {
    try {
      await documentTypesAPI.update(docTypeId, { workflow_template: templateId });
      toast.success("Primary template assigned");
      qc.invalidateQueries({ queryKey: ["document-types"] });
      setShowDetailModal(null);
      if (selectedDocType?.id === docTypeId) {
        setSelectedDocType(prev => prev ? { ...prev, workflow_template: templateId } : null);
      }
    } catch {
      toast.error("Failed to assign template");
    }
  }, [qc, selectedDocType]);

  const handleStartCreateForDocType = (docType: DocumentType | null) => {
    setCreatingForDocType(docType);
    setSelectedDocType(null);
    setEditingTemplateId(null);
    setShowDetailModal(null);
  };

  const handleSaved = (t: WorkflowTemplate, isNew: boolean) => {
    if (isNew && creatingForDocType) {
      documentTypesAPI.update(creatingForDocType.id, { workflow_template: t.id })
        .then(() => {
          toast.success(`Template "${t.name}" created and assigned`);
          qc.invalidateQueries({ queryKey: ["document-types"] });
          setCreatingForDocType(null);
          setSelectedDocType(null);
          setEditingTemplateId(null);
        })
        .catch(() => {
          toast.warning(`Template created but failed to assign`);
          setCreatingForDocType(null);
          setSelectedDocType(null);
          setEditingTemplateId(null);
        });
    } else if (isNew && !creatingForDocType) {
      setEditingTemplateId(t.id);
      toast.success(`Template "${t.name}" created`);
    } else {
      if (selectedDocType) {
        setSelectedDocType(prev => prev ? { ...prev, workflow_template: t.id } : null);
      }
      toast.success(`Template "${t.name}" saved`);
    }
    qc.invalidateQueries({ queryKey: ["document-types"] });
    qc.invalidateQueries({ queryKey: ["workflow-templates"] });
  };

  const docTypesArray = useMemo(() => Array.isArray(docTypes) ? docTypes : [], [docTypes]);
  const filteredDocTypes = useMemo(
    () => docTypesArray.filter(dt => dt.name.toLowerCase().includes(search.toLowerCase())),
    [docTypesArray, search]
  );
  const allTemplatesArray = useMemo(() => Array.isArray(allTemplates) ? allTemplates : [], [allTemplates]);
  const filteredTemplates = useMemo(
    () => allTemplatesArray.filter(t => t.name.toLowerCase().includes(search.toLowerCase())),
    [allTemplatesArray, search]
  );

  const withTemplate = docTypesArray.filter(d => d.workflow_template).length;
  const withoutTemplate = docTypesArray.length - withTemplate;

  const showEditor = selectedDocType || editingTemplateId || creatingForDocType;
  const currentTemplate = creatingForDocType ? null : (fetchedTemplate ?? null);
  const isLoadingTemplate =
    !creatingForDocType &&
    !!effectiveTemplateId &&
    (templateLoading || templateFetching || fetchedTemplate === undefined);

  const editorDocType = selectedDocType || creatingForDocType || null;

  return (
    <div className="flex gap-6 h-[calc(100vh-7rem)] bg-muted/40 p-6">
      {/* Left Sidebar */}
      <aside className="w-80 flex-shrink-0 flex flex-col bg-card rounded-2xl border border-border overflow-hidden">
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-lg font-bold text-foreground">
              {sidebarTab === "doctypes" ? "Document Types" : "Templates"}
            </h1>
            {sidebarTab === "templates" && (
              <button
                onClick={() => handleStartCreateForDocType(null)}
                className="flex items-center gap-1 px-3 py-1.5 text-xs font-medium bg-primary text-white rounded-lg hover:bg-primary/90"
              >
                <Plus className="w-3 h-3" /> New
              </button>
            )}
          </div>

          <div className="flex bg-muted p-1 rounded-lg mb-4">
            <button
              onClick={() => { setSidebarTab("doctypes"); setSearch(""); }}
              className={clsx(
                "flex-1 flex items-center justify-center gap-2 py-2 text-xs font-medium rounded-md transition-all",
                sidebarTab === "doctypes" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
              )}
            >
              <FolderTree className="w-3.5 h-3.5" /> Types
            </button>
            <button
              onClick={() => { setSidebarTab("templates"); setSearch(""); }}
              className={clsx(
                "flex-1 flex items-center justify-center gap-2 py-2 text-xs font-medium rounded-md transition-all",
                sidebarTab === "templates" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground"
              )}
            >
              <LayoutTemplate className="w-3.5 h-3.5" /> Templates
            </button>
          </div>

          {sidebarTab === "doctypes" && (
            <div className="flex rounded-lg overflow-hidden border border-border text-xs mb-4">
              <div className="flex-1 flex items-center gap-1.5 px-3 py-2 bg-teal/10 border-r border-border">
                <span className="w-1.5 h-1.5 rounded-full bg-teal" />
                <span className="text-teal font-medium">{withTemplate} ready</span>
              </div>
              <div className="flex-1 flex items-center gap-1.5 px-3 py-2 bg-accent/10">
                <span className="w-1.5 h-1.5 rounded-full bg-accent" />
                <span className="text-accent-foreground font-medium">{withoutTemplate} pending</span>
              </div>
            </div>
          )}

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={`Search ${sidebarTab === "doctypes" ? "document types" : "templates"}...`}
              className={clsx(inp, "pl-9")}
            />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-2 space-y-1">
          {sidebarTab === "doctypes" ? (
            filteredDocTypes.map(dt => {
              const hasTemplate = !!dt.workflow_template;
              const isSelected = selectedDocType?.id === dt.id;
              return (
                <div key={dt.id} className="relative group">
                  <button
                    onClick={() => handleDocTypeClick(dt)}
                    className={clsx(
                      "w-full text-left rounded-xl p-3 transition-all border",
                      isSelected ? "bg-accent/10 border-accent/40" : "bg-card border-border hover:border-foreground/20"
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className={clsx(
                        "w-2 h-2 rounded-full mt-1.5",
                        hasTemplate ? "bg-teal" : "bg-accent"
                      )} />
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm text-foreground truncate">{dt.name}</p>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">{dt.reference_prefix}-XXXXX</p>
                      </div>
                      {!hasTemplate && (
                        <span className="text-[10px] text-accent-foreground font-medium bg-accent/20 px-2 py-0.5 rounded-full">
                          Setup
                        </span>
                      )}
                    </div>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowDetailModal(dt); }}
                    className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1.5 bg-card border border-border rounded-lg hover:bg-muted/40"
                  >
                    <MoreVertical className="w-3.5 h-3.5 text-muted-foreground" />
                  </button>
                </div>
              );
            })
          ) : (
            filteredTemplates.map(t => {
              const isSelected = editingTemplateId === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => handleTemplateClick(t)}
                  className={clsx(
                    "w-full text-left rounded-xl p-3 transition-all border",
                    isSelected ? "bg-accent/10 border-accent/40" : "bg-card border-border hover:border-foreground/20"
                  )}
                >
                  <div className="flex items-start gap-2.5">
                    <LayoutTemplate className="w-5 h-5 text-muted-foreground mt-0.5" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-sm text-foreground truncate">{t.name}</p>
                      <p className="text-xs text-muted-foreground mt-0.5">{t.step_count} step{t.step_count !== 1 ? 's' : ''}</p>
                    </div>
                  </div>
                </button>
              );
            })
          )}
        </div>
      </aside>

      {/* Right Editor */}
      <main className="flex-1 bg-card rounded-2xl border border-border p-6 overflow-hidden flex flex-col">
        {!showEditor && (
          <div className="flex-1 flex flex-col items-center justify-center text-center">
            <div className="w-16 h-16 rounded-2xl bg-muted flex items-center justify-center mb-4">
              <GitBranch className="w-8 h-8 text-muted-foreground" />
            </div>
            <p className="text-lg font-semibold text-foreground">Select a document type or template</p>
            <p className="text-sm text-muted-foreground mt-1 max-w-sm">
              Configure approval workflows by selecting an item from the sidebar
            </p>
          </div>
        )}

        {showEditor && (
          <>
            {isLoadingTemplate ? (
              <div className="flex-1 flex items-center justify-center">
                <Loader2 className="w-8 h-8 text-accent animate-spin" />
              </div>
            ) : (
              <TemplateEditor
                key={creatingForDocType?.id || editingTemplateId || selectedDocType?.workflow_template || selectedDocType?.id || "new-template"}
                docType={editorDocType}
                template={currentTemplate}
                onSaved={handleSaved}
                allTemplates={allTemplatesArray}
                docTypes={docTypesArray}
              />
            )}
          </>
        )}
      </main>

      {showDetailModal && (
        <DocTypeDetailModal
          docType={showDetailModal}
          onClose={() => setShowDetailModal(null)}
          onAssignTemplate={(templateId) => handleAssignTemplate(showDetailModal.id, templateId)}
          onCreateTemplate={() => {
            setShowDetailModal(null);
            handleStartCreateForDocType(showDetailModal);
          }}
          templates={allTemplatesArray}
          isLoading={templatesLoading}
        />
      )}
    </div>
  );
}