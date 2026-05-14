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

import { useState, useRef } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import {
  useQuery, useMutation, useQueryClient,
} from "@tanstack/react-query";
import {
  Folder, FolderOpen, Star, FileText, ArrowLeft,
  Plus, Trash2, Search, X, Loader2, ExternalLink,
  ChevronRight, MoreHorizontal, FolderPlus,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import clsx from "clsx";
import { foldersAPI } from "@/services/foldersApi";
import { documentsAPI } from "@/services/api";
import StatusBadge from "@/components/documents/StatusBadge";
import { formatDocumentFileType } from "@/lib/documentFormat";
import type { DocumentFolder, DocumentFolderItem } from "@/types/";
import type { Document } from "@/types";

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

  const path: Array<{ id: string; name: string }> = [];
  let current: DocumentFolder | undefined = folder;
  while (current) {
    path.unshift({ id: current.id, name: current.name });
    current = flat.find((f) => f.id === current!.parent);
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
      qc.invalidateQueries({ queryKey: ["folder-documents", folderId] });
      qc.invalidateQueries({ queryKey: ["folders", "tree"] });
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
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div
        className="relative w-full max-w-lg rounded-2xl border border-border bg-card shadow-2xl overflow-hidden"
        style={{ maxHeight: "80vh" }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-base font-semibold text-foreground">Add documents to folder</h2>
          <button onClick={onClose} className="p-1 rounded-lg hover:bg-muted transition-colors">
            <X className="w-4 h-4 text-muted-foreground" />
          </button>
        </div>

        {/* Search */}
        <div className="px-5 py-3 border-b border-border">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
            <input
              autoFocus
              className="input w-full pl-9"
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
            <div className="divide-y divide-border">
              {docs.map((doc) => {
                const checked = selected.has(doc.id);
                return (
                  <label
                    key={doc.id}
                    className="flex items-center gap-3 px-5 py-3 hover:bg-muted/40 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      className="rounded border-border"
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
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-t border-border bg-muted/20">
          <p className="text-xs text-muted-foreground">
            {selected.size} selected
          </p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onClose}
              className="btn-ghost text-sm px-3 py-1.5"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={selected.size === 0 || addMutation.isPending}
              onClick={handleAdd}
              className="btn-primary text-sm px-4 py-1.5 disabled:opacity-50"
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
      className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 hover:border-primary/30 hover:bg-muted/30 transition-all"
    >
      <div
        className="flex h-10 w-10 items-center justify-center rounded-lg"
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
}: {
  item: DocumentFolderItem;
  onRemove: () => void;
}) {
  const navigate = useNavigate();
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div
      className="group flex items-start gap-3 rounded-xl border border-border bg-card p-4 hover:border-primary/30 hover:shadow-sm transition-all cursor-pointer"
      onClick={() => navigate(`/documents/${item.document}`)}
    >
      <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/5 text-primary shrink-0">
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
          className="p-1.5 rounded-lg opacity-0 group-hover:opacity-100 hover:bg-muted transition-all"
          onClick={() => setMenuOpen((o) => !o)}
        >
          <MoreHorizontal className="w-4 h-4 text-muted-foreground" />
        </button>
        {menuOpen && (
          <>
            <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
            <div className="absolute right-0 top-8 z-20 w-40 rounded-xl border border-border bg-card shadow-xl py-1 text-sm">
              <button
                className="flex items-center gap-2 w-full px-3 py-2 hover:bg-muted text-foreground"
                onClick={() => navigate(`/documents/${item.document}`)}
              >
                <ExternalLink className="w-3.5 h-3.5 text-muted-foreground" />
                Open
              </button>
              <button
                className="flex items-center gap-2 w-full px-3 py-2 hover:bg-destructive/10 text-destructive"
                onClick={() => { onRemove(); setMenuOpen(false); }}
              >
                <Trash2 className="w-3.5 h-3.5" />
                Remove
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── FolderPage (exported) ────────────────────────────────────────────────────

export default function FolderPage() {
  const { folderId } = useParams<{ folderId: string }>();
  const navigate     = useNavigate();
  const qc           = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);

  // Folder meta
  const { data: folder, isLoading: folderLoading } = useQuery({
    queryKey: ["folder", folderId],
    queryFn: () => foldersAPI.get(folderId!).then((r) => r.data),
    enabled: !!folderId,
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
  });

  // Subfolders (from tree cache)
  const tree: DocumentFolder[] = qc.getQueryData(["folders", "tree"]) ?? [];
  const findFolder = (nodes: DocumentFolder[], id: string): DocumentFolder | undefined => {
    for (const n of nodes) {
      if (n.id === id) return n;
      if (n.children) {
        const found = findFolder(n.children, id);
        if (found) return found;
      }
    }
  };
  const folderNode = findFolder(tree, folderId ?? "");
  const subfolders = folderNode?.children ?? [];

  const removeDoc = useMutation({
    mutationFn: (docId: string) => foldersAPI.removeDocument(folderId!, docId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["folder-documents", folderId] });
      qc.invalidateQueries({ queryKey: ["folders", "tree"] });
    },
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

  const FolderIcon = folder.is_favourites ? Star : FolderOpen;

  return (
    <div className="mx-auto w-full max-w-[1680px] space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-2">
          <Breadcrumb folder={folder} />
          <div className="flex items-center gap-3">
            <div
              className="flex h-10 w-10 items-center justify-center rounded-xl"
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

        {!folder.is_favourites && (
          <button
            type="button"
            onClick={() => setShowAdd(true)}
            className="inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <Plus className="w-4 h-4" />
            Add documents
          </button>
        )}
      </div>

      {/* Subfolders */}
      {(subfolders.length > 0 || !folder.is_favourites) && (
        <section>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-3">
            Subfolders
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {!folder.is_favourites && (
              <button
                type="button"
                className="group flex items-center gap-3 rounded-xl border border-dashed border-border bg-card p-4 hover:border-primary/30 hover:bg-muted/30 transition-all text-left"
              >
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/5 text-primary shrink-0">
                  <Plus className="w-5 h-5" />
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold text-foreground truncate">New Folder</p>
                  <p className="text-[11px] text-muted-foreground truncate">Create subdirectory</p>
                </div>
              </button>
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
          <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-border py-20 text-center">
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
                <button
                  onClick={() => setShowAdd(true)}
                  className="mt-5 inline-flex items-center gap-2 rounded-xl bg-primary px-4 py-2.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  Add documents
                </button>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
            {items.map((item) => (
              <DocumentCard
                key={item.id}
                item={item}
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
    </div>
  );
}
