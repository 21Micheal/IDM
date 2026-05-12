/**
 * components/folders/FolderTree.tsx
 *
 * Collapsible folder tree for the document sidebar.
 * Features:
 *  - Recursive render of unlimited depth (UI cap = 5)
 *  - Inline rename, inline create child
 *  - Context menu (rename / new subfolder / delete)
 *  - Star badge on Favourites node
 *  - Drag-to-reorder via HTML5 drag API (no extra lib)
 *  - Optimistic UI via react-query mutations
 */

import {
  useState, useRef, useCallback, KeyboardEvent,
} from "react";
import { useNavigate, useLocation } from "react-router-dom";
import {
  useMutation, useQuery, useQueryClient,
} from "@tanstack/react-query";
import {
  Star, Folder, FolderOpen, FolderPlus,
  ChevronRight, ChevronDown,
  MoreHorizontal, Pencil, Trash2, Plus,
  Check, X,
} from "lucide-react";
import clsx from "clsx";
import { foldersAPI } from "@/services/foldersApi";
import type { DocumentFolder } from "../../types";

// ─── Constants ────────────────────────────────────────────────────────────────

const ICON_MAP: Record<string, React.ElementType> = {
  star:   Star,
  folder: Folder,
};

const PRESET_COLORS = [
  "#6366f1", "#f59e0b", "#10b981", "#3b82f6",
  "#ef4444", "#8b5cf6", "#ec4899", "#14b8a6",
];

// ─── Types ────────────────────────────────────────────────────────────────────

interface FolderNodeProps {
  folder: DocumentFolder;
  depth: number;
  activeFolderId: string | null;
  onSelect: (id: string) => void;
}

interface ContextMenuState {
  folderId: string;
  x: number;
  y: number;
}

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useFolderMutations() {
  const qc = useQueryClient();

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ["folders", "tree"] });
    qc.invalidateQueries({ queryKey: ["folders"] });
  };

  const createFolder = useMutation({
    mutationFn: foldersAPI.create,
    onSuccess: invalidate,
  });

  const renameFolder = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string }) =>
      foldersAPI.update(id, { name }),
    onSuccess: invalidate,
  });

  const deleteFolder = useMutation({
    mutationFn: foldersAPI.delete,
    onSuccess: invalidate,
  });

  const updateFolder = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Partial<DocumentFolder> }) =>
      foldersAPI.update(id, data),
    onSuccess: invalidate,
  });

  return { createFolder, renameFolder, deleteFolder, updateFolder };
}

// ─── ColorPicker ─────────────────────────────────────────────────────────────

function ColorDot({
  color,
  selected,
  onClick,
}: {
  color: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="relative w-5 h-5 rounded-full ring-offset-1 transition-transform hover:scale-110"
      style={{ backgroundColor: color }}
      title={color}
    >
      {selected && (
        <Check className="absolute inset-0 m-auto w-3 h-3 text-white drop-shadow" />
      )}
    </button>
  );
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
      className="flex-1 min-w-0 bg-transparent border-b border-primary text-sm text-foreground outline-none px-0.5"
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
        className="fixed z-50 w-44 rounded-xl border border-border bg-card shadow-xl py-1 text-sm"
        style={{ top: y, left: x }}
      >
        <button
          className="flex items-center gap-2 w-full px-3 py-2 hover:bg-muted transition-colors text-foreground"
          onClick={() => { onRename(); onClose(); }}
        >
          <Pencil className="w-3.5 h-3.5 text-muted-foreground" />
          Rename
        </button>
        <button
          className="flex items-center gap-2 w-full px-3 py-2 hover:bg-muted transition-colors text-foreground"
          onClick={() => { onNewChild(); onClose(); }}
        >
          <FolderPlus className="w-3.5 h-3.5 text-muted-foreground" />
          New subfolder
        </button>
        {!folder.is_system && (
          <>
            <div className="my-1 border-t border-border" />
            <button
              className="flex items-center gap-2 w-full px-3 py-2 hover:bg-destructive/10 transition-colors text-destructive"
              onClick={() => { onDelete(); onClose(); }}
            >
              <Trash2 className="w-3.5 h-3.5" />
              Delete folder
            </button>
          </>
        )}
      </div>
    </>
  );
}

// ─── FolderNode ───────────────────────────────────────────────────────────────

