import { useEffect, useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { groupsAPI, documentTypesAPI, usersAPI, normalizeListResponse, dmsSettingsAPI } from "@/services/api";
import {
  Plus, Users, Shield, ChevronRight, X, Loader2,
  Check, UserPlus, Settings2, Info, Trash2, Copy,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────
interface DocType   { id: string; name: string; code: string }
interface GroupPerm {
  id: string;
  document_type: string | null;
  document_type_name: string | null;
  stage: string;
  action: string;
}
interface Member    { id: string; user: { id: string; full_name: string; email: string; job_description?: string }; expires_at: string | null; is_active: boolean }
interface Group     { id: string; name: string; description: string; permissions: GroupPerm[]; member_count: number; has_admin_access: boolean; sees_all_documents: boolean }
interface User      { id: string; full_name: string; email: string; job_description?: string }

const ADMIN_GROUP_NAME = "Administrators";
const HOD_GROUP_NAME = "HOD";

/** Names of system-managed groups that cannot be duplicated or deleted. */
const SYSTEM_GROUPS = new Set([ADMIN_GROUP_NAME, HOD_GROUP_NAME]);

const PERMISSION_STAGES = [
  { value: "creation", label: "Creation", description: "Draft, upload, and resubmit" },
  { value: "approval", label: "For approval", description: "While workflow is in progress" },
  { value: "after_approval", label: "After approval", description: "Approved, rejected, or archived" },
] as const;

// Used when the org runs RBAC in global single-stage mode.
const GLOBAL_STAGE = [
  { value: "any", label: "All stages", description: "One configuration applied across the entire document lifecycle" },
] as const;

type PermissionStage = string;

const ALL_ACTIONS = [
  { value: "view",     label: "View",     description: "Open and read documents" },
  { value: "upload",   label: "Upload",   description: "Add new documents" },
  { value: "submit",   label: "Submit",   description: "Submit draft documents for approval" },
  { value: "edit",     label: "Edit",     description: "Update document metadata" },
  { value: "download", label: "Download", description: "Download file copies" },
  { value: "comment",  label: "Comment",  description: "Add comments" },
  { value: "approve",  label: "Approve",  description: "Act on workflow approvals" },
  { value: "archive",  label: "Archive",  description: "Move to archive" },
  { value: "delete",   label: "Delete",   description: "Void / delete documents" },
];

// Sentinel row key for the "fallback" configuration that applies to every
// document type (stored on the backend as a permission with document_type = null).
const GLOBAL_DT_KEY = "__all_document_types__";

function emptyMatrix(docTypes: DocType[]): Record<string, Set<string>> {
  const matrix: Record<string, Set<string>> = { [GLOBAL_DT_KEY]: new Set() };
  docTypes.forEach((dt) => { matrix[dt.id] = new Set(); });
  return matrix;
}

function buildStageMatrices(
  group: Group,
  docTypes: DocType[],
  singleStage: boolean,
): Record<PermissionStage, Record<string, Set<string>>> {
  const stageList = singleStage ? GLOBAL_STAGE : PERMISSION_STAGES;
  const stages = stageList.reduce((acc, stage) => {
    acc[stage.value] = emptyMatrix(docTypes);
    return acc;
  }, {} as Record<PermissionStage, Record<string, Set<string>>>);

  group.permissions.forEach((p) => {
    if (p.action === "admin") return;
    const stage = p.stage || "any";
    // Each mode shows only the permissions it manages, matching how the backend
    // resolves them: global mode reads the "any" config; stage mode reads per-stage.
    if (singleStage ? stage !== "any" : stage === "any") return;
    if (!stages[stage]) return;
    // A null document_type is the global fallback row.
    const dtKey = p.document_type ?? GLOBAL_DT_KEY;
    if (!stages[stage][dtKey]) stages[stage][dtKey] = new Set();
    stages[stage][dtKey].add(p.action);
  });

  return stages;
}

/** Whether the group currently has any global-fallback (null document_type) rules. */
function groupUsesGlobalFallback(group: Group): boolean {
  return group.permissions.some((p) => p.action !== "admin" && !p.document_type);
}

// ── Duplicate Group Modal ─────────────────────────────────────────────────────
function DuplicateGroupModal({
  group,
  onClose,
  onDuplicated,
}: {
  group: Group;
  onClose: () => void;
  onDuplicated: (newGroup: Group) => void;
}) {
  const [name, setName] = useState(`${group.name} (Copy)`);
  const [desc, setDesc] = useState(group.description);

  const mutation = useMutation({
    mutationFn: () => groupsAPI.duplicate(group.id, { name: name.trim(), description: desc.trim() }),
    onSuccess: (res) => {
      toast.success(`Group "${name.trim()}" created with ${group.permissions.filter(p => p.action !== "admin").length} permission rule(s) copied.`);
      onDuplicated(res.data as Group);
    },
    onError: (err: any) =>
      toast.error(extractApiError(err, "Failed to duplicate group.")),
  });

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-foreground/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-md bg-card rounded-2xl overflow-hidden border border-border"
           style={{ boxShadow: "var(--shadow-elegant)" }}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl bg-accent/15 flex items-center justify-center flex-shrink-0">
              <Copy className="w-4 h-4 text-accent" />
            </div>
            <div>
              <h2 className="font-semibold text-base text-foreground">Duplicate group</h2>
              <p className="text-xs text-muted-foreground">Copies name, description and all permission rules.</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 text-muted-foreground hover:text-foreground rounded-lg hover:bg-muted transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Source badge */}
        <div className="mx-6 mt-5 flex items-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-3">
          <Shield className="w-4 h-4 text-accent flex-shrink-0" />
          <div className="min-w-0">
            <p className="text-xs text-muted-foreground">Duplicating</p>
            <p className="text-sm font-semibold text-foreground truncate">{group.name}</p>
          </div>
        </div>

        {/* Form */}
        <div className="space-y-4 p-6">
          <div>
            <label className="label">New group name <span className="text-destructive">*</span></label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="input"
              placeholder="e.g. Finance Team (Copy)"
              autoFocus
              onKeyDown={(e) => e.key === "Enter" && name.trim() && mutation.mutate()}
            />
          </div>
          <div>
            <label className="label">Description</label>
            <input
              value={desc}
              onChange={(e) => setDesc(e.target.value)}
              className="input"
              placeholder="Optional description…"
            />
          </div>
          <div className="flex gap-3 pt-1">
            <button
              onClick={() => mutation.mutate()}
              disabled={!name.trim() || mutation.isPending}
              className="btn-primary flex-1 justify-center"
            >
              {mutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Duplicate group
            </button>
            <button onClick={onClose} className="btn-secondary px-6">Cancel</button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PermissionMatrix({
  group,
  docTypes,
  singleStage,
  onSave,
  isSaving,
}: {
  group: Group;
  docTypes: DocType[];
  singleStage: boolean;
  onSave: (perms: { document_type_id: string | null; stage: string; action: string }[]) => void;
  isSaving: boolean;
}) {
  const stageList = singleStage ? GLOBAL_STAGE : PERMISSION_STAGES;
  const [activeStage, setActiveStage] = useState<PermissionStage>(stageList[0].value);
  const [matrices, setMatrices] = useState(() => buildStageMatrices(group, docTypes, singleStage));
  const [useGlobal, setUseGlobal] = useState(() => groupUsesGlobalFallback(group));

  useEffect(() => {
    setActiveStage(stageList[0].value);
    setMatrices(buildStageMatrices(group, docTypes, singleStage));
    setUseGlobal(groupUsesGlobalFallback(group));
  }, [group.id, group.permissions, docTypes, singleStage]);

  const matrix = matrices[activeStage] ?? emptyMatrix(docTypes);

  const toggle = (dtKey: string, action: string) => {
    setMatrices((prev) => {
      const stageMatrix = { ...(prev[activeStage] ?? emptyMatrix(docTypes)) };
      const set = new Set(stageMatrix[dtKey] ?? []);
      set.has(action) ? set.delete(action) : set.add(action);
      stageMatrix[dtKey] = set;
      return { ...prev, [activeStage]: stageMatrix };
    });
  };

  const toggleAll = (dtKey: string) => {
    setMatrices((prev) => {
      const stageMatrix = { ...(prev[activeStage] ?? emptyMatrix(docTypes)) };
      const current = stageMatrix[dtKey] ?? new Set();
      stageMatrix[dtKey] = current.size === ALL_ACTIONS.length
        ? new Set()
        : new Set(ALL_ACTIONS.map((a) => a.value));
      return { ...prev, [activeStage]: stageMatrix };
    });
  };

  const handleSave = () => {
    const perms: { document_type_id: string | null; stage: string; action: string }[] = [];
    stageList.forEach(({ value: stage }) => {
      const stageMatrix = matrices[stage] ?? emptyMatrix(docTypes);
      Object.entries(stageMatrix).forEach(([key, actions]) => {
        const isGlobalRow = key === GLOBAL_DT_KEY;
        // Mutually exclusive: in global-fallback mode save only the fallback row;
        // otherwise save only the per-document-type rows.
        if (useGlobal !== isGlobalRow) return;
        actions.forEach((action) => {
          perms.push({
            document_type_id: isGlobalRow ? null : key,
            stage,
            action,
          });
        });
      });
    });
    onSave(perms);
  };

  const rows = [
    ...docTypes.map((dt) => ({ key: dt.id, label: dt.name, sublabel: `${dt.code}-XXXXX` })),
  ];

  // Renders one action checkbox cell, inactive (greyed, non-interactive) when
  // the row's mode isn't the one in use.
  const renderCheck = (rowKey: string, action: string, disabled: boolean) => {
    const checked = matrix[rowKey]?.has(action) ?? false;
    return (
      <td key={action} className="px-4 py-3.5 text-center">
        <button
          type="button"
          disabled={disabled}
          onClick={() => toggle(rowKey, action)}
          className={clsx(
            "w-6 h-6 rounded-md border-2 flex items-center justify-center mx-auto transition-all",
            checked
              ? "bg-[#287EAD] border-[#287EAD]"
              : "border-border hover:border-[#287EAD]/60",
            disabled && "opacity-40 cursor-not-allowed hover:border-border",
          )}
        >
          {checked && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
        </button>
      </td>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-sm text-foreground bg-[#287EAD]/10 border border-[#287EAD]/30 rounded-xl p-4">
        <Info className="w-5 h-5 flex-shrink-0 text-[#287EAD]" />
        <span>
          {singleStage
            ? "One configuration applies across the entire document lifecycle (single-stage mode is on in DMS settings)."
            : "Configure explicit permissions per document type and lifecycle stage. Rules at one stage apply only to that stage."}
        </span>
      </div>

      {/* Fallback (all document types) toggle */}
      <label className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 cursor-pointer">
        <input
          type="checkbox"
          checked={useGlobal}
          onChange={(e) => setUseGlobal(e.target.checked)}
          className="mt-0.5 h-4 w-4 accent-[#287EAD]"
        />
        <div>
          <p className="text-sm font-semibold text-foreground">Use one configuration for all document types</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Set access once and apply it to every document type. The per-document-type
            rows below are disabled while this is on — use this <span className="font-medium">or</span> per-type rules, not both.
          </p>
        </div>
      </label>

      {!singleStage && (
        <>
          <div className="flex flex-wrap gap-2">
            {PERMISSION_STAGES.map((stage) => (
              <button
                key={stage.value}
                type="button"
                title={stage.description}
                onClick={() => setActiveStage(stage.value)}
                className={clsx(
                  "px-4 py-2 rounded-lg text-sm font-medium border transition-colors",
                  activeStage === stage.value
                    ? "bg-[#287EAD] text-white border-[#287EAD]"
                    : "bg-card text-foreground border-border hover:border-[#287EAD]/50"
                )}
              >
                {stage.label}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted-foreground -mt-2">
            {PERMISSION_STAGES.find((s) => s.value === activeStage)?.description}
          </p>
        </>
      )}

      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="bg-muted/60 border-b border-border">
              <th className="text-left px-6 py-3 font-semibold text-foreground w-56 text-xs uppercase tracking-wider">Document Type</th>
              {ALL_ACTIONS.map((a) => (
                <th key={a.value} className="px-4 py-3 font-semibold text-foreground text-center w-24 text-xs uppercase tracking-wider" title={a.description}>
                  {a.label}
                </th>
              ))}
              <th className="px-6 py-3 font-semibold text-muted-foreground text-center w-20 text-xs uppercase tracking-wider">All</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border bg-card">
            {/* Fallback row — applies to every document type */}
            <tr className={clsx(
              "border-b-2 border-[#287EAD]/30 bg-[#287EAD]/5 transition-opacity",
              !useGlobal && "opacity-50",
            )}>
              <td className="px-6 py-3.5">
                <p className="font-semibold text-sm text-[#287EAD]">All document types</p>
                <p className="text-xs text-muted-foreground mt-0.5">Fallback for every type</p>
              </td>
              {ALL_ACTIONS.map((a) => renderCheck(GLOBAL_DT_KEY, a.value, !useGlobal))}
              <td className="px-6 py-3.5 text-center">
                <button
                  type="button"
                  disabled={!useGlobal}
                  onClick={() => toggleAll(GLOBAL_DT_KEY)}
                  className={clsx(
                    "text-xs font-semibold text-[#287EAD] hover:text-[#287EAD]/80 hover:underline",
                    !useGlobal && "opacity-40 cursor-not-allowed no-underline hover:no-underline",
                  )}
                >
                  {(matrix[GLOBAL_DT_KEY]?.size ?? 0) === ALL_ACTIONS.length ? "Clear" : "Select all"}
                </button>
              </td>
            </tr>
            {rows.map(({ key, label, sublabel }) => (
              <tr key={key} className={clsx(
                "hover:bg-muted/40 transition-colors",
                useGlobal && "opacity-50",
              )}>
                <td className="px-6 py-3.5">
                  <p className="font-medium text-sm text-foreground">
                    {label}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{sublabel}</p>
                </td>
                {ALL_ACTIONS.map((a) => renderCheck(key, a.value, useGlobal))}
                <td className="px-6 py-3.5 text-center">
                  <button
                    type="button"
                    disabled={useGlobal}
                    onClick={() => toggleAll(key)}
                    className={clsx(
                      "text-xs font-semibold text-[#287EAD] hover:text-[#287EAD]/80 hover:underline",
                      useGlobal && "opacity-40 cursor-not-allowed no-underline hover:no-underline",
                    )}
                  >
                    {(matrix[key]?.size ?? 0) === ALL_ACTIONS.length ? "Clear" : "Select all"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="btn-primary px-6"
        >
          {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
          {isSaving ? "Saving…" : "Save permissions"}
        </button>
      </div>
    </div>
  );
}

// ── Group Detail Panel ────────────────────────────────────────────────────────
function GroupDetail({
  group,
  docTypes,
  onClose,
}: {
  group: Group;
  docTypes: DocType[];
  onClose: () => void;
}) {
  const qc = useQueryClient();
  const [tab, setTab] = useState<"permissions" | "members">("permissions");
  const [userSearch, setUserSearch] = useState("");
  const isHodGroup = group.name === HOD_GROUP_NAME;
  const isBuiltInGroup = isHodGroup;

  const { data: dms } = useQuery({
    queryKey: ["dms-settings"],
    queryFn: () => dmsSettingsAPI.get().then((r) => r.data),
  });
  const singleStage = Boolean(dms?.rbac_single_stage);

  const { data: members = [] } = useQuery<Member[]>({
    queryKey: ["group-members", group.id],
    queryFn: () => groupsAPI.members(group.id).then((r) => r.data),
  });

  const { data: groupDetail } = useQuery<any>({
    queryKey: ["group", group.id],
    queryFn: () => groupsAPI.get(group.id).then((r) => r.data),
  });

  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ["users-search", userSearch],
    queryFn: () => usersAPI.list({
      search: userSearch || undefined,
      page_size: 20
    }).then((r) => r.data.results ?? r.data),
    enabled: tab === "members" && !isHodGroup,
  });

  const setPermsMutation = useMutation({
    mutationFn: (perms: { document_type_id: string | null; stage: string; action: string }[]) =>
      groupsAPI.setPermissions(group.id, perms),
    onSuccess: () => {
      toast.success("Permissions saved successfully");
      qc.invalidateQueries({ queryKey: ["groups"] });
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to save permissions")),
  });

  const setSeesAllMutation = useMutation({
    mutationFn: (value: boolean) => groupsAPI.update(group.id, { sees_all_documents: value }),
    onSuccess: (_d, value) => {
      toast.success(value
        ? "This group can now see all documents."
        : "Document visibility for this group is back to involvement-only.");
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["group", group.id] });
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to update document visibility")),
  });

  const deleteMutation = useMutation({
    mutationFn: () => groupsAPI.delete(group.id),
    onSuccess: () => {
      toast.success("Group deleted");
      qc.invalidateQueries({ queryKey: ["groups"] });
      onClose();
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to delete group")),
  });

  const addMemberMutation = useMutation({
    mutationFn: (userId: string) => groupsAPI.addMember(group.id, userId),
    onSuccess: () => {
      toast.success("Member added");
      qc.invalidateQueries({ queryKey: ["group-members", group.id] });
      qc.invalidateQueries({ queryKey: ["groups"] });
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to add member")),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => groupsAPI.removeMember(group.id, userId),
    onSuccess: () => {
      toast.success("Member removed");
      qc.invalidateQueries({ queryKey: ["group-members", group.id] });
      qc.invalidateQueries({ queryKey: ["groups"] });
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to remove member")),
  });

  const setHeadMutation = useMutation({
    mutationFn: (headId: string | null) =>
      groupsAPI.update(group.id, { head_id: headId }).then((r) => r.data),
    onSuccess: (_data, headId) => {
      toast.success(headId === null ? "Group approver cleared" : "Group approver updated");
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["group", group.id] });
      qc.invalidateQueries({ queryKey: ["group-members", group.id] });
    },
    onError: (err: any) => toast.error(err?.response?.data?.head_id?.[0] || "Failed to update group approver"),
  });

  // Defend against orphaned memberships whose user no longer resolves (the API
  // can return user: null for a stale row). One such row must not crash the page.
  const safeMembers = (members ?? []).filter((m) => Boolean(m && m.user));
  const memberIds = new Set(safeMembers.map((m) => m.user.id));
  const currentHead = groupDetail?.head ?? null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-sm p-4">
      <div
        className="w-full max-w-4xl bg-card rounded-2xl overflow-hidden max-h-[92vh] flex flex-col border border-border"
        style={{ boxShadow: "var(--shadow-elegant)" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-5 border-b border-border bg-muted/40">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-xl bg-accent/15 flex items-center justify-center">
              <Shield className="w-5 h-5 text-accent" />
            </div>
            <div>
              <h2 className="font-semibold text-xl text-foreground tracking-tight">{group.name}</h2>
              {isHodGroup && (
                <p className="text-xs font-semibold uppercase tracking-widest text-accent mt-1">
                  Synced from department heads
                </p>
              )}
              {group.description && <p className="text-sm text-muted-foreground">{group.description}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!isBuiltInGroup && (
              <button
                onClick={() => {
                  if (window.confirm(`Delete group "${group.name}"? This will remove its members and permissions.`)) {
                    deleteMutation.mutate();
                  }
                }}
                disabled={deleteMutation.isPending}
                className="px-3 py-2 rounded-lg text-sm font-semibold text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
              >
                {deleteMutation.isPending ? "Deleting..." : "Delete"}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-2 text-muted-foreground hover:text-foreground hover:bg-muted rounded-lg transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Tabs */}
        <div className="border-b border-border px-8">
          <nav className="-mb-px flex gap-8">
            {[
              { id: "permissions", label: "Permissions", icon: Shield },
              { id: "members", label: `Members (${group.member_count})`, icon: Users },
            ].map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id as typeof tab)}
                className={clsx(
                  "flex items-center gap-2 px-1 py-4 text-sm font-medium border-b-2 transition-colors -mb-px",
                  tab === id
                    ? "border-accent text-accent"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </nav>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-8 bg-background">
          {tab === "permissions" && (
            <div className="space-y-6">
              {/* Sees-all-documents (auditor) toggle */}
              <label className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 cursor-pointer">
                <input
                  type="checkbox"
                  checked={Boolean(groupDetail?.sees_all_documents ?? group.sees_all_documents)}
                  disabled={setSeesAllMutation.isPending}
                  onChange={(e) => setSeesAllMutation.mutate(e.target.checked)}
                  className="mt-0.5 h-4 w-4 accent-[#287EAD]"
                />
                <div>
                  <p className="text-sm font-semibold text-foreground">This group can see all documents</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Members get full visibility of every document (e.g. auditors) — in lists and
                    search — bypassing the involvement rule. What they can <span className="font-medium">do</span> with each
                    document is still governed by the permissions below.
                  </p>
                </div>
              </label>

              <PermissionMatrix
                group={group}
                docTypes={docTypes}
                singleStage={singleStage}
                onSave={(perms) => setPermsMutation.mutate(perms)}
                isSaving={setPermsMutation.isPending}
              />
            </div>
          )}

          {tab === "members" && (
            <div className="space-y-8">
              {/* Current Members */}
              <div>
                <h3 className="font-semibold text-base text-foreground mb-4">Current members</h3>
                <div className="mb-6">
                  <h4 className="text-sm font-semibold text-foreground mb-2">Designated approver</h4>
                  {currentHead ? (
                    <div className="flex items-center gap-4 p-4 bg-accent/10 border border-accent/30 rounded-xl">
                      <div className="w-10 h-10 rounded-full bg-accent/20 flex items-center justify-center text-accent text-sm font-bold flex-shrink-0">
                        {currentHead.full_name.split(" ").map((n: string) => n[0]).join("").slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-foreground text-sm">{currentHead.full_name}</p>
                        <p className="text-xs text-muted-foreground">{currentHead.email}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="badge bg-accent/15 text-accent text-xs">Approver</span>
                        <button
                          type="button"
                          onClick={() => setHeadMutation.mutate(null)}
                          disabled={setHeadMutation.isPending}
                          className="text-xs font-semibold text-muted-foreground hover:text-destructive transition-colors"
                        >
                          Clear approver
                        </button>
                      </div>
                    </div>
                  ) : (
                    <div className="border border-dashed border-border rounded-xl p-4 text-sm text-muted-foreground">No approver set for this group.</div>
                  )}
                </div>
                <div className="space-y-2">
                  {safeMembers.map((m) => (
                    <div key={m.id} className="flex items-center gap-4 p-4 bg-card border border-border rounded-xl hover:border-accent/40 transition-colors group">
                      <div className="w-10 h-10 rounded-full bg-accent/15 flex items-center justify-center text-accent text-sm font-bold">
                        {m.user.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-foreground text-sm">{m.user.full_name}</p>
                        <p className="text-xs text-muted-foreground">{m.user.email}</p>
                      </div>
                      <div className="flex items-center gap-3">
                      <span className="badge text-xs bg-muted text-muted-foreground">
                          {m.user.job_description || "Staff"}
                      </span>
                        {m.expires_at && (
                          <span className="text-xs text-muted-foreground">
                            Expires {new Date(m.expires_at).toLocaleDateString()}
                          </span>
                        )}
                        {!isHodGroup && (
                          <>
                            <button
                              onClick={() => removeMemberMutation.mutate(m.user.id)}
                              className="opacity-0 group-hover:opacity-100 text-destructive hover:bg-destructive/10 p-2 rounded-lg transition-all"
                            >
                              <X className="w-4 h-4" />
                            </button>
                            {currentHead?.id !== m.user.id && (
                              <button
                                onClick={() => setHeadMutation.mutate(m.user.id)}
                                className="ml-2 opacity-0 group-hover:opacity-100 text-accent hover:bg-accent/10 p-2 rounded-lg transition-all text-xs"
                              >
                                Set as approver
                              </button>
                            )}
                          </>
                        )}
                      </div>
                    </div>
                  ))}
                  {!members?.length && (
                    <div className="text-center py-12 text-muted-foreground border border-dashed border-border rounded-xl text-sm">
                      No members yet. Add some from below.
                    </div>
                  )}
                </div>
              </div>

              {/* Add Members */}
              <div>
                <h3 className="font-semibold text-base text-foreground mb-4">Add members</h3>
                {isHodGroup && (
                  <div className="mb-4 rounded-xl border border-accent/30 bg-accent/10 p-4 text-sm text-foreground">
                    HOD group membership is managed by setting a head on each department.
                  </div>
                )}
                <input
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  className="input mb-4"
                  placeholder="Search users by name or email…"
                  disabled={isHodGroup}
                />

                {!isHodGroup && (
                <div className="max-h-96 overflow-y-auto border border-border rounded-xl divide-y divide-border bg-card">
                  {allUsers
                    ?.filter((u) => !memberIds.has(u.id))
                    .map((u) => (
                      <div
                        key={u.id}
                        className="flex items-center gap-4 p-4 hover:bg-muted/40 transition-colors"
                      >
                        <div className="w-10 h-10 rounded-full bg-muted flex items-center justify-center text-muted-foreground text-sm font-bold">
                          {u.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-foreground text-sm">{u.full_name}</p>
                          <p className="text-xs text-muted-foreground">{u.email}</p>
                        </div>
                        <span className="badge text-xs bg-muted text-muted-foreground">
                          {u.job_description || "Staff"}
                        </span>
                        <div className="flex items-center gap-2">
                          <button
                            onClick={() => addMemberMutation.mutate(u.id)}
                            disabled={addMemberMutation.isPending}
                            className="btn-primary text-xs px-4 py-2"
                          >
                            <UserPlus className="w-3.5 h-3.5" /> Add
                          </button>
                        </div>
                      </div>
                    ))}
                </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main GroupsPage ───────────────────────────────────────────────────────────
export default function GroupsPage() {
  const qc = useQueryClient();
  const [selectedGroup, setSelected] = useState<Group | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newDesc, setNewDesc] = useState("");
  const [duplicatingGroup, setDuplicatingGroup] = useState<Group | null>(null);

  const { data: groups = [], isLoading } = useQuery<Group[]>({
    queryKey: ["groups"],
    queryFn: () => groupsAPI.list().then((r) => r.data.results ?? r.data),
  });
  const orderedGroups = [...groups].sort((a, b) => {
    return a.name.localeCompare(b.name);
  });

  const { data: docTypes = [] } = useQuery<unknown, Error, DocType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<DocType>(data),
  });

  const createMutation = useMutation({
    mutationFn: () => groupsAPI.create({ name: newName.trim(), description: newDesc.trim() }),
    onSuccess: () => {
      toast.success("Group created successfully");
      qc.invalidateQueries({ queryKey: ["groups"] });
      setShowCreate(false);
      setNewName("");
      setNewDesc("");
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to create group")),
  });

  const deleteGroupMutation = useMutation({
    mutationFn: (groupId: string) => groupsAPI.delete(groupId),
    onSuccess: (_data, groupId) => {
      toast.success("Group deleted");
      qc.invalidateQueries({ queryKey: ["groups"] });
      if (selectedGroup?.id === groupId) {
        setSelected(null);
      }
    },
    onError: (err) => toast.error(extractApiError(err, "Failed to delete group")),
  });

  return (
    <div className="admin-shell">
      <div className="admin-page-header flex items-end justify-between gap-4">
        <div>
          <h1 className="admin-page-title">Permission groups</h1>
          <p className="admin-page-subtitle">
            Define fine-grained access control per document type.
          </p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="btn-primary"
        >
          <Plus className="w-4 h-4" /> New group
        </button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="card p-6 max-w-lg mb-8">
          <h2 className="text-base font-semibold mb-4 text-foreground">Create new group</h2>
          <div className="space-y-4">
            <div>
              <label className="label">Group name <span className="text-destructive">*</span></label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="input"
                placeholder="e.g. Finance Team"
                autoFocus
              />
            </div>
            <div>
              <label className="label">Description</label>
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="input"
                placeholder="Optional description…"
              />
            </div>
            <div className="flex gap-3 pt-1">
              <button
                onClick={() => createMutation.mutate()}
                disabled={!newName.trim() || createMutation.isPending}
                className="btn-primary flex-1 justify-center"
              >
                {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Create group
              </button>
              <button onClick={() => setShowCreate(false)} className="btn-secondary px-6">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Groups Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
        {isLoading && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card p-6 animate-pulse">
            <div className="h-6 bg-muted rounded w-3/4 mb-4" />
            <div className="h-4 bg-muted rounded w-1/2" />
          </div>
        ))}

        {orderedGroups?.map((group) => {
          const ruleCount = group.permissions.filter((p) => p.action !== "admin").length;
          const isSystemGroup = SYSTEM_GROUPS.has(group.name);
          const isHodGroup = group.name === HOD_GROUP_NAME;

          return (
            <div
              key={group.id}
              onClick={() => setSelected(group)}
              className="card p-6 hover:border-accent/40 transition-all duration-200 cursor-pointer group"
              style={{ boxShadow: "var(--shadow-card)" }}
            >
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-accent/15 flex items-center justify-center flex-shrink-0">
                    <Shield className="w-6 h-6 text-accent" />
                  </div>
                  <div>
                    <h3 className="font-semibold text-lg text-foreground group-hover:text-accent transition-colors">
                      {group.name}
                    </h3>
                    {isHodGroup && (
                      <span className="inline-flex items-center rounded-full bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent mt-2">
                        Synced from department heads
                      </span>
                    )}
                    {group.description && (
                      <p className="text-sm text-muted-foreground line-clamp-2 mt-0.5">{group.description}</p>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-6 flex items-center justify-between text-sm">
                <div className="flex gap-5 text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <Users className="w-4 h-4" /> {group.member_count} members
                  </span>
                  <span className="flex items-center gap-1.5">
                    <Settings2 className="w-4 h-4" /> {ruleCount} rules
                  </span>
                </div>
                <div className="flex items-center gap-1">
                  {!isSystemGroup && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setDuplicatingGroup(group);
                      }}
                      className="p-2 rounded-lg text-muted-foreground hover:text-accent hover:bg-accent/10 transition-colors opacity-0 group-hover:opacity-100"
                      title="Duplicate group"
                    >
                      <Copy className="w-4 h-4" />
                    </button>
                  )}
                  {!isSystemGroup && (
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (window.confirm(`Delete group "${group.name}"? This removes members and permissions.`)) {
                          deleteGroupMutation.mutate(group.id);
                        }
                      }}
                      disabled={deleteGroupMutation.isPending}
                      className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                      title="Delete group"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                  <ChevronRight className="w-5 h-5 text-muted-foreground group-hover:text-accent transition-colors" />
                </div>
              </div>
            </div>
          );
        })}

        {!isLoading && !groups?.length && !showCreate && (
          <div className="col-span-full py-20 text-center">
            <Shield className="w-16 h-16 text-muted-foreground/30 mx-auto mb-5" />
            <p className="text-xl font-semibold text-foreground">No groups yet</p>
            <p className="text-muted-foreground mt-2 max-w-md mx-auto text-sm">
              Create permission groups to control who can view, edit, approve, or delete documents.
            </p>
            <button
              onClick={() => setShowCreate(true)}
              className="btn-primary mt-6"
            >
              <Plus className="w-4 h-4" /> Create first group
            </button>
          </div>
        )}
      </div>

      {/* Group Detail Panel */}
      {selectedGroup && (
        <GroupDetail
          group={selectedGroup}
          docTypes={docTypes ?? []}
          onClose={() => setSelected(null)}
        />
      )}

      {/* Duplicate Modal */}
      {duplicatingGroup && (
        <DuplicateGroupModal
          group={duplicatingGroup}
          onClose={() => setDuplicatingGroup(null)}
          onDuplicated={(newGroup) => {
            setDuplicatingGroup(null);
            qc.invalidateQueries({ queryKey: ["groups"] });
            setSelected(newGroup);
          }}
        />
      )}
    </div>
  );
}
