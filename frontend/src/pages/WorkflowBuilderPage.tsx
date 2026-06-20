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
  FileSignature, Copy,
  Bell, Mail,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────
type AssigneeType = "group_any" | "group_all" | "group_specific";
type StepType = "approval" | "notification";

interface WorkflowStep {
  id?: string;
  order: number;
  name: string;
  status_label: string;
  step_type: StepType;
  // Approval-step fields
  assignee_type: AssigneeType;
  assignee_group: string | null;
  assignee_group_name?: string;
  assignee_user: string | null;
  assignee_user_name?: string;
  assignee_user_auto?: boolean;
  sla_hours: number;
  allow_resubmit: boolean;
  allow_approve: boolean;
  allow_reject: boolean;
  allow_return: boolean;
  requires_signature: boolean;
  instructions: string;
  // Custom approver email (approval steps)
  approver_email_subject?: string;
  approver_email_body?: string;
  // Notification-step fields
  notify_user?: string | null;
  notify_user_name?: string;
  notify_email?: string;
  notification_subject?: string;
  notification_message?: string;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  document_type: string | null;
  document_type_name?: string | null;
  category?: string;
  is_active: boolean;
  notify_uploader_on_approval?: boolean;
  email_templates?: EmailTemplates;
  steps: WorkflowStep[];
  step_count: number;
  created_by?: { id: string; full_name: string; email: string };
  created_at?: string;
  updated_at?: string;
}

type EmailTemplateKey =
  | "workflow_complete"
  | "action_approved"
  | "action_rejected"
  | "action_returned"
  | "action_held"
  | "action_released"
  | "hold_ending"
  | "hold_expired"
  | "sla_warning"
  | "sla_overdue";

interface EmailTemplateEntry {
  subject: string;
  body: string;
}

type EmailTemplates = Partial<Record<EmailTemplateKey, EmailTemplateEntry>>;

const EMAIL_TEMPLATE_DEFS: {
  key: EmailTemplateKey;
  label: string;
  description: string;
  group: "Uploader" | "Completion" | "Approver";
  placeholders: string[];
  defaultSubject: string;
  defaultBody: string;
}[] = [
  {
    key: "action_approved",
    label: "Step approved",
    description: "Sent to the uploader when an approval step is completed.",
    group: "Uploader",
    placeholders: ["{uploader_name}", "{document_title}", "{document_ref}", "{actor_name}", "{step_name}", "{comment}", "{document_url}"],
    defaultSubject: "DMS — Document approved: {document_ref}",
    defaultBody: "Hello {uploader_name},\n\nYour document has been approved.\n\n  Document: {document_title}\n  Reference: {document_ref}\n  Approved by: {actor_name}\n  Step: {step_name}\n\nLog in to DMS to view the document status.\n",
  },
  {
    key: "action_rejected",
    label: "Step rejected",
    description: "Sent to the uploader when a document is rejected.",
    group: "Uploader",
    placeholders: ["{uploader_name}", "{document_title}", "{document_ref}", "{actor_name}", "{step_name}", "{comment}", "{document_url}"],
    defaultSubject: "DMS — Document rejected: {document_ref}",
    defaultBody: "Hello {uploader_name},\n\nYour document has been rejected and requires revision.\n\n  Document: {document_title}\n  Reference: {document_ref}\n  Rejected by: {actor_name}\n  Step: {step_name}\n\nPlease make the required changes and resubmit.\n",
  },
  {
    key: "action_returned",
    label: "Returned for review",
    description: "Sent to the uploader when a document is sent back.",
    group: "Uploader",
    placeholders: ["{uploader_name}", "{document_title}", "{document_ref}", "{actor_name}", "{step_name}", "{return_destination}", "{comment}", "{document_url}"],
    defaultSubject: "DMS — Document returned for review: {document_ref}",
    defaultBody: "Hello {uploader_name},\n\nYour document has been returned and requires your attention.\n\n  Document: {document_title}\n  Reference: {document_ref}\n  Returned by: {actor_name}\n  Returned to: {return_destination}\n\nPlease make the required changes and resubmit for approval.\n",
  },
  {
    key: "action_held",
    label: "Placed on hold",
    description: "Sent to the uploader when a document is put on hold.",
    group: "Uploader",
    placeholders: ["{uploader_name}", "{document_title}", "{document_ref}", "{actor_name}", "{hold_duration}", "{comment}", "{document_url}"],
    defaultSubject: "DMS — Document on hold: {document_ref}",
    defaultBody: "Hello {uploader_name},\n\nYour document has been placed on hold during the approval process.\n\n  Document: {document_title}\n  Reference: {document_ref}\n  Held by: {actor_name}\n  Duration: {hold_duration}\n\nThe document will resume processing after the hold period, or when manually released.\n",
  },
  {
    key: "action_released",
    label: "Hold released",
    description: "Sent to the uploader when a hold is released.",
    group: "Uploader",
    placeholders: ["{uploader_name}", "{document_title}", "{document_ref}", "{actor_name}", "{step_name}", "{document_url}"],
    defaultSubject: "DMS — Hold released: {document_ref}",
    defaultBody: "Hello {uploader_name},\n\nThe hold on your document has been released.\n\n  Document: {document_title}\n  Reference: {document_ref}\n  Released by: {actor_name}\n  Step: {step_name}\n\nThe document is now back in the approval queue.\n",
  },
  {
    key: "workflow_complete",
    label: "Workflow finished",
    description: "Sent to the workflow starter when the document is fully approved or rejected.",
    group: "Completion",
    placeholders: ["{recipient_name}", "{document_title}", "{document_ref}", "{outcome}", "{outcome_label}", "{document_url}"],
    defaultSubject: "DMS — Document {outcome}: {document_ref}",
    defaultBody: "Hello {recipient_name},\n\nYour document has been {outcome}.\n\n  Document: {document_title}\n  Reference: {document_ref}\n  Status: {outcome_label}\n\nLog in to DMS to view the document.\n",
  },
  {
    key: "sla_warning",
    label: "SLA approaching",
    description: "Sent to an approver before their task deadline.",
    group: "Approver",
    placeholders: ["{approver_name}", "{document_title}", "{document_ref}", "{step_name}", "{due_at}", "{document_url}"],
    defaultSubject: "DMS — SLA approaching: {document_ref}",
    defaultBody: "Hello {approver_name},\n\nAn approval task is approaching its SLA deadline.\n\n  Document: {document_title}\n  Reference: {document_ref}\n  Step: {step_name}\n  Due by: {due_at}\n\nPlease log in to DMS to action this request.\n",
  },
  {
    key: "sla_overdue",
    label: "SLA overdue",
    description: "Sent to an approver when their task passes its deadline.",
    group: "Approver",
    placeholders: ["{approver_name}", "{document_title}", "{document_ref}", "{step_name}", "{due_at}", "{document_url}"],
    defaultSubject: "DMS — SLA overdue: {document_ref}",
    defaultBody: "Hello {approver_name},\n\nAn approval task has passed its SLA deadline and requires urgent action.\n\n  Document: {document_title}\n  Reference: {document_ref}\n  Step: {step_name}\n  Was due: {due_at}\n\nPlease log in to DMS immediately.\n",
  },
  {
    key: "hold_ending",
    label: "Hold ending soon",
    description: "Sent to an approver before a scheduled hold expires.",
    group: "Approver",
    placeholders: ["{approver_name}", "{document_title}", "{document_ref}", "{step_name}", "{hold_ends_at}", "{document_url}"],
    defaultSubject: "DMS — Hold ending soon: {document_ref}",
    defaultBody: "Hello {approver_name},\n\nA hold you scheduled is approaching its end.\n\n  Document: {document_title}\n  Reference: {document_ref}\n  Step: {step_name}\n  Hold ends: {hold_ends_at}\n\nPlease log in to DMS if you need to action or extend the task.\n",
  },
  {
    key: "hold_expired",
    label: "Hold expired",
    description: "Sent to an approver when a hold auto-releases.",
    group: "Approver",
    placeholders: ["{approver_name}", "{document_title}", "{document_ref}", "{step_name}", "{document_url}"],
    defaultSubject: "DMS — Hold expired, action required: {document_ref}",
    defaultBody: "Hello {approver_name},\n\nThe hold period you set on a document has expired.\n\n  Document: {document_title}\n  Reference: {document_ref}\n  Step: {step_name}\n\nPlease log in to DMS to action this approval.\n",
  },
];

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
const HOD_GROUP_NAME = "HOD";

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

function isHodGroupName(name: string | null | undefined) {
  return (name ?? "").trim().toLowerCase() === HOD_GROUP_NAME.toLowerCase();
}

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

function normalizeStepType(value: unknown): StepType {
  return value === "notification" ? "notification" : "approval";
}

function normalizeStep(step: WorkflowStep): WorkflowStep {
  return {
    ...step,
    step_type: normalizeStepType((step as any).step_type),
    assignee_type: normalizeAssigneeType(step.assignee_type),
    assignee_group: isUuidLike(step.assignee_group) ? step.assignee_group : null,
    assignee_user: isUuidLike(step.assignee_user) ? step.assignee_user : null,
    notify_user: isUuidLike(step.notify_user) ? step.notify_user : (step.notify_user ?? null),
    requires_signature: Boolean(step.requires_signature),
    approver_email_subject: step.approver_email_subject ?? "",
    approver_email_body: step.approver_email_body ?? "",
  };
}

