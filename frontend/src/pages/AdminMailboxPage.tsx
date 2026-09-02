import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart3, Inbox, Loader2, Mail, Pencil, PlugZap, RefreshCw, Trash2, X, Plus } from "lucide-react";
import clsx from "clsx";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  documentTypesAPI,
  mailboxAPI,
  normalizeListResponse,
  usersAPI,
  type Mailbox,
  type MailboxConnection,
  type MailboxProtocol,
} from "@/services/api";
import { extractApiError } from "@/lib/apiError";
import { toast } from "@/components/ui/vault-toast";
import CustomListbox from "@/components/ui/CustomListbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

type DocumentTypeLite = { id: string; name: string; code: string };
type UserLite = { id: string; email: string; first_name: string; last_name: string; full_name?: string };

const POLL_INTERVAL_OPTIONS = [
  { value: "60", label: "Every 1 minute" },
  { value: "300", label: "Every 5 minutes" },
  { value: "900", label: "Every 15 minutes" },
  { value: "1800", label: "Every 30 minutes" },
  { value: "3600", label: "Every hour" },
];

const inputCls =
  "h-9 w-full border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";
const labelCls = "mb-1 block text-xs font-medium uppercase tracking-wide text-[#6E767D]";
const panelCls = "border border-[#C8CDD2] bg-white";
const panelHeaderCls = "flex items-center gap-2 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3";
const btnPrimary =
  "inline-flex items-center gap-2 bg-[#287EAD] px-3 h-9 text-sm font-medium text-white hover:bg-[#226c95] disabled:opacity-50";
const btnGhost =
  "inline-flex items-center gap-2 border border-[#AEB5BB] bg-white px-3 h-9 text-sm text-[#1F2933] hover:bg-[#F5F7F8] disabled:opacity-50";

const POLL_STATUS_STYLES: Record<Mailbox["poll_status"], string> = {
  idle: "bg-[#E5E7EB] text-[#374151]",
  polling: "bg-[#FEF3C7] text-[#92400E]",
  ok: "bg-[#DCFCE7] text-[#166534]",
  error: "bg-[#FEE2E2] text-[#991B1B]",
};

const EMAIL_STATUS_STYLES: Record<string, string> = {
  imported: "bg-[#DCFCE7] text-[#166534]",
  partial: "bg-[#FEF9C3] text-[#854D0E]",
  skipped: "bg-[#E5E7EB] text-[#374151]",
  failed: "bg-[#FEE2E2] text-[#991B1B]",
};

const EMPTY_IMAP: MailboxConnection = {
  host: "",
  port: 993,
  use_ssl: true,
  username: "",
  password: "",
  folder: "INBOX",
  verify_tls: true,
};
const EMPTY_GRAPH: MailboxConnection = {
  tenant_id: "",
  client_id: "",
  client_secret: "",
  mailbox: "",
  folder: "inbox",
};
const emptyConnectionFor = (p: MailboxProtocol): MailboxConnection =>
  p === "graph" ? { ...EMPTY_GRAPH } : { ...EMPTY_IMAP };

// Render the sender→supplier map as editable "key = value" lines, and parse
// them back. Keeps the admin form simple while the backend stores a JSON map.
function mapToText(map: Record<string, string>): string {
  return Object.entries(map || {})
    .map(([k, v]) => `${k} = ${v}`)
    .join("\n");
}
function textToMap(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim();
    if (key && value) out[key] = value;
  }
  return out;
}

