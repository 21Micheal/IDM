/**
 * FormsPage
 *
 * Dedicated landing page for "Forms" (built-template documents filled in-app —
 * imprest requests, retirements, etc.) — separated out from the generic
 * Documents area per the July 2026 forms rework.
 *
 * Pass 5 — corpus-wide filtering/pagination:
 * Every earlier pass fetched the TABLE from a server-paginated query
 * (PAGE_SIZE rows) and applied department/requester/date/amount/stage/type
 * filters CLIENT-SIDE on top of that already-narrow slice — so a matching
 * form sitting on page 2 of the server results could vanish from a client
 * filter's view entirely, and row numbering only ever counted within one
 * server page. Restructured around a single pool query (same
 * `STATS_POOL_SIZE`-capped fetch the stat cards already used) that now
 * doubles as the source for the table: EVERY filter (search, status, stage,
 * type, variance, department, requester, date, amount) runs client-side
 * against that one pool, then the filtered result is paginated client-side.
 * Numbering and pagination are now consistent with what's actually being
 * filtered — "row 11" really is the 11th matching form, not the 11th row of
 * whatever the server happened to hand back. The tradeoff (documented at
 * STATS_POOL_SIZE below) is the same one already accepted for the stat
 * cards: this covers up to STATS_POOL_SIZE forms, not the literal entire
 * corpus. Ask the backend for a real filtering/aggregate endpoint once forms
 * comfortably exceed that.
 *
 * Pass 6 — stop guessing what a proper mapping already answers:
 * `apps/sunsystems/variance.py`'s compute_retirement_variance() now also
 * resolves the spent table's description (the SAME admin-configured column
 * the Stage 2 journal payload's line description already uses — see
 * mapping.py's classify_retirement/spent_amount.description_column) and
 * persists it onto `metadata.form.retirement_variance.description`.
 * getFormDescription() now prefers that over the guessed DESCRIPTION_KEYS
 * list, for the same reason getFormAmount() prefers `requested_amount` over
 * guessed keys: the mapping is admin-configured and stays correct however a
 * field gets renamed in the builder, whereas a hardcoded frontend key
 * breaks the moment it does. (Guessed keys remain as a last-resort fallback
 * for request-phase forms — this description is retirement-only, same as
 * the variance itself — or a template with no retirement mapping at all.)
 * Also removed the previous pass's client-side variance fallback (guessing
 * a spent TABLE + COLUMN key): unlike a single scalar field, getting either
 * wrong there risks showing an approver an outright incorrect Over/Under
 * figure, not just a blank cell — so variance stays backend-only.
 *
 * Other notes carried over from earlier passes (still true):
 *   - `documentsAPI.list({ is_form: true, ... })` — `is_form` isn't a real
 *     backend filter yet; this page also filters client-side on
 *     `metadata.form.sections` as a safety net regardless.
 *   - RBAC relies entirely on the backend's existing document-list scoping.
 *   - "Ready for retirement" trusts `doc.can_submit_retirement` alone (the
 *     backend's own answer to "is this true right now").
 *   - "Pending Approval" is scoped to the REQUEST stage only, kept disjoint
 *     from "Ready for Retirement" so the three stat cards never overlap.
 *   - Amount prefers `metadata.form.requested_amount` (backend-resolved from
 *     the template's SunSystems retirement mapping — see
 *     apps/sunsystems/variance.py's get_requested_amount), falling back to
 *     the legacy `doc.amount` column, then guessed field-key names.
 *   - "Name" is the form's own title — what the person typed when creating
 *     it (FormFillModal defaults that input to the template's name, but it's
 *     editable, so it's the DOCUMENT's title, not a template lookup). The
 *     "type" filter/column-adjacent template list is a SEPARATE concept —
 *     which template (LPO, Journal, etc.) the form's schema came from.
 */

