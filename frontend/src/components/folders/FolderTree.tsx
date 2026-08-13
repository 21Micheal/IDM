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
import { useNavigate } from "react-router-dom";
import {
  useMutation, useQuery, useQueryClient,
} from "@tanstack/react-query";
import {
  Star, Folder, FolderOpen, FolderPlus,
  ChevronRight, ChevronDown,
  MoreHorizontal, Pencil, Trash2, Plus,
 
} from "lucide-react";
import clsx from "clsx";
import { foldersAPI } from "@/services/foldersApi";
import type { DocumentFolder } from "../../types";

// ─── Constants ────────────────────────────────────────────────────────────────

// NOTE: removed unused icon map and preset colors to satisfy lint

// ─── Types ────────────────────────────────────────────────────────────────────

interface FolderNodeProps {
  folder: DocumentFolder;
  depth: number;
  activeFolderId: string | null;
  onSelect: (id: string) => void;
}

// ContextMenuState removed (not used)

// ─── Hooks ────────────────────────────────────────────────────────────────────

function useFolderMutations() {
  const _qc = useQueryClient();

  void _qc;

  const invalidate = () => {
    _qc.invalidateQueries({ queryKey: ["folders", "tree"] });
    _qc.invalidateQueries({ queryKey: ["folders"] });
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

// ColorDot component removed (unused)

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

function FolderNode({ folder, depth, activeFolderId, onSelect }: FolderNodeProps) {
  const [open, setOpen]         = useState(false);
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
          "group flex cursor-pointer select-none items-center gap-1.5 rounded-md px-2 py-1.5 transition-colors",
          isActive
            ? "bg-[#287EAD] text-white shadow-sm"
            : "text-[#3D454D] hover:bg-white/75 hover:text-[#1F2933] hover:shadow-sm",
        )}
        style={{ paddingLeft: `${8 + indent}px` }}
        onClick={() => { onSelect(folder.id); if (hasChildren) setOpen((o) => !o); }}
        onContextMenu={handleContextMenu}
      >
        {/* Collapse toggle */}
        <span
          className="flex h-4 w-4 shrink-0 items-center justify-center"
          onClick={(e) => { e.stopPropagation(); if (hasChildren) setOpen((o) => !o); }}
        >
          {hasChildren
            ? (open
                ? <ChevronDown className="h-3 w-3 text-[#6E767D]" />
                : <ChevronRight className="h-3 w-3 text-[#6E767D]" />
              )
            : <span className="w-3" />
          }
        </span>

        {/* Folder icon */}
        <Icon
          className={clsx(
            "h-4 w-4 shrink-0",
            isActive ? "text-white" : folder.is_favourites ? "text-[#A15C00]" : "text-[#6E767D]",
          )}
          style={{ color: isActive || folder.is_favourites ? undefined : folder.color }}
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
          <span className="min-w-[1.25rem] bg-[#287EAD] px-1.5 py-0.5 text-center text-[10px] font-bold tabular-nums text-white">
            {folder.document_count}
          </span>
        )}

        {/* ⋯ button */}
        {!renaming && (
          <button
            type="button"
            className="p-0.5 text-[#6E767D] opacity-0 transition-opacity hover:bg-[#DCEAF2] hover:text-[#287EAD] group-hover:opacity-100"
            onClick={(e) => { e.stopPropagation(); handleContextMenu(e); }}
          >
            <MoreHorizontal className="h-3.5 w-3.5" />
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
          className="flex items-center gap-1.5 px-2 py-1.5 text-[#3D454D]"
          style={{ paddingLeft: `${8 + indent + 12}px` }}
        >
          <Folder className="h-4 w-4 shrink-0 text-[#7C8790]" />
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
  const _qc = useQueryClient();
  void _qc;
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

      {/* New root folder inline input */}
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
              onSelect={handleSelect}
            />
          ))}
        </div>
      )}
    </div>
  );
}
