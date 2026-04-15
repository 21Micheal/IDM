import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { groupsAPI, documentTypesAPI, usersAPI } from "@/services/api";
import {
  Plus, Users, Shield, ChevronRight, X, Loader2,
  Check, Trash2, UserPlus, Settings2, Info,
} from "lucide-react";
import { toast } from "react-toastify";
import clsx from "clsx";

// ── Types ─────────────────────────────────────────────────────────────────────
interface DocType   { id: string; name: string; code: string }
interface GroupPerm { id: string; document_type: string | null; document_type_name: string | null; action: string }
interface Member    { id: string; user: { id: string; full_name: string; email: string; role: string }; expires_at: string | null; is_active: boolean }
interface Group     { id: string; name: string; description: string; permissions: GroupPerm[]; member_count: number }
interface User      { id: string; full_name: string; email: string; role: string }

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

const ROLE_COLORS: Record<string, string> = {
  admin:   "bg-purple-100 text-purple-700",
  finance: "bg-blue-100 text-blue-700",
  auditor: "bg-amber-100 text-amber-700",
  viewer:  "bg-gray-100 text-gray-600",
};

// ── Permission matrix ─────────────────────────────────────────────────────────
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
  // Build initial state from current permissions
  const init: Record<string, Set<string>> = { "__all__": new Set() };
  docTypes.forEach((dt) => { init[dt.id] = new Set(); });
  group.permissions.forEach((p) => {
    const key = p.document_type ?? "__all__";
    if (!init[key]) init[key] = new Set();
    init[key].add(p.action);
  });

  const [matrix, setMatrix] = useState<Record<string, Set<string>>>(init);

  const toggle = (dtKey: string, action: string) => {
    setMatrix((prev) => {
      const next = { ...prev };
      const set  = new Set(prev[dtKey] ?? []);
      set.has(action) ? set.delete(action) : set.add(action);
      next[dtKey] = set;
      return next;
    });
  };

  const toggleAll = (dtKey: string) => {
    setMatrix((prev) => {
      const current = prev[dtKey] ?? new Set();
      const next    = { ...prev };
      next[dtKey]   = current.size === ALL_ACTIONS.length
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
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm text-gray-500 bg-gray-50 rounded-lg p-3">
        <Info className="w-4 h-4 flex-shrink-0" />
        <span>
          Tick the actions each document type's members can perform.
          "All document types" applies as a fallback when no specific row is set.
        </span>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="w-full text-xs">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-4 py-3 font-medium text-gray-600 w-48">Document type</th>
              {ALL_ACTIONS.map((a) => (
                <th key={a.value} className="px-2 py-3 font-medium text-gray-600 text-center w-20" title={a.description}>
                  {a.label}
                </th>
              ))}
              <th className="px-3 py-3 font-medium text-gray-500 text-center">All</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(({ key, label, sublabel }, idx) => (
              <tr key={key} className={clsx("hover:bg-gray-50", idx === 0 && "bg-brand-50/40")}>
                <td className="px-4 py-2.5">
                  <p className={clsx("font-medium", idx === 0 ? "text-brand-700" : "text-gray-800")}>
                    {label}
                  </p>
                  <p className="text-gray-400 text-[10px] mt-0.5">{sublabel}</p>
                </td>
                {ALL_ACTIONS.map((a) => {
                  const checked = matrix[key]?.has(a.value) ?? false;
                  return (
                    <td key={a.value} className="px-2 py-2.5 text-center">
                      <button
                        type="button"
                        onClick={() => toggle(key, a.value)}
                        className={clsx(
                          "w-5 h-5 rounded border-2 flex items-center justify-center mx-auto transition-colors",
                          checked
                            ? "bg-brand-600 border-brand-600"
                            : "border-gray-300 hover:border-brand-400"
                        )}
                      >
                        {checked && <Check className="w-3 h-3 text-white" strokeWidth={3} />}
                      </button>
                    </td>
                  );
                })}
                <td className="px-3 py-2.5 text-center">
                  <button
                    type="button"
                    onClick={() => toggleAll(key)}
                    className="text-[10px] text-brand-600 hover:underline"
                  >
                    {(matrix[key]?.size ?? 0) === ALL_ACTIONS.length ? "None" : "All"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="flex justify-end">
        <button onClick={handleSave} disabled={isSaving} className="btn-primary flex items-center gap-2">
          {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
          {isSaving ? "Saving permissions..." : "Save permissions"}
        </button>
      </div>
    </div>
  );
}

// ── Group detail panel ────────────────────────────────────────────────────────
function GroupDetail({
  group,
  docTypes,
  onClose,
}: {
  group: Group;
  docTypes: DocType[];
  onClose: () => void;
}) {
  const qc  = useQueryClient();
  const [tab, setTab] = useState<"permissions" | "members">("permissions");
  const [userSearch, setUserSearch] = useState("");

  const { data: members } = useQuery<Member[]>({
    queryKey: ["group-members", group.id],
    queryFn:  () => groupsAPI.members(group.id).then((r) => r.data),
  });

  const { data: allUsers } = useQuery<User[]>({
    queryKey: ["users-search", userSearch],
    queryFn:  () => usersAPI.list({ search: userSearch || undefined, page_size: 20 }).then((r) => r.data.results ?? r.data),
    enabled:  tab === "members",
  });

  const setPermsMutation = useMutation({
    mutationFn: (perms: { document_type_id: string | null; action: string }[]) =>
      groupsAPI.setPermissions(group.id, perms),
    onSuccess: () => {
      toast.success("Permissions updated successfully");
      qc.invalidateQueries({ queryKey: ["groups"] });
      qc.invalidateQueries({ queryKey: ["group-members", group.id] });
    },
    onError: () => toast.error("Failed to save permissions"),
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
  });

  const memberIds = new Set(members?.map((m) => m.user.id) ?? []);

  return (
    <div className="fixed inset-0 z-40 flex">
      {/* Backdrop */}
      <div className="flex-1 bg-black/40" onClick={onClose} />

      {/* Panel */}
      <div className="w-full max-w-3xl bg-white shadow-2xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
          <div>
            <h2 className="font-semibold text-gray-900 text-lg">{group.name}</h2>
            {group.description && (
              <p className="text-sm text-gray-500 mt-0.5">{group.description}</p>
            )}
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-200 px-6">
          <nav className="-mb-px flex gap-0">
            {[
              { id: "permissions", label: "Permissions", icon: Shield },
              { id: "members",     label: `Members (${group.member_count})`, icon: Users },
            ].map(({ id, label, icon: Icon }) => (
              <button
                key={id}
                onClick={() => setTab(id as typeof tab)}
                className={clsx(
                  "flex items-center gap-2 px-4 py-3 text-sm font-medium border-b-2 transition-colors",
                  tab === id
                    ? "border-brand-500 text-brand-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </nav>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-6">
          {tab === "permissions" && (
            <PermissionMatrix
              group={group}
              docTypes={docTypes}
              onSave={(perms) => setPermsMutation.mutate(perms)}
              isSaving={setPermsMutation.isPending}
            />
          )}

          {tab === "members" && (
            <div className="space-y-5">
              {/* Current members */}
              <div>
                <h3 className="font-medium text-gray-900 text-sm mb-3">
                  Current members ({members?.length ?? 0})
                </h3>
                <div className="space-y-2">
                  {members?.map((m) => (
                    <div key={m.id} className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50">
                      <div className="w-8 h-8 rounded-full bg-brand-100 flex items-center justify-center text-brand-700 text-xs font-semibold flex-shrink-0">
                        {m.user.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900">{m.user.full_name}</p>
                        <p className="text-xs text-gray-500">{m.user.email}</p>
                      </div>
                      <span className={clsx("badge text-xs", ROLE_COLORS[m.user.role])}>
                        {m.user.role}
                      </span>
                      {m.expires_at && (
                        <span className="text-xs text-gray-400">
                          Expires {new Date(m.expires_at).toLocaleDateString()}
                        </span>
                      )}
                      <button
                        onClick={() => removeMemberMutation.mutate(m.user.id)}
                        className="text-gray-400 hover:text-red-500 transition-colors ml-1"
                        title="Remove from group"
                      >
                        <X className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                  {!members?.length && (
                    <p className="text-sm text-gray-400 text-center py-4">
                      No members yet. Add users from the list below.
                    </p>
                  )}
                </div>
              </div>

              {/* Add members */}
              <div>
                <h3 className="font-medium text-gray-900 text-sm mb-3">Add members</h3>
                <input
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  className="input mb-3"
                  placeholder="Search users by name or email…"
                />
                <div className="space-y-2 max-h-64 overflow-y-auto">
                  {allUsers
                    ?.filter((u) => !memberIds.has(u.id))
                    .map((u) => (
                      <div
                        key={u.id}
                        className="flex items-center gap-3 p-3 rounded-lg border border-gray-100 hover:bg-gray-50"
                      >
                        <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center text-gray-600 text-xs font-semibold flex-shrink-0">
                          {u.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium text-gray-900">{u.full_name}</p>
                          <p className="text-xs text-gray-500">{u.email}</p>
                        </div>
                        <span className={clsx("badge text-xs", ROLE_COLORS[u.role])}>
                          {u.role}
                        </span>
                        <button
                          onClick={() => addMemberMutation.mutate(u.id)}
                          disabled={addMemberMutation.isPending}
                          className="btn-primary text-xs px-2 py-1 ml-1"
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

// ── Main page ─────────────────────────────────────────────────────────────────
export default function GroupsPage() {
  const qc = useQueryClient();
  const [selectedGroup, setSelected] = useState<Group | null>(null);
  const [showCreate, setShowCreate]  = useState(false);
  const [newName, setNewName]        = useState("");
  const [newDesc, setNewDesc]        = useState("");

  const { data: groups, isLoading } = useQuery<Group[]>({
    queryKey: ["groups"],
    queryFn:  () => groupsAPI.list().then((r) => r.data.results ?? r.data),
  });

  const { data: docTypes } = useQuery<DocType[]>({
    queryKey: ["document-types"],
    queryFn:  () => documentTypesAPI.list().then((r) => r.data.results ?? r.data),
  });

  const createMutation = useMutation({
    mutationFn: () => groupsAPI.create({ name: newName.trim(), description: newDesc.trim() }),
    onSuccess: () => {
      toast.success("Group created");
      qc.invalidateQueries({ queryKey: ["groups"] });
      setShowCreate(false);
      setNewName("");
      setNewDesc("");
    },
    onError: () => toast.error("Failed to create group"),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => groupsAPI.delete(id),
    onSuccess: () => {
      toast.success("Group deleted");
      qc.invalidateQueries({ queryKey: ["groups"] });
      setSelected(null);
    },
    onError: () => toast.error("Failed to delete group"),
  });

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Permission groups</h1>
          <p className="text-gray-500 text-sm mt-1">
            Groups define fine-grained per-document-type access. Users can belong to multiple groups.
          </p>
        </div>
        <button onClick={() => setShowCreate(true)} className="btn-primary">
          <Plus className="w-4 h-4" /> New group
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="card p-5 space-y-3">
          <h2 className="font-medium text-gray-900">New permission group</h2>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="label">Group name <span className="text-red-500">*</span></label>
              <input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                className="input"
                placeholder="e.g. Accounts Payable"
                autoFocus
              />
            </div>
            <div>
              <label className="label">Description</label>
              <input
                value={newDesc}
                onChange={(e) => setNewDesc(e.target.value)}
                className="input"
                placeholder="Optional — what this group is for"
              />
            </div>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => createMutation.mutate()}
              disabled={!newName.trim() || createMutation.isPending}
              className="btn-primary"
            >
              {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
              Create group
            </button>
            <button onClick={() => setShowCreate(false)} className="btn-secondary">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Groups grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {isLoading && Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="card p-5 space-y-3 animate-pulse">
            <div className="h-5 bg-gray-100 rounded w-2/3" />
            <div className="h-4 bg-gray-100 rounded w-full" />
            <div className="h-4 bg-gray-100 rounded w-1/2" />
          </div>
        ))}

        {groups?.map((group) => (
          <div
            key={group.id}
            className="card p-5 flex flex-col gap-3 hover:shadow-md transition-shadow cursor-pointer"
            onClick={() => setSelected(group)}
          >
            <div className="flex items-start justify-between gap-2">
              <div className="w-9 h-9 rounded-xl bg-brand-50 flex items-center justify-center flex-shrink-0">
                <Shield className="w-4 h-4 text-brand-600" />
              </div>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  if (confirm(`Delete group "${group.name}"? This cannot be undone.`)) {
                    deleteMutation.mutate(group.id);
                  }
                }}
                className="text-gray-300 hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>

            <div>
              <h3 className="font-semibold text-gray-900">{group.name}</h3>
              {group.description && (
                <p className="text-sm text-gray-500 mt-0.5 line-clamp-2">{group.description}</p>
              )}
            </div>

            <div className="flex items-center justify-between pt-1">
              <div className="flex gap-3 text-xs text-gray-500">
                <span className="flex items-center gap-1">
                  <Users className="w-3.5 h-3.5" /> {group.member_count} members
                </span>
                <span className="flex items-center gap-1">
                  <Settings2 className="w-3.5 h-3.5" /> {group.permissions.length} rules
                </span>
              </div>
              <ChevronRight className="w-4 h-4 text-gray-400" />
            </div>
          </div>
        ))}

        {!isLoading && !groups?.length && !showCreate && (
          <div className="col-span-3 card p-12 text-center">
            <Shield className="w-10 h-10 text-gray-200 mx-auto mb-3" />
            <p className="font-medium text-gray-700">No groups yet</p>
            <p className="text-sm text-gray-400 mt-1">
              Create a group, set its permissions per document type, then add members.
            </p>
            <button onClick={() => setShowCreate(true)} className="btn-primary mt-4">
              <Plus className="w-4 h-4" /> Create first group
            </button>
          </div>
        )}
      </div>

      {/* Detail slide-over */}
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
