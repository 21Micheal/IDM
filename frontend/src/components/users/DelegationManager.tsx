import { useState } from "react";
import { extractApiError } from "@/lib/apiError";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { documentTypesAPI, profileAPI } from "@/services/api";
import { format } from "date-fns";
import { ArrowLeftRight, CalendarClock, CircleSlash, Loader2, UserCheck } from "lucide-react";
import { toast } from "@/components/ui/vault-toast";
import CustomListbox from "@/components/ui/CustomListbox";

export type DelegationRecord = {
  id: string;
  delegate: { id: string; full_name?: string; email: string };
  starts_at: string;
  ends_at: string;
  comment: string;
  is_active: boolean;
  is_current: boolean;
  document_type_name?: string | null;
  dismissed_at?: string | null;
};

type DelegationForm = {
  delegate_id: string;
  starts_at: string;
  ends_at: string;
  comment: string;
  document_type_id: string | null;
};

type UserOption = {
  id: string;
  full_name?: string;
  email: string;
};

type DocumentTypeOption = {
  id: string;
  name: string;
  code: string;
};

const emptyForm: DelegationForm = {
  delegate_id: "",
  starts_at: "",
  ends_at: "",
  comment: "",
  document_type_id: null,
};

type DelegationScheduleFormProps = {
  /** When set, the admin schedules delegation on behalf of this user. */
  delegatorId?: string;
  delegatorName?: string;
  onCreated?: () => void;
};

export function DelegationScheduleForm({
  delegatorId,
  delegatorName,
  onCreated,
}: DelegationScheduleFormProps) {
  const qc = useQueryClient();
  const [form, setForm] = useState<DelegationForm>(emptyForm);

  const { data: candidates = [] } = useQuery<UserOption[]>({
    queryKey: ["delegations", "candidates", delegatorId ?? "self"],
    queryFn: () =>
      profileAPI.delegationCandidates(delegatorId).then((r) => r.data),
  });

  const { data: documentTypes = [] } = useQuery<DocumentTypeOption[]>({
    queryKey: ["documentTypes"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data.results ?? r.data),
  });

  const createMutation = useMutation({
    mutationFn: () =>
      profileAPI.createDelegation({
        ...form,
        ...(delegatorId ? { delegator_id: delegatorId } : {}),
      }),
    onSuccess: () => {
      toast.success(delegatorId ? "Delegation scheduled" : "Delegation created");
      setForm(emptyForm);
      qc.invalidateQueries({ queryKey: ["delegations"] });
      if (delegatorId) {
        qc.invalidateQueries({ queryKey: ["users", "delegations", delegatorId] });
      }
      onCreated?.();
    },
    onError: (err) =>
      toast.error(extractApiError(err, "Failed to create delegation")),
  });

  const heading = delegatorId ? "Schedule delegation" : "Out of office delegation";
  const description = delegatorId
    ? `Assign ${delegatorName ?? "this user"}'s workflow tasks to another user for a set period.`
    : "Assign your workflow tasks to another user temporarily.";

  return (
    <div className="rounded-xl border border-border bg-muted/20 p-5 space-y-4">
      <div className="flex items-center gap-3">
        <div className="w-10 h-10 rounded-lg bg-emerald-100 flex items-center justify-center">
          <ArrowLeftRight className="w-5 h-5 text-emerald-600" />
        </div>
        <div>
          <h3 className="text-base font-semibold text-foreground">{heading}</h3>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            Delegate to
          </label>
          <CustomListbox
            className="w-full"
            value={form.delegate_id}
            onChange={(value) => setForm((s) => ({ ...s, delegate_id: value }))}
            options={[
              { value: "", label: "Select user" },
              ...candidates.map((candidate) => ({ value: candidate.id, label: candidate.full_name || candidate.email })),
            ]}
            buttonClassName="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm text-left"
            ariaLabel="Delegate to"
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            Document type filter
          </label>
          <CustomListbox
            className="w-full"
            value={form.document_type_id || ""}
            onChange={(value) => setForm((s) => ({ ...s, document_type_id: value || null }))}
            options={[
              { value: "", label: "All tasks" },
              ...documentTypes.map((dt) => ({ value: dt.id, label: `${dt.name} (${dt.code})` })),
            ]}
            buttonClassName="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm text-left"
            ariaLabel="Document type filter"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Leave empty to delegate all tasks, or filter to one document type.
          </p>
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            Start date
          </label>
          <input
            type="datetime-local"
            className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm"
            value={form.starts_at}
            onChange={(e) => setForm((s) => ({ ...s, starts_at: e.target.value }))}
          />
        </div>

        <div>
          <label className="block text-xs font-medium text-muted-foreground mb-1.5">
            End date
          </label>
          <input
            type="datetime-local"
            className="w-full h-10 rounded-lg border border-input bg-background px-3 text-sm"
            value={form.ends_at}
            onChange={(e) => setForm((s) => ({ ...s, ends_at: e.target.value }))}
          />
        </div>
      </div>

      <div>
        <label className="block text-xs font-medium text-muted-foreground mb-1.5">
          Reason for delegation
        </label>
        <textarea
          className="w-full rounded-lg border border-input bg-background px-3 py-2 text-sm resize-none"
          rows={3}
          value={form.comment}
          onChange={(e) => setForm((s) => ({ ...s, comment: e.target.value }))}
          placeholder={
            delegatorId
              ? "e.g. Annual leave, training, extended absence…"
              : "Explain why you are delegating these tasks…"
          }
        />
      </div>

      <button
        type="button"
        className="inline-flex items-center gap-2 h-10 px-4 rounded-lg bg-primary text-primary-foreground text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        disabled={
          !form.delegate_id ||
          !form.starts_at ||
          !form.ends_at ||
          !form.comment.trim() ||
          createMutation.isPending
        }
        onClick={() => createMutation.mutate()}
      >
        {createMutation.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
        {delegatorId ? "Schedule delegation" : "Create delegation"}
      </button>
    </div>
  );
}

