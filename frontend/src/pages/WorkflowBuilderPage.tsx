import {
  useState, useCallback, useRef, useMemo, useEffect,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { workflowAPI, documentTypesAPI, groupsAPI, templatesAPI, normalizeListResponse } from "@/services/api";
import { deriveDocumentTypeConfig } from "@/lib/documentTypeConfig";
import {
  Plus, Trash2, Save, GitBranch, Loader2, X,
  Settings2, AlertCircle,
  CheckCircle2,
  Search, MoreVertical,
  FolderTree, LayoutTemplate, Check,
  User, UsersRound, Users,
  Edit3, FileSignature, Copy,
  Bell, Mail,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import clsx from "clsx";
import CustomListbox from "@/components/ui/CustomListbox";
import BranchedWorkflowEditor from "@/components/workflow/BranchedWorkflowEditor";
import {
  type Block, type StepData, type WorkflowDefinition, type WorkflowField,
  SYSTEM_FIELDS, definitionFromSteps, fieldMap, flattenSteps, mapSteps,
  migrateLegacyRules, validateDefinition,
} from "@/lib/workflowGraph";

// ── Types ─────────────────────────────────────────────────────────────────────
type AssigneeType = "group_any" | "group_all" | "group_specific";
type StepType = "approval" | "notification";
type WorkflowTargetType = "document" | "payment_run";
type WorkflowRouteKind = "document" | "form" | "payment_run";

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
  /** Approver may send the document back to the PREVIOUS approval on the path it took. */
  allow_return: boolean;
  /** Approver may send the document back to the SUBMITTER (to edit and resubmit). */
  allow_return_submitter: boolean;
  requires_signature: boolean;
  instructions: string;
  // Custom approver email (approval steps)
  approver_email_subject?: string;
  approver_email_body?: string;
  // Notification-step fields
  notify_user?: string | null;
  notify_user_name?: string;
  /** Single address — kept for back-compat; UI now uses notify_emails[] */
  notify_email?: string;
  /** Multiple recipient email addresses (RFQ supplier emails, etc.) */
  notify_emails?: string[];
  notification_subject?: string;
  notification_message?: string;
  /** When true the backend embeds a form table in the email body */
  notify_include_items_table?: boolean;
  /** Form table field key to render as the items/quotation table */
  notify_table_field?: string | null;
  /** Recipient type: "user" | "email" | "supplier" */
  notify_recipient_type?: "user" | "email" | "supplier";
  /** Form field key containing supplier codes (when notify_recipient_type is "supplier") */
  notify_supplier_field?: string | null;
}

interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  target_type: WorkflowTargetType;
  document_type: string | null;
  document_type_name?: string | null;
  category?: string;
  is_active: boolean;
  notify_uploader_on_approval?: boolean;
  email_templates?: EmailTemplates;
  steps: WorkflowStep[];
  /** v2 branched definition. When present the engine follows it and `steps` is only a flat mirror. */
  definition?: WorkflowDefinition | null;
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
  | "sla_overdue"
  | "workflow_notification";

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
  {
    key: "workflow_notification",
    label: "Workflow notification step",
    description: "Optional override for notification-step emails to people outside the approval chain. Uses the step subject/body unless set. No login or document links are appended.",
    group: "Uploader",
    placeholders: [
      "{document_title}", "{document_ref}", "{payment_reference}",
      "{line_count}", "{total_amount}", "{currencies}", "{step_name}",
    ],
    defaultSubject: "DMS — Workflow notification: {document_ref}",
    defaultBody: "Hello,\n\nA workflow notification has been triggered.\n\n  Item: {document_title}\n  Reference: {document_ref}\n  Step: {step_name}\n",
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
  is_personal_type?: boolean;
  description?: string;
  metadata?: Record<string, any>;
  is_form?: boolean;
}

interface WorkflowRule {
  id: string;
  target_type?: WorkflowTargetType;
  document_type: string | null;
  document_type_name: string | null;
  template: string;
  template_name: string;
  template_document_type?: string | null;
  phase?: string;
  amount_min: string;
  amount_max: string | null;
  currency: string;
  label: string;
  is_active: boolean;
}

type WorkflowPhase = "requisition" | "rfq" | "lpo" | "request" | "retirement" | "payment_run";

const WORKFLOW_PHASES: { value: WorkflowPhase; label: string }[] = [
  { value: "requisition", label: "Requisition" },
  { value: "rfq", label: "RFQ" },
  { value: "lpo", label: "LPO" },
  { value: "request", label: "Request" },
  { value: "retirement", label: "Retirement" },
  { value: "payment_run", label: "Payment run" },
];

function workflowPhaseLabel(value?: string | null) {
  const normalized = (value || "request").trim().toLowerCase();
  return WORKFLOW_PHASES.find((phase) => phase.value === normalized)?.label ?? (normalized || "Request");
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
  { value: "group_specific", label: "Specific member", description: "Designated approver or a chosen member", Icon: User },
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
    // Templates saved before this option existed keep their behaviour: no return-to-submitter.
    allow_return_submitter: Boolean((step as any).allow_return_submitter),
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
    target_type: template.target_type ?? "document",
    document_type: isUuidLike(template.document_type) ? template.document_type : null,
    notify_uploader_on_approval: template.notify_uploader_on_approval ?? true,
    email_templates: normalizeEmailTemplates(template.email_templates),
    steps: (template.steps ?? []).map(normalizeStep),
    definition: template.definition?.blocks
      ? { ...template.definition, blocks: mapSteps(template.definition.blocks, (s) => normalizeStep(s as WorkflowStep) as StepData) }
      : null,
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
  if ((template.target_type ?? "document") === "payment_run") {
    return {
      ...template,
      document_type: null,
      document_type_name: "Payment run",
    };
  }
  const resolved = resolveTemplateDocumentType(template, docTypes);
  return {
    ...template,
    document_type: resolved.id,
    document_type_name: resolved.name,
  };
}

function isFormDocumentType(type: Partial<DocumentType> | null | undefined): boolean {
  if (!type) return false;
  const metadata = type.metadata as Record<string, any> | undefined;
  const haystack = [type.name, type.code, type.description, type.category].filter(Boolean).join(" ");
  return Boolean(
    type.is_form ||
    metadata?.form ||
    metadata?.form_template ||
    /\b(form|imprest|retirement|advance)\b/i.test(haystack),
  );
}

function isRequisitionDocumentType(type: Pick<DocumentType, "name" | "code" | "description"> | null | undefined) {
  if (!type) return false;
  return /requisition/i.test([type.name, type.code, type.description].filter(Boolean).join(" "));
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
    sla_hours: 48, allow_resubmit: true, allow_approve: true, allow_reject: true, allow_return: true, allow_return_submitter: true,
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
    allow_resubmit: false, allow_approve: false, allow_reject: false, allow_return: false, allow_return_submitter: false,
    requires_signature: false,
    instructions: "",
    approver_email_subject: "", approver_email_body: "",
    notify_user: null,
    notify_email: "",
    notify_emails: [],
    notification_subject: "Workflow update",
    notification_message: "Hello,\n\nThis is an automated notification regarding the document workflow.\n\nThank you.",
    notify_include_items_table: false,
    notify_table_field: null,
    notify_recipient_type: "email",
    notify_supplier_field: null,
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
    rest.allow_return_submitter = false;
    rest.allow_resubmit     = false;
    rest.requires_signature = false;
    rest.assignee_user_auto = false;
    rest.assignee_group     = null;
    rest.assignee_user      = null;
    rest.approver_email_subject = "";
    rest.approver_email_body    = "";
    // Keep recipient type and supplier field for notification steps
    rest.notify_recipient_type = rest.notify_recipient_type ?? "email";
    return rest;
  }

  // Approval step: clear notification fields
  rest.notify_user                  = null;
  rest.notify_email                 = "";
  rest.notify_emails                = [];
  rest.notification_subject         = "";
  rest.notification_message         = "";
  rest.notify_include_items_table   = false;
  rest.notify_table_field           = null;
  rest.notify_recipient_type        = undefined;
  rest.notify_supplier_field        = null;

  if (rest.assignee_type !== "group_specific") {
    rest.assignee_user      = null;
    rest.assignee_user_auto = false;
  } else {
    rest.assignee_user_auto = Boolean(rest.assignee_user_auto);
  }
  return rest;
}

