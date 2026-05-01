const loadedChunks = new Set<string>();

function loadOnce(key: string, loader: () => Promise<unknown>) {
  if (loadedChunks.has(key)) return;
  loadedChunks.add(key);
  void loader().catch(() => {
    loadedChunks.delete(key);
  });
}

export function preloadDocumentWorkspace() {
  loadOnce("route:document-detail", () => import("@/pages/DocumentDetailPage"));
  loadOnce("component:document-viewer", () => import("@/components/documents/DocumentViewer"));
  loadOnce("component:metadata-panel", () => import("@/components/documents/MetadataEditPanel"));
  loadOnce("component:workflow-action-panel", () => import("@/components/workflow/WorkflowActionPanel"));
}

export function preloadCommonRoutes() {
  loadOnce("route:dashboard", () => import("@/pages/DashboardPage"));
  loadOnce("route:documents", () => import("@/pages/DocumentsPage"));
  loadOnce("route:upload", () => import("@/pages/UploadPage"));
  loadOnce("route:scan-upload", () => import("@/pages/UploadPage"));
  loadOnce("route:search", () => import("@/pages/SearchPage"));
  loadOnce("route:workflow", () => import("@/pages/WorkflowPage"));
  loadOnce("route:notifications", () => import("@/pages/NotificationsPage"));
}

export function preloadRouteForPath(pathname: string) {
  if (pathname === "/") {
    loadOnce("route:dashboard", () => import("@/pages/DashboardPage"));
    return;
  }

  if (pathname.startsWith("/documents/scan")) {
    loadOnce("route:scan-upload", () => import("@/pages/UploadPage"));
    return;
  }

  if (pathname.startsWith("/documents/") && !pathname.startsWith("/documents/upload")) {
    preloadDocumentWorkspace();
    return;
  }

  if (pathname === "/documents") {
    loadOnce("route:documents", () => import("@/pages/DocumentsPage"));
    return;
  }

  if (pathname.startsWith("/workflow/builder")) {
    loadOnce("route:workflow-builder", () => import("@/pages/WorkflowBuilderPage"));
    return;
  }

  if (pathname.startsWith("/workflow")) {
    loadOnce("route:workflow", () => import("@/pages/WorkflowPage"));
    return;
  }

  if (pathname.startsWith("/search")) {
    loadOnce("route:search", () => import("@/pages/SearchPage"));
    return;
  }

  if (pathname.startsWith("/upload") || pathname.startsWith("/documents/upload")) {
    loadOnce("route:upload", () => import("@/pages/UploadPage"));
    return;
  }

  if (pathname.startsWith("/notifications")) {
    loadOnce("route:notifications", () => import("@/pages/NotificationsPage"));
    return;
  }
}
