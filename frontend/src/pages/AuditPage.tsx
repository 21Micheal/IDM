import { useState, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import {
  ShieldCheck,
  Filter,
  Clock,
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
import CustomListbox from "@/components/ui/CustomListbox";
import { format, subDays, isToday, isYesterday, formatDistanceToNow } from "date-fns";
import { useAuthStore } from "@/store/authStore";
import { toast } from "@/components/ui/vault-toast";
import { QUERY_SHORT_STALE } from "@/lib/reactQueryDefaults";
import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";

// ─── Shared design tokens ─────────────────────────────────────────────────────
const inputCls =
  "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

const labelCls = "mb-1.5 block text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]";

// ─── Event colour helpers (portal flat palette) ───────────────────────────────
type EventMeta = { dot: string; chip: string; label: string };

function eventMeta(event: string): EventMeta {
  const e = event || "";
  if (e.includes("rejected") || e.includes("deleted") || e.includes("failed") || e.includes("declined") || e.includes("cancelled"))
    return { dot: "bg-red-500",     chip: "border-red-200 bg-red-50 text-red-700",         label: humanize(e) };
  if (e.includes("approved") || e.includes("completed") || e.includes("restored") || e.includes("released") || e.includes("signed"))
    return { dot: "bg-emerald-500", chip: "border-emerald-200 bg-emerald-50 text-emerald-700", label: humanize(e) };
  if (e.includes("submitted") || e.includes("created") || e.includes("request_created"))
    return { dot: "bg-[#287EAD]",   chip: "border-[#A7CDE3] bg-[#EEF6FB] text-[#287EAD]",  label: humanize(e) };
  if (e.includes("workflow") || e.includes("held") || e.includes("returned") || e.includes("delegated") || e.includes("reassigned"))
    return { dot: "bg-orange-400",  chip: "border-orange-200 bg-orange-50 text-orange-700", label: humanize(e) };
  if (e.includes("downloaded") || e.includes("exported") || e.includes("printed"))
    return { dot: "bg-violet-500",  chip: "border-violet-200 bg-violet-50 text-violet-700", label: humanize(e) };
  if (e.includes("login") || e.includes("mfa") || e.includes("permission") || e.includes("group"))
    return { dot: "bg-sky-500",     chip: "border-sky-200 bg-sky-50 text-sky-700",          label: humanize(e) };
  return   { dot: "bg-[#9AA5B1]",  chip: "border-[#C8CDD2] bg-[#F5F7F8] text-[#5E6870]",  label: humanize(e) };
}

function humanize(event: string): string {
  return event.split(/[._]/).map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join(" ");
}

function actorInitials(name: string): string {
  if (!name || name === "System") return "SY";
  return name.split(" ").map((p) => p[0]).slice(0, 2).join("").toUpperCase() || "?";
}

// ─── Subcomponents ────────────────────────────────────────────────────────────
function EventChip({ event }: { event: string }) {
  const m = eventMeta(event);
  return (
    <span className={`inline-flex items-center gap-1.5 border px-2 py-0.5 text-[10px] font-bold uppercase tracking-wider ${m.chip}`}>
      <span className={`h-1.5 w-1.5 rounded-full ${m.dot}`} />
      {m.label}
    </span>
  );
}

function ActorCell({ log }: { log: any }) {
  const name = log.actor_name || log.actor_email || "System";
  return (
    <div className="flex items-center gap-2.5">
      <div className="flex h-8 w-8 shrink-0 items-center justify-center border border-[#A7CDE3] bg-[#EEF6FB] text-[10px] font-bold text-[#287EAD]">
        {actorInitials(name)}
      </div>
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-[#1F2933]">{name}</div>
        {log.actor_name && log.actor_email && (
          <div className="truncate text-xs text-[#5E6870]">{log.actor_email}</div>
        )}
        {log.actor_job_description && (
          <div className="truncate text-xs text-[#9AA5B1]">{log.actor_job_description}</div>
        )}
      </div>
    </div>
  );
}

function formatGroupPermissionSummary(changes: any): string | null {
  if (!changes) return null;
  const granted = typeof changes.granted_count === "number" ? changes.granted_count : 0;
  const revoked = typeof changes.revoked_count === "number" ? changes.revoked_count : 0;
  const total   = typeof changes.total_permissions === "number" ? changes.total_permissions : 0;
  if (granted > 0 && revoked > 0) return `${granted} granted, ${revoked} revoked (${total} total)`;
  if (granted > 0) return `${granted} permission${granted === 1 ? "" : "s"} granted (${total} total)`;
  if (revoked > 0) return `${revoked} permission${revoked === 1 ? "" : "s"} revoked (${total} total)`;
  return `${total} total permissions`;
}

function formatGroupPermissionDetailedChanges(changes: any): string | null {
  if (!changes) return null;
  const granted = Array.isArray(changes.granted_details) ? changes.granted_details : [];
  const revoked = Array.isArray(changes.revoked_details) ? changes.revoked_details : [];
  if (!granted.length && !revoked.length) return null;
  const parts: string[] = [];
  for (const d of granted) {
    const action = String(d.action || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    const doc    = d.document_type_name ? ` for ${d.document_type_name}` : "";
    const stage  = d.stage && d.stage !== "any" ? ` in ${d.stage} stage` : "";
    parts.push(`Granted ${action}${doc}${stage}`);
  }
  for (const d of revoked) {
    const action = String(d.action || "").replace(/_/g, " ").replace(/\b\w/g, (c: string) => c.toUpperCase());
    const doc    = d.document_type_name ? ` for ${d.document_type_name}` : "";
    const stage  = d.stage && d.stage !== "any" ? ` in ${d.stage} stage` : "";
    parts.push(`Revoked ${action}${doc}${stage}`);
  }
  return parts.join(", ") || null;
}

// ─── Main page ────────────────────────────────────────────────────────────────
export default function AuditPage() {
  const [searchTerm,  setSearchTerm]  = useState("");
  const [eventFilter, setEventFilter] = useState("");
  const [dateFrom,    setDateFrom]    = useState(format(subDays(new Date(), 30), "yyyy-MM-dd"));
  const [dateTo,      setDateTo]      = useState(format(new Date(), "yyyy-MM-dd"));
  const [page,        setPage]        = useState(1);

  const PAGE_SIZE = 10;
  const eventOptions = [
    ["document.created",                "Document Created"],
    ["document.bulk_uploaded",          "Bulk Uploaded"],
    ["document.bulk_reviewed",          "Bulk Upload Reviewed"],
    ["document.viewed",                 "Document Viewed"],
    ["document.previewed",              "Document Previewed"],
    ["document.downloaded",             "Document Downloaded"],
    ["document.printed",                "Document Printed"],
    ["document.updated",                "Document Updated"],
    ["document.deleted",                "Document Deleted"],
    ["document.archived",               "Document Archived"],
    ["document.submitted",              "Document Submitted"],
    ["document.version_uploaded",       "Version Uploaded"],
    ["document.version_restored",       "Version Restored"],
    ["document.preview_queued",         "Preview Queued"],
    ["document.version_preview_queued", "Version Preview Queued"],
    ["document.ocr_queued",             "OCR Queued"],
    ["document.ocr_completed",          "OCR Completed"],
    ["document.ocr_failed",             "OCR Failed"],
    ["document.edit_lock_acquired",     "Edit Lock Acquired"],
    ["document.edit_lock_released",     "Edit Lock Released"],
    ["workflow.approved",               "Workflow Approved"],
    ["workflow.rejected",               "Workflow Rejected"],
    ["workflow.returned",               "Workflow Returned"],
    ["workflow.held",                   "Workflow Held"],
    ["workflow.released",               "Workflow Released"],
    ["workflow.cancelled",              "Workflow Cancelled"],
    ["workflow.delegated",              "Workflow Delegated"],
    ["workflow.reassigned",             "Workflow Reassigned"],
    ["user.login",                      "User Login"],
    ["user.login_failed",               "Login Failed"],
    ["user.mfa_enabled",                "MFA Enabled"],
    ["permission.changed",              "Permission Changed"],
    ["group.permission_updated",        "Group Permissions Updated"],
    ["signature.request_created",       "Signature Request Created"],
    ["signature.request_signed",        "Signature Request Signed"],
    ["signature.request_completed",     "Signature Request Completed"],
    ["signature.request_declined",      "Signature Request Declined"],
    ["signature.request_cancelled",     "Signature Request Cancelled"],
    ["audit.exported",                  "Audit Exported"],
  ] as const;

  const user = useAuthStore((s) => s.user);
  const listEndpoint = user?.has_admin_access ? "/audit/" : "/audit/my-activity/";

  const { data, isLoading } = useQuery({
    queryKey: ["audit-logs", listEndpoint, searchTerm, eventFilter, dateFrom, dateTo, page],
    queryFn: () =>
      api.get(listEndpoint, {
        params: {
          search:    searchTerm   || undefined,
          event:     eventFilter  || undefined,
          date_from: dateFrom     || undefined,
          date_to:   dateTo       || undefined,
          page,
          page_size: PAGE_SIZE,
          ordering:  "-timestamp",
        },
      }).then((r) => r.data),
    ...QUERY_SHORT_STALE,
  });

  const exportAudit = async () => {
    try {
      const response = await api.get("/audit/export/", {
        params: { search: searchTerm || undefined, event: eventFilter || undefined, date_from: dateFrom || undefined, date_to: dateTo || undefined },
        responseType: "blob",
      });
      const url  = window.URL.createObjectURL(new Blob([response.data]));
      const link = document.createElement("a");
      link.href  = url;
      link.setAttribute("download", `audit-trail-${format(new Date(), "yyyy-MM-dd")}.csv`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
      toast.success("Audit log exported successfully");
    } catch {
      toast.error("Failed to export audit log");
    }
  };

  const resetFilters = () => {
    setSearchTerm(""); setEventFilter("");
    setDateFrom(format(subDays(new Date(), 30), "yyyy-MM-dd"));
    setDateTo(format(new Date(), "yyyy-MM-dd"));
    setPage(1);
  };

  const totalPages = Math.ceil((data?.count ?? 0) / PAGE_SIZE);

  const activeFilterCount = [
    searchTerm,
    eventFilter,
    dateFrom !== format(subDays(new Date(), 30), "yyyy-MM-dd") ? dateFrom : "",
    dateTo   !== format(new Date(), "yyyy-MM-dd")              ? dateTo   : "",
  ].filter(Boolean).length;

  // Non-admin grouped feed
  const groupedFeed = useMemo(() => {
    const groups: Record<string, any[]> = {};
    (data?.results ?? []).forEach((log: any) => {
      const d   = new Date(log.timestamp);
      const key = isToday(d) ? "Today" : isYesterday(d) ? "Yesterday" : format(d, "EEEE, dd MMM yyyy");
      (groups[key] ||= []).push(log);
    });
    return groups;
  }, [data]);

  // ── Pagination bar ───────────────────────────────────────────────────────────
  const PaginationBar = ({ className = "" }: { className?: string }) =>
    totalPages > 1 ? (
      <div className={`flex items-center justify-between border-t border-[#C8CDD2] bg-[#F5F7F8] px-5 py-3 ${className}`}>
        <p className="text-xs text-[#5E6870]">
          Page <span className="font-semibold text-[#1F2933]">{page}</span> of{" "}
          <span className="font-semibold text-[#1F2933]">{totalPages}</span>
          <span className="mx-2 text-[#C8CDD2]">·</span>
          <span className="font-semibold text-[#1F2933]">{(data?.count ?? 0).toLocaleString()}</span> total events
        </p>
        <div className="flex gap-1">
          <button
            onClick={() => setPage((p) => Math.max(1, p - 1))}
            disabled={page === 1}
            className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#EEF6FB] disabled:opacity-40"
          >
            <ChevronLeft className="h-3.5 w-3.5" /> Prev
          </button>
          <button
            onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            disabled={page >= totalPages}
            className="inline-flex items-center gap-1 border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#EEF6FB] disabled:opacity-40"
          >
            Next <ChevronRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
    ) : null;

  return (
    <div className="flex h-full flex-col bg-[#EDEDED] text-[#1F2933]">
      {/* ── Command bar ─────────────────────────────────────────────────────── */}
      <WorkspaceCommandBar
        actions={
          user?.has_admin_access ? (
            <button
              onClick={exportAudit}
              className="flex items-center gap-2 border border-white/40 bg-white px-3 py-2 text-sm font-semibold text-[#287EAD] hover:bg-[#EEF6FB]"
            >
              <Download className="h-4 w-4" /> Export CSV
            </button>
          ) : null
        }
      >
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <ShieldCheck className="h-5 w-5" />
            <div className="flex min-w-0 items-center gap-2">
              <h1 className="truncate text-lg font-semibold tracking-tight">
                {user?.has_admin_access ? "Audit Trail" : "Document Activity"}
              </h1>
              <span title={user?.has_admin_access ? "Full system audit log for administrators." : "Recent actions on documents you own."}>
                <Info className="h-4 w-4 text-white/75" />
              </span>
            </div>
            {!isLoading && data?.count !== undefined && (
              <span className="ml-1 inline-flex items-center gap-1.5 border border-white/30 px-2.5 py-1 text-xs font-medium text-white/85">
                <Activity className="h-3 w-3" />
                {data.count.toLocaleString()} {data.count === 1 ? "event" : "events"}
              </span>
            )}
          </div>
          <p className="mt-0.5 max-w-2xl text-xs text-white/75">
            {user?.has_admin_access
              ? "Immutable record of all system activities and changes."
              : "A simple feed of recent actions on your documents — approvals, views, and uploads."}
          </p>
        </div>
      </WorkspaceCommandBar>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        {/* ── Admin view ────────────────────────────────────────────────────── */}
        {user?.has_admin_access ? (
          <>
            {/* Filters */}
            <div className="mb-4 border border-[#C8CDD2] bg-white p-4">
              <div className="mb-4 flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Filter className="h-4 w-4 text-[#5E6870]" />
                  <span className="text-sm font-semibold text-[#1F2933]">Filters</span>
                  {activeFilterCount > 0 && (
                    <span className="bg-[#EEF6FB] px-2 py-0.5 text-xs font-semibold text-[#287EAD]">
                      {activeFilterCount} active
                    </span>
                  )}
                </div>
                {activeFilterCount > 0 && (
                  <button onClick={resetFilters} className="inline-flex items-center gap-1 text-xs text-[#5E6870] hover:text-[#1F2933]">
                    <X className="h-3 w-3" /> Clear all
                  </button>
                )}
              </div>

              <div className="grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-4">
                <div>
                  <label className={labelCls}>
                    <span className="flex items-center gap-1"><Search className="h-3 w-3" /> Search</span>
                  </label>
                  <input
                    type="text"
                    value={searchTerm}
                    onChange={(e) => { setSearchTerm(e.target.value); setPage(1); }}
                    placeholder="Actor, object, or event…"
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Event type</label>
                  <CustomListbox
                    value={eventFilter}
                    onChange={(v) => { setEventFilter(v); setPage(1); }}
                    options={[{ value: "", label: "All Events" }, ...eventOptions.map(([value, label]) => ({ value, label }))]}
                    buttonClassName={inputCls}
                    ariaLabel="Event type filter"
                  />
                </div>
                <div>
                  <label className={labelCls}>From</label>
                  <input type="date" value={dateFrom} onChange={(e) => { setDateFrom(e.target.value); setPage(1); }} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>To</label>
                  <input type="date" value={dateTo}   onChange={(e) => { setDateTo(e.target.value);   setPage(1); }} className={inputCls} />
                </div>
              </div>
            </div>

            {/* Table */}
            <div className="overflow-hidden border border-[#C8CDD2] bg-white">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-[#C8CDD2] bg-[#F5F7F8]">
                      {["Event", "Actor", "Details", "IP Address", "Timestamp"].map((h) => (
                        <th key={h} className="px-5 py-3 text-left text-[11px] font-bold uppercase tracking-wider text-[#5E6870]">
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-[#EEF1F4]">
                    {/* Loading skeleton */}
                    {isLoading && Array.from({ length: 8 }).map((_, i) => (
                      <tr key={i}>
                        {Array.from({ length: 5 }).map((_, j) => (
                          <td key={j} className="px-5 py-4">
                            <div className="h-4 animate-pulse rounded bg-[#F0F2F4]" />
                          </td>
                        ))}
                      </tr>
                    ))}

                    {/* Data rows */}
                    {data?.results?.map((log: any) => (
                      <tr key={log.id} className="transition-colors hover:bg-[#F8FAFB]">
                        {/* Event */}
                        <td className="px-5 py-3.5 align-top">
                          <EventChip event={log.event} />
                        </td>
                        {/* Actor */}
                        <td className="px-5 py-3.5 align-top">
                          <ActorCell log={log} />
                        </td>
                        {/* Details / object */}
                        <td className="max-w-sm px-5 py-3.5 align-top">
                          {log.summary && (
                            <p className="mb-1 text-sm leading-snug text-[#1F2933]">{log.summary}</p>
                          )}
                          {log.event === "group.permission_updated" && log.changes && (
                            <p className="mb-1 text-xs text-[#5E6870]">
                              {formatGroupPermissionDetailedChanges(log.changes) || formatGroupPermissionSummary(log.changes)}
                            </p>
                          )}
                          {(log.object_type || log.object_repr) && (
                            <div className="flex flex-wrap items-center gap-1.5">
                              {log.object_type && (
                                <span className="border border-[#C8CDD2] bg-[#F5F7F8] px-1.5 py-0.5 font-mono text-[11px] text-[#1F2933]">
                                  {log.object_type}
                                </span>
                              )}
                              {log.object_repr && (
                                <span className="max-w-[200px] truncate text-xs text-[#5E6870]">{log.object_repr}</span>
                              )}
                            </div>
                          )}
                        </td>
                        {/* IP */}
                        <td className="px-5 py-3.5 align-top font-mono text-xs text-[#5E6870]">
                          {log.ip_address || <span className="text-[#C8CDD2]">—</span>}
                        </td>
                        {/* Timestamp */}
                        <td className="whitespace-nowrap px-5 py-3.5 align-top text-xs">
                          <div className="flex items-center gap-2 text-[#5E6870]">
                            <Clock className="h-3.5 w-3.5 shrink-0" />
                            <div>
                              <div className="font-medium text-[#1F2933]">{format(new Date(log.timestamp), "dd MMM yyyy")}</div>
                              <div className="text-[11px]">{format(new Date(log.timestamp), "HH:mm:ss")}</div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    ))}

                    {/* Empty */}
                    {!isLoading && !data?.results?.length && (
                      <tr>
                        <td colSpan={5} className="py-20 text-center">
                          <ShieldCheck className="mx-auto mb-3 h-10 w-10 text-[#C8CDD2]" />
                          <p className="text-sm font-semibold text-[#1F2933]">No audit events found</p>
                          <p className="mt-1 text-xs text-[#5E6870]">Try adjusting your filters or expanding the date range.</p>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <PaginationBar />
            </div>
          </>
        ) : (
          /* ── Non-admin activity feed ──────────────────────────────────────── */
          <div className="space-y-5">
            <div className="flex items-center gap-2 border border-[#C8CDD2] bg-white p-4 text-sm text-[#5E6870]">
              <Calendar className="h-4 w-4 shrink-0 text-[#287EAD]" />
              Showing recent activity on your documents (last 30 days).
            </div>

            {/* Loading skeleton */}
            {isLoading && (
              <div className="divide-y divide-[#EEF1F4] border border-[#C8CDD2] bg-white">
                {Array.from({ length: 6 }).map((_, i) => (
                  <div key={i} className="flex items-center gap-3 p-4">
                    <div className="h-9 w-9 animate-pulse bg-[#F0F2F4]" />
                    <div className="flex-1 space-y-2">
                      <div className="h-4 w-3/4 animate-pulse rounded bg-[#F0F2F4]" />
                      <div className="h-3 w-1/3 animate-pulse rounded bg-[#F0F2F4]" />
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Grouped by day */}
            {!isLoading && Object.entries(groupedFeed).map(([day, items]) => (
              <div key={day}>
                <div className="mb-2 flex items-center gap-3 px-1">
                  <h3 className="text-[10px] font-bold uppercase tracking-wider text-[#5E6870]">{day}</h3>
                  <div className="h-px flex-1 bg-[#C8CDD2]" />
                  <span className="text-[11px] text-[#9AA5B1]">{items.length} {items.length === 1 ? "activity" : "activities"}</span>
                </div>
                <div className="overflow-hidden border border-[#C8CDD2] bg-white">
                  <ul className="divide-y divide-[#EEF1F4]">
                    {items.map((log: any) => {
                      const m = eventMeta(log.event || "");
                      return (
                        <li key={log.id} className="flex items-start gap-3 p-4 transition-colors hover:bg-[#F8FAFB]">
                          <div className={`flex h-9 w-9 shrink-0 items-center justify-center border ${m.chip}`}>
                            <FileText className="h-4 w-4" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-sm leading-snug text-[#1F2933]">
                              {log.summary || humanize(log.event || "Activity")}
                            </p>
                            {log.event === "group.permission_updated" && log.changes && (
                              <p className="mt-0.5 text-xs text-[#5E6870]">
                                {formatGroupPermissionDetailedChanges(log.changes) || formatGroupPermissionSummary(log.changes)}
                              </p>
                            )}
                            <div className="mt-1 flex items-center gap-1.5 text-xs text-[#9AA5B1]">
                              <Clock className="h-3 w-3" />
                              {formatDistanceToNow(new Date(log.timestamp), { addSuffix: true })}
                            </div>
                          </div>
                          <span className="shrink-0 font-mono text-xs text-[#9AA5B1]">
                            {format(new Date(log.timestamp), "HH:mm")}
                          </span>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </div>
            ))}

            {/* Empty */}
            {!isLoading && !data?.results?.length && (
              <div className="flex flex-col items-center justify-center border border-[#C8CDD2] bg-white py-20 text-center">
                <ShieldCheck className="mb-3 h-10 w-10 text-[#C8CDD2]" />
                <p className="text-sm font-semibold text-[#1F2933]">No recent activity</p>
                <p className="mt-1 text-xs text-[#5E6870]">Actions on your documents will appear here.</p>
              </div>
            )}

            <PaginationBar />
          </div>
        )}
      </div>
    </div>
  );
}
