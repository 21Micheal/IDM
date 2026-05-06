// services/foldersApi.ts

import { api } from "./api"; 
import type {
  DocumentFolder,
  DocumentFolderItem,
  DocumentFavourite,
  FavouriteCheckResult,
} from "../types";

// ── Folders ───────────────────────────────────────────────────────────────────

export const foldersAPI = {
  /** Full flat list (with child_count, document_count annotations) */
  list: () => api.get<DocumentFolder[]>("/documents/folders/"),

  /** Recursive tree — used for sidebar */
  tree: () => api.get<DocumentFolder[]>("/documents/folders/tree/"),

  get: (id: string) => api.get<DocumentFolder>(`/documents/folders/${id}/`),

  create: (data: {
    name: string;
    parent?: string | null;
    color?: string;
    icon?: string;
    position?: number;
  }) => api.post<DocumentFolder>("/documents/folders/", data),

  update: (
    id: string,
    data: Partial<Pick<DocumentFolder, "name" | "color" | "icon" | "position" | "parent">>
  ) => api.patch<DocumentFolder>(`/documents/folders/${id}/`, data),

  delete: (id: string) => api.delete(`/documents/folders/${id}/`),

  /** Ordered list of documents inside a folder */
  documents: (folderId: string) =>
    api.get<DocumentFolderItem[]>(`/documents/folders/${folderId}/documents/`),

  addDocument: (folderId: string, documentId: string) =>
    api.post<DocumentFolderItem>(`/documents/folders/${folderId}/add-document/`, {
      document: documentId,
    }),

  removeDocument: (folderId: string, documentId: string) =>
    api.delete(`/documents/folders/${folderId}/remove-document/${documentId}/`),

  /** Bulk reorder folders */
  reorder: (items: { id: string; position: number }[]) =>
    api.patch("/documents/folders/reorder/", { items }),

  /** Bulk reorder items inside a folder */
  reorderItems: (folderId: string, items: { id: string; position: number }[]) =>
    api.patch("/documents/folder-items/reorder/", { folder: folderId, items }),
};

// ── Favourites ────────────────────────────────────────────────────────────────

export const favouritesAPI = {
  list: () => api.get<DocumentFavourite[]>("/documents/favourites/"),

  /** Add to favourites */
  add: (documentId: string) =>
    api.post<DocumentFavourite>("/documents/favourites/", { document: documentId }),

  /** Remove by favourite record ID */
  remove: (favouriteId: string) =>
    api.delete(`/documents/favourites/${favouriteId}/`),

  /**
   * Toggle star state.
   * Returns { starred: boolean, ...rest }
   */
  toggle: (documentId: string) =>
    api.post<{ starred: boolean } & Partial<DocumentFavourite>>(
      "/documents/favourites/toggle/",
      { document: documentId }
    ),

  /** Check if a specific document is starred */
  check: (documentId: string) =>
    api.get<FavouriteCheckResult>("/documents/favourites/check/", {
      params: { document: documentId },
    }),

  /** Record that user opened a favourite (updates access_count) */
  recordAccess: (favouriteId: string) =>
    api.post(`/documents/favourites/${favouriteId}/access/`),
};