type DelegationListProps = {
  delegations: DelegationRecord[];
  onDisable: (delegationId: string) => void;
  onDismiss?: (delegationId: string) => void;
  disablePending?: boolean;
  dismissPending?: boolean;
  emptyMessage?: string;
};

export function DelegationList({
  delegations,
  onDisable,
  onDismiss,
  disablePending = false,
  dismissPending = false,
  emptyMessage = "No delegations configured.",
}: DelegationListProps) {
  if (!delegations.length) {
    return (
      <div className="rounded-lg border border-dashed border-border bg-muted/20 px-6 py-10 text-center">
        <CalendarClock className="w-6 h-6 text-muted-foreground/60 mx-auto mb-2" />
        <p className="text-sm text-muted-foreground">{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {delegations.map((delegation) => {
        const now = new Date();
        const endsAt = new Date(delegation.ends_at);
        const hasEnded = now > endsAt;
        
        const status = delegation.is_current
          ? { label: "Active now", tone: "bg-emerald-500/10 text-emerald-600 border-emerald-500/20" }
          : hasEnded
            ? { label: "Ended", tone: "bg-muted text-muted-foreground border-border" }
            : delegation.is_active
              ? { label: "Scheduled", tone: "bg-primary/10 text-primary border-primary/20" }
              : { label: "Ended", tone: "bg-muted text-muted-foreground border-border" };

        return (
          <div
            key={delegation.id}
            className="rounded-xl border border-border bg-background p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3"
          >
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <p className="font-medium text-foreground truncate">
                  {delegation.delegate.full_name || delegation.delegate.email}
                </p>
                <span
                  className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium border ${status.tone}`}
                >
                  {status.label}
                </span>
              </div>
              <p className="text-xs text-muted-foreground mt-1">
                {format(new Date(delegation.starts_at), "dd MMM yyyy HH:mm")} →{" "}
                {format(new Date(delegation.ends_at), "dd MMM yyyy HH:mm")}
              </p>
              {delegation.document_type_name && (
                <p className="text-xs text-muted-foreground mt-1">
                  Scope: {delegation.document_type_name}
                </p>
              )}
              {delegation.comment && (
                <p className="text-xs text-muted-foreground mt-1 italic">
                  &ldquo;{delegation.comment}&rdquo;
                </p>
              )}
            </div>
            <div className="flex gap-2 self-start sm:self-auto">
              {delegation.is_active && !hasEnded && (
                <button
                  type="button"
                  onClick={() => onDisable(delegation.id)}
                  disabled={disablePending}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border bg-background text-xs font-medium hover:bg-muted disabled:opacity-70"
                >
                  <CircleSlash className="w-3.5 h-3.5" />
                  Disable
                </button>
              )}
              {(!delegation.is_active || hasEnded) && onDismiss && (
                <button
                  type="button"
                  onClick={() => onDismiss(delegation.id)}
                  disabled={dismissPending}
                  className="inline-flex items-center gap-1.5 h-9 px-3 rounded-lg border border-border bg-background text-xs font-medium hover:bg-muted disabled:opacity-70"
                >
                  {dismissPending && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                  Dismiss
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function DelegationSectionHeader({
  count,
  title = "Delegations",
}: {
  count: number;
  title?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-2">
        <UserCheck className="w-4 h-4 text-muted-foreground" />
        <h2 className="font-semibold text-foreground">{title}</h2>
      </div>
      <span className="text-xs text-muted-foreground">{count} configured</span>
    </div>
  );
}
