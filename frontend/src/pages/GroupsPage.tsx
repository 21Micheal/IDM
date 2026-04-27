import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { groupsAPI, documentTypesAPI, usersAPI, normalizeListResponse } from "@/services/api";
import {
  Plus, Users, Shield, ChevronRight, X, Loader2,
  Check, UserPlus, Settings2, Info, Trash2,
} from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────
interface DocType   { id: string; name: string; code: string }
interface GroupPerm { id: string; document_type: string | null; document_type_name: string | null; action: string }
interface Member    { id: string; user: { id: string; full_name: string; email: string; job_description?: string }; expires_at: string | null; is_active: boolean }
interface Group     { id: string; name: string; description: string; permissions: GroupPerm[]; member_count: number; has_admin_access: boolean }
interface User      { id: string; full_name: string; email: string; job_description?: string }

const ALL_ACTIONS = [
  { value: "view",     label: "View",     description: "Open and read documents" },
  { value: "upload",   label: "Upload",   description: "Add new documents" },
  { value: "edit",     label: "Edit",     description: "Update document metadata" },
  { value: "download", label: "Download", description: "Download file copies" },
  { value: "comment",  label: "Comment",  description: "Add comments" },
  { value: "approve",  label: "Approve",  description: "Act on workflow approvals" },
  { value: "archive",  label: "Archive",  description: "Move to archive" },
  { value: "delete",   label: "Delete",   description: "Void / delete documents" },
];

