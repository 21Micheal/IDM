import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { dmsSettingsAPI, type DmsSettings } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import {
  Copy, Archive, Droplets, ClipboardCheck, Loader2, RotateCcw, Save,
  Link2, Trash2,
} from "lucide-react";
import clsx from "clsx";

function SettingsTab() {
  const qc = useQueryClient();
  const { data, isLoading } = useQuery({
    queryKey: ["dms-settings"],
    queryFn: () => dmsSettingsAPI.get().then((r) => r.data),
  });
  const [draft, setDraft] = useState<DmsSettings | null>(null);
  const settings = draft ?? data ?? null;

  const mutation = useMutation({
    mutationFn: (payload: Partial<DmsSettings>) => dmsSettingsAPI.update(payload).then((r) => r.data),
    onSuccess: (saved) => {
      setDraft(saved);
      qc.setQueryData(["dms-settings"], saved);
      toast.success("DMS settings saved.");
    },
    onError: () => toast.error("Could not save DMS settings."),
  });

  const update = <K extends keyof DmsSettings>(key: K, value: DmsSettings[K]) => {
    if (!settings) return;
    setDraft({ ...settings, [key]: value });
  };

  const reset = () => setDraft(data ?? null);

  const save = () => {
    if (!settings) return;
    mutation.mutate(settings);
  };

  const Toggle = ({
    checked,
    onChange,
    label,
    description,
  }: {
    checked: boolean;
    onChange: (checked: boolean) => void;
    label: string;
    description: string;
  }) => (
    <label className="flex items-start justify-between gap-4 rounded-lg border border-border bg-card px-4 py-3">
      <span>
        <span className="block text-sm font-semibold text-foreground">{label}</span>
        <span className="mt-0.5 block text-xs text-muted-foreground">{description}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        onClick={() => onChange(!checked)}
        className={clsx(
          "relative h-6 w-11 flex-shrink-0 rounded-full transition-colors focus:outline-none focus:ring-2 focus:ring-ring",
          checked ? "bg-primary" : "bg-muted-foreground/30"
        )}
      >
        <span
          className={clsx(
            "absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform",
            checked ? "translate-x-5" : "translate-x-0.5"
          )}
        />
      </button>
    </label>
  );

  if (isLoading || !settings) {
    return (
      <div className="flex h-48 items-center justify-center rounded-lg border border-border bg-card">
        <Loader2 className="h-6 w-6 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold text-foreground">DMS behaviour</h2>
          <p className="text-sm text-muted-foreground mt-1">
            Configure document handling rules that apply across uploads, previews, and lifecycle automation.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={reset} className="btn-secondary" disabled={mutation.isPending}>
            <RotateCcw className="h-4 w-4" /> Reset
          </button>
          <button type="button" onClick={save} className="btn-primary" disabled={mutation.isPending}>
            {mutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save settings
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        <section className="card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-accent/10 text-accent">
              <Droplets className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Watermarks</h3>
              <p className="text-sm text-muted-foreground">
                Disabled by default. When enabled, view-only previews carry the configured watermark.
              </p>
            </div>
          </div>
          <Toggle
            checked={settings.watermark_enabled}
            onChange={(checked) => update("watermark_enabled", checked)}
            label="Watermark view-only previews"
            description="Show a watermark only when the viewer does not have download permission."
          />
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label>
              <span className="label">Watermark text</span>
              <input
                className="input"
                value={settings.watermark_text}
                onChange={(e) => update("watermark_text", e.target.value)}
                placeholder="CONFIDENTIAL"
              />
            </label>
            <label>
              <span className="label">Position</span>
              <select
                className="input"
                value={settings.watermark_position}
                onChange={(e) => update("watermark_position", e.target.value as DmsSettings["watermark_position"])}
              >
                <option value="diagonal">Diagonal pattern</option>
                <option value="center">Centered</option>
                <option value="footer">Footer strip</option>
              </select>
            </label>
          </div>
          <label>
            <span className="label">Opacity: {settings.watermark_opacity}%</span>
            <input
              type="range"
              min={1}
              max={80}
              value={settings.watermark_opacity}
              onChange={(e) => update("watermark_opacity", Number(e.target.value))}
              className="w-full accent-primary"
            />
          </label>
        </section>

        <section className="card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-violet-500/10 text-violet-700">
              <Link2 className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Signed file links</h3>
              <p className="text-sm text-muted-foreground">
                Disabled by default. Enable only when browser-native file links are required.
              </p>
            </div>
          </div>
          <Toggle
            checked={settings.signed_file_urls_enabled}
            onChange={(checked) => update("signed_file_urls_enabled", checked)}
            label="Issue signed file URLs"
            description="Create short-lived query links for previews, printing, and direct downloads."
          />
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            When off, file access uses the normal authenticated API request instead of a URL token.
          </div>
        </section>

        <section className="card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-[hsl(var(--teal))]/10 text-[hsl(var(--teal))]">
              <Copy className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Duplicate uploads</h3>
              <p className="text-sm text-muted-foreground">
                Choose whether users may upload the same file checksum more than once.
              </p>
            </div>
          </div>
          <Toggle
            checked={settings.allow_duplicate_uploads}
            onChange={(checked) => update("allow_duplicate_uploads", checked)}
            label="Allow duplicate uploads"
            description="When off, duplicate files uploaded by the same user are blocked before storage."
          />
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            Current mode:{" "}
            <span className="font-semibold text-foreground">
              {settings.allow_duplicate_uploads ? "duplicates allowed" : "duplicates blocked"}
            </span>
          </div>
        </section>

        <section className="card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-sky-500/10 text-sky-700">
              <Archive className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Automatic archiving</h3>
              <p className="text-sm text-muted-foreground">
                Approved documents can be moved to archive automatically after they have aged out.
              </p>
            </div>
          </div>
          <Toggle
            checked={settings.auto_archive_enabled}
            onChange={(checked) => update("auto_archive_enabled", checked)}
            label="Enable automatic archiving"
            description="A scheduled job checks approved documents every hour."
          />
          <label className="block">
            <span className="label">Archive approved documents after</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                className="input max-w-36"
                value={settings.auto_archive_after_days}
                onChange={(e) => update("auto_archive_after_days", Math.max(1, Number(e.target.value) || 1))}
              />
              <span className="text-sm text-muted-foreground">days since last update</span>
            </div>
          </label>
        </section>

        <section className="card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-rose-500/10 text-rose-700">
              <Trash2 className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Trash auto-empty</h3>
              <p className="text-sm text-muted-foreground">
                Permanently delete documents that have stayed in Trash beyond the retention period.
              </p>
            </div>
          </div>
          <Toggle
            checked={settings.trash_auto_empty_enabled}
            onChange={(checked) => update("trash_auto_empty_enabled", checked)}
            label="Automatically empty Trash"
            description="A scheduled job permanently removes documents left in Trash too long."
          />
          <label className="block">
            <span className="label">Empty documents from Trash after</span>
            <div className="flex items-center gap-2">
              <input
                type="number"
                min={1}
                className="input max-w-36"
                value={settings.trash_retention_days}
                onChange={(e) => update("trash_retention_days", Math.max(1, Number(e.target.value) || 1))}
              />
              <span className="text-sm text-muted-foreground">days in Trash</span>
            </div>
          </label>
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            Permanent deletion cannot be undone. Restore anything worth keeping before it ages out.
          </div>
        </section>

        <section className="card p-5 space-y-4">
          <div className="flex items-start gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-700">
              <ClipboardCheck className="h-5 w-5" />
            </div>
            <div>
              <h3 className="font-semibold text-foreground">Upload governance</h3>
              <p className="text-sm text-muted-foreground">
                Lightweight rules for upload hygiene that can expand as the DMS grows.
              </p>
            </div>
          </div>
          <Toggle
            checked={settings.require_metadata_on_upload}
            onChange={(checked) => update("require_metadata_on_upload", checked)}
            label="Require configured metadata"
            description="Keep admin-defined required metadata checks active during uploads."
          />
          <div className="rounded-lg border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
            Required metadata is checked against each document type's admin-defined required fields.
          </div>
        </section>
      </div>
    </div>
  );
}

export default function AdminPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground tracking-tight">DMS settings</h1>
        <p className="text-muted-foreground text-sm mt-1">
          Configure document handling rules, preview watermarks, upload policies, and lifecycle automation.
        </p>
      </div>

      <SettingsTab />
    </div>
  );
}
