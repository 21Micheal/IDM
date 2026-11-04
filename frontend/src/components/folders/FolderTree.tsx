/**
 * components/folders/FolderTree.tsx
 *
 * Collapsible folder tree for the document sidebar.
 * Features:
 *  - Recursive render of unlimited depth
 *  - Inline rename, inline create child
 *  - Context menu (rename / new subfolder / delete)
 *  - Star badge on Favourites node
 *  - Expanded state survives tree refetches; ancestors of the active folder stay open
 */

import {
  useState, useRef, useCallback, useEffect, KeyboardEvent,
} from "react";
import { useNavigate } from "react-router-dom";
import {
  useMutation, useQuery, useQueryClient,
} from "@tanstack/react-query";
import {
  Star, Folder, FolderOpen, FolderPlus,
  ChevronRight, ChevronDown,
  MoreHorizontal, Pencil, Trash2, Plus, Share2,
} from "lucide-react";
import clsx from "clsx";
import { foldersAPI } from "@/services/foldersApi";
import { collectAncestorIds, invalidateFolderCaches } from "@/lib/folderCache";
import type { DocumentFolder } from "../../types";

// ─── Types ────────────────────────────────────────────────────────────────────

interface FolderNodeProps {
  folder: DocumentFolder;
  depth: number;
  activeFolderId: string | null;
  expandedIds: Set<string>;
  onToggleExpand: (id: string) => void;
  onExpand: (id: string) => void;
  onSelect: (id: string) => void;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useFolderMutations() {
  const qc = useQueryClient();

  const invalidate = (parentId?: string | null) => {
    invalidateFolderCaches(qc, parentId ?? undefined);
  };

  const createFolder = useMutation({
    mutationFn: foldersAPI.create,
    onSuccess: (_data, vars) => invalidate(vars.parent),
  });

  const renameFolder = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      foldersAPI.update(id, { name }),
    onSuccess: (_data, vars) => invalidate(vars.id),
  });

  const deleteFolder = useMutation({
    mutationFn: foldersAPI.delete,
    onSuccess: (_data, id) => invalidate(id),
  });

  const updateFolder = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<DocumentFolder> }) =>
      foldersAPI.update(id, data),
    onSuccess: (_data, vars) => invalidate(vars.id),
  });

  return { createFolder, renameFolder, deleteFolder, updateFolder };
}

// ─── Inline edit input ────────────────────────────────────────────────────────

function InlineInput({
  initial,
  onConfirm,
  onCancel,
  placeholder = "Folder name",
}: {
  initial: string;
  onConfirm: (v: string) => void;
  onCancel: () => void;
  placeholder?: string;
}) {
  const [val, setVal] = useState(initial);
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
    <input
      ref={ref}
      autoFocus
      className="min-w-0 flex-1 border-b border-[#287EAD] bg-transparent px-0.5 text-sm text-[#1F2933] outline-none placeholder:text-[#7C8790]"
      value={val}
      placeholder={placeholder}
      onChange={(e) => setVal(e.target.value)}
      onKeyDown={onKey}
      onBlur={commit}
    />
  );
}

// ─── Context Menu ─────────────────────────────────────────────────────────────

function ContextMenu({
  folder,
  x,
  y,
  onClose,
  onRename,
  onNewChild,
  onDelete,
}: {
  folder: DocumentFolder;
  x: number;
  y: number;
  onClose: () => void;
  onRename: () => void;
  onNewChild: () => void;
  onDelete: () => void;
}) {
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div
        className="fixed z-50 w-48 border border-[#C8CDD2] bg-white py-1 text-sm shadow-xl"
        style={{ top: y, left: x }}
      >
        <button
          className="flex w-full items-center gap-2 px-3 py-2 text-[#1F2933] transition-colors hover:bg-[#EEF3F7]"
          onClick={() => { onRename(); onClose(); }}
        >
          <Pencil className="h-3.5 w-3.5 text-[#6E767D]" />
          Rename
        </button>
        <button
          className="flex w-full items-center gap-2 px-3 py-2 text-[#1F2933] transition-colors hover:bg-[#EEF3F7]"
          onClick={() => { onNewChild(); onClose(); }}
        >
          <FolderPlus className="h-3.5 w-3.5 text-[#6E767D]" />
          New subfolder
        </button>
        {!folder.is_system && (
          <>
            <div className="my-1 border-t border-[#C8CDD2]" />
            <button
              className="flex w-full items-center gap-2 px-3 py-2 text-[#B42318] transition-colors hover:bg-[#FFF1F0]"
              onClick={() => { onDelete(); onClose(); }}
            >
              <Trash2 className="h-3.5 w-3.5" />
              Delete folder
            </button>
          </>
        )}
      </div>
    </>
  );
}

