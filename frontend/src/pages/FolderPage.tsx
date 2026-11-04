/**
 * pages/FolderPage.tsx
 *
 * Full-page view for a single folder:
 *   - Breadcrumb trail (up to root)
 *   - Document cards with status badges
 *   - Drag-reorder of documents inside folder
 *   - Subfolder grid
 *   - Empty state with call-to-action
 *   - "Add documents" search modal
 */

import { useState, useRef, KeyboardEvent } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  useQuery, useMutation, useQueryClient,
} from "@tanstack/react-query";
import {
  Folder, FolderOpen, Star, FileText, Share2, Users,
  Plus, Trash2, Search, X, Loader2, ExternalLink,
  ChevronRight, MoreHorizontal,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { foldersAPI } from "@/services/foldersApi";
import { documentsAPI } from "@/services/api";
import { usersAPI } from "@/services/api";
import StatusBadge from "@/components/documents/StatusBadge";
import { formatDocumentFileType } from "@/lib/documentFormat";
import { invalidateFolderCaches } from "@/lib/folderCache";
import type { DocumentFolder, DocumentFolderItem } from "@/types/";
import type { Document } from "@/types";

const SHARE_RIGHTS = [
  ["comment", "Can comment"],
  ["edit", "Can edit documents"],
  ["download", "Can download"],
] as const;

function FolderShareModal({ folder, onClose, onShare, isSaving }: {
  folder: DocumentFolder;
  onClose: () => void;
  onShare: (data: { recipient_user_ids: string[]; permissions: string[]; expires_at: string | null }) => void;
  isSaving: boolean;
}) {
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<string[]>([]);
  const [permissions, setPermissions] = useState<string[]>(["view"]);
  const [expiresAt, setExpiresAt] = useState("");
  const { data: rawUsers = [] } = useQuery({
    queryKey: ["users", "folder-share-recipients"],
    queryFn: () => usersAPI.list({ page_size: 500 }).then((r) => r.data),
    staleTime: 60_000,
  });
  const users = Array.isArray(rawUsers) ? rawUsers : (rawUsers as any)?.results ?? [];
  const visibleUsers = users.filter((user: any) =>
    `${user.full_name ?? `${user.first_name ?? ""} ${user.last_name ?? ""}`} ${user.email}`.toLowerCase().includes(search.toLowerCase()),
  );
  const toggle = (permission: string) => setPermissions((current) => current.includes(permission)
    ? current.filter((value) => value !== permission)
    : [...current, permission]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-xl border border-[#C8CDD2] bg-white shadow-xl">
        <div className="flex items-start justify-between border-b border-[#C8CDD2] bg-[#287EAD] px-5 py-4 text-white">
          <div><h2 className="font-semibold">Share “{folder.name}”</h2><p className="mt-1 text-xs text-white/80">Recipients can browse this folder and its existing subfolders.</p></div>
          <button type="button" onClick={onClose} aria-label="Close"><X className="h-4 w-4" /></button>
        </div>
        <div className="space-y-4 p-5">
          <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Find people by name or email" className="h-9 w-full border border-[#C8CDD2] px-3 text-sm outline-none focus:border-[#287EAD]" />
          <div className="max-h-44 divide-y divide-[#E1E7EA] overflow-y-auto border border-[#E1E7EA]">
            {visibleUsers.map((person: any) => {
              const name = person.full_name || `${person.first_name ?? ""} ${person.last_name ?? ""}`.trim() || person.email;
              return <label key={person.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 hover:bg-[#F5F7F8]">
                <input type="checkbox" checked={selected.includes(person.id)} onChange={() => setSelected((current) => current.includes(person.id) ? current.filter((id) => id !== person.id) : [...current, person.id])} />
                <span className="min-w-0"><span className="block truncate text-sm font-medium">{name}</span><span className="block truncate text-xs text-[#6E767D]">{person.email}</span></span>
              </label>;
            })}
            {visibleUsers.length === 0 && <p className="px-3 py-5 text-center text-sm text-[#6E767D]">No matching users.</p>}
          </div>
          <div>
            <p className="mb-2 text-sm font-semibold">Permissions</p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="flex items-center gap-2 border border-[#C8CDD2] p-2 text-sm"><input type="checkbox" checked disabled />Can view (required)</label>
              {SHARE_RIGHTS.map(([right, label]) => <label key={right} className="flex items-center gap-2 border border-[#C8CDD2] p-2 text-sm"><input type="checkbox" checked={permissions.includes(right)} onChange={() => toggle(right)} />{label}</label>)}
            </div>
            <p className="mt-2 text-xs text-[#6E767D]">Edit applies to documents in the folder; recipients cannot change your folder structure.</p>
          </div>
          <label className="block text-sm font-semibold">Access expires (optional)<input type="datetime-local" value={expiresAt} onChange={(event) => setExpiresAt(event.target.value)} className="mt-1 h-9 w-full border border-[#C8CDD2] px-3 text-sm font-normal" /></label>
        </div>
        <div className="flex justify-end gap-2 border-t border-[#C8CDD2] bg-[#F5F7F8] px-5 py-3">
          <button type="button" onClick={onClose} className="border border-[#C8CDD2] bg-white px-3 py-2 text-sm">Cancel</button>
          <button type="button" disabled={!selected.length || isSaving} onClick={() => onShare({ recipient_user_ids: selected, permissions: ["view", ...permissions.filter((value) => value !== "view")], expires_at: expiresAt ? new Date(expiresAt).toISOString() : null })} className="bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50">{isSaving ? "Sharing…" : "Share folder"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── Breadcrumb ───────────────────────────────────────────────────────────────

function Breadcrumb({ folder }: { folder: DocumentFolder }) {
  // Build path by traversing parent_name — limited to 4 ancestors
  // For full lineage, the backend should send a `path` array; here we
  // reconstruct from the flat list cached in react-query.
  const qc = useQueryClient();
  const rawFlatData = qc.getQueryData(["folders"]);
  const flat: DocumentFolder[] = Array.isArray(rawFlatData)
    ? rawFlatData
    : (rawFlatData as any)?.results ?? [];
  const rawSharedData = qc.getQueryData(["folders", "shared"]);
  const sharedRoots: DocumentFolder[] = Array.isArray(rawSharedData) ? rawSharedData as DocumentFolder[] : [];
  const flatten = (node: DocumentFolder): DocumentFolder[] => [node, ...(node.children ?? []).flatMap(flatten)];
  const allFolders = [...flat, ...sharedRoots.flatMap(flatten)];

  const path: Array<{ id: string; name: string }> = [];
  let current: DocumentFolder | undefined = folder;
  while (current) {
    path.unshift({ id: current.id, name: current.name });
    current = allFolders.find((f) => f.id === current!.parent);
  }

  return (
    <nav className="flex items-center gap-1 text-sm text-muted-foreground flex-wrap">
      <Link to="/documents" className="hover:text-foreground transition-colors">
        Documents
      </Link>
      {path.map((seg, i) => (
        <span key={seg.id} className="flex items-center gap-1">
          <ChevronRight className="w-3.5 h-3.5 opacity-40" />
          {i < path.length - 1 ? (
            <Link
              to={`/documents/folders/${seg.id}`}
              className="hover:text-foreground transition-colors"
            >
              {seg.name}
            </Link>
          ) : (
            <span className="font-semibold text-foreground">{seg.name}</span>
          )}
        </span>
      ))}
    </nav>
  );
}

// ─── AddDocumentModal ─────────────────────────────────────────────────────────

function AddDocumentModal({
  folderId,
  existingDocIds,
  onClose,
}: {
  folderId: string;
  existingDocIds: Set<string>;
  onClose: () => void;
}) {
  const [q, setQ]               = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const qc                      = useQueryClient();

  const { data, isFetching } = useQuery({
    queryKey: ["doc-search-for-folder", q],
    queryFn: () =>
      documentsAPI.list({ search: q, page_size: 20 }).then((r) =>
        (r.data.results ?? r.data) as Document[]
      ),
    enabled: true,
    staleTime: 10_000,
  });

  const addMutation = useMutation({
    mutationFn: (docId: string) => foldersAPI.addDocument(folderId, docId),
    onSuccess: () => {
      invalidateFolderCaches(qc, folderId);
    },
  });

  const handleAdd = async () => {
    for (const id of selected) {
      await addMutation.mutateAsync(id);
    }
    onClose();
  };

  const docs = (data ?? []).filter((d) => !existingDocIds.has(d.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />
      <div
        className="relative w-full max-w-lg border border-[#C8CDD2] bg-white shadow-xl overflow-hidden"
        style={{ maxHeight: "80vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-[#C8CDD2] bg-[#287EAD]">
          <h2 className="text-base font-semibold text-white">Add documents to folder</h2>
          <button onClick={onClose} className="p-1 text-white/70 hover:text-white hover:bg-white/10 transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-[#C8CDD2]">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              autoFocus
              className="w-full pl-9 border border-[#C8CDD2] px-3 py-2 text-sm outline-none focus:border-[#287EAD]"
              placeholder="Search documents…"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
          </div>
        </div>

        {/* List */}
        <div className="overflow-y-auto" style={{ maxHeight: "40vh" }}>
          {isFetching ? (
            <div className="flex justify-center p-8">
              <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
            </div>
          ) : docs.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-muted-foreground">
              {q ? "No documents match your search." : "All documents are already in this folder."}
            </p>
          ) : (
            <div className="divide-y divide-[#C8CDD2]">
              {docs.map((doc) => {
                const checked = selected.has(doc.id);
                return (
                  <label
                    key={doc.id}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-[#F5F7F8] cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      className="rounded border-[#C8CDD2] text-[#287EAD] focus:ring-0"
                      checked={checked}
                      onChange={() => {
                        setSelected((prev) => {
                          const next = new Set(prev);
                          if (checked) next.delete(doc.id);
                          else next.add(doc.id);
                          return next;
                        });
                      }}
                    />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium text-foreground truncate">{doc.title}</p>
                      <p className="text-xs text-muted-foreground truncate">
                        {doc.reference_number} · {doc.document_type_name}
                      </p>
                    </div>
                    <StatusBadge status={doc.status} />
                  </label>
                );
              })}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-[#C8CDD2] bg-[#F5F7F8]">
          <p className="text-xs text-muted-foreground">
            {selected.size} selected
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="text-sm px-3 py-1.5 border border-[#C8CDD2] bg-white hover:bg-[#F5F7F8]"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={selected.size === 0 || addMutation.isPending}
              onClick={handleAdd}
              className="text-sm px-4 py-1.5 bg-[#287EAD] text-white disabled:opacity-50"
            >
              {addMutation.isPending ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                `Add ${selected.size > 0 ? selected.size : ""}`
              )}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── SubfolderCard ────────────────────────────────────────────────────────────

function SubfolderCard({ folder }: { folder: DocumentFolder }) {
  return (
    <Link
      to={`/documents/folders/${folder.id}`}
      className="group flex items-center gap-3 border border-[#C8CDD2] bg-white p-4 hover:border-[#287EAD]/40 hover:bg-[#F5F7F8] transition-colors"
    >
      <div
        className="flex h-10 w-10 items-center justify-center border border-[#C8CDD2]"
        style={{ backgroundColor: `${folder.color}20` }}
      >
        <Folder className="w-5 h-5" style={{ color: folder.color }} />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground truncate">{folder.name}</p>
        <p className="text-xs text-muted-foreground">
          {folder.document_count} doc{folder.document_count !== 1 ? "s" : ""}
        </p>
      </div>
      <ChevronRight className="w-4 h-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" />
    </Link>
  );
}

// ─── DocumentCard ─────────────────────────────────────────────────────────────

function DocumentCard({
  item,
  onRemove,
  canRemove,
}: {
  item: DocumentFolderItem;
  onRemove: () => void;
  canRemove: boolean;
}) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className="group flex items-start gap-3 border border-[#C8CDD2] bg-white p-4 hover:border-[#287EAD]/40 hover:bg-[#F5F7F8] transition-colors cursor-pointer"
      onClick={() => navigate(`/documents/${item.document}`)}
    >
      <div className="flex h-10 w-10 items-center justify-center border border-[#C8CDD2] bg-[#EEF6FB] text-[#287EAD] shrink-0">
        <FileText className="w-5 h-5" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-semibold text-foreground truncate">{item.document_title}</p>
        <p className="text-xs text-muted-foreground truncate">
          {item.document_reference} · {item.document_type_name}
        </p>
        <div className="mt-2 flex items-center gap-2">
          <StatusBadge status={item.document_status} />
          <span className="text-[11px] text-muted-foreground">
            {formatDocumentFileType(item.document_file_name, item.document_file_mime_type)}
          </span>
          <span className="text-[11px] text-muted-foreground">
            · {formatDistanceToNow(new Date(item.document_updated_at), { addSuffix: true })}
          </span>
        </div>
      </div>

      {/* Actions */}
      <div className="relative shrink-0" onClick={(e) => e.stopPropagation()}>
        <button
          className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-white border border-[#C8CDD2] transition-all"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-8 z-20 w-40 border border-[#C8CDD2] bg-white shadow-xl py-1 text-sm">
              <button
                className="flex items-center gap-2 w-full px-3 py-2 hover:bg-[#F5F7F8] text-foreground"
                onClick={() => navigate(`/documents/${item.document}`)}
              >
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                Open
              </button>
              {canRemove && <button
                className="flex items-center gap-2 w-full px-3 py-2 hover:bg-red-50 text-red-600"
                onClick={() => { onRemove(); setMenuOpen(false); }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove
              </button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── SubfolderInlineInput ─────────────────────────────────────────────────────

function SubfolderInlineInput({
  onConfirm,
  onCancel,
}: {
  onConfirm: (name: string) => void;
  onCancel: () => void;
}) {
  const [val, setVal] = useState("");
  const ref = useRef<HTMLInputElement>(null);

  const commit = () => {
    const trimmed = val.trim();
    if (trimmed) onConfirm(trimmed);
    else onCancel();
  };

  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") commit();
    if (e.key === "Escape") onCancel();
  };

  return (
    <div className="flex items-center gap-3 border border-[#287EAD] bg-white p-4">
      <div className="flex h-10 w-10 items-center justify-center border border-[#C8CDD2] bg-[#EEF6FB] text-[#287EAD] shrink-0">
        <Folder className="w-5 h-5" />
      </div>
      <input
        ref={ref}
        autoFocus
        className="flex-1 min-w-0 border-b border-[#287EAD] bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground py-0.5"
        placeholder="Folder name…"
        value={val}
        onChange={(e) => setVal(e.target.value)}
        onKeyDown={onKey}
        onBlur={commit}
      />
    </div>
  );
}

// ─── FolderPage (exported) ────────────────────────────────────────────────────

export default function FolderPage() {
  const { folderId } = useParams<{ folderId: string }>();
  const navigate     = useNavigate();
  const qc           = useQueryClient();
  const [showAdd, setShowAdd]               = useState(false);
  const [showShare, setShowShare] = useState(false);
  const [addingSubfolder, setAddingSubfolder] = useState(false);
  const [requestedRights, setRequestedRights] = useState<string[]>(["edit"]);

  const createSubfolder = useMutation({
    mutationFn: (name: string) =>
      foldersAPI.create({ name, parent: folderId! }),
    onSuccess: () => {
      invalidateFolderCaches(qc, folderId);
    },
  });

  // Folder meta
  const { data: folder, isLoading: folderLoading, isError: folderError } = useQuery({
    queryKey: ["folder", folderId],
    queryFn: () => foldersAPI.get(folderId!).then((r) => r.data),
    enabled: !!folderId,
    refetchInterval: 30_000,
  });

  const { data: sharedRoots = [] } = useQuery({
    queryKey: ["folders", "shared"],
    queryFn: () => foldersAPI.shared().then((r) => r.data),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  const { data: sharing } = useQuery({
    queryKey: ["folder-sharing", folderId],
    queryFn: () => foldersAPI.sharing(folderId!).then((r) => r.data),
    enabled: Boolean(folderId && folder),
    refetchInterval: 10_000,
  });

  // Flat folder list for breadcrumb traversal
  useQuery({
    queryKey: ["folders"],
    queryFn: () => foldersAPI.list().then((r) => Array.isArray(r.data) ? r.data : []),
    staleTime: 60_000,
  });

  // Documents in folder
  const { data: items = [], isLoading: itemsLoading } = useQuery({
    queryKey: ["folder-documents", folderId],
    queryFn: () => foldersAPI.documents(folderId!).then((r) => r.data),
    enabled: !!folderId,
    refetchInterval: 30_000,
  });

  // Subfolders — subscribe to the tree query so create/rename updates re-render
  const { data: tree = [] } = useQuery({
    queryKey: ["folders", "tree"],
    queryFn: () => foldersAPI.tree().then((r) => r.data),
    staleTime: 30_000,
  });
  const flatten = (node: DocumentFolder): DocumentFolder[] => [node, ...(node.children ?? []).flatMap(flatten)];
  const sharedTree = sharedRoots.flatMap(flatten);
  const findFolder = (nodes: DocumentFolder[], id: string): DocumentFolder | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children) {
        const found = findFolder(n.children, id);
        if (found) return found;
      }
    }
  };
  const folderNode = findFolder([...tree, ...sharedRoots], folderId ?? "") ?? sharedTree.find((node) => node.id === folderId);
  const subfolders = folderNode?.children ?? [];

  const removeDoc = useMutation({
    mutationFn: (docId: string) => foldersAPI.removeDocument(folderId!, docId),
    onSuccess: () => {
      invalidateFolderCaches(qc, folderId);
    },
  });

  const shareFolder = useMutation({
    mutationFn: (data: { recipient_user_ids: string[]; permissions: string[]; expires_at: string | null }) => foldersAPI.share(folderId!, data),
    onSuccess: () => {
      setShowShare(false);
      void qc.invalidateQueries({ queryKey: ["folder-sharing", folderId] });
      void qc.invalidateQueries({ queryKey: ["folders", "shared"] });
    },
  });
  const manageShare = useMutation({
    mutationFn: (data: { recipient_id: string; revoke?: boolean; permissions?: string[] }) => foldersAPI.manageShare(folderId!, data),
    onSuccess: () => { void qc.invalidateQueries({ queryKey: ["folder-sharing", folderId] }); void qc.invalidateQueries({ queryKey: ["folders", "shared"] }); },
  });
  const requestAccess = useMutation({
    mutationFn: (permissions: string[]) => foldersAPI.requestAccess(folderId!, permissions),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["folder-sharing", folderId] }),
  });
  const manageRequest = useMutation({
    mutationFn: ({ requestId, grant }: { requestId: string; grant: boolean }) => foldersAPI.manageAccessRequest(folderId!, requestId, grant),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ["folder-sharing", folderId] }),
  });

  const existingDocIds = new Set(items.map((i) => i.document));

  if (folderLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!folder) {
    return (
      <div className="text-center py-16">
        <p className="text-muted-foreground">Folder not found.</p>
        <button onClick={() => navigate("/documents")} className="mt-3 btn-ghost text-sm">
          Back to documents
        </button>
      </div>
    );
  }

  if (folderError && folder.is_shared) {
    return (
      <div className="mx-auto max-w-xl border border-[#C8CDD2] bg-white px-6 py-12 text-center">
        <Share2 className="mx-auto h-8 w-8 text-[#7C8790]" />
        <p className="mt-3 font-semibold text-[#1F2933]">This shared folder is no longer available</p>
        <p className="mt-1 text-sm text-[#6E767D]">Its access may have expired or been revoked.</p>
        <button onClick={() => navigate("/documents")} className="mt-4 text-sm font-semibold text-[#287EAD]">Back to documents</button>
      </div>
    );
  }

  const FolderIcon = folder.is_favourites ? Star : FolderOpen;

  return (
    <div className="mx-auto w-full max-w-[1680px] space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Breadcrumb folder={folder} />
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center border border-[#C8CDD2]"
              style={{ backgroundColor: `${folder.color}20` }}
            >
              <FolderIcon
                className={clsx("w-6 h-6", folder.is_favourites && "text-amber-400")}
                style={{ color: folder.is_favourites ? undefined : folder.color }}
              />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {folder.name}
              </h1>
              <p className="text-sm text-muted-foreground">
                {items.length} document{items.length !== 1 ? "s" : ""}
                {subfolders.length > 0 && ` · ${subfolders.length} subfolder${subfolders.length !== 1 ? "s" : ""}`}
              </p>
            </div>
          </div>
        </div>

        {!folder.is_favourites && !folder.is_shared && (
          <div className="flex gap-2">
            <button type="button" onClick={() => setShowShare(true)} className="inline-flex items-center gap-2 border border-[#287EAD] bg-white px-4 py-2.5 text-sm font-semibold text-[#287EAD] hover:bg-[#EEF6FB]">
              <Share2 className="h-4 w-4" /> Share folder
            </button>
            <button type="button" onClick={() => setShowAdd(true)} className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#206D99] transition-colors">
              <Plus className="w-4 h-4" /> Add documents
            </button>
          </div>
        )}
      </div>

      {folder.is_shared && sharing?.my_share && (
        <div className="flex flex-wrap items-center justify-between gap-3 border border-[#BBD5E3] bg-[#EEF6FB] px-4 py-3">
          <div>
            <p className="text-sm font-semibold text-[#1F2933]">Shared by {sharing.my_share.shared_by_name ?? folder.shared_by_name ?? "a colleague"}</p>
            <p className="mt-1 text-xs text-[#5E6870]">Your access: {(sharing.my_share.permissions ?? folder.share_permissions ?? ["view"]).map((right: string) => right === "view" ? "View" : right === "edit" ? "Edit documents" : right === "comment" ? "Comment" : "Download").join(" · ")}</p>
          </div>
          {SHARE_RIGHTS.some(([right]) => !(sharing.my_share.permissions ?? []).includes(right)) && (
            <div className="flex flex-wrap items-center gap-2">
              {SHARE_RIGHTS.filter(([right]) => !(sharing.my_share.permissions ?? []).includes(right)).map(([right, label]) => <label key={right} className="flex items-center gap-1 text-xs text-[#5E6870]"><input type="checkbox" checked={requestedRights.includes(right)} disabled={sharing.my_request?.status === "pending"} onChange={() => setRequestedRights((current) => current.includes(right) ? current.filter((value) => value !== right) : [...current, right])} />{label}</label>)}
              <button type="button" disabled={requestAccess.isPending || sharing.my_request?.status === "pending" || requestedRights.length === 0} onClick={() => requestAccess.mutate(requestedRights)} className="border border-[#287EAD] bg-white px-3 py-2 text-xs font-semibold text-[#287EAD] disabled:opacity-50">
                {sharing.my_request?.status === "pending" ? "Access requested" : "Request selected access"}
              </button>
            </div>
          )}
        </div>
      )}

      {sharing?.can_manage && (sharing.recipients?.length > 0 || sharing.requests?.length > 0) && (
        <section className="border border-[#C8CDD2] bg-white p-4">
          <div className="mb-3 flex items-center gap-2"><Users className="h-4 w-4 text-[#287EAD]" /><h2 className="text-sm font-semibold">Folder access</h2></div>
          <div className="space-y-2">
            {(sharing.recipients ?? []).map((recipient: any) => <div key={recipient.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E1E7EA] pt-2 text-sm">
              <span>{recipient.name}<span className="ml-2 text-xs text-[#6E767D]">{recipient.email}</span><span className="ml-2 text-xs text-[#6E767D]">{recipient.permissions.map((right: string) => right === "edit" ? "Edit" : right === "comment" ? "Comment" : right === "download" ? "Download" : "View").join(" · ")}{recipient.expires_at ? ` · expires ${new Date(recipient.expires_at).toLocaleDateString()}` : ""}</span>{recipient.editing_documents?.length > 0 && <span className="ml-2 text-xs font-semibold text-emerald-700">Editing: {recipient.editing_documents.join(", ")}</span>}</span>
              {recipient.is_active && <span className="flex items-center gap-2">
                {SHARE_RIGHTS.map(([right]) => <label key={right} title={`Can ${right}`} className="flex items-center gap-1 text-[10px] text-[#5E6870]"><input type="checkbox" checked={recipient.permissions.includes(right)} disabled={manageShare.isPending} onChange={(event) => manageShare.mutate({ recipient_id: recipient.id, permissions: event.target.checked ? [...recipient.permissions, right] : recipient.permissions.filter((value: string) => value !== right) })} />{right === "comment" ? "Comment" : right === "edit" ? "Edit" : "Download"}</label>)}
                <button type="button" disabled={manageShare.isPending} onClick={() => manageShare.mutate({ recipient_id: recipient.id, revoke: true })} className="text-xs font-semibold text-red-700">Revoke</button>
              </span>}
              {!recipient.is_active && <span className="text-xs text-[#6E767D]">{recipient.revoked_at ? "Revoked" : "Expired"}</span>}
            </div>)}
            {(sharing.requests ?? []).map((accessRequest: any) => <div key={accessRequest.id} className="flex flex-wrap items-center justify-between gap-2 border-t border-[#E1E7EA] pt-2 text-sm">
              <span>{accessRequest.requester_name} requested {accessRequest.permissions.filter((right: string) => right !== "view").join(" and ")} access</span>
              <span className="flex gap-3"><button type="button" disabled={manageRequest.isPending} onClick={() => manageRequest.mutate({ requestId: accessRequest.id, grant: true })} className="text-xs font-semibold text-emerald-700">Grant</button><button type="button" disabled={manageRequest.isPending} onClick={() => manageRequest.mutate({ requestId: accessRequest.id, grant: false })} className="text-xs font-semibold text-[#6E767D]">Decline</button></span>
            </div>)}
          </div>
        </section>
      )}

      {/* Subfolders */}
      {(subfolders.length > 0 || !folder.is_favourites) && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Subfolders
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {!folder.is_favourites && !folder.is_shared && (
              addingSubfolder ? (
                <SubfolderInlineInput
                  onConfirm={(name) => {
                    createSubfolder.mutate(name);
                    setAddingSubfolder(false);
                  }}
                  onCancel={() => setAddingSubfolder(false)}
                />
              ) : (
                <button
                  type="button"
                  onClick={() => setAddingSubfolder(true)}
                  className="group flex items-center gap-3 border border-dashed border-[#C8CDD2] bg-white p-4 hover:border-[#287EAD]/40 hover:bg-[#F5F7F8] transition-colors text-left"
                >
                  <div className="flex h-10 w-10 items-center justify-center border border-[#C8CDD2] bg-[#EEF6FB] text-[#287EAD] shrink-0">
                    <Plus className="w-5 h-5" />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-foreground truncate">New Folder</p>
                    <p className="text-[11px] text-muted-foreground truncate">Create subdirectory</p>
                  </div>
                </button>
              )
            )}

            {subfolders.map((sf) => (
              <SubfolderCard key={sf.id} folder={sf} />
            ))}
          </div>
        </section>
      )}

      {/* Documents */}
      <section>
        {subfolders.length > 0 && (
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Documents
          </h2>
        )}

        {itemsLoading ? (
          <div className="flex justify-center py-16">
            <Loader2 className="w-6 h-6 animate-spin text-muted-foreground" />
          </div>
        ) : items.length === 0 ? (
          <div className="flex flex-col items-center justify-center border border-dashed border-[#C8CDD2] py-20 text-center">
            {folder.is_favourites ? (
              <>
                <Star className="w-12 h-12 text-amber-300/60 mb-4" />
                <p className="text-base font-semibold text-foreground">No favourites yet</p>
                <p className="mt-1 text-sm text-muted-foreground max-w-xs">
                  Star any document using the ★ button to add it here for quick access.
                </p>
              </>
            ) : (
              <>
                <Folder className="w-12 h-12 text-muted-foreground/40 mb-4" />
                <p className="text-base font-semibold text-foreground">This folder is empty</p>
                <p className="mt-1 text-sm text-muted-foreground max-w-xs">
                  Add documents to organise your workspace.
                </p>
                {!folder.is_shared && <button
                  onClick={() => setShowAdd(true)}
                  className="mt-5 inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2.5 text-sm font-semibold text-white hover:bg-[#206D99] transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Add documents
                </button>}
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {items.map((item) => (
              <DocumentCard
                key={item.id}
                item={item}
                canRemove={!folder.is_shared}
                onRemove={() => removeDoc.mutate(item.document)}
              />
            ))}
          </div>
        )}
      </section>

      {/* Add documents modal */}
      {showAdd && (
        <AddDocumentModal
          folderId={folderId!}
          existingDocIds={existingDocIds}
          onClose={() => setShowAdd(false)}
        />
      )}
      {showShare && <FolderShareModal folder={folder} onClose={() => setShowShare(false)} onShare={(data) => shareFolder.mutate(data)} isSaving={shareFolder.isPending} />}
    </div>
  );
}