import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { extractApiError } from "@/lib/apiError";
import { documentsAPI, documentTypesAPI, templatesAPI, normalizeListResponse } from "@/services/api";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import {
  Plus, Search as SearchIcon, Eye, X, TrendingUp, TrendingDown, FileWarning,
  ClipboardCheck, Wallet, FileStack,
} from "lucide-react";
import CustomListbox from "@/components/ui/CustomListbox";
import StatusBadge from "@/components/documents/StatusBadge";
import { StatCard } from "@/components/dashboard/StatCard";

// ── Local helpers ─────────────────────────────────────────────────────────────

const PAGE_SIZE = 10;
// The single pool this whole page (stat cards, chips, filters, AND the table)
// is computed from. Not a true "fetch everything" — a practical cap until
// there's a real backend summary/filter endpoint.
const STATS_POOL_SIZE = 500;

const STATUS_CHIPS: { value: string; label: string }[] = [
  { value: "", label: "All" },
  { value: "draft", label: "Draft" },
  { value: "pending_approval", label: "Pending approval" },
  { value: "ready_for_retirement", label: "Ready for Retirement" },
  { value: "returned", label: "Returned" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "archived", label: "Archived" },
];

// "Stage" (request vs retirement) is a separate axis from "type" — Imprest
// covers several distinct FORM TEMPLATES (LPO, Journal, etc. — see
// imprestTemplates below), each of which independently goes through both
// stages. Kept as its own filter rather than folded into the type dropdown.
const STAGE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All stages" },
  { value: "request", label: "Request" },
  { value: "retirement", label: "Retirement" },
];

const VARIANCE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "All variance" },
  { value: "over", label: "Overspent" },
  { value: "under", label: "Underspent" },
];

// Matches the Imprest document type by code/name, same heuristic
// NewFormModal.tsx uses — there's no first-class "is this an Imprest type"
// flag on DocumentType yet.
const IMPREST_MATCHERS = ["imprest"];
function isImprestDocType(t: any): boolean {
  const code = String(t?.code || "").toLowerCase();
  const name = String(t?.name || "").toLowerCase();
  return IMPREST_MATCHERS.some((m) => code.includes(m) || name.includes(m));
}
function isBuiltForm(t: any): boolean {
  return t?.type === "built" && t?.kind !== "document";
}

function isFormDocument(doc: any): boolean {
  return Boolean(doc?.metadata?.form?.sections);
}

function getFormValues(doc: any): Record<string, unknown> {
  return doc?.metadata?.form?.values ?? {};
}

