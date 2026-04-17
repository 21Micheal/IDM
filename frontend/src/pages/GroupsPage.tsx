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
      <div className="flex items-center gap-3 text-sm text-gray-600 bg-gray-50 rounded-2xl p-4">
        <Info className="w-5 h-5 flex-shrink-0 text-brand-500" />
        <span>
          Select the actions members of this group can perform for each document type.
          "All document types" acts as a fallback.
        </span>
      </div>

      <div className="overflow-x-auto rounded-2xl border border-gray-200">
        <table className="w-full text-sm min-w-[900px]">
          <thead>
            <tr className="bg-gray-50 border-b border-gray-200">
              <th className="text-left px-6 py-4 font-medium text-gray-600 w-56">Document Type</th>
              {ALL_ACTIONS.map((a) => (
                <th key={a.value} className="px-4 py-4 font-medium text-gray-600 text-center w-24" title={a.description}>
                  {a.label}
                </th>
              ))}
              <th className="px-6 py-4 font-medium text-gray-500 text-center w-20">All</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {rows.map(({ key, label, sublabel }, idx) => (
              <tr key={key} className={clsx("hover:bg-gray-50", idx === 0 && "bg-brand-50/30")}>
                <td className="px-6 py-4">
                  <p className={clsx("font-medium", idx === 0 ? "text-brand-700" : "text-gray-900")}>
                    {label}
                  </p>
                  <p className="text-xs text-gray-400 mt-0.5">{sublabel}</p>
                </td>
                {ALL_ACTIONS.map((a) => {
                  const checked = matrix[key]?.has(a.value) ?? false;
                  return (
                    <td key={a.value} className="px-4 py-4 text-center">
                      <button
                        type="button"
                        onClick={() => toggle(key, a.value)}
                        className={clsx(
                          "w-6 h-6 rounded-lg border-2 flex items-center justify-center mx-auto transition-all",
                          checked
                            ? "bg-brand-600 border-brand-600"
                            : "border-gray-300 hover:border-brand-400"
                        )}
                      >
                        {checked && <Check className="w-4 h-4 text-white" strokeWidth={3} />}
                      </button>
                    </td>
                  );
                })}
                <td className="px-6 py-4 text-center">
                  <button
                    type="button"
                    onClick={() => toggleAll(key)}
                    className="text-xs font-medium text-brand-600 hover:text-brand-700 hover:underline"
                  >
                    {(matrix[key]?.size ?? 0) === ALL_ACTIONS.length ? "Clear" : "Select All"}
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
          className="btn-primary flex items-center gap-2 px-8"
        >
          {isSaving && <Loader2 className="w-4 h-4 animate-spin" />}
          {isSaving ? "Saving..." : "Save Permissions"}
        </button>
      </div>
    </div>
  );
}

// ── Minimal Group Detail Panel ────────────────────────────────────────────────
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
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      {/* Minimal centered panel */}
      <div className="w-full max-w-4xl bg-white shadow-2xl rounded-3xl overflow-hidden max-h-[92vh] flex flex-col">
        
        {/* Header */}
        <div className="flex items-center justify-between px-8 py-5 border-b border-gray-100">
          <div className="flex items-center gap-4">
            <div className="w-11 h-11 rounded-2xl bg-brand-100 flex items-center justify-center">
              <Shield className="w-6 h-6 text-brand-600" />
            </div>
            <div>
              <h2 className="font-semibold text-2xl text-gray-900">{group.name}</h2>
              {group.description && <p className="text-sm text-gray-500">{group.description}</p>}
            </div>
          </div>
          <button 
            onClick={onClose} 
            className="p-2 text-gray-400 hover:text-gray-600 hover:bg-gray-100 rounded-xl transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Tabs */}
        <div className="border-b border-gray-100 px-8">
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
                    ? "border-brand-600 text-brand-600"
                    : "border-transparent text-gray-500 hover:text-gray-700"
                )}
              >
                <Icon className="w-4 h-4" />
                {label}
              </button>
            ))}
          </nav>
        </div>

        {/* Content Area */}
        <div className="flex-1 overflow-y-auto p-8">
          {tab === "permissions" && (
            <PermissionMatrix
              group={group}
              docTypes={docTypes}
              onSave={(perms) => setPermsMutation.mutate(perms)}
              isSaving={setPermsMutation.isPending}
            />
          )}

          {tab === "members" && (
            <div className="space-y-10">
              {/* Current Members */}
              <div>
                <h3 className="font-semibold text-lg text-gray-900 mb-5">Current Members</h3>
                <div className="space-y-3">
                  {members?.map((m) => (
                    <div key={m.id} className="flex items-center gap-4 p-5 bg-white border border-gray-100 rounded-2xl hover:border-gray-200 group">
                      <div className="w-10 h-10 rounded-2xl bg-brand-100 flex items-center justify-center text-brand-700 text-sm font-semibold">
                        {m.user.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-900">{m.user.full_name}</p>
                        <p className="text-sm text-gray-500">{m.user.email}</p>
                      </div>
                      <div className="flex items-center gap-4">
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
                          className="opacity-0 group-hover:opacity-100 text-red-500 hover:text-red-600 p-2 rounded-xl hover:bg-red-50 transition-all"
                        >
                          <X className="w-5 h-5" />
                        </button>
                      </div>
                    </div>
                  ))}
                  {!members?.length && (
                    <div className="text-center py-12 text-gray-400 border border-dashed border-gray-200 rounded-2xl">
                      No members yet. Add some from below.
                    </div>
                  )}
                </div>
              </div>

              {/* Add Members */}
              <div>
                <h3 className="font-semibold text-lg text-gray-900 mb-5">Add Members</h3>
                <input
                  value={userSearch}
                  onChange={(e) => setUserSearch(e.target.value)}
                  className="input mb-5"
                  placeholder="Search users by name or email..."
                />

                <div className="max-h-96 overflow-y-auto border border-gray-100 rounded-2xl divide-y divide-gray-100">
                  {allUsers
                    ?.filter((u) => !memberIds.has(u.id))
                    .map((u) => (
                      <div
                        key={u.id}
                        className="flex items-center gap-4 p-5 hover:bg-gray-50 transition-colors"
                      >
                        <div className="w-10 h-10 rounded-2xl bg-gray-100 flex items-center justify-center text-gray-600 text-sm font-semibold">
                          {u.full_name.split(" ").map((n) => n[0]).join("").slice(0, 2)}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="font-medium text-gray-900">{u.full_name}</p>
                          <p className="text-sm text-gray-500">{u.email}</p>
                        </div>
                        <span className={clsx("badge text-xs", ROLE_COLORS[u.role])}>
                          {u.role}
                        </span>
                        <button
                          onClick={() => addMemberMutation.mutate(u.id)}
                          disabled={addMemberMutation.isPending}
                          className="btn-primary text-sm px-6 py-2 flex items-center gap-2"
                        >
                          <UserPlus className="w-4 h-4" /> Add
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

  const { data: docTypes = [] } = useQuery<DocType[]>({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data.results ?? r.data),
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
    <div className="max-w-6xl mx-auto py-10">
      <div className="flex items-end justify-between mb-10">
        <div>
          <h1 className="text-4xl font-bold text-gray-900">Permission Groups</h1>
          <p className="text-gray-500 mt-2 text-lg">
            Define fine-grained access control per document type
          </p>
        </div>
        <button 
          onClick={() => setShowCreate(true)} 
          className="btn-primary flex items-center gap-2"
        >
          <Plus className="w-5 h-5" /> New Group
        </button>
      </div>

      {/* Create Form */}
      {showCreate && (
        <div className="card p-8 max-w-lg mx-auto mb-12">
          <h2 className="text-xl font-semibold mb-6">Create New Group</h2>
          <div className="space-y-5">
            <div>
              <label className="label">Group Name <span className="text-red-500">*</span></label>
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
                placeholder="Optional description..."
              />
            </div>
            <div className="flex gap-3 pt-2">
              <button
                onClick={() => createMutation.mutate()}
                disabled={!newName.trim() || createMutation.isPending}
                className="btn-primary flex-1"
              >
                {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
                Create Group
              </button>
              <button onClick={() => setShowCreate(false)} className="btn-secondary px-8">
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Groups Grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {isLoading && Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="card p-8 animate-pulse">
            <div className="h-6 bg-gray-100 rounded w-3/4 mb-4" />
            <div className="h-4 bg-gray-100 rounded w-1/2" />
          </div>
        ))}

        {groups?.map((group) => (
          <div
            key={group.id}
            onClick={() => setSelected(group)}
            className="card p-8 hover:shadow-xl transition-all duration-300 cursor-pointer group border border-transparent hover:border-brand-100"
          >
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-4">
                <div className="w-14 h-14 rounded-2xl bg-brand-100 flex items-center justify-center flex-shrink-0">
                  <Shield className="w-7 h-7 text-brand-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-2xl text-gray-900 group-hover:text-brand-700 transition-colors">
                    {group.name}
                  </h3>
                  {group.description && (
                    <p className="text-sm text-gray-500 line-clamp-2 mt-1">{group.description}</p>
                  )}
                </div>
              </div>
            </div>

            <div className="mt-8 flex items-center justify-between text-sm">
              <div className="flex gap-6 text-gray-500">
                <span className="flex items-center gap-1.5">
                  <Users className="w-4 h-4" /> {group.member_count} members
                </span>
                <span className="flex items-center gap-1.5">
                  <Settings2 className="w-4 h-4" /> {group.permissions.length} rules
                </span>
              </div>
              <ChevronRight className="w-5 h-5 text-gray-400 group-hover:text-brand-500 transition-colors" />
            </div>
          </div>
        ))}

        {!isLoading && !groups?.length && !showCreate && (
          <div className="col-span-full py-24 text-center">
            <Shield className="w-16 h-16 text-gray-200 mx-auto mb-6" />
            <p className="text-2xl font-medium text-gray-600">No groups yet</p>
            <p className="text-gray-500 mt-3 max-w-md mx-auto">
              Create permission groups to control who can view, edit, approve, or delete documents.
            </p>
            <button 
              onClick={() => setShowCreate(true)} 
              className="btn-primary mt-8"
            >
              <Plus className="w-5 h-5 mr-2" /> Create First Group
            </button>
          </div>
        )}
      </div>

      {/* Minimal Group Detail Panel */}
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