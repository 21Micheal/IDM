import { useState, useEffect } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { ShieldCheck, Filter, Clock, User, Download, ChevronLeft, ChevronRight, Search } from "lucide-react";
import { format, subDays } from "date-fns";
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

  const { data, isLoading } = useQuery({
    queryKey: ["audit-logs", searchTerm, eventFilter, dateFrom, dateTo, page],
    queryFn: () =>
      api
        .get("/audit/", {
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
      return "bg-destructive/10 text-destructive";
    if (event.includes("approved") || event.includes("created") || event.includes("completed") || event.includes("success"))
      return "bg-teal/15 text-teal";
    if (event.includes("login") || event.includes("viewed") || event.includes("previewed") || event.includes("downloaded") || event.includes("exported"))
      return "bg-accent/15 text-accent";
    if (event.includes("workflow") || event.includes("submitted") || event.includes("queued"))
      return "bg-primary/10 text-primary";
    return "bg-muted text-muted-foreground";
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

  return (
    <div className="max-w-7xl mx-auto py-10 px-6">
      {/* Header */}
      <div className="flex items-end justify-between mb-10">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-primary" />
            </div>
            <h1 className="text-3xl font-bold text-foreground tracking-tight">Audit Trail</h1>
          </div>
          <p className="text-muted-foreground text-sm">
            Immutable record of all system activities and changes
          </p>
        </div>

        <button onClick={exportAudit} className="btn-secondary flex items-center gap-2">
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      {/* Filters */}
      <div className="card p-6 mb-8">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Filter className="w-4 h-4" />
            <span className="font-medium">Filters</span>
          </div>
          <button
            onClick={resetFilters}
            className="text-xs text-muted-foreground hover:text-foreground underline"
          >
            Clear all
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          <div className="lg:col-span-2">
            <label className="label flex items-center gap-2">
              <Search className="w-4 h-4" /> Search
            </label>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              placeholder="Actor email, object name, or event..."
              className="input"
            />
          </div>

          <div>
            <label className="label">Event Type</label>
            <select
              value={eventFilter}
              onChange={(e) => setEventFilter(e.target.value)}
              className="input"
            >
              <option value="">All Events</option>
              {eventOptions.map(([value, label]) => (
                <option key={value} value={value}>{label}</option>
              ))}
            </select>
          </div>

          <div>
            <label className="label">From Date</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="input"
            />
          </div>

          <div>
            <label className="label">To Date</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="input"
            />
          </div>
        </div>
      </div>

      {/* Audit Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Event</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Actor</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Object</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">IP Address</th>
                <th className="text-left px-6 py-4 font-semibold text-xs uppercase tracking-wider text-muted-foreground">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {isLoading && Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 5 }).map((_, j) => (
                    <td key={j} className="px-6 py-4">
                      <div className="h-4 bg-muted rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))}

              {data?.results?.map((log: { id: string; event: string; summary?: string; actor_name?: string; actor_email?: string; object_type?: string; object_repr?: string; ip_address?: string; timestamp: string }) => (
                <tr key={log.id} className="hover:bg-muted/40 transition-colors">
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium ${eventColor(log.event)}`}>
                      {log.event}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-muted-foreground" />
                      <span className="text-foreground font-medium">{log.actor_name || log.actor_email || "System"}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-muted-foreground">
                    {log.summary && <div className="mb-1 text-foreground">{log.summary}</div>}
                    {log.object_type && (
                      <span className="font-mono text-xs bg-muted px-2 py-0.5 rounded text-foreground">
                        {log.object_type}
                      </span>
                    )}
                    {log.object_repr && <span className="ml-2 text-muted-foreground">· {log.object_repr}</span>}
                  </td>
                  <td className="px-6 py-4 font-mono text-xs text-muted-foreground">
                    {log.ip_address || "—"}
                  </td>
                  <td className="px-6 py-4 text-muted-foreground text-xs whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-muted-foreground" />
                      {format(new Date(log.timestamp), "dd MMM yyyy • HH:mm:ss")}
                    </div>
                  </td>
                </tr>
              ))}

              {!isLoading && !data?.results?.length && (
                <tr>
                  <td colSpan={5} className="py-20 text-center">
                    <ShieldCheck className="w-12 h-12 text-muted mx-auto mb-4" />
                    <p className="text-muted-foreground">No audit events found for the selected filters.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-muted/40">
            <p className="text-sm text-muted-foreground">
              Showing page {page} of {totalPages} • {data?.count ?? 0} total events
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
    </div>
  );
}