// ── Branching support: field catalog + per-step validation ───────────────────
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Adapter: turns a document type's form definition into condition fields.
 * ASSUMPTION: form fields live under one of the metadata paths below and look like
 * { id|name|key, label|title, type, options }. Adjust here if your schema differs —
 * nothing else depends on it.
 */
function extractFormFields(docType: Partial<DocumentType> | null | undefined): WorkflowField[] {
  const m = (docType?.metadata ?? {}) as Record<string, any>;
  const raw: any[] = m.form?.fields ?? m.form_template?.fields ?? m.form?.schema?.fields ?? m.fields ?? [];
  if (!Array.isArray(raw)) return [];
  const toType = (t: string): WorkflowField["type"] => {
    const x = (t || "").toLowerCase();
    if (["currency", "money", "amount"].includes(x)) return "money";
    if (["number", "integer", "decimal", "float"].includes(x)) return "number";
    if (["select", "dropdown", "radio", "choice"].includes(x)) return "select";
    if (["multiselect", "multi_select", "checkbox_group", "tags"].includes(x)) return "multiselect";
    if (["checkbox", "boolean", "switch", "toggle"].includes(x)) return "boolean";
    if (["date", "datetime"].includes(x)) return "date";
    return "text";
  };
  const out: WorkflowField[] = [];
  for (const f of raw) {
    const id = String(f?.id ?? f?.name ?? f?.key ?? "");
    if (!id) continue;
    const opts = Array.isArray(f?.options)
      ? f.options.map((o: any) => (typeof o === "string" ? { value: o, label: o } : { value: String(o.value ?? o.id ?? o.label), label: String(o.label ?? o.value) }))
      : undefined;
    out.push({ id, label: String(f?.label ?? f?.title ?? id), type: toType(String(f?.type ?? "")), options: opts, source: "form" });
  }
  return out;
}

function buildFieldCatalog(docType: Partial<DocumentType> | null | undefined, target: WorkflowTargetType): WorkflowField[] {
  const system = SYSTEM_FIELDS.filter((f) => (target === "payment_run" ? true : !f.id.startsWith("payment_run.")))
    .filter((f) => (target === "payment_run" ? f.id !== "amount" : true));
  return [...extractFormFields(docType), ...system];
}

