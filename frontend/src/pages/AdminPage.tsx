import { useEffect, useMemo, useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dmsSettingsAPI, billingAPI, type DmsSettings, type IdpUsageReport } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import { useAuthStore } from "@/store/authStore";
import {
  Archive,
  BellRing,
  Building2,
  ClipboardCheck,
  Clock,
  Copy,
  Droplets,
  Link2,
  Loader2,
  RotateCcw,
  Save,
  ShieldCheck,
  Sparkles,
  Timer,
  Trash2,
  Wallet,
} from "lucide-react";
import CustomListbox from "@/components/ui/CustomListbox";
import clsx from "clsx";

type SectionId = "preview" | "lifecycle" | "governance" | "idp" | "security" | "ops_billing";

const inputCls =
  "h-9 border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

const panelCls = "border border-[#C8CDD2] bg-white";
const panelHeaderCls = "border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3";
const sectionBodyCls = "space-y-5 p-4";

const baseSections: Array<{
  id: SectionId;
  title: string;
  description: string;
  icon: React.ElementType;
  opsOnly?: boolean;
}> = [
  {
    id: "preview",
    title: "Preview & Links",
    description: "Watermarks and file access behavior",
    icon: Droplets,
  },
  {
    id: "lifecycle",
    title: "Lifecycle",
    description: "Archiving and trash retention",
    icon: Archive,
  },
  {
    id: "governance",
    title: "Governance",
    description: "Duplicates, metadata, and stage access",
    icon: ShieldCheck,
  },
  {
    id: "idp",
    title: "Document extraction",
    description: "Claude IDP and fallback behaviour",
    icon: Sparkles,
  },
  {
    id: "security",
    title: "Security",
    description: "Session lifetime and inactivity sign-out",
    icon: Clock,
  },
  {
    id: "ops_billing",
    title: "Client billing (ops)",
    description: "Anthropic usage & spend across all registered clients",
    icon: Wallet,
    opsOnly: true,
  },
];

/** Render a minutes value as a human-friendly "Xh Ym" / "X min" string. */
function formatMinutes(total: number): string {
  if (!total || total <= 0) return "disabled";
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  if (hours && minutes) return `${hours}h ${minutes}m`;
  if (hours) return `${hours}h`;
  return `${minutes} min`;
}

function SettingToggle({
  checked,
  onChange,
  label,
  description,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  description: string;
}) {
  return (
    <div className="grid gap-4 border border-[#D3D7DA] bg-[#F7F8F9] px-4 py-3 sm:grid-cols-[1fr_auto] sm:items-center">
      <div>
        <p className="text-sm font-semibold text-[#1F2933]">{label}</p>
        <p className="mt-1 text-xs leading-relaxed text-[#5E6870]">{description}</p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-[#287EAD]/30",
          checked ? "bg-[#287EAD]" : "bg-[#AEB5BB]",
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-5" : "translate-x-0.5",
          )}
        />
      </button>
    </div>
  );
}

