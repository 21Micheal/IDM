import {
  useState, useCallback, useRef, useMemo, type DragEvent,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { workflowAPI, documentTypesAPI, usersAPI, groupsAPI } from "@/services/api";
import {
  Plus, GripVertical, Trash2, ChevronDown, ChevronUp,
  Save, GitBranch, Loader2, X, ArrowDown,
  Settings2, Eye, AlertCircle, Info, TriangleAlert,
  Clock, FileText, CheckCircle2, Copy, Layers,
  Search, MoreVertical, Shield,
  Users, Calendar, RefreshCw,
  FolderTree, LayoutTemplate, Check,
  ChevronRight, Building2, Award, List, User, UsersRound,
} from "lucide-react";
import { toast } from "react-toastify";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────
type AssigneeType = "group_any" | "group_all" | "group_specific" | "specific_user";

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
interface AppUser { id: string; full_name: string; email: string; role: string; }
interface Group { id: string; name: string; description?: string; member_count?: number; }
interface GroupMembershipApiItem {
  user?: AppUser;
  id?: string;
  full_name?: string;
  email?: string;
  role?: string;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const ASSIGNEE_MODES: { value: AssigneeType; label: string; description: string; Icon: typeof Users }[] = [
  { value: "group_any",      label: "Any member of a group",      description: "Any one member can approve",       Icon: Users },
  { value: "group_all",      label: "All members of a group",     description: "Every member must approve",        Icon: UsersRound },
  { value: "group_specific", label: "Specific member of a group", description: "Pick one member from a group",     Icon: User },
  { value: "specific_user",  label: "Specific user",              description: "Direct assignment to a user",      Icon: User },
];

// Stable color tokens for groups (cycled via hash of group id)
const GROUP_TOKENS = ["var(--primary)", "var(--teal)", "var(--accent)", "var(--muted-foreground)"];
const tokenForGroup = (id: string | null | undefined) => {
  if (!id) return "var(--muted-foreground)";
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return GROUP_TOKENS[h % GROUP_TOKENS.length];
};
const groupHsl = (id: string | null | undefined) => `hsl(${tokenForGroup(id)})`;

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
    sla_hours: 48, allow_resubmit: true, instructions: "",
  };
}
function stepToPayload(step: WorkflowStep): Partial<WorkflowStep> {
  const { assignee_user_name, assignee_group_name, ...rest } = step as any;
  return rest;
}