// ─── FolderNode ───────────────────────────────────────────────────────────────

function FolderNode({
  folder, depth, activeFolderId, expandedIds, onToggleExpand, onExpand, onSelect,
}: FolderNodeProps) {
  const [renaming, setRenaming] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [ctx, setCtx] = useState<{ x: number; y: number } | null>(null);

  const { createFolder, renameFolder, deleteFolder } = useFolderMutations();

  const hasChildren = (folder.children?.length ?? 0) > 0;
  const open = expandedIds.has(folder.id) || addingChild;
  const isActive = activeFolderId === folder.id;
  const Icon = folder.is_favourites
    ? Star
    : (open && hasChildren ? FolderOpen : Folder);

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtx({ x: e.clientX, y: e.clientY });
  };

  const handleDelete = () => {
    if (!window.confirm(`Delete "${folder.name}" and all its subfolders?`)) return;
    deleteFolder.mutate(folder.id);
  };

  const indent = depth * 12;

  return (
    <div>
      <div
        className={clsx(
          "group flex cursor-pointer select-none items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors",
          isActive
            ? "bg-[#287EAD] text-white shadow-sm"
            : "text-[#3D454D] hover:bg-white/75 hover:text-[#1F2933] hover:shadow-sm",
        )}
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={() => onSelect(folder.id)}
        onContextMenu={handleContextMenu}
      >
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center"
          onClick={(e) => {
            e.stopPropagation();
            if (hasChildren || addingChild) onToggleExpand(folder.id);
          }}
        >
          {hasChildren || addingChild
            ? (open
                ? <ChevronDown className="h-3 w-3 text-[#6E767D]" />
                : <ChevronRight className="h-3 w-3 text-[#6E767D]" />
              )
            : <span className="w-3" />
          }
        </span>

        <Icon
          className={clsx(
            "h-4 w-4 shrink-0",
            isActive ? "text-white" : folder.is_favourites ? "text-[#A15C00]" : "text-[#6E767D]",
          )}
          style={{ color: isActive || folder.is_favourites ? undefined : folder.color }}
        />

        {renaming ? (
          <InlineInput
            initial={folder.name}
            placeholder="Folder name"
            onConfirm={(name) => {
              renameFolder.mutate({ id: folder.id, name });
              setRenaming(false);
            }}
            onCancel={() => setRenaming(false)}
          />
        ) : (
          <span className="flex-1 truncate text-sm font-medium">
            {folder.name}
          </span>
        )}

        {folder.document_count > 0 && !renaming && (
          <span className={clsx(
            "min-w-[1.25rem] px-1.5 py-0.5 text-center text-[10px] font-bold tabular-nums",
            isActive ? "bg-white/20 text-white" : "bg-[#287EAD] text-white",
          )}>
            {folder.document_count}
          </span>
        )}

        {!renaming && (
          <button
            type="button"
            className={clsx(
              "p-0.5 opacity-0 transition-opacity group-hover:opacity-100",
              isActive
                ? "text-white/80 hover:bg-white/15 hover:text-white"
                : "text-[#6E767D] hover:bg-[#DCEAF2] hover:text-[#287EAD]",
            )}
            onClick={(e) => { e.stopPropagation(); handleContextMenu(e); }}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {ctx && (
        <ContextMenu
          folder={folder}
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          onRename={() => setRenaming(true)}
          onNewChild={() => { onExpand(folder.id); setAddingChild(true); }}
          onDelete={handleDelete}
        />
      )}

      {addingChild && (
        <div
          className="flex items-center gap-1.5 px-2 py-1.5 text-[#3D454D]"
          style={{ paddingLeft: `${8 + indent + 12}px` }}
        >
          <Folder className="h-4 w-4 shrink-0 text-[#7C8790]" />
          <InlineInput
            initial=""
            placeholder="New folder…"
            onConfirm={(name) => {
              onExpand(folder.id);
              createFolder.mutate({ name, parent: folder.id });
              setAddingChild(false);
            }}
            onCancel={() => setAddingChild(false)}
          />
        </div>
      )}

      {open && folder.children && folder.children.length > 0 && (
        <div>
          {folder.children.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              depth={depth + 1}
              activeFolderId={activeFolderId}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              onExpand={onExpand}
              onSelect={onSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── FolderTree (exported) ────────────────────────────────────────────────────

export interface FolderTreeProps {
  activeFolderId?: string | null;
  onFolderSelect?: (folderId: string) => void;
}

export function FolderTree({ activeFolderId = null, onFolderSelect }: FolderTreeProps) {
  const navigate = useNavigate();
  const [addingRoot, setAddingRoot] = useState(false);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() => new Set());
  const { createFolder } = useFolderMutations();

  const { data: tree = [], isLoading } = useQuery({
    queryKey: ["folders", "tree"],
    queryFn: () => foldersAPI.tree().then((r) => r.data),
    staleTime: 30_000,
  });
  const { data: sharedFolders = [] } = useQuery({
    queryKey: ["folders", "shared"],
    queryFn: () => foldersAPI.shared().then((r) => r.data),
    staleTime: 15_000,
    refetchInterval: 30_000,
  });

  // Keep the path to the active folder expanded across navigations / refetches.
  useEffect(() => {
    if (!activeFolderId || tree.length === 0) return;
    const ancestors = collectAncestorIds(tree, activeFolderId);
    setExpandedIds((prev) => {
      let changed = false;
      const next = new Set(prev);
      for (const id of ancestors) {
        if (!next.has(id)) {
          next.add(id);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [activeFolderId, tree]);

  const onToggleExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const onExpand = useCallback((id: string) => {
    setExpandedIds((prev) => {
      if (prev.has(id)) return prev;
      const next = new Set(prev);
      next.add(id);
      return next;
    });
  }, []);

  const handleSelect = useCallback(
    (id: string) => {
      if (onFolderSelect) {
        onFolderSelect(id);
      } else {
        navigate(`/documents/folders/${id}`);
      }
    },
    [navigate, onFolderSelect],
  );

  return (
    <div className="select-none">
      <div className="flex items-center justify-between gap-2 px-3 pb-2 pt-4">
        <p className="text-[10px] font-bold uppercase tracking-widest text-[#6E767D]">My Folders</p>
        <button
          type="button"
          title="Create new folder"
          aria-label="Create new folder"
          className="inline-flex h-7 w-7 items-center justify-center border border-[#C8CDD2] bg-white text-[#5E6870] transition-colors hover:bg-[#EEF3F7] hover:text-[#287EAD]"
          onClick={() => setAddingRoot(true)}
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
      </div>

      {addingRoot && (
        <div className="flex items-center gap-1.5 px-3 py-1.5">
          <Folder className="h-4 w-4 shrink-0 text-[#7C8790]" />
          <InlineInput
            initial=""
            placeholder="New folder…"
            onConfirm={(name) => {
              createFolder.mutate({ name, parent: null });
              setAddingRoot(false);
            }}
            onCancel={() => setAddingRoot(false)}
          />
        </div>
      )}

      {isLoading ? (
        <div className="px-3 py-2 text-xs text-[#6E767D]">Loading...</div>
      ) : tree.length === 0 && !addingRoot ? (
        <div className="mx-3 border border-dashed border-[#C8CDD2] bg-white px-3 py-3 text-xs text-[#6E767D]">
          No folders yet.{" "}
          <button
            className="font-semibold text-[#287EAD] underline-offset-2 hover:underline"
            onClick={() => setAddingRoot(true)}
          >
            Create one
          </button>
        </div>
      ) : (
        <div className="mt-0.5 space-y-0.5 px-1">
          {tree.map((folder) => (
            <FolderNode
              key={folder.id}
              folder={folder}
              depth={0}
              activeFolderId={activeFolderId}
              expandedIds={expandedIds}
              onToggleExpand={onToggleExpand}
              onExpand={onExpand}
              onSelect={handleSelect}
            />
          ))}
        </div>
      )}

      {sharedFolders.length > 0 && (
        <section className="mt-3 border-t border-[#CDD3D8] pt-2">
          <div className="flex items-center gap-2 px-3 pb-1.5 pt-1">
            <Share2 className="h-3 w-3 text-[#6E767D]" />
            <p className="text-[10px] font-bold uppercase tracking-widest text-[#6E767D]">Shared with me</p>
          </div>
          <div className="space-y-0.5 px-1">
            {sharedFolders.map((folder) => (
              <button
                key={folder.share_id ?? folder.id}
                type="button"
                onClick={() => handleSelect(folder.id)}
                className={clsx(
                  "flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-left text-sm transition-colors",
                  activeFolderId === folder.id ? "bg-[#287EAD] text-white" : "text-[#3D454D] hover:bg-white/75",
                )}
              >
                <Folder className="h-4 w-4 shrink-0" style={{ color: activeFolderId === folder.id ? undefined : folder.color }} />
                <span className="min-w-0 flex-1 truncate">{folder.name}</span>
                <span className="max-w-20 truncate text-[10px] opacity-70">{folder.shared_by_name}</span>
              </button>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