function SettingBlock({
  icon: Icon,
  title,
  description,
  children,
}: {
  icon: React.ElementType;
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className={panelCls}>
      <div className={panelHeaderCls}>
        <div className="flex items-start gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center border border-[#A7CDE3] bg-[#EEF6FB] text-[#287EAD]">
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-[#1F2933]">{title}</h3>
            <p className="mt-0.5 text-xs leading-relaxed text-[#5E6870]">{description}</p>
          </div>
        </div>
      </div>
      <div className={sectionBodyCls}>{children}</div>
    </section>
  );
}

function InfoNote({ children }: { children: React.ReactNode }) {
  return (
    <div className="border border-[#D3D7DA] bg-[#F7F8F9] px-4 py-3 text-sm leading-relaxed text-[#5E6870]">
      {children}
    </div>
  );
}

function IdpUsageClientPanel({
  usage,
}: {
  usage?: IdpUsageReport;
}) {
  const summary = usage?.summary;
  const daily = usage?.daily ?? [];
  const maxDocs = Math.max(1, ...daily.map((d) => d.documents));

  const total = summary?.documents_processed ?? 0;
  const claude = summary?.claude_docs ?? 0;
  const needsManual = summary?.needs_manual_docs ?? 0;
  const failed = summary?.failed_docs ?? 0;
  const regex = summary?.regex_docs ?? 0;
  const successRate = summary?.success_rate_pct;

  return (
    <div className="space-y-4">
      {/* Headline: count + outcome pills */}
      <div>
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
          <span className="text-sm font-semibold text-[#1F2933]">
            {total > 0
              ? `${total} document${total !== 1 ? "s" : ""} processed this month`
              : "No documents processed yet"}
          </span>
          {successRate != null && (
            <span className="text-xs text-[#5E6870]">
              {successRate}% extracted successfully
            </span>
          )}
        </div>
        {total > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1">
            {claude > 0 && (
              <span className="text-xs text-[#5E6870]">
                <span className="font-semibold text-[#287EAD]">{claude}</span> Claude
              </span>
            )}
            {regex > 0 && (
              <span className="text-xs text-[#5E6870]">
                <span className="font-semibold text-[#1F2933]">{regex}</span> Pattern match
              </span>
            )}
            {needsManual > 0 && (
              <span className="text-xs text-[#5E6870]">
                <span className="font-semibold text-[#C47B1A]">{needsManual}</span> Needs review
              </span>
            )}
            {failed > 0 && (
              <span className="text-xs text-[#5E6870]">
                <span className="font-semibold text-[#9B2C2C]">{failed}</span> Failed
              </span>
            )}
          </div>
        )}
      </div>
      {/* Sparkline — fixed-width bars so 2 days don't blow up to fill the row */}
      {daily.length > 0 && (
        <div>
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
            Last {daily.length} days
          </p>
          <div className="overflow-x-auto">
            <div
              className="flex h-10 items-end gap-px"
              style={{ minWidth: `${daily.length * 10}px` }}
            >
              {daily.map((point) => (
                <div
                  key={point.date}
                  title={`${point.date}: ${point.documents} doc${point.documents !== 1 ? "s" : ""}`}
                  className="w-2 shrink-0 rounded-sm bg-[#287EAD]/70"
                  style={{ height: `${Math.max(8, (point.documents / maxDocs) * 100)}%` }}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function IdpUsageBillingPanel({
  usage,
  monthlyLimit,
  onMonthlyLimitChange,
}: {
  usage?: IdpUsageReport;
  monthlyLimit: string;
  onMonthlyLimitChange: (value: string) => void;
}) {
  const billing = usage?.billing;
  if (!billing) {
    return (
      <InfoNote>
        Token and cost data appear after Claude extractions have been recorded. Hard spend caps are
        configured in the Anthropic console — figures here are estimates for Flaxem only.
      </InfoNote>
    );
  }

  return (
    <div className="space-y-4">
      <InfoNote>
        Hard cap is Anthropic workspace spend. These figures are estimates for Flaxem operators and
        are not shown to client administrators.
      </InfoNote>
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="border border-[#D3D7DA] bg-[#F7F8F9] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Input tokens</p>
          <p className="mt-1 text-lg font-semibold text-[#1F2933]">
            {billing.input_tokens.toLocaleString()}
          </p>
        </div>
        <div className="border border-[#D3D7DA] bg-[#F7F8F9] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Output tokens</p>
          <p className="mt-1 text-lg font-semibold text-[#1F2933]">
            {billing.output_tokens.toLocaleString()}
          </p>
        </div>
        <div className="border border-[#D3D7DA] bg-[#F7F8F9] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Est. cost (month)</p>
          <p className="mt-1 text-lg font-semibold text-[#1F2933]">
            ${Number(billing.estimated_cost_usd).toFixed(4)}
            {billing.limit_used_pct != null ? ` (${billing.limit_used_pct}% of ref)` : ""}
          </p>
        </div>
      </div>
      <label className="block max-w-xs">
        <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
          Reference monthly limit (USD)
        </span>
        <input
          type="number"
          min={0}
          step="0.01"
          className={`${inputCls} w-full`}
          value={monthlyLimit}
          onChange={(event) => onMonthlyLimitChange(event.target.value)}
        />
        <span className="mt-1 block text-xs text-[#5E6870]">
          Not enforced — optional licence benchmark. Save settings to persist.
        </span>
      </label>
    </div>
  );
}

// ── Import cap modal ─────────────────────────────────────────────────────────
type ImportModal = { keyId: string; keyName: string; cap: string } | null;

// ── Spend progress bar (per-client row) ──────────────────────────────────────
function SpendBar({ cost, limit, pct }: { cost: string; limit: string; pct: number | null }) {
  if (!pct || Number(limit) <= 0) return null;
  const color =
    pct >= 90 ? "bg-[#9B2C2C]" : pct >= 80 ? "bg-[#C47B1A]" : "bg-[#287EAD]";
  const textColor =
    pct >= 90 ? "text-[#9B2C2C]" : pct >= 80 ? "text-[#C47B1A]" : "text-[#5E6870]";
  return (
    <div className="mt-1.5 space-y-0.5">
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#E4E7EA]">
        <div
          className={`h-full rounded-full transition-all ${color}`}
          style={{ width: `${Math.min(100, pct)}%` }}
        />
      </div>
      <p className={`text-[10px] font-semibold ${textColor}`}>
        {pct.toFixed(1)}% of ${Number(limit).toFixed(0)} cap
      </p>
    </div>
  );
}

function OpsBillingPanel() {
  const qc = useQueryClient();
  const [draftName, setDraftName] = useState("");
  const [draftKeyId, setDraftKeyId] = useState("");
  const [draftWs, setDraftWs] = useState("");
  const [draftLimit, setDraftLimit] = useState("");

  // Modal state for per-row import — prompts cap before importing a single key.
  const [importModal, setImportModal] = useState<ImportModal>(null);
  const [importBulkCap, setImportBulkCap] = useState("");

  const { data: report, isLoading } = useQuery({
    queryKey: ["billing-ops-usage"],
    queryFn: () => billingAPI.usage(30).then((r) => r.data),
    refetchInterval: 30_000,
  });

  const { data: discovered, isFetching: discovering } = useQuery({
    queryKey: ["billing-discovered-keys"],
    queryFn: () => billingAPI.discoveredKeys().then((r) => r.data),
    enabled: Boolean(report?.configured),
  });

  const syncMutation = useMutation({
    mutationFn: () => billingAPI.sync().then((r) => r.data),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["billing-ops-usage"] });
      if (result.ok) {
        toast.success(`Synced ${result.saved ?? 0} client(s) for ${result.day ?? "yesterday"}.`);
      } else {
        toast.error(result.reason || "Sync failed.");
      }
    },
    onError: (err) => toast.error(extractApiError(err, "Sync failed.")),
  });

  const importMutation = useMutation({
    mutationFn: ({ api_key_ids, cap }: { api_key_ids?: string[]; cap: string }) =>
      billingAPI
        .importKeys({ api_key_ids, monthly_limit_usd: cap || "0" })
        .then((r) => r.data),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ["billing-ops-usage"] });
      qc.invalidateQueries({ queryKey: ["billing-discovered-keys"] });
      setImportModal(null);
      if (result.ok) {
        toast.success(
          `Imported ${result.imported} key(s)`
            + (result.skipped ? ` (${result.skipped} already registered)` : "")
            + ".",
        );
      } else {
        toast.error(result.reason || "Import failed.");
      }
    },
    onError: (err) => toast.error(extractApiError(err, "Import failed.")),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      billingAPI.createClient({
        client_name: draftName.trim(),
        api_key_id: draftKeyId.trim(),
        workspace_id: draftWs.trim(),
        monthly_limit_usd: draftLimit || "0",
        is_active: true,
      }).then((r) => r.data),
    onSuccess: () => {
      setDraftName("");
      setDraftKeyId("");
      setDraftWs("");
      setDraftLimit("");
      qc.invalidateQueries({ queryKey: ["billing-ops-usage"] });
      qc.invalidateQueries({ queryKey: ["billing-discovered-keys"] });
      toast.success("Client registered.");
    },
    onError: (err) => toast.error(extractApiError(err, "Could not register client.")),
  });

  const deleteMutation = useMutation({
    mutationFn: (id: string) => billingAPI.deleteClient(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["billing-ops-usage"] });
      qc.invalidateQueries({ queryKey: ["billing-discovered-keys"] });
      toast.success("Client removed.");
    },
    onError: (err) => toast.error(extractApiError(err, "Could not remove client.")),
  });

  // Cap is the only editable field after import — name & api_key_id are locked.
  const [capDrafts, setCapDrafts] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!report?.clients) return;
    setCapDrafts((prev) => {
      const next = { ...prev };
      for (const c of report.clients) {
        if (next[c.id] === undefined) next[c.id] = String(c.monthly_limit_usd ?? "0");
      }
      return next;
    });
  }, [report?.clients]);

  const updateMutation = useMutation({
    mutationFn: ({ id, cap }: { id: string; cap: string }) =>
      billingAPI.updateClient(id, { monthly_limit_usd: cap }).then((r) => r.data),
    onSuccess: (saved) => {
      setCapDrafts((prev) => ({ ...prev, [saved.id]: String(saved.monthly_limit_usd ?? "0") }));
      qc.invalidateQueries({ queryKey: ["billing-ops-usage"] });
      toast.success(`Cap updated for ${saved.client_name}.`);
    },
    onError: (err) => toast.error(extractApiError(err, "Could not update cap.")),
  });

  const saveCapForRow = (c: { id: string; monthly_limit_usd: string }) => {
    const cap = (capDrafts[c.id] ?? String(c.monthly_limit_usd)).trim();
    const capNum = Math.max(0, Number(cap) || 0);
    if (String(capNum) === String(Number(c.monthly_limit_usd) || 0)) return;
    updateMutation.mutate({ id: c.id, cap: String(capNum) });
  };

  if (isLoading || !report) {
    return (
      <div className="flex min-h-[8rem] items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-[#287EAD]" />
      </div>
    );
  }

  const unregistered = (discovered?.keys ?? []).filter((k) => !k.registered);

  return (
    <div className="space-y-5">
      {/* Import cap modal (per-row) */}
      {importModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
          <div className="w-full max-w-sm border border-[#C8CDD2] bg-white p-5 shadow-xl">
            <h3 className="mb-1 text-sm font-semibold text-[#1F2933]">Import key</h3>
            <p className="mb-4 text-xs text-[#5E6870]">
              <span className="font-medium text-[#1F2933]">{importModal.keyName}</span>
              <span className="ml-1 font-mono text-[10px]">({importModal.keyId})</span>
            </p>
            <label className="block">
              <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                Monthly reference cap (USD)
              </span>
              <input
                type="number"
                min={0}
                step="0.01"
                autoFocus
                className={`${inputCls} w-full`}
                placeholder="0 = no cap"
                value={importModal.cap}
                onChange={(e) =>
                  setImportModal((prev) => prev ? { ...prev, cap: e.target.value } : prev)
                }
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    importMutation.mutate({ api_key_ids: [importModal.keyId], cap: importModal.cap });
                  } else if (e.key === "Escape") {
                    setImportModal(null);
                  }
                }}
              />
              <span className="mt-1 block text-xs text-[#5E6870]">
                Flaxem alert threshold only — hard stop remains the Anthropic workspace limit.
              </span>
            </label>
            <div className="mt-4 flex justify-end gap-2">
              <button
                type="button"
                className="border border-[#AEB5BB] bg-white px-3 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#EEF3F7]"
                onClick={() => setImportModal(null)}
              >
                Cancel
              </button>
              <button
                type="button"
                className="bg-[#287EAD] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50"
                disabled={importMutation.isPending}
                onClick={() =>
                  importMutation.mutate({ api_key_ids: [importModal.keyId], cap: importModal.cap })
                }
              >
                {importMutation.isPending ? <Loader2 className="inline h-3 w-3 animate-spin" /> : null}
                {" "}Import
              </button>
            </div>
          </div>
        </div>
      )}

      <InfoNote>
        Keys in your Anthropic organisation appear below. Import them into Flaxem to track spend;
        daily sync uses ANTHROPIC_ADMIN_KEY. Hard spend stops remain workspace caps in Anthropic.
        {!report.configured && (
          <>
            {" "}
            <strong className="font-semibold text-[#1F2933]">Admin key not configured</strong> — set
            ANTHROPIC_ADMIN_KEY on this deployment to enable discovery and sync.
          </>
        )}
      </InfoNote>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="border border-[#D3D7DA] bg-[#F7F8F9] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Clients</p>
          <p className="mt-1 text-lg font-semibold text-[#1F2933]">{report.summary.clients}</p>
        </div>
        <div className="border border-[#D3D7DA] bg-[#F7F8F9] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Month spend</p>
          <p className="mt-1 text-lg font-semibold text-[#1F2933]">
            ${Number(report.summary.cost_usd).toFixed(2)}
          </p>
        </div>
        <div className="border border-[#D3D7DA] bg-[#F7F8F9] px-3 py-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">Tokens (in / out)</p>
          <p className="mt-1 text-lg font-semibold text-[#1F2933]">
            {report.summary.input_tokens.toLocaleString()} / {report.summary.output_tokens.toLocaleString()}
          </p>
        </div>
      </div>

      {report.alerts.length > 0 && (
        <div className="border border-[#C45C26] bg-[#FFF7F2] px-3 py-2 text-sm text-[#1F2933]">
          {report.alerts.map((a) => (
            <p key={a.client_name}>
              ⚠ {a.client_name} — {a.pct.toFixed(0)}% of ${Number(a.monthly_limit_usd).toFixed(0)} cap (${Number(a.cost_usd).toFixed(2)} spent)
            </p>
          ))}
        </div>
      )}

      {report.configured && (
        <div className="space-y-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <p className="mb-1 text-sm font-semibold text-[#1F2933]">Keys in Anthropic organisation</p>
              <p className="text-xs text-[#5E6870]">Set a reference cap before importing — you can adjust it later.</p>
            </div>
            <div className="ml-auto flex items-center gap-2">
              <input
                type="number"
                min={0}
                step="0.01"
                placeholder="Cap USD (0 = none)"
                className={`${inputCls} w-32 text-xs`}
                value={importBulkCap}
                onChange={(e) => setImportBulkCap(e.target.value)}
                aria-label="Monthly cap for bulk import"
              />
              <button
                type="button"
                className="inline-flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-3 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#EEF3F7] disabled:opacity-50"
                disabled={importMutation.isPending || unregistered.length === 0}
                onClick={() => importMutation.mutate({ api_key_ids: undefined, cap: importBulkCap || "0" })}
              >
                {importMutation.isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                Import all unregistered ({unregistered.length})
              </button>
            </div>
          </div>
          {discovered?.error && (
            <p className="text-sm text-[#9B2C2C]">{discovered.error}</p>
          )}
          <div className="overflow-x-auto border border-[#D3D7DA]">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-[#F5F7F8] text-xs uppercase tracking-wider text-[#5E6870]">
                <tr>
                  <th className="px-3 py-2 font-semibold">Name</th>
                  <th className="px-3 py-2 font-semibold">Key id</th>
                  <th className="px-3 py-2 font-semibold">Hint</th>
                  <th className="px-3 py-2 font-semibold">Status</th>
                  <th className="px-3 py-2 font-semibold" />
                </tr>
              </thead>
              <tbody className="divide-y divide-[#D3D7DA]">
                {discovering && !discovered ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-[#5E6870]">Loading keys from Anthropic…</td>
                  </tr>
                ) : (discovered?.keys?.length ?? 0) === 0 ? (
                  <tr>
                    <td colSpan={5} className="px-3 py-4 text-[#5E6870]">No active keys returned by Anthropic.</td>
                  </tr>
                ) : (
                  discovered!.keys.map((k) => (
                    <tr key={k.id}>
                      <td className="px-3 py-2 font-medium text-[#1F2933]">{k.name}</td>
                      <td className="px-3 py-2 font-mono text-xs text-[#5E6870]">{k.id}</td>
                      <td className="px-3 py-2 font-mono text-xs text-[#5E6870]">{k.partial_key_hint || "—"}</td>
                      <td className="px-3 py-2 text-[#5E6870]">{k.registered ? "Registered" : "Not in Flaxem"}</td>
                      <td className="px-3 py-2 text-right">
                        {k.registered ? (
                          <span className="text-xs text-[#5E6870]">{k.registered_name}</span>
                        ) : (
                          <button
                            type="button"
                            className="text-xs font-semibold text-[#287EAD] hover:underline disabled:opacity-50"
                            disabled={importMutation.isPending}
                            onClick={() =>
                              setImportModal({ keyId: k.id, keyName: k.name, cap: importBulkCap || "" })
                            }
                          >
                            Import…
                          </button>
                        )}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Registered clients table — name & key locked; only cap is editable */}
      <div className="overflow-x-auto border border-[#D3D7DA]">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-[#F5F7F8] text-xs uppercase tracking-wider text-[#5E6870]">
            <tr>
              <th className="px-3 py-2 font-semibold">Client</th>
              <th className="px-3 py-2 font-semibold">Usage</th>
              <th className="px-3 py-2 font-semibold">Cost (month)</th>
              <th className="px-3 py-2 font-semibold">Ref. cap (USD)</th>
              <th className="px-3 py-2 font-semibold" />
            </tr>
          </thead>
          <tbody className="divide-y divide-[#D3D7DA]">
            {report.clients.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-4 text-[#5E6870]">
                  No clients registered yet — import keys from Anthropic above.
                </td>
              </tr>
            ) : (
              report.clients.map((c) => {
                const draftCap = capDrafts[c.id] ?? String(c.monthly_limit_usd ?? "0");
                const capDirty =
                  String(Math.max(0, Number(draftCap) || 0)) !== String(Number(c.monthly_limit_usd) || 0);
                return (
                  <tr key={c.id}>
                    {/* Client name — read-only after import */}
                    <td className="px-3 py-2">
                      <p className="font-medium text-[#1F2933]">{c.client_name}</p>
                      <p className="mt-0.5 font-mono text-[10px] text-[#5E6870]">{c.api_key_id}</p>
                    </td>
                    {/* Usage column: token totals + spend progress bar */}
                    <td className="px-3 py-2">
                      <p className="text-xs text-[#5E6870]">
                        <span className="font-semibold text-[#1F2933]">{c.input_tokens.toLocaleString()}</span> in
                        {" / "}
                        <span className="font-semibold text-[#1F2933]">{c.output_tokens.toLocaleString()}</span> out
                      </p>
                      <SpendBar cost={c.cost_usd} limit={c.monthly_limit_usd} pct={c.limit_used_pct} />
                    </td>
                    {/* Cost */}
                    <td className="px-3 py-2 text-[#1F2933]">
                      ${Number(c.cost_usd).toFixed(2)}
                    </td>
                    {/* Editable cap */}
                    <td className="px-3 py-2">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        className={`${inputCls} w-24`}
                        value={draftCap}
                        onChange={(e) =>
                          setCapDrafts((prev) => ({ ...prev, [c.id]: e.target.value }))
                        }
                        onBlur={() => saveCapForRow(c)}
                        aria-label={`Reference monthly cap for ${c.client_name}`}
                      />
                      <span className="mt-0.5 block text-[10px] text-[#5E6870]">
                        Alert threshold only
                      </span>
                    </td>
                    {/* Actions */}
                    <td className="px-3 py-2 text-right">
                      <div className="flex flex-col items-end gap-1">
                        {capDirty && (
                          <button
                            type="button"
                            className="text-xs font-semibold text-[#287EAD] hover:underline disabled:opacity-50"
                            disabled={updateMutation.isPending}
                            onClick={() => saveCapForRow(c)}
                          >
                            Save
                          </button>
                        )}
                        <button
                          type="button"
                          className="text-xs font-semibold text-[#9B2C2C] hover:underline"
                          onClick={() => {
                            if (window.confirm(`Remove ${c.client_name}?`)) {
                              deleteMutation.mutate(c.id);
                            }
                          }}
                        >
                          Remove
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Manual register form */}
      <details className="border border-[#D3D7DA]">
        <summary className="cursor-pointer select-none bg-[#F7F8F9] px-4 py-2.5 text-xs font-semibold uppercase tracking-wider text-[#5E6870] hover:bg-[#EEF3F7]">
          Register client manually
        </summary>
        <div className="grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
          <label>
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Client name</span>
            <input className={`${inputCls} w-full`} value={draftName} onChange={(e) => setDraftName(e.target.value)} placeholder="Acme Ltd" />
          </label>
          <label>
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">API key id</span>
            <input className={`${inputCls} w-full`} value={draftKeyId} onChange={(e) => setDraftKeyId(e.target.value)} placeholder="apikey_…" />
          </label>
          <label>
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Workspace id (optional)</span>
            <input className={`${inputCls} w-full`} value={draftWs} onChange={(e) => setDraftWs(e.target.value)} placeholder="wrkspc_…" />
          </label>
          <label>
            <span className="mb-1 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Monthly limit USD</span>
            <input type="number" min={0} step="0.01" className={`${inputCls} w-full`} value={draftLimit} onChange={(e) => setDraftLimit(e.target.value)} />
          </label>
        </div>
        <div className="flex gap-2 px-3 pb-3">
          <button
            type="button"
            className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50"
            disabled={createMutation.isPending || !draftName.trim() || !draftKeyId.trim()}
            onClick={() => createMutation.mutate()}
          >
            {createMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
            Register
          </button>
        </div>
      </details>

      <div className="flex justify-end">
        <button
          type="button"
          className="inline-flex items-center gap-2 border border-[#AEB5BB] bg-white px-4 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#EEF3F7] disabled:opacity-50"
          disabled={syncMutation.isPending || !report.configured || report.summary.clients === 0}
          onClick={() => syncMutation.mutate()}
        >
          {syncMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Sync usage now
        </button>
      </div>
    </div>
  );
}

function SettingsWorkspace() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isPlatformOps = Boolean(user?.is_staff || user?.is_superuser);
  const sections = useMemo(
    () => baseSections.filter((s) => !s.opsOnly || isPlatformOps),
    [isPlatformOps],
  );
  const [activeSection, setActiveSection] = useState<SectionId>("preview");
  const [draft, setDraft] = useState<DmsSettings | null>(null);
  const [opsMonthlyLimit, setOpsMonthlyLimit] = useState<string>("");

  useEffect(() => {
    if (activeSection === "ops_billing" && !isPlatformOps) {
      setActiveSection("preview");
    }
  }, [activeSection, isPlatformOps]);

  const { data, isLoading } = useQuery({
    queryKey: ["dms-settings"],
    queryFn: () => dmsSettingsAPI.get().then((r) => r.data),
    refetchInterval: activeSection === "idp" ? 5000 : false,
  });

  const { data: idpUsage } = useQuery({
    queryKey: ["idp-usage"],
    queryFn: () => dmsSettingsAPI.idpUsage(30).then((r) => r.data),
    enabled: activeSection === "idp",
    refetchInterval: activeSection === "idp" ? 5000 : false,
  });

  // Keep pages-used counter in sync while viewing IDP settings (OCR jobs increment it server-side).
  useEffect(() => {
    if (!data) return;
    setDraft((prev) => {
      if (!prev) return null;
      if (prev.idp_pages_used === data.idp_pages_used) return prev;
      return { ...prev, idp_pages_used: data.idp_pages_used };
    });
  }, [data]);

  useEffect(() => {
    if (idpUsage?.billing?.monthly_limit_usd != null) {
      setOpsMonthlyLimit(idpUsage.billing.monthly_limit_usd);
    }
  }, [idpUsage?.billing?.monthly_limit_usd]);

  const settings = draft ?? data ?? null;
  const opsLimitDirty = Boolean(
    isPlatformOps
    && idpUsage?.billing
    && opsMonthlyLimit !== ""
    && opsMonthlyLimit !== String(idpUsage.billing.monthly_limit_usd),
  );
  const hasChanges = Boolean(
    (draft && data && JSON.stringify(draft) !== JSON.stringify(data))
    || opsLimitDirty,
  );

  const mutation = useMutation({
    mutationFn: (payload: Partial<DmsSettings> & { idp_monthly_limit_usd?: number | string }) =>
      dmsSettingsAPI.update(payload).then((r) => r.data),
    onSuccess: (saved) => {
      setDraft(saved);
      qc.setQueryData(["dms-settings"], saved);
      qc.invalidateQueries({ queryKey: ["idp-usage"] });
      toast.success("DMS settings saved.");
    },
    onError: (err) => toast.error(extractApiError(err, "Could not save DMS settings.")),
  });

  const update = <K extends keyof DmsSettings>(key: K, value: DmsSettings[K]) => {
    if (!settings) return;
    setDraft({ ...settings, [key]: value });
  };

  const reset = () => setDraft(data ?? null);
  const save = () => {
    if (!settings) return;
    const payload: Partial<DmsSettings> & { idp_monthly_limit_usd?: number } = { ...settings };
    if (isPlatformOps && opsMonthlyLimit !== "") {
      payload.idp_monthly_limit_usd = Math.max(0, Number(opsMonthlyLimit) || 0);
    }
    mutation.mutate(payload);
  };

  const summary = useMemo(() => {
    if (!settings) return [];
    const docs = idpUsage?.summary.documents_processed;
    return [
      { label: "Watermark", value: settings.watermark_enabled ? "Enabled" : "Off" },
      { label: "Duplicates", value: settings.allow_duplicate_uploads ? "Allowed" : "Blocked" },
      { label: "Access mode", value: settings.rbac_single_stage ? "Global" : "Stage-based" },
      { label: "Session", value: formatMinutes(settings.session_lifetime_minutes) },
      {
        label: "Idle out",
        value: settings.session_idle_timeout_minutes > 0
          ? formatMinutes(settings.session_idle_timeout_minutes)
          : "Off",
      },
      {
        label: "IDP fallback",
        value: settings.idp_fallback_policy === "claude_only"
          ? "Claude only"
          : settings.idp_fallback_policy === "claude_ask"
            ? "Ask on failure"
            : "Regex allowed",
      },
      {
        label: "Docs this month",
        value: docs != null ? String(docs) : String(settings.idp_pages_used),
      },
    ];
  }, [settings, idpUsage]);

  if (isLoading || !settings) {
    return (
      <div className="flex min-h-[24rem] items-center justify-center border border-[#C8CDD2] bg-white">
        <Loader2 className="h-6 w-6 animate-spin text-[#287EAD]" />
      </div>
    );
  }

  return (
    <div className="grid min-h-[calc(100vh-12rem)] grid-cols-1 border border-[#C8CDD2] bg-white lg:grid-cols-[290px_1fr]">
      <aside className="border-b border-[#C8CDD2] bg-[#F6F7F8] lg:border-b-0 lg:border-r">
        <div className="border-b border-[#C8CDD2] px-4 py-3">
          <p className="text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Settings groups</p>
        </div>
        <div className="divide-y divide-[#D3D7DA]">
          {sections.map((section) => {
            const Icon = section.icon;
            const active = activeSection === section.id;
            return (
              <button
                key={section.id}
                type="button"
                onClick={() => setActiveSection(section.id)}
                className={clsx(
                  "flex w-full gap-3 px-4 py-3 text-left transition-colors",
                  active ? "bg-[#348FBE] text-white" : "bg-[#F6F7F8] text-[#1F2933] hover:bg-white",
                )}
              >
                <Icon className={clsx("mt-0.5 h-4 w-4 shrink-0", active ? "text-white" : "text-[#287EAD]")} />
                <span>
                  <span className="block text-sm font-semibold">{section.title}</span>
                  <span className={clsx("mt-0.5 block text-xs", active ? "text-white/80" : "text-[#5E6870]")}>
                    {section.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
        <div className="m-4 border border-[#C8CDD2] bg-white">
          <div className="border-b border-[#D3D7DA] bg-[#F5F7F8] px-3 py-2 text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
            Current Policy
          </div>
          <div className="divide-y divide-[#D3D7DA]">
            {summary.map((item) => (
              <div key={item.label} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                <span className="text-[#5E6870]">{item.label}</span>
                <span className="font-semibold text-[#1F2933]">{item.value}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>

      <main className="min-w-0 bg-[#EDEDED]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#C8CDD2] bg-[#F5F7F8] px-5 py-3">
          <div>
            <h2 className="text-base font-semibold text-[#1F2933]">
              {sections.find((section) => section.id === activeSection)?.title}
            </h2>
            <p className="mt-0.5 text-sm text-[#5E6870]">
              {sections.find((section) => section.id === activeSection)?.description}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {activeSection !== "ops_billing" && hasChanges && (
              <span className="text-xs font-semibold text-[#287EAD]">Unsaved changes</span>
            )}
            {activeSection !== "ops_billing" && (
              <>
            <button
              type="button"
              onClick={reset}
              className="inline-flex items-center gap-2 border border-[#AEB5BB] bg-white px-3 py-2 text-sm font-semibold text-[#1F2933] hover:bg-[#EEF3F7] disabled:opacity-50"
              disabled={mutation.isPending || !hasChanges}
            >
              <RotateCcw className="h-4 w-4" />
              Reset
            </button>
            <button
              type="button"
              onClick={save}
              className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white hover:bg-[#1E6F99] disabled:opacity-50"
              disabled={mutation.isPending || !hasChanges}
            >
              {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
              Save
            </button>
              </>
            )}
          </div>
        </div>

        <div className="space-y-5 p-5 pr-8">
          {activeSection === "preview" && (
            <>
              <SettingBlock
                icon={Droplets}
                title="Watermarks"
                description="Apply visible marks to restricted previews without changing the original file."
              >
                <SettingToggle
                  checked={settings.watermark_enabled}
                  onChange={(checked) => update("watermark_enabled", checked)}
                  label="Watermark view-only previews"
                  description="Show a watermark only when the viewer does not have download permission."
                />
                <div className="grid gap-4 sm:grid-cols-2">
                  <label>
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Watermark text</span>
                    <input
                      className={`${inputCls} w-full`}
                      value={settings.watermark_text}
                      onChange={(event) => update("watermark_text", event.target.value)}
                      placeholder="CONFIDENTIAL"
                    />
                  </label>
                  <label>
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Position</span>
                    <CustomListbox
                      value={settings.watermark_position}
                      onChange={(v) => update("watermark_position", v as DmsSettings["watermark_position"])}
                      options={[
                        { value: "diagonal", label: "Diagonal pattern" },
                        { value: "center", label: "Centered" },
                        { value: "footer", label: "Footer strip" },
                      ]}
                      buttonClassName={`${inputCls} w-full`}
                      ariaLabel="Watermark position"
                    />
                  </label>
                </div>
                <label className="block">
                  <span className="mb-2 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                    Opacity: {settings.watermark_opacity}%
                  </span>
                  <input
                    type="range"
                    min={1}
                    max={80}
                    value={settings.watermark_opacity}
                    onChange={(event) => update("watermark_opacity", Number(event.target.value))}
                    className="w-full accent-[#287EAD]"
                  />
                </label>
              </SettingBlock>

              <SettingBlock
                icon={Link2}
                title="Signed file links"
                description="Control whether previews and downloads can use short-lived file URLs."
              >
                <SettingToggle
                  checked={settings.signed_file_urls_enabled}
                  onChange={(checked) => update("signed_file_urls_enabled", checked)}
                  label="Issue signed file URLs"
                  description="Create short-lived query links for previews, printing, and direct downloads."
                />
                <InfoNote>
                  When this is off, file access uses the normal authenticated API request instead of a URL token.
                </InfoNote>
              </SettingBlock>
            </>
          )}

          {activeSection === "lifecycle" && (
            <>
              <SettingBlock
                icon={Archive}
                title="Automatic archiving"
                description="Move approved documents into archive after they have aged out."
              >
                <SettingToggle
                  checked={settings.auto_archive_enabled}
                  onChange={(checked) => update("auto_archive_enabled", checked)}
                  label="Enable automatic archiving"
                  description="A scheduled job checks approved documents every hour."
                />
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                    Archive approved documents after
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      className={`${inputCls} w-32`}
                      value={settings.auto_archive_after_days}
                      onChange={(event) => update("auto_archive_after_days", Math.max(1, Number(event.target.value) || 1))}
                    />
                    <span className="text-sm text-[#5E6870]">days since last update</span>
                  </div>
                </label>
              </SettingBlock>

              <SettingBlock
                icon={Trash2}
                title="Trash auto-empty"
                description="Permanently remove documents that exceed the trash retention period."
              >
                <SettingToggle
                  checked={settings.trash_auto_empty_enabled}
                  onChange={(checked) => update("trash_auto_empty_enabled", checked)}
                  label="Automatically empty Trash"
                  description="A scheduled job permanently removes documents left in Trash too long."
                />
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                    Empty documents from Trash after
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={1}
                      className={`${inputCls} w-32`}
                      value={settings.trash_retention_days}
                      onChange={(event) => update("trash_retention_days", Math.max(1, Number(event.target.value) || 1))}
                    />
                    <span className="text-sm text-[#5E6870]">days in Trash</span>
                  </div>
                </label>
                <InfoNote>Permanent deletion cannot be undone. Restore anything worth keeping before it ages out.</InfoNote>
              </SettingBlock>
            </>
          )}

          {activeSection === "governance" && (
            <>
              <SettingBlock
                icon={Building2}
                title="Organization identity"
                description="Used to auto-fill {{company_name}} / {{company_address}} merge fields in document templates."
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <label>
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Organization name</span>
                    <input
                      className={`${inputCls} w-full`}
                      value={settings.organization_name ?? ""}
                      onChange={(event) => update("organization_name", event.target.value)}
                      placeholder="e.g. Fairfield Systems Ltd"
                    />
                  </label>
                  <label>
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">Organization address</span>
                    <input
                      className={`${inputCls} w-full`}
                      value={settings.organization_address ?? ""}
                      onChange={(event) => update("organization_address", event.target.value)}
                      placeholder="e.g. 12 Market St, Nairobi"
                    />
                  </label>
                </div>
              </SettingBlock>

              <SettingBlock
                icon={Copy}
                title="Duplicate uploads"
                description="Choose whether users may upload the same file checksum more than once."
              >
                <SettingToggle
                  checked={settings.allow_duplicate_uploads}
                  onChange={(checked) => update("allow_duplicate_uploads", checked)}
                  label="Allow duplicate uploads"
                  description="When off, duplicate files uploaded by the same user are blocked before storage."
                />
                <SettingToggle
                  checked={settings.purge_trashed_duplicates_on_reupload}
                  onChange={(checked) => update("purge_trashed_duplicates_on_reupload", checked)}
                  label="Replace trashed copies on re-upload"
                  description="A document in Trash never blocks a re-upload. With this on, re-uploading the same file also permanently removes the uploader's trashed copy, instead of leaving both."
                />
                <InfoNote>
                  Current mode:{" "}
                  <span className="font-semibold text-[#1F2933]">
                    {settings.allow_duplicate_uploads ? "duplicates allowed" : "duplicates blocked"}
                  </span>
                  {settings.purge_trashed_duplicates_on_reupload && (
                    <> · re-uploads replace the trashed copy</>
                  )}
                </InfoNote>
              </SettingBlock>

              <SettingBlock
                icon={ShieldCheck}
                title="Permission stages"
                description="Choose whether group permissions are configured per lifecycle stage."
              >
                <SettingToggle
                  checked={settings.rbac_single_stage}
                  onChange={(checked) => update("rbac_single_stage", checked)}
                  label="Single global stage"
                  description="When on, one permission set applies across the entire lifecycle and the stage selector is hidden in Groups."
                />
                <InfoNote>
                  Default is stage-based: separate permissions for Creation, For approval, and After approval.
                  Reconfigure group permissions after changing this mode.
                </InfoNote>
              </SettingBlock>

              <SettingBlock
                icon={ClipboardCheck}
                title="Upload governance"
                description="Metadata rules that keep uploads consistent across document types."
              >
                <SettingToggle
                  checked={settings.require_metadata_on_upload}
                  onChange={(checked) => update("require_metadata_on_upload", checked)}
                  label="Require configured metadata"
                  description="Keep admin-defined required metadata checks active during uploads."
                />
                <InfoNote>
                  Required metadata is checked against each document type&apos;s admin-defined required fields.
                </InfoNote>
              </SettingBlock>
            </>
          )}

          {activeSection === "idp" && (
            <>
              <SettingBlock
                icon={Sparkles}
                title="Claude extraction"
                description="Control whether paid Claude IDP runs and how failures are handled."
              >
                <SettingToggle
                  checked={settings.idp_claude_enabled}
                  onChange={(checked) => update("idp_claude_enabled", checked)}
                  label="Enable Claude extraction"
                  description="Turn off when the subscription ends. Documents will not call Claude until re-enabled."
                />
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                    When Claude cannot run
                  </span>
                  <CustomListbox
                    value={settings.idp_fallback_policy}
                    onChange={(v) => {
                      if (!settings) return;
                      const policy = v as DmsSettings["idp_fallback_policy"];
                      setDraft({
                        ...settings,
                        idp_fallback_policy: policy,
                        idp_allow_regex_fallback: policy === "claude_then_regex"
                          ? true
                          : settings.idp_allow_regex_fallback,
                      });
                    }}
                    options={[
                      { value: "claude_only", label: "Leave fields empty (recommended)" },
                      { value: "claude_ask", label: "Ask the uploader on single upload" },
                      { value: "claude_then_regex", label: "Allow pattern matching as last resort" },
                    ]}
                    buttonClassName={`${inputCls} w-full`}
                    ariaLabel="IDP fallback policy"
                  />
                </label>
                <SettingToggle
                  checked={settings.idp_allow_regex_fallback}
                  onChange={(checked) => update("idp_allow_regex_fallback", checked)}
                  label="Allow pattern matching fallback"
                  description="Permits the local regex pipeline when policy allows it or the uploader opts in. Values are labelled as guessed."
                />
                <InfoNote>
                  Bulk upload and mailbox ingestion follow this policy without prompting.
                  Subscription end should disable Claude above — do not rely on regex as a silent substitute.
                </InfoNote>
              </SettingBlock>

              <SettingBlock
                icon={Sparkles}
                title="Document extraction activity"
                description="Documents processed this month and Claude extraction success rate."
              >
                <IdpUsageClientPanel usage={idpUsage} />
              </SettingBlock>

              {isPlatformOps && (
                <SettingBlock
                  icon={Sparkles}
                  title="Anthropic spend (Flaxem ops)"
                  description="Token and cost estimates from Claude responses. Hard caps remain in the Anthropic workspace console."
                >
                  <IdpUsageBillingPanel
                    usage={idpUsage}
                    monthlyLimit={opsMonthlyLimit}
                    onMonthlyLimitChange={setOpsMonthlyLimit}
                  />
                </SettingBlock>
              )}
            </>
          )}

          {activeSection === "ops_billing" && isPlatformOps && (
            <SettingBlock
              icon={Wallet}
              title="All clients — Anthropic usage"
              description="Official Usage/Cost from the Anthropic Admin API, grouped by registered client keys."
            >
              <OpsBillingPanel />
            </SettingBlock>
          )}

          {activeSection === "security" && (
            <>
              <SettingBlock
                icon={Clock}
                title="Session lifetime"
                description="The maximum time a signed-in session stays valid before users must sign in again, regardless of activity."
              >
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                    Sign users out after
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={5}
                      className={`${inputCls} w-32`}
                      value={settings.session_lifetime_minutes}
                      onChange={(event) =>
                        update("session_lifetime_minutes", Math.max(5, Number(event.target.value) || 5))
                      }
                    />
                    <span className="text-sm text-[#5E6870]">
                      minutes since sign-in · {formatMinutes(settings.session_lifetime_minutes)}
                    </span>
                  </div>
                </label>
                <InfoNote>
                  This is the absolute cap. When it elapses the session ends even if the user is active, and they
                  are returned to the sign-in screen.
                </InfoNote>
              </SettingBlock>

              <SettingBlock
                icon={Timer}
                title="Inactivity timeout"
                description="Sign users out after a period with no interaction (mouse, keyboard, scrolling, or navigation)."
              >
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                    Sign idle users out after
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={settings.session_lifetime_minutes}
                      className={`${inputCls} w-32`}
                      value={settings.session_idle_timeout_minutes}
                      onChange={(event) =>
                        update(
                          "session_idle_timeout_minutes",
                          Math.max(0, Number(event.target.value) || 0),
                        )
                      }
                    />
                    <span className="text-sm text-[#5E6870]">
                      minutes of inactivity ·{" "}
                      {settings.session_idle_timeout_minutes > 0
                        ? formatMinutes(settings.session_idle_timeout_minutes)
                        : "disabled"}
                    </span>
                  </div>
                </label>
                <InfoNote>
                  Set to <span className="font-semibold text-[#1F2933]">0</span> to disable the inactivity timeout —
                  only the absolute session lifetime will apply. The idle timeout cannot exceed the session
                  lifetime.
                </InfoNote>
              </SettingBlock>

              <SettingBlock
                icon={BellRing}
                title="Expiry warning"
                description="Warn users before their session ends, with the option to stay signed in when the timeout is due to inactivity."
              >
                <label className="block">
                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                    Show the warning before expiry
                  </span>
                  <div className="flex items-center gap-2">
                    <input
                      type="number"
                      min={0}
                      max={settings.session_lifetime_minutes}
                      className={`${inputCls} w-32`}
                      value={settings.session_warning_minutes}
                      onChange={(event) =>
                        update(
                          "session_warning_minutes",
                          Math.max(0, Number(event.target.value) || 0),
                        )
                      }
                    />
                    <span className="text-sm text-[#5E6870]">
                      minutes before sign-out ·{" "}
                      {settings.session_warning_minutes > 0
                        ? formatMinutes(settings.session_warning_minutes)
                        : "disabled"}
                    </span>
                  </div>
                </label>
                <InfoNote>
                  Set to <span className="font-semibold text-[#1F2933]">0</span> to disable the warning. For very short
                  timeouts the warning is automatically capped to half the remaining window so it never appears the
                  instant a session begins.
                </InfoNote>
              </SettingBlock>
            </>
          )}
        </div>
      </main>
    </div>
  );
}

export default function AdminPage() {
  return (
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#EDEDED] text-[#1F2933]">
      <div className="border-b border-[#C8CDD2] bg-[#F5F7F8] px-6 py-4">
        <h1 className="text-xl font-semibold tracking-tight text-[#1F2933]">DMS Settings</h1>
        <p className="mt-1 text-sm text-[#5E6870]">
          Configure document handling, preview access, retention, and upload governance.
        </p>
      </div>
      <div className="p-5 pr-8">
        <SettingsWorkspace />
      </div>
    </div>
  );
}