/** Same rules the old save loop enforced, expressed per step so validateDefinition can reuse them. */
function validateStepData(raw: StepData): string | null {
  const s = raw as WorkflowStep;
  if (!s.name?.trim()) return "Every step needs a name.";
  if (s.step_type === "notification") {
    const emails = s.notify_emails?.filter((e) => e.trim()) ?? [];
    const single = s.notify_email?.trim();
    const recipientType = s.notify_recipient_type ?? "email";
    if (recipientType === "user" && !s.notify_user) return `"${s.name}" needs a selected user.`;
    if (recipientType === "email" && !s.notify_user && emails.length === 0 && !single) return `"${s.name}" needs at least one recipient (user or email).`;
    if (recipientType === "supplier" && !s.notify_supplier_field) return `"${s.name}" needs a supplier field selected.`;
    const bad = emails.find((e) => !EMAIL_RE.test(e.trim()));
    if (bad) return `"${s.name}" has an invalid email address: ${bad}`;
    if (single && !EMAIL_RE.test(single)) return `"${s.name}" has an invalid email address.`;
    if (!s.notification_subject?.trim()) return `"${s.name}" needs an email subject.`;
    if (!s.notification_message?.trim()) return `"${s.name}" needs an email message.`;
    return null;
  }
  if (!s.assignee_group) return `"${s.name}" needs a group.`;
  if (s.assignee_type === "group_specific" && !s.assignee_user) return `"${s.name}" needs a specific group member.`;
  if (!s.allow_approve && !s.allow_reject && !s.allow_return && !s.allow_return_submitter) return `"${s.name}" must have at least one approver action enabled.`;
  if (s.requires_signature && !s.allow_approve) return `"${s.name}" requires approval before it can require a signature.`;
  return null;
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

type RuleFormValues = {
  phase: WorkflowPhase;
  amount_min: string;
  amount_max: string;
  currency: string;
  label: string;
};

function RuleFormFields({ values, routeKind, isRequisitionWorkflow, disabledPhases = [], onChange }: {
  values: RuleFormValues;
  routeKind: WorkflowRouteKind;
  isRequisitionWorkflow: boolean;
  /* Procurement stages that cannot be configured yet (the preceding stage has
   * no routing rule). RFQ needs Requisition; LPO needs RFQ (or Requisition for
   * Travel requisitions, which skip RFQ). */
  disabledPhases?: WorkflowPhase[];
  onChange: (patch: Partial<RuleFormValues>) => void;
}) {
  const phaseOptions = WORKFLOW_PHASES
    .filter((phase) => {
      if (isRequisitionWorkflow) return ["requisition", "rfq", "lpo"].includes(phase.value);
      if (routeKind === "payment_run") return phase.value === "payment_run";
      if (routeKind === "form") return ["request", "retirement"].includes(phase.value);
      return phase.value === "request";
    })
    .map((phase) => ({
      value: phase.value,
      label: phase.label,
      disabled: disabledPhases.includes(phase.value) && phase.value !== values.phase,
    }));
  const showPhase = routeKind !== "document" || isRequisitionWorkflow;

  return (
    <div className="grid grid-cols-2 gap-3">
      {showPhase && (
        <div className="col-span-2">
          <Label>{isRequisitionWorkflow ? "Procurement stage" : "Workflow phase"}</Label>
          <CustomListbox
            value={values.phase}
            onChange={(v) => onChange({ phase: v as WorkflowPhase })}
            options={phaseOptions}
            buttonClassName={inp}
            ariaLabel="Workflow phase"
          />
          <p className="text-[11px] text-muted-foreground mt-1">
            {routeKind === "payment_run"
              ? "Payment run routing starts after selected lines have been marked in SunSystems."
              : isRequisitionWorkflow
                ? "Each stage has its own amount thresholds and approval chain. RFQ starts after Requisition approval; LPO starts after RFQ approval."
                : "Each phase has its own amount thresholds and approval chain for routing documents through the workflow."}
          </p>
          {isRequisitionWorkflow && disabledPhases.length > 0 && (
            <p className="text-[11px] text-amber-600 mt-1">
              Configure the earlier procurement stage first — a later stage cannot start until the
              preceding one is approved. (Travel requisitions skip RFQ, so LPO is also unlocked once
              Requisition is configured.)
            </p>
          )}
        </div>
      )}
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
        <CustomListbox
          value={values.currency}
          onChange={(v) => onChange({ currency: v })}
          options={CURRENCIES.map((c) => ({ value: c, label: c }))}
          buttonClassName={inp}
          ariaLabel="Currency"
        />
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
  docType,
  onChange,
  onClose,
  onDelete,
  onInsertNotificationAfter,
}: {
  step: WorkflowStep;
  index: number;
  total: number;
  groups: Group[];
  docType: DocumentType | null;
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

  // Keep the "designated approver" choice bound to the group's CURRENT head.
  //  - On first entry to group_specific (no explicit pick yet) default to the head.
  //  - When the admin explicitly chose "Designated approver" (assignee_user_auto),
  //    re-sync the stored user whenever the group's head changes, so the builder
  //    never keeps pointing at a former approver. Hand-picked members are left as-is.
  useEffect(() => {
    if (step.assignee_type !== "group_specific") return;
    const head = groupDetail?.head;
    if (!head?.id) return;

    if (step.assignee_user_auto) {
      if (step.assignee_user !== head.id || step.assignee_user_name !== head.full_name) {
        onChange({ assignee_user: head.id, assignee_user_name: head.full_name, assignee_user_auto: true });
      }
      return;
    }

    // Not in auto mode: only seed a default the very first time (no user picked yet).
    if (step.assignee_user_auto === false) return;
    if (step.assignee_user) return;
    onChange({ assignee_user: head.id, assignee_user_name: head.full_name, assignee_user_auto: true });
  }, [step.assignee_type, step.assignee_user, step.assignee_user_name, step.assignee_user_auto, groupDetail?.head, onChange]);

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
              <CustomListbox
                value={step.assignee_group ?? ""}
                onChange={(v) => {
                  const id = v || null;
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
                options={[{ value: "", label: "Select group" }, ...groups.map((g) => ({ value: g.id, label: isHodGroupName(g.name) ? "HOD - uploader department head" : g.name }))]}
                buttonClassName={inp}
                ariaLabel="Approver group"
              />
            </div>

            <div>
              <Label required>Assignment mode</Label>
              <CustomListbox
                value={step.assignee_type}
                onChange={(v) => {
                  const next = v as AssigneeType;
                  onChange({
                    assignee_type: next,
                    assignee_user: next === "group_specific" ? step.assignee_user : null,
                    assignee_user_name: next === "group_specific" ? step.assignee_user_name : undefined,
                    assignee_user_auto: next === "group_specific" ? step.assignee_user_auto : undefined,
                  });
                }}
                options={ASSIGNEE_MODES.map((m) => ({ value: m.value, label: `${m.label} — ${m.description}` }))}
                buttonClassName={inp}
                ariaLabel="Assignment mode"
              />
              {isHodGroupSelected && (
                <p className="text-[11px] text-muted-foreground mt-1">
                  The assignee will be picked automatically from the uploader&apos;s department head.
                </p>
              )}
            </div>

            {needsGroupMember && (
              <div>
                <Label required>Approver</Label>
                <CustomListbox
                  value={step.assignee_user_auto ? "__designated__" : (step.assignee_user ?? "")}
                  onChange={(v) => {
                    const val = v;
                    if (val === "__designated__") {
                      const head = groupDetail?.head;
                      onChange({ assignee_user: head?.id ?? null, assignee_user_name: head?.full_name, assignee_user_auto: true });
                      return;
                    }
                    const id = val || null;
                    const u = effectiveGroupMembers.find(x => x.id === id);
                    onChange({ assignee_user: id, assignee_user_name: u?.full_name, assignee_user_auto: false });
                  }}
                  options={[{ value: "", label: membersLoading ? "Loading members..." : "Select approver" }, ...(groupDetail?.head?.id || step.assignee_user_auto ? [{ value: "__designated__", label: "Designated approver — always the group's current head" }] : []), ...effectiveGroupMembers.map((u) => ({ value: u.id, label: `${u.full_name}${groupDetail?.head?.id === u.id ? " (current designated approver)" : ""}` }))]}
                  buttonClassName={inp}
                  ariaLabel="Approver"
                />
                {step.assignee_user_auto ? (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Follows the group&apos;s designated approver — change it on the group and this step
                    updates automatically{groupDetail?.head?.full_name ? ` (currently ${groupDetail.head.full_name})` : ""}.
                  </p>
                ) : !step.assignee_group ? (
                  <p className="text-[11px] text-muted-foreground mt-1">Pick a group first</p>
                ) : (
                  <p className="text-[11px] text-muted-foreground mt-1">
                    Pinned to this specific person — it won&apos;t change if the group&apos;s designated approver changes.
                  </p>
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
                <span className="text-xs font-semibold">Allow Return to Previous Step</span>
                <div className={clsx("w-8 h-4 rounded-full relative transition-colors", step.allow_return ? "bg-accent" : "bg-muted-foreground/30")}>
                  <div className={clsx("absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform", step.allow_return ? "translate-x-4" : "translate-x-0.5")} />
                </div>
              </button>
              <button
                type="button"
                onClick={() => onChange({ allow_return_submitter: !step.allow_return_submitter })}
                className={clsx(
                  "w-full flex items-center justify-between px-4 py-2.5 rounded-xl border transition-all",
                  step.allow_return_submitter
                    ? "bg-accent/5 border-accent/30 text-accent shadow-sm"
                    : "bg-muted/30 border-border text-muted-foreground"
                )}
              >
                <span className="text-xs font-semibold">Allow Return to Submitter</span>
                <div className={clsx("w-8 h-4 rounded-full relative transition-colors", step.allow_return_submitter ? "bg-accent" : "bg-muted-foreground/30")}>
                  <div className={clsx("absolute top-0.5 w-3 h-3 rounded-full bg-white transition-transform", step.allow_return_submitter ? "translate-x-4" : "translate-x-0.5")} />
                </div>
              </button>
              <p className="text-[11px] text-muted-foreground px-1">
                <b>Reject</b> always ends the workflow as Rejected. <b>Return</b> pauses approval so someone can rework:
                previous step or submitter. After resubmit, the workflow resumes at <b>this</b> step — it does not restart from the beginning.
              </p>
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
            docType={docType}
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
  docType,
  onChange,
}: {
  step: WorkflowStep;
  groups: Group[];
  docType: DocumentType | null;
  onChange: (patch: Partial<WorkflowStep>) => void;
}) {
  const [recipientMode, setRecipientMode] = useState<"user" | "email" | "supplier">(
    (step.notify_recipient_type as any) || (step.notify_user ? "user" : "email")
  );
  // Tag-style multi-email input state
  const [emailDraft, setEmailDraft] = useState("");
  const emailDraftRef = useRef<HTMLInputElement>(null);

  const emails: string[] = step.notify_emails?.length
    ? step.notify_emails
    : step.notify_email?.trim()
    ? [step.notify_email.trim()]
    : [];

  const addEmail = (raw: string) => {
    const val = raw.trim().toLowerCase();
    if (!val) return;
    const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!EMAIL_RE.test(val)) {
      return; // silently ignore bad emails (border turns red via CSS)
    }
    if (emails.includes(val)) { setEmailDraft(""); return; }
    onChange({ notify_emails: [...emails, val], notify_email: val, notify_user: null, notify_user_name: undefined });
    setEmailDraft("");
  };

  const removeEmail = (addr: string) => {
    const next = emails.filter((e) => e !== addr);
    onChange({ notify_emails: next, notify_email: next[0] ?? "", notify_user: null });
  };

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

  // Form fields for supplier recipients, email placeholders, and items tables.
  const { data: formCatalog, isLoading: formCatalogLoading } = useQuery({
    queryKey: ["form-notification-catalog", docType?.id],
    queryFn: async () => {
      const empty = {
        supplierFields: [] as { key: string; label: string }[],
        scalarFields: [] as { key: string; label: string; type: string }[],
        tableFields: [] as { key: string; label: string; columns: { key: string; label: string }[] }[],
      };
      if (!docType?.id) return empty;
      const res = await templatesAPI.list({ document_type: docType.id, type: "built" });
      const raw = res.data?.results ?? res.data ?? [];
      const templates = Array.isArray(raw) ? raw : [];
      const supplierFields: { key: string; label: string }[] = [];
      const scalarFields: { key: string; label: string; type: string }[] = [];
      const tableFields: { key: string; label: string; columns: { key: string; label: string }[] }[] = [];
      const seen = new Set<string>();
      const skipTypes = new Set(["button", "signature", "file", "multi_file", "budget"]);
      for (const tmpl of templates) {
        if (tmpl?.kind && tmpl.kind !== "form") continue;
        for (const section of tmpl?.sections ?? []) {
          for (const f of section?.fields ?? []) {
            const key = String(f?.key || f?.id || "").trim();
            if (!key || seen.has(key)) continue;
            const type = String(f?.type || "text");
            const label = String(f?.label || f?.key || f?.id || key);
            if (type === "sunsystems_account") {
              seen.add(key);
              supplierFields.push({ key, label });
              scalarFields.push({ key, label, type });
              continue;
            }
            if (type === "table") {
              seen.add(key);
              const columns = (f.columns ?? [])
                .filter((c: any) => c?.key || c?.id)
                .filter((c: any) => !["file", "multi_file", "button", "signature"].includes(String(c?.type || "")))
                .map((c: any) => ({ key: String(c.key || c.id), label: String(c.label || c.key || c.id) }));
              tableFields.push({ key, label, columns });
              continue;
            }
            if (skipTypes.has(type)) continue;
            seen.add(key);
            scalarFields.push({ key, label, type });
          }
        }
      }
      return { supplierFields, scalarFields, tableFields };
    },
    enabled: !!docType?.id,
    staleTime: 5 * 60_000,
  });

  const supplierFields = formCatalog?.supplierFields ?? [];
  const supplierFieldsLoading = formCatalogLoading;
  const scalarFields = formCatalog?.scalarFields ?? [];
  const tableFields = formCatalog?.tableFields ?? [];
  const messageBodyRef = useRef<HTMLTextAreaElement>(null);

  const systemPlaceholders = useMemo(
    () => [
      { key: "document_title", label: "Document title" },
      { key: "document_ref", label: "Reference" },
      { key: "uploader_name", label: "Submitter" },
      { key: "step_name", label: "Step name" },
      { key: "today", label: "Today's date" },
      { key: "items_table", label: "Items table" },
    ],
    [],
  );

  const insertPlaceholder = (token: string) => {
    const snippet = `{${token}}`;
    const el = messageBodyRef.current;
    const current = step.notification_message ?? "";
    if (!el) {
      onChange({ notification_message: `${current}${current.endsWith("\n") || !current ? "" : " "}${snippet}` });
      return;
    }
    const start = el.selectionStart ?? current.length;
    const end = el.selectionEnd ?? current.length;
    const next = current.slice(0, start) + snippet + current.slice(end);
    onChange({ notification_message: next });
    requestAnimationFrame(() => {
      el.focus();
      const pos = start + snippet.length;
      el.setSelectionRange(pos, pos);
    });
  };

  // When there is exactly one supplier field, pre-select it for the user.
  useEffect(() => {
    if (recipientMode !== "supplier") return;
    if (step.notify_supplier_field) return;
    if (supplierFields.length === 1) {
      onChange({
        notify_recipient_type: "supplier",
        notify_supplier_field: supplierFields[0].key,
      });
    }
  }, [recipientMode, supplierFields, step.notify_supplier_field, onChange]);

  // Pre-select the only table when the items-table toggle is on.
  useEffect(() => {
    if (!step.notify_include_items_table) return;
    if (step.notify_table_field) return;
    if (tableFields.length === 1) {
      onChange({ notify_table_field: tableFields[0].key });
    }
  }, [step.notify_include_items_table, step.notify_table_field, tableFields, onChange]);

  const handleRecipientModeChange = (mode: "user" | "email" | "supplier") => {
    setRecipientMode(mode);
    onChange({
      notify_recipient_type: mode,
      notify_user: null,
      notify_user_name: undefined,
      notify_email: "",
      notify_emails: [],
      notify_supplier_field: mode === "supplier" ? (step.notify_supplier_field ?? null) : null,
    });
  };

  return (
    <div className="space-y-5">
      <div className="flex items-start gap-3 p-3 rounded-lg bg-sky-50 border border-sky-200">
        <Mail className="w-4 h-4 text-sky-600 mt-0.5 flex-shrink-0" />
        <p className="text-[11px] text-sky-900 leading-relaxed">
          This step sends an email and <strong>immediately advances</strong> the workflow — no approver action required.
        </p>
      </div>

      {/* Recipient mode toggle */}
      <div>
        <Label required>Recipient(s)</Label>
        <div className="flex bg-muted rounded-lg p-1 mb-2">
          <button
            type="button"
            onClick={() => handleRecipientModeChange("user")}
            className={clsx(
              "flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-all",
              recipientMode === "user" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"
            )}
          >
            Group member
          </button>
          <button
            type="button"
            onClick={() => handleRecipientModeChange("email")}
            className={clsx(
              "flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-all",
              recipientMode === "email" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"
            )}
          >
            Email address(es)
          </button>
          <button
            type="button"
            onClick={() => handleRecipientModeChange("supplier")}
            className={clsx(
              "flex-1 px-2 py-1.5 text-xs font-medium rounded-md transition-all",
              recipientMode === "supplier" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground"
            )}
          >
            Form suppliers
          </button>
        </div>

        {recipientMode === "user" ? (
          <div className="space-y-2">
            <CustomListbox
              value={step.assignee_group ?? ""}
              onChange={(v) => {
                const id = v || null;
                const g = groups.find(x => x.id === id);
                onChange({
                  assignee_group: id,
                  assignee_group_name: g?.name,
                  notify_user: null,
                  notify_user_name: undefined,
                  notify_email: "",
                  notify_emails: [],
                });
              }}
              options={[{ value: "", label: "Select group" }, ...groups.map(g => ({ value: g.id, label: g.name }))]}
              className={inp}
              buttonClassName="w-full"
              ariaLabel="Notification group"
            />
            <CustomListbox
              value={step.notify_user ?? ""}
              onChange={(v) => {
                const id = v || null;
                const u = allMembers.find(x => x.id === id);
                onChange({ notify_user: id, notify_user_name: u?.full_name, notify_email: "", notify_emails: [] });
              }}
              options={[{ value: "", label: !step.assignee_group ? "Pick a group first" : "Select member" }, ...allMembers.map(u => ({ value: u.id, label: `${u.full_name} (${u.email})` }))]}
              className={inp}
              buttonClassName="w-full"
              ariaLabel="Notification user"
              disabled={!step.assignee_group}
            />
          </div>
        ) : recipientMode === "supplier" ? (
          <div className="space-y-2">
            {!docType?.id ? (
              <p className="text-xs text-muted-foreground p-3 bg-muted/50 rounded-lg">
                Assign this workflow to a document type first, then pick the form&apos;s Supplier field.
              </p>
            ) : supplierFieldsLoading ? (
              <p className="text-xs text-muted-foreground p-3 bg-muted/50 rounded-lg flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Looking up supplier fields…
              </p>
            ) : supplierFields.length === 0 ? (
              <p className="text-xs text-muted-foreground p-3 bg-muted/50 rounded-lg">
                This form has no supplier fields. Add a <span className="font-semibold">Supplier</span> field
                (SunSystems account) in the Template Builder to use this option.
              </p>
            ) : (
              <>
                <CustomListbox
                  value={step.notify_supplier_field ?? ""}
                  onChange={(v) => onChange({ notify_supplier_field: v || null, notify_recipient_type: "supplier" })}
                  options={[{ value: "", label: "Select supplier field" }, ...supplierFields.map((f) => ({ value: f.key, label: f.label }))]}
                  className={inp}
                  buttonClassName="w-full"
                  ariaLabel="Supplier field"
                />
                <p className="text-[11px] text-muted-foreground">
                  Emails will be sent to the suppliers selected in this field when the notification fires.
                </p>
              </>
            )}
          </div>
        ) : (
          /* ── Multi-email tag input ── */
          <div>
            {/* Existing email tags */}
            {emails.length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {emails.map((addr) => (
                  <span
                    key={addr}
                    className="inline-flex items-center gap-1 rounded-full border border-sky-200 bg-sky-50 px-2.5 py-0.5 text-[11px] font-medium text-sky-800"
                  >
                    {addr}
                    <button
                      type="button"
                      onClick={() => removeEmail(addr)}
                      className="ml-0.5 rounded-full text-sky-500 hover:text-sky-800 transition-colors"
                      aria-label={`Remove ${addr}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
            {/* New email entry */}
            <div className="flex gap-2">
              <input
                ref={emailDraftRef}
                type="email"
                value={emailDraft}
                onChange={(e) => setEmailDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === "," || e.key === " ") {
                    e.preventDefault();
                    addEmail(emailDraft);
                  } else if (e.key === "Backspace" && !emailDraft && emails.length > 0) {
                    removeEmail(emails[emails.length - 1]);
                  }
                }}
                className={clsx(inp, "flex-1")}
                placeholder="name@supplier.com — press Enter or comma to add"
              />
              <button
                type="button"
                onClick={() => addEmail(emailDraft)}
                disabled={!emailDraft.trim()}
                className="rounded border border-border px-2.5 py-1.5 text-xs font-medium hover:bg-muted disabled:opacity-40 transition-colors"
              >
                Add
              </button>
            </div>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Add one or more recipient emails. Press Enter, comma, or click Add after each address.
            </p>
          </div>
        )}
      </div>

      {/* Subject */}
      <div>
        <Label required>Email subject</Label>
        <input
          value={step.notification_subject ?? ""}
          onChange={e => onChange({ notification_subject: e.target.value })}
          className={inp}
          placeholder="e.g. RFQ — Quotation request for {document_ref}"
        />
      </div>

      {/* Message body + variable chips */}
      <div>
        <Label required>Email message</Label>
        <textarea
          ref={messageBodyRef}
          value={step.notification_message ?? ""}
          onChange={e => onChange({ notification_message: e.target.value })}
          rows={9}
          className={clsx(inp, "resize-none font-mono text-xs leading-relaxed")}
          placeholder={"Hello,\n\nPlease send your quotation on or before {due_date_copy}.\n\nDetails:\n{items_table}\n\nThank you."}
        />
        <div className="mt-2 space-y-1.5">
          <p className="text-[11px] text-muted-foreground">
            Click a variable to insert it at the cursor. Values are filled from the submitted form when the email sends.
          </p>
          <div className="flex flex-wrap gap-1.5">
            {systemPlaceholders.map((p) => (
              <button
                key={p.key}
                type="button"
                onClick={() => insertPlaceholder(p.key)}
                className="rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[10px] font-medium text-sky-800 hover:bg-sky-100"
                title={`Insert {${p.key}}`}
              >
                {p.label}
              </button>
            ))}
            {scalarFields.slice(0, 16).map((f) => (
              <button
                key={f.key}
                type="button"
                onClick={() => insertPlaceholder(f.key)}
                className="rounded-full border border-border bg-muted/40 px-2 py-0.5 text-[10px] font-medium text-foreground hover:bg-muted"
                title={`Insert {${f.key}}`}
              >
                {f.label}
              </button>
            ))}
          </div>
          {!docType?.id && (
            <p className="text-[11px] text-amber-700">Assign a document type to load form field variables.</p>
          )}
        </div>
      </div>

      {/* Items table toggle */}
      <div className="rounded-lg border border-border p-3 space-y-2">
        <label className="flex cursor-pointer items-start gap-3">
          <div className="relative mt-0.5 flex-shrink-0">
            <input
              type="checkbox"
              checked={Boolean(step.notify_include_items_table)}
              onChange={(e) => onChange({
                notify_include_items_table: e.target.checked,
                notify_table_field: e.target.checked ? (step.notify_table_field ?? tableFields[0]?.key ?? null) : null,
              })}
              className="sr-only"
            />
            <div className={clsx(
              "h-4 w-4 rounded border-2 transition-colors flex items-center justify-center",
              step.notify_include_items_table
                ? "border-primary bg-primary"
                : "border-muted-foreground bg-background"
            )}>
              {step.notify_include_items_table && (
                <svg className="h-2.5 w-2.5 text-primary-foreground" viewBox="0 0 12 12" fill="none">
                  <path d="M2 6l3 3 5-5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </div>
          </div>
          <div>
            <p className="text-xs font-medium text-foreground">Include form table in email</p>
            <p className="text-[11px] text-muted-foreground leading-relaxed">
              Embeds a structured HTML table from the form (quotation / line items). Use{" "}
              <code className="text-[10px] bg-muted px-1 rounded">{"{items_table}"}</code> in the message
              to place it, or leave it out and the table is appended at the end.
            </p>
          </div>
        </label>

        {step.notify_include_items_table && (
          <div className="ml-7 space-y-2">
            {formCatalogLoading ? (
              <p className="text-xs text-muted-foreground flex items-center gap-2">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading form tables…
              </p>
            ) : tableFields.length === 0 ? (
              <p className="text-xs text-muted-foreground p-2 bg-muted/50 rounded-lg">
                This form has no table fields. Add a table (items / quotation lines) in the Template Builder.
              </p>
            ) : (
              <>
                <CustomListbox
                  value={step.notify_table_field ?? ""}
                  onChange={(v) => onChange({ notify_table_field: v || null })}
                  options={[
                    { value: "", label: "Select table field" },
                    ...tableFields.map((t) => ({ value: t.key, label: t.label })),
                  ]}
                  className={inp}
                  buttonClassName="w-full"
                  ariaLabel="Form table field"
                />
                {(() => {
                  const selected = tableFields.find((t) => t.key === step.notify_table_field) ?? tableFields[0];
                  if (!selected) return null;
                  const cols = selected.columns.length ? selected.columns : [{ key: "col", label: "…" }];
                  return (
                    <div className="rounded border border-dashed border-sky-300 bg-sky-50 px-3 py-2">
                      <p className="text-[11px] text-sky-800 font-medium">
                        Preview columns from “{selected.label}”:
                      </p>
                      <div className="mt-1.5 overflow-x-auto rounded border border-sky-200 text-[10px]">
                        <div
                          className="grid bg-sky-100 font-semibold text-sky-700"
                          style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(4rem, 1fr))` }}
                        >
                          {cols.map((c, i) => (
                            <div key={c.key} className={clsx("px-2 py-1", i < cols.length - 1 && "border-r border-sky-200")}>
                              {c.label}
                            </div>
                          ))}
                        </div>
                        <div
                          className="grid text-sky-600"
                          style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(4rem, 1fr))` }}
                        >
                          {cols.map((c, i) => (
                            <div key={c.key} className={clsx("border-t border-sky-200 px-2 py-1 italic", i < cols.length - 1 && "border-r border-sky-200")}>
                              from form…
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })()}
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Flowchart Editor (pan / zoom / drag) ─────────────────────────────────────
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

function RoutingRulesPanel({ template, routeKind }: { template: WorkflowTemplate; routeKind: WorkflowRouteKind }) {
  const qc = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const isPaymentRun = template.target_type === "payment_run";
  const isFormWorkflow = routeKind === "form";
  const isRequisitionWorkflow = isRequisitionDocumentType({
    name: template.document_type_name ?? "",
    code: "",
    description: "",
  });
  const defaultPhase: WorkflowPhase = isPaymentRun ? "payment_run" : isRequisitionWorkflow ? "requisition" : "request";
  const blankRuleForm: RuleFormValues = {
    phase: defaultPhase,
    amount_min: "0",
    amount_max: "",
    currency: "USD",
    label: "",
  };
  const [form, setForm] = useState<RuleFormValues>(blankRuleForm);
  const templateId = template.id;
  const hasRoutingScope = isPaymentRun || Boolean(template.document_type);

  const { data: rules, isLoading } = useQuery<WorkflowRule[]>({
    queryKey: ["workflow-rules", templateId],
    queryFn: () => workflowAPI.listRules({ template: templateId }).then(r => r.data.results ?? r.data),
    enabled: hasRoutingScope,
  });

  const createRule = useMutation({
    mutationFn: () => workflowAPI.createRule({
      ...form, template: templateId,
      phase: routeKind === "document" && !isRequisitionWorkflow ? "request" : form.phase,
      amount_min: form.amount_min || "0",
      amount_max: form.amount_max || null,
    }),
    onSuccess: () => {
      toast.success("Routing rule created");
      qc.invalidateQueries({ queryKey: ["workflow-rules", templateId] });
      setShowAdd(false);
      setForm(blankRuleForm);
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
    onError: (err: any) => toast.error(formatApiError(err?.response?.data) || "Failed to remove rule"),
  });

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<RuleFormValues>(blankRuleForm);

  const startEdit = (rule: WorkflowRule) => {
    setShowAdd(false);
    setEditingId(rule.id);
    setEditForm({
      phase: ((rule.phase || defaultPhase).trim().toLowerCase() || defaultPhase) as WorkflowPhase,
      amount_min: String(rule.amount_min ?? "0"),
      amount_max: rule.amount_max == null ? "" : String(rule.amount_max),
      currency: rule.currency, label: rule.label ?? "",
    });
  };

  const updateRule = useMutation({
    mutationFn: () => workflowAPI.updateRule(editingId as string, {
      amount_min: editForm.amount_min || "0",
      amount_max: editForm.amount_max || null,
      phase: routeKind === "document" && !isRequisitionWorkflow ? "request" : editForm.phase,
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
    () => [...(rules ?? [])].sort((a, b) => {
      const phaseCompare = workflowPhaseLabel(a.phase).localeCompare(workflowPhaseLabel(b.phase));
      if (phaseCompare) return phaseCompare;
      return Number(a.amount_min) - Number(b.amount_min);
    }),
    [rules]
  );

  // Stage-aware gating: a later procurement stage may only be configured once
  // its predecessor has a routing rule. LPO is additionally unlocked by a
  // Requisition rule because Travel requisitions skip RFQ.
  const configuredPhases = new Set(
    (rules ?? []).map((r) => (r.phase || defaultPhase).trim().toLowerCase()),
  );
  const disabledPhases: WorkflowPhase[] = isRequisitionWorkflow
    ? (["rfq", "lpo"] as WorkflowPhase[]).filter((phase) => {
        if (phase === "rfq") return !configuredPhases.has("requisition");
        return !(configuredPhases.has("rfq") || configuredPhases.has("requisition"));
      })
    : [];

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
            {isRequisitionWorkflow ? "Procurement approval routing" : routeKind === "document" ? "Amount routing rules" : "Phase and amount routing rules"}
          </h3>
          <p className="text-xs text-muted-foreground mt-1">
            Rules for this template are automatically scoped to{" "}
            <span className="font-medium text-foreground">{isPaymentRun ? "payment runs" : template.document_type_name ?? "its document type"}</span>.
          </p>
        </div>
        {!showAdd && hasRoutingScope && (
          <button onClick={openAddRule} className="btn-primary text-xs px-3 py-1.5">
            <Plus className="w-3.5 h-3.5" /> Add rule
          </button>
        )}
      </div>

      {!hasRoutingScope && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-medium text-amber-900">Assign a document type to this template first</p>
          <p className="text-xs text-amber-800/80 mt-1">
            Routing rules are linked to the template&apos;s document type.
          </p>
        </div>
      )}

      {showAdd && hasRoutingScope && (
        <div className="rounded-xl border-2 border-accent/40 bg-accent/5 p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="text-sm font-semibold text-foreground">New routing rule</h4>
            <button onClick={() => setShowAdd(false)} className="p-1 rounded hover:bg-muted"><X className="w-4 h-4 text-muted-foreground" /></button>
          </div>
          <RuleFormFields values={form} routeKind={routeKind} isRequisitionWorkflow={isRequisitionWorkflow} disabledPhases={disabledPhases} onChange={(p) => setForm(f => ({ ...f, ...p }))} />
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

      {!isLoading && hasRoutingScope && sortedRules.length === 0 && !showAdd && (
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
                  <RuleFormFields values={editForm} routeKind={routeKind} isRequisitionWorkflow={isRequisitionWorkflow} disabledPhases={disabledPhases} onChange={(p) => setEditForm(f => ({ ...f, ...p }))} />
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
                      {(isPaymentRun || isFormWorkflow || isRequisitionWorkflow) && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-primary/10 text-primary">
                          {workflowPhaseLabel(rule.phase)}
                        </span>
                      )}
                      {rule.label && <span className="text-[11px] px-2 py-0.5 rounded-full bg-muted text-muted-foreground">{rule.label}</span>}
                    </div>
                    <p className="text-[11px] text-muted-foreground mt-1">
                      Matching {isPaymentRun ? "payment runs" : `${(rule.document_type_name ?? "this document type").toLowerCase()} documents`} will use this template.
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
  onDelete,
  allTemplates: _allTemplates,
  docTypes,
  initialTargetType = "document",
}: {
  template: WorkflowTemplate | null;
  docType?: DocumentType | null;
  initialTargetType?: WorkflowTargetType;
  onSaved: (t: WorkflowTemplate, isNew: boolean, meta?: { retiredSiblings?: boolean }) => void;
  onDuplicate?: () => void;
  onDelete?: () => void;
  allTemplates?: WorkflowTemplate[];
  docTypes?: DocumentType[];
}) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [targetType, setTargetType] = useState<WorkflowTargetType>("document");
  const [notifyUploaderOnApproval, setNotifyUploaderOnApproval] = useState(true);
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplates>({});
  const [selectedDocumentTypeId, setSelectedDocumentTypeId] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(!template);
  const [activeTab, setActiveTab] = useState<"flow" | "rules" | "emails">("flow");
  const [selectedBlockId, setSelectedBlockId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  /** After Import rules, the next save should deactivate the folded sibling templates. */
  const [retireSiblingsOnSave, setRetireSiblingsOnSave] = useState(false);

  useEffect(() => {
    setName(template?.name ?? (docType ? `${docType.name} Workflow` : initialTargetType === "payment_run" ? "Payment Run Workflow" : "New Template"));
    setDescription(template?.description ?? "");
    setBlocks(
      template?.definition?.blocks?.length
        ? template.definition.blocks
        : definitionFromSteps(template?.steps ?? []).blocks
    );
    setTargetType(template?.target_type ?? initialTargetType);
    setNotifyUploaderOnApproval(template?.notify_uploader_on_approval ?? true);
    setEmailTemplates(normalizeEmailTemplates(template?.email_templates));
    setSelectedDocumentTypeId((template?.target_type ?? initialTargetType) === "payment_run" ? null : (template?.document_type ?? docType?.id ?? null));
    setIsDirty(!template);
    setActiveTab("flow");
    setSelectedBlockId(null);
    setRetireSiblingsOnSave(false);
  }, [template?.id, docType?.id, initialTargetType]);

  // The legacy "Routing rules" tab disappears once the template is saved as a branched workflow.
  useEffect(() => {
    if (template?.definition && activeTab === "rules") setActiveTab("flow");
  }, [template?.definition, activeTab]);

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
  const selectedDocumentType = useMemo(
    () => availableDocTypes.find((item) => item.id === selectedDocumentTypeId) ?? docType ?? null,
    [availableDocTypes, selectedDocumentTypeId, docType]
  );
  const routeKind: WorkflowRouteKind = targetType === "payment_run"
    ? "payment_run"
    : isFormDocumentType(selectedDocumentType)
      ? "form"
      : "document";
  const canEditDocumentType = !template && !docType;

  const saveMutation = useMutation({
    mutationFn: (payload: {
      name: string; description: string;
      target_type: WorkflowTargetType;
      document_type: string | null; is_active: boolean;
      notify_uploader_on_approval: boolean;
      email_templates: EmailTemplates;
      steps: Partial<WorkflowStep>[];
      definition: WorkflowDefinition;
      retire_siblings?: boolean;
    }) =>
      template
        ? workflowAPI.updateTemplate(template.id, payload)
        : workflowAPI.createTemplate(payload),
    onSuccess: async ({ data }, variables) => {
      const normalized = normalizeTemplate(data);
      setIsDirty(false);
      setRetireSiblingsOnSave(false);
      qc.setQueryData(["workflow-template", normalized.id], normalized);
      qc.invalidateQueries({ queryKey: ["workflow-templates"] });
      qc.invalidateQueries({ queryKey: ["document-types"] });
      qc.invalidateQueries({ queryKey: ["workflow-template", normalized.id] });
      onSaved(normalized, !template, { retiredSiblings: Boolean(variables.retire_siblings) });
    },
    onError: (err: any) => {
      toast.error(formatApiError(err?.response?.data) || "Save failed");
    },
  });

  const fieldCatalog = useMemo(
    () => buildFieldCatalog(selectedDocumentType, targetType),
    [selectedDocumentType, targetType],
  );

  const handleBlocksChange = useCallback((next: Block[]) => {
    setBlocks(next);
    setIsDirty(true);
  }, []);

  const handleSave = () => {
    if (!name.trim())               { toast.error("Template name is required"); return; }
    if (targetType === "document" && !selectedDocumentTypeId) {
      toast.error("Choose the document type this template belongs to");
      return;
    }

    // HOD group is always "any member" — enforced on every approval step, wherever it sits in the tree.
    const blocksForSave = mapSteps(blocks, (step) => {
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

    const issues = validateDefinition(blocksForSave, fieldMap(fieldCatalog), validateStepData);
    const firstError = issues.find((i) => i.severity === "error");
    if (firstError) {
      toast.error(firstError.message);
      if (firstError.block_id) { setSelectedBlockId(firstError.block_id); setActiveTab("flow"); }
      return;
    }

    saveMutation.mutate({
      name: name.trim(),
      description: description.trim(),
      target_type: targetType,
      document_type: targetType === "payment_run" ? null : selectedDocumentTypeId,
      is_active: template ? template.is_active : true,
      notify_uploader_on_approval: notifyUploaderOnApproval,
      email_templates: emailTemplatesToPayload(emailTemplates),
      // Flat mirror in document order — keeps step_count / list views working. The engine follows `definition`.
      steps: flattenSteps(blocksForSave).map((s) => stepToPayload(s as WorkflowStep)),
      definition: {
        version: 2,
        blocks: mapSteps(blocksForSave, (s) => stepToPayload(s as WorkflowStep) as StepData),
      },
      ...(retireSiblingsOnSave ? { retire_siblings: true } : {}),
    });
  };

  /** One-off: fold this document type's existing templates + amount rules into a single branched workflow. */
  const handleImportLegacy = async () => {
    const siblings = (_allTemplates ?? []).filter((t) =>
      t.is_active !== false && t.target_type === targetType &&
      (targetType === "payment_run" ? !t.document_type : t.document_type === selectedDocumentTypeId));
    if (siblings.length === 0) { toast.warning("No existing templates found for this document type"); return; }
    const confirmMsg = siblings.length > 1
      ? `Fold ${siblings.length} templates and their amount rules into this one branched workflow? On save, the other templates will be deactivated.`
      : "Replace the current workflow with one built from the existing templates and routing rules?";
    if (blocks.length > 0 && !window.confirm(confirmMsg)) return;
    if (blocks.length === 0 && siblings.length > 1 && !window.confirm(confirmMsg)) return;
    setImporting(true);
    try {
      const full = await Promise.all(siblings.map((t) => workflowAPI.getTemplate(t.id).then((r) => normalizeTemplate(r.data))));
      const ruleLists = await Promise.all(full.map((t) =>
        workflowAPI.listRules({ template: t.id }).then((r) => (r.data.results ?? r.data) as WorkflowRule[])));
      const { definition, notes } = migrateLegacyRules(
        full.map((t) => ({ id: t.id, name: t.name, steps: t.steps.map(({ id: _id, ...rest }) => rest as StepData) })),
        ruleLists.flat(),
        { maxInclusive: true },
      );
      setBlocks(definition.blocks);
      setSelectedBlockId(null);
      setIsDirty(true);
      setRetireSiblingsOnSave(true);
      setActiveTab("flow");
      toast.success(
        `Imported ${full.length} template${full.length > 1 ? "s" : ""} as one workflow — review it, then save` +
        (full.length > 1 ? " (siblings will be retired)" : ""),
      );
      if (notes.length) toast.warning(notes.join(" "));
    } catch (err: any) {
      toast.error(formatApiError(err?.response?.data) || "Import failed");
    } finally {
      setImporting(false);
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between mb-4 flex-shrink-0 gap-4">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-3 flex-wrap">
            <span className="inline-flex items-center gap-1 text-[11px] font-medium text-muted-foreground bg-muted px-2.5 py-1 rounded-full">
              <FolderTree className="w-3 h-3" /> {targetType === "payment_run" ? "Payment run" : "Template scope"}
            </span>
            {targetType === "payment_run" ? (
              <span className="inline-flex items-center gap-1 text-xs font-medium text-accent bg-accent/20 px-2.5 py-1 rounded-full">
                Payment run approvals
              </span>
            ) : selectedDocumentTypeName && (
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
          {canEditDocumentType && (
            <div className="mt-3 max-w-sm">
              <Label required>Workflow target</Label>
              <CustomListbox
                ariaLabel="Workflow target"
                value={targetType}
                onChange={(v) => {
                  const next = v as WorkflowTargetType;
                  setTargetType(next);
                  if (next === "payment_run") setSelectedDocumentTypeId(null);
                  setIsDirty(true);
                }}
                options={[
                  { value: "document", label: "Document type" },
                  { value: "payment_run", label: "Payment run" },
                ]}
                buttonClassName="h-9 w-full rounded-lg border border-border bg-card px-3 text-sm text-foreground"
              />
            </div>
          )}
          {targetType === "document" && (
          <div className="mt-3 max-w-sm">
            <Label required>Document type</Label>
            {canEditDocumentType ? (
              <CustomListbox
                value={selectedDocumentTypeId ?? ""}
                onChange={(v) => { setSelectedDocumentTypeId(v || null); setIsDirty(true); }}
                options={[{ value: "", label: "Select document type" }, ...availableDocTypes.map((item) => ({ value: item.id, label: item.name }))]}
                className={inp}
                buttonClassName="w-full"
                ariaLabel="Document type"
              />
            ) : (
              <div className="rounded-lg border border-border bg-muted/40 px-3 py-2 text-sm font-medium text-foreground">
                {selectedDocumentTypeName ?? "No document type assigned"}
              </div>
            )}
          </div>
          )}
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
            {template && !template.definition && (
              <button
                onClick={() => setActiveTab("rules")}
                className={clsx("px-3 py-1.5 text-xs font-medium rounded-md transition-all",
                  activeTab === "rules" ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}
              >Routing rules (legacy)</button>
            )}
          </div>
          {isDirty && (
            <span className="text-[11px] text-accent bg-accent/20 px-2 py-1 rounded-md">
              Unsaved{retireSiblingsOnSave ? " · will retire siblings" : ""}
            </span>
          )}
          {(template || docType) && (
            <button onClick={handleImportLegacy} disabled={importing} className="btn-secondary text-sm"
              title="Fold this document type's existing templates and amount rules into one branched workflow">
              {importing ? <Loader2 className="w-4 h-4 animate-spin" /> : <GitBranch className="w-4 h-4" />}
              Import rules
            </button>
          )}
          {template && onDuplicate && (
            <button onClick={onDuplicate} className="btn-secondary text-sm">
              <Copy className="w-4 h-4" /> Duplicate
            </button>
          )}
          {template && onDelete && (
            <button
              onClick={onDelete}
              className="btn-secondary text-sm text-destructive hover:bg-destructive/10 hover:border-destructive/40"
            >
              <Trash2 className="w-4 h-4" /> Delete
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
        <BranchedWorkflowEditor
          blocks={blocks}
          onChange={handleBlocksChange}
          fields={fieldCatalog}
          groups={(groups ?? []).map((g) => ({ id: g.id, name: g.name }))}
          currencies={CURRENCIES}
          selectedId={selectedBlockId}
          onSelect={setSelectedBlockId}
          makeApprovalStep={() => blankStep() as StepData}
          makeNotificationStep={() => blankNotificationStep() as StepData}
          validateStep={validateStepData}
          renderStepPanel={({ block, index, total, onChange, onClose, onDelete }) => (
            <StepEditPanel
              step={block.step as WorkflowStep}
              index={index}
              total={total}
              groups={groups ?? []}
              docType={selectedDocumentType}
              onChange={onChange as (patch: Partial<WorkflowStep>) => void}
              onClose={onClose}
              onDelete={onDelete}
            />
          )}
        />
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
            target_type: targetType,
            document_type: targetType === "payment_run" ? null : selectedDocumentTypeId,
            document_type_name: targetType === "payment_run" ? "Payment run" : availableDocTypes.find((item) => item.id === selectedDocumentTypeId)?.name ?? template.document_type_name ?? null,
          })} routeKind={routeKind} />
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
  const isPaymentRun = template.target_type === "payment_run";
  const activeDocTypes = useMemo(() => docTypes.filter((d) => d.is_active), [docTypes]);

  const duplicateMutation = useMutation({
    mutationFn: () => workflowAPI.duplicateTemplate(template.id, newName.trim() || undefined),
    onSuccess: async ({ data }) => {
      let cloned = normalizeTemplate(data as WorkflowTemplate);
      if (selectedDocTypeId && selectedDocTypeId !== template.document_type) {
        try {
          const patchRes = await workflowAPI.updateTemplate(cloned.id, {
            name: cloned.name, description: cloned.description,
            target_type: "document",
            document_type: selectedDocTypeId, is_active: true,
            steps: (cloned.steps ?? []).map(stepToPayload),
            // Preserve branching when the copy is moved to another document type.
            ...(cloned.definition
              ? { definition: { ...cloned.definition, blocks: mapSteps(cloned.definition.blocks, (st) => stepToPayload(st as WorkflowStep) as StepData) } }
              : {}),
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
            {isPaymentRun ? " · Payment run" : template.document_type_name ? ` · ${template.document_type_name}` : ""}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="p-5 space-y-4">
          <div>
            <Label required>New template name</Label>
            <input value={newName} onChange={(e) => setNewName(e.target.value)} className="input" autoFocus />
          </div>
          {!isPaymentRun && (
            <div>
              <Label required>Document type</Label>
              <CustomListbox
                value={selectedDocTypeId ?? ""}
                onChange={(v) => setSelectedDocTypeId(v || null)}
                options={[{ value: "", label: "Select document type" }, ...activeDocTypes.map((d) => ({ value: d.id, label: d.name }))]}
                className="input"
                buttonClassName="w-full"
                ariaLabel="Document type"
              />
              <p className="text-[11px] text-muted-foreground mt-1">The duplicate can be assigned to a different document type.</p>
            </div>
          )}
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

// ── Delete Template Modal ─────────────────────────────────────────────────────
function DeleteTemplateModal({
  template, docTypes, onClose, onDeleted,
}: {
  template: WorkflowTemplate;
  docTypes: DocumentType[];
  onClose: () => void;
  onDeleted: (deletedId: string) => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const primaryForDocTypes = useMemo(
    () => docTypes.filter((d) => d.workflow_template === template.id),
    [docTypes, template.id]
  );

  const deleteMutation = useMutation({
    mutationFn: () => workflowAPI.deleteTemplate(template.id),
    onSuccess: () => {
      toast.success(`"${template.name}" permanently deleted`);
      onDeleted(template.id);
    },
    onError: (err: any) => {
      toast.error(formatApiError(err?.response?.data) || "Failed to delete workflow");
    },
  });

  const canDelete = confirmText.trim().toLowerCase() === "delete" && !deleteMutation.isPending;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-card rounded-2xl w-full max-w-md shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-destructive/15 flex items-center justify-center">
              <Trash2 className="w-4 h-4 text-destructive" />
            </div>
            <div>
              <h2 className="text-sm font-bold text-foreground">Delete workflow</h2>
              <p className="text-xs text-muted-foreground mt-0.5">This permanently removes the template and all its steps.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-muted rounded-lg transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="rounded-xl border border-border bg-muted/40 px-4 py-3">
            <p className="text-sm font-semibold text-foreground">{template.name}</p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {template.step_count ?? template.steps?.length ?? 0} steps
              {template.document_type_name ? ` · ${template.document_type_name}` : ""}
            </p>
          </div>

          <div className="flex items-start gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
            <AlertCircle className="w-4 h-4 text-destructive mt-0.5 flex-shrink-0" />
            <div className="text-xs text-foreground leading-relaxed">
              This action <span className="font-semibold">cannot be undone</span>. The template, its steps and
              its amount-based routing rules will be permanently deleted.
              {primaryForDocTypes.length > 0 && (
                <p className="mt-1.5">
                  It is the primary template for{" "}
                  <span className="font-semibold">
                    {primaryForDocTypes.map((d) => d.name).join(", ")}
                  </span>
                  , which will be left with no workflow until you assign a new one.
                </p>
              )}
            </div>
          </div>

          <div>
            <Label>Type <span className="font-mono font-semibold">delete</span> to confirm</Label>
            <input
              value={confirmText}
              onChange={(e) => setConfirmText(e.target.value)}
              className={inp}
              placeholder="delete"
              autoFocus
              onKeyDown={(e) => { if (e.key === "Enter" && canDelete) deleteMutation.mutate(); }}
            />
          </div>

          <div className="flex gap-2 pt-1">
            <button
              onClick={() => deleteMutation.mutate()}
              disabled={!canDelete}
              className={clsx(
                "flex-1 inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-xl font-medium transition-colors",
                canDelete
                  ? "bg-destructive text-white hover:bg-destructive/90"
                  : "bg-muted text-muted-foreground cursor-not-allowed"
              )}
            >
              {deleteMutation.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
              Delete permanently
            </button>
            <button onClick={onClose} className="btn-secondary">Cancel</button>
          </div>
        </div>
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
  const [creatingPaymentRunTemplate, setCreatingPaymentRunTemplate] = useState(false);
  const [duplicatingTemplate, setDuplicatingTemplate] = useState<WorkflowTemplate | null>(null);
  const [deletingTemplate, setDeletingTemplate] = useState<WorkflowTemplate | null>(null);

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
      setSelectedDocType(null); setEditingTemplateId(null); setCreatingForDocType(null); setCreatingPaymentRunTemplate(false);
      return;
    }
    setSelectedDocType(dt); setEditingTemplateId(null); setCreatingForDocType(null); setCreatingPaymentRunTemplate(false);
  };

  const handleTemplateClick = (t: WorkflowTemplate) => {
    setEditingTemplateId(t.id); setSelectedDocType(null); setCreatingForDocType(null); setCreatingPaymentRunTemplate(false);
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
    setSelectedDocType(null); setEditingTemplateId(null); setShowDetailModal(null); setCreatingPaymentRunTemplate(false);
  };

  const handleStartCreatePaymentRunTemplate = () => {
    setCreatingPaymentRunTemplate(true);
    setCreatingForDocType(null); setSelectedDocType(null); setEditingTemplateId(null); setShowDetailModal(null);
    setSidebarTab("templates");
  };

  const handleSaved = (t: WorkflowTemplate, isNew: boolean, meta?: { retiredSiblings?: boolean }) => {
    if (isNew && creatingForDocType) {
      documentTypesAPI.update(creatingForDocType.id, { workflow_template: t.id })
        .then(() => {
          toast.success(`Template "${t.name}" created and assigned`);
          qc.invalidateQueries({ queryKey: ["document-types"] });
          setEditingTemplateId(t.id);
          setSelectedDocType({ ...creatingForDocType, workflow_template: t.id });
          setCreatingForDocType(null);
          setCreatingPaymentRunTemplate(false);
        })
        .catch(() => {
          toast.warning(`Template created but failed to assign`);
          setEditingTemplateId(t.id);
          setSelectedDocType(creatingForDocType);
          setCreatingForDocType(null);
          setCreatingPaymentRunTemplate(false);
        });
    } else if (isNew) {
      setEditingTemplateId(t.id);
      setCreatingPaymentRunTemplate(false);
      toast.success(`Template "${t.name}" created`);
    } else {
      if (selectedDocType) setSelectedDocType(prev => prev ? { ...prev, workflow_template: t.id } : null);
      toast.success(
        meta?.retiredSiblings
          ? `Saved "${t.name}" — old amount-based templates for this form were retired`
          : `Template "${t.name}" saved`,
      );
    }
    qc.invalidateQueries({ queryKey: ["document-types"] });
    qc.invalidateQueries({ queryKey: ["workflow-templates"] });
  };

  const docTypesArray  = useMemo(() => Array.isArray(docTypes) ? docTypes : [], [docTypes]);
  // Workflows only apply to standard document types — personal documents and the
  // catch-all "Unclassified" type never run a workflow, so keep them out of the list.
  const workflowDocTypes = useMemo(
    () => docTypesArray.filter(
      (dt) => !deriveDocumentTypeConfig(dt).isPersonalType && dt.code !== "UNCLASS",
    ),
    [docTypesArray],
  );
  const filteredDocTypes = useMemo(
    () => workflowDocTypes.filter(dt => dt.name.toLowerCase().includes(search.toLowerCase())),
    [workflowDocTypes, search]
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

  const withTemplate    = workflowDocTypes.filter(d => d.workflow_template).length;
  const withoutTemplate = workflowDocTypes.length - withTemplate;

  const showEditor = selectedDocType || editingTemplateId || creatingForDocType || creatingPaymentRunTemplate;
  const currentTemplate = creatingForDocType || creatingPaymentRunTemplate ? null : (fetchedTemplate ?? null);
  const isLoadingTemplate =
    !creatingForDocType && !creatingPaymentRunTemplate && !!effectiveTemplateId &&
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
            <button
              type="button"
              onClick={handleStartCreatePaymentRunTemplate}
              className="inline-flex items-center gap-1 rounded-lg bg-accent/15 px-2.5 py-1.5 text-xs font-medium text-accent hover:bg-accent/25"
            >
              <Plus className="h-3.5 w-3.5" /> Payment Run
            </button>
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
                          className={clsx("w-full text-left rounded-xl p-3 pr-16 transition-all border",
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
                        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 opacity-0 group-hover/item:opacity-100 transition-opacity">
                          <button
                            onClick={(e) => { e.stopPropagation(); setDuplicatingTemplate(t); }}
                            title="Duplicate workflow"
                            className="p-1.5 rounded-lg border border-border bg-card hover:bg-accent/10 hover:border-accent/40 hover:text-accent transition-all"
                          >
                            <Copy className="w-3.5 h-3.5 text-muted-foreground" />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setDeletingTemplate(t); }}
                            title="Delete workflow"
                            className="p-1.5 rounded-lg border border-border bg-card hover:bg-destructive/10 hover:border-destructive/40 transition-all"
                          >
                            <Trash2 className="w-3.5 h-3.5 text-muted-foreground hover:text-destructive" />
                          </button>
                        </div>
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
              onDelete={currentTemplate ? () => setDeletingTemplate(currentTemplate) : undefined}
              allTemplates={resolvedTemplates}
              docTypes={docTypesArray}
              initialTargetType={creatingPaymentRunTemplate ? "payment_run" : "document"}
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

      {deletingTemplate && (
        <DeleteTemplateModal
          template={deletingTemplate}
          docTypes={docTypesArray}
          onClose={() => setDeletingTemplate(null)}
          onDeleted={(deletedId) => {
            setDeletingTemplate(null);
            if (editingTemplateId === deletedId) setEditingTemplateId(null);
            if (selectedDocType?.workflow_template === deletedId) setSelectedDocType(null);
            qc.invalidateQueries({ queryKey: ["workflow-templates"] });
            qc.invalidateQueries({ queryKey: ["document-types"] });
          }}
        />
      )}
    </div>
  );
}