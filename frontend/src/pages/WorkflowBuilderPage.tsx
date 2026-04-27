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
import { toast } from "@/components/ui/vault-toast";
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
  document_type: string | null;
  document_type_name?: string | null;
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
  template_document_type?: string | null;
  amount_min: string;
  amount_max: string | null;
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

const LEGACY_ASSIGNEE_TYPE_MAP: Record<string, AssigneeType> = {
  any_role: "group_any",
  group_member: "group_any",
  group_hod: "group_all",
  specific_user: "group_specific",
};

function isUuidLike(value: unknown): value is string {
  return typeof value === "string"
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function normalizeAssigneeType(value: unknown): AssigneeType {
  if (typeof value === "string" && value in LEGACY_ASSIGNEE_TYPE_MAP) {
    return LEGACY_ASSIGNEE_TYPE_MAP[value];
  }
  if (value === "group_any" || value === "group_all" || value === "group_specific") {
    return value;
  }
  return "group_any";
}

function normalizeStep(step: WorkflowStep): WorkflowStep {
  return {
    ...step,
    assignee_type: normalizeAssigneeType(step.assignee_type),
    assignee_group: isUuidLike(step.assignee_group) ? step.assignee_group : null,
    assignee_user: isUuidLike(step.assignee_user) ? step.assignee_user : null,
  };
}

function normalizeTemplate(template: WorkflowTemplate): WorkflowTemplate {
  return {
    ...template,
    document_type: isUuidLike(template.document_type) ? template.document_type : null,
    steps: (template.steps ?? []).map(normalizeStep),
  };
}

function resolveTemplateDocumentType(
  template: WorkflowTemplate,
  docTypes: DocumentType[],
): { id: string | null; name: string | null } {
  if (template.document_type) {
    const matched = docTypes.find((item) => item.id === template.document_type);
    return { id: template.document_type, name: matched?.name ?? template.document_type_name ?? null };
  }
  const inferred = docTypes.find((item) => item.workflow_template === template.id);
  if (inferred) return { id: inferred.id, name: inferred.name };
  return { id: null, name: template.document_type_name ?? null };
}

function attachResolvedTemplateDocumentType(
  template: WorkflowTemplate,
  docTypes: DocumentType[],
): WorkflowTemplate {
  const resolved = resolveTemplateDocumentType(template, docTypes);
  return {
    ...template,
    document_type: resolved.id,
    document_type_name: resolved.name,
  };
}

function formatMoney(value: number, currency: string) {
  return `${currency} ${value.toLocaleString(undefined, { minimumFractionDigits: 0, maximumFractionDigits: 2 })}`;
}

function formatRuleRange(rule: WorkflowRule) {
  const min = Number(rule.amount_min || 0);
  const max = rule.amount_max === null || rule.amount_max === "" ? null : Number(rule.amount_max);
  if (max === null) return `${formatMoney(min, rule.currency)} and above`;
  if (min === 0) return `Up to ${formatMoney(max, rule.currency)}`;
  return `${formatMoney(min, rule.currency)} to ${formatMoney(max, rule.currency)}`;
}

function blankStep(): WorkflowStep {
  return {
    order: 0, name: "", status_label: "Pending Approval",
    assignee_type: "group_any", assignee_group: null, assignee_user: null,
    sla_hours: 48, allow_resubmit: true, allow_approve: true, allow_reject: true, allow_return: true, instructions: "",
  };
}

function stepToPayload(step: WorkflowStep): Partial<WorkflowStep> {
  const { assignee_user_name, assignee_group_name, ...rest } = normalizeStep(step) as any;
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
    const validNodes = positions.slice(0, steps.length).filter(Boolean) as NodePos[];
    if (validNodes.length === 0) return;
    const xs = validNodes.map(p => p.x);
    const ys = validNodes.map(p => p.y);
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

    const stepTop = (p: NodePos) => ({ x: p?.x ?? 0, y: (p?.y ?? 0) - NODE_H / 2 });
    const stepBottom = (p: NodePos) => ({ x: p?.x ?? 0, y: (p?.y ?? 0) + NODE_H / 2 });

    if (steps.length > 0) {
      const p0 = positions[0];
      if (p0) {
        const t = stepTop(p0);
        lines.push({ id: "start", d: bezierPath(startBottom, t) });
      }

      for (let i = 0; i < steps.length - 1; i++) {
        const pA = positions[i];
        const pB = positions[i + 1];
        if (pA && pB) {
          lines.push({
            id: `s-${i}`,
            d: bezierPath(stepBottom(pA), stepTop(pB)),
          });
        }
      }

      const last = positions[steps.length - 1];
      if (last) {
        const currentValidY = positions.slice(0, steps.length).reduce((m, p) => (p ? Math.max(m, p.y) : m), 0);
        const endTop = { x: last.x, y: currentValidY + NODE_H + 80 };
        lines.push({ id: "end", d: bezierPath(stepBottom(last), { x: endTop.x, y: endTop.y - ANCHOR_H / 2 }) });
      }
    }
    return lines;
  }, [positions, steps.length]);

  // Compute SVG viewbox-ish bounds for the inner content
  const bounds = useMemo(() => {
    const validNodes = positions.slice(0, steps.length).filter(Boolean) as NodePos[];
    const xs = validNodes.map(p => p.x);
    const ys = validNodes.map(p => p.y);
    const minX = Math.min(-ANCHOR_W, ...xs.map(x => x - NODE_W / 2)) - 200;
    const maxX = Math.max(ANCHOR_W, ...xs.map(x => x + NODE_W / 2)) + 200;
    const minY = -ANCHOR_H - 200;
    const lastY_bound = validNodes.reduce((m, p) => Math.max(m, p.y), 0);
    const maxY = lastY_bound + NODE_H + ANCHOR_H + 200;
    return { minX, maxX, minY, maxY, w: maxX - minX, h: maxY - minY };
  }, [positions, steps.length]);

  const currentValidNodes = positions.slice(0, steps.length).filter(Boolean) as NodePos[];
  const lastY = currentValidNodes.reduce((m, p) => Math.max(m, p.y), 0);
  const lastNodeMain = steps.length > 0 ? positions[steps.length - 1] : null;
  const endX = lastNodeMain ? lastNodeMain.x : 0;
  const endY = lastNodeMain ? lastY + NODE_H + 80 : NODE_H + 80;

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
function RoutingRulesPanel({ template }: {
  template: WorkflowTemplate;
}) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({
    amount_min: "0",
    amount_max: "",
    currency: "USD",
    label: "",
  });
  const templateId = template.id;
  const hasDocumentType = Boolean(template.document_type);

  const { data: rules, isLoading } = useQuery<WorkflowRule[]>({
    queryKey: ["workflow-rules", templateId],
    queryFn: () => workflowAPI.listRules({ template: templateId }).then(r => r.data.results ?? r.data),
    enabled: hasDocumentType,
  });

  const createRule = useMutation({
    mutationFn: () => workflowAPI.createRule({
      ...form,
      template: templateId,
      amount_min: form.amount_min || "0",
      amount_max: form.amount_max || null,
    }),
    onSuccess: () => {
      toast.success("Routing rule created");
      qc.invalidateQueries({ queryKey: ["workflow-rules", templateId] });
      setShowAdd(false);
      setForm({ amount_min: "0", amount_max: "", currency: "USD", label: "" });
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
    () => [...(rules ?? [])].sort((a, b) => Number(a.amount_min) - Number(b.amount_min)),
    [rules]
  );

  const handleCreateRule = () => {
    if (!templateId) {
      toast.error("Save the template before adding routing rules");
      return;
    }
    if (!hasDocumentType) {
      toast.error("Assign a document type to this template before adding routing rules");
      return;
    }
    if (form.amount_min.trim() === "") {
      toast.error("Minimum amount is required");
      return;
    }
    createRule.mutate();
  };

  return (
    <div className="max-w-3xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4">
        <div className="flex-1">
          <h3 className="font-semibold text-foreground text-base flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-muted-foreground" />
            Amount-based routing rules
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Rules for this template are automatically scoped to <span className="font-medium text-foreground">{template.document_type_name ?? "its document type"}</span>.
            Add non-overlapping amount ranges to route matching documents here.
          </p>
        </div>
        {!showAdd && hasDocumentType && (
          <button onClick={() => setShowAdd(true)} className="btn-primary text-xs px-3 py-1.5">
            <Plus className="w-3.5 h-3.5" /> Add rule
          </button>
        )}
      </div>

      {!hasDocumentType && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">Assign a document type to this template first</p>
          <p className="text-xs text-amber-800/80 mt-1">
            Routing rules are linked to the template&apos;s document type, so this template needs a document type before ranges can be added.
          </p>
        </div>
      )}

      {showAdd && hasDocumentType && (
        <div className="rounded-xl border-2 border-accent/40 bg-accent/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground">New routing rule</h4>
            <button onClick={() => setShowAdd(false)} className="p-1 rounded hover:bg-muted">
              <X className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>
          <p className="text-xs text-muted-foreground">
            Applies to <span className="font-medium text-foreground">{template.document_type_name}</span> documents only.
          </p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label required>Minimum amount</Label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.amount_min}
                onChange={e => setForm(f => ({ ...f, amount_min: e.target.value }))}
                className={inp}
                placeholder="0"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                Starts matching from {formatMoney(Number(form.amount_min || 0), form.currency)}
              </p>
            </div>
            <div>
              <Label>Maximum amount</Label>
              <input
                type="number"
                min={0}
                step="0.01"
                value={form.amount_max}
                onChange={e => setForm(f => ({ ...f, amount_max: e.target.value }))}
                className={inp}
                placeholder="Leave blank for no upper limit"
              />
              <p className="text-[11px] text-muted-foreground mt-1">
                {form.amount_max
                  ? `Stops at ${formatMoney(Number(form.amount_max), form.currency)}`
                  : "Leave blank to cover everything above the minimum"}
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
              onClick={handleCreateRule}
              disabled={createRule.isPending}
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

      {!isLoading && hasDocumentType && sortedRules.length === 0 && !showAdd && (
        <div className="text-center py-12 bg-muted/40 rounded-xl border border-dashed border-border">
          <Settings2 className="w-12 h-12 mx-auto mb-3 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground">No routing rules yet</p>
          <p className="text-xs text-muted-foreground mt-1 max-w-md mx-auto">
            Add amount ranges to send matching {template.document_type_name?.toLowerCase() ?? "documents"} to this template.
          </p>
          <button onClick={() => setShowAdd(true)} className="btn-secondary text-xs mt-4">
            <Plus className="w-3.5 h-3.5" /> Add your first rule
          </button>
        </div>
      )}

      {sortedRules.length > 0 && (
        <div className="space-y-3">
          {sortedRules.map((rule, idx) => {
            return (
              <div key={rule.id} className="rounded-xl border border-border bg-card px-4 py-3 group hover:border-foreground/20 transition-colors">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-accent/15 text-accent-foreground flex items-center justify-center text-xs font-semibold shrink-0">
                    {idx + 1}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-foreground">{formatRuleRange(rule)}</p>
                      {rule.label && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                          {rule.label}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Matching {rule.document_type_name.toLowerCase()} documents will use this template.
                    </p>
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
              </div>
            );
          })}
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
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [selectedDocumentTypeId, setSelectedDocumentTypeId] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(!template);
  const [activeTab, setActiveTab] = useState<"flow" | "rules">("flow");

  useEffect(() => {
    setName(template?.name ?? (docType ? `${docType.name} Workflow` : "New Template"));
    setDescription(template?.description ?? "");
    setSteps(
      template?.steps?.slice().sort((a, b) => a.order - b.order).map((s) => ({ ...s })) ?? []
    );
    setSelectedDocumentTypeId(template?.document_type ?? docType?.id ?? null);
    setIsDirty(!template);
    setActiveTab("flow");
    setSelectedStepIndex(null);
  }, [template?.id, docType?.id]);

  const { data: groups } = useQuery<Group[]>({
    queryKey: ["groups-all"],
    queryFn: () => groupsAPI.list().then((r: any) => r.data.results ?? r.data),
  });

  const availableDocTypes = useMemo(
    () => (docTypes ?? []).filter((item) => item.is_active),
    [docTypes]
  );
  const selectedDocumentTypeName = useMemo(
    () => availableDocTypes.find((item) => item.id === selectedDocumentTypeId)?.name
      ?? template?.document_type_name
      ?? docType?.name
      ?? null,
    [availableDocTypes, selectedDocumentTypeId, template?.document_type_name, docType?.name]
  );
  const canEditDocumentType = !template;

  const saveMutation = useMutation({
    mutationFn: (payload: {
      name: string;
      description: string;
      document_type: string | null;
      is_active: boolean;
      steps: Partial<WorkflowStep>[];
    }) =>
      template
        ? workflowAPI.updateTemplate(template.id, payload)
        : workflowAPI.createTemplate(payload),
    onSuccess: async ({ data }) => {
      const normalized = normalizeTemplate(data);
      setIsDirty(false);

      qc.invalidateQueries({ queryKey: ["workflow-templates"] });
      qc.invalidateQueries({ queryKey: ["document-types"] });
      onSaved(normalized, !template);
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
    if (!selectedDocumentTypeId) { toast.error("Choose the document type this template belongs to"); return; }
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
      document_type: selectedDocumentTypeId,
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
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground bg-muted px-2.5 py-1 rounded-full">
              <FolderTree className="w-3 h-3" />
              Template scope
            </span>
            {selectedDocumentTypeName && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-accent-foreground bg-accent/20 px-2.5 py-1 rounded-full">
                {selectedDocumentTypeName}
              </span>
            )}
          </div>
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
          <div className="mt-3 max-w-sm">
            <Label required>Document type</Label>
            {!canEditDocumentType ? (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm font-medium text-foreground">
                {selectedDocumentTypeName ?? "No document type assigned"}
              </div>
            ) : docType ? (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm font-medium text-foreground">
                {docType.name}
              </div>
            ) : (
              <select
                value={selectedDocumentTypeId ?? ""}
                onChange={(e) => {
                  setSelectedDocumentTypeId(e.target.value || null);
                  setIsDirty(true);
                }}
                className={inp}
              >
                <option value="">Select document type</option>
                {availableDocTypes.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            )}
          </div>
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
          {template && (
            <RoutingRulesPanel template={normalizeTemplate({
              ...template,
              document_type: selectedDocumentTypeId,
              document_type_name: availableDocTypes.find((item) => item.id === selectedDocumentTypeId)?.name ?? template.document_type_name ?? null,
            })} />
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
  const activeTemplates = templates?.filter(t => t.is_active && t.document_type === docType.id) ?? [];
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
    queryFn: () => workflowAPI.listTemplates().then(r =>
      (r.data.results ?? r.data as WorkflowTemplate[]).map(normalizeTemplate)
    ),
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
      return normalizeTemplate(response.data);
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
          setEditingTemplateId(t.id);
          setSelectedDocType({ ...creatingForDocType, workflow_template: t.id });
          setCreatingForDocType(null);
        })
        .catch(() => {
          toast.warning(`Template created but failed to assign`);
          setEditingTemplateId(t.id);
          setSelectedDocType(creatingForDocType);
          setCreatingForDocType(null);
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
  const resolvedTemplates = useMemo(
    () => allTemplatesArray.map((template) => attachResolvedTemplateDocumentType(template, docTypesArray)),
    [allTemplatesArray, docTypesArray]
  );
  const filteredTemplates = useMemo(
    () => resolvedTemplates.filter(t =>
      [t.name, t.document_type_name ?? ""].some(value => value.toLowerCase().includes(search.toLowerCase()))
    ),
    [resolvedTemplates, search]
  );
  const groupedTemplates = useMemo(() => {
    const groups = new Map<string, { label: string; templates: WorkflowTemplate[] }>();
    for (const template of filteredTemplates) {
      const key = template.document_type ?? "unassigned";
      const label = template.document_type_name ?? "Unassigned";
      if (!groups.has(key)) groups.set(key, { label, templates: [] });
      groups.get(key)!.templates.push(template);
    }
    return Array.from(groups.entries())
      .map(([key, group]) => [
        key,
        { ...group, templates: [...group.templates].sort((a, b) => a.name.localeCompare(b.name)) },
      ] as const)
      .sort((a, b) => a[1].label.localeCompare(b[1].label));
  }, [filteredTemplates]);

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
          ) : groupedTemplates.length > 0 ? (
            groupedTemplates.map(([groupKey, group]) => (
              <div key={groupKey} className="rounded-xl border border-border overflow-hidden bg-muted/20">
                <div className="px-3 py-2 bg-muted/60 border-b border-border">
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {group.label}
                  </p>
                </div>
                <div className="p-1 space-y-1">
                  {group.templates.map((t) => {
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
                            <p className="text-xs text-muted-foreground mt-0.5">
                              {t.step_count} step{t.step_count !== 1 ? 's' : ''}
                              {t.description ? ` · ${t.description}` : ""}
                            </p>
                          </div>
                        </div>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))
          ) : (
            <div className="text-center py-10 px-4 text-muted-foreground">
              <LayoutTemplate className="w-10 h-10 mx-auto mb-3 text-muted-foreground/50" />
              <p className="text-sm font-medium text-foreground">No templates found</p>
              <p className="text-xs mt-1">
                {search ? "Try a different search term" : "Create a template to get started"}
              </p>
            </div>
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
                docType={editorDocType}
                template={currentTemplate}
                onSaved={handleSaved}
                allTemplates={resolvedTemplates}
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
          templates={resolvedTemplates}
          isLoading={templatesLoading}
        />
      )}
    </div>
  );
}
