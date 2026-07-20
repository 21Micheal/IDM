import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Database,
  Loader2,
  Play,
  PlugZap,
  RefreshCw,
  Trash2,
} from "lucide-react";
import clsx from "clsx";

import {
  documentTypesAPI,
  migrationAPI,
  normalizeListResponse,
  type MigrationConnection,
  type MigrationJob,
} from "@/services/api";
import CustomListbox from "@/components/ui/CustomListbox";
import { extractApiError } from "@/lib/apiError";
import { toast } from "@/components/ui/vault-toast";

type DocumentTypeLite = { id: string; name: string; code: string };

const inputCls =
  "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";
const labelCls = "mb-1 block text-xs font-medium uppercase tracking-wide text-[#6E767D]";
const panelCls = "border border-[#C8CDD2] bg-white";
const panelHeaderCls = "flex items-center gap-2 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3";
const btnPrimary =
  "inline-flex items-center gap-2 bg-[#287EAD] px-3 h-9 text-sm font-medium text-white hover:bg-[#226c95] disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-2 border border-[#AEB5BB] bg-white px-3 h-9 text-sm text-[#1F2933] hover:bg-[#F5F7F8] disabled:opacity-50";

const STATUS_STYLES: Record<MigrationJob["status"], string> = {
  draft: "bg-[#E5E7EB] text-[#374151]",
  queued: "bg-[#DBEAFE] text-[#1E40AF]",
  running: "bg-[#FEF3C7] text-[#92400E]",
  completed: "bg-[#DCFCE7] text-[#166534]",
  partial: "bg-[#FEF9C3] text-[#854D0E]",
  failed: "bg-[#FEE2E2] text-[#991B1B]",
  cancelled: "bg-[#E5E7EB] text-[#374151]",
};

const EMPTY_CONNECTION: MigrationConnection = {
  api_url: "",
  token_url: "",
  tenant: "",
  client_id: "",
  client_secret: "",
  saak: "",
  sask: "",
  scope: "",
  idm_path: "IDM/api",
  verify_tls: true,
};

const CONNECTION_FIELDS: Array<{ key: keyof MigrationConnection; label: string; secret?: boolean }> = [
  { key: "api_url", label: "ION API URL" },
  { key: "token_url", label: "OAuth2 Token URL" },
  { key: "tenant", label: "Tenant" },
  { key: "client_id", label: "Client ID" },
  { key: "client_secret", label: "Client Secret", secret: true },
  { key: "saak", label: "Service Account Key (saak)" },
  { key: "sask", label: "Service Account Secret (sask)", secret: true },
  { key: "scope", label: "Scope (optional)" },
  { key: "idm_path", label: "IDM API Path" },
];

