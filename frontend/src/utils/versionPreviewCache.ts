/**
 * utils/versionPreviewCache.ts
 * 
 * Shared cache for document version previews to improve performance
 * and enable lazy loading of previous versions.
 */

import type { DocumentPreviewResponse } from "@/types";

type VersionPreviewCache = {
  [key: string]: {
    preview: DocumentPreviewResponse;
    timestamp: number;
  };
};

const VERSION_PREVIEW_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const versionPreviewCache: VersionPreviewCache = {};

export function getCachedVersionPreview(cacheKey: string): DocumentPreviewResponse | null {
  const cached = versionPreviewCache[cacheKey];
  if (!cached) return null;
  
  if (Date.now() - cached.timestamp > VERSION_PREVIEW_CACHE_TTL) {
    delete versionPreviewCache[cacheKey];
    return null;
  }
  
  return cached.preview;
}

export function setCachedVersionPreview(cacheKey: string, preview: DocumentPreviewResponse): void {
  versionPreviewCache[cacheKey] = {
    preview: { ...preview },
    timestamp: Date.now(),
  };
}

export function clearDocumentVersionCache(documentId: string): void {
  Object.keys(versionPreviewCache).forEach(key => {
    if (key.startsWith(`${documentId}-`)) {
      delete versionPreviewCache[key];
    }
  });
}

export function clearAllVersionCache(): void {
  Object.keys(versionPreviewCache).forEach(key => {
    delete versionPreviewCache[key];
  });
}