function normalizeEmailTemplates(raw: unknown): EmailTemplates {
  const out: EmailTemplates = {};
  if (!raw || typeof raw !== "object") return out;
  for (const def of EMAIL_TEMPLATE_DEFS) {
    const entry = (raw as Record<string, unknown>)[def.key];
    if (!entry || typeof entry !== "object") continue;
    const subject = typeof (entry as EmailTemplateEntry).subject === "string"
      ? (entry as EmailTemplateEntry).subject
      : "";
    const body = typeof (entry as EmailTemplateEntry).body === "string"
      ? (entry as EmailTemplateEntry).body
      : "";
    if (subject || body) {
      out[def.key] = { subject, body };
    }
  }
  return out;
}

function emailTemplatesToPayload(templates: EmailTemplates): EmailTemplates {
  const out: EmailTemplates = {};
  for (const [key, val] of Object.entries(templates)) {
    const subject = val?.subject?.trim() ?? "";
    const body = val?.body?.trim() ?? "";
    if (subject || body) {
      out[key as EmailTemplateKey] = {
        ...(subject ? { subject } : {}),
        ...(body ? { body } : {}),
      } as EmailTemplateEntry;
    }
  }
  return out;
}

function normalizeTemplate(template: WorkflowTemplate): WorkflowTemplate {
  return {
    ...template,
    document_type: isUuidLike(template.document_type) ? template.document_type : null,
    notify_uploader_on_approval: template.notify_uploader_on_approval ?? true,
    email_templates: normalizeEmailTemplates(template.email_templates),
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
    step_type: "approval",
    assignee_type: "group_any", assignee_group: null, assignee_user: null,
    sla_hours: 48, allow_resubmit: true, allow_approve: true, allow_reject: true, allow_return: true,
    requires_signature: false, instructions: "",
    approver_email_subject: "", approver_email_body: "",
  };
}

function blankNotificationStep(): WorkflowStep {
  return {
    order: 0, name: "Send Notification", status_label: "Notification Sent",
    step_type: "notification",
    assignee_type: "group_any", assignee_group: null, assignee_user: null,
    sla_hours: 1,
    allow_resubmit: false, allow_approve: false, allow_reject: false, allow_return: false,
    requires_signature: false,
    instructions: "",
    approver_email_subject: "", approver_email_body: "",
    notify_user: null,
    notify_email: "",
    notification_subject: "Workflow update",
    notification_message: "Hello,\n\nThis is an automated notification regarding the document workflow.\n\nThank you.",
  };
}

