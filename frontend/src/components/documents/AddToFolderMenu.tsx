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
import { FolderPlus, Check, Folder, Star, Plus, Loader2 } from "lucide-react";
import clsx from "clsx";
import { foldersAPI } from "@/services/foldersApi";
import type { DocumentFolder } from "../../types";

interface Props {
  documentId: string;
  showLabel?: boolean;
  className?: string;
}

interface FlatFolderWithMembership extends DocumentFolder {
  isMember: boolean;
}

export function AddToFolderMenu({ documentId, showLabel = false, className }: Props) {
  const [open, setOpen] = useState(false);
  const qc              = useQueryClient();

  // Flat folder list with document_count
  const { data: folders = [] } = useQuery<DocumentFolder[]>({
    queryKey: ["folders"],
    queryFn: () => foldersAPI.list().then((r) => Array.isArray(r.data) ? r.data : []),
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
            const items = await foldersAPI
              .documents(f.id)
              .then((r) => r.data);
            return items.some((i) => i.document === documentId)
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

  const handleToggle = (folder: DocumentFolder) => {
    if (folder.is_favourites) return; // favourites managed via StarButton
    const isMember = memberships.includes(folder.id);
    if (isMember) {
      removeMutation.mutate(folder.id);
    } else {
      addMutation.mutate(folder.id);
    }
  };

  const isPending = addMutation.isPending || removeMutation.isPending;

  // Sort: system first, then alphabetical
  const sortedFolders = [...folders].sort((a, b) => {
    if (a.is_system && !b.is_system) return -1;
    if (!a.is_system && b.is_system) return 1;
    return a.name.localeCompare(b.name);
  });

  return (
    <div className={clsx("relative", className)}>
      <button
        type="button"
        title="Organize in folders"
        aria-label="Organize document in folders"
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        className={clsx(
          showLabel
            ? "inline-flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-medium"
            : "p-1.5 rounded-lg",
          "text-muted-foreground hover:text-foreground hover:bg-muted transition-colors",
        )}
      >
        <FolderPlus className="w-4 h-4" />
        {showLabel && <span>Organize in folders</span>}
      </button>

      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute right-0 top-9 z-50 w-56 rounded-xl border border-border bg-card shadow-xl overflow-hidden">
            <div className="px-3 py-2.5 border-b border-border">
              <p className="text-xs font-semibold text-foreground">Organize in folders</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">
                Select a folder to add or remove this document.
              </p>
            </div>

            {folders.length === 0 ? (
              <p className="px-3 py-4 text-xs text-muted-foreground text-center">
                No folders yet. Create one in the sidebar.
              </p>
            ) : (
              <div className="py-1 max-h-60 overflow-y-auto">
                {sortedFolders
                  .filter((f) => !f.is_favourites)
                  .map((folder) => {
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
            )}
          </div>
        </>
      )}
    </div>
  );
}
