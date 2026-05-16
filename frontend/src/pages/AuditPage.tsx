import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import {
  ShieldCheck,
  Filter,
  Clock,
  User,
  Download,
  Info,
  ChevronLeft,
  ChevronRight,
  Search,
  Activity,
  Calendar,
  X,
  FileText,
} from "lucide-react";
import { format, subDays, isToday, isYesterday, formatDistanceToNow } from "date-fns";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";

export default function AuditPage() {
  const [searchTerm, setSearchTerm] = useState("");
  const [eventFilter, setEventFilter] = useState("");
  const [dateFrom, setDateFrom] = useState(format(subDays(new Date(), 30), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(new Date(), "yyyy-MM-dd"));
  const [page, setPage] = useState(1);

  const PAGE_SIZE = 10;
  const eventOptions = [
    ["document.created", "Document Created"],
    ["document.bulk_uploaded", "Bulk Uploaded"],
    ["document.bulk_reviewed", "Bulk Upload Reviewed"],
    ["document.viewed", "Document Viewed"],
    ["document.previewed", "Document Previewed"],
    ["document.downloaded", "Document Downloaded"],
    ["document.printed", "Document Printed"],
    ["document.updated", "Document Updated"],
    ["document.deleted", "Document Deleted"],
    ["document.archived", "Document Archived"],
    ["document.submitted", "Document Submitted"],
    ["document.version_uploaded", "Version Uploaded"],
    ["document.version_restored", "Version Restored"],
    ["document.preview_queued", "Preview Queued"],
    ["document.version_preview_queued", "Version Preview Queued"],
    ["document.ocr_queued", "OCR Queued"],
    ["document.ocr_completed", "OCR Completed"],
    ["document.ocr_failed", "OCR Failed"],
    ["document.edit_lock_acquired", "Edit Lock Acquired"],
    ["document.edit_lock_released", "Edit Lock Released"],
    ["workflow.approved", "Workflow Approved"],
    ["workflow.rejected", "Workflow Rejected"],
    ["workflow.returned", "Workflow Returned"],
    ["workflow.held", "Workflow Held"],
    ["workflow.released", "Workflow Released"],
    ["workflow.cancelled", "Workflow Cancelled"],
    ["workflow.delegated", "Workflow Delegated"],
    ["workflow.reassigned", "Workflow Reassigned"],
    ["user.login", "User Login"],
    ["user.login_failed", "Login Failed"],
    ["user.mfa_enabled", "MFA Enabled"],
    ["permission.changed", "Permission Changed"],
    ["audit.exported", "Audit Exported"],
  ] as const;

  const eventLabelMap = useMemo(
    () => Object.fromEntries(eventOptions.map(([v, l]) => [v, l])),
    [],
  );

  const humanizeEvent = (event: string) =>
    eventLabelMap[event] ||
    event
      .split(/[._]/)
      .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
      .join(" ");

  const user = useAuthStore((s) => s.user);

  const listEndpoint = user?.has_admin_access ? "/audit/" : "/audit/my-activity/";

  const { data, isLoading } = useQuery({
    queryKey: ["audit-logs", listEndpoint, searchTerm, eventFilter, dateFrom, dateTo, page],
    queryFn: () =>
      api
        .get(listEndpoint, {
          params: {
            search: searchTerm || undefined,
            event: eventFilter || undefined,
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            page,
            page_size: PAGE_SIZE,
            ordering: "-timestamp",
          },
        })
        .then((r) => r.data),
    ...QUERY_SHORT_STALE,
  });

  // Indigo Vault semantic event coloring
  const eventColor = (event: string) => {
    if (event.includes("deleted") || event.includes("rejected") || event.includes("failed"))
      return "bg-destructive/10 text-destructive ring-1 ring-destructive/20";
    if (
      event.includes("approved") ||
      event.includes("created") ||
      event.includes("completed") ||
      event.includes("success")
    )
      return "bg-teal/15 text-teal ring-1 ring-teal/20";
    if (
      event.includes("login") ||
      event.includes("viewed") ||
      event.includes("previewed") ||
      event.includes("downloaded") ||
      event.includes("exported")
    )
      return "bg-accent/15 text-accent ring-1 ring-accent/20";
    if (event.includes("workflow") || event.includes("submitted") || event.includes("queued"))
      return "bg-primary/10 text-primary ring-1 ring-primary/20";
    return "bg-muted text-muted-foreground ring-1 ring-border";
  };

  const eventDot = (event: string) => {
    if (event.includes("deleted") || event.includes("rejected") || event.includes("failed"))
      return "bg-destructive";
    if (event.includes("approved") || event.includes("created") || event.includes("completed"))
      return "bg-teal";
    if (event.includes("login") || event.includes("viewed") || event.includes("downloaded"))
      return "bg-accent";
    if (event.includes("workflow") || event.includes("submitted") || event.includes("queued"))
      return "bg-primary";
    return "bg-muted-foreground/40";
  };

  const exportAudit = async () => {
    try {
      const response = await api.get("/audit/export/", {
        params: {
          search: searchTerm || undefined,
          event: eventFilter || undefined,
          date_from: dateFrom || undefined,
          date_to: dateTo || undefined,
        },
        responseType: "blob",
      });

      const url = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href = url;
      link.setAttribute("download", `audit-trail-${format(new Date(), "yyyy-MM-dd")}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);

      toast.success("Audit log exported successfully");
    } catch (err) {
      toast.error("Failed to export audit log");
    }
  };

  const resetFilters = () => {
    setSearchTerm("");
    setEventFilter("");
    setDateFrom(format(subDays(new Date(), 30), "yyyy-MM-dd"));
    setDateTo(format(new Date(), "yyyy-MM-dd"));
    setPage(1);
  };

  const totalPages = Math.ceil((data?.count ?? 0) / PAGE_SIZE);

  const activeFilterCount = [
    searchTerm,
    eventFilter,
    dateFrom !== format(subDays(new Date(), 30), "yyyy-MM-dd") ? dateFrom : "",
    dateTo !== format(new Date(), "yyyy-MM-dd") ? dateTo : "",
  ].filter(Boolean).length;

  // Group user feed entries by day
  const groupedFeed = useMemo(() => {
    const groups: Record<string, any[]> = {};
    (data?.results ?? []).forEach((log: any) => {
      const d = new Date(log.timestamp);
      const key = isToday(d)
        ? "Today"
        : isYesterday(d)
          ? "Yesterday"
          : format(d, "EEEE, dd MMM yyyy");
      (groups[key] ||= []).push(log);
    });
    return groups;
  }, [data]);

  return (
    <div className="max-w-7xl mx-auto py-10 px-6">
      {/* Header */}
      <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-11 h-11 rounded-xl bg-gradient-to-br from-primary/15 to-primary/5 ring-1 ring-primary/20 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-primary" />
            </div>
            <div className="flex items-center gap-2">
              <h1 className="text-3xl font-bold text-foreground tracking-tight">
                {user?.has_admin_access ? "Audit Trail" : "Document Activity"}
              </h1>
              <span
                title={
                  user?.has_admin_access
                    ? "Full system audit log for administrators."
                    : "A plain-language feed of recent actions on documents you uploaded or own (approvals, views, uploads)."
                }
              >
                <Info className="w-4 h-4 text-muted-foreground" />
              </span>
            </div>
            {!isLoading && data?.count !== undefined && (
              <span className="ml-1 inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-muted text-xs font-medium text-muted-foreground">
                <Activity className="w-3 h-3" />
                {data.count.toLocaleString()} {data.count === 1 ? "event" : "events"}
              </span>
            )}
          </div>
          <p className="text-muted-foreground text-sm max-w-2xl">
            {user?.has_admin_access
              ? "Immutable record of all system activities and changes."
              : "A simple feed of recent actions on your documents — approvals, views, and uploads."}
          </p>
        </div>

        {user?.has_admin_access && (
          <button onClick={exportAudit} className="btn-secondary flex items-center gap-2">
            <Download className="w-4 h-4" />
            Export CSV
          </button>
        )}
      </div>

      {/* Filters: full controls for admins, simplified note for regular users */}
      {user?.has_admin_access ? (
        <div className="card p-6 mb-6">
          <div className="flex items-center justify-between mb-5">
            <div className="flex items-center gap-2 text-sm">
              <Filter className="w-4 h-4 text-muted-foreground" />
              <span className="font-medium text-foreground">Filters</span>
              {activeFilterCount > 0 && (
                <span className="ml-1 px-2 py-0.5 rounded-full bg-primary/10 text-primary text-xs font-medium">
                  {activeFilterCount} active
                </span>
              )}
            </div>
            {activeFilterCount > 0 && (
              <button
                onClick={resetFilters}
                className="text-xs text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
              >
                <X className="w-3 h-3" />
                Clear all
              </button>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
            <div className="lg:col-span-2">
              <label className="label flex items-center gap-2">
                <Search className="w-4 h-4" /> Search
              </label>
              <input
                type="text"
                value={searchTerm}
                onChange={(e) => {
                  setSearchTerm(e.target.value);
                  setPage(1);
                }}
                placeholder="Actor email, object name, or event..."
                className="input"
              />
            </div>

            <div>
              <label className="label">Event Type</label>
              <select
                value={eventFilter}
                onChange={(e) => {
                  setEventFilter(e.target.value);
                  setPage(1);
                }}
                className="input"
              >
                <option value="">All Events</option>
                {eventOptions.map(([value, label]) => (
                  <option key={value} value={value}>
                    {label}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="label">From</label>
                <input
                  type="date"
                  value={dateFrom}
                  onChange={(e) => {
                    setDateFrom(e.target.value);
                    setPage(1);
                  }}
                  className="input"
                />
              </div>
              <div>
                <label className="label">To</label>
                <input
                  type="date"
                  value={dateTo}
                  onChange={(e) => {
                    setDateTo(e.target.value);
                    setPage(1);
                  }}
                  className="input"
                />
              </div>
            </div>
          </div>
        </div>
      ) : (
        <div className="card p-4 mb-6 text-sm text-muted-foreground flex items-center gap-2">
          <Calendar className="w-4 h-4 text-muted-foreground" />
          Showing recent activity on your documents (last 30 days). Use the Dashboard for a quick overview.
        </div>
      )}

      {/* Audit Table / Simple Feed for non-admin users */}
      {user?.has_admin_access ? (
        <div className="card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-border bg-muted/40">
                  <th className="text-left px-6 py-3.5 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Event</th>
                  <th className="text-left px-6 py-3.5 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Actor</th>
                  <th className="text-left px-6 py-3.5 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Object</th>
                  <th className="text-left px-6 py-3.5 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">IP Address</th>
                  <th className="text-left px-6 py-3.5 font-semibold text-[11px] uppercase tracking-wider text-muted-foreground">Timestamp</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {isLoading &&
                  Array.from({ length: 8 }).map((_, i) => (
                    <tr key={i}>
                      {Array.from({ length: 5 }).map((_, j) => (
                        <td key={j} className="px-6 py-4">
                          <div className="h-4 bg-muted rounded animate-pulse" />
                        </td>
                      ))}
                    </tr>
                  ))}

                {data?.results?.map(
                  (log: {
                    id: string;
                    event: string;
                    summary?: string;
                    actor_name?: string;
                    actor_email?: string;
                    object_type?: string;
                    object_repr?: string;
                    ip_address?: string;
                    timestamp: string;
                  }) => (
                    <tr key={log.id} className="hover:bg-muted/30 transition-colors">
                      <td className="px-6 py-4 align-top">
                        <span
                          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${eventColor(log.event)}`}
                        >
                          <span className={`w-1.5 h-1.5 rounded-full ${eventDot(log.event)}`} />
                          {humanizeEvent(log.event)}
                        </span>
                      </td>
                      <td className="px-6 py-4 align-top">
                        <div className="flex items-center gap-2.5">
                          <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0">
                            <User className="w-3.5 h-3.5 text-muted-foreground" />
                          </div>
                          <div className="min-w-0">
                            <div className="text-foreground font-medium truncate">
                              {log.actor_name || log.actor_email || "System"}
                            </div>
                            {log.actor_name && log.actor_email && (
                              <div className="text-xs text-muted-foreground truncate">
                                {log.actor_email}
                              </div>
                            )}
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-4 align-top text-muted-foreground max-w-md">
                        {log.summary && (
                          <div className="mb-1 text-foreground leading-snug">{log.summary}</div>
                        )}
                        <div className="flex items-center gap-2 flex-wrap">
                          {log.object_type && (
                            <span className="font-mono text-[11px] bg-muted px-1.5 py-0.5 rounded text-foreground">
                              {log.object_type}
                            </span>
                          )}
                          {log.object_repr && (
                            <span className="text-xs text-muted-foreground truncate">
                              {log.object_repr}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-6 py-4 align-top font-mono text-xs text-muted-foreground">
                        {log.ip_address || "—"}
                      </td>
                      <td className="px-6 py-4 align-top text-muted-foreground text-xs whitespace-nowrap">
                        <div className="flex items-center gap-2">
                          <Clock className="w-3.5 h-3.5" />
                          <div>
                            <div className="text-foreground">
                              {format(new Date(log.timestamp), "dd MMM yyyy")}
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {format(new Date(log.timestamp), "HH:mm:ss")}
                            </div>
                          </div>
                        </div>
                      </td>
                    </tr>
                  ),
                )}

                {!isLoading && !data?.results?.length && (
                  <tr>
                    <td colSpan={5} className="py-20 text-center">
                      <div className="w-14 h-14 rounded-2xl bg-muted/60 mx-auto mb-4 flex items-center justify-center">
                        <ShieldCheck className="w-6 h-6 text-muted-foreground" />
                      </div>
                      <p className="text-foreground font-medium mb-1">No audit events found</p>
                      <p className="text-sm text-muted-foreground">
                        Try adjusting your filters or expanding the date range.
                      </p>
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-muted/30">
              <p className="text-sm text-muted-foreground">
                Page <span className="font-medium text-foreground">{page}</span> of{" "}
                <span className="font-medium text-foreground">{totalPages}</span>
                <span className="mx-2">·</span>
                <span className="font-medium text-foreground">{data?.count ?? 0}</span> total events
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="btn-secondary px-4 py-2 disabled:opacity-50 flex items-center gap-1"
                >
                  <ChevronLeft className="w-4 h-4" /> Previous
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="btn-secondary px-4 py-2 disabled:opacity-50 flex items-center gap-1"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      ) : (
        <div className="space-y-6">
          {isLoading && (
            <div className="card p-4 space-y-3">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="flex items-center gap-3">
                  <div className="w-9 h-9 rounded-full bg-muted animate-pulse shrink-0" />
                  <div className="flex-1 space-y-2">
                    <div className="h-4 bg-muted rounded animate-pulse w-3/4" />
                    <div className="h-3 bg-muted rounded animate-pulse w-1/3" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {!isLoading &&
            Object.entries(groupedFeed).map(([day, items]) => (
              <div key={day}>
                <div className="flex items-center gap-3 mb-3 px-1">
                  <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                    {day}
                  </h3>
                  <div className="flex-1 h-px bg-border" />
                  <span className="text-[11px] text-muted-foreground">
                    {items.length} {items.length === 1 ? "activity" : "activities"}
                  </span>
                </div>
                <div className="card overflow-hidden">
                  <ul className="divide-y divide-border">
                    {items.map((log: any) => (
                      <li
                        key={log.id}
                        className="p-4 hover:bg-muted/30 transition-colors flex items-start gap-3"
                      >
                        <div
                          className={`w-9 h-9 rounded-full flex items-center justify-center shrink-0 ${eventColor(
                            log.event || "",
                          )}`}
                        >
                          <FileText className="w-4 h-4" />
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="text-sm text-foreground leading-snug">
                            {log.summary || humanizeEvent(log.event || "Activity")}
                          </div>
                          <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-1.5">
                            <Clock className="w-3 h-3" />
                            {formatDistanceToNow(new Date(log.timestamp), { addSuffix: true })}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground font-mono whitespace-nowrap">
                          {format(new Date(log.timestamp), "HH:mm")}
                        </div>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ))}

          {!isLoading && !data?.results?.length && (
            <div className="card py-20 text-center">
              <div className="w-14 h-14 rounded-2xl bg-muted/60 mx-auto mb-4 flex items-center justify-center">
                <ShieldCheck className="w-6 h-6 text-muted-foreground" />
              </div>
              <p className="text-foreground font-medium mb-1">No recent activity</p>
              <p className="text-sm text-muted-foreground">
                Actions on your documents will appear here.
              </p>
            </div>
          )}

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="card flex items-center justify-between px-6 py-4">
              <p className="text-sm text-muted-foreground">
                Page <span className="font-medium text-foreground">{page}</span> of{" "}
                <span className="font-medium text-foreground">{totalPages}</span>
                <span className="mx-2">·</span>
                <span className="font-medium text-foreground">{data?.count ?? 0}</span> total
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  disabled={page === 1}
                  className="btn-secondary px-4 py-2 disabled:opacity-50 flex items-center gap-1"
                >
                  <ChevronLeft className="w-4 h-4" /> Previous
                </button>
                <button
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  disabled={page === totalPages}
                  className="btn-secondary px-4 py-2 disabled:opacity-50 flex items-center gap-1"
                >
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}