function stepToPayload(step: WorkflowStep): Partial<WorkflowStep> {
  // Strip UI-only display name fields before sending to the API
  const {
    assignee_user_name: _aun,
    assignee_group_name: _agn,
    notify_user_name: _nun,
    ...rest
  } = normalizeStep(step) as any;
  void _aun; void _agn; void _nun;

  if (rest.step_type === "notification") {
    // Notification steps: clear all approval semantics
    rest.allow_approve      = false;
    rest.allow_reject       = false;
    rest.allow_return       = false;
    rest.allow_resubmit     = false;
    rest.requires_signature = false;
    rest.assignee_user_auto = false;
    rest.assignee_group     = null;
    rest.assignee_user      = null;
    rest.approver_email_subject = "";
    rest.approver_email_body    = "";
    return rest;
  }

  // Approval step: clear notification fields
  rest.notify_user            = null;
  rest.notify_email           = "";
  rest.notification_subject   = "";
  rest.notification_message   = "";

  if (rest.assignee_type !== "group_specific") {
    rest.assignee_user      = null;
    rest.assignee_user_auto = false;
  } else {
    rest.assignee_user_auto = Boolean(rest.assignee_user_auto);
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

type RuleFormValues = { amount_min: string; amount_max: string; currency: string; label: string };

function RuleFormFields({ values, onChange }: {
  values: RuleFormValues;
  onChange: (patch: Partial<RuleFormValues>) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <div>
        <Label required>Minimum amount</Label>
        <input
          type="number" min={0} step="0.01"
          value={values.amount_min}
          onChange={e => onChange({ amount_min: e.target.value })}
          className={inp}
          placeholder="0"
        />
        <p className="text-[11px] text-muted-foreground mt-1">
          Starts matching from {formatMoney(Number(values.amount_min || 0), values.currency)}
        </p>
      </div>
      <div>
        <Label>Maximum amount</Label>
        <input
          type="number" min={0} step="0.01"
          value={values.amount_max}
          onChange={e => onChange({ amount_max: e.target.value })}
          className={inp}
          placeholder="Leave blank for no upper limit"
        />
        <p className="text-[11px] text-muted-foreground mt-1">
          {values.amount_max
            ? `Stops at ${formatMoney(Number(values.amount_max), values.currency)}`
            : "Leave blank to cover everything above the minimum"}
        </p>
      </div>
      <div>
        <Label>Currency</Label>
        <select
          value={values.currency}
          onChange={e => onChange({ currency: e.target.value })}
          className={inp}
        >
          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      <div className="col-span-2">
        <Label>Label (optional)</Label>
        <input
          value={values.label}
          onChange={e => onChange({ label: e.target.value })}
          className={inp}
          placeholder="e.g., High-value transactions"
        />
      </div>
    </div>
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
  onInsertNotificationAfter,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  groups: Group[];
  onChange: (patch: Partial<WorkflowStep>) => void;
  onClose: () => void;
  onDelete: () => void;
  onInsertNotificationAfter?: () => void;
}) {
  const selectedGroup = groups.find((group) => group.id === step.assignee_group);
  const isHodGroupSelected = isHodGroupName(selectedGroup?.name ?? step.assignee_group_name);
  const needsGroupMember = step.assignee_type === "group_specific" && !isHodGroupSelected;

  const { data: groupMembers = [], isLoading: membersLoading } = useQuery<AppUser[]>({
    queryKey: ["group-members", step.assignee_group],
    queryFn: async () => {
      const r = await groupsAPI.members(step.assignee_group!);
      const raw: GroupMembershipApiItem[] = r.data?.results ?? r.data ?? [];
      return raw.map((item) => item?.user ?? item).filter((u): u is AppUser => Boolean(u?.id && u?.email));
    },
    enabled: !!step.assignee_group,
  });

  const { data: groupDetail } = useQuery<any>({
    queryKey: ["group", step.assignee_group],
    queryFn: () => groupsAPI.get(step.assignee_group!).then((r) => r.data),
    enabled: !!step.assignee_group,
  });

  const effectiveGroupMembers = useMemo(() => {
    const head = groupDetail?.head as AppUser | undefined;
    if (!head || !head.id) return groupMembers;
    if (groupMembers.some((u) => u.id === head.id)) return groupMembers;
    return [head, ...groupMembers];
  }, [groupDetail?.head, groupMembers]);

  const color = getGroupColor(step.assignee_group);

  // Force HOD group to group_any
  useEffect(() => {
    if (!isHodGroupSelected) return;
    if (step.assignee_type !== "group_any" || step.assignee_user || step.assignee_user_name) {
      onChange({
        assignee_type: "group_any",
        assignee_user: null,
        assignee_user_name: undefined,
      });
    }
  }, [isHodGroupSelected, onChange, step.assignee_type, step.assignee_user, step.assignee_user_name]);

  // Default specific assignee to group's designated approver if present
  useEffect(() => {
    if (step.assignee_type !== "group_specific") return;
    if (step.assignee_user) return;
    if (step.assignee_user_auto === false) return;
    const head = groupDetail?.head;
    if (head && head.id) {
      onChange({ assignee_user: head.id, assignee_user_name: head.full_name, assignee_user_auto: true });
    }
  }, [step.assignee_type, step.assignee_user, step.assignee_user_auto, groupDetail?.head, onChange]);

  // Whether the custom approver email section is expanded
  const [showApproverEmail, setShowApproverEmail] = useState(
    Boolean(step.approver_email_subject || step.approver_email_body)
  );

  return (
    <aside className="w-[420px] flex-shrink-0 flex flex-col bg-card border border-border rounded-xl shadow-elegant overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between p-4 border-b border-border bg-muted/40">
        <div className="flex items-center gap-3">
          <div
            className="w-9 h-9 rounded-lg flex items-center justify-center text-white text-sm font-bold shadow-sm"
            style={{ backgroundColor: step.step_type === "notification" ? "#0ea5e9" : color }}
          >
            {step.step_type === "notification" ? <Bell className="w-4 h-4" /> : index + 1}
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">
              Edit {step.step_type === "notification" ? "notification" : "approval"} step {index + 1}
            </h3>
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
            placeholder={step.step_type === "notification" ? "e.g. Notify Requester" : "e.g. Finance Manager Review"}
          />
        </div>

        <div>
          <Label>{step.step_type === "notification" ? "Document status after notification" : "Document status while pending"}</Label>
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

        {/* ── Approval step fields ────────────────────────────────────────── */}
        {step.step_type === "approval" && (<>
          <div className="grid grid-cols-1 gap-4 p-4 rounded-lg bg-muted/40 border border-border">
            <div>
              <Label required>Approver group</Label>
              <select
                value={step.assignee_group ?? ""}
                onChange={e => {
                  const id = e.target.value || null;
                  const g = groups.find(x => x.id === id);
                  const isHod = isHodGroupName(g?.name);
                  onChange({
                    assignee_group: id,
                    assignee_group_name: g?.name,
                    assignee_type: isHod ? "group_any" : step.assignee_type,
                    assignee_user: null,
                    assignee_user_name: undefined,
                    assignee_user_auto: undefined,
                  });
                }}
                className={inp}
              >
                <option value="">Select group</option>
                {groups.map(g => (
                  <option key={g.id} value={g.id}>
                    {isHodGroupName(g.name) ? "HOD - uploader department head" : g.name}
                  </option>
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
                    assignee_user_auto: next === "group_specific" ? step.assignee_user_auto : undefined,
                  });
                }}
                disabled={isHodGroupSelected}
                className={inp}
              >
                {ASSIGNEE_MODES.map(m => (
                  <option key={m.value} value={m.value}>{m.label} — {m.description}</option>
                ))}
              </select>
              {isHodGroupSelected && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  The assignee will be picked automatically from the uploader&apos;s department head.
                </p>
              )}
            </div>

            {needsGroupMember && (
              <div>
                <Label required>Specific member</Label>
                <select
                  value={step.assignee_user ?? ""}
                  onChange={e => {
                    const id = e.target.value || null;
                    const u = groupMembers.find(x => x.id === id);
                    onChange({ assignee_user: id, assignee_user_name: u?.full_name, assignee_user_auto: false });
                  }}
                  disabled={!step.assignee_group || membersLoading}
                  className={inp}
                >
                  <option value="">{membersLoading ? "Loading members..." : "Select member"}</option>
                  {effectiveGroupMembers.map(u => (
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
                type="range" min={1} max={168}
                value={step.sla_hours}
                onChange={e => onChange({ sla_hours: Number(e.target.value) })}
                className="flex-1 accent-primary"
              />
              <input
                type="number" min={1} max={720}
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
            <div className="space-y-2">
              <button
                type="button"
                onClick={() => onChange({ allow_approve: !step.allow_approve, requires_signature: step.allow_approve ? false : step.requires_signature })}
                className={clsx(
                  "w-full flex items-center justify-between px-4 py-2.5 rounded-xl border transition-all",
                  step.allow_approve
                    ? "bg-teal/5 border-teal/30 text-teal shadow-sm"
                    : "bg-muted/30 border-border text-muted-foreground"
                )}
              >
                <span className="text-xs font-semibold">Allow Approval</span>
                <div className={clsx("w-8 h-4 rounded-full relative transition-colors", step.allow_approve ? "bg-teal" : "bg-muted-foreground/30")}>
                  <div className={clsx("absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform", step.allow_approve ? "translate-x-4" : "translate-x-0.5")} />
                </div>
              </button>

              <button
                type="button"
                onClick={() => onChange({ requires_signature: !step.requires_signature, allow_approve: true })}
                className={clsx(
                  "w-full flex items-center justify-between px-4 py-2.5 rounded-xl border transition-all",
                  step.requires_signature
                    ? "bg-primary/5 border-primary/30 text-primary shadow-sm"
                    : "bg-muted/30 border-border text-muted-foreground"
                )}
              >
                <span className="text-xs font-semibold flex items-center gap-2">
                  <FileSignature className="w-4 h-4" />
                  Require E-Signature
                </span>
                <div className={clsx("w-8 h-4 rounded-full relative transition-colors", step.requires_signature ? "bg-primary" : "bg-muted-foreground/30")}>
                  <div className={clsx("absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform", step.requires_signature ? "translate-x-4" : "translate-x-0.5")} />
                </div>
              </button>

              <button
                type="button"
                onClick={() => onChange({ allow_reject: !step.allow_reject })}
                className={clsx(
                  "w-full flex items-center justify-between px-4 py-2.5 rounded-xl border transition-all",
                  step.allow_reject
                    ? "bg-destructive/5 border-destructive/30 text-destructive shadow-sm"
                    : "bg-muted/30 border-border text-muted-foreground"
                )}
              >
                <span className="text-xs font-semibold">Allow Rejection</span>
                <div className={clsx("w-8 h-4 rounded-full relative transition-colors", step.allow_reject ? "bg-destructive" : "bg-muted-foreground/30")}>
                  <div className={clsx("absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform", step.allow_reject ? "translate-x-4" : "translate-x-0.5")} />
                </div>
              </button>

              <button
                type="button"
                onClick={() => onChange({ allow_return: !step.allow_return })}
                className={clsx(
                  "w-full flex items-center justify-between px-4 py-2.5 rounded-xl border transition-all",
                  step.allow_return
                    ? "bg-accent/5 border-accent/30 text-accent shadow-sm"
                    : "bg-muted/30 border-border text-muted-foreground"
                )}
              >
                <span className="text-xs font-semibold">Allow Return to Previous</span>
                <div className={clsx("w-8 h-4 rounded-full relative transition-colors", step.allow_return ? "bg-accent" : "bg-muted-foreground/30")}>
                  <div className={clsx("absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform", step.allow_return ? "translate-x-4" : "translate-x-0.5")} />
                </div>
              </button>
            </div>
          </div>

          <div>
            <Label>Instructions for approver</Label>
            <textarea
              value={step.instructions}
              onChange={e => onChange({ instructions: e.target.value })}
              rows={3}
              className={clsx(inp, "resize-none")}
              placeholder="Guidelines for the approver..."
            />
          </div>

          {/* ── Custom approver email (collapsible) ────────────────────────── */}
          <div className="rounded-xl border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => setShowApproverEmail(v => !v)}
              className="w-full flex items-center justify-between px-4 py-3 bg-muted/40 hover:bg-muted/60 transition-colors"
            >
              <span className="flex items-center gap-2 text-xs font-semibold text-foreground">
                <Mail className="w-3.5 h-3.5 text-muted-foreground" />
                Custom approver email
                {(step.approver_email_subject || step.approver_email_body) && (
                  <span className="text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded-full font-medium">
                    Configured
                  </span>
                )}
              </span>
              <span className="text-[11px] text-muted-foreground">
                {showApproverEmail ? "Hide" : "Customise"}
              </span>
            </button>

            {showApproverEmail && (
              <div className="p-4 space-y-3 border-t border-border">
                <div className="flex items-start gap-2 p-2.5 rounded-lg bg-blue-50 border border-blue-200">
                  <Mail className="w-3.5 h-3.5 text-blue-600 mt-0.5 flex-shrink-0" />
                  <p className="text-[11px] text-blue-900 leading-relaxed">
                    Override the default task-assignment email for this step. Leave blank to use the system default.
                    Available placeholders: <code className="font-mono bg-blue-100 px-1 rounded">{"{approver_name}"}</code>,{" "}
                    <code className="font-mono bg-blue-100 px-1 rounded">{"{document_title}"}</code>,{" "}
                    <code className="font-mono bg-blue-100 px-1 rounded">{"{document_ref}"}</code>,{" "}
                    <code className="font-mono bg-blue-100 px-1 rounded">{"{step_name}"}</code>,{" "}
                    <code className="font-mono bg-blue-100 px-1 rounded">{"{instructions}"}</code>,{" "}
                    <code className="font-mono bg-blue-100 px-1 rounded">{"{document_url}"}</code>.
                  </p>
                </div>
                <div>
                  <Label>Email subject</Label>
                  <input
                    value={step.approver_email_subject ?? ""}
                    onChange={e => onChange({ approver_email_subject: e.target.value })}
                    className={inp}
                    placeholder="e.g. Action required: {document_title}"
                  />
                </div>
                <div>
                  <Label>Email body</Label>
                  <textarea
                    value={step.approver_email_body ?? ""}
                    onChange={e => onChange({ approver_email_body: e.target.value })}
                    rows={7}
                    className={clsx(inp, "resize-none font-mono text-xs leading-relaxed")}
                    placeholder={`Dear {approver_name},\n\nYou have a document awaiting your review.\n\nDocument: {document_title} ({document_ref})\nStep: {step_name}\n\n{instructions}\n\nReview it here: {document_url}\n\nThank you.`}
                  />
                </div>
              </div>
            )}
          </div>

          {/* ── "Add notification after this step" shortcut ────────────────── */}
          {onInsertNotificationAfter && (
            <button
              type="button"
              onClick={onInsertNotificationAfter}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl border-2 border-dashed border-sky-300 bg-sky-50/50 text-sky-700 hover:bg-sky-50 hover:border-sky-400 text-xs font-semibold transition-all"
            >
              <Bell className="w-3.5 h-3.5" />
              Send notification after this step
            </button>
          )}
        </>)}

        {/* ── Notification step fields ──────────────────────────────────────── */}
        {step.step_type === "notification" && (
          <NotificationStepFields
            step={step}
            groups={groups}
            onChange={onChange}
          />
        )}
      </div>
    </aside>
  );
}

// ── Notification Step Fields ──────────────────────────────────────────────────
function NotificationStepFields({
  step,
  groups,
  onChange,
}: {
  step: WorkflowStep;
  groups: Group[];
  onChange: (patch: Partial<WorkflowStep>) => void;
}) {
  const [recipientMode, setRecipientMode] = useState<"user" | "email">(
    step.notify_user ? "user" : (step.notify_email ? "email" : "user")
  );

  const { data: allMembers = [] } = useQuery<AppUser[]>({
    queryKey: ["notif-group-members", step.assignee_group],
    queryFn: async () => {
      if (!step.assignee_group) return [];
      const r = await groupsAPI.members(step.assignee_group);
      const raw: GroupMembershipApiItem[] = r.data?.results ?? r.data ?? [];
      return raw.map((item) => item?.user ?? item).filter((u): u is AppUser => Boolean(u?.id && u?.email));
    },
    enabled: !!step.assignee_group,
  });

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 p-3 rounded-lg bg-sky-50 border border-sky-200">
        <Mail className="w-4 h-4 text-sky-600 mt-0.5 flex-shrink-0" />
        <p className="text-[11px] text-sky-900 leading-relaxed">
          This step sends an email and <strong>immediately advances</strong> the workflow — no approver action required.
        </p>
      </div>

      <div>
        <Label required>Recipient</Label>
        <div className="flex bg-muted rounded-lg p-1 mb-2">
          <button
            type="button"
            onClick={() => setRecipientMode("user")}
            className={clsx(
              "flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-all",
              recipientMode === "user" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"
            )}
          >
            Group member
          </button>
          <button
            type="button"
            onClick={() => setRecipientMode("email")}
            className={clsx(
              "flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-all",
              recipientMode === "email" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"
            )}
          >
            Custom email
          </button>
        </div>

        {recipientMode === "user" ? (
          <div className="space-y-2">
            <select
              value={step.assignee_group ?? ""}
              onChange={e => {
                const id = e.target.value || null;
                const g = groups.find(x => x.id === id);
                onChange({
                  assignee_group: id,
                  assignee_group_name: g?.name,
                  notify_user: null,
                  notify_user_name: undefined,
                  notify_email: "",
                });
              }}
              className={inp}
            >
              <option value="">Select group</option>
              {groups.map(g => (
                <option key={g.id} value={g.id}>{g.name}</option>
              ))}
            </select>
            <select
              value={step.notify_user ?? ""}
              onChange={e => {
                const id = e.target.value || null;
                const u = allMembers.find(x => x.id === id);
                onChange({ notify_user: id, notify_user_name: u?.full_name, notify_email: "" });
              }}
              disabled={!step.assignee_group}
              className={inp}
            >
              <option value="">{!step.assignee_group ? "Pick a group first" : "Select member"}</option>
              {allMembers.map(u => (
                <option key={u.id} value={u.id}>{u.full_name} ({u.email})</option>
              ))}
            </select>
          </div>
        ) : (
          <input
            type="email"
            value={step.notify_email ?? ""}
            onChange={e => onChange({ notify_email: e.target.value, notify_user: null, notify_user_name: undefined })}
            className={inp}
            placeholder="name@example.com"
          />
        )}
      </div>

      <div>
        <Label required>Email subject</Label>
        <input
          value={step.notification_subject ?? ""}
          onChange={e => onChange({ notification_subject: e.target.value })}
          className={inp}
          placeholder="e.g. Document approved — action complete"
        />
      </div>

      <div>
        <Label required>Email message</Label>
        <textarea
          value={step.notification_message ?? ""}
          onChange={e => onChange({ notification_message: e.target.value })}
          rows={8}
          className={clsx(inp, "resize-none font-mono text-xs leading-relaxed")}
          placeholder={"Hello,\n\nYour document has progressed..."}
        />
        <p className="text-[11px] text-muted-foreground mt-1">
          Plain text. The recipient will receive this message by email when this step is reached.
        </p>
      </div>
    </div>
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
  for (let i = 0; i < stepCount; i++) {
    positions.push({ x: 0, y: (i + 1) * (NODE_H + 80) });
  }
  return positions;
}

function FlowchartEditor({
  steps,
  groups: _groups,
  selectedIndex,
  onSelectIndex,
  onStepsChange: _onStepsChange,
  onAddStep,
}: {
  steps: WorkflowStep[];
  groups: Group[];
  selectedIndex: number | null;
  onSelectIndex: (i: number | null) => void;
  onStepsChange: (steps: WorkflowStep[]) => void;
  onAddStep: (kind: StepType) => void;
}) {
  const [showAddMenu, setShowAddMenu] = useState(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const [transform, setTransform] = useState({ x: 80, y: 40, k: 1 });
  const [positions, setPositions] = useState<NodePos[]>(() => defaultPositions(steps.length));

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

  const dragRef = useRef<{ kind: "node" | "pan" | null; index?: number; startX: number; startY: number; orig: NodePos | { x: number; y: number } }>({
    kind: null, startX: 0, startY: 0, orig: { x: 0, y: 0 },
  });

  const onPointerDownNode = (i: number, e: React.PointerEvent) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = {
      kind: "node", index: i,
      startX: e.clientX, startY: e.clientY,
      orig: { ...positions[i] },
    };
  };

  const onPointerDownCanvas = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    onSelectIndex(null);
    dragRef.current = {
      kind: "pan",
      startX: e.clientX, startY: e.clientY,
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
      return { k: newK, x: mx - (mx - t.x) * ratio, y: my - (my - t.y) * ratio };
    });
  };

  const zoomBy = (factor: number) => {
    setTransform(t => ({ ...t, k: Math.min(2, Math.max(0.4, t.k * factor)) }));
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

  const connections = useMemo(() => {
    const lines: { id: string; d: string }[] = [];
    const startCenter = { x: 0, y: 0 };
    const startBottom = { x: startCenter.x, y: startCenter.y + ANCHOR_H / 2 };
    const stepTop    = (p: NodePos) => ({ x: p?.x ?? 0, y: (p?.y ?? 0) - NODE_H / 2 });
    const stepBottom = (p: NodePos) => ({ x: p?.x ?? 0, y: (p?.y ?? 0) + NODE_H / 2 });

    if (steps.length > 0) {
      const p0 = positions[0];
      if (p0) lines.push({ id: "start", d: bezierPath(startBottom, stepTop(p0)) });
      for (let i = 0; i < steps.length - 1; i++) {
        const pA = positions[i]; const pB = positions[i + 1];
        if (pA && pB) lines.push({ id: `s-${i}`, d: bezierPath(stepBottom(pA), stepTop(pB)) });
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

  const bounds = useMemo(() => {
    const validNodes = positions.slice(0, steps.length).filter(Boolean) as NodePos[];
    const xs = validNodes.map(p => p.x);
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
        <span className="text-[11px] text-muted-foreground">Drag canvas to pan · Drag nodes to rearrange · ⌘/Ctrl + scroll to zoom</span>
      </div>

      <div
        ref={wrapperRef}
        className="absolute inset-0 cursor-grab active:cursor-grabbing select-none"
        style={{
          backgroundImage: "radial-gradient(hsl(var(--border)) 1px, transparent 1px)",
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
          {/* SVG connection lines */}
          <svg
            style={{
              position: "absolute",
              left: bounds.minX, top: bounds.minY,
              width: bounds.w, height: bounds.h,
              pointerEvents: "none", overflow: "visible",
            }}
          >
            <defs>
              <marker id="wf-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
                <path d="M0,0 L10,5 L0,10 z" fill="hsl(var(--muted-foreground))" />
              </marker>
            </defs>
            <g transform={`translate(${-bounds.minX} ${-bounds.minY})`}>
              {connections.map(c => (
                <path key={c.id} d={c.d} fill="none"
                  stroke="hsl(var(--muted-foreground))" strokeWidth={1.8}
                  strokeOpacity={0.7} markerEnd="url(#wf-arrow)" />
              ))}
            </g>
          </svg>

          {/* Start anchor */}
          <div className="absolute" style={{ left: -ANCHOR_W / 2, top: -ANCHOR_H / 2, width: ANCHOR_W, height: ANCHOR_H }}>
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
            const isNotification = step.step_type === "notification";
            return (
              <div
                key={step.id || `n-${i}`}
                className={clsx("absolute group", isSelected && "z-20")}
                style={{ left: pos.x - NODE_W / 2, top: pos.y - NODE_H / 2, width: NODE_W, height: NODE_H }}
                onPointerDown={(e) => onPointerDownNode(i, e)}
                onClick={(e) => { e.stopPropagation(); onSelectIndex(i); }}
              >
                <div className={clsx(
                  "w-full h-full rounded-2xl bg-card border-2 p-3 cursor-grab active:cursor-grabbing transition-all",
                  isNotification && "border-dashed",
                  isSelected
                    ? (isNotification ? "border-sky-500 shadow-elegant ring-4 ring-sky-200" : "border-accent shadow-elegant ring-4 ring-accent/15")
                    : "border-border shadow-sm hover:shadow-md hover:border-foreground/20"
                )}>
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      <div
                        className="w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold"
                        style={{ backgroundColor: isNotification ? "#0ea5e9" : color }}
                      >
                        {isNotification ? <Bell className="w-3.5 h-3.5" /> : i + 1}
                      </div>
                      <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">
                        {isNotification ? "Notify" : "Step"} {i + 1}
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

                  {isNotification ? (
                    <>
                      <div className="flex items-center gap-1.5 mb-2">
                        <div className="w-5 h-5 rounded flex items-center justify-center bg-sky-100">
                          <Mail className="w-3 h-3 text-sky-600" />
                        </div>
                        <p className="text-[11px] text-muted-foreground truncate flex-1">
                          {step.notify_user_name || step.notify_email || "No recipient"}
                        </p>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-sky-700 bg-sky-100 px-1.5 py-0.5 rounded font-medium">Email only</span>
                        <span className="text-[10px] text-muted-foreground truncate ml-2">
                          {step.notification_subject || "No subject"}
                        </span>
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="flex items-center gap-1.5 mb-2">
                        <div className="w-5 h-5 rounded flex items-center justify-center" style={{ backgroundColor: `${color}22` }}>
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
                          {step.allow_reject  && <span className="w-1.5 h-1.5 rounded-full bg-destructive" title="Reject" />}
                          {step.allow_return  && <span className="w-1.5 h-1.5 rounded-full bg-accent" title="Return" />}
                          {(step.approver_email_subject || step.approver_email_body) && (
                            <Mail className="w-3 h-3 text-primary/60" title="Custom email configured" />
                          )}
                        </div>
                      </div>
                    </>
                  )}
                </div>
              </div>
            );
          })}

          {/* End anchor */}
          <div className="absolute" style={{ left: endX - ANCHOR_W / 2, top: endY - ANCHOR_H / 2, width: ANCHOR_W, height: ANCHOR_H }}>
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

          {/* Add-step floating picker */}
          <div className="absolute" style={{ left: endX + ANCHOR_W / 2 + 20, top: endY - 18 }}>
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setShowAddMenu(v => !v); }}
                className="flex items-center gap-2 px-3 py-2 bg-card border-2 border-dashed border-border rounded-xl text-xs font-medium text-muted-foreground hover:border-accent hover:text-accent hover:bg-accent/10 transition-all shadow-sm"
              >
                <Plus className="w-3.5 h-3.5" /> Add step
              </button>
              {showAddMenu && (
                <div
                  className="absolute left-0 top-full mt-2 w-56 bg-card border border-border rounded-xl shadow-elegant overflow-hidden z-30"
                  onClick={(e) => e.stopPropagation()}
                >
                  <button
                    onClick={() => { onAddStep("approval"); setShowAddMenu(false); }}
                    className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/60 transition-colors"
                  >
                    <div className="w-7 h-7 rounded-md bg-accent/15 text-accent flex items-center justify-center flex-shrink-0">
                      <CheckCircle2 className="w-3.5 h-3.5" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-foreground">Approval step</p>
                      <p className="text-[11px] text-muted-foreground">Requires approver action</p>
                    </div>
                  </button>
                  <button
                    onClick={() => { onAddStep("notification"); setShowAddMenu(false); }}
                    className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-muted/60 transition-colors border-t border-border"
                  >
                    <div className="w-7 h-7 rounded-md bg-sky-100 text-sky-600 flex items-center justify-center flex-shrink-0">
                      <Bell className="w-3.5 h-3.5" />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-foreground">Notification step</p>
                      <p className="text-[11px] text-muted-foreground">Sends a custom email, auto-advances</p>
                    </div>
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Empty state */}
          {steps.length === 0 && (
            <div className="absolute" style={{ left: -140, top: NODE_H }}>
              <div className="flex flex-col gap-2 p-4 bg-card border-2 border-dashed border-border rounded-2xl shadow-sm">
                <p className="text-xs font-semibold text-foreground text-center mb-1">Add your first step</p>
                <button
                  onClick={(e) => { e.stopPropagation(); onAddStep("approval"); }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:border-accent hover:bg-accent/5 text-xs font-medium text-foreground transition-all"
                >
                  <CheckCircle2 className="w-3.5 h-3.5 text-accent" /> Approval step
                </button>
                <button
                  onClick={(e) => { e.stopPropagation(); onAddStep("notification"); }}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg border border-border hover:border-sky-400 hover:bg-sky-50 text-xs font-medium text-foreground transition-all"
                >
                  <Bell className="w-3.5 h-3.5 text-sky-600" /> Notification step
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function bezierPath(a: { x: number; y: number }, b: { x: number; y: number }) {
  const dy = b.y - a.y;
  const dx = b.x - a.x;
  if (Math.abs(dy) >= Math.abs(dx)) {
    const cy = Math.max(40, Math.abs(dy) * 0.4);
    return `M ${a.x} ${a.y} C ${a.x} ${a.y + cy}, ${b.x} ${b.y - cy}, ${b.x} ${b.y}`;
  }
  const cx = Math.max(40, Math.abs(dx) * 0.4);
  return `M ${a.x} ${a.y} C ${a.x + cx} ${a.y}, ${b.x - cx} ${b.y}, ${b.x} ${b.y}`;
}

// ── Routing Rules Panel ───────────────────────────────────────────────────────
// ── Template email settings ───────────────────────────────────────────────────
function TemplateEmailsPanel({
  notifyUploaderOnApproval,
  emailTemplates,
  onNotifyUploaderChange,
  onEmailTemplatesChange,
}: {
  notifyUploaderOnApproval: boolean;
  emailTemplates: EmailTemplates;
  onNotifyUploaderChange: (value: boolean) => void;
  onEmailTemplatesChange: (patch: EmailTemplates) => void;
}) {
  const [expandedKey, setExpandedKey] = useState<EmailTemplateKey | null>(null);

  const grouped = useMemo(() => {
    const groups: Record<string, typeof EMAIL_TEMPLATE_DEFS> = {};
    for (const def of EMAIL_TEMPLATE_DEFS) {
      (groups[def.group] ??= []).push(def);
    }
    return groups;
  }, []);

  const patchTemplate = (key: EmailTemplateKey, patch: Partial<EmailTemplateEntry>) => {
    const current = emailTemplates[key] ?? { subject: "", body: "" };
    onEmailTemplatesChange({
      ...emailTemplates,
      [key]: { ...current, ...patch },
    });
  };

  return (
    <div className="flex-1 overflow-y-auto min-h-0 space-y-6 pb-8">
      <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <p className="text-sm font-semibold text-foreground">Notify uploader on approval</p>
            <p className="text-xs text-muted-foreground mt-1 leading-relaxed">
              When enabled, the document uploader receives an email and in-app notification each time
              an approval step is completed. Reject, return, and hold notifications are always sent.
            </p>
          </div>
          <button
            type="button"
            onClick={() => onNotifyUploaderChange(!notifyUploaderOnApproval)}
            className={clsx(
              "flex-shrink-0 w-11 h-6 rounded-full relative transition-colors mt-0.5",
              notifyUploaderOnApproval ? "bg-accent" : "bg-muted-foreground/30"
            )}
            aria-pressed={notifyUploaderOnApproval}
          >
            <div className={clsx(
              "absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform",
              notifyUploaderOnApproval ? "translate-x-5" : "translate-x-0.5"
            )} />
          </button>
        </div>
      </div>

      <div className="space-y-6">
        {Object.entries(grouped).map(([groupName, defs]) => (
          <div key={groupName}>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {groupName} emails
            </h3>
            <div className="space-y-2">
              {defs.map((def) => {
                const entry = emailTemplates[def.key] ?? { subject: "", body: "" };
                const isConfigured = Boolean(entry.subject?.trim() || entry.body?.trim());
                const isExpanded = expandedKey === def.key;
                return (
                  <div key={def.key} className="rounded-xl border border-border overflow-hidden bg-card">
                    <button
                      type="button"
                      onClick={() => setExpandedKey(isExpanded ? null : def.key)}
                      className="w-full flex items-center justify-between px-4 py-3 bg-muted/30 hover:bg-muted/50 transition-colors text-left"
                    >
                      <span className="flex items-center gap-2 min-w-0">
                        <Mail className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
                        <span className="min-w-0">
                          <span className="block text-xs font-semibold text-foreground">{def.label}</span>
                          <span className="block text-[11px] text-muted-foreground truncate">{def.description}</span>
                        </span>
                        {isConfigured && (
                          <span className="text-[10px] bg-primary/15 text-primary px-1.5 py-0.5 rounded-full font-medium flex-shrink-0">
                            Custom
                          </span>
                        )}
                      </span>
                      <span className="text-[11px] text-muted-foreground flex-shrink-0 ml-2">
                        {isExpanded ? "Hide" : "Edit"}
                      </span>
                    </button>
                    {isExpanded && (
                      <div className="p-4 space-y-3 border-t border-border">
                        <p className="text-[11px] text-muted-foreground leading-relaxed">
                          Leave blank to use the system default. Placeholders:{" "}
                          {def.placeholders.map((ph) => (
                            <code key={ph} className="font-mono bg-muted px-1 rounded mr-1">{ph}</code>
                          ))}
                        </p>
                        <div>
                          <Label>Email subject</Label>
                          <input
                            value={entry.subject}
                            onChange={(e) => patchTemplate(def.key, { subject: e.target.value })}
                            className={inp}
                            placeholder={def.defaultSubject}
                          />
                        </div>
                        <div>
                          <Label>Email body</Label>
                          <textarea
                            value={entry.body}
                            onChange={(e) => patchTemplate(def.key, { body: e.target.value })}
                            rows={8}
                            className={clsx(inp, "resize-none font-mono text-xs leading-relaxed")}
                            placeholder={def.defaultBody}
                          />
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>

      <p className="text-[11px] text-muted-foreground">
        Per-step emails (approver task assignment and in-flow notification steps) are configured on each step in the Workflow tab.
      </p>
    </div>
  );
}

function RoutingRulesPanel({ template }: { template: WorkflowTemplate }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ amount_min: "0", amount_max: "", currency: "USD", label: "" });
  const templateId = template.id;
  const hasDocumentType = Boolean(template.document_type);

  const { data: rules, isLoading } = useQuery<WorkflowRule[]>({
    queryKey: ["workflow-rules", templateId],
    queryFn: () => workflowAPI.listRules({ template: templateId }).then(r => r.data.results ?? r.data),
    enabled: hasDocumentType,
  });

  const createRule = useMutation({
    mutationFn: () => workflowAPI.createRule({
      ...form, template: templateId,
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
      toast.error(formatApiError(err?.response?.data) || "Failed to create rule");
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

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RuleFormValues>({ amount_min: "0", amount_max: "", currency: "USD", label: "" });

  const startEdit = (rule: WorkflowRule) => {
    setShowAdd(false);
    setEditingId(rule.id);
    setEditForm({
      amount_min: String(rule.amount_min ?? "0"),
      amount_max: rule.amount_max == null ? "" : String(rule.amount_max),
      currency: rule.currency, label: rule.label ?? "",
    });
  };

  const updateRule = useMutation({
    mutationFn: () => workflowAPI.updateRule(editingId as string, {
      amount_min: editForm.amount_min || "0",
      amount_max: editForm.amount_max || null,
      currency: editForm.currency, label: editForm.label,
    }),
    onSuccess: () => {
      toast.success("Rule updated");
      qc.invalidateQueries({ queryKey: ["workflow-rules", templateId] });
      setEditingId(null);
    },
    onError: (err: any) => {
      toast.error(formatApiError(err?.response?.data) || "Failed to update rule");
    },
  });

  const sortedRules = useMemo(
    () => [...(rules ?? [])].sort((a, b) => Number(a.amount_min) - Number(b.amount_min)),
    [rules]
  );

  const openAddRule = () => {
    const existingCurrency = rules?.[0]?.currency;
    if (existingCurrency) setForm(f => ({ ...f, currency: existingCurrency }));
    setShowAdd(true);
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
            Rules for this template are automatically scoped to{" "}
            <span className="font-medium text-foreground">{template.document_type_name ?? "its document type"}</span>.
          </p>
        </div>
        {!showAdd && hasDocumentType && (
          <button onClick={openAddRule} className="btn-primary text-xs px-3 py-1.5">
            <Plus className="w-3.5 h-3.5" /> Add rule
          </button>
        )}
      </div>

      {!hasDocumentType && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">Assign a document type to this template first</p>
          <p className="text-xs text-amber-800/80 mt-1">
            Routing rules are linked to the template&apos;s document type.
          </p>
        </div>
      )}

      {showAdd && hasDocumentType && (
        <div className="rounded-xl border-2 border-accent/40 bg-accent/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground">New routing rule</h4>
            <button onClick={() => setShowAdd(false)} className="p-1 rounded hover:bg-muted"><X className="w-4 h-4 text-muted-foreground" /></button>
          </div>
          <RuleFormFields values={form} onChange={(p) => setForm(f => ({ ...f, ...p }))} />
          <div className="flex gap-2 pt-2">
            <button onClick={() => createRule.mutate()} disabled={createRule.isPending} className="btn-primary text-xs">
              {createRule.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Create rule
            </button>
            <button onClick={() => setShowAdd(false)} className="btn-secondary text-xs">Cancel</button>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="space-y-2">{[1, 2].map(i => <div key={i} className="h-16 bg-muted rounded-lg animate-pulse" />)}</div>
      )}

      {!isLoading && hasDocumentType && sortedRules.length === 0 && !showAdd && (
        <div className="text-center py-12 bg-muted/40 rounded-xl border border-dashed border-border">
          <Settings2 className="w-12 h-12 mx-auto mb-3 text-muted-foreground/60" />
          <p className="text-sm font-medium text-foreground">No routing rules yet</p>
          <button onClick={openAddRule} className="btn-secondary text-xs mt-4">
            <Plus className="w-3.5 h-3.5" /> Add your first rule
          </button>
        </div>
      )}

      {sortedRules.length > 0 && (
        <div className="space-y-3">
          {sortedRules.map((rule, idx) => {
            if (editingId === rule.id) {
              return (
                <div key={rule.id} className="rounded-xl border-2 border-accent/40 bg-accent/5 p-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h4 className="text-sm font-semibold text-foreground">Edit routing rule</h4>
                    <button onClick={() => setEditingId(null)} className="p-1 rounded hover:bg-muted"><X className="w-4 h-4 text-muted-foreground" /></button>
                  </div>
                  <RuleFormFields values={editForm} onChange={(p) => setEditForm(f => ({ ...f, ...p }))} />
                  <div className="flex gap-2 pt-2">
                    <button onClick={() => updateRule.mutate()} disabled={updateRule.isPending} className="btn-primary text-xs">
                      {updateRule.isPending && <Loader2 className="w-3 h-3 animate-spin" />} Save changes
                    </button>
                    <button onClick={() => setEditingId(null)} className="btn-secondary text-xs">Cancel</button>
                  </div>
                </div>
              );
            }
            return (
              <div key={rule.id} className="rounded-xl border border-border bg-card px-4 py-3 group hover:border-foreground/20 transition-colors">
                <div className="flex items-start gap-3">
                  <div className="w-8 h-8 rounded-lg bg-accent/15 text-accent flex items-center justify-center text-xs font-semibold shrink-0">{idx + 1}</div>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <p className="text-sm font-semibold text-foreground">{formatRuleRange(rule)}</p>
                      {rule.label && <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{rule.label}</span>}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Matching {rule.document_type_name.toLowerCase()} documents will use this template.
                    </p>
                  </div>
                  <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                    <button onClick={() => startEdit(rule)} className="p-1.5 text-muted-foreground hover:text-accent rounded-lg hover:bg-accent/10 transition-colors">
                      <Edit3 className="w-4 h-4" />
                    </button>
                    <button onClick={() => deleteRule.mutate(rule.id)} disabled={deleteRule.isPending} className="p-1.5 text-muted-foreground hover:text-destructive rounded-lg hover:bg-destructive/10 transition-colors">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
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
  onDuplicate,
  allTemplates: _allTemplates,
  docTypes,
}: {
  template: WorkflowTemplate | null;
  docType?: DocumentType | null;
  onSaved: (t: WorkflowTemplate, isNew: boolean) => void;
  onDuplicate?: () => void;
  allTemplates?: WorkflowTemplate[];
  docTypes?: DocumentType[];
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [steps, setSteps] = useState<WorkflowStep[]>([]);
  const [notifyUploaderOnApproval, setNotifyUploaderOnApproval] = useState(true);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplates>({});
  const [selectedDocumentTypeId, setSelectedDocumentTypeId] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(!template);
  const [activeTab, setActiveTab] = useState<"flow" | "rules" | "emails">("flow");
  const [selectedStepIndex, setSelectedStepIndex] = useState<number | null>(null);

  useEffect(() => {
    setName(template?.name ?? (docType ? `${docType.name} Workflow` : "New Template"));
    setDescription(template?.description ?? "");
    setSteps(
      template?.steps?.slice().sort((a, b) => a.order - b.order).map((s) => ({ ...s })) ?? []
    );
    setNotifyUploaderOnApproval(template?.notify_uploader_on_approval ?? true);
    setEmailTemplates(normalizeEmailTemplates(template?.email_templates));
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
  const canEditDocumentType = !template && !docType;

  const saveMutation = useMutation({
    mutationFn: (payload: {
      name: string; description: string;
      document_type: string | null; is_active: boolean;
      notify_uploader_on_approval: boolean;
      email_templates: EmailTemplates;
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
      toast.error(formatApiError(err?.response?.data) || "Save failed");
    },
  });

  const handleStepsChange = useCallback((newSteps: WorkflowStep[]) => {
    setSteps(newSteps.map((s, i) => ({ ...s, order: i + 1 })));
    setIsDirty(true);
  }, []);

  const handleSave = () => {
    if (!name.trim())               { toast.error("Template name is required"); return; }
    if (!selectedDocumentTypeId)    { toast.error("Choose the document type this template belongs to"); return; }
    if (steps.length === 0)         { toast.error("Add at least one step"); return; }

    const hasApproval = steps.some(s => s.step_type !== "notification");
    if (!hasApproval) { toast.error("Add at least one approval step"); return; }

    const stepsForSave = steps.map((step) => {
      if (step.step_type === "notification") return step;
      const group = (groups ?? []).find((item) => item.id === step.assignee_group);
      if (!isHodGroupName(group?.name ?? step.assignee_group_name)) return step;
      return {
        ...step,
        assignee_type: "group_any" as AssigneeType,
        assignee_group_name: group?.name ?? step.assignee_group_name,
        assignee_user: null, assignee_user_name: undefined,
      };
    });

    for (const s of stepsForSave) {
      if (!s.name.trim()) { toast.error(`Step ${s.order} needs a name`); return; }
      if (s.step_type === "notification") {
        if (!s.notify_user && !(s.notify_email && s.notify_email.trim())) {
          toast.error(`"${s.name}" needs a recipient (user or email)`); return;
        }
        if (s.notify_email && s.notify_email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.notify_email.trim())) {
          toast.error(`"${s.name}" has an invalid email address`); return;
        }
        if (!s.notification_subject || !s.notification_subject.trim()) {
          toast.error(`"${s.name}" needs an email subject`); return;
        }
        if (!s.notification_message || !s.notification_message.trim()) {
          toast.error(`"${s.name}" needs an email message`); return;
        }
        continue;
      }
      if (!s.assignee_group) { toast.error(`"${s.name}" needs a group`); return; }
      if (s.assignee_type === "group_specific" && !s.assignee_user) {
        toast.error(`"${s.name}" needs a specific group member`); return;
      }
      if (!s.allow_approve && !s.allow_reject && !s.allow_return) {
        toast.error(`"${s.name}" must have at least one approver action enabled`); return;
      }
      if (s.requires_signature && !s.allow_approve) {
        toast.error(`"${s.name}" requires approval before it can require a signature`); return;
      }
    }

    saveMutation.mutate({
      name: name.trim(),
      description: description.trim(),
      document_type: selectedDocumentTypeId,
      is_active: template ? template.is_active : true,
      notify_uploader_on_approval: notifyUploaderOnApproval,
      email_templates: emailTemplatesToPayload(emailTemplates),
      steps: stepsForSave.map(stepToPayload),
    });
  };

  const handleAddStep = useCallback((kind: StepType = "approval") => {
    const newStep = {
      ...(kind === "notification" ? blankNotificationStep() : blankStep()),
      order: steps.length + 1,
    };
    const next = [...steps, newStep];
    setSteps(next);
    setIsDirty(true);
    setSelectedStepIndex(next.length - 1);
  }, [steps]);

  const handleInsertNotificationAfter = useCallback((index: number) => {
    const newStep = { ...blankNotificationStep(), order: index + 2 };
    const next = [
      ...steps.slice(0, index + 1),
      newStep,
      ...steps.slice(index + 1),
    ].map((s, i) => ({ ...s, order: i + 1 }));
    setSteps(next);
    setIsDirty(true);
    setSelectedStepIndex(index + 1);
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
              <FolderTree className="w-3 h-3" /> Template scope
            </span>
            {selectedDocumentTypeName && (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-accent bg-accent/20 px-2.5 py-1 rounded-full">
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
            {canEditDocumentType ? (
              <select
                value={selectedDocumentTypeId ?? ""}
                onChange={(e) => { setSelectedDocumentTypeId(e.target.value || null); setIsDirty(true); }}
                className={inp}
              >
                <option value="">Select document type</option>
                {availableDocTypes.map((item) => (
                  <option key={item.id} value={item.id}>{item.name}</option>
                ))}
              </select>
            ) : (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm font-medium text-foreground">
                {selectedDocumentTypeName ?? "No document type assigned"}
              </div>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <div className="flex bg-muted rounded-lg p-1">
            <button
              onClick={() => setActiveTab("flow")}
              className={clsx("px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                activeTab === "flow" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}
            >Workflow</button>
            <button
              onClick={() => setActiveTab("emails")}
              className={clsx("px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                activeTab === "emails" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}
            >Emails</button>
            {template && (
              <button
                onClick={() => setActiveTab("rules")}
                className={clsx("px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                  activeTab === "rules" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}
              >Routing rules</button>
            )}
          </div>
          {isDirty && <span className="text-[11px] text-accent bg-accent/20 px-2 py-1 rounded-md">Unsaved</span>}
          {template && onDuplicate && (
            <button onClick={onDuplicate} className="btn-secondary text-sm">
              <Copy className="w-4 h-4" /> Duplicate
            </button>
          )}
          <button onClick={handleSave} disabled={saveMutation.isPending} className="btn-primary text-sm">
            {saveMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
            Save
          </button>
        </div>
      </div>

      {/* Content */}
      {activeTab === "flow" ? (
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
              onInsertNotificationAfter={
                steps[selectedStepIndex].step_type === "approval"
                  ? () => handleInsertNotificationAfter(selectedStepIndex)
                  : undefined
              }
            />
          )}
        </div>
      ) : activeTab === "emails" ? (
        <TemplateEmailsPanel
          notifyUploaderOnApproval={notifyUploaderOnApproval}
          emailTemplates={emailTemplates}
          onNotifyUploaderChange={(value) => { setNotifyUploaderOnApproval(value); setIsDirty(true); }}
          onEmailTemplatesChange={(next) => { setEmailTemplates(next); setIsDirty(true); }}
        />
      ) : template ? (
        <div className="flex-1 overflow-y-auto min-h-0">
          <RoutingRulesPanel template={normalizeTemplate({
            ...template,
            document_type: selectedDocumentTypeId,
            document_type_name: availableDocTypes.find((item) => item.id === selectedDocumentTypeId)?.name ?? template.document_type_name ?? null,
          })} />
        </div>
      ) : null}
    </div>
  );
}

// ── Duplicate Template Modal ──────────────────────────────────────────────────
function DuplicateTemplateModal({
  template, docTypes, onClose, onDuplicated,
}: {
  template: WorkflowTemplate;
  docTypes: DocumentType[];
  onClose: () => void;
  onDuplicated: (newTemplate: WorkflowTemplate) => void;
}) {
  const [newName, setNewName] = useState(`${template.name} (copy)`);
  const [selectedDocTypeId, setSelectedDocTypeId] = useState<string | null>(template.document_type ?? null);
  const activeDocTypes = useMemo(() => docTypes.filter((d) => d.is_active), [docTypes]);

  const duplicateMutation = useMutation({
    mutationFn: () => workflowAPI.duplicateTemplate(template.id, newName.trim() || undefined),
    onSuccess: async ({ data }) => {
      let cloned = normalizeTemplate(data as WorkflowTemplate);
      if (selectedDocTypeId && selectedDocTypeId !== template.document_type) {
        try {
          const patchRes = await workflowAPI.updateTemplate(cloned.id, {
            name: cloned.name, description: cloned.description,
            document_type: selectedDocTypeId, is_active: true,
            steps: (cloned.steps ?? []).map(stepToPayload),
          });
          cloned = normalizeTemplate(patchRes.data as WorkflowTemplate);
        } catch {
          toast.warning("Duplicated, but could not update document type");
        }
      }
      toast.success(`"${cloned.name}" created`);
      onDuplicated(cloned);
    },
    onError: (err: any) => {
      toast.error(formatApiError(err?.response?.data) || "Duplication failed");
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newName.trim()) { toast.error("Name is required"); return; }
    duplicateMutation.mutate();
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-card rounded-2xl w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent/15 flex items-center justify-center">
              <Copy className="w-4 h-4 text-accent" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-foreground">Duplicate workflow</h2>
              <p className="text-xs text-muted-foreground mt-0.5">Creates a full copy with all steps</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="mx-5 mt-4 rounded-xl border border-border bg-muted/40 px-4 py-3">
          <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground mb-1">Source template</p>
          <p className="text-sm font-semibold text-foreground">{template.name}</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            {template.step_count ?? template.steps?.length ?? 0} steps
            {template.document_type_name ? ` · ${template.document_type_name}` : ""}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <Label required>New template name</Label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} className="input" autoFocus />
          </div>
          <div>
            <Label required>Document type</Label>
            <select value={selectedDocTypeId ?? ""} onChange={(e) => setSelectedDocTypeId(e.target.value || null)} className="input">
              <option value="">Select document type</option>
              {activeDocTypes.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <p className="text-[11px] text-muted-foreground mt-1">The duplicate can be assigned to a different document type.</p>
          </div>
          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={duplicateMutation.isPending} className="btn-primary flex-1">
              {duplicateMutation.isPending ? <><Loader2 className="w-4 h-4 animate-spin" /> Duplicating…</> : <><Copy className="w-4 h-4" /> Duplicate</>}
            </button>
            <button type="button" onClick={onClose} className="btn-secondary">Cancel</button>
          </div>
        </form>
      </div>
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

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-card rounded-2xl max-w-2xl w-full max-h-[85vh] overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b">
          <div>
            <h2 className="text-lg font-bold text-foreground">{docType.name}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">Code: {docType.code} · Prefix: {docType.reference_prefix}</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg"><X className="w-5 h-5 text-muted-foreground" /></button>
        </div>

        <div className="p-5 overflow-y-auto">
          <div className={clsx("mb-6 p-4 rounded-xl border",
            docType.workflow_template ? "bg-teal/10 border-teal/30" : "bg-accent/10 border-accent/30"
          )}>
            <div className="flex items-start gap-3">
              {docType.workflow_template
                ? <CheckCircle2 className="w-5 h-5 text-teal mt-0.5" />
                : <AlertCircle className="w-5 h-5 text-accent-foreground mt-0.5" />}
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
              <button onClick={onCreateTemplate} className="inline-flex items-center gap-1 rounded-lg bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/25">
                <Plus className="w-3.5 h-3.5" /> Create New
              </button>
            </div>

            {isLoading ? (
              <div className="space-y-2">{[1, 2, 3].map(i => <div key={i} className="h-20 bg-muted rounded-xl animate-pulse" />)}</div>
            ) : activeTemplates.length > 0 ? (
              <div className="space-y-2 max-h-[40vh] overflow-y-auto">
                {activeTemplates.map(template => {
                  const isCurrentPrimary = template.id === docType.workflow_template;
                  const isSelected = selectedTemplateId === template.id;
                  return (
                    <div
                      key={template.id}
                      onClick={() => setSelectedTemplateId(template.id)}
                      className={clsx("p-4 rounded-xl border-2 cursor-pointer transition-all",
                        isSelected ? "border-accent/50 bg-accent/10" : "border-border hover:border-foreground/20",
                        isCurrentPrimary && !isSelected && "border-teal/50 bg-teal/10"
                      )}
                    >
                      <div className="flex items-center justify-between">
                        <div>
                          <p className="font-semibold text-sm text-foreground">{template.name}</p>
                          {template.description && <p className="text-xs text-muted-foreground mt-0.5">{template.description}</p>}
                        </div>
                        <div className="flex items-center gap-2">
                          {isCurrentPrimary && <span className="text-xs text-teal bg-teal/15 px-2 py-0.5 rounded-full">Primary</span>}
                          {isSelected && <div className="w-5 h-5 rounded-full bg-accent flex items-center justify-center"><Check className="w-3 h-3 text-white" /></div>}
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
                <button onClick={onCreateTemplate} className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-accent/15 px-3 py-2 text-sm font-medium text-accent hover:bg-accent/25">
                  <Plus className="w-4 h-4" /> Create your first template
                </button>
              </div>
            )}
          </div>
        </div>

        <div className="flex gap-3 p-5 border-t bg-muted/40">
          <button
            onClick={() => onAssignTemplate(selectedTemplateId)}
            disabled={!selectedTemplateId || selectedTemplateId === docType.workflow_template}
            className={clsx("flex-1 px-4 py-2.5 rounded-xl font-medium transition-colors",
              !selectedTemplateId || selectedTemplateId === docType.workflow_template
                ? "bg-muted text-muted-foreground cursor-not-allowed"
                : "bg-primary text-white hover:bg-primary/90"
            )}
          >
            Set as Primary Template
          </button>
          <button onClick={onClose} className="btn-secondary">Cancel</button>
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
  const [duplicatingTemplate, setDuplicatingTemplate] = useState<WorkflowTemplate | null>(null);

  const { data: docTypes } = useQuery<unknown, Error, DocumentType[]>({
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

  const { data: fetchedTemplate, isFetching: templateFetching, isLoading: templateLoading } = useQuery<WorkflowTemplate | null>({
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
    if (!dt.workflow_template) {
      setShowDetailModal(dt);
      setSelectedDocType(null); setEditingTemplateId(null); setCreatingForDocType(null);
      return;
    }
    setSelectedDocType(dt); setEditingTemplateId(null); setCreatingForDocType(null);
  };

  const handleTemplateClick = (t: WorkflowTemplate) => {
    setEditingTemplateId(t.id); setSelectedDocType(null); setCreatingForDocType(null);
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

  const handleStartCreateForDocType = (docType: DocumentType) => {
    setCreatingForDocType(docType);
    setSelectedDocType(null); setEditingTemplateId(null); setShowDetailModal(null);
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
    } else if (isNew) {
      setEditingTemplateId(t.id);
      toast.success(`Template "${t.name}" created`);
    } else {
      if (selectedDocType) setSelectedDocType(prev => prev ? { ...prev, workflow_template: t.id } : null);
      toast.success(`Template "${t.name}" saved`);
    }
    qc.invalidateQueries({ queryKey: ["document-types"] });
    qc.invalidateQueries({ queryKey: ["workflow-templates"] });
  };

  const docTypesArray  = useMemo(() => Array.isArray(docTypes) ? docTypes : [], [docTypes]);
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
      [t.name, t.document_type_name ?? ""].some(v => v.toLowerCase().includes(search.toLowerCase()))
    ),
    [resolvedTemplates, search]
  );
  const groupedTemplates = useMemo(() => {
    const groups = new Map<string, { label: string; templates: WorkflowTemplate[] }>();
    for (const template of filteredTemplates) {
      const key   = template.document_type ?? "unassigned";
      const label = template.document_type_name ?? "Unassigned";
      if (!groups.has(key)) groups.set(key, { label, templates: [] });
      groups.get(key)!.templates.push(template);
    }
    return Array.from(groups.entries())
      .map(([key, group]) => [key, { ...group, templates: [...group.templates].sort((a, b) => a.name.localeCompare(b.name)) }] as const)
      .sort((a, b) => a[1].label.localeCompare(b[1].label));
  }, [filteredTemplates]);

  const withTemplate    = docTypesArray.filter(d => d.workflow_template).length;
  const withoutTemplate = docTypesArray.length - withTemplate;

  const showEditor = selectedDocType || editingTemplateId || creatingForDocType;
  const currentTemplate = creatingForDocType ? null : (fetchedTemplate ?? null);
  const isLoadingTemplate =
    !creatingForDocType && !!effectiveTemplateId &&
    (templateLoading || templateFetching || fetchedTemplate === undefined);
  const editorDocType = selectedDocType || creatingForDocType || null;

  return (
    <div className="admin-shell flex h-[calc(100vh-3.5rem)] gap-5 overflow-hidden">
      {/* Left Sidebar */}
      <aside className="flex w-80 flex-shrink-0 flex-col overflow-hidden border border-[#C8CDD2] bg-white">
        <div className="border-b border-[#C8CDD2] bg-[#F7F8F9] p-4">
          <div className="flex items-center justify-between mb-4">
            <h1 className="text-lg font-bold text-foreground">
              {sidebarTab === "doctypes" ? "Document Types" : "Templates"}
            </h1>
          </div>

          <div className="flex bg-muted p-1 rounded-lg mb-4">
            <button
              onClick={() => { setSidebarTab("doctypes"); setSearch(""); }}
              className={clsx("flex-1 flex items-center justify-center gap-2 py-2 text-xs font-medium rounded-md transition-all",
                sidebarTab === "doctypes" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}
            >
              <FolderTree className="w-3.5 h-3.5" /> Types
            </button>
            <button
              onClick={() => { setSidebarTab("templates"); setSearch(""); }}
              className={clsx("flex-1 flex items-center justify-center gap-2 py-2 text-xs font-medium rounded-md transition-all",
                sidebarTab === "templates" ? "bg-card text-foreground shadow-sm" : "text-muted-foreground")}
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
                <span className="text-accent font-medium">{withoutTemplate} pending</span>
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
              const isSelected  = selectedDocType?.id === dt.id || creatingForDocType?.id === dt.id;
              return (
                <div key={dt.id} className="relative group">
                  <button
                    onClick={() => handleDocTypeClick(dt)}
                    className={clsx("w-full text-left rounded-xl p-3 pr-10 transition-all border",
                      isSelected ? "bg-accent/10 border-accent/40" : "bg-card border-border hover:border-foreground/20")}
                  >
                    <div className="flex items-start gap-2.5">
                      <div className={clsx("w-2 h-2 rounded-full mt-1.5", hasTemplate ? "bg-teal" : "bg-accent")} />
                      <div className="flex-1 min-w-0">
                        <p className="font-semibold text-sm text-foreground truncate">{dt.name}</p>
                        <p className="text-xs text-muted-foreground font-mono mt-0.5">{dt.reference_prefix}-XXXXX</p>
                      </div>
                      {!hasTemplate && (
                        <span className="text-[10px] text-accent font-medium bg-accent/20 px-2 py-0.5 rounded-full">Setup</span>
                      )}
                    </div>
                  </button>
                  <button
                    onClick={(e) => { e.stopPropagation(); setShowDetailModal(dt); }}
                    className={clsx(
                      "absolute right-2 top-1/2 -translate-y-1/2 p-1.5 bg-card border border-border rounded-lg hover:bg-muted/40",
                      hasTemplate ? "opacity-0 group-hover:opacity-100" : "opacity-100 border-accent/40 bg-accent/10"
                    )}
                    title={hasTemplate ? "Manage templates" : "Set up template"}
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
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">{group.label}</p>
                </div>
                <div className="p-1 space-y-1">
                  {group.templates.map((t) => {
                    const isSelected = editingTemplateId === t.id;
                    return (
                      <div key={t.id} className="relative group/item">
                        <button
                          onClick={() => handleTemplateClick(t)}
                          className={clsx("w-full text-left rounded-xl p-3 pr-10 transition-all border",
                            isSelected ? "bg-accent/10 border-accent/40" : "bg-card border-border hover:border-foreground/20")}
                        >
                          <div className="flex items-start gap-2.5">
                            <LayoutTemplate className="w-5 h-5 text-muted-foreground mt-0.5" />
                            <div className="flex-1 min-w-0">
                              <p className="font-semibold text-sm text-foreground truncate">{t.name}</p>
                              <p className="text-xs text-muted-foreground mt-0.5">
                                {t.step_count} step{t.step_count !== 1 ? "s" : ""}
                                {t.description ? ` · ${t.description}` : ""}
                              </p>
                            </div>
                          </div>
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setDuplicatingTemplate(t); }}
                          title="Duplicate workflow"
                          className="absolute right-2 top-1/2 -translate-y-1/2 p-1.5 rounded-lg border border-border bg-card opacity-0 group-hover/item:opacity-100 hover:bg-accent/10 hover:border-accent/40 hover:text-accent transition-all"
                        >
                          <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                        </button>
                      </div>
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
                {search ? "Try a different search term" : "Choose a document type to create a template"}
              </p>
            </div>
          )}
        </div>
      </aside>

      {/* Right Editor */}
      <main className="flex flex-1 flex-col overflow-hidden border border-[#C8CDD2] bg-white p-5">
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
          isLoadingTemplate ? (
            <div className="flex-1 flex items-center justify-center">
              <Loader2 className="w-8 h-8 text-accent animate-spin" />
            </div>
          ) : (
            <TemplateEditor
              docType={editorDocType}
              template={currentTemplate}
              onSaved={handleSaved}
              onDuplicate={currentTemplate ? () => setDuplicatingTemplate(currentTemplate) : undefined}
              allTemplates={resolvedTemplates}
              docTypes={docTypesArray}
            />
          )
        )}
      </main>

      {showDetailModal && (
        <DocTypeDetailModal
          docType={showDetailModal}
          onClose={() => setShowDetailModal(null)}
          onAssignTemplate={(templateId) => handleAssignTemplate(showDetailModal.id, templateId)}
          onCreateTemplate={() => { setShowDetailModal(null); handleStartCreateForDocType(showDetailModal); }}
          templates={resolvedTemplates}
          isLoading={templatesLoading}
        />
      )}

      {duplicatingTemplate && (
        <DuplicateTemplateModal
          template={duplicatingTemplate}
          docTypes={docTypesArray}
          onClose={() => setDuplicatingTemplate(null)}
          onDuplicated={(newTemplate) => {
            setDuplicatingTemplate(null);
            qc.invalidateQueries({ queryKey: ["workflow-templates"] });
            qc.invalidateQueries({ queryKey: ["document-types"] });
            setEditingTemplateId(newTemplate.id);
            setSelectedDocType(null); setCreatingForDocType(null);
            setSidebarTab("templates");
          }}
        />
      )}
    </div>
  );
}