import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { ShieldCheck, Filter, Clock, User, Download, ChevronLeft, ChevronRight, Calendar, Search } from "lucide-react";
import { format, subDays } from "date-fns";
import { toast } from "react-toastify";

export default function AuditPage() {
  const [searchTerm, setSearchTerm] = useState("");        // Advanced search (actor, object, event)
  const [eventFilter, setEventFilter] = useState("");
  const [dateFrom, setDateFrom] = useState(format(subDays(new Date(), 30), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(format(new Date(), "yyyy-MM-dd"));
  const [page, setPage] = useState(1);

  const PAGE_SIZE = 50;

  const { data, isLoading } = useQuery({
    queryKey: ["audit-logs", searchTerm, eventFilter, dateFrom, dateTo, page],
    queryFn: () =>
      api
        .get("/audit/", { 
          params: { 
            search: searchTerm || undefined,           // Advanced search
            event: eventFilter || undefined,
            date_from: dateFrom || undefined,
            date_to: dateTo || undefined,
            page,
            page_size: PAGE_SIZE,
            ordering: "-timestamp"
          } 
        })
        .then((r) => r.data),
  });

  const eventColor = (event: string) => {
    if (event.includes("deleted") || event.includes("rejected") || event.includes("failed")) 
      return "bg-red-100 text-red-700";
    if (event.includes("approved") || event.includes("created") || event.includes("success")) 
      return "bg-green-100 text-green-700";
    if (event.includes("login") || event.includes("viewed") || event.includes("downloaded")) 
      return "bg-blue-100 text-blue-700";
    return "bg-gray-100 text-gray-600";
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
    <div className="max-w-6xl mx-auto py-10 px-6">
      {/* Header */}
      <div className="flex items-end justify-between mb-10">
        <div>
          <h1 className="text-4xl font-bold text-gray-900">Audit Trail</h1>
          <p className="text-gray-500 mt-2 text-lg">
            Immutable record of all system activities and changes
          </p>
        </div>

        <button
          onClick={exportAudit}
          className="btn-secondary flex items-center gap-2"
        >
          <Download className="w-4 h-4" />
          Export CSV
        </button>
      </div>

      {/* Advanced Filters */}
      <div className="card p-6 mb-8">
        <div className="flex items-center justify-between mb-5">
          <div className="flex items-center gap-2 text-sm text-gray-500">
            <Filter className="w-4 h-4" />
            <span>Advanced Filters</span>
          </div>
          <button 
            onClick={resetFilters} 
            className="text-xs text-gray-500 hover:text-gray-700 underline"
          >
            Clear all filters
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-5">
          {/* Advanced Search */}
          <div className="lg:col-span-2">
            <label className="label flex items-center gap-2">
              <Search className="w-4 h-4" /> Advanced Search
            </label>
            <input
              type="text"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setPage(1);
              }}
              placeholder="Search actor email, object, or event..."
              className="input"
            />
            <p className="text-xs text-gray-400 mt-1">Searches across actor, object repr, and event name</p>
          </div>

          {/* Event Filter */}
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
              <option value="document.created">Document Created</option>
              <option value="document.viewed">Document Viewed</option>
              <option value="document.downloaded">Document Downloaded</option>
              <option value="document.deleted">Document Deleted</option>
              <option value="workflow.approved">Workflow Approved</option>
              <option value="workflow.rejected">Workflow Rejected</option>
              <option value="user.login">User Login</option>
              <option value="user.login_failed">Login Failed</option>
              <option value="user.created">User Created</option>
            </select>
          </div>

          {/* Date From */}
          <div>
            <label className="label">From Date</label>
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

          {/* Date To */}
          <div>
            <label className="label">To Date</label>
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

      {/* Audit Table */}
      <div className="card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-gray-100 bg-gray-50">
                <th className="text-left px-6 py-4 font-medium text-gray-500">Event</th>
                <th className="text-left px-6 py-4 font-medium text-gray-500">Actor</th>
                <th className="text-left px-6 py-4 font-medium text-gray-500">Object</th>
                <th className="text-left px-6 py-4 font-medium text-gray-500">IP Address</th>
                <th className="text-left px-6 py-4 font-medium text-gray-500">Timestamp</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {isLoading && Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 5 }).map((_, j) => (
                    <td key={j} className="px-6 py-4">
                      <div className="h-4 bg-gray-100 rounded animate-pulse" />
                    </td>
                  ))}
                </tr>
              ))}

              {data?.results?.map((log: {
                id: string;
                event: string;
                actor_email: string;
                object_type: string;
                object_repr: string;
                ip_address: string;
                timestamp: string;
              }) => (
                <tr key={log.id} className="hover:bg-gray-50 transition-colors">
                  <td className="px-6 py-4">
                    <span className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${eventColor(log.event)}`}>
                      {log.event}
                    </span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <User className="w-4 h-4 text-gray-400" />
                      <span className="text-gray-700 font-medium">{log.actor_email || "System"}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-gray-600">
                    {log.object_type && (
                      <span className="font-mono text-xs bg-gray-100 px-2 py-0.5 rounded">
                        {log.object_type}
                      </span>
                    )}
                    {log.object_repr && (
                      <span className="ml-2 text-gray-500">· {log.object_repr}</span>
                    )}
                  </td>
                  <td className="px-6 py-4 font-mono text-xs text-gray-500">
                    {log.ip_address || "—"}
                  </td>
                  <td className="px-6 py-4 text-gray-500 text-xs whitespace-nowrap">
                    <div className="flex items-center gap-2">
                      <Clock className="w-4 h-4 text-gray-400" />
                      {format(new Date(log.timestamp), "dd MMM yyyy • HH:mm:ss")}
                    </div>
                  </td>
                </tr>
              ))}

              {!isLoading && !data?.results?.length && (
                <tr>
                  <td colSpan={5} className="py-20 text-center">
                    <ShieldCheck className="w-12 h-12 text-gray-200 mx-auto mb-4" />
                    <p className="text-gray-500">No audit events found for the selected filters.</p>
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {totalPages > 1 && (
          <div className="flex items-center justify-between px-6 py-4 border-t border-gray-100 bg-gray-50">
            <p className="text-sm text-gray-500">
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