// Guessed field-key names — ONLY a last resort for a form whose template
// has no retirement mapping configured at all, or one still in the request
// phase (the mapping-driven description below only exists once expense rows
// are entered at retirement). Not authoritative — breaks if an admin renames
// the field. Prefer getFormDescription()'s backend-resolved value below.
const DESCRIPTION_KEYS = ["description", "purpose", "purpose_of_travel", "reason", "details", "activity", "short_text_j1lo", "short_text_ca8g"];
function getFormDescription(doc: any): string {
  // Authoritative: the spent table's description column, resolved server-side
  // by apps/sunsystems/variance.py's compute_retirement_variance (the SAME
  // admin-configured column the Stage 2 journal payload's line description
  // uses — see mapping.py's classify_retirement/spent_amount.description_column).
  // Dynamic regardless of how the admin names/renames the actual field, unlike
  // the guessed keys below. Only present once the form has reached retirement.
  const mapped = doc?.metadata?.form?.retirement_variance?.description;
  if (typeof mapped === "string" && mapped.trim()) return mapped.trim();
  // Fallback — guessed keys, for request-phase forms or templates with no
  // retirement mapping configured (nothing authoritative to read above).
  const values = getFormValues(doc);
  for (const key of DESCRIPTION_KEYS) {
    const v = values[key];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return doc.description || "—";
}

// Same field precedence DashboardPage.getDocumentDepartmentName() already
// uses — kept identical so "department" means the same thing everywhere.
function getFormDepartment(doc: any): string {
  return doc?.department_name || doc?.uploaded_by_department_name || doc?.uploaded_by?.department_name || "—";
}

function getFormRequester(doc: any): string {
  return doc?.uploaded_by?.full_name || doc?.uploaded_by?.email || doc?.owned_by?.full_name || "—";
}

// "Name" — the form's OWN title, i.e. what the person typed when creating it.
// FormFillModal pre-fills that input with the template's name, but it's an
// editable field on the document (`doc.title`), not a fixed template lookup —
// so this reads the document's title directly, not metadata.form.template_id.
function getFormName(doc: any): string {
  return doc?.title || doc?.reference_number || "—";
}

function getFormAmount(doc: any): number | null {
  // Authoritative: the field the template's SunSystems retirement mapping
  // names as "issued/requested amount" (see apps/sunsystems/variance.py's
  // get_requested_amount) — synced onto metadata.form.requested_amount from
  // the request phase onward, no field-name guessing involved. Only absent
  // when the imprest template has no retirement mapping configured at all.
  const requested = Number(doc?.metadata?.form?.requested_amount);
  if (Number.isFinite(requested) && requested > 0) return requested;
  // Legacy fallback: documents created before Forms was split out of the
  // regular upload flow may still carry a top-level `amount` from that
  // page's old "Amount" field. New forms never set this column.
  const amt = Number(doc?.amount);
  if (Number.isFinite(amt) && amt > 0) return amt;
  // Last resort — guessed field-key names, for a form whose template has no
  // retirement mapping configured (so there's nothing authoritative above).
  const values = getFormValues(doc);
  const alt = Number((values as any)?.amount ?? (values as any)?.total ?? (values as any)?.total_amount ?? (values as any)?.requested_amount ?? (values as any)?.advance_amount);
  return Number.isFinite(alt) && alt > 0 ? alt : null;
}

// Variance is backend-only, deliberately — apps/sunsystems/variance.py
// resolves issued/spent (and now description) straight from the template's
// admin-configured SunSystems retirement mapping (issued_amount field,
// spent_amount table+column), which stays correct however fields get
// renamed in the builder. A client-side guess would need to know which
// TABLE and which COLUMN hold the spend, and getting either wrong risks
// showing an approver an incorrect Over/Under figure — worse than showing
// nothing — so unlike amount/description there's no local fallback here.
// If this is empty for a retirement-stage form, the template's Retirement
// panel (issued_amount/spent_amount) most likely isn't configured yet — see
// apps/sunsystems/variance.py's module docstring.
function getFormVariance(doc: any): { amount: number; kind: "over" | "under" } | null {
  const backend = doc?.metadata?.form?.retirement_variance ?? doc?.form_summary?.retirement_variance;
  if (!backend || typeof backend !== "object") return null;
  const amount = Number(backend.amount);
  if (!Number.isFinite(amount) || amount === 0) return null; // exact, or nothing computed — nothing to flag
  return { amount: Math.abs(amount), kind: backend.kind === "under" || amount < 0 ? "under" : "over" };
}

// A form has exactly two approval STAGES — request and retirement — tracked
// by builder_workflow_phase. Absent/undefined means it hasn't reached the
// retirement stage yet, i.e. it's still at the "request" stage. (Distinct
// from "type"/template — see the type filter below.)
function getFormStage(doc: any): "request" | "retirement" {
  return doc?.builder_workflow_phase === "retirement" ? "retirement" : "request";
}

// The backend already computes exactly this ("can this document's retirement
// be submitted right now") — trust it alone. Layering on a phase+status
// guess double-counted retirements that were already submitted (and
// therefore no longer "ready" to submit).
function isReadyForRetirement(doc: any): boolean {
  return Boolean(doc.can_submit_retirement);
}

// Pending-approval, REQUEST STAGE ONLY — kept disjoint from "ready for
// retirement" and from a retirement that's itself pending approval, so the
// three stat cards never overlap.
const REQUEST_PENDING_STATUSES = ["pending_approval", "request_pending", "on_hold"];
function isPendingRequestApproval(doc: any): boolean {
  if (getFormStage(doc) === "retirement") return false;
  const step = doc.builder_process_step || doc.status;
  return REQUEST_PENDING_STATUSES.includes(step);
}

function formatMoney(amount: number | null, currency?: string) {
  if (amount === null) return "—";
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency || "KES" }).format(amount);
  } catch {
    return `${currency ?? ""} ${amount.toLocaleString()}`.trim();
  }
}

