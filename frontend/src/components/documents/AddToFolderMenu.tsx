/**
 * components/documents/AddToFolderMenu.tsx
 *
 * Dropdown menu that lets the user add or remove the current document
 * from any of their folders.  Renders as a popover triggered by a
 * FolderPlus icon button.
 *
 * Usage:
 *   <AddToFolderMenu documentId={doc.id} />
 */

import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { FolderPlus, Check, Folder, Star, Plus, Loader2, X } from "lucide-react";
import clsx from "clsx";
import { foldersAPI } from "@/services/foldersApi";
import { normalizeListResponse } from "@/services/api";
import type { DocumentFolder } from "../../types";

interface Props {
  documentId: string;
  showLabel?: boolean;
  className?: string;
  triggerClassName?: string;
}

export function AddToFolderMenu({ documentId, showLabel = false, className, triggerClassName }: Props) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [folderName, setFolderName] = useState("");
  const qc              = useQueryClient();

  // Flat folder list with document_count
  const { data: folders = [] } = useQuery<DocumentFolder[]>({
    queryKey: ["folders"],
    queryFn: () => foldersAPI.list().then((r) => normalizeListResponse<DocumentFolder>(r.data)),
    staleTime: 60_000,
    enabled: open,
  });

  // Which folders already contain this document
  const { data: memberships = [] } = useQuery({
    queryKey: ["doc-folder-memberships", documentId],
    queryFn: async () => {
      // For each folder check via the items list.
      // A lightweight approach: fetch all folder items for this document
      // by hitting a dedicated endpoint if you add one, or filter client-side.
      // Here we fetch each folder's document list — cached so only new ones hit network.
      // For large folder counts, add GET /documents/{id}/folders/ endpoint instead.
      const results = await Promise.all(
        folders.map(async (f) => {
          try {
            const items = await foldersAPI.documents(f.id).then((r) =>
              normalizeListResponse<Record<string, unknown>>(r.data),
            );
            return items.some((item) => getFolderItemDocumentId(item) === documentId)
              ? f.id
              : null;
          } catch {
            return null;
          }
        }),
      );
      return results.filter(Boolean) as string[];
    },
    enabled: open && folders.length > 0,
    staleTime: 10_000,
  });

  const addMutation = useMutation({
    mutationFn: (folderId: string) => foldersAPI.addDocument(folderId, documentId),
    onSuccess: (_, folderId) => {
      qc.invalidateQueries({ queryKey: ["folder-documents", folderId] });
      qc.invalidateQueries({ queryKey: ["doc-folder-memberships", documentId] });
      qc.invalidateQueries({ queryKey: ["folders", "tree"] });
      qc.invalidateQueries({ queryKey: ["folders"] });
    },
  });

  const removeMutation = useMutation({
    mutationFn: (folderId: string) => foldersAPI.removeDocument(folderId, documentId),
    onSuccess: (_, folderId) => {
      qc.invalidateQueries({ queryKey: ["folder-documents", folderId] });
      qc.invalidateQueries({ queryKey: ["doc-folder-memberships", documentId] });
      qc.invalidateQueries({ queryKey: ["folders", "tree"] });
      qc.invalidateQueries({ queryKey: ["folders"] });
    },
  });

  const createMutation = useMutation({
    mutationFn: (name: string) => foldersAPI.create({ name, parent: null }),
    onSuccess: ({ data }) => {
      qc.invalidateQueries({ queryKey: ["folders"] });
      qc.invalidateQueries({ queryKey: ["folders", "tree"] });
      setFolderName("");
      setCreating(false);
      addMutation.mutate(data.id);
    },
  });

  const handleToggle = (folder: DocumentFolder) => {
    if (folder.is_favourites) return; // favourites managed via StarButton
    const isMember = memberships.includes(folder.id);
    if (isMember) {
      removeMutation.mutate(folder.id);
    } else {
      addMutation.mutate(folder.id);
    }
  };

  // Sort: system first, then alphabetical
  const sortedFolders = [...folders].sort((a, b) => {
    if (a.is_system && !b.is_system) return -1;
    if (!a.is_system && b.is_system) return 1;
    return a.name.localeCompare(b.name);
  });
  const availableFolders = sortedFolders.filter((folder) => !folder.is_favourites);
  const isPending = addMutation.isPending || removeMutation.isPending;
  const isCreating = createMutation.isPending;

  const handleCreate = () => {
    const name = folderName.trim();
    if (!name || isCreating) return;
    createMutation.mutate(name);
  };

  return (
    <div className={clsx("relative", className)}>
      <button
        type="button"
        title="Organize in folders"
        aria-label="Organize document in folders"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className={clsx(
          triggerClassName ?? [
            showLabel
              ? "inline-flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1 text-xs font-semibold"
              : "p-1.5 rounded-lg",
            "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
          ],
        )}
      >
        <FolderPlus className={showLabel ? "w-3.5 h-3.5" : "w-4 h-4"} />
        {showLabel && <span>Add to folder</span>}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-50 w-72 rounded-xl border border-border bg-card shadow-xl overflow-hidden">
            <div className="px-3 py-2.5 border-b border-border">
              <p className="text-xs font-semibold text-foreground">Add to folder</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Choose an existing folder or create one here.
              </p>
            </div>

            {folders.length === 0 && !creating ? (
              <div className="px-3 py-4 text-center">
                <Folder className="mx-auto mb-2 h-8 w-8 text-muted-foreground/50" />
                <p className="text-xs font-medium text-foreground">No folders found</p>
                <p className="mt-1 text-[11px] text-muted-foreground">
                  Create a folder and this document will be added to it.
                </p>
                <button
                  type="button"
                  onClick={() => setCreating(true)}
                  className="mt-3 inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  <Plus className="h-3.5 w-3.5" />
                  New folder
                </button>
              </div>
            ) : (
              <>
                <div className="py-1 max-h-60 overflow-y-auto">
                  {availableFolders.map((folder) => {
                    const isMember = memberships.includes(folder.id);
                    const FolderIcon = folder.is_favourites ? Star : Folder;
                    return (
                      <button
                        key={folder.id}
                        type="button"
                        onClick={() => handleToggle(folder)}
                        disabled={isPending}
                        className="flex items-center gap-2.5 w-full px-3 py-2 hover:bg-muted/60 transition-colors text-sm text-foreground"
                      >
                        <FolderIcon
                          className="w-4 h-4 shrink-0"
                          style={{
                            color: folder.is_favourites ? "#f59e0b" : folder.color,
                          }}
                        />
                        <span className="flex-1 truncate text-left">{folder.name}</span>
                        {isMember && (
                          <Check className="w-3.5 h-3.5 text-primary shrink-0" />
                        )}
                      </button>
                    );
                  })}
                </div>

                {!creating && (
                  <button
                    type="button"
                    onClick={() => setCreating(true)}
                    className="flex w-full items-center gap-2 border-t border-border px-3 py-2 text-sm font-medium text-primary hover:bg-primary/5"
                  >
                    <Plus className="h-4 w-4" />
                    Create new folder
                  </button>
                )}
              </>
            )}

            {creating && (
              <div className="border-t border-border bg-muted/20 p-3">
                <label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
                  New folder name
                </label>
                <div className="flex items-center gap-2">
                  <input
                    autoFocus
                    value={folderName}
                    onChange={(event) => setFolderName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") handleCreate();
                      if (event.key === "Escape") {
                        setCreating(false);
                        setFolderName("");
                      }
                    }}
                    className="input h-8 text-xs"
                    placeholder="Folder name"
                  />
                  <button
                    type="button"
                    onClick={handleCreate}
                    disabled={!folderName.trim() || isCreating}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                    title="Create folder"
                  >
                    {isCreating ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Check className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setCreating(false);
                      setFolderName("");
                    }}
                    className="inline-flex h-8 w-8 items-center justify-center rounded-md border border-border bg-card text-muted-foreground hover:text-foreground"
                    title="Cancel"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function getFolderItemDocumentId(item: Record<string, unknown>): string | null {
  const documentValue = item.document;
  if (typeof documentValue === "string") return documentValue;
  if (documentValue && typeof documentValue === "object" && "id" in documentValue) {
    const id = (documentValue as { id?: unknown }).id;
    return typeof id === "string" ? id : null;
  }
  const documentId = item.document_id;
  return typeof documentId === "string" ? documentId : null;
}
