import type { QueryClient } from "@tanstack/react-query";
import { foldersAPI } from "@/services/foldersApi";
import type { DocumentFolder } from "@/types";

/** Invalidate every folder-related react-query cache (optionally scoped). */
export function invalidateFolderCaches(qc: QueryClient, folderId?: string | null) {
  void qc.invalidateQueries({ queryKey: ["folders"] });
  void qc.invalidateQueries({ queryKey: ["folders", "tree"] });
  if (folderId) {
    void qc.invalidateQueries({ queryKey: ["folder", folderId] });
    void qc.invalidateQueries({ queryKey: ["folder-documents", folderId] });
  } else {
    void qc.invalidateQueries({ queryKey: ["folder"] });
    void qc.invalidateQueries({ queryKey: ["folder-documents"] });
  }
}

/** Flatten a folder tree into `{id, label}` options (indented by depth). */
export function flattenFolderOptions(
  nodes: DocumentFolder[],
  depth = 0,
): Array<{ value: string; label: string }> {
  const out: Array<{ value: string; label: string }> = [];
  for (const node of nodes) {
    if (node.is_favourites) continue;
    const pad = depth > 0 ? `${"— ".repeat(depth)}` : "";
    out.push({ value: node.id, label: `${pad}${node.name}` });
    if (node.children?.length) {
      out.push(...flattenFolderOptions(node.children, depth + 1));
    }
  }
  return out;
}

/** Ancestor folder ids from root down to (but not including) target. */
export function collectAncestorIds(tree: DocumentFolder[], targetId: string): string[] {
  const path: string[] = [];
  const walk = (nodes: DocumentFolder[], ancestors: string[]): boolean => {
    for (const node of nodes) {
      if (node.id === targetId) {
        path.push(...ancestors);
        return true;
      }
      if (node.children?.length && walk(node.children, [...ancestors, node.id])) {
        return true;
      }
    }
    return false;
  };
  walk(tree, []);
  return path;
}

/** Add documents to a folder and refresh caches. Failures are soft (toast upstream). */
export async function addDocumentsToFolder(
  qc: QueryClient,
  folderId: string,
  documentIds: string[],
): Promise<void> {
  const unique = [...new Set(documentIds.filter(Boolean))];
  for (const documentId of unique) {
    await foldersAPI.addDocument(folderId, documentId);
  }
  invalidateFolderCaches(qc, folderId);
}