// ── Main page ─────────────────────────────────────────────────────────────────

export default function FormsPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [stageFilter, setStageFilter] = useState("");
  const [templateFilter, setTemplateFilter] = useState("");
  const [varianceFilter, setVarianceFilter] = useState("");
  const [departmentFilter, setDepartmentFilter] = useState("");
  const [requesterFilter, setRequesterFilter] = useState("");
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [amountMin, setAmountMin] = useState("");
  const [amountMax, setAmountMax] = useState("");
  const [page, setPage] = useState(1);

  // ── Imprest templates (LPO, Journal, etc.) — for the type filter. Imprest
  // is one document type with several form templates under it; this is
  // unrelated to the request/retirement stage above, and unrelated to a
  // form's own (user-typed) Name.
  const { data: docTypes = [] } = useQuery({
    queryKey: ["document-types"],
    queryFn: () => documentTypesAPI.list().then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<any>(data),
    staleTime: 5 * 60_000,
  });
  const imprestType = useMemo(() => docTypes.find(isImprestDocType) ?? null, [docTypes]);

  const { data: imprestTemplates = [] } = useQuery({
    queryKey: ["templates", "document-type", imprestType?.id],
    queryFn: () => templatesAPI.list({ document_type_id: imprestType!.id }).then((r) => r.data as unknown),
    select: (data) => normalizeListResponse<any>(data).filter(isBuiltForm),
    enabled: Boolean(imprestType?.id),
    staleTime: 5 * 60_000,
  });

  // ── The one pool everything on this page reads from — see the "Pass 5"
  // note at the top of the file for why this replaced a server-paginated
  // table query + a separate stats-only query.
  const { data: poolData, isLoading, error } = useQuery({
    queryKey: ["forms", "pool"],
    queryFn: () =>
      documentsAPI.list({
        is_form: true,
        ordering: "-created_at",
        page: 1,
        page_size: STATS_POOL_SIZE,
      }).then((r) => r.data),
    staleTime: 15_000,
  });
  const poolRows = useMemo(() => {
    const results = (poolData?.results ?? []) as any[];
    return results.filter(isFormDocument);
  }, [poolData]);

  const departmentOptions = useMemo(
    () => Array.from(new Set(poolRows.map(getFormDepartment).filter((d) => d !== "—"))).sort((a, b) => a.localeCompare(b)),
    [poolRows],
  );
  const requesterOptions = useMemo(() => {
    const map = new Map<string, string>();
    poolRows.forEach((doc) => {
      const id = doc.uploaded_by?.id;
      if (id) map.set(id, getFormRequester(doc));
    });
    return Array.from(map.entries());
  }, [poolRows]);

  // Every filter runs against the SAME pool — corpus-wide (up to
  // STATS_POOL_SIZE), not "whatever page the server handed back".
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return poolRows.filter((doc) => {
      if (q) {
        const title = String(doc.title || "").toLowerCase();
        const ref = String(doc.reference_number || "").toLowerCase();
        if (!title.includes(q) && !ref.includes(q)) return false;
      }
      // Handle status filtering: for "pending_approval", use the same logic as
      // isPendingRequestApproval to match custom workflow status labels
      // For "ready_for_retirement", use isReadyForRetirement
      if (statusFilter) {
        if (statusFilter === "pending_approval") {
          if (!isPendingRequestApproval(doc)) return false;
        } else if (statusFilter === "ready_for_retirement") {
          if (!isReadyForRetirement(doc)) return false;
        } else if (doc.status !== statusFilter) {
          return false;
        }
      }
      if (stageFilter && getFormStage(doc) !== stageFilter) return false;
      if (templateFilter && String(doc?.metadata?.form?.template_id ?? "") !== templateFilter) return false;
      if (varianceFilter) {
        const v = getFormVariance(doc);
        if (!v || v.kind !== varianceFilter) return false;
      }
      if (departmentFilter && getFormDepartment(doc) !== departmentFilter) return false;
      if (requesterFilter && doc.uploaded_by?.id !== requesterFilter) return false;
      if (dateFrom && new Date(doc.created_at) < new Date(dateFrom)) return false;
      if (dateTo && new Date(doc.created_at) > new Date(dateTo)) return false;
      const amt = getFormAmount(doc);
      if (amountMin && (amt === null || amt < Number(amountMin))) return false;
      if (amountMax && (amt === null || amt > Number(amountMax))) return false;
      return true;
    });
  }, [
    poolRows, search, statusFilter, stageFilter, templateFilter, varianceFilter,
    departmentFilter, requesterFilter, dateFrom, dateTo, amountMin, amountMax,
  ]);

  // Reset to page 1 whenever any filter narrows/widens the result set —
  // otherwise you can land on an empty page 3 after a filter shrinks the list.
  useEffect(() => { setPage(1); }, [
    search, statusFilter, stageFilter, templateFilter, varianceFilter,
    departmentFilter, requesterFilter, dateFrom, dateTo, amountMin, amountMax,
  ]);

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pageRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, page]);

  // Status chip counts — from the pool, corpus-wide (not the current filtered
  // page). Each chip counts against every filter EXCEPT status itself, so the
  // numbers reflect "if you clicked this chip" rather than double-applying
  // the currently-selected status.
  const statusCounts = useMemo(() => {
    const withoutStatus = poolRows.filter((doc) => {
      const q = search.trim().toLowerCase();
      if (q) {
        const title = String(doc.title || "").toLowerCase();
        const ref = String(doc.reference_number || "").toLowerCase();
        if (!title.includes(q) && !ref.includes(q)) return false;
      }
      if (stageFilter && getFormStage(doc) !== stageFilter) return false;
      if (templateFilter && String(doc?.metadata?.form?.template_id ?? "") !== templateFilter) return false;
      if (varianceFilter) {
        const v = getFormVariance(doc);
        if (!v || v.kind !== varianceFilter) return false;
      }
      if (departmentFilter && getFormDepartment(doc) !== departmentFilter) return false;
      if (requesterFilter && doc.uploaded_by?.id !== requesterFilter) return false;
      if (dateFrom && new Date(doc.created_at) < new Date(dateFrom)) return false;
      if (dateTo && new Date(doc.created_at) > new Date(dateTo)) return false;
      const amt = getFormAmount(doc);
      if (amountMin && (amt === null || amt < Number(amountMin))) return false;
      if (amountMax && (amt === null || amt > Number(amountMax))) return false;
      return true;
    });
    const counts: Record<string, number> = {};
    for (const chip of STATUS_CHIPS) {
      if (chip.value === "pending_approval") {
        counts[chip.value] = withoutStatus.filter(isPendingRequestApproval).length;
      } else if (chip.value === "ready_for_retirement") {
        counts[chip.value] = withoutStatus.filter(isReadyForRetirement).length;
      } else if (chip.value) {
        counts[chip.value] = withoutStatus.filter((d) => d.status === chip.value).length;
      } else {
        counts[chip.value] = withoutStatus.length;
      }
    }
    return counts;
  }, [
    poolRows, search, stageFilter, templateFilter, varianceFilter,
    departmentFilter, requesterFilter, dateFrom, dateTo, amountMin, amountMax,
  ]);

  // Stat cards — always corpus-wide regardless of the filters above (these
  // are meant as fixed "needs attention" counters, not filter-reactive).
  // "Total forms" prefers the server's own matching count (true total, not
  // capped by STATS_POOL_SIZE) and falls back to what we actually fetched.
  const totalFormsCount = poolData?.count ?? poolRows.length;
  const pendingCount = useMemo(() => poolRows.filter(isPendingRequestApproval).length, [poolRows]);
  const readyForRetirementCount = useMemo(() => poolRows.filter(isReadyForRetirement).length, [poolRows]);

  const activeFilterCount = [
    statusFilter, stageFilter, templateFilter, varianceFilter, departmentFilter,
    requesterFilter, dateFrom, dateTo, amountMin, amountMax,
  ].filter(Boolean).length;

  const clearFilters = () => {
    setSearch(""); setStatusFilter(""); setStageFilter(""); setTemplateFilter(""); setVarianceFilter("");
    setDepartmentFilter(""); setRequesterFilter(""); setDateFrom(""); setDateTo(""); setAmountMin(""); setAmountMax("");
    setPage(1);
  };

  return (
    <div className="mx-auto max-w-[1400px] space-y-5 p-6">
      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[#1F2933]">Forms</h1>
          <p className="mt-1 text-sm text-[#5E6870]">Imprest, retirement, and other in-app forms — separate from general documents.</p>
        </div>
        <button
          type="button"
          onClick={() => navigate('/forms/new')}
          className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#1E6F99]"
        >
          <Plus className="h-4 w-4" /> New Form
        </button>
      </div>

      {/* ── Stat cards ── */}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <StatCard
          title="Total Forms"
          value={totalFormsCount}
          icon={FileStack}
          color="primary"
          href="#"
        />
        <StatCard
          title="Pending Approval"
          value={pendingCount}
          icon={ClipboardCheck}
          color="accent"
          href="#"
        />
        <StatCard
          title="Ready for Retirement"
          value={readyForRetirementCount}
          icon={Wallet}
          color="teal"
          onClick={() => {
            setStatusFilter("ready_for_retirement");
          }}
        />
      </div>

      {/* ── Filters ── */}
      <div className="border border-[#C8CDD2] bg-white p-4">
        {/* Status quick filters */}
        <div className="flex flex-wrap items-center gap-1.5 mb-3">
          {STATUS_CHIPS.map((chip) => (
            <button
              key={chip.value || "all"}
              type="button"
              onClick={() => setStatusFilter(chip.value)}
              className={cn(
                "inline-flex items-center gap-1.5 border px-2.5 py-1 text-xs font-semibold transition-colors",
                statusFilter === chip.value
                  ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]"
                  : "border-[#C8CDD2] bg-white text-[#5E6870] hover:border-[#287EAD]/50 hover:text-[#1F2933]",
              )}
            >
              {chip.label}
              <span className={cn(
                "px-1.5 py-0.5 text-[10px] font-bold",
                statusFilter === chip.value ? "bg-[#287EAD] text-white" : "bg-[#F0F2F4] text-[#5E6870]",
              )}>
                {statusCounts[chip.value] ?? 0}
              </span>
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2 border-t border-[#EEF0F2] pt-3">
          <div className="relative min-w-[220px] max-w-[320px]">
            <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#5E6870]" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search forms by title or reference…"
              className="h-9 w-full border border-[#AEB5BB] bg-white pl-9 pr-3 text-sm text-[#1F2933] placeholder:text-[#8C969E] focus:outline-none focus:ring-1 focus:ring-[#287EAD]"
            />
          </div>

          <CustomListbox
            value={stageFilter}
            onChange={setStageFilter}
            options={STAGE_OPTIONS}
            buttonClassName="h-9 w-[140px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]"
            ariaLabel="Stage filter"
          />

          <CustomListbox
            value={templateFilter}
            onChange={setTemplateFilter}
            options={[{ value: "", label: "All form types" }, ...imprestTemplates.map((t: any) => ({ value: String(t.id), label: t.name }))]}
            buttonClassName="h-9 w-[170px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]"
            ariaLabel="Form type filter"
          />

          <CustomListbox
            value={varianceFilter}
            onChange={setVarianceFilter}
            options={VARIANCE_OPTIONS}
            buttonClassName="h-9 w-[140px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]"
            ariaLabel="Variance filter"
          />

          <CustomListbox
            value={departmentFilter}
            onChange={setDepartmentFilter}
            options={[{ value: "", label: "All departments" }, ...departmentOptions.map((d) => ({ value: d, label: d }))]}
            buttonClassName="h-9 w-[150px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]"
            ariaLabel="Department filter"
          />

          <CustomListbox
            value={requesterFilter}
            onChange={setRequesterFilter}
            options={[{ value: "", label: "All requesters" }, ...requesterOptions.map(([id, name]) => ({ value: id, label: name }))]}
            buttonClassName="h-9 w-[150px] border border-[#AEB5BB] bg-white px-2 text-sm text-[#1F2933]"
            ariaLabel="Requester filter"
          />

          <label className="flex items-center gap-1.5 text-xs text-[#5E6870]">
            From
            <input type="date" value={dateFrom} onChange={(e) => setDateFrom(e.target.value)}
              className="h-8 border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933]" />
          </label>

          <label className="flex items-center gap-1.5 text-xs text-[#5E6870]">
            To
            <input type="date" value={dateTo} onChange={(e) => setDateTo(e.target.value)}
              className="h-8 border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933]" />
          </label>

          <label className="flex items-center gap-1.5 text-xs text-[#5E6870]">
            Amount min
            <input type="number" value={amountMin} onChange={(e) => setAmountMin(e.target.value)}
              className="h-8 w-24 border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933]" />
          </label>

          <label className="flex items-center gap-1.5 text-xs text-[#5E6870]">
            Amount max
            <input type="number" value={amountMax} onChange={(e) => setAmountMax(e.target.value)}
              className="h-8 w-24 border border-[#AEB5BB] bg-white px-2 text-xs text-[#1F2933]" />
          </label>

          {activeFilterCount > 0 && (
            <button type="button" onClick={clearFilters}
              className="inline-flex items-center gap-1 text-xs font-semibold text-[#287EAD] hover:text-[#1E6F99]">
              <X className="h-3.5 w-3.5" /> Clear filters ({activeFilterCount})
            </button>
          )}

          <span className="ml-auto text-xs text-[#5E6870]">
            {isLoading ? "Loading…" : `${filteredRows.length} matching form${filteredRows.length === 1 ? "" : "s"}`}
          </span>
        </div>
      </div>

      {/* ── Summary report table ── */}
      <div className="overflow-hidden border border-[#C8CDD2] bg-white">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1300px] text-sm">
            <thead>
              <tr className="border-b border-[#AEB5BB] bg-[#50545A] text-left text-xs font-semibold text-white">
                <th className="w-12 border-r border-[#858A90] px-3 py-3">#</th>
                <th className="border-r border-[#858A90] px-3 py-3">Reference</th>
                <th className="border-r border-[#858A90] px-3 py-3">Name</th>
                <th className="border-r border-[#858A90] px-3 py-3">Requester</th>
                <th className="border-r border-[#858A90] px-3 py-3">Department</th>
                <th className="border-r border-[#858A90] px-3 py-3">Description</th>
                <th className="border-r border-[#858A90] px-3 py-3">Creation Date</th>
                <th className="border-r border-[#858A90] px-3 py-3">Amount</th>
                <th className="border-r border-[#858A90] px-3 py-3">Approval status</th>
                <th className="border-r border-[#858A90] px-3 py-3">Variance</th>
                <th className="w-16 px-3 py-3">View</th>
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                Array.from({ length: 6 }).map((_, i) => (
                  <tr key={i} className="h-[44px] border-b border-[#D3D7DA]">
                    {Array.from({ length: 11 }).map((__, j) => (
                      <td key={j} className="border-r border-[#D3D7DA] px-3">
                        <div className="h-3 w-2/3 animate-pulse bg-[#E1E5E8]" />
                      </td>
                    ))}
                  </tr>
                ))
              ) : error ? (
                <tr>
                  <td colSpan={11} className="py-16 text-center text-red-600">
                    {extractApiError(error, "Could not load forms.")}
                  </td>
                </tr>
              ) : pageRows.length === 0 ? (
                <tr>
                  <td colSpan={11} className="py-20 text-center text-[#5E6870]">
                    <FileWarning className="mx-auto mb-3 h-10 w-10 text-[#AEB5BB]" />
                    No forms match the current filters.
                  </td>
                </tr>
              ) : (
                pageRows.map((doc, idx) => {
                  const variance = getFormVariance(doc);
                  const amount = getFormAmount(doc);
                  // Corpus-wide sequence: position within the FULL filtered
                  // result set, not just this page's slice of it.
                  const rowNumber = (page - 1) * PAGE_SIZE + idx + 1;
                  return (
                    <tr key={doc.id} className="h-[46px] border-b border-[#D3D7DA] bg-white hover:bg-[#F5F7F8]">
                      <td className="border-r border-[#D3D7DA] px-3 text-[#5E6870]">{rowNumber}</td>
                      <td className="border-r border-[#D3D7DA] px-3">
                        <Link to={`/forms/${doc.id}`} className="font-mono text-xs font-semibold text-[#2B86C5] hover:underline">
                          {doc.reference_number}
                        </Link>
                      </td>
                      <td className="border-r border-[#D3D7DA] px-3">{getFormName(doc)}</td>
                      <td className="border-r border-[#D3D7DA] px-3">{getFormRequester(doc)}</td>
                      <td className="border-r border-[#D3D7DA] px-3">{getFormDepartment(doc)}</td>
                      <td className="max-w-[240px] truncate border-r border-[#D3D7DA] px-3" title={getFormDescription(doc)}>
                        {getFormDescription(doc)}
                      </td>
                      <td className="border-r border-[#D3D7DA] px-3 whitespace-nowrap">
                        {format(new Date(doc.created_at), "dd MMM yyyy")}
                      </td>
                      <td className="border-r border-[#D3D7DA] px-3 font-mono">{formatMoney(amount, doc.currency)}</td>
                      <td className="border-r border-[#D3D7DA] px-3"><StatusBadge status={doc.status} /></td>
                      <td className="border-r border-[#D3D7DA] px-3">
                        {variance ? (
                          <span className={cn(
                            "inline-flex items-center gap-1 px-1.5 py-0.5 text-[11px] font-semibold",
                            variance.kind === "over" ? "bg-red-50 text-red-700" : "bg-amber-50 text-amber-700",
                          )}>
                            {variance.kind === "over" ? <TrendingUp className="h-3 w-3" /> : <TrendingDown className="h-3 w-3" />}
                            {variance.kind === "over" ? "Over" : "Under"} {formatMoney(variance.amount, doc.currency)}
                          </span>
                        ) : (
                          <span className="text-[#AEB5BB]">—</span>
                        )}
                      </td>
                      <td className="px-3">
                        <Link to={`/forms/${doc.id}`} className="inline-flex items-center gap-1 font-semibold text-[#2B86C5] hover:underline">
                          <Eye className="h-3.5 w-3.5" /> View
                        </Link>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {filteredRows.length > PAGE_SIZE && (
          <div className="flex items-center justify-between border-t border-[#C8CDD2] bg-[#F5F7F8] px-4 py-2.5 text-xs text-[#5E6870]">
            <span>
              Page {page} of {totalPages} · {filteredRows.length.toLocaleString()} matching forms
              {activeFilterCount > 0 || search || statusFilter ? " (filtered)" : ""}
            </span>
            <div className="flex items-center gap-2">
              <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page === 1}
                className="border border-[#C8CDD2] bg-white px-3 py-1 disabled:opacity-40">Previous</button>
              <button onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={page >= totalPages}
                className="border border-[#C8CDD2] bg-white px-3 py-1 disabled:opacity-40">Next</button>
            </div>
          </div>
        )}
      </div>

    </div>
  );
}