function normalizeStep(step: WorkflowStep): WorkflowStep {
  return {
    ...step,
    assignee_type: step.assignee_type === "any_role" ? "group_any" : step.assignee_type,
  };
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
const inp = "input"; // global class from index.css

function Label({ children, required, tooltip }: { children: React.ReactNode; required?: boolean; tooltip?: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <label className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
        {children}{required && <span className="text-destructive ml-0.5">*</span>}
      </label>
      {tooltip && (
        <div className="group relative">
          <Info className="w-3 h-3 text-muted-foreground cursor-help" />
          <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block bg-primary text-primary-foreground text-xs rounded px-2 py-1 whitespace-nowrap z-10">
            {tooltip}
          </div>
        </div>
      )}
    </div>
  );
}

function SlaBadge({ hours }: { hours: number }) {
  const tone = hours <= 24
    ? "bg-destructive/10 text-destructive border-destructive/30"
    : hours <= 72
      ? "bg-accent/15 text-accent-foreground border-accent/30"
      : "bg-muted text-muted-foreground border-border";
  const label = hours < 24 ? `${hours}h` : hours % 24 === 0 ? `${hours / 24}d` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return (
    <span className={clsx("inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border", tone)}>
      <Clock className="w-3 h-3" />{label}
    </span>
  );
}

// ── SVG Flow Preview ──────────────────────────────────────────────────────────
function FlowPreview({ steps, name }: { steps: WorkflowStep[]; name: string }) {
  const NW = 240, NH = 85, GAP = 55, PAD = 28;
  const total = steps.length + 2;
  const svgH = PAD * 2 + total * NH + (total - 1) * GAP;
  const svgW = NW + PAD * 2;
  const cx = PAD + NW / 2;
  const ny = (i: number) => PAD + i * (NH + GAP);

  if (steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-80 text-muted-foreground gap-4 bg-muted/40 rounded-xl">
        <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center">
          <GitBranch className="w-10 h-10 opacity-40" />
        </div>
        <p className="text-sm font-medium">No steps configured</p>
        <p className="text-xs">Add steps to visualize the approval flow</p>
      </div>
    );
  }

  return (
    <div className="overflow-auto flex justify-center py-8 bg-muted/30 rounded-xl">
      <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} style={{ fontFamily: "Inter,system-ui,sans-serif" }}>
        <defs>
          <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill={`hsl(var(--muted-foreground))`} />
          </marker>
          <marker id="arr-blue" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill={`hsl(var(--primary))`} />
          </marker>
          <filter id="sh"><feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#00000020" /></filter>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="b" />
            <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        {/* START */}
        {(() => {
          const y = ny(0);
          const startFill = `hsl(var(--teal) / 0.12)`;
          const startStroke = `hsl(var(--teal) / 0.5)`;
          const startDot = `hsl(var(--teal))`;
          return (
            <g>
              <rect x={PAD} y={y} width={NW} height={NH} rx={42}
                fill={startFill} stroke={startStroke} strokeWidth={2} filter="url(#sh)" />
              <circle cx={cx} cy={y + 26} r="14" fill={startDot} opacity="0.18" />
              <circle cx={cx} cy={y + 26} r="7" fill={startDot} filter="url(#glow)" />
              <text x={cx} y={y + 55} textAnchor="middle" fontSize={13} fill={startDot} fontWeight={700}>Document Submitted</text>
              <text x={cx} y={y + 73} textAnchor="middle" fontSize={9} fill={startDot} opacity="0.7" fontWeight={600} letterSpacing={2}>START</text>
              <line x1={cx} y1={y + NH} x2={cx} y2={y + NH + GAP} stroke={`hsl(var(--muted-foreground))`} strokeWidth={1.5} strokeDasharray="6 5" markerEnd="url(#arr)" />
            </g>
          );
        })()}

        {/* STEPS */}
        {steps.map((step, i) => {
          const y = ny(i + 1);
          const rc = groupHsl(step.assignee_group);
          const isLast = i === steps.length - 1;
          const mode = ASSIGNEE_MODES.find(m => m.value === step.assignee_type);
          let assigneeLabel = "Unassigned";
          if (step.assignee_type === "specific_user") {
            assigneeLabel = step.assignee_user_name ?? "Specific user";
          } else if (step.assignee_group_name) {
            const suffix =
              step.assignee_type === "group_any" ? " · any member"
              : step.assignee_type === "group_all" ? " · all members"
              : ` · ${step.assignee_user_name ?? "specific member"}`;
            assigneeLabel = `${step.assignee_group_name}${suffix}`;
          }
          const stepName = step.name.length > 28 ? step.name.slice(0, 26) + "…" : step.name;
          const statusLbl = step.status_label.length > 22 ? step.status_label.slice(0, 20) + "…" : step.status_label;

          return (
            <g key={step.id || step.order}>
              <rect x={PAD} y={y} width={NW} height={NH} rx={14}
                fill="white" stroke={rc} strokeWidth={2} filter="url(#sh)" />
              <rect x={PAD + 4} y={y + 12} width={4} height={NH - 24} rx={2} fill={rc} />
              <circle cx={PAD + 28} cy={y + NH / 2} r={15} fill={rc} filter="url(#glow)" />
              <text x={PAD + 28} y={y + NH / 2 + 5} textAnchor="middle" fontSize={12} fill="white" fontWeight={800}>{i + 1}</text>
              {step.name
                ? <text x={PAD + 52} y={y + 32} fontSize={13} fill={`hsl(var(--foreground))`} fontWeight={700}>{stepName}</text>
                : <text x={PAD + 52} y={y + 32} fontSize={12} fill={`hsl(var(--muted-foreground))`} fontStyle="italic">Unnamed step</text>}
              <g transform={`translate(${PAD + 52}, ${y + 52})`}>
                <circle cx="0" cy="0" r="6" fill={rc} opacity="0.2" />
                <circle cx="0" cy="0" r="3" fill={rc} />
                <text x="12" y="3" fontSize={10.5} fill={`hsl(var(--muted-foreground))`}>
                  {mode?.label.split(" ")[0]}: {assigneeLabel.length > 28 ? assigneeLabel.slice(0, 26) + "…" : assigneeLabel}
                </text>
              </g>
              <rect x={PAD + NW - 72} y={y + 14} width="64" height="20" rx="10" fill={`hsl(var(--muted))`} stroke={`hsl(var(--border))`} strokeWidth="0.5" />
              <text x={PAD + NW - 40} y={y + 27.5} textAnchor="middle" fontSize={9} fill={`hsl(var(--muted-foreground))`}>⏱ SLA {step.sla_hours}h</text>
              <text x={PAD + NW - 12} y={y + 65} textAnchor="end" fontSize={9} fill={`hsl(var(--muted-foreground))`} fontStyle="italic">→ {statusLbl}</text>
              {!isLast && (
                <line x1={cx} y1={y + NH} x2={cx} y2={y + NH + GAP - 10}
                  stroke={`hsl(var(--muted-foreground))`} strokeWidth={1.5} strokeDasharray="6 5" markerEnd="url(#arr)" />
              )}
            </g>
          );
        })}

        {/* END */}
        {(() => {
          const y = ny(steps.length + 1);
          const endFill = `hsl(var(--primary) / 0.08)`;
          const endStroke = `hsl(var(--primary) / 0.4)`;
          const endDot = `hsl(var(--primary))`;
          return (
            <g>
              <line x1={cx} y1={ny(steps.length) + NH} x2={cx} y2={y}
                stroke={endDot} strokeWidth={1.5} strokeDasharray="6 5" markerEnd="url(#arr-blue)" />
              <rect x={PAD} y={y} width={NW} height={NH} rx={42}
                fill={endFill} stroke={endStroke} strokeWidth={2} filter="url(#sh)" />
              <circle cx={cx} cy={y + 26} r="14" fill={endDot} opacity="0.15" />
              <circle cx={cx} cy={y + 26} r="7" fill={endDot} filter="url(#glow)" />
              <text x={cx} y={y + 55} textAnchor="middle" fontSize={13} fill={endDot} fontWeight={700}>Document Approved</text>
              <text x={cx} y={y + 73} textAnchor="middle" fontSize={9} fill={endDot} opacity="0.6" fontWeight={600} letterSpacing={2}>END</text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

// ── StepCard ──────────────────────────────────────────────────────────────────
function StepCard({
  step, index, users, groups, isDragOver, onChange, onRemove,
  onDragStart, onDragOver, onDragEnd, onDrop,
}: {
  step: WorkflowStep;
  index: number;
  users: AppUser[];
  groups: Group[];
  isDragOver: boolean;
  onChange: (patch: Partial<WorkflowStep>) => void;
  onRemove: () => void;
  onDragStart: (e: DragEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDragEnd: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const rc = groupHsl(step.assignee_group);
  const isGroupMode = step.assignee_type !== "specific_user";
  const needsGroupMember = step.assignee_type === "group_specific";

  const { data: groupMembers = [], isLoading: membersLoading } = useQuery<AppUser[]>({
    queryKey: ["group-members", step.assignee_group],
    queryFn: async () => {
      const r = await groupsAPI.members(step.assignee_group!);
      const raw: GroupMembershipApiItem[] = r.data?.results ?? r.data ?? [];

      // API returns group memberships (with nested `user`) while this dropdown
      // needs plain users. Normalize both shapes for safety.
      return raw
        .map((item) => item?.user ?? item)
        .filter((u): u is AppUser => Boolean(u?.id && u?.email));
    },
    enabled: !!step.assignee_group && needsGroupMember,
  });

  const handleModeChange = (next: AssigneeType) => {
    if (next === "specific_user") {
      onChange({ assignee_type: next, assignee_group: null, assignee_group_name: undefined, assignee_user: null, assignee_user_name: undefined });
    } else {
      onChange({
        assignee_type: next,
        assignee_user: next === "group_specific" ? step.assignee_user : null,
        assignee_user_name: next === "group_specific" ? step.assignee_user_name : undefined,
      });
    }
  };

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      className={clsx(
        "rounded-xl border transition-all bg-card overflow-hidden select-none group",
        isDragOver ? "border-accent ring-2 ring-accent/30 shadow-lg scale-[1.01]" : "border-border hover:border-muted-foreground/40 shadow-sm hover:shadow-md"
      )}
    >
      <div className="flex items-center gap-2.5 px-4 py-3 bg-muted/40 border-b border-border">
        <span className="cursor-grab text-muted-foreground/60 hover:text-foreground transition-colors active:cursor-grabbing">
          <GripVertical className="w-4 h-4" />
        </span>
        <div className="w-7 h-7 rounded-full text-white text-xs font-bold flex items-center justify-center shadow-sm" style={{ background: rc }}>
          {index + 1}
        </div>
        <input
          value={step.name}
          onChange={e => onChange({ name: e.target.value })}
          className="flex-1 bg-transparent text-sm font-semibold text-foreground outline-none placeholder:text-muted-foreground/60 py-1"
          placeholder="Step name, e.g. Finance Manager Review"
        />
        <SlaBadge hours={step.sla_hours} />
        <div className="flex items-center gap-0.5 ml-1">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className={clsx("p-1.5 rounded transition-colors",
              showAdvanced ? "text-accent-foreground bg-accent/15" : "text-muted-foreground hover:text-foreground hover:bg-muted")}
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setExpanded(!expanded)} className="p-1.5 text-muted-foreground hover:text-foreground rounded hover:bg-muted">
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <button onClick={onRemove} className="p-1.5 text-muted-foreground hover:text-destructive rounded hover:bg-destructive/10 transition-colors">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {expanded && (
        <div className="p-4 space-y-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-4">
            <div className="lg:col-span-2">
              <Label tooltip="Status shown on the document while pending this step">Document status</Label>
              <input
                list={`sp-${step.id || index}`}
                value={step.status_label}
                onChange={e => onChange({ status_label: e.target.value })}
                className={inp}
                placeholder="e.g. Pending Finance Review"
              />
              <datalist id={`sp-${step.id || index}`}>
                {STATUS_PRESETS.map(p => <option key={p} value={p} />)}
              </datalist>
            </div>

            <div className="lg:col-span-2">
              <Label required tooltip="Choose how this step is assigned">Assignment mode</Label>
              <select
                value={step.assignee_type}
                onChange={e => handleModeChange(e.target.value as AssigneeType)}
                className={inp}
              >
                {ASSIGNEE_MODES.map(m => (
                  <option key={m.value} value={m.value}>{m.label} — {m.description}</option>
                ))}
              </select>
            </div>

            {isGroupMode ? (
              <>
                <div className={needsGroupMember ? "" : "lg:col-span-2"}>
                  <Label required tooltip="Permission group responsible for this step">Group</Label>
                  <select
                    value={step.assignee_group ?? ""}
                    onChange={e => {
                      const id = e.target.value || null;
                      const g = groups.find(x => x.id === id);
                      onChange({
                        assignee_group: id,
                        assignee_group_name: g?.name,
                        assignee_user: needsGroupMember ? null : step.assignee_user,
                        assignee_user_name: needsGroupMember ? undefined : step.assignee_user_name,
                      });
                    }}
                    className={inp}
                  >
                    <option value="">— Select group —</option>
                    {groups.map(g => (
                      <option key={g.id} value={g.id}>
                        {g.name}{typeof g.member_count === "number" ? ` · ${g.member_count} member${g.member_count === 1 ? "" : "s"}` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                {needsGroupMember && (
                  <div>
                    <Label required tooltip="Specific member of the selected group">Member</Label>
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
                      <option value="">
                        {!step.assignee_group ? "— Select a group first —" : membersLoading ? "Loading members…" : "— Select member —"}
                      </option>
                      {groupMembers.map(u => (
                        <option key={u.id} value={u.id}>{u.full_name} · {u.email}</option>
                      ))}
                    </select>
                  </div>
                )}
              </>
            ) : (
              <div className="lg:col-span-2">
                <Label required>User</Label>
                <select
                  value={step.assignee_user ?? ""}
                  onChange={e => {
                    const id = e.target.value || null;
                    const u = users.find(x => x.id === id);
                    onChange({ assignee_user: id, assignee_user_name: u?.full_name });
                  }}
                  className={inp}
                >
                  <option value="">— Select user —</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>{u.full_name} · {u.email}</option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <Label tooltip="Maximum hours allowed for this approval step before escalation">SLA (hours)</Label>
              <div className="flex items-center gap-3">
                <div className="flex-1">
                  <input
                    type="range"
                    min={1}
                    max={168}
                    step={1}
                    value={step.sla_hours}
                    onChange={e => onChange({ sla_hours: Number(e.target.value) })}
                    className="w-full h-1.5 bg-muted rounded-lg appearance-none cursor-pointer accent-accent"
                  />
                </div>
                <input
                  type="number"
                  min={1}
                  max={720}
                  value={step.sla_hours}
                  onChange={e => onChange({ sla_hours: Math.max(1, Number(e.target.value)) })}
                  className={clsx(inp, "w-20 text-center")}
                />
                <span className="text-xs text-muted-foreground w-16">
                  {Math.floor(step.sla_hours / 24)}d {step.sla_hours % 24}h
                </span>
              </div>
            </div>
          </div>

          {showAdvanced && (
            <div className="pt-3 border-t border-border">
              <p className="text-xs font-medium text-muted-foreground mb-3 uppercase tracking-wider flex items-center gap-2">
                <Settings2 className="w-3 h-3" /> Advanced settings
              </p>
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id={`rs-${step.id || index}`}
                  checked={step.allow_resubmit}
                  onChange={e => onChange({ allow_resubmit: e.target.checked })}
                  className="mt-0.5 w-4 h-4 rounded border-border text-accent focus:ring-accent"
                />
                <label htmlFor={`rs-${step.id || index}`} className="text-sm text-foreground leading-snug cursor-pointer">
                  Allow resubmission after rejection
                </label>
              </div>
            </div>
          )}

          <div>
            <Label>Approver instructions</Label>
            <textarea
              value={step.instructions}
              rows={2}
              onChange={e => onChange({ instructions: e.target.value })}
              className={clsx(inp, "resize-none")}
              placeholder="What should the approver verify? Any specific guidelines or documents to check?"
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Template Card ─────────────────────────────────────────────────────────────
function TemplateCard({ template, onSelect, onClone, isSelected }: {
  template: WorkflowTemplate;
  onSelect: () => void;
  onClone: () => void;
  isSelected: boolean;
}) {
  return (
    <div
      onClick={onSelect}
      className={clsx(
        "rounded-xl border-2 p-4 cursor-pointer transition-all group",
        isSelected
          ? "border-accent bg-accent/5 shadow-md"
          : "border-border bg-card hover:border-accent/40 hover:shadow-md"
      )}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center shadow-sm">
            <LayoutTemplate className="w-4 h-4" />
          </div>
          <div>
            <p className="font-semibold text-foreground text-sm">{template.name}</p>
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onClone(); }}
          className="opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-accent-foreground hover:bg-accent/15 rounded-lg transition-all"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>
      {template.description && (
        <p className="text-xs text-muted-foreground line-clamp-2 mb-3">{template.description}</p>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <GitBranch className="w-3 h-3" />
        <span>{template.step_count} step{template.step_count !== 1 ? 's' : ''}</span>
      </div>
    </div>
  );
}

// ── Routing Rules Panel ───────────────────────────────────────────────────────
function RoutingRulesPanel({ templateId, docTypes }: {
  templateId: string;
  docTypes: DocumentType[];
}) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ document_type: "", amount_threshold: "0", currency: "USD", label: "" });

  const { data: rules, isLoading } = useQuery<WorkflowRule[]>({
    queryKey: ["workflow-rules", templateId],
    queryFn: () => workflowAPI.listRules({ template: templateId }).then(r => r.data.results ?? r.data),
  });

  const createRule = useMutation({
    mutationFn: () => workflowAPI.createRule({ ...form, template: templateId }),
    onSuccess: () => {
      toast.success("Routing rule created");
      qc.invalidateQueries({ queryKey: ["workflow-rules", templateId] });
      setShowAdd(false);
      setForm({ document_type: "", amount_threshold: "0", currency: "USD", label: "" });
    },
    onError: () => toast.error("Failed to create rule"),
  });

  const deleteRule = useMutation({
    mutationFn: (id: string) => workflowAPI.deleteRule(id),
    onSuccess: () => {
      toast.success("Rule removed");
      qc.invalidateQueries({ queryKey: ["workflow-rules", templateId] });
    },
  });

  const sortedRules = [...(rules ?? [])].sort((a, b) => Number(a.amount_threshold) - Number(b.amount_threshold));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-foreground text-sm flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-accent-foreground" />
            Amount-based routing rules
          </h3>
          <p className="text-xs text-muted-foreground mt-0.5 max-w-md">
            Route high-value documents to different approval workflows based on amount thresholds.
            Rules are evaluated in order of threshold (lowest first). Threshold 0 = catch-all.
          </p>
        </div>
        <button onClick={() => setShowAdd(true)} className="btn-primary text-xs px-3 py-1.5">
          <Plus className="w-3.5 h-3.5" /> Add rule
        </button>
      </div>

      <div className="p-3 bg-teal/10 border border-teal/30 rounded-lg">
        <div className="flex items-start gap-2 text-xs text-teal">
          <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>When a document is submitted, the workflow engine selects the rule with the highest threshold ≤ document amount. This template will be used for documents matching this rule.</span>
        </div>
      </div>

      {showAdd && (
        <div className="rounded-xl border-2 border-accent/40 bg-accent/5 p-4 space-y-3">
          <h4 className="text-sm font-semibold text-foreground flex items-center gap-2">
            <Plus className="w-3.5 h-3.5 text-accent-foreground" /> New routing rule
          </h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label required>Document type</Label>
              <select
                value={form.document_type}
                onChange={e => setForm(f => ({ ...f, document_type: e.target.value }))}
                className={inp}
              >
                <option value="">— Select document type —</option>
                {docTypes.filter(dt => dt.workflow_template !== templateId).map(dt => (
                  <option key={dt.id} value={dt.id}>{dt.name}</option>
                ))}
              </select>
              <p className="text-xs text-muted-foreground mt-1">
                Documents of this type will use this template when the amount threshold is met.
              </p>
            </div>
            <div>
              <Label>Minimum amount (≥)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">$</span>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  value={form.amount_threshold}
                  onChange={e => setForm(f => ({ ...f, amount_threshold: e.target.value }))}
                  className={clsx(inp, "pl-7")}
                  placeholder="0 = catch-all"
                />
              </div>
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

      {!isLoading && sortedRules.length === 0 && !showAdd && (
        <div className="text-center py-12 bg-muted/40 rounded-xl">
          <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mx-auto mb-3">
            <GitBranch className="w-6 h-6 text-muted-foreground/60" />
          </div>
          <p className="text-sm font-medium text-muted-foreground">No routing rules</p>
          <p className="text-xs text-muted-foreground/80 mt-1">
            Add rules to route documents from other document types to this template based on amount thresholds.
          </p>
        </div>
      )}

      {sortedRules.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider px-1">
            Rules pointing to this template ({sortedRules.length})
          </p>
          {sortedRules.map((rule, idx) => {
            const threshold = Number(rule.amount_threshold);
            const isCatchAll = threshold === 0;
            return (
              <div key={rule.id} className="flex items-center gap-3 p-3 rounded-xl bg-card border border-border hover:border-accent/40 transition-all group">
                <div className={clsx(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold",
                  isCatchAll ? "bg-muted text-muted-foreground" : "bg-accent/15 text-accent-foreground border border-accent/30"
                )}>
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-foreground">
                      {rule.label || (isCatchAll ? "Default (catch-all)" : `≥ ${threshold.toLocaleString()} ${rule.currency}`)}
                    </p>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
                      {rule.document_type_name}
                    </span>
                  </div>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    {isCatchAll
                      ? "Applies when no higher threshold matches"
                      : `Documents from ${rule.document_type_name} with amount ≥ ${threshold.toLocaleString()} ${rule.currency} use this template`}
                  </p>
                </div>
                <button
                  onClick={() => deleteRule.mutate(rule.id)}
                  disabled={deleteRule.isPending}
                  className="opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-destructive rounded-lg hover:bg-destructive/10 transition-all"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
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
  const [name, setName] = useState(template?.name ?? (docType ? `${docType.name} Workflow` : "New Workflow Template"));
  const [description, setDescription] = useState(template?.description ?? "");
  const [steps, setSteps] = useState<WorkflowStep[]>(() =>
    template?.steps?.slice().sort((a, b) => a.order - b.order).map(s => normalizeStep({ ...s })) ?? []
  );
  const [activeTab, setTab] = useState<"steps" | "preview" | "rules">("steps");
  const [isDirty, setIsDirty] = useState(!template);
  const [showTemplateLibrary, setShowTemplateLibrary] = useState(false);

  const dragIdx = useRef<number | null>(null);
  const overIdx = useRef<number | null>(null);
  const [dragOver, setDragOver] = useState<number | null>(null);

  const { data: users } = useQuery<AppUser[]>({
    queryKey: ["users-all"],
    queryFn: () => usersAPI.list({ page_size: 200 }).then(r => r.data.results ?? r.data),
  });

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

  const duplicateMutation = useMutation({
    mutationFn: (payload: { id: string; name?: string }) =>
      workflowAPI.duplicateTemplate(payload.id, payload.name),
    onSuccess: ({ data }) => {
      toast.success(`Template duplicated as "${data.name}"`);
      qc.invalidateQueries({ queryKey: ["workflow-templates"] });
      setShowTemplateLibrary(false);
    },
    onError: () => toast.error("Failed to duplicate template"),
  });

  const reorderMutation = useMutation({
    mutationFn: (stepIds: string[]) => workflowAPI.reorderSteps(template!.id, stepIds),
    onError: () => toast.error("Could not persist step order — please re-save."),
  });

  const patchStep = useCallback((i: number, patch: Partial<WorkflowStep>) => {
    setSteps(prev => {
      const next = [...prev];
      next[i] = { ...next[i], ...patch };
      return next;
    });
    setIsDirty(true);
  }, []);

  const addStep = () => {
    setSteps(prev => [...prev, { ...blankStep(), order: prev.length + 1 }]);
    setIsDirty(true);
  };

  const removeStep = (i: number) => {
    setSteps(prev => prev.filter((_, j) => j !== i).map((s, idx) => ({ ...s, order: idx + 1 })));
    setIsDirty(true);
  };

  const handleDragStart = (i: number) => (e: DragEvent) => {
    dragIdx.current = i;
    e.dataTransfer.effectAllowed = "move";
    setTimeout(() => setDragOver(i), 0);
  };

  const handleDragOver = (i: number) => (e: DragEvent) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (overIdx.current !== i) {
      overIdx.current = i;
      setDragOver(i);
    }
  };

  const handleDragEnd = () => {
    dragIdx.current = null;
    overIdx.current = null;
    setDragOver(null);
  };

  const handleDrop = (targetIdx: number) => (e: DragEvent) => {
    e.preventDefault();
    const from = dragIdx.current;
    if (from === null || from === targetIdx) {
      handleDragEnd();
      return;
    }

    setSteps(prev => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(targetIdx, 0, item);
      const reordered = next.map((s, idx) => ({ ...s, order: idx + 1 }));

      if (template && reordered.every(s => s.id)) {
        const stepIds = reordered.map(s => s.id!);
        reorderMutation.mutate(stepIds);
      }
      return reordered;
    });
    setIsDirty(true);
    handleDragEnd();
  };

  const handleSave = () => {
    if (!name.trim()) { toast.error("Template name is required"); return; }
    if (steps.length === 0) { toast.error("Add at least one approval step"); return; }
    for (const s of steps) {
      if (!s.name.trim()) { toast.error(`Step ${s.order} needs a name`); return; }
      if (s.assignee_type !== "specific_user" && !s.assignee_group) {
        toast.error(`"${s.name}" needs a group`); return;
      }
      if (s.assignee_type === "group_specific" && !s.assignee_user) {
        toast.error(`"${s.name}" needs a specific group member`); return;
      }
      if (s.assignee_type === "specific_user" && !s.assignee_user) {
        toast.error(`"${s.name}" needs a user`); return;
      }
    }

    saveMutation.mutate({
      name: name.trim(),
      description: description.trim(),
      steps: steps.map(stepToPayload),
    });
  };

  const handleCloneFromLibrary = (sourceTemplate: WorkflowTemplate) => {
    duplicateMutation.mutate({ id: sourceTemplate.id, name: `${sourceTemplate.name} (Copy)` });
  };

  const tabs = [
    { id: "steps" as const, label: `Steps (${steps.length})`, Icon: GitBranch },
    { id: "preview" as const, label: "Flow preview", Icon: Eye },
    ...(template ? [{ id: "rules" as const, label: "Routing Rules", Icon: Settings2 }] : []),
  ];

  return (
    <div className="flex flex-col h-full min-h-0">
      {isDirty && (
        <div className="flex items-center gap-2 px-3 py-2 mb-3 bg-accent/15 border border-accent/40 rounded-lg text-xs text-accent-foreground flex-shrink-0">
          <TriangleAlert className="w-3.5 h-3.5" /> Unsaved changes
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4 pb-4 border-b border-border mb-4 flex-shrink-0">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className="mt-1 w-10 h-10 rounded-xl bg-primary text-primary-foreground shadow-md flex items-center justify-center flex-shrink-0">
            <FileText className="w-5 h-5" />
          </div>
          <div className="flex-1 min-w-0">
            {docType && (
              <p className="text-xs font-medium text-accent-foreground bg-accent/15 border border-accent/30 px-2 py-0.5 rounded-full inline-block mb-1">
                {docType.name}
              </p>
            )}
            <input
              value={name}
              onChange={e => { setName(e.target.value); setIsDirty(true); }}
              className="w-full text-lg font-bold text-foreground bg-transparent border-0 outline-none placeholder:text-muted-foreground/60 p-0"
              placeholder="Template name…"
            />
            <input
              value={description}
              onChange={e => { setDescription(e.target.value); setIsDirty(true); }}
              className="w-full text-sm text-muted-foreground bg-transparent border-0 outline-none placeholder:text-muted-foreground/60 p-0 mt-1"
              placeholder="Short description (optional)"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!template && (
            <button
              onClick={() => setShowTemplateLibrary(!showTemplateLibrary)}
              className="btn-secondary text-sm"
            >
              <Layers className="w-4 h-4" /> Browse templates
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saveMutation.isPending || (!isDirty && !!template)}
            className="btn-primary text-sm"
          >
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {template ? "Save Changes" : "Create Template"}
          </button>
        </div>
      </div>

      {/* Template Library Browser */}
      {showTemplateLibrary && (
        <div className="mb-4 p-4 bg-muted/40 rounded-xl border border-border">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
              <Layers className="w-4 h-4 text-accent-foreground" />
              Template Library
            </h3>
            <button onClick={() => setShowTemplateLibrary(false)} className="p-1 text-muted-foreground hover:text-foreground">
              <X className="w-4 h-4" />
            </button>
          </div>
          {allTemplates === undefined ? (
            <div className="flex items-center justify-center py-10">
              <Loader2 className="w-6 h-6 text-accent animate-spin" />
            </div>
          ) : allTemplates.length === 0 ? (
            <div className="text-center py-10 text-muted-foreground">
              <p className="text-sm">No templates available to clone</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 max-h-64 overflow-y-auto">
              {allTemplates.filter(t => t.is_active && t.id !== template?.id).map(t => (
                <TemplateCard
                  key={t.id}
                  template={t}
                  onSelect={() => handleCloneFromLibrary(t)}
                  onClone={() => handleCloneFromLibrary(t)}
                  isSelected={false}
                />
              ))}
            </div>
          )}
        </div>
      )}

      {/* Tabs */}
      <div className="border-b border-border mb-4 flex gap-1 flex-shrink-0">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={clsx(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-all",
              activeTab === id
                ? "bg-card text-foreground border-b-2 border-accent shadow-sm"
                : "text-muted-foreground hover:text-foreground hover:bg-muted"
            )}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      {activeTab === "steps" && (
        <div className="flex-1 overflow-y-auto pr-1 space-y-2.5 min-h-0">
          {steps.length === 0 && (
            <div className="flex flex-col items-center justify-center py-20 text-muted-foreground gap-4 bg-muted/30 rounded-xl border-2 border-dashed border-border">
              <div className="w-20 h-20 rounded-full bg-muted flex items-center justify-center">
                <GitBranch className="w-10 h-10 text-muted-foreground/40" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-foreground">No approval steps yet</p>
                <p className="text-xs text-muted-foreground mt-1">Define the approval chain for {docType?.name || "this"} workflow</p>
              </div>
            </div>
          )}
          {steps.map((step, i) => (
            <div key={step.id || i}>
              <StepCard
                step={step}
                index={i}
                users={users ?? []}
                groups={groups ?? []}
                isDragOver={dragOver === i}
                onChange={p => patchStep(i, p)}
                onRemove={() => removeStep(i)}
                onDragStart={handleDragStart(i)}
                onDragOver={handleDragOver(i)}
                onDragEnd={handleDragEnd}
                onDrop={handleDrop(i)}
              />
              {i < steps.length - 1 && (
                <div className="flex justify-center py-1">
                  <ArrowDown className="w-4 h-4 text-muted-foreground/40" />
                </div>
              )}
            </div>
          ))}
          <button
            onClick={addStep}
            className="w-full mt-2 border-2 border-dashed border-border rounded-xl py-4 text-sm text-muted-foreground hover:border-accent hover:text-accent-foreground hover:bg-accent/5 flex items-center justify-center gap-2 transition-all group"
          >
            <Plus className="w-4 h-4 group-hover:scale-110 transition-transform" /> Add approval step
          </button>
          {steps.length > 0 && (
            <p className="text-center text-xs text-muted-foreground pb-3 flex items-center justify-center gap-1">
              <GripVertical className="w-3 h-3" /> Drag steps to reorder the approval chain
            </p>
          )}
        </div>
      )}

      {activeTab === "preview" && (
        <div className="flex-1 overflow-y-auto min-h-0 bg-muted/30 rounded-xl border border-border">
          <div className="p-4 border-b border-border bg-card rounded-t-xl sticky top-0 z-10">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-sm font-semibold text-foreground">{name || "Untitled template"}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-muted-foreground">{docType?.name || "Global Template"}</span>
                  <span className="text-xs text-muted-foreground/60">•</span>
                  <span className="text-xs text-muted-foreground">{steps.length} step{steps.length !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {ASSIGNEE_MODES.map(m => (
                  <span key={m.value} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                    <m.Icon className="w-3 h-3 text-accent-foreground" />
                    {m.label}
                  </span>
                ))}
              </div>
            </div>
          </div>
          <FlowPreview steps={steps} name={name} />
        </div>
      )}

      {activeTab === "rules" && template && docTypes && (
        <div className="flex-1 overflow-y-auto min-h-0 pr-1">
          <RoutingRulesPanel templateId={template.id} docTypes={docTypes} />
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
    <div className="fixed inset-0 bg-primary/40 backdrop-blur-sm flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-card rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden border border-border" style={{ boxShadow: "var(--shadow-elegant)" }} onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-border bg-muted/40 sticky top-0 z-10">
          <div>
            <h2 className="text-lg font-bold text-foreground flex items-center gap-2">
              <FileText className="w-5 h-5 text-accent-foreground" />
              {docType.name}
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              Code: {docType.code} · Prefix: {docType.reference_prefix}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto">
          <div className={clsx(
            "mb-6 p-4 rounded-xl border",
            docType.workflow_template ? "bg-teal/10 border-teal/30" : "bg-accent/10 border-accent/30"
          )}>
            <div className="flex items-start gap-3">
              {docType.workflow_template ? (
                <CheckCircle2 className="w-5 h-5 text-teal mt-0.5 flex-shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 text-accent-foreground mt-0.5 flex-shrink-0" />
              )}
              <div className="flex-1">
                <p className="text-sm font-medium text-foreground">
                  {docType.workflow_template ? "Primary Template Assigned" : "No Primary Template Assigned"}
                </p>
                {currentPrimaryTemplate && (
                  <div className="mt-2 p-2 bg-card rounded-lg border border-teal/30">
                    <p className="text-sm font-medium text-foreground">{currentPrimaryTemplate.name}</p>
                    {currentPrimaryTemplate.description && (
                      <p className="text-xs text-muted-foreground mt-0.5">{currentPrimaryTemplate.description}</p>
                    )}
                    <p className="text-xs text-muted-foreground mt-1">
                      {currentPrimaryTemplate.step_count} step{currentPrimaryTemplate.step_count !== 1 ? 's' : ''}
                    </p>
                  </div>
                )}
                <p className="text-xs text-muted-foreground mt-1">
                  The primary template is used for documents that don't match any amount-based routing rules.
                </p>
              </div>
            </div>
          </div>

          <div className="mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-foreground flex items-center gap-2">
                <LayoutTemplate className="w-4 h-4 text-accent-foreground" />
                Available Templates
                <span className="text-xs font-normal text-muted-foreground">
                  ({activeTemplates.length} total)
                </span>
              </h3>
              <button onClick={onCreateTemplate} className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-accent-foreground bg-accent/15 border border-accent/30 rounded-lg hover:bg-accent/25 transition-colors">
                <Plus className="w-3.5 h-3.5" /> Create New
              </button>
            </div>

            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => <div key={i} className="h-24 bg-muted rounded-xl animate-pulse" />)}
              </div>
            ) : activeTemplates.length > 0 ? (
              <div className="space-y-2 max-h-[40vh] overflow-y-auto pr-1">
                {activeTemplates.map(template => {
                  const isCurrentPrimary = template.id === docType.workflow_template;
                  const isSelected = selectedTemplateId === template.id;
                  return (
                    <div
                      key={template.id}
                      onClick={() => setSelectedTemplateId(template.id)}
                      className={clsx(
                        "relative p-4 rounded-xl border-2 transition-all cursor-pointer group",
                        isSelected
                          ? "border-accent bg-accent/5 shadow-sm"
                          : "border-border hover:border-accent/40 hover:bg-muted/40",
                        isCurrentPrimary && !isSelected && "border-teal/40 bg-teal/5"
                      )}
                    >
                      {isSelected && (
                        <div className="absolute top-3 right-3">
                          <div className="w-5 h-5 rounded-full bg-accent flex items-center justify-center">
                            <Check className="w-3 h-3 text-accent-foreground" />
                          </div>
                        </div>
                      )}

                      <div className="flex items-start gap-3 pr-8">
                        <div className={clsx(
                          "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0 text-white",
                          isCurrentPrimary ? "bg-teal" : "bg-primary"
                        )}>
                          <LayoutTemplate className="w-5 h-5" />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-foreground text-sm">
                              {template.name}
                            </span>
                            {isCurrentPrimary && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-teal/15 text-teal border border-teal/30">
                                Current Primary
                              </span>
                            )}
                            {template.category && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-muted text-muted-foreground">
                                {template.category}
                              </span>
                            )}
                          </div>

                          {template.description && (
                            <p className="text-xs text-muted-foreground mt-1 line-clamp-2">
                              {template.description}
                            </p>
                          )}

                          <div className="flex items-center gap-3 mt-2">
                            <span className="text-xs text-muted-foreground flex items-center gap-1">
                              <GitBranch className="w-3 h-3" /> {template.step_count} steps
                            </span>
                            {template.updated_at && (
                              <span className="text-xs text-muted-foreground flex items-center gap-1">
                                <Calendar className="w-3 h-3" /> Updated {new Date(template.updated_at).toLocaleDateString()}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="text-center py-12 bg-muted/40 rounded-xl">
                <LayoutTemplate className="w-12 h-12 mx-auto mb-3 text-muted-foreground/40" />
                <p className="text-sm font-medium text-muted-foreground">No templates available</p>
                <p className="text-xs text-muted-foreground/80 mt-1">
                  Create a template to assign as the primary workflow
                </p>
                <button onClick={onCreateTemplate} className="mt-3 text-sm text-accent-foreground hover:underline font-medium">
                  + Create your first template
                </button>
              </div>
            )}
          </div>

          <div className="p-3 bg-teal/10 border border-teal/30 rounded-xl mb-4">
            <p className="text-xs text-teal flex items-start gap-2">
              <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                You can also create <strong>amount-based routing rules</strong> that send documents
                from this type to different templates based on the document amount.
              </span>
            </p>
          </div>
        </div>

        <div className="flex gap-3 p-5 border-t border-border bg-muted/40">
          <button
            onClick={handleAssign}
            disabled={!selectedTemplateId || selectedTemplateId === docType.workflow_template}
            className={clsx(
              "flex-1 px-4 py-2.5 rounded-xl font-medium transition-all shadow-sm",
              !selectedTemplateId || selectedTemplateId === docType.workflow_template
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
            )}
          >
            {selectedTemplateId === docType.workflow_template
              ? "✓ Already Primary"
              : "Set as Primary Template"}
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
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");
  const [savedConfirmation, setSavedConfirmation] = useState<{ docTypeName: string; templateName: string } | null>(null);

  const { data: docTypes, isLoading: dtLoading } = useQuery<DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then(r => r.data.results ?? r.data as DocumentType[]),
  });

  const { data: allTemplates, isLoading: templatesLoading } = useQuery<WorkflowTemplate[]>({
    queryKey: ["workflow-templates"],
    queryFn: () => workflowAPI.listTemplates().then(r => r.data.results ?? r.data as WorkflowTemplate[]),
  });

  const effectiveTemplateId = editingTemplateId || selectedDocType?.workflow_template || null;

  // 🔧 Bug fix: drive editor directly from query result; do NOT mirror via useState/useEffect.
  // The previous `activeTemplate` mirror was stale on first render after id changed,
  // because effects run AFTER paint — so the editor mounted with `template={null}` (or
  // the previous template's data) on the first selection, leaving the panel blank.
  const {
    data: fetchedTemplate,
    isFetching: templateFetching,
    isLoading: templateLoading,
    isError: templateError,
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
    setSavedConfirmation(null);
  };

  const handleTemplateClick = (t: WorkflowTemplate) => {
    setEditingTemplateId(t.id);
    setSelectedDocType(null);
    setCreatingForDocType(null);
    setSavedConfirmation(null);
  };

  const handleAssignTemplate = useCallback(async (docTypeId: string, templateId: string) => {
    try {
      await documentTypesAPI.update(docTypeId, { workflow_template: templateId });
      toast.success("Primary template assigned successfully");
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
    setSavedConfirmation(null);
  };

  const handleSaved = (t: WorkflowTemplate, isNew: boolean) => {
    if (isNew && creatingForDocType) {
      documentTypesAPI.update(creatingForDocType.id, { workflow_template: t.id })
        .then(() => {
          toast.success(`Template "${t.name}" created and assigned to ${creatingForDocType.name}`);
          qc.invalidateQueries({ queryKey: ["document-types"] });
          setSavedConfirmation({ docTypeName: creatingForDocType.name, templateName: t.name });
          setCreatingForDocType(null);
          setSelectedDocType(null);
          setEditingTemplateId(null);
        })
        .catch(() => {
          toast.warning(`Template "${t.name}" created but failed to assign to document type`);
          setCreatingForDocType(null);
          setSelectedDocType(null);
          setEditingTemplateId(null);
        });
    } else if (isNew && !creatingForDocType) {
      setSavedConfirmation(null);
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
  // 🔧 Editor source = fetched template (no mirror state). For new templates, pass null.
  const currentTemplate = creatingForDocType ? null : (fetchedTemplate ?? null);
  // Show loader whenever we need a template but haven't received it yet.
  const isLoadingTemplate =
    !creatingForDocType &&
    !!effectiveTemplateId &&
    (templateLoading || templateFetching || fetchedTemplate === undefined);

  if (templateError && effectiveTemplateId) {
    toast.error("Failed to load template");
  }

  const editorDocType = selectedDocType || creatingForDocType || null;

  return (
    <div className="flex gap-6 h-[calc(100vh-7rem)] min-h-0 bg-background rounded-2xl p-1">
      {/* Left Panel */}
      <aside className="w-80 flex-shrink-0 flex flex-col gap-4 bg-card rounded-2xl border border-border overflow-hidden" style={{ boxShadow: "var(--shadow-card)" }}>
        <div className="p-4 border-b border-border">
          <div className="flex items-center justify-between mb-3 gap-2">
            <div className="min-w-0">
              <h1 className="text-lg font-bold text-foreground flex items-center gap-2">
                {sidebarTab === "doctypes" ? (
                  <FolderTree className="w-5 h-5 text-accent-foreground" />
                ) : (
                  <LayoutTemplate className="w-5 h-5 text-accent-foreground" />
                )}
                {sidebarTab === "doctypes" ? "Document Types" : "Templates"}
              </h1>
              {sidebarTab === "doctypes" ? (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {withTemplate} / {docTypesArray.length} have primary templates
                </p>
              ) : (
                <p className="text-xs text-muted-foreground mt-0.5">
                  {allTemplatesArray.length} saved template{allTemplatesArray.length !== 1 ? 's' : ''}
                </p>
              )}
            </div>
            <div className="flex items-center gap-1">
              {sidebarTab === "templates" && (
                <button
                  onClick={() => handleStartCreateForDocType(null)}
                  className="flex items-center gap-1 px-2 py-1 text-xs bg-accent/15 text-accent-foreground border border-accent/30 rounded-lg hover:bg-accent/25"
                >
                  <Plus className="w-3 h-3" /> New
                </button>
              )}
              <button
                onClick={() => setViewMode(viewMode === "list" ? "grid" : "list")}
                className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted"
              >
                {viewMode === "list" ? <LayoutTemplate className="w-4 h-4" /> : <List className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Tab Switcher */}
          <div className="flex bg-muted p-1 rounded-lg mb-4">
            <button
              onClick={() => { setSidebarTab("doctypes"); setSearch(""); }}
              className={clsx(
                "flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all",
                sidebarTab === "doctypes" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
              )}
            >
              <FolderTree className="w-3.5 h-3.5" /> Types
            </button>
            <button
              onClick={() => { setSidebarTab("templates"); setSearch(""); }}
              className={clsx(
                "flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all",
                sidebarTab === "templates" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"
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
              placeholder={sidebarTab === "doctypes" ? "Search document types..." : "Search templates..."}
              className={clsx(inp, "pl-9")}
            />
          </div>
        </div>

        <div className={clsx(
          "flex-1 overflow-y-auto pb-4 gap-2",
          viewMode === "grid" ? "px-3 grid grid-cols-1" : "px-2 space-y-1"
        )}>
          {(dtLoading || (sidebarTab === "templates" && templatesLoading)) && Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 bg-muted rounded-xl animate-pulse" />
          ))}

          {sidebarTab === "doctypes" ? (
            filteredDocTypes.length === 0 && !dtLoading ? (
              <div className="text-center py-12 text-muted-foreground">
                <FileText className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium text-foreground">No document types found</p>
                <p className="text-xs mt-1">{search ? "Try a different search term" : "Create a document type first"}</p>
              </div>
            ) : (
              filteredDocTypes.map(dt => {
                const hasTemplate = !!dt.workflow_template;
                const isSelected = selectedDocType?.id === dt.id;
                return (
                  <div key={dt.id} className="relative group">
                    <button
                      onClick={() => handleDocTypeClick(dt)}
                      className={clsx(
                        "w-full text-left rounded-xl p-3 transition-all border",
                        isSelected
                          ? "bg-accent/10 border-accent/40 shadow-sm ring-1 ring-accent/30"
                          : "bg-card border-border hover:border-muted-foreground/30 hover:bg-muted/40"
                      )}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className={clsx(
                          "w-2 h-2 rounded-full flex-shrink-0 mt-1.5 ring-2",
                          hasTemplate ? "bg-teal ring-teal/20" : "bg-accent ring-accent/20"
                        )} />
                        <div className="flex-1 min-w-0">
                          <p className={clsx("font-semibold text-sm truncate", isSelected ? "text-foreground" : "text-foreground")}>
                            {dt.name}
                          </p>
                          <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                            {dt.reference_prefix}-XXXXX
                          </p>
                        </div>
                        {!hasTemplate && (
                          <span className="text-[10px] text-accent-foreground font-medium flex-shrink-0 bg-accent/15 border border-accent/30 px-2 py-0.5 rounded-full">
                            Setup
                          </span>
                        )}
                      </div>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowDetailModal(dt); }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1.5 text-muted-foreground hover:text-accent-foreground rounded-lg bg-card border border-border shadow-sm transition-all"
                    >
                      <MoreVertical className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )
          ) : (
            filteredTemplates.length === 0 && !templatesLoading ? (
              <div className="text-center py-12 text-muted-foreground">
                <LayoutTemplate className="w-10 h-10 mx-auto mb-3 opacity-30" />
                <p className="text-sm font-medium text-foreground">No templates found</p>
                <p className="text-xs mt-1">
                  {search ? "Try a different search term" : (
                    <button
                      onClick={() => handleStartCreateForDocType(null)}
                      className="text-accent-foreground hover:underline"
                    >
                      Create your first template
                    </button>
                  )}
                </p>
              </div>
            ) : (
              filteredTemplates.map(t => {
                const isSelected = editingTemplateId === t.id;
                return (
                  <button
                    key={t.id}
                    onClick={() => handleTemplateClick(t)}
                    className={clsx(
                      "w-full text-left rounded-xl p-3 transition-all border",
                      isSelected
                        ? "bg-accent/10 border-accent/40 shadow-sm ring-1 ring-accent/30"
                        : "bg-card border-border hover:border-muted-foreground/30 hover:bg-muted/40"
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-primary text-primary-foreground flex items-center justify-center flex-shrink-0">
                        <LayoutTemplate className="w-4 h-4" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm truncate text-foreground">
                          {t.name}
                        </p>
                        <p className="text-xs text-muted-foreground mt-0.5">
                          {t.step_count} step{t.step_count !== 1 ? 's' : ''}
                          {t.description && ` · ${t.description.slice(0, 40)}${t.description.length > 40 ? '…' : ''}`}
                        </p>
                      </div>
                    </div>
                  </button>
                );
              })
            )
          )}
        </div>
      </aside>

      {/* Right Panel - Editor */}
      <main className="flex-1 min-w-0 bg-card rounded-2xl border border-border p-5 overflow-hidden flex flex-col" style={{ boxShadow: "var(--shadow-card)" }}>
        {!showEditor && savedConfirmation && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-5">
            <div className="w-20 h-20 rounded-2xl bg-teal text-white flex items-center justify-center" style={{ boxShadow: "var(--shadow-elegant)" }}>
              <CheckCircle2 className="w-10 h-10" />
            </div>
            <div>
              <p className="text-xl font-semibold text-foreground">Workflow Created!</p>
              <p className="text-sm text-muted-foreground mt-2 max-w-md">
                <span className="font-medium text-accent-foreground">{savedConfirmation.templateName}</span> is now the primary template for
                <span className="font-medium text-foreground"> {savedConfirmation.docTypeName}</span>
              </p>
              <p className="text-xs text-muted-foreground mt-2">
                You can now add amount-based routing rules to use different templates for high-value documents.
              </p>
            </div>
            <button
              onClick={() => setSavedConfirmation(null)}
              className="btn-primary"
            >
              Continue <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {!showEditor && !savedConfirmation && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-5">
            <div className="w-24 h-24 rounded-2xl bg-muted flex items-center justify-center">
              <GitBranch className="w-10 h-10 text-muted-foreground/40" />
            </div>
            <div>
              <p className="text-lg font-semibold text-foreground">
                {sidebarTab === "doctypes" ? "Select a document type" : "Select or create a template"}
              </p>
              <p className="text-sm text-muted-foreground mt-1 max-w-sm">
                {sidebarTab === "doctypes"
                  ? "Each document type has a primary workflow template. Select one from the left panel to edit its workflow."
                  : "Templates define approval steps. Select an existing template or click 'New' to create one."}
              </p>
            </div>
            {sidebarTab === "doctypes" && withoutTemplate > 0 && (
              <div className="flex items-center gap-2 px-4 py-2.5 bg-accent/10 border border-accent/30 rounded-xl text-sm text-accent-foreground">
                <TriangleAlert className="w-4 h-4" />
                {withoutTemplate} document type{withoutTemplate !== 1 ? 's' : ''} need{withoutTemplate === 1 ? 's' : ''} a primary workflow template
              </div>
            )}
            {sidebarTab === "templates" && (
              <button
                onClick={() => handleStartCreateForDocType(null)}
                className="btn-primary"
              >
                <Plus className="w-4 h-4" /> Create New Template
              </button>
            )}
          </div>
        )}

        {showEditor && (
          <>
            {isLoadingTemplate ? (
              <div className="flex-1 flex items-center justify-center">
                <div className="text-center">
                  <Loader2 className="w-8 h-8 text-accent animate-spin mx-auto mb-3" />
                  <p className="text-sm text-muted-foreground">Loading template...</p>
                </div>
              </div>
            ) : (
              <TemplateEditor
                // Remount when target id changes so internal state syncs to new template.
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
