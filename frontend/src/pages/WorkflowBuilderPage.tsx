import {
  useState, useCallback, useRef, useEffect, type DragEvent,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { workflowAPI, documentTypesAPI, usersAPI } from "@/services/api";
import {
  Plus, GripVertical, Trash2, ChevronDown, ChevronUp,
  Save, GitBranch, Loader2, X, ArrowDown,
  Settings2, Eye, AlertCircle, Info, TriangleAlert,
  Clock, FileText, CheckCircle2, Copy, Layers,
  Search, MoreVertical, Zap, Shield,
  Users, Calendar, ExternalLink, RefreshCw,
  FolderTree, LayoutTemplate, Sparkles, Check,
  ChevronRight, Building2, Award, List, User,
} from "lucide-react";
import { toast } from "react-toastify";
import clsx from "clsx";

// ── Types (aligned with Django serializers) ───────────────────────────────────

interface WorkflowStep {
  id?: string;
  order: number;
  name: string;
  status_label: string;
  assignee_type: "any_role" | "specific_user";
  assignee_role: string;
  assignee_user: string | null;
  assignee_user_name?: string;  // READ ONLY - from serializer
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

interface AppUser {
  id: string;
  full_name: string;
  email: string;
  role: string;
}

// ── Constants ──────────────────────────────────────────────────────────────────

const ROLES = [
  { value: "admin",   label: "Administrator", color: "#6366f1", icon: Shield, description: "Full system access" },
  { value: "finance", label: "Finance Staff",  color: "#0ea5e9", icon: Building2, description: "Financial approvals" },
  { value: "auditor", label: "Auditor",        color: "#f59e0b", icon: Award, description: "Compliance review" },
  { value: "viewer",  label: "Viewer",         color: "#10b981", icon: Eye, description: "Read-only access" },
];

const CURRENCIES = ["USD", "EUR", "GBP", "KES", "ZAR", "NGN", "GHS", "AED", "INR", "JPY", "CAD", "AUD", "CHF", "CNY"];
const STATUS_PRESETS = [
  "Draft", "Pending Approval", "Pending Finance Review", "Pending Senior Review",
  "Pending Board Approval", "Pending Legal Review", "Awaiting Sign-off",
  "Under Review", "Conditional Approval", "Rejected", "Approved", "Archived",
];
const TEMPLATE_CATEGORIES = [
  "Financial", "Legal", "HR", "Procurement", "IT", "Operations", "Executive", "Compliance", "Sales", "Marketing"
];

const ROLE_COLORS: Record<string, string> = {
  admin: "#6366f1", finance: "#0ea5e9", auditor: "#f59e0b", viewer: "#10b981",
};

function uid() { return Math.random().toString(36).slice(2, 10); }

function blankStep(): WorkflowStep {
  return {
    order: 0,
    name: "",
    status_label: "Pending Approval",
    assignee_type: "any_role",
    assignee_role: "finance",
    assignee_user: null,
    sla_hours: 48,
    allow_resubmit: true,
    instructions: "",
  };
}

/**
 * Strip read-only fields before sending to API
 * assignee_user_name is read-only from serializer
 */
function stepToPayload(step: WorkflowStep): Partial<WorkflowStep> {
  const { assignee_user_name, ...rest } = step as any;
  return rest;
}

// ── Styled Components ──────────────────────────────────────────────────────────

const inp = "w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition placeholder-slate-400";

function Label({ children, required, tooltip }: { children: React.ReactNode; required?: boolean; tooltip?: string }) {
  return (
    <div className="flex items-center gap-1.5 mb-1.5">
      <label className="text-xs font-semibold text-slate-600 uppercase tracking-wide">
        {children}{required && <span className="text-red-500 ml-0.5">*</span>}
      </label>
      {tooltip && (
        <div className="group relative">
          <Info className="w-3 h-3 text-slate-400 cursor-help" />
          <div className="absolute left-0 bottom-full mb-2 hidden group-hover:block bg-slate-800 text-white text-xs rounded px-2 py-1 whitespace-nowrap z-10">
            {tooltip}
          </div>
        </div>
      )}
    </div>
  );
}

function SlaBadge({ hours }: { hours: number }) {
  const color = hours <= 24 ? "bg-red-50 text-red-600 border-red-200"
    : hours <= 72 ? "bg-amber-50 text-amber-600 border-amber-200"
    : "bg-slate-100 text-slate-500 border-slate-200";
  const label = hours < 24 ? `${hours}h` : hours % 24 === 0 ? `${hours / 24}d` : `${Math.floor(hours / 24)}d ${hours % 24}h`;
  return (
    <span className={clsx("inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border", color)}>
      <Clock className="w-3 h-3" />{label}
    </span>
  );
}

// ── SVG Flow Preview ───────────────────────────────────────────────────────────

function FlowPreview({ steps, name }: { steps: WorkflowStep[]; name: string }) {
  const NW = 240, NH = 85, GAP = 55, PAD = 28;
  const total = steps.length + 2;
  const svgH = PAD * 2 + total * NH + (total - 1) * GAP;
  const svgW = NW + PAD * 2;
  const cx = PAD + NW / 2;
  const ny = (i: number) => PAD + i * (NH + GAP);

  if (steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-80 text-slate-400 gap-4 bg-gradient-to-b from-slate-50 to-white rounded-xl">
        <div className="w-20 h-20 rounded-full bg-slate-100 flex items-center justify-center">
          <GitBranch className="w-10 h-10 text-slate-300" />
        </div>
        <p className="text-sm font-medium">No steps configured</p>
        <p className="text-xs text-slate-400">Add steps to visualize the approval flow</p>
      </div>
    );
  }

  return (
    <div className="overflow-auto flex justify-center py-8 bg-gradient-to-br from-slate-50 to-white rounded-xl">
      <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`} style={{ fontFamily: "system-ui,sans-serif" }}>
        <defs>
          <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="#94a3b8" />
          </marker>
          <marker id="arr-green" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="#22c55e" />
          </marker>
          <marker id="arr-blue" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="#3b82f6" />
          </marker>
          <filter id="sh"><feDropShadow dx="0" dy="3" stdDeviation="4" floodColor="#00000015" /></filter>
          <filter id="glow">
            <feGaussianBlur stdDeviation="3" result="coloredBlur" />
            <feMerge>
              <feMergeNode in="coloredBlur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <linearGradient id="startGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#f0fdf4" />
            <stop offset="100%" stopColor="#dcfce7" />
          </linearGradient>
          <linearGradient id="endGrad" x1="0%" y1="0%" x2="100%" y2="100%">
            <stop offset="0%" stopColor="#eff6ff" />
            <stop offset="100%" stopColor="#dbeafe" />
          </linearGradient>
        </defs>

        {/* START */}
        {(() => {
          const y = ny(0); return (
            <g>
              <rect x={PAD} y={y} width={NW} height={NH} rx={42}
                fill="url(#startGrad)" stroke="#86efac" strokeWidth={2} filter="url(#sh)" />
              <circle cx={cx} cy={y + 26} r="14" fill="#22c55e" opacity="0.15" />
              <circle cx={cx} cy={y + 26} r="7" fill="#22c55e" filter="url(#glow)" />
              <text x={cx} y={y + 55} textAnchor="middle" fontSize={13} fill="#15803d" fontWeight={700}>Document Submitted</text>
              <text x={cx} y={y + 73} textAnchor="middle" fontSize={9} fill="#86efac" fontWeight={600} letterSpacing={2}>START</text>
              <line x1={cx} y1={y + NH} x2={cx} y2={y + NH + GAP} stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="6 5" markerEnd="url(#arr)" />
            </g>
          );
        })()}

        {/* STEPS */}
        {steps.map((step, i) => {
          const y = ny(i + 1);
          const rc = ROLE_COLORS[step.assignee_role] ?? "#6366f1";
          const isLast = i === steps.length - 1;
          const assigneeLabel = step.assignee_type === "any_role"
            ? (ROLES.find(r => r.value === step.assignee_role)?.label ?? step.assignee_role)
            : (step.assignee_user_name ?? "Specific user");
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
                ? <text x={PAD + 52} y={y + 32} fontSize={13} fill="#1e293b" fontWeight={700}>{stepName}</text>
                : <text x={PAD + 52} y={y + 32} fontSize={12} fill="#94a3b8" fontStyle="italic">Unnamed step</text>}
              <g transform={`translate(${PAD + 52}, ${y + 52})`}>
                <circle cx="0" cy="0" r="6" fill={rc} opacity="0.2" />
                <circle cx="0" cy="0" r="3" fill={rc} />
                <text x="12" y="3" fontSize={10.5} fill="#64748b">
                  {step.assignee_type === "any_role" ? `Role: ${assigneeLabel}` : `User: ${assigneeLabel}`}
                </text>
              </g>
              <rect x={PAD + NW - 72} y={y + 14} width="64" height="20" rx="10" fill="#f8fafc" stroke="#e2e8f0" strokeWidth="0.5" />
              <text x={PAD + NW - 40} y={y + 27.5} textAnchor="middle" fontSize={9} fill="#64748b">⏱ SLA {step.sla_hours}h</text>
              <text x={PAD + NW - 12} y={y + 65} textAnchor="end" fontSize={9} fill="#94a3b8" fontStyle="italic">→ {statusLbl}</text>
              {!isLast && (
                <g>
                  <line x1={cx} y1={y + NH} x2={cx} y2={y + NH + GAP - 10}
                    stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="6 5" markerEnd="url(#arr)" />
                  <path d={`M${cx - 10},${y + NH + GAP - 16} L${cx},${y + NH + GAP - 6} L${cx + 10},${y + NH + GAP - 16}`}
                    fill="none" stroke="#94a3b8" strokeWidth="1.5" strokeLinecap="round" />
                </g>
              )}
            </g>
          );
        })}

        {/* END */}
        {(() => {
          const y = ny(steps.length + 1); return (
            <g>
              <line x1={cx} y1={ny(steps.length) + NH} x2={cx} y2={y}
                stroke="#3b82f6" strokeWidth={1.5} strokeDasharray="6 5" markerEnd="url(#arr-blue)" />
              <rect x={PAD} y={y} width={NW} height={NH} rx={42}
                fill="url(#endGrad)" stroke="#93c5fd" strokeWidth={2} filter="url(#sh)" />
              <circle cx={cx} cy={y + 26} r="14" fill="#3b82f6" opacity="0.15" />
              <circle cx={cx} cy={y + 26} r="7" fill="#3b82f6" filter="url(#glow)" />
              <text x={cx} y={y + 55} textAnchor="middle" fontSize={13} fill="#1d4ed8" fontWeight={700}>Document Approved</text>
              <text x={cx} y={y + 73} textAnchor="middle" fontSize={9} fill="#93c5fd" fontWeight={600} letterSpacing={2}>END</text>
            </g>
          );
        })()}
      </svg>
    </div>
  );
}

// ── StepCard Component ─────────────────────────────────────────────────────────

function StepCard({
  step, index, users, isDragOver, onChange, onRemove,
  onDragStart, onDragOver, onDragEnd, onDrop,
}: {
  step: WorkflowStep;
  index: number;
  users: AppUser[];
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
  const rc = ROLE_COLORS[step.assignee_role] ?? "#6366f1";

  return (
    <div
      draggable
      onDragStart={onDragStart}
      onDragOver={onDragOver}
      onDragEnd={onDragEnd}
      onDrop={onDrop}
      className={clsx(
        "rounded-xl border transition-all bg-white overflow-hidden select-none group",
        isDragOver ? "border-indigo-400 ring-2 ring-indigo-200 shadow-lg scale-[1.01]" : "border-slate-200 hover:border-slate-300 shadow-sm hover:shadow-md"
      )}
    >
      <div className="flex items-center gap-2.5 px-4 py-3 bg-gradient-to-r from-slate-50 to-white border-b border-slate-100">
        <span className="cursor-grab text-slate-300 hover:text-slate-500 transition-colors active:cursor-grabbing">
          <GripVertical className="w-4 h-4" />
        </span>
        <div className="w-7 h-7 rounded-full text-white text-xs font-bold flex items-center justify-center shadow-sm" style={{ background: rc }}>
          {index + 1}
        </div>
        <input
          value={step.name}
          onChange={e => onChange({ name: e.target.value })}
          className="flex-1 bg-transparent text-sm font-semibold text-slate-800 outline-none placeholder-slate-300 py-1"
          placeholder="Step name, e.g. Finance Manager Review"
        />
        <SlaBadge hours={step.sla_hours} />
        <div className="flex items-center gap-0.5 ml-1">
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            className={clsx("p-1.5 rounded transition-colors", showAdvanced ? "text-indigo-500 bg-indigo-50" : "text-slate-400 hover:text-slate-600 hover:bg-slate-100")}
          >
            <Settings2 className="w-3.5 h-3.5" />
          </button>
          <button onClick={() => setExpanded(!expanded)} className="p-1.5 text-slate-400 hover:text-slate-600 rounded hover:bg-slate-100">
            {expanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
          </button>
          <button onClick={onRemove} className="p-1.5 text-slate-300 hover:text-red-500 rounded hover:bg-red-50 transition-colors">
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

            <div>
              <Label required tooltip="Who is responsible for this approval step?">Assignment type</Label>
              <div className="flex gap-2">
                <button
                  onClick={() => onChange({ assignee_type: "any_role", assignee_user: null })}
                  className={clsx("flex-1 px-3 py-2 text-sm rounded-lg border transition-all flex items-center justify-center gap-2",
                    step.assignee_type === "any_role"
                      ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  )}
                >
                  <Users className="w-3.5 h-3.5" /> Role-based
                </button>
                <button
                  onClick={() => onChange({ assignee_type: "specific_user", assignee_role: "", assignee_user: null })}
                  className={clsx("flex-1 px-3 py-2 text-sm rounded-lg border transition-all flex items-center justify-center gap-2",
                    step.assignee_type === "specific_user"
                      ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                      : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                  )}
                >
                  <User className="w-3.5 h-3.5" /> Specific user
                </button>
              </div>
            </div>

            {step.assignee_type === "any_role" ? (
              <div>
                <Label required>Select role</Label>
                <div className="grid grid-cols-2 gap-2">
                  {ROLES.map(r => (
                    <button
                      key={r.value}
                      onClick={() => onChange({ assignee_role: r.value })}
                      className={clsx("flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-all",
                        step.assignee_role === r.value
                          ? "border-indigo-300 bg-indigo-50 text-indigo-700"
                          : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
                      )}
                    >
                      <r.icon className="w-3.5 h-3.5" />
                      {r.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <div>
                <Label required>Select user</Label>
                <select
                  value={step.assignee_user ?? ""}
                  onChange={e => onChange({ assignee_user: e.target.value || null })}
                  className={inp}
                >
                  <option value="">— Select user —</option>
                  {users.map(u => (
                    <option key={u.id} value={u.id}>
                      {u.full_name} · {ROLES.find(r => r.value === u.role)?.label || u.role}
                    </option>
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
                    className="w-full h-1.5 bg-slate-200 rounded-lg appearance-none cursor-pointer accent-indigo-600"
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
                <span className="text-xs text-slate-400 w-16">
                  {Math.floor(step.sla_hours / 24)}d {step.sla_hours % 24}h
                </span>
              </div>
            </div>
          </div>

          {showAdvanced && (
            <div className="pt-3 border-t border-slate-100">
              <p className="text-xs font-medium text-slate-500 mb-3 uppercase tracking-wider flex items-center gap-2">
                <Settings2 className="w-3 h-3" /> Advanced settings
              </p>
              <div className="flex items-start gap-3">
                <input
                  type="checkbox"
                  id={`rs-${step.id || index}`}
                  checked={step.allow_resubmit}
                  onChange={e => onChange({ allow_resubmit: e.target.checked })}
                  className="mt-0.5 w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                />
                <label htmlFor={`rs-${step.id || index}`} className="text-sm text-slate-700 leading-snug cursor-pointer">
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

// ── Template Card ──────────────────────────────────────────────────────────────

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
          ? "border-indigo-500 bg-indigo-50/30 shadow-md"
          : "border-slate-200 bg-white hover:border-indigo-300 hover:shadow-md"
      )}
    >
      <div className="flex items-start justify-between mb-2">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-100 to-indigo-200 flex items-center justify-center">
            <LayoutTemplate className="w-4 h-4 text-indigo-600" />
          </div>
          <div>
            <p className="font-semibold text-slate-800 text-sm">{template.name}</p>
          </div>
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onClone(); }}
          className="opacity-0 group-hover:opacity-100 p-1.5 text-slate-400 hover:text-indigo-600 rounded-lg transition-all"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>
      {template.description && (
        <p className="text-xs text-slate-500 line-clamp-2 mb-3">{template.description}</p>
      )}
      <div className="flex items-center gap-2 text-xs text-slate-400">
        <GitBranch className="w-3 h-3" />
        <span>{template.step_count} step{template.step_count !== 1 ? 's' : ''}</span>
      </div>
    </div>
  );
}

// ── Routing Rules Panel ────────────────────────────────────────────────────────

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
          <h3 className="font-semibold text-slate-800 text-sm flex items-center gap-2">
            <Settings2 className="w-4 h-4 text-indigo-500" />
            Amount-based routing rules
          </h3>
          <p className="text-xs text-slate-500 mt-0.5 max-w-md">
            Route high-value documents to different approval workflows based on amount thresholds.
            Rules are evaluated in order of threshold (lowest first). Threshold 0 = catch-all.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors shadow-sm"
        >
          <Plus className="w-3.5 h-3.5" /> Add rule
        </button>
      </div>

      <div className="p-3 bg-gradient-to-r from-blue-50 to-indigo-50 border border-blue-100 rounded-lg">
        <div className="flex items-start gap-2 text-xs text-blue-700">
          <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
          <span>When a document is submitted, the workflow engine selects the rule with the highest threshold ≤ document amount. This template will be used for documents matching this rule.</span>
        </div>
      </div>

      {showAdd && (
        <div className="rounded-xl border-2 border-indigo-200 bg-indigo-50/30 p-4 space-y-3">
          <h4 className="text-sm font-semibold text-slate-800 flex items-center gap-2">
            <Plus className="w-3.5 h-3.5 text-indigo-500" /> New routing rule
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
                  <option key={dt.id} value={dt.id}>
                    {dt.name}
                  </option>
                ))}
              </select>
              <p className="text-xs text-slate-400 mt-1">
                Documents of this type will use this template when the amount threshold is met.
              </p>
            </div>
            <div>
              <Label>Minimum amount (≥)</Label>
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400">$</span>
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
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors"
            >
              {createRule.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Create rule
            </button>
            <button
              onClick={() => setShowAdd(false)}
              className="px-4 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="space-y-2">
          {[1, 2].map(i => <div key={i} className="h-16 bg-slate-100 rounded-lg animate-pulse" />)}
        </div>
      )}

      {!isLoading && sortedRules.length === 0 && !showAdd && (
        <div className="text-center py-12 bg-slate-50 rounded-xl">
          <div className="w-12 h-12 rounded-full bg-slate-100 flex items-center justify-center mx-auto mb-3">
            <GitBranch className="w-6 h-6 text-slate-300" />
          </div>
          <p className="text-sm font-medium text-slate-500">No routing rules</p>
          <p className="text-xs text-slate-400 mt-1">
            Add rules to route documents from other document types to this template based on amount thresholds.
          </p>
        </div>
      )}

      {sortedRules.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider px-1">Rules pointing to this template ({sortedRules.length})</p>
          {sortedRules.map((rule, idx) => {
            const threshold = Number(rule.amount_threshold);
            const isCatchAll = threshold === 0;
            return (
              <div key={rule.id} className="flex items-center gap-3 p-3 rounded-xl bg-white border border-slate-200 hover:border-indigo-200 transition-all group">
                <div className={clsx(
                  "w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold",
                  isCatchAll ? "bg-slate-100 text-slate-500" : "bg-indigo-100 text-indigo-600"
                )}>
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-sm font-medium text-slate-800">
                      {rule.label || (isCatchAll ? "Default (catch-all)" : `≥ ${threshold.toLocaleString()} ${rule.currency}`)}
                    </p>
                    <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
                      {rule.document_type_name}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {isCatchAll
                      ? "Applies when no higher threshold matches"
                      : `Documents from ${rule.document_type_name} with amount ≥ ${threshold.toLocaleString()} ${rule.currency} use this template`}
                  </p>
                </div>
                <button
                  onClick={() => deleteRule.mutate(rule.id)}
                  disabled={deleteRule.isPending}
                  className="opacity-0 group-hover:opacity-100 p-1.5 text-slate-400 hover:text-red-500 rounded-lg hover:bg-red-50 transition-all"
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

// ── Template Editor ────────────────────────────────────────────────────────────

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
    template?.steps?.sort((a, b) => a.order - b.order).map(s => ({ ...s })) ?? []
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

  const saveMutation = useMutation({
    mutationFn: (payload: { name: string; description: string; steps: Partial<WorkflowStep>[] }) =>
      template
        ? workflowAPI.updateTemplate(template.id, payload)
        : workflowAPI.createTemplate(payload),
    onSuccess: async ({ data }) => {
      toast.success(template ? "Template saved" : "Template created");
      setIsDirty(false);

      if (!template && docType) {
        // For new templates, assign to the current document type
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
      const message = err?.response?.data?.detail || err?.response?.data?.name?.[0] || "Save failed";
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
    mutationFn: (stepIds: string[]) =>
      workflowAPI.reorderSteps(template!.id, stepIds),
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

      // Persist order if template exists and all steps have IDs
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
    if (!name.trim()) {
      toast.error("Template name is required");
      return;
    }
    if (steps.length === 0) {
      toast.error("Add at least one approval step");
      return;
    }
    for (const s of steps) {
      if (!s.name.trim()) {
        toast.error(`Step ${s.order} needs a name`);
        return;
      }
      if (s.assignee_type === "any_role" && !s.assignee_role) {
        toast.error(`"${s.name}" needs a role`);
        return;
      }
      if (s.assignee_type === "specific_user" && !s.assignee_user) {
        toast.error(`"${s.name}" needs a user`);
        return;
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
        <div className="flex items-center gap-2 px-3 py-2 mb-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 flex-shrink-0 animate-pulse">
          <TriangleAlert className="w-3.5 h-3.5" /> Unsaved changes
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200 mb-4 flex-shrink-0">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className="mt-1 w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-600 shadow-lg flex items-center justify-center flex-shrink-0">
            <FileText className="w-5 h-5 text-white" />
          </div>
          <div className="flex-1 min-w-0">
            {docType && (
              <p className="text-xs font-medium text-indigo-600 bg-indigo-50 px-2 py-0.5 rounded-full inline-block mb-1">
                {docType.name}
              </p>
            )}
            <input
              value={name}
              onChange={e => { setName(e.target.value); setIsDirty(true); }}
              className="w-full text-lg font-bold text-slate-900 bg-transparent border-0 outline-none placeholder-slate-300 p-0"
              placeholder="Template name…"
            />
            <input
              value={description}
              onChange={e => { setDescription(e.target.value); setIsDirty(true); }}
              className="w-full text-sm text-slate-500 bg-transparent border-0 outline-none placeholder-slate-300 p-0 mt-1"
              placeholder="Short description (optional)"
            />
          </div>
        </div>
        <div className="flex items-center gap-2">
          {!template && (
            <button
              onClick={() => setShowTemplateLibrary(!showTemplateLibrary)}
              className="flex items-center gap-2 px-3 py-2 text-sm font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors"
            >
              <Layers className="w-4 h-4" /> Browse templates
            </button>
          )}
          <button
            onClick={handleSave}
            disabled={saveMutation.isPending || (!isDirty && !!template)}
            className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-gradient-to-r from-indigo-600 to-indigo-700 text-white rounded-lg hover:from-indigo-700 hover:to-indigo-800 disabled:opacity-50 transition-all shadow-sm"
          >
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            {template ? "Save Changes" : "Create Template"}
          </button>
        </div>
      </div>

      {/* Template Library Browser */}
      {showTemplateLibrary && (
        <div className="mb-4 p-4 bg-slate-50 rounded-xl border border-slate-200">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <Layers className="w-4 h-4 text-indigo-500" />
              Template Library
            </h3>
            <button onClick={() => setShowTemplateLibrary(false)} className="p-1 text-slate-400 hover:text-slate-600">
              <X className="w-4 h-4" />
            </button>
          </div>
        {allTemplates === undefined ? (
          <div className="flex items-center justify-center py-10">
            <Loader2 className="w-6 h-6 text-indigo-500 animate-spin" />
          </div>
        ) : allTemplates.length === 0 ? (
          <div className="text-center py-10 text-slate-400">
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
      <div className="border-b border-slate-200 mb-4 flex gap-1 flex-shrink-0">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={clsx(
              "flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-t-lg transition-all",
              activeTab === id
                ? "bg-white text-indigo-600 border-b-2 border-indigo-500 shadow-sm"
                : "text-slate-500 hover:text-slate-700 hover:bg-slate-50"
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
            <div className="flex flex-col items-center justify-center py-20 text-slate-400 gap-4 bg-slate-50 rounded-xl border-2 border-dashed border-slate-200">
              <div className="w-20 h-20 rounded-full bg-slate-100 flex items-center justify-center">
                <GitBranch className="w-10 h-10 text-slate-300" />
              </div>
              <div className="text-center">
                <p className="text-sm font-medium text-slate-600">No approval steps yet</p>
                <p className="text-xs text-slate-400 mt-1">Define the approval chain for {docType?.name || "this"} workflow</p>
              </div>
            </div>
          )}
          {steps.map((step, i) => (
            <div key={step.id || i}>
              <StepCard
                step={step}
                index={i}
                users={users ?? []}
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
                  <ArrowDown className="w-4 h-4 text-slate-300" />
                </div>
              )}
            </div>
          ))}
          <button
            onClick={addStep}
            className="w-full mt-2 border-2 border-dashed border-slate-200 rounded-xl py-4 text-sm text-slate-500 hover:border-indigo-300 hover:text-indigo-600 hover:bg-indigo-50/30 flex items-center justify-center gap-2 transition-all group"
          >
            <Plus className="w-4 h-4 group-hover:scale-110 transition-transform" /> Add approval step
          </button>
          {steps.length > 0 && (
            <p className="text-center text-xs text-slate-400 pb-3 flex items-center justify-center gap-1">
              <GripVertical className="w-3 h-3" /> Drag steps to reorder the approval chain
            </p>
          )}
        </div>
      )}

      {activeTab === "preview" && (
        <div className="flex-1 overflow-y-auto min-h-0 bg-gradient-to-br from-slate-50 to-white rounded-xl border border-slate-100">
          <div className="p-4 border-b border-slate-100 bg-white rounded-t-xl sticky top-0 z-10">
            <div className="flex items-center justify-between flex-wrap gap-3">
              <div>
                <p className="text-sm font-semibold text-slate-800">{name || "Untitled template"}</p>
                <div className="flex items-center gap-2 mt-1">
                  <span className="text-xs text-slate-400">{docType?.name || "Global Template"}</span>
                  <span className="text-xs text-slate-300">•</span>
                  <span className="text-xs text-slate-400">{steps.length} step{steps.length !== 1 ? 's' : ''}</span>
                </div>
              </div>
              <div className="flex items-center gap-3 flex-wrap">
                {ROLES.map(r => (
                  <span key={r.value} className="flex items-center gap-1.5 text-xs text-slate-500">
                    <span className="w-2.5 h-2.5 rounded-full" style={{ background: r.color }} />
                    {r.label}
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

// ── Document Type Detail Modal ─────────────────────────────────────────────────

function DocTypeDetailModal({
  docType,
  onClose,
  onAssignTemplate,
  onCreateTemplate,
  templates,
  isLoading,
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
      <div className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-slate-200 bg-gradient-to-r from-slate-50 to-white sticky top-0 z-10">
          <div>
            <h2 className="text-lg font-bold text-slate-800 flex items-center gap-2">
              <FileText className="w-5 h-5 text-indigo-500" />
              {docType.name}
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Code: {docType.code} · Prefix: {docType.reference_prefix}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 overflow-y-auto">
          {/* Current Primary Template Status */}
          <div className={clsx(
            "mb-6 p-4 rounded-xl",
            docType.workflow_template ? "bg-green-50 border border-green-100" : "bg-amber-50 border border-amber-100"
          )}>
            <div className="flex items-start gap-3">
              {docType.workflow_template ? (
                <CheckCircle2 className="w-5 h-5 text-green-600 mt-0.5 flex-shrink-0" />
              ) : (
                <AlertCircle className="w-5 h-5 text-amber-600 mt-0.5 flex-shrink-0" />
              )}
              <div className="flex-1">
                <p className="text-sm font-medium">
                  {docType.workflow_template ? "Primary Template Assigned" : "No Primary Template Assigned"}
                </p>
                {currentPrimaryTemplate && (
                  <div className="mt-2 p-2 bg-white rounded-lg border border-green-200">
                    <p className="text-sm font-medium text-slate-800">{currentPrimaryTemplate.name}</p>
                    {currentPrimaryTemplate.description && (
                      <p className="text-xs text-slate-500 mt-0.5">{currentPrimaryTemplate.description}</p>
                    )}
                    <p className="text-xs text-slate-400 mt-1">
                      {currentPrimaryTemplate.step_count} step{currentPrimaryTemplate.step_count !== 1 ? 's' : ''}
                    </p>
                  </div>
                )}
                <p className="text-xs text-slate-500 mt-1">
                  The primary template is used for documents that don't match any amount-based routing rules.
                </p>
              </div>
            </div>
          </div>

          {/* Template Selection Section */}
          <div className="mb-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <LayoutTemplate className="w-4 h-4 text-indigo-500" />
                Available Templates
                <span className="text-xs font-normal text-slate-400">
                  ({activeTemplates.length} total)
                </span>
              </h3>
              <button
                onClick={onCreateTemplate}
                className="flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors"
              >
                <Plus className="w-3.5 h-3.5" /> Create New
              </button>
            </div>

            {isLoading ? (
              <div className="space-y-2">
                {[1, 2, 3].map(i => (
                  <div key={i} className="h-24 bg-slate-100 rounded-xl animate-pulse" />
                ))}
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
                          ? "border-indigo-400 bg-indigo-50/50 shadow-sm"
                          : "border-slate-200 hover:border-indigo-200 hover:bg-slate-50",
                        isCurrentPrimary && !isSelected && "border-green-200 bg-green-50/30"
                      )}
                    >
                      {/* Selection indicator */}
                      {isSelected && (
                        <div className="absolute top-3 right-3">
                          <div className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center">
                            <Check className="w-3 h-3 text-white" />
                          </div>
                        </div>
                      )}

                      <div className="flex items-start gap-3 pr-8">
                        <div className={clsx(
                          "w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0",
                          isCurrentPrimary ? "bg-green-100" : "bg-indigo-100"
                        )}>
                          <LayoutTemplate className={clsx(
                            "w-5 h-5",
                            isCurrentPrimary ? "text-green-600" : "text-indigo-600"
                          )} />
                        </div>

                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-semibold text-slate-800 text-sm">
                              {template.name}
                            </span>
                            {isCurrentPrimary && (
                              <span className="text-xs px-2 py-0.5 rounded-full bg-green-100 text-green-700">
                                Current Primary
                              </span>
                            )}
                            {template.category && (
                              <span className="text-xs px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                                {template.category}
                              </span>
                            )}
                          </div>

                          {template.description && (
                            <p className="text-xs text-slate-500 mt-1 line-clamp-2">
                              {template.description}
                            </p>
                          )}

                          <div className="flex items-center gap-3 mt-2">
                            <span className="text-xs text-slate-400 flex items-center gap-1">
                              <GitBranch className="w-3 h-3" /> {template.step_count} steps
                            </span>
                            {template.updated_at && (
                              <span className="text-xs text-slate-400 flex items-center gap-1">
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
              <div className="text-center py-12 bg-slate-50 rounded-xl">
                <LayoutTemplate className="w-12 h-12 mx-auto mb-3 text-slate-300" />
                <p className="text-sm font-medium text-slate-500">No templates available</p>
                <p className="text-xs text-slate-400 mt-1">
                  Create a template to assign as the primary workflow
                </p>
                <button
                  onClick={onCreateTemplate}
                  className="mt-3 text-sm text-indigo-600 hover:text-indigo-700 font-medium"
                >
                  + Create your first template
                </button>
              </div>
            )}
          </div>

          {/* Info about routing rules */}
          <div className="p-3 bg-blue-50 rounded-xl mb-4">
            <p className="text-xs text-blue-700 flex items-start gap-2">
              <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0" />
              <span>
                You can also create <strong>amount-based routing rules</strong> that send documents
                from this type to different templates based on the document amount.
              </span>
            </p>
          </div>
        </div>

        {/* Action Buttons */}
        <div className="flex gap-3 p-5 border-t border-slate-200 bg-slate-50">
          <button
            onClick={handleAssign}
            disabled={!selectedTemplateId || selectedTemplateId === docType.workflow_template}
            className={clsx(
              "flex-1 px-4 py-2.5 rounded-xl font-medium transition-all shadow-sm",
              !selectedTemplateId || selectedTemplateId === docType.workflow_template
                ? "bg-slate-100 text-slate-400 cursor-not-allowed"
                : "bg-indigo-600 text-white hover:bg-indigo-700"
            )}
          >
            {selectedTemplateId === docType.workflow_template
              ? "✓ Already Primary"
              : "Set as Primary Template"}
          </button>
          <button
            onClick={onClose}
            className="px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl font-medium hover:bg-slate-100 transition-all"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

// Update the main component to reuse TemplateEditor for creation
export default function WorkflowBuilderPage() {
  const qc = useQueryClient();
  const [selectedDocType, setSelectedDocType] = useState<DocumentType | null>(null);
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);
  const [sidebarTab, setSidebarTab] = useState<"doctypes" | "templates">("doctypes");
  const [activeTemplate, setActiveTemplate] = useState<WorkflowTemplate | null>(null);
  const [search, setSearch] = useState("");
  const [showDetailModal, setShowDetailModal] = useState<DocumentType | null>(null);
  const [creatingForDocType, setCreatingForDocType] = useState<DocumentType | null>(null);
  const [viewMode, setViewMode] = useState<"list" | "grid">("list");

  // Fetch document types
  const { data: docTypes, isLoading: dtLoading } = useQuery<DocumentType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then(r => r.data.results ?? r.data as DocumentType[]),
  });

  // Fetch all templates for library
  const { data: allTemplates, isLoading: templatesLoading } = useQuery<WorkflowTemplate[]>({
    queryKey: ["workflow-templates"],
    queryFn: () => workflowAPI.listTemplates().then(r => r.data.results ?? r.data as WorkflowTemplate[]),
  });

  // Determine which template ID to fetch
  const effectiveTemplateId = editingTemplateId || selectedDocType?.workflow_template || null;

  // Fetch the selected template
  const { data: fetchedTemplate, isLoading: templateLoading, isError: templateError } = useQuery<WorkflowTemplate | null>({
    queryKey: ["workflow-template", effectiveTemplateId],
    queryFn: async () => {
      if (!effectiveTemplateId) return null;
      const response = await workflowAPI.getTemplate(effectiveTemplateId);
      return response.data;
    },
    enabled: !!effectiveTemplateId,
    staleTime: 1000 * 60 * 5,
  });

  const [savedConfirmation, setSavedConfirmation] = useState<{ docTypeName: string; templateName: string } | null>(null);

  // Reset editing state when switching between doc type and template
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
    } catch (error) {
      toast.error("Failed to assign template");
    }
  }, [qc, selectedDocType]);

  // Handle creating a new template for a document type - just open the editor in create mode
  const handleStartCreateForDocType = (docType: DocumentType) => {
    setCreatingForDocType(docType);
    setSelectedDocType(null);
    setEditingTemplateId(null);
    setShowDetailModal(null);
    setSavedConfirmation(null);
  };

  // Update active template when fetched data changes
  useEffect(() => {
    if (fetchedTemplate !== undefined) {
      setActiveTemplate(fetchedTemplate);
    }
  }, [fetchedTemplate]);

  const handleSaved = (t: WorkflowTemplate, isNew: boolean) => {
    if (isNew && creatingForDocType) {
      // New template created for a document type - assign it
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
      // New template created from templates tab
      setSavedConfirmation(null);
      setEditingTemplateId(t.id);
      setActiveTemplate(t);
      toast.success(`Template "${t.name}" created`);
    } else {
      // Existing template updated
      if (selectedDocType) {
        setSelectedDocType(prev => prev ? { ...prev, workflow_template: t.id } : null);
      }
      setActiveTemplate(t);
      toast.success(`Template "${t.name}" saved`);
    }
    qc.invalidateQueries({ queryKey: ["document-types"] });
    qc.invalidateQueries({ queryKey: ["workflow-templates"] });
  };

  const docTypesArray = Array.isArray(docTypes) ? docTypes : [];
  const filteredDocTypes = docTypesArray.filter(dt => 
    dt.name.toLowerCase().includes(search.toLowerCase())
  );
  
  const allTemplatesArray = Array.isArray(allTemplates) ? allTemplates : [];
  const filteredTemplates = allTemplatesArray.filter(t => 
    t.name.toLowerCase().includes(search.toLowerCase())
  );

  const withTemplate = docTypesArray.filter(d => d.workflow_template).length;
  const withoutTemplate = docTypesArray.length - withTemplate;
  
  // Determine what to show in the editor
  const showEditor = selectedDocType || editingTemplateId || creatingForDocType;
  const currentTemplate = creatingForDocType ? null : activeTemplate;
  const isLoadingTemplate = templateLoading && !!effectiveTemplateId && !creatingForDocType;

  // Handle template fetch error
  if (templateError && effectiveTemplateId) {
    toast.error("Failed to load template");
  }

  // Determine the document type for the editor (for display purposes)
  const editorDocType = selectedDocType || creatingForDocType || null;

  return (
    <div className="flex gap-6 h-[calc(100vh-7rem)] min-h-0 bg-slate-50 rounded-2xl p-1">
      {/* Left Panel */}
      <aside className="w-80 flex-shrink-0 flex flex-col gap-4 bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        <div className="p-4 border-b border-slate-100">
          <div className="flex items-center justify-between mb-3">
            <div>
              <h1 className="text-lg font-bold text-slate-800 flex items-center gap-2">
                {sidebarTab === "doctypes" ? (
                  <FolderTree className="w-5 h-5 text-indigo-500" />
                ) : (
                  <LayoutTemplate className="w-5 h-5 text-indigo-500" />
                )}
                {sidebarTab === "doctypes" ? "Document Types" : "Templates"}
              </h1>
              {sidebarTab === "doctypes" ? (
                <p className="text-xs text-slate-400 mt-0.5">
                  {withTemplate} / {docTypesArray.length} have primary templates
                </p>
              ) : (
                <p className="text-xs text-slate-400 mt-0.5">
                  {allTemplatesArray.length} saved template{allTemplatesArray.length !== 1 ? 's' : ''}
                </p>
              )}
            </div>
            {sidebarTab === "templates" && (
              <button
                onClick={() => handleStartCreateForDocType(null as any)}
                className="flex items-center gap-1 px-2 py-1 text-xs bg-indigo-50 text-indigo-600 rounded-lg hover:bg-indigo-100"
              >
                <Plus className="w-3 h-3" /> New
              </button>
            )}
            <button
              onClick={() => setViewMode(viewMode === "list" ? "grid" : "list")}
              className="p-1.5 text-slate-400 hover:text-slate-600 rounded-lg hover:bg-slate-100"
            >
              {viewMode === "list" ? <LayoutTemplate className="w-4 h-4" /> : <List className="w-4 h-4" />}
            </button>
          </div>

          {/* Tab Switcher */}
          <div className="flex bg-slate-100 p-1 rounded-lg mb-4">
            <button
              onClick={() => {
                setSidebarTab("doctypes");
                setSearch("");
              }}
              className={clsx(
                "flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all",
                sidebarTab === "doctypes" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              <FolderTree className="w-3.5 h-3.5" /> Types
            </button>
            <button
              onClick={() => {
                setSidebarTab("templates");
                setSearch("");
              }}
              className={clsx(
                "flex-1 flex items-center justify-center gap-2 py-1.5 text-xs font-medium rounded-md transition-all",
                sidebarTab === "templates" ? "bg-white text-indigo-600 shadow-sm" : "text-slate-500 hover:text-slate-700"
              )}
            >
              <LayoutTemplate className="w-3.5 h-3.5" /> Templates
            </button>
          </div>

          {/* Stats - only for doc types */}
          {sidebarTab === "doctypes" && (
            <div className="flex rounded-lg overflow-hidden border border-slate-200 text-xs mb-4">
              <div className="flex-1 flex items-center gap-1.5 px-3 py-2 bg-green-50">
                <CheckCircle2 className="w-3 h-3 text-green-500" />
                <span className="text-green-700 font-medium">{withTemplate} ready</span>
              </div>
              <div className="flex-1 flex items-center gap-1.5 px-3 py-2 bg-amber-50 border-l border-slate-200">
                <AlertCircle className="w-3 h-3 text-amber-500" />
                <span className="text-amber-700 font-medium">{withoutTemplate} pending</span>
              </div>
            </div>
          )}

          {/* Search */}
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder={sidebarTab === "doctypes" ? "Search document types..." : "Search templates..."}
              className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/40 bg-white placeholder-slate-400"
            />
          </div>
        </div>

        {/* List Content */}
        <div className={clsx(
          "flex-1 overflow-y-auto pb-4 gap-2",
          viewMode === "grid" ? "px-3 grid grid-cols-1" : "px-2 space-y-1"
        )}>
          {(dtLoading || (sidebarTab === "templates" && templatesLoading)) && Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-20 bg-slate-100 rounded-xl animate-pulse" />
          ))}

          {sidebarTab === "doctypes" ? (
            filteredDocTypes.length === 0 && !dtLoading ? (
              <div className="text-center py-12 text-slate-400">
                <FileText className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p className="text-sm font-medium text-slate-500">No document types found</p>
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
                          ? "bg-indigo-50 border-indigo-200 shadow-sm ring-1 ring-indigo-200"
                          : "bg-white border-slate-100 hover:border-slate-200 hover:bg-slate-50"
                      )}
                    >
                      <div className="flex items-start gap-2.5">
                        <div className={clsx(
                          "w-2 h-2 rounded-full flex-shrink-0 mt-1.5",
                          hasTemplate ? "bg-green-400 ring-2 ring-green-100" : "bg-amber-400 ring-2 ring-amber-100"
                        )} />
                        <div className="flex-1 min-w-0">
                          <p className={clsx("font-semibold text-sm truncate", isSelected ? "text-indigo-700" : "text-slate-800")}>
                            {dt.name}
                          </p>
                          <p className="text-xs text-slate-400 mt-0.5 font-mono">
                            {dt.reference_prefix}-XXXXX
                          </p>
                        </div>
                        {!hasTemplate && (
                          <span className="text-xs text-amber-500 font-medium flex-shrink-0 bg-amber-50 px-2 py-0.5 rounded-full">
                            Setup
                          </span>
                        )}
                      </div>
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setShowDetailModal(dt); }}
                      className="absolute right-2 top-1/2 -translate-y-1/2 opacity-0 group-hover:opacity-100 p-1.5 text-slate-400 hover:text-indigo-600 rounded-lg bg-white shadow-sm transition-all"
                    >
                      <MoreVertical className="w-3.5 h-3.5" />
                    </button>
                  </div>
                );
              })
            )
          ) : (
            filteredTemplates.length === 0 && !templatesLoading ? (
              <div className="text-center py-12 text-slate-400">
                <LayoutTemplate className="w-10 h-10 mx-auto mb-3 opacity-20" />
                <p className="text-sm font-medium text-slate-500">No templates found</p>
                <p className="text-xs mt-1">
                  {search ? "Try a different search term" : (
                    <button
                      onClick={() => handleStartCreateForDocType(null as any)}
                      className="text-indigo-600 hover:text-indigo-700"
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
                        ? "bg-indigo-50 border-indigo-200 shadow-sm ring-1 ring-indigo-200"
                        : "bg-white border-slate-100 hover:border-slate-200 hover:bg-slate-50"
                    )}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className="w-8 h-8 rounded-lg bg-indigo-50 flex items-center justify-center flex-shrink-0">
                        <LayoutTemplate className="w-4 h-4 text-indigo-500" />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className={clsx("font-semibold text-sm truncate", isSelected ? "text-indigo-700" : "text-slate-800")}>
                          {t.name}
                        </p>
                        <p className="text-xs text-slate-400 mt-0.5">
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
      <main className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 p-5 overflow-hidden flex flex-col shadow-sm">
        {!showEditor && savedConfirmation && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-5">
            <div className="w-20 h-20 rounded-2xl bg-gradient-to-br from-green-400 to-emerald-500 flex items-center justify-center shadow-lg">
              <CheckCircle2 className="w-10 h-10 text-white" />
            </div>
            <div>
              <p className="text-xl font-semibold text-slate-800">Workflow Created!</p>
              <p className="text-sm text-slate-500 mt-2 max-w-md">
                <span className="font-medium text-indigo-600">{savedConfirmation.templateName}</span> is now the primary template for
                <span className="font-medium"> {savedConfirmation.docTypeName}</span>
              </p>
              <p className="text-xs text-slate-400 mt-2">
                You can now add amount-based routing rules to use different templates for high-value documents.
              </p>
            </div>
            <button
              onClick={() => setSavedConfirmation(null)}
              className="flex items-center gap-2 px-6 py-2.5 bg-gradient-to-r from-indigo-600 to-indigo-700 text-white rounded-xl font-medium shadow-md hover:shadow-lg transition-all"
            >
              Continue <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {!showEditor && !savedConfirmation && (
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-5">
            <div className="w-24 h-24 rounded-2xl bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center">
              <GitBranch className="w-10 h-10 text-slate-300" />
            </div>
            <div>
              <p className="text-lg font-semibold text-slate-600">
                {sidebarTab === "doctypes" ? "Select a document type" : "Select or create a template"}
              </p>
              <p className="text-sm text-slate-400 mt-1 max-w-sm">
                {sidebarTab === "doctypes" 
                  ? "Each document type has a primary workflow template. Select one from the left panel to edit its workflow."
                  : "Templates define approval steps. Select an existing template or click 'New' to create one."}
              </p>
            </div>
            {sidebarTab === "doctypes" && withoutTemplate > 0 && (
              <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-700">
                <TriangleAlert className="w-4 h-4" />
                {withoutTemplate} document type{withoutTemplate !== 1 ? 's' : ''} need{withoutTemplate === 1 ? 's' : ''} a primary workflow template
              </div>
            )}
            {sidebarTab === "templates" && (
              <button
                onClick={() => handleStartCreateForDocType(null as any)}
                className="flex items-center gap-2 px-4 py-2.5 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-all shadow-sm"
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
                  <Loader2 className="w-8 h-8 text-indigo-500 animate-spin mx-auto mb-3" />
                  <p className="text-sm text-slate-500">Loading template...</p>
                </div>
              </div>
            ) : (
              <TemplateEditor
                key={creatingForDocType?.id || selectedDocType?.id || editingTemplateId || "new-template"}
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

      {/* Document Type Detail Modal with Full Template Listing */}
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

      {/* Create Template Modal is now handled by the editor itself */}
    </div>
  );
}