export default function AdminMigrationPage() {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<MigrationConnection>(EMPTY_CONNECTION);
  const [name, setName] = useState("");
  const [targetType, setTargetType] = useState("");
  const [sourceQuery, setSourceQuery] = useState("");
  const [includeAttributes, setIncludeAttributes] = useState(true);
  const [maxDocuments, setMaxDocuments] = useState(0);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);

  // Prefill the connection form from environment-configured ION defaults.
  const defaultsQuery = useQuery({
    queryKey: ["migration-connection-defaults"],
    queryFn: () => migrationAPI.connectionDefaults().then((r) => r.data),
  });
  useEffect(() => {
    if (defaultsQuery.data?.connection) {
      setConnection((prev) => ({ ...prev, ...defaultsQuery.data!.connection }));
    }
  }, [defaultsQuery.data]);

  const typesQuery = useQuery({
    queryKey: ["document-types-lite"],
    queryFn: () =>
      documentTypesAPI.list().then((r) => normalizeListResponse<DocumentTypeLite>(r.data)),
  });

  const jobsQuery = useQuery({
    queryKey: ["migration-jobs"],
    queryFn: () => migrationAPI.list().then((r) => normalizeListResponse<MigrationJob>(r.data)),
    // Poll while any job is actively running so progress stays live.
    refetchInterval: (query) => {
      const jobs = (query.state.data as MigrationJob[] | undefined) ?? [];
      return jobs.some((j) => j.status === "running" || j.status === "queued") ? 3000 : false;
    },
  });

  const detailQuery = useQuery({
    queryKey: ["migration-job", selectedJobId],
    queryFn: () => migrationAPI.get(selectedJobId as string).then((r) => r.data),
    enabled: Boolean(selectedJobId),
    refetchInterval: (query) => {
      const job = query.state.data as MigrationJob | undefined;
      return job && (job.status === "running" || job.status === "queued") ? 3000 : false;
    },
  });

  const setField = (key: keyof MigrationConnection, value: string | boolean) =>
    setConnection((prev) => ({ ...prev, [key]: value }));

  const testMutation = useMutation({
    mutationFn: () => migrationAPI.testConnection(connection).then((r) => r.data),
    onSuccess: (data) => {
      if (data.ok) toast.success(`Connected to ION${data.tenant ? ` (tenant ${data.tenant})` : ""}.`);
      else toast.error(data.detail || "Connection failed.");
    },
    onError: (err) => toast.error(extractApiError(err, "Connection test failed.")),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      migrationAPI
        .create({
          name: name.trim(),
          connection,
          source_query: sourceQuery,
          target_document_type: targetType || null,
          include_attributes: includeAttributes,
          max_documents: Number(maxDocuments) || 0,
        })
        .then((r) => r.data),
    onSuccess: (job) => {
      toast.success("Migration job created.");
      setName("");
      setSourceQuery("");
      queryClient.invalidateQueries({ queryKey: ["migration-jobs"] });
      setSelectedJobId(job.id);
    },
    onError: (err) => toast.error(extractApiError(err, "Could not create migration job.")),
  });

  const runMutation = useMutation({
    mutationFn: (id: string) => migrationAPI.run(id).then((r) => r.data),
    onSuccess: () => {
      toast.success("Migration started.");
      queryClient.invalidateQueries({ queryKey: ["migration-jobs"] });
      queryClient.invalidateQueries({ queryKey: ["migration-job", selectedJobId] });
    },
    onError: (err) => toast.error(extractApiError(err, "Could not start migration.")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => migrationAPI.delete(id),
    onSuccess: (_d, id) => {
      toast.success("Job deleted.");
      if (selectedJobId === id) setSelectedJobId(null);
      queryClient.invalidateQueries({ queryKey: ["migration-jobs"] });
    },
    onError: (err) => toast.error(extractApiError(err, "Could not delete job.")),
  });

  const jobs = jobsQuery.data ?? [];
  const types = typesQuery.data ?? [];
  const detail = detailQuery.data;
  const canCreate = name.trim().length > 0 && Boolean(targetType);

  const progressPct = useMemo(() => {
    if (!detail || !detail.total_items) return 0;
    return Math.round((detail.processed_items / detail.total_items) * 100);
  }, [detail]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center gap-3">
        <Database className="h-6 w-6 text-[#287EAD]" />
        <div>
          <h1 className="text-xl font-semibold text-[#1F2933]">Infor IDM Migration</h1>
          <p className="text-sm text-[#6E767D]">
            Pull documents from an Infor IDM tenant over the ION API into this DMS.
          </p>
        </div>
      </header>

      {/* ── ION connection ──────────────────────────────────────────────── */}
      <section className={panelCls}>
        <div className={panelHeaderCls}>
          <PlugZap className="h-4 w-4 text-[#287EAD]" />
          <h2 className="text-sm font-semibold text-[#1F2933]">ION Connection</h2>
          <span className="text-xs text-[#6E767D]">
            Blank fields fall back to server-configured defaults.
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
          {CONNECTION_FIELDS.map((f) => (
            <div key={f.key}>
              <label className={labelCls}>{f.label}</label>
              <input
                className={inputCls}
                type={f.secret ? "password" : "text"}
                value={(connection[f.key] as string) ?? ""}
                placeholder={f.secret ? "•••••• (leave blank to keep stored)" : ""}
                onChange={(e) => setField(f.key, e.target.value)}
              />
            </div>
          ))}
          <label className="flex items-center gap-2 text-sm text-[#1F2933]">
            <input
              type="checkbox"
              checked={connection.verify_tls ?? true}
              onChange={(e) => setField("verify_tls", e.target.checked)}
            />
            Verify TLS certificates
          </label>
        </div>
        <div className="flex justify-end gap-2 border-t border-[#C8CDD2] px-4 py-3">
          <button
            className={btnGhost}
            disabled={testMutation.isPending}
            onClick={() => testMutation.mutate()}
          >
            {testMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <PlugZap className="h-4 w-4" />
            )}
            Test connection
          </button>
        </div>
      </section>

      {/* ── New job ─────────────────────────────────────────────────────── */}
      <section className={panelCls}>
        <div className={panelHeaderCls}>
          <Database className="h-4 w-4 text-[#287EAD]" />
          <h2 className="text-sm font-semibold text-[#1F2933]">New migration job</h2>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
          <div>
            <label className={labelCls}>Job name</label>
            <input
              className={inputCls}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Finance invoices 2024"
            />
          </div>
          <div>
            <label className={labelCls}>Target document type</label>
            <CustomListbox
              value={targetType}
              onChange={setTargetType}
              options={[
                { value: "", label: "Select a type…" },
                ...types.map((t) => ({ value: t.id, label: `${t.name} (${t.code})` })),
              ]}
              buttonClassName={inputCls}
              ariaLabel="Target document type"
            />
          </div>
          <div className="md:col-span-2">
            <label className={labelCls}>IDM source query (optional)</label>
            <input
              className={inputCls}
              value={sourceQuery}
              onChange={(e) => setSourceQuery(e.target.value)}
              placeholder="IDM/AQL query — leave blank to pull everything the connector lists"
            />
          </div>
          <div>
            <label className={labelCls}>Max documents (0 = no limit)</label>
            <input
              className={inputCls}
              type="number"
              min={0}
              value={maxDocuments}
              onChange={(e) => setMaxDocuments(Number(e.target.value))}
            />
          </div>
          <label className="flex items-center gap-2 self-end text-sm text-[#1F2933]">
            <input
              type="checkbox"
              checked={includeAttributes}
              onChange={(e) => setIncludeAttributes(e.target.checked)}
            />
            Import IDM attributes into document metadata
          </label>
        </div>
        <div className="flex justify-end border-t border-[#C8CDD2] px-4 py-3">
          <button
            className={btnPrimary}
            disabled={!canCreate || createMutation.isPending}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Database className="h-4 w-4" />
            )}
            Create job
          </button>
        </div>
      </section>

      {/* ── Jobs list ───────────────────────────────────────────────────── */}
      <section className={panelCls}>
        <div className={clsx(panelHeaderCls, "justify-between")}>
          <span className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-[#287EAD]" />
            <h2 className="text-sm font-semibold text-[#1F2933]">Migration jobs</h2>
          </span>
          <button
            className={btnGhost}
            onClick={() => jobsQuery.refetch()}
            disabled={jobsQuery.isFetching}
          >
            <RefreshCw className={clsx("h-4 w-4", jobsQuery.isFetching && "animate-spin")} />
            Refresh
          </button>
        </div>
        {jobs.length === 0 ? (
          <p className="p-6 text-center text-sm text-[#6E767D]">No migration jobs yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[#F5F7F8] text-left text-xs uppercase tracking-wide text-[#6E767D]">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Type</th>
                <th className="px-4 py-2">Status</th>
                <th className="px-4 py-2">Progress</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {jobs.map((job) => (
                <tr
                  key={job.id}
                  className={clsx(
                    "border-t border-[#E5E7EB] hover:bg-[#F9FAFB] cursor-pointer",
                    selectedJobId === job.id && "bg-[#EFF6FB]",
                  )}
                  onClick={() => setSelectedJobId(job.id)}
                >
                  <td className="px-4 py-2 font-medium text-[#1F2933]">{job.name}</td>
                  <td className="px-4 py-2 text-[#6E767D]">{job.target_document_type_name ?? "—"}</td>
                  <td className="px-4 py-2">
                    <span className={clsx("rounded px-2 py-0.5 text-xs font-medium", STATUS_STYLES[job.status])}>
                      {job.status}
                    </span>
                  </td>
                  <td className="px-4 py-2 text-[#6E767D]">
                    {job.processed_items}/{job.total_items || "?"}{" "}
                    <span className="text-[#16A34A]">✓{job.succeeded_items}</span>{" "}
                    <span className="text-[#DC2626]">✗{job.failed_items}</span>{" "}
                    <span className="text-[#6E767D]">⊘{job.skipped_items}</span>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                      <button
                        className={btnGhost}
                        disabled={
                          runMutation.isPending ||
                          job.status === "running" ||
                          job.status === "queued"
                        }
                        onClick={() => runMutation.mutate(job.id)}
                        title="Run migration"
                      >
                        <Play className="h-4 w-4" />
                      </button>
                      <button
                        className={btnGhost}
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          if (confirm(`Delete migration job "${job.name}"?`)) deleteMutation.mutate(job.id);
                        }}
                        title="Delete job"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* ── Job detail / log ────────────────────────────────────────────── */}
      {detail && (
        <section className={panelCls}>
          <div className={panelHeaderCls}>
            <h2 className="text-sm font-semibold text-[#1F2933]">{detail.name} — details</h2>
            <span className={clsx("rounded px-2 py-0.5 text-xs font-medium", STATUS_STYLES[detail.status])}>
              {detail.status}
            </span>
          </div>
          <div className="space-y-3 p-4">
            {detail.total_items > 0 && (
              <div className="h-2 w-full overflow-hidden rounded bg-[#E5E7EB]">
                <div className="h-full bg-[#287EAD]" style={{ width: `${progressPct}%` }} />
              </div>
            )}
            {detail.error && (
              <p className="border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-sm text-[#991B1B]">
                {detail.error}
              </p>
            )}
            <div className="max-h-72 overflow-auto border border-[#E5E7EB]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[#F5F7F8] text-left uppercase tracking-wide text-[#6E767D]">
                  <tr>
                    <th className="px-3 py-2">IDM ID</th>
                    <th className="px-3 py-2">Reference</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {(detail.log ?? []).length === 0 ? (
                    <tr>
                      <td className="px-3 py-3 text-[#6E767D]" colSpan={4}>
                        No items processed yet.
                      </td>
                    </tr>
                  ) : (
                    (detail.log ?? []).map((entry, i) => (
                      <tr key={i} className="border-t border-[#E5E7EB]">
                        <td className="px-3 py-1.5 font-mono text-[#374151]">{entry.ion_id ?? "—"}</td>
                        <td className="px-3 py-1.5">{entry.reference_number ?? "—"}</td>
                        <td className="px-3 py-1.5">{entry.status}</td>
                        <td className="px-3 py-1.5 text-[#6E767D]">{entry.detail}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </section>
      )}
    </div>
  );
}
