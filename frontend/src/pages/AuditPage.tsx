import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { ShieldCheck, Filter } from "lucide-react";
import { format } from "date-fns";

export default function AuditPage() {
  const [eventFilter, setEventFilter] = useState("");

  const { data, isLoading } = useQuery({
    queryKey: ["audit-logs", eventFilter],
    queryFn: () =>
      api
        .get("/audit/", { params: { event: eventFilter || undefined, page_size: 50 } })
        .then((r) => r.data),
  });

  const eventColor = (event: string) => {
    if (event.includes("deleted") || event.includes("rejected")) return "text-red-600 bg-red-50";
    if (event.includes("approved") || event.includes("created")) return "text-green-600 bg-green-50";
    if (event.includes("login")) return "text-blue-600 bg-blue-50";
    return "text-gray-600 bg-gray-50";
  };

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Audit trail</h1>
        <p className="text-gray-500 text-sm mt-1">
          Immutable record of all system events.
        </p>
      </div>

      <div className="flex gap-3">
        <div className="w-64">
          <select
            value={eventFilter}
            onChange={(e) => setEventFilter(e.target.value)}
            className="input text-sm"
          >
            <option value="">All events</option>
            <option value="document.created">Document created</option>
            <option value="document.viewed">Document viewed</option>
            <option value="document.downloaded">Document downloaded</option>
            <option value="document.deleted">Document deleted</option>
            <option value="workflow.approved">Workflow approved</option>
            <option value="workflow.rejected">Workflow rejected</option>
            <option value="user.login">User login</option>
            <option value="user.login_failed">Login failed</option>
          </select>
        </div>
      </div>

      <div className="card overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-100 bg-gray-50">
              <th className="text-left px-4 py-3 font-medium text-gray-500">Event</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Actor</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Object</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">IP address</th>
              <th className="text-left px-4 py-3 font-medium text-gray-500">Timestamp</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {isLoading &&
              Array.from({ length: 8 }).map((_, i) => (
                <tr key={i}>
                  {Array.from({ length: 5 }).map((_, j) => (
                    <td key={j} className="px-4 py-3">
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
              <tr key={log.id} className="hover:bg-gray-50">
                <td className="px-4 py-3">
                  <span className={`badge text-[11px] ${eventColor(log.event)}`}>
                    {log.event}
                  </span>
                </td>
                <td className="px-4 py-3 text-gray-700">{log.actor_email || "—"}</td>
                <td className="px-4 py-3 text-gray-500">
                  {log.object_type && <span className="font-mono text-xs">{log.object_type}</span>}
                  {log.object_repr && <span className="ml-1 text-gray-400">· {log.object_repr}</span>}
                </td>
                <td className="px-4 py-3 text-gray-500 font-mono text-xs">{log.ip_address || "—"}</td>
                <td className="px-4 py-3 text-gray-500 text-xs whitespace-nowrap">
                  {format(new Date(log.timestamp), "dd MMM yyyy HH:mm:ss")}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {!isLoading && !data?.results?.length && (
          <div className="py-10 text-center text-gray-400">
            <ShieldCheck className="w-8 h-8 mx-auto mb-2 opacity-30" />
            No audit events found.
          </div>
        )}
      </div>
    </div>
  );
}
