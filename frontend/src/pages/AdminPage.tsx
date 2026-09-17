import { useEffect, useMemo, useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dmsSettingsAPI, type DmsSettings, type IdpUsageReport } from "@/services/api";
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
} from "lucide-react";
import CustomListbox from "@/components/ui/CustomListbox";
import clsx from "clsx";

type SectionId = "preview" | "lifecycle" | "governance" | "idp" | "security";

const inputCls =
  "h-9 border border-[#AEB5BB] bg-white px-3 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";

const panelCls = "border border-[#C8CDD2] bg-white";
const panelHeaderCls = "border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3";
const sectionBodyCls = "space-y-5 p-4";

const sections: Array<{
  id: SectionId;
  title: string;
  description: string;
  icon: React.ElementType;
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
  pagesUsed,
}: {
  usage?: IdpUsageReport;
  pagesUsed: number;
}) {
  const summary = usage?.summary;
  const daily = usage?.daily ?? [];
  const maxDocs = Math.max(1, ...daily.map((d) => d.documents));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-4">
        {[
          { label: "Processed (month)", value: summary?.documents_processed ?? "—" },
          { label: "Claude extracted", value: summary?.claude_docs ?? "—" },
          { label: "Needs manual", value: summary?.needs_manual_docs ?? "—" },
          {
            label: "Success rate",
            value: summary?.success_rate_pct != null ? `${summary.success_rate_pct}%` : "—",
          },
        ].map((item) => (
          <div key={item.label} className="border border-[#D3D7DA] bg-[#F7F8F9] px-3 py-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-[#5E6870]">{item.label}</p>
            <p className="mt-1 text-lg font-semibold text-[#1F2933]">{item.value}</p>
          </div>
        ))}
      </div>
      <p className="text-xs text-[#5E6870]">
        Claude pages since reset: <span className="font-semibold text-[#1F2933]">{pagesUsed}</span>
        {summary?.failed_docs ? ` · Failed: ${summary.failed_docs}` : ""}
        {summary?.regex_docs ? ` · Pattern matching: ${summary.regex_docs}` : ""}
      </p>
      {daily.length > 0 && (
        <div>
          <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
            Last {daily.length} days
          </p>
          <div className="flex h-16 items-end gap-0.5">
            {daily.map((point) => (
              <div
                key={point.date}
                title={`${point.date}: ${point.documents} docs`}
                className="min-w-0 flex-1 bg-[#287EAD]/80"
                style={{ height: `${Math.max(4, (point.documents / maxDocs) * 100)}%` }}
              />
            ))}
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

function SettingsWorkspace() {
  const qc = useQueryClient();
  const user = useAuthStore((s) => s.user);
  const isPlatformOps = Boolean(user?.is_staff || user?.is_superuser);
  const [activeSection, setActiveSection] = useState<SectionId>("preview");
  const [draft, setDraft] = useState<DmsSettings | null>(null);
  const [opsMonthlyLimit, setOpsMonthlyLimit] = useState<string>("");

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
            {hasChanges && <span className="text-xs font-semibold text-[#287EAD]">Unsaved changes</span>}
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
                description="How many documents were processed this month and how often Claude extraction succeeded."
              >
                <IdpUsageClientPanel usage={idpUsage} pagesUsed={settings.idp_pages_used} />
                <div className="grid gap-4 sm:grid-cols-2">
                  <label>
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                      Pages used (since last reset)
                    </span>
                    <input
                      type="number"
                      min={0}
                      className={`${inputCls} w-full`}
                      value={settings.idp_pages_used}
                      onChange={(event) =>
                        update("idp_pages_used", Math.max(0, Number(event.target.value) || 0))
                      }
                    />
                    <span className="mt-1 block text-xs text-[#5E6870]">
                      Volume counter for Claude pages. Does not block extraction — reset manually when starting a new reporting period.
                    </span>
                  </label>
                  <label>
                    <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wider text-[#5E6870]">
                      Reference page target (optional)
                    </span>
                    <input
                      type="number"
                      min={0}
                      className={`${inputCls} w-full`}
                      value={settings.idp_page_allowance}
                      onChange={(event) =>
                        update("idp_page_allowance", Math.max(0, Number(event.target.value) || 0))
                      }
                    />
                    <span className="mt-1 block text-xs text-[#5E6870]">
                      Optional benchmark only (0 = hide). Hard spend limits are set in Anthropic, not here.
                    </span>
                  </label>
                </div>
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