// ── Permission Matrix ────────────────────────────────────────────────────────
function PermissionMatrix({
  group,
  docTypes,
  onSave,
  isSaving,
}: {
  group: Group;
  docTypes: DocType[];
  onSave: (perms: { document_type_id: string | null; action: string }[]) => void;
  isSaving: boolean;
}) {
  const init: Record<string, Set<string>> = { "__all__": new Set() };
  docTypes.forEach((dt) => { init[dt.id] = new Set(); });
  group.permissions.forEach((p) => {
    if (p.action === "admin") return;
    const key = p.document_type ?? "__all__";
    if (!init[key]) init[key] = new Set();
    init[key].add(p.action);
  });

  const [matrix, setMatrix] = useState<Record<string, Set<string>>>(init);

  const toggle = (dtKey: string, action: string) => {
    setMatrix((prev) => {
      const next = { ...prev };
      const set = new Set(prev[dtKey] ?? []);
      set.has(action) ? set.delete(action) : set.add(action);
      next[dtKey] = set;
      return next;
    });
  };

  const toggleAll = (dtKey: string) => {
    setMatrix((prev) => {
      const current = prev[dtKey] ?? new Set();
      const next = { ...prev };
      next[dtKey] = current.size === ALL_ACTIONS.length
        ? new Set()
        : new Set(ALL_ACTIONS.map((a) => a.value));
      return next;
    });
  };

  const handleSave = () => {
    const perms: { document_type_id: string | null; action: string }[] = [];
    Object.entries(matrix).forEach(([key, actions]) => {
      actions.forEach((action) => {
        perms.push({
          document_type_id: key === "__all__" ? null : key,
          action,
        });
      });
    });
    onSave(perms);
  };

  const rows = [
    { key: "__all__", label: "All document types", sublabel: "Wildcard — applies when no specific rule exists" },
    ...docTypes.map((dt) => ({ key: dt.id, label: dt.name, sublabel: `${dt.code}-XXXXX` })),
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 text-sm text-foreground bg-accent/10 border border-accent/30 rounded-xl p-4">
        <Info className="w-5 h-5 flex-shrink-0 text-accent" />
        <span>
          Select the actions members of this group can perform for each document type.
          "All document types" acts as a fallback.
        </span>
      </div>

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
            {rows.map(({ key, label, sublabel }, idx) => (
              <tr key={key} className={clsx("hover:bg-muted/40 transition-colors", idx === 0 && "bg-accent/5")}>
                <td className="px-6 py-3.5">
                  <p className={clsx("font-medium text-sm", idx === 0 ? "text-accent" : "text-foreground")}>
                    {label}
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">{sublabel}</p>
                </td>
                {ALL_ACTIONS.map((a) => {
                  const checked = matrix[key]?.has(a.value) ?? false;
                  return (
                    <td key={a.value} className="px-4 py-3.5 text-center">
                      <button
                        type="button"
                        onClick={() => toggle(key, a.value)}
                        className={clsx(
                          "w-6 h-6 rounded-md border-2 flex items-center justify-center mx-auto transition-all",
                          checked
                            ? "bg-accent border-accent"
                            : "border-border hover:border-accent/60"
                        )}
                      >
                        {checked && <Check className="w-4 h-4 text-accent-foreground" strokeWidth={3} />}
                      </button>
                    </td>
                  );
                })}
                <td className="px-6 py-3.5 text-center">
                  <button
                    type="button"
                    onClick={() => toggleAll(key)}
                    className="text-xs font-semibold text-accent hover:text-accent/80 hover:underline"
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
  const [adminAccess, setAdminAccess] = useState(group.has_admin_access);

  useEffect(() => {
    setAdminAccess(group.has_admin_access);
  }, [group.id, group.has_admin_access]);

  const { data: members = [] } = useQuery<Member[]>({
    queryKey: ["group-members", group.id],
    queryFn: () => groupsAPI.members(group.id).then((r) => r.data),
  });

  const { data: allUsers = [] } = useQuery<User[]>({
    queryKey: ["users-search", userSearch],
    queryFn: () => usersAPI.list({
      search: userSearch || undefined,
      page_size: 20
    }).then((r) => r.data.results ?? r.data),
    enabled: tab === "members",
  });

  const setPermsMutation = useMutation({
    mutationFn: (perms: { document_type_id: string | null; action: string }[]) =>
      groupsAPI.setPermissions(group.id, perms),
    onSuccess: () => {
      toast.success("Permissions saved successfully");
      qc.invalidateQueries({ queryKey: ["groups"] });
    },
    onError: () => toast.error("Failed to save permissions"),
  });

  const adminAccessMutation = useMutation({
    mutationFn: (enabled: boolean) => groupsAPI.setAdminAccess(group.id, enabled),
    onMutate: (enabled) => {
      setAdminAccess(enabled);
    },
    onSuccess: () => {
      toast.success("Administrator access updated");
      qc.invalidateQueries({ queryKey: ["groups"] });
    },
    onError: () => {
      setAdminAccess(group.has_admin_access);
      toast.error("Failed to update administrator access");
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => groupsAPI.delete(group.id),
    onSuccess: () => {
      toast.success("Group deleted");
      qc.invalidateQueries({ queryKey: ["groups"] });
      onClose();
    },
    onError: () => toast.error("Failed to delete group"),
  });

  const addMemberMutation = useMutation({
    mutationFn: (userId: string) => groupsAPI.addMember(group.id, userId),
    onSuccess: () => {
      toast.success("Member added");
      qc.invalidateQueries({ queryKey: ["group-members", group.id] });
      qc.invalidateQueries({ queryKey: ["groups"] });
    },
    onError: () => toast.error("Failed to add member"),
  });

  const removeMemberMutation = useMutation({
    mutationFn: (userId: string) => groupsAPI.removeMember(group.id, userId),
    onSuccess: () => {
      toast.success("Member removed");
      qc.invalidateQueries({ queryKey: ["group-members", group.id] });
      qc.invalidateQueries({ queryKey: ["groups"] });
    },
    onError: () => toast.error("Failed to remove member"),
  });

  const memberIds = new Set(members?.map((m) => m.user.id) ?? []);

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
              {group.has_admin_access && (
                <p className="text-xs font-semibold uppercase tracking-widest text-accent mt-1">
                  System administrator group
                </p>
              )}
              {group.description && <p className="text-sm text-muted-foreground">{group.description}</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {!group.has_admin_access && (
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
              <div className="rounded-2xl border border-border bg-card p-5 flex items-center justify-between gap-4">
                <div>
                  <p className="font-semibold text-foreground">Administrator access</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    Give this group full admin privileges for the application.
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => adminAccessMutation.mutate(!adminAccess)}
                  disabled={adminAccessMutation.isPending}
                  className={clsx(
                    "inline-flex items-center gap-3 rounded-full border px-4 py-2 text-sm font-semibold transition-colors",
                    adminAccess
                      ? "bg-accent/15 border-accent text-accent"
                      : "bg-muted border-border text-muted-foreground hover:text-foreground"
                  )}
                  aria-pressed={adminAccess}
                >
                  <span className={clsx(
                    "relative inline-flex h-5 w-9 rounded-full transition-colors",
                    adminAccess ? "bg-accent" : "bg-border"
                  )}>
                    <span className={clsx(
                      "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform",
                      adminAccess ? "translate-x-4" : "translate-x-0.5"
                    )} />
                  </span>
                  {adminAccess ? "Enabled" : "Disabled"}
                </button>
              </div>

              <PermissionMatrix
                group={group}
                docTypes={docTypes}
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
                <div className="space-y-2">
                  {members?.map((m) => (
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
                        <button
                          onClick={() => removeMemberMutation.mutate(m.user.id)}
                          className="opacity-0 group-hover:opacity-100 text-destructive hover:bg-destructive/10 p-2 rounded-lg transition-all"
                        >
                          <X className="w-4 h-4" />
                        </button>
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
                <input
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  className="input mb-4"
                  placeholder="Search users by name or email…"
                />

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
                        <button
                          onClick={() => addMemberMutation.mutate(u.id)}
                          disabled={addMemberMutation.isPending}
                          className="btn-primary text-xs px-4 py-2"
                        >
                          <UserPlus className="w-3.5 h-3.5" /> Add
                        </button>
                      </div>
                    ))}
                </div>
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

  const { data: groups = [], isLoading } = useQuery<Group[]>({
    queryKey: ["groups"],
    queryFn: () => groupsAPI.list().then((r) => r.data.results ?? r.data),
  });
  const orderedGroups = [...groups].sort((a, b) => {
    if (a.has_admin_access && !b.has_admin_access) return -1;
    if (!a.has_admin_access && b.has_admin_access) return 1;
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
    onError: () => toast.error("Failed to create group"),
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
    onError: () => toast.error("Failed to delete group"),
  });

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-end justify-between mb-8">
        <div>
          <h1 className="text-3xl font-bold text-foreground tracking-tight">Permission groups</h1>
          <p className="text-muted-foreground mt-1.5">
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
          const isSystemGroup = group.has_admin_access;

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
                    {isSystemGroup && (
                      <span className="inline-flex items-center rounded-full bg-accent/15 px-2.5 py-1 text-[11px] font-semibold text-accent mt-2">
                        System administrator group
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
                <div className="flex items-center gap-2">
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
                      className="p-2 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors"
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
    </div>
  );
}