// Sender allowlist: one address/domain per line (commas also accepted).
function listToText(list: string[]): string {
  return (list || []).join("\n");
}
function textToList(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export default function AdminMailboxPage() {
  const queryClient = useQueryClient();
  const [protocol, setProtocol] = useState<MailboxProtocol>("imap");
  const [connection, setConnection] = useState<MailboxConnection>(EMPTY_IMAP);
  const [name, setName] = useState("");
  const [defaultType, setDefaultType] = useState("");
  const [autoClassify, setAutoClassify] = useState(false);
  const [relatedSet, setRelatedSet] = useState(true);
  const [maxMessages, setMaxMessages] = useState(50);
  const [ingestHistory, setIngestHistory] = useState(false);
  const [ingestSince, setIngestSince] = useState("");
  const [autoPoll, setAutoPoll] = useState(false);
  const [pollInterval, setPollInterval] = useState(300);
  const [reviewerIds, setReviewerIds] = useState<string[]>([]);
  const [supplierMapText, setSupplierMapText] = useState("");
  const [allowlistText, setAllowlistText] = useState("");
  const [attachmentTypesText, setAttachmentTypesText] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  // null = creating a new mailbox; an id = editing that mailbox.
  const [editingId, setEditingId] = useState<string | null>(null);
  const [isNewMailboxModalOpen, setIsNewMailboxModalOpen] = useState(false);

  // Prefill the connection form from environment-configured defaults for the
  // selected protocol.
  const defaultsQuery = useQuery({
    queryKey: ["mailbox-connection-defaults", protocol],
    queryFn: () => mailboxAPI.connectionDefaults(protocol).then((r) => r.data),
  });

  // Switching protocol resets the connection to that protocol's empty shape;
  // the defaults effect then overlays any non-blank env values.
  const changeProtocol = (p: MailboxProtocol) => {
    if (p === protocol) return;
    setProtocol(p);
    setConnection(emptyConnectionFor(p));
  };
  useEffect(() => {
    const defaults = defaultsQuery.data?.connection;
    if (!defaults) return;
    // Only overlay non-blank server defaults so an empty IMAP_* env value can
    // never wipe what the user has already typed (mirrors the backend's
    // merge_connection_with_defaults, where non-blank mailbox values win).
    setConnection((prev) => {
      const merged: MailboxConnection = { ...prev };
      for (const [key, value] of Object.entries(defaults)) {
        if (value !== "" && value !== null && value !== undefined) {
          (merged as Record<string, unknown>)[key] = value;
        }
      }
      return merged;
    });
  }, [defaultsQuery.data]);

  const typesQuery = useQuery({
    queryKey: ["document-types-lite"],
    queryFn: () =>
      documentTypesAPI.list().then((r) => normalizeListResponse<DocumentTypeLite>(r.data)),
  });

  const usersQuery = useQuery({
    queryKey: ["users-lite-mailbox-reviewers"],
    queryFn: () =>
      usersAPI.list({ page_size: 200 }).then((r) => normalizeListResponse<UserLite>(r.data)),
  });

  const [statsDays, setStatsDays] = useState(30);
  const statsQuery = useQuery({
    queryKey: ["mailbox-stats", statsDays],
    queryFn: () => mailboxAPI.stats(statsDays).then((r) => r.data),
  });

  const mailboxesQuery = useQuery({
    queryKey: ["mailboxes"],
    queryFn: () => mailboxAPI.list().then((r) => normalizeListResponse<Mailbox>(r.data)),
    // Poll while any mailbox is actively polling so progress stays live.
    refetchInterval: (query) => {
      const boxes = (query.state.data as Mailbox[] | undefined) ?? [];
      return boxes.some((b) => b.poll_status === "polling") ? 3000 : false;
    },
  });

  const detailQuery = useQuery({
    queryKey: ["mailbox", selectedId],
    queryFn: () => mailboxAPI.get(selectedId as string).then((r) => r.data),
    enabled: Boolean(selectedId),
    refetchInterval: (query) => {
      const box = query.state.data as Mailbox | undefined;
      return box && box.poll_status === "polling" ? 3000 : false;
    },
  });

  const setField = (key: keyof MailboxConnection, value: string | boolean | number) =>
    setConnection((prev) => ({ ...prev, [key]: value }));

  const testMutation = useMutation({
    mutationFn: () => mailboxAPI.testConnection(connection, protocol).then((r) => r.data),
    onSuccess: (data) => {
      if (data.ok)
        toast.success(`Connected to ${data.mailbox ?? data.host ?? "mailbox"} (${data.folder ?? "INBOX"}).`);
      else toast.error(data.detail || "Connection failed.");
    },
    onError: (err) => toast.error(extractApiError(err, "Connection test failed.")),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      mailboxAPI
        .create({
          name: name.trim(),
          protocol,
          connection,
          default_document_type: defaultType || null,
          auto_classify: autoClassify,
          related_set_attachments: relatedSet,
          ingest_history: ingestHistory,
          ingest_since: ingestSince || null,
          max_messages_per_poll: Number(maxMessages) || 0,
          auto_poll: autoPoll,
          poll_interval_seconds: Number(pollInterval) || 300,
          reviewers: reviewerIds,
          sender_supplier_map: textToMap(supplierMapText),
          sender_allowlist: textToList(allowlistText),
          allowed_attachment_extensions: textToList(attachmentTypesText),
        })
        .then((r) => r.data),
    onSuccess: (box) => {
      toast.success("Mailbox created.");
      setIsNewMailboxModalOpen(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
      setSelectedId(box.id);
    },
    onError: (err) => toast.error(extractApiError(err, "Could not create mailbox.")),
  });

  const resetForm = () => {
    setEditingId(null);
    setIsNewMailboxModalOpen(false);
    setName("");
    setDefaultType("");
    setAutoClassify(false);
    setRelatedSet(true);
    setMaxMessages(50);
    setIngestHistory(false);
    setIngestSince("");
    setAutoPoll(false);
    setPollInterval(300);
    setReviewerIds([]);
    setSupplierMapText("");
    setAllowlistText("");
    setAttachmentTypesText("");
    // Back to a clean IMAP create form; the defaults effect re-overlays env values.
    setProtocol("imap");
    setConnection({ ...EMPTY_IMAP });
  };

  const startEdit = async (id: string) => {
    try {
      const { data } = await mailboxAPI.get(id);
      setEditingId(id);
      setIsNewMailboxModalOpen(true);
      setName(data.name);
      setProtocol(data.protocol);
      // Keep the stored (redacted) connection as-is; blank the secrets so an
      // unchanged save preserves them server-side.
      setConnection({
        ...emptyConnectionFor(data.protocol),
        ...(data.connection ?? {}),
        password: "",
        client_secret: "",
      });
      setDefaultType(data.default_document_type ?? "");
      setAutoClassify(data.auto_classify);
      setRelatedSet(data.related_set_attachments);
      setMaxMessages(data.max_messages_per_poll);
      setIngestHistory(data.ingest_history);
      setIngestSince(data.ingest_since ?? "");
      setAutoPoll(data.auto_poll ?? false);
      setPollInterval(data.poll_interval_seconds ?? 300);
      setReviewerIds(data.reviewers ?? data.reviewer_details?.map((u) => u.id) ?? []);
      setSupplierMapText(mapToText(data.sender_supplier_map ?? {}));
      setAllowlistText(listToText(data.sender_allowlist ?? []));
      setAttachmentTypesText(listToText(data.allowed_attachment_extensions ?? []));
    } catch (err) {
      toast.error(extractApiError(err, "Could not load mailbox for editing."));
    }
  };

  const updateMutation = useMutation({
    mutationFn: () =>
      mailboxAPI
        .update(editingId as string, {
          name: name.trim(),
          protocol,
          connection,
          default_document_type: defaultType || null,
          auto_classify: autoClassify,
          related_set_attachments: relatedSet,
          ingest_history: ingestHistory,
          ingest_since: ingestSince || null,
          max_messages_per_poll: Number(maxMessages) || 0,
          auto_poll: autoPoll,
          poll_interval_seconds: Number(pollInterval) || 300,
          reviewers: reviewerIds,
          sender_supplier_map: textToMap(supplierMapText),
          sender_allowlist: textToList(allowlistText),
          allowed_attachment_extensions: textToList(attachmentTypesText),
        })
        .then((r) => r.data),
    onSuccess: (box) => {
      toast.success("Mailbox updated.");
      const id = box.id;
      setIsNewMailboxModalOpen(false);
      resetForm();
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
      queryClient.invalidateQueries({ queryKey: ["mailbox", id] });
    },
    onError: (err) => toast.error(extractApiError(err, "Could not update mailbox.")),
  });

  const pollMutation = useMutation({
    mutationFn: (id: string) => mailboxAPI.poll(id).then((r) => r.data),
    onSuccess: () => {
      toast.success("Poll started.");
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
      queryClient.invalidateQueries({ queryKey: ["mailbox", selectedId] });
    },
    onError: (err) => toast.error(extractApiError(err, "Could not start poll.")),
  });

  const toggleActiveMutation = useMutation({
    mutationFn: ({ id, is_active }: { id: string; is_active: boolean }) =>
      mailboxAPI.update(id, { is_active }).then((r) => r.data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
      queryClient.invalidateQueries({ queryKey: ["mailbox", selectedId] });
    },
    onError: (err) => toast.error(extractApiError(err, "Could not update mailbox.")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => mailboxAPI.delete(id),
    onSuccess: (_d, id) => {
      toast.success("Mailbox deleted.");
      if (selectedId === id) setSelectedId(null);
      queryClient.invalidateQueries({ queryKey: ["mailboxes"] });
    },
    onError: (err) => toast.error(extractApiError(err, "Could not delete mailbox.")),
  });

  const mailboxes = mailboxesQuery.data ?? [];
  const types = typesQuery.data ?? [];
  const detail = detailQuery.data;
  const canCreate = name.trim().length > 0;

  const recentEmails = useMemo(() => detail?.recent_emails ?? [], [detail]);

  return (
    <div className="mx-auto max-w-5xl space-y-6 p-6">
      <header className="flex items-center gap-3">
        <Inbox className="h-6 w-6 text-[#287EAD]" />
        <div>
          <h1 className="text-xl font-semibold text-[#1F2933]">Email Ingestion</h1>
          <p className="text-sm text-[#6E767D]">
            Watch an IMAP or Microsoft 365 mailbox and import attachments as draft documents into
            the review queue.
          </p>
        </div>
      </header>

      {/* ── Mailbox connection ──────────────────────────────────────────── */}
      <section className={panelCls}>
        <div className={panelHeaderCls}>
          <PlugZap className="h-4 w-4 text-[#287EAD]" />
          <h2 className="text-sm font-semibold text-[#1F2933]">Mailbox Connection</h2>
          <span className="text-xs text-[#6E767D]">
            Blank fields fall back to server-configured defaults.
          </span>
        </div>
        <div className="grid grid-cols-1 gap-4 p-4 md:grid-cols-2">
          <div>
            <label className={labelCls}>Protocol</label>
            <CustomListbox
              value={protocol}
              onChange={(v) => changeProtocol(v as MailboxProtocol)}
              options={[
                { value: "imap", label: "IMAP" },
                { value: "graph", label: "Microsoft Graph (Microsoft 365 / Outlook)" },
              ]}
              buttonClassName={inputCls}
              className="w-full"
              ariaLabel="Mailbox protocol"
            />
          </div>
          <div className="hidden md:block" />

          {protocol === "imap" ? (
            <>
              <div>
                <label className={labelCls}>Host</label>
                <input
                  className={inputCls}
                  value={connection.host ?? ""}
                  onChange={(e) => setField("host", e.target.value)}
                  placeholder="imap.example.com"
                />
              </div>
              <div>
                <label className={labelCls}>Port</label>
                <input
                  className={inputCls}
                  type="number"
                  min={1}
                  value={connection.port ?? 993}
                  onChange={(e) => setField("port", Number(e.target.value))}
                />
              </div>
              <div>
                <label className={labelCls}>Username</label>
                <input
                  className={inputCls}
                  value={connection.username ?? ""}
                  onChange={(e) => setField("username", e.target.value)}
                  placeholder="invoices@example.com"
                />
              </div>
              <div>
                <label className={labelCls}>Password</label>
                <input
                  className={inputCls}
                  type="password"
                  value={connection.password ?? ""}
                  placeholder="•••••• (leave blank to keep stored)"
                  onChange={(e) => setField("password", e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls}>Folder</label>
                <input
                  className={inputCls}
                  value={connection.folder ?? "INBOX"}
                  onChange={(e) => setField("folder", e.target.value)}
                />
              </div>
              <div className="flex items-end gap-4">
                <label className="flex items-center gap-2 text-sm text-[#1F2933]">
                  <input
                    type="checkbox"
                    checked={connection.use_ssl ?? true}
                    onChange={(e) => setField("use_ssl", e.target.checked)}
                  />
                  Use SSL
                </label>
                <label className="flex items-center gap-2 text-sm text-[#1F2933]">
                  <input
                    type="checkbox"
                    checked={connection.verify_tls ?? true}
                    onChange={(e) => setField("verify_tls", e.target.checked)}
                  />
                  Verify TLS
                </label>
              </div>
            </>
          ) : (
            <>
              <div>
                <label className={labelCls}>Tenant ID</label>
                <input
                  className={inputCls}
                  value={connection.tenant_id ?? ""}
                  onChange={(e) => setField("tenant_id", e.target.value)}
                  placeholder="Azure AD directory (tenant) id"
                />
              </div>
              <div>
                <label className={labelCls}>Client ID</label>
                <input
                  className={inputCls}
                  value={connection.client_id ?? ""}
                  onChange={(e) => setField("client_id", e.target.value)}
                  placeholder="App registration (client) id"
                />
              </div>
              <div>
                <label className={labelCls}>Client Secret</label>
                <input
                  className={inputCls}
                  type="password"
                  value={connection.client_secret ?? ""}
                  placeholder="•••••• (leave blank to keep stored)"
                  onChange={(e) => setField("client_secret", e.target.value)}
                />
              </div>
              <div>
                <label className={labelCls}>Mailbox (user)</label>
                <input
                  className={inputCls}
                  value={connection.mailbox ?? ""}
                  onChange={(e) => setField("mailbox", e.target.value)}
                  placeholder="invoices@your-tenant.com"
                />
              </div>
              <div>
                <label className={labelCls}>Folder</label>
                <input
                  className={inputCls}
                  value={connection.folder ?? "inbox"}
                  onChange={(e) => setField("folder", e.target.value)}
                  placeholder="inbox"
                />
              </div>
              <div className="flex items-end">
                <p className="text-xs text-[#6E767D]">
                  App-only access: the Azure app registration needs the application permission
                  <span className="font-medium"> Mail.Read</span> with admin consent.
                </p>
              </div>
            </>
          )}
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

      {/* ── New / edit mailbox dialog ──────────────────────────────────────── */}
      <Dialog open={isNewMailboxModalOpen} onOpenChange={setIsNewMailboxModalOpen}>
        <DialogContent className="max-w-3xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{editingId ? "Edit mailbox" : "New mailbox"}</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-4 py-4 md:grid-cols-2">
            <div>
              <label className={labelCls}>Mailbox name</label>
              <input
                className={inputCls}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Supplier invoices"
              />
            </div>
            <div>
              <label className={labelCls}>Default document type</label>
              <CustomListbox
                value={defaultType}
                onChange={setDefaultType}
                options={[
                  { value: "", label: "Unclassified — reviewer classifies" },
                  ...types.map((t) => ({ value: t.id, label: `${t.name} (${t.code})` })),
                ]}
                buttonClassName={inputCls}
                className="w-full"
                ariaLabel="Default document type"
              />
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>Sender → supplier map (one per line: email or domain = Supplier)</label>
              <textarea
                className={clsx(inputCls, "h-24 py-2")}
                value={supplierMapText}
                onChange={(e) => setSupplierMapText(e.target.value)}
                placeholder={"acme.com = ACME Ltd\nbilling@globex.com = Globex Inc"}
              />
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>
                Sender allowlist (one email or domain per line — leave empty to accept all)
              </label>
              <textarea
                className={clsx(inputCls, "h-24 py-2")}
                value={allowlistText}
                onChange={(e) => setAllowlistText(e.target.value)}
                placeholder={"acme.com\nap@globex.com"}
              />
              <p className="mt-1 text-xs text-[#6E767D]">
                When set, only emails from these senders are ingested — everything else is skipped.
              </p>
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>
                Attachment types (file extensions, comma or line separated — leave empty for all)
              </label>
              <input
                className={inputCls}
                value={attachmentTypesText}
                onChange={(e) => setAttachmentTypesText(e.target.value)}
                placeholder="pdf, png, jpg"
              />
              <p className="mt-1 text-xs text-[#6E767D]">
                When set, only attachments with these extensions are imported — others are ignored.
              </p>
            </div>
            <div>
              <label className={labelCls}>Max messages per poll (0 = no limit)</label>
              <input
                className={inputCls}
                type="number"
                min={0}
                value={maxMessages}
                onChange={(e) => setMaxMessages(Number(e.target.value))}
              />
            </div>
            <div>
              <label className={labelCls}>Import messages since (optional)</label>
              <input
                className={inputCls}
                type="date"
                value={ingestSince}
                onChange={(e) => setIngestSince(e.target.value)}
              />
              <p className="mt-1 text-xs text-[#6E767D]">
                Only ingest mail received on or after this date.
              </p>
            </div>
            <div className="md:col-span-2">
              <label className="flex items-center gap-2 text-sm text-[#1F2933]">
                <input
                  type="checkbox"
                  checked={ingestHistory}
                  onChange={(e) => setIngestHistory(e.target.checked)}
                />
                Import the mailbox's existing backlog on first poll
              </label>
              <p className="mt-1 text-xs text-[#6E767D]">
                Off by default — a new mailbox ingests only mail that arrives after it's created,
                so an existing inbox doesn't pull its whole history.
              </p>
            </div>
            <div className="md:col-span-2 space-y-3 border border-[#E5E7EB] bg-[#F9FAFB] p-3">
              <label className="flex items-center gap-2 text-sm text-[#1F2933]">
                <input
                  type="checkbox"
                  checked={autoPoll}
                  onChange={(e) => setAutoPoll(e.target.checked)}
                />
                Automatic polling
              </label>
              <p className="text-xs text-[#6E767D]">
                When enabled, the system polls this mailbox on a schedule and lands matching
                attachments in Pending review — no manual Poll now required. Manual poll still works.
              </p>
              {autoPoll && (
                <div className="max-w-xs">
                  <label className={labelCls}>Poll interval</label>
                  <CustomListbox
                    value={String(pollInterval)}
                    onChange={(v) => setPollInterval(Number(v))}
                    options={POLL_INTERVAL_OPTIONS}
                    buttonClassName={inputCls}
                    className="w-full"
                    ariaLabel="Automatic poll interval"
                  />
                </div>
              )}
            </div>
            <div className="md:col-span-2">
              <label className={labelCls}>Reviewers (optional)</label>
              <div className="max-h-40 overflow-auto border border-[#AEB5BB] bg-white p-2">
                {(usersQuery.data ?? []).length === 0 ? (
                  <p className="px-1 py-2 text-xs text-[#6E767D]">
                    {usersQuery.isLoading ? "Loading users…" : "No users available."}
                  </p>
                ) : (
                  (usersQuery.data ?? []).map((u) => {
                    const checked = reviewerIds.includes(u.id);
                    const label = u.full_name || `${u.first_name} ${u.last_name}`.trim() || u.email;
                    return (
                      <label
                        key={u.id}
                        className="flex cursor-pointer items-center gap-2 px-1 py-1 text-sm text-[#1F2933] hover:bg-[#F5F7F8]"
                      >
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() =>
                            setReviewerIds((prev) =>
                              checked ? prev.filter((id) => id !== u.id) : [...prev, u.id],
                            )
                          }
                        />
                        <span className="truncate">{label}</span>
                        <span className="truncate text-xs text-[#6E767D]">{u.email}</span>
                      </label>
                    );
                  })
                )}
              </div>
              <div className="mt-1 flex items-center justify-between gap-3 text-xs text-[#6E767D]">
                <p>
                  Members who see this mailbox's ingested documents in Pending review.
                  Leave empty so the mailbox owner and admins handle review.
                </p>
                <span className="whitespace-nowrap font-medium text-[#4B5560]">
                  {reviewerIds.length} selected
                </span>
              </div>
            </div>
            <div className="flex flex-col justify-end gap-2">
              <label className="flex items-center gap-2 text-sm text-[#1F2933]">
                <input
                  type="checkbox"
                  checked={relatedSet}
                  onChange={(e) => setRelatedSet(e.target.checked)}
                />
                Treat multi-attachment emails as a related set
              </label>
              <label className="flex items-center gap-2 text-sm text-[#1F2933]">
                <input
                  type="checkbox"
                  checked={autoClassify}
                  onChange={(e) => setAutoClassify(e.target.checked)}
                />
                Auto-classify document type from content
              </label>
            </div>
          </div>
          <DialogFooter>
            <button
              className={btnGhost}
              onClick={() => setIsNewMailboxModalOpen(false)}
            >
              Cancel
            </button>
            <button
              className={btnPrimary}
              disabled={!canCreate || createMutation.isPending || updateMutation.isPending}
              onClick={() => (editingId ? updateMutation.mutate() : createMutation.mutate())}
            >
              {createMutation.isPending || updateMutation.isPending ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Mail className="h-4 w-4" />
              )}
              {editingId ? "Save changes" : "Create mailbox"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ── Ingestion statistics ────────────────────────────────────────── */}
      <section className={panelCls}>
        <div className={clsx(panelHeaderCls, "justify-between")}>
          <span className="flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-[#287EAD]" />
            <h2 className="text-sm font-semibold text-[#1F2933]">Ingestion statistics</h2>
          </span>
          <CustomListbox
            value={String(statsDays)}
            onChange={(v) => setStatsDays(Number(v))}
            options={[
              { value: "7", label: "Last 7 days" },
              { value: "30", label: "Last 30 days" },
              { value: "90", label: "Last 90 days" },
            ]}
            buttonClassName="h-8 border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933] text-left"
            ariaLabel="Ingestion statistics time range"
          />
        </div>
        <div className="space-y-4 p-4">
          {statsQuery.data && (
            <div className="flex flex-wrap gap-x-6 gap-y-1 text-sm">
              <span className="text-[#1F2933]">
                <span className="font-semibold">{statsQuery.data.totals.documents}</span> documents
              </span>
              <span className="text-[#16A34A]">✓ {statsQuery.data.totals.imported} imported</span>
              <span className="text-[#6E767D]">⊘ {statsQuery.data.totals.skipped} skipped</span>
              <span className="text-[#DC2626]">✗ {statsQuery.data.totals.failed} failed</span>
              <span className="text-[#6E767D]">{statsQuery.data.totals.total} emails seen</span>
            </div>
          )}
          <div className="h-64 w-full">
            {statsQuery.isLoading ? (
              <div className="flex h-full items-center justify-center">
                <Loader2 className="h-6 w-6 animate-spin text-[#5E6870]" />
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={statsQuery.data?.daily ?? []} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#EEF1F3" />
                  <XAxis
                    dataKey="date"
                    tick={{ fontSize: 11, fill: "#6E767D" }}
                    tickFormatter={(d: string) => d.slice(5)}
                    interval="preserveStartEnd"
                    minTickGap={24}
                  />
                  <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: "#6E767D" }} width={32} />
                  <Tooltip />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="imported" stackId="a" name="Imported" fill="#16A34A" />
                  <Bar dataKey="skipped" stackId="a" name="Skipped" fill="#CBD5E1" />
                  <Bar dataKey="failed" stackId="a" name="Failed" fill="#DC2626" />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>
        </div>
      </section>

      {/* ── Mailboxes list ──────────────────────────────────────────────── */}
      <section className={panelCls}>
        <div className={clsx(panelHeaderCls, "justify-between")}>
          <span className="flex items-center gap-2">
            <RefreshCw className="h-4 w-4 text-[#287EAD]" />
            <h2 className="text-sm font-semibold text-[#1F2933]">Mailboxes</h2>
          </span>
          <div className="flex items-center gap-2">
            <button
              className={btnPrimary}
              onClick={() => {
                resetForm();
                setIsNewMailboxModalOpen(true);
              }}
            >
              <Plus className="h-4 w-4" />
              New mailbox
            </button>
            <button
              className={btnGhost}
              onClick={() => mailboxesQuery.refetch()}
              disabled={mailboxesQuery.isFetching}
            >
              <RefreshCw className={clsx("h-4 w-4", mailboxesQuery.isFetching && "animate-spin")} />
              Refresh
            </button>
          </div>
        </div>
        {mailboxes.length === 0 ? (
          <p className="p-6 text-center text-sm text-[#6E767D]">No mailboxes yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-[#F5F7F8] text-left text-xs uppercase tracking-wide text-[#6E767D]">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-4 py-2">Default type</th>
                <th className="px-4 py-2">Active</th>
                <th className="px-4 py-2">Auto poll</th>
                <th className="px-4 py-2">Status & timing</th>
                <th className="px-4 py-2 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {mailboxes.map((box) => (
                <tr
                  key={box.id}
                  className={clsx(
                    "border-t border-[#E5E7EB] hover:bg-[#F9FAFB] cursor-pointer",
                    selectedId === box.id && "bg-[#EFF6FB]",
                  )}
                  onClick={() => setSelectedId(box.id)}
                >
                  <td className="px-4 py-2 font-medium text-[#1F2933]">{box.name}</td>
                  <td className="px-4 py-2 text-[#6E767D]">
                    {box.default_document_type_name ?? "Unclassified"}
                  </td>
                  <td className="px-4 py-2" onClick={(e) => e.stopPropagation()}>
                    <label className="inline-flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={box.is_active}
                        disabled={toggleActiveMutation.isPending}
                        onChange={(e) =>
                          toggleActiveMutation.mutate({ id: box.id, is_active: e.target.checked })
                        }
                      />
                    </label>
                  </td>
                  <td className="px-4 py-2 text-[#6E767D]">
                    {box.auto_poll
                      ? `Every ${Math.max(1, Math.round((box.poll_interval_seconds || 300) / 60))}m`
                      : "Manual"}
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex flex-col gap-1">
                      <div className="flex items-center gap-2">
                        <span
                          className={clsx(
                            "rounded px-2 py-0.5 text-xs font-medium",
                            POLL_STATUS_STYLES[box.poll_status],
                          )}
                        >
                          {box.poll_status}
                        </span>
                        <span className="text-[#16A34A]">✓{box.last_imported_count}</span>
                        <span className="text-[#6E767D]">⊘{box.last_skipped_count}</span>
                        <span className="text-[#DC2626]">✗{box.last_failed_count}</span>
                      </div>
                      {box.last_polled_at && (
                        <span className="text-xs text-[#6E767D]">
                          Last poll: {new Date(box.last_polled_at).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2">
                    <div className="flex justify-end gap-2" onClick={(e) => e.stopPropagation()}>
                      <button
                        className={btnGhost}
                        onClick={() => startEdit(box.id)}
                        title="Edit mailbox"
                      >
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button
                        className={btnGhost}
                        disabled={pollMutation.isPending || box.poll_status === "polling" || !box.is_active}
                        onClick={() => pollMutation.mutate(box.id)}
                        title="Poll now"
                      >
                        <RefreshCw className="h-4 w-4" />
                      </button>
                      <button
                        className={btnGhost}
                        disabled={deleteMutation.isPending}
                        onClick={() => {
                          if (confirm(`Delete mailbox "${box.name}"?`)) deleteMutation.mutate(box.id);
                        }}
                        title="Delete mailbox"
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

      {/* ── Mailbox detail / recent emails ──────────────────────────────── */}
      {detail && (
        <section className={panelCls}>
          <div className={clsx(panelHeaderCls, "justify-between")}>
            <span className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-[#1F2933]">{detail.name} — recent emails</h2>
              <span
                className={clsx(
                  "rounded px-2 py-0.5 text-xs font-medium",
                  POLL_STATUS_STYLES[detail.poll_status],
                )}
              >
                {detail.poll_status}
              </span>
            </span>
            {detail.last_polled_at && (
              <span className="text-xs text-[#6E767D]">
                Last polled {new Date(detail.last_polled_at).toLocaleString()}
              </span>
            )}
          </div>
          <div className="space-y-3 p-4">
            {detail.last_error && (
              <p className="border border-[#FECACA] bg-[#FEF2F2] px-3 py-2 text-sm text-[#991B1B]">
                {detail.last_error}
                {(detail.consecutive_failures ?? 0) > 1 && (
                  <span className="font-medium"> · {detail.consecutive_failures} consecutive failed polls</span>
                )}
              </p>
            )}
            {detail.email_counts && (
              <div className="flex flex-wrap gap-4 text-sm">
                <span className="text-[#1F2933]">
                  <span className="font-semibold">{detail.email_counts.total}</span> emails seen
                </span>
                <span className="text-[#16A34A]">✓ {detail.email_counts.imported} imported</span>
                {detail.email_counts.partial > 0 && (
                  <span className="text-[#854D0E]">◐ {detail.email_counts.partial} partial</span>
                )}
                <span className="text-[#6E767D]">⊘ {detail.email_counts.skipped} skipped</span>
                <span className="text-[#DC2626]">✗ {detail.email_counts.failed} failed</span>
              </div>
            )}
            <div className="max-h-72 overflow-auto border border-[#E5E7EB]">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-[#F5F7F8] text-left uppercase tracking-wide text-[#6E767D]">
                  <tr>
                    <th className="px-3 py-2">From</th>
                    <th className="px-3 py-2">Subject</th>
                    <th className="px-3 py-2">Status</th>
                    <th className="px-3 py-2">Docs</th>
                    <th className="px-3 py-2">Detail</th>
                  </tr>
                </thead>
                <tbody>
                  {recentEmails.length === 0 ? (
                    <tr>
                      <td className="px-3 py-3 text-[#6E767D]" colSpan={5}>
                        No emails ingested yet.
                      </td>
                    </tr>
                  ) : (
                    recentEmails.map((email) => (
                      <tr key={email.id} className="border-t border-[#E5E7EB]">
                        <td className="px-3 py-1.5 text-[#374151]">{email.sender || "—"}</td>
                        <td className="px-3 py-1.5 text-[#374151]">{email.subject || "—"}</td>
                        <td className="px-3 py-1.5">
                          <span
                            className={clsx(
                              "rounded px-2 py-0.5 text-xs font-medium",
                              EMAIL_STATUS_STYLES[email.status] ?? "bg-[#E5E7EB] text-[#374151]",
                            )}
                          >
                            {email.status}
                          </span>
                        </td>
                        <td className="px-3 py-1.5 text-[#6E767D]">
                          {email.documents_created}/{email.attachment_count}
                        </td>
                        <td className="px-3 py-1.5 text-[#6E767D]">{email.detail}</td>
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