function FolderNode({ folder, depth, activeFolderId, onSelect }: FolderNodeProps) {
  const [open, setOpen]         = useState(depth === 0);
  const [renaming, setRenaming] = useState(false);
  const [addingChild, setAddingChild] = useState(false);
  const [ctx, setCtx]           = useState<{ x: number; y: number } | null>(null);

  const { createFolder, renameFolder, deleteFolder } = useFolderMutations();

  const hasChildren = (folder.children?.length ?? 0) > 0;
  const isActive    = activeFolderId === folder.id;
  const Icon        = folder.is_favourites
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
      {/* Row */}
      <div
        className={clsx(
          "group flex items-center gap-1.5 rounded-lg px-2 py-1.5 cursor-pointer select-none transition-colors",
          isActive
            ? "bg-sidebar-primary text-sidebar-primary-foreground"
            : "text-sidebar-foreground hover:bg-sidebar-accent/50",
        )}
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={() => { onSelect(folder.id); if (hasChildren) setOpen((o) => !o); }}
        onContextMenu={handleContextMenu}
      >
        {/* Collapse toggle */}
        <span
          className="w-4 h-4 flex items-center justify-center shrink-0"
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setOpen((o) => !o); }}
        >
          {hasChildren
            ? (open
                ? <ChevronDown className="w-3 h-3 opacity-60" />
                : <ChevronRight className="w-3 h-3 opacity-60" />
              )
            : <span className="w-3" />
          }
        </span>

        {/* Folder icon */}
        <Icon
          className={clsx(
            "w-4 h-4 shrink-0",
            folder.is_favourites ? "text-amber-400" : "opacity-70",
          )}
          style={{ color: folder.is_favourites ? undefined : folder.color }}
        />

        {/* Name / inline edit */}
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

        {/* Count badge */}
        {folder.document_count > 0 && !renaming && (
          <span className="text-[10px] opacity-50 tabular-nums">
            {folder.document_count}
          </span>
        )}

        {/* ⋯ button */}
        {!renaming && (
          <button
            type="button"
            className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-black/10 transition-opacity"
            onClick={(e) => { e.stopPropagation(); handleContextMenu(e); }}
          >
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Context menu */}
      {ctx && (
        <ContextMenu
          folder={folder}
          x={ctx.x}
          y={ctx.y}
          onClose={() => setCtx(null)}
          onRename={() => setRenaming(true)}
          onNewChild={() => { setOpen(true); setAddingChild(true); }}
          onDelete={handleDelete}
        />
      )}

      {/* Inline new-child input */}
      {addingChild && (
        <div
          className="flex items-center gap-1.5 px-2 py-1.5"
          style={{ paddingLeft: `${8 + indent + 12}px` }}
        >
          <Folder className="w-4 h-4 opacity-40 shrink-0" />
          <InlineInput
            initial=""
            placeholder="New folder…"
            onConfirm={(name) => {
              createFolder.mutate({ name, parent: folder.id });
              setAddingChild(false);
            }}
            onCancel={() => setAddingChild(false)}
          />
        </div>
      )}

      {/* Children */}
      {open && folder.children && folder.children.length > 0 && (
        <div>
          {folder.children.map((child) => (
            <FolderNode
              key={child.id}
              folder={child}
              depth={depth + 1}
              activeFolderId={activeFolderId}
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
  const qc = useQueryClient();
  const [addingRoot, setAddingRoot] = useState(false);
  const { createFolder } = useFolderMutations();

  const { data: tree = [], isLoading } = useQuery({
    queryKey: ["folders", "tree"],
    queryFn: () => foldersAPI.tree().then((r) => r.data),
    staleTime: 30_000,
  });

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
      {/* Section header */}
      <div className="flex items-center justify-between px-3 pt-4 pb-1">
        <p className="text-[10px] font-semibold uppercase tracking-widest text-sidebar-foreground/60">
          My Folders
        </p>
        <button
          type="button"
          title="Create new folder"
          aria-label="Create new folder"
          className="inline-flex items-center gap-1.5 rounded-md border border-sidebar-border/60 bg-white/10 px-2 py-1 text-[11px] font-semibold text-sidebar-foreground hover:bg-sidebar-accent/70 hover:text-white transition-colors"
          onClick={() => setAddingRoot(true)}
        >
          <Plus className="w-3.5 h-3.5" />
          New folder
        </button>
      </div>

      {/* New root folder inline input */}
      {addingRoot && (
        <div className="flex items-center gap-1.5 px-3 py-1.5">
          <Folder className="w-4 h-4 opacity-40 shrink-0" />
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
        <div className="px-3 py-2 text-xs text-sidebar-foreground/50">Loading…</div>
      ) : tree.length === 0 && !addingRoot ? (
        <div className="px-3 py-2 text-xs text-sidebar-foreground/50">
          No folders yet.{" "}
          <button
            className="underline underline-offset-2"
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
              onSelect={handleSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
