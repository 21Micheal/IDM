// AnalyticsDashboard.tsx
// Enterprise analytics workspace for the Flaxem DMS.
//
//  • Global filters: period (3/6/12m) · department · document type — server-side.
//  • Executive KPI row with period-over-period trends (/analytics/overview).
//  • Six cards: SLA breach trend, status distribution, approval turnaround,
//    department activity, document volume by type, top uploaders.
//  • Per-card states (skeleton / empty / error+retry) and CSV export.
//  Access: admins + HOD (department heads).

import { useMemo, useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, departmentsAPI, documentTypesAPI, normalizeListResponse } from "@/services/api";
import { QUERY_FIVE_MIN_STALE } from "@/lib/reactQueryDefaults";
import { exportCsv } from "@/lib/exportCsv";
import { StatCard } from "@/components/dashboard/StatCard";
import type { DocumentType } from "@/types";
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ReferenceLine, Cell, LabelList,
} from "recharts";
import {
  AlertTriangle, Clock, FileBarChart, FileText, CheckCircle2, Hourglass,
  Users, Building2, PieChart as PieIcon, Download, Loader2, RefreshCw, Inbox, ShieldCheck,
} from "lucide-react";

/* ── Types ─────────────────────────────────────────────────────────────────── */
type Metric = { current: number | null; previous: number | null; delta_pct: number | null };
interface Overview {
  period: { months: number; start: string; end: string };
  documents: Metric;
  approved: Metric;
  rejected: Metric;
  pending_now: number;
  avg_turnaround_hours: Metric;
  sla_compliance: Metric;
  active_uploaders: Metric;
}
interface TurnaroundItem { step: string; avg_hours: number; sla_hours: number; completed: number }
interface SlaItem { month: string; total: number; breached: number; breach_rate: number }
interface VolumeItem { month: string; [docType: string]: number | string }
interface UploaderItem { name: string; department: string; count: number; approved: number; pending: number; rejected: number }
interface StatusItem { status: string; label: string; count: number }
interface DeptItem { department: string; uploads: number; approved: number; pending: number; rejected: number }

type Period = 3 | 6 | 12;
interface Filters { months: Period; department: string; document_type: string }

/* ── Palette ───────────────────────────────────────────────────────────────── */
const BRAND = {
  primary: "hsl(203,80%,42%)",
  accent: "hsl(240,40%,50%)",
  teal: "hsl(195,75%,45%)",
  danger: "hsl(0,84%,46%)",
  warning: "hsl(38,90%,50%)",
  neutral: "hsl(210,20%,82%)",
  muted: "hsl(210,12%,55%)",
};
const STATUS_COLORS: Record<string, string> = {
  draft: "hsl(210,16%,70%)",
  pending_review: "hsl(38,90%,50%)",
  pending_approval: "hsl(203,80%,42%)",
  returned: "hsl(28,85%,55%)",
  approved: "hsl(150,55%,42%)",
  rejected: "hsl(0,84%,46%)",
  archived: "hsl(240,20%,60%)",
  void: "hsl(0,0%,55%)",
  pending_signature: "hsl(265,55%,58%)",
  signed: "hsl(170,60%,40%)",
};
const VOLUME_PALETTE = ["#147eb3", "#3d3d8f", "#1ba0b8", "#e0992a", "#8b5cf6", "#3cb371", "#b71c1c", "#94a3b8"];

const DOC_TYPE_COLORS_STORAGE_KEY = "analytics.docTypeColors.v1";
function loadSavedDocTypeColors(): Record<string, string> {
  try { const raw = localStorage.getItem(DOC_TYPE_COLORS_STORAGE_KEY); return raw ? JSON.parse(raw) : {}; }
  catch { return {}; }
}
function saveDocTypeColors(map: Record<string, string>) {
  try { localStorage.setItem(DOC_TYPE_COLORS_STORAGE_KEY, JSON.stringify(map)); } catch { /* ignore */ }
}

const SYSTEM_TYPE_CODES = ["UNCLASS", "SIGREQ", "PERSONAL"];

/* ── Generic chart query hook ──────────────────────────────────────────────── */
function useAnalytics<T>(name: string, path: string, filters: Filters): UseQueryResult<T> {
  const params: Record<string, string | number> = { months: filters.months };
  if (filters.department) params.department = filters.department;
  if (filters.document_type) params.document_type = filters.document_type;
  return useQuery<T>({
    queryKey: ["analytics", name, filters],
    queryFn: () => api.get(`/analytics/${path}/`, { params }).then((r) => r.data),
    ...QUERY_FIVE_MIN_STALE,
  });
}

/* ── Shared UI ─────────────────────────────────────────────────────────────── */
function ChartTooltip({ active, payload, label, formatter }: {
  active?: boolean; payload?: any[]; label?: string; formatter?: (name: string, value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-border bg-card px-3 py-2.5 text-xs shadow-lg" style={{ minWidth: 150 }}>
      {label && <p className="mb-1.5 border-b border-border pb-1 font-semibold text-foreground">{label}</p>}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4 py-0.5">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: p.color ?? p.fill ?? p.payload?.fill }} />
            {p.name}
          </span>
          <span className="font-semibold text-foreground">{formatter ? formatter(p.name, p.value) : p.value}</span>
        </div>
      ))}
    </div>
  );
}

function ChartCard<T>({
  icon: Icon, title, subtitle, query, exportRows, exportName, headerExtra, children,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  query: UseQueryResult<T>;
  exportRows?: (data: T) => Array<Record<string, unknown>>;
  exportName?: string;
  headerExtra?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  const { data, isLoading, isError, refetch, isFetching } = query;
  const rows = data && exportRows ? exportRows(data) : [];
  const isEmpty = !isLoading && !isError && Array.isArray(data) && (data as any[]).length === 0;

  return (
    <div className="flex flex-col overflow-hidden rounded-xl border border-border bg-card" style={{ boxShadow: "var(--shadow-card)" }}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
        <div className="flex items-center gap-3">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-white" style={{ background: BRAND.primary }}>
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground">{title}</h3>
            <p className="text-xs text-muted-foreground">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {headerExtra}
          {isFetching && !isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {exportRows && exportName && (
            <button
              type="button"
              onClick={() => data && exportCsv(exportName, exportRows(data))}
              disabled={!data || rows.length === 0}
              title="Export CSV"
              className="rounded-md border border-border bg-card p-1.5 text-muted-foreground transition hover:text-foreground disabled:opacity-40"
            >
              <Download className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex-1 p-5">
        {isLoading ? (
          <div className="h-[260px] animate-pulse rounded-lg bg-muted/50" />
        ) : isError ? (
          <div className="flex h-[260px] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            Could not load this chart.
            <button onClick={() => refetch()} className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-semibold text-foreground hover:bg-muted">
              <RefreshCw className="h-3.5 w-3.5" /> Retry
            </button>
          </div>
        ) : isEmpty ? (
          <div className="flex h-[260px] flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
            <Inbox className="h-7 w-7 opacity-40" />
            No data for the selected filters.
          </div>
        ) : (
          children(data as T)
        )}
      </div>
    </div>
  );
}

/* ── KPI row ───────────────────────────────────────────────────────────────── */
function kpiTrend(m: Metric | undefined, higherIsBetter: boolean) {
  if (!m || m.delta_pct === null || m.delta_pct === undefined) return undefined;
  const up = m.delta_pct >= 0;
  return {
    value: Math.abs(m.delta_pct),
    isPositive: higherIsBetter ? up : !up,
    direction: (m.delta_pct === 0 ? "flat" : up ? "up" : "down") as "up" | "down" | "flat",
    suffix: "%",
    label: "vs prev period",
  };
}
const fmt = (v: number | null | undefined, suffix = "") =>
  v === null || v === undefined ? "—" : `${Math.round(v * 10) / 10}${suffix}`;

function KpiRow({ query }: { query: UseQueryResult<Overview> }) {
  const { data, isLoading } = query;
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-24 animate-pulse rounded-xl bg-card" />)}
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      <StatCard title="Documents" value={data.documents.current ?? 0} icon={FileText} color="primary" trend={kpiTrend(data.documents, true)} />
      <StatCard title="Approved" value={data.approved.current ?? 0} icon={CheckCircle2} color="teal" trend={kpiTrend(data.approved, true)} />
      <StatCard title="Pending backlog" value={data.pending_now} icon={Hourglass} color="accent" />
      <StatCard title="Avg turnaround" value={fmt(data.avg_turnaround_hours.current, "h")} icon={Clock} color="primary" trend={kpiTrend(data.avg_turnaround_hours, false)} />
      <StatCard title="SLA compliance" value={fmt(data.sla_compliance.current, "%")} icon={ShieldCheck} color="teal" trend={kpiTrend(data.sla_compliance, true)} />
      <StatCard title="Active uploaders" value={data.active_uploaders.current ?? 0} icon={Users} color="accent" trend={kpiTrend(data.active_uploaders, true)} />
    </div>
  );
}

/* ── Charts ────────────────────────────────────────────────────────────────── */
function SlaBreachChart({ data }: { data: SlaItem[] }) {
  const avg = data.length ? (data.reduce((s, d) => s + d.breach_rate, 0) / data.length).toFixed(1) : "—";
  return (
    <>
      <ResponsiveContainer width="100%" height={250}>
        <AreaChart data={data} margin={{ left: -8, right: 12, top: 4, bottom: 0 }}>
          <defs>
            <linearGradient id="slaGrad" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor={BRAND.danger} stopOpacity={0.22} />
              <stop offset="95%" stopColor={BRAND.danger} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(210,20%,91%)" />
          <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: BRAND.muted }} interval="preserveStartEnd" />
          <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: BRAND.muted }} tickFormatter={(v: number) => `${v}%`} domain={[0, "dataMax + 5"]} />
          <Tooltip content={<ChartTooltip formatter={(n, v) => (n === "Breach rate" ? `${v}%` : String(v))} />} />
          <ReferenceLine y={10} stroke={BRAND.warning} strokeDasharray="5 3" label={{ value: "10% target", position: "right", fontSize: 10, fill: BRAND.warning }} />
          <Area type="monotone" dataKey="breach_rate" name="Breach rate" stroke={BRAND.danger} strokeWidth={2.5} fill="url(#slaGrad)" dot={{ r: 2.5, fill: BRAND.danger, strokeWidth: 0 }} activeDot={{ r: 5 }} />
        </AreaChart>
      </ResponsiveContainer>
      <p className="mt-2 text-[11px] text-muted-foreground">Average breach rate this period: <span className="font-semibold text-foreground">{avg}%</span>. Dashed line marks the 10% target.</p>
    </>
  );
}

function StatusDonut({ data }: { data: StatusItem[] }) {
  const total = data.reduce((s, d) => s + d.count, 0);
  return (
    <div className="flex flex-col items-center gap-4 lg:flex-row">
      <ResponsiveContainer width="100%" height={230} className="lg:!w-1/2">
        <PieChart>
          <Pie data={data} dataKey="count" nameKey="label" innerRadius={58} outerRadius={88} paddingAngle={2} strokeWidth={0}>
            {data.map((d) => <Cell key={d.status} fill={STATUS_COLORS[d.status] ?? BRAND.neutral} />)}
          </Pie>
          <Tooltip content={<ChartTooltip formatter={(_n, v) => `${v} (${total ? Math.round((v / total) * 100) : 0}%)`} />} />
        </PieChart>
      </ResponsiveContainer>
      <div className="grid w-full grid-cols-1 gap-1.5 sm:grid-cols-2 lg:w-1/2">
        {data.map((d) => (
          <div key={d.status} className="flex items-center justify-between gap-2 text-xs">
            <span className="flex items-center gap-1.5 truncate text-muted-foreground">
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: STATUS_COLORS[d.status] ?? BRAND.neutral }} />
              <span className="truncate">{d.label}</span>
            </span>
            <span className="shrink-0 font-semibold text-foreground">{d.count}<span className="ml-1 text-muted-foreground">({total ? Math.round((d.count / total) * 100) : 0}%)</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TurnaroundChart({ data }: { data: TurnaroundItem[] }) {
  const breaching = data.filter((d) => d.avg_hours > d.sla_hours).length;
  return (
    <>
      <ResponsiveContainer width="100%" height={Math.max(220, data.length * 46)}>
        <BarChart data={data} layout="vertical" margin={{ left: 0, right: 44, top: 4, bottom: 4 }} barCategoryGap="26%">
          <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="hsl(210,20%,91%)" />
          <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: BRAND.muted }} tickFormatter={(v: number) => `${v}h`} />
          <YAxis type="category" dataKey="step" width={120} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "hsl(210,12%,45%)", fontWeight: 500 }} />
          <Tooltip content={<ChartTooltip formatter={(_n, v) => `${v}h`} />} />
          <Bar dataKey="avg_hours" name="Avg hours" radius={[0, 4, 4, 0]} maxBarSize={22}>
            {data.map((e, i) => <Cell key={i} fill={e.avg_hours > e.sla_hours ? BRAND.danger : BRAND.primary} fillOpacity={0.9} />)}
            <LabelList dataKey="avg_hours" position="right" formatter={(v: number) => `${v}h`} style={{ fontSize: 11, fontWeight: 600, fill: "hsl(222,30%,20%)" }} />
          </Bar>
          <Bar dataKey="sla_hours" name="SLA target" radius={[0, 4, 4, 0]} maxBarSize={7} fill={BRAND.neutral} fillOpacity={0.7} />
          <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
        </BarChart>
      </ResponsiveContainer>
      <p className="mt-2 text-[11px] text-muted-foreground">Red bars exceed their SLA target — <span className="font-medium text-foreground">{breaching} of {data.length} steps</span> currently breaching.</p>
    </>
  );
}

function DepartmentChart({ data }: { data: DeptItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(220, data.length * 44)}>
      <BarChart data={data} layout="vertical" margin={{ left: 0, right: 16, top: 4, bottom: 4 }} barCategoryGap="24%">
        <CartesianGrid horizontal={false} strokeDasharray="3 3" stroke="hsl(210,20%,91%)" />
        <XAxis type="number" tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: BRAND.muted }} />
        <YAxis type="category" dataKey="department" width={120} tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: "hsl(210,12%,45%)", fontWeight: 500 }} />
        <Tooltip content={<ChartTooltip />} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11, paddingTop: 8 }} />
        <Bar dataKey="approved" name="Approved" stackId="a" fill="hsl(150,55%,42%)" maxBarSize={22} />
        <Bar dataKey="pending" name="Pending" stackId="a" fill={BRAND.primary} maxBarSize={22} />
        <Bar dataKey="rejected" name="Rejected" stackId="a" fill={BRAND.danger} maxBarSize={22} />
      </BarChart>
    </ResponsiveContainer>
  );
}

function VolumeChart({ data }: { data: VolumeItem[] }) {
  const docTypes = useMemo(() => {
    const set = new Set<string>();
    data.forEach((row) => Object.keys(row).forEach((k) => { if (k !== "month") set.add(k); }));
    return Array.from(set);
  }, [data]);

  const [savedColors, setSavedColors] = useState<Record<string, string>>(() => loadSavedDocTypeColors());
  const [editingType, setEditingType] = useState<string | null>(null);

  const colorFor = (t: string, i: number) => savedColors[t] ?? VOLUME_PALETTE[i % VOLUME_PALETTE.length];

  useEffect(() => {
    let mounted = true;
    api.get("/documents/doc-type-colors/").then((resp) => {
      if (!mounted) return;
      const payload = resp?.data || {};
      const map: Record<string, string> = {};
      if (Array.isArray(payload)) payload.forEach((it: any) => { if (it.doc_type && it.color) map[it.doc_type] = it.color; });
      else Object.assign(map, payload);
      setSavedColors((prev) => { const merged = { ...prev, ...map }; saveDocTypeColors(merged); return merged; });
    }).catch(() => { /* ignore */ });
    return () => { mounted = false; };
  }, []);

  const updateColor = (type: string, color: string) => {
    setSavedColors((prev) => { const next = { ...prev, [type]: color }; saveDocTypeColors(next); return next; });
    api.post("/documents/doc-type-colors/", { mappings: [{ doc_type: type, color }] }).catch(() => { /* ignore */ });
  };

  const totals = useMemo(() => {
    const t: Record<string, number> = {};
    docTypes.forEach((dt) => { t[dt] = data.reduce((s, row) => s + (Number(row[dt]) || 0), 0); });
    return t;
  }, [data, docTypes]);
  const grand = Object.values(totals).reduce((s, v) => s + v, 0);

  return (
    <>
      <div className="mb-4 flex flex-wrap gap-2">
        {docTypes.map((t, i) => (
          <div key={t} className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorFor(t, i) }} />
            <span className="text-muted-foreground">{t}</span>
            <span className="text-foreground">{totals[t]}</span>
            <span className="text-muted-foreground">({grand ? Math.round((totals[t] / grand) * 100) : 0}%)</span>
            <button type="button" onClick={() => setEditingType(editingType === t ? null : t)} className="ml-1 text-muted-foreground hover:text-foreground">edit</button>
            {editingType === t && (
              <input type="color" value={colorFor(t, i)} onChange={(e) => updateColor(t, e.target.value)} onBlur={() => setEditingType(null)} className="h-5 w-8 rounded" />
            )}
          </div>
        ))}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={data} margin={{ left: -10, right: 8, top: 4, bottom: 0 }} barCategoryGap="30%">
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(210,20%,91%)" vertical={false} />
          <XAxis dataKey="month" tickLine={false} axisLine={false} tick={{ fontSize: 10, fill: BRAND.muted }} interval="preserveStartEnd" />
          <YAxis tickLine={false} axisLine={false} tick={{ fontSize: 11, fill: BRAND.muted }} />
          <Tooltip content={<ChartTooltip />} />
          {docTypes.map((t, i) => (
            <Bar key={t} dataKey={t} stackId="a" fill={colorFor(t, i)} fillOpacity={0.9} radius={i === docTypes.length - 1 ? [4, 4, 0, 0] : [0, 0, 0, 0]} />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </>
  );
}

function UploadersList({ data }: { data: UploaderItem[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);
  return (
    <div className="-mx-5 -mb-5 divide-y divide-border">
      {data.map((p, i) => {
        const approvedPct = p.count ? Math.round((p.approved / p.count) * 100) : 0;
        const barWidth = Math.round((p.count / max) * 100);
        return (
          <div key={p.name + i} className="flex items-center gap-4 px-5 py-3">
            <span className="w-5 shrink-0 text-center text-[13px] font-black tabular-nums" style={{ color: i === 0 ? BRAND.warning : i < 3 ? BRAND.primary : "hsl(210,12%,60%)" }}>{i + 1}</span>
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-black text-white" style={{ background: BRAND.accent }}>
              {p.name.split(" ").map((n) => n[0]).join("").slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between gap-2">
                <p className="truncate text-sm font-semibold text-foreground">{p.name}</p>
                <span className="shrink-0 text-sm font-black tabular-nums text-foreground">{p.count}</span>
              </div>
              <div className="mt-0.5 flex items-center gap-2 text-[11px]">
                <span className="text-muted-foreground">{p.department}</span>
                <span className="text-muted-foreground">·</span>
                <span className="font-medium" style={{ color: approvedPct >= 80 ? BRAND.teal : BRAND.warning }}>{approvedPct}% approved</span>
                {p.rejected > 0 && <><span className="text-muted-foreground">·</span><span className="font-medium" style={{ color: BRAND.danger }}>{p.rejected} rejected</span></>}
              </div>
              <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full transition-all duration-500" style={{ width: `${barWidth}%`, background: BRAND.accent, opacity: 0.75 }} />
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ── Filter bar ────────────────────────────────────────────────────────────── */
function FilterBar({ filters, onChange, departments, docTypes }: {
  filters: Filters;
  onChange: (f: Filters) => void;
  departments: { id: string; name: string }[];
  docTypes: DocumentType[];
}) {
  const periods: Period[] = [3, 6, 12];
  const selectCls = "h-9 rounded-lg border border-border bg-card px-3 text-sm text-foreground outline-none focus:border-primary";
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
        {periods.map((p) => (
          <button key={p} type="button" onClick={() => onChange({ ...filters, months: p })}
            className={`rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-all ${filters.months === p ? "bg-card text-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
            {p}m
          </button>
        ))}
      </div>
      <select value={filters.department} onChange={(e) => onChange({ ...filters, department: e.target.value })} className={selectCls}>
        <option value="">All departments</option>
        {departments.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <select value={filters.document_type} onChange={(e) => onChange({ ...filters, document_type: e.target.value })} className={selectCls}>
        <option value="">All document types</option>
        {docTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    </div>
  );
}

/* ── Page ──────────────────────────────────────────────────────────────────── */
export default function AnalyticsDashboardPage() {
  const [filters, setFilters] = useState<Filters>({ months: 12, department: "", document_type: "" });

  const { data: departments = [] } = useQuery({
    queryKey: ["departments-all"],
    queryFn: () => departmentsAPI.list().then((r) => normalizeListResponse<{ id: string; name: string }>(r.data)),
    ...QUERY_FIVE_MIN_STALE,
  });
  const { data: docTypes = [] } = useQuery({
    queryKey: ["document-types-all"],
    queryFn: () => documentTypesAPI.list().then((r) => normalizeListResponse<DocumentType>(r.data)),
    select: (rows: DocumentType[]) => rows.filter((t) => !SYSTEM_TYPE_CODES.includes((t.code || "").toUpperCase()) && !t.is_personal_type),
    ...QUERY_FIVE_MIN_STALE,
  });

  const overview = useAnalytics<Overview>("overview", "overview", filters);
  const sla = useAnalytics<SlaItem[]>("sla", "sla-breach-rate", filters);
  const status = useAnalytics<StatusItem[]>("status", "status-distribution", filters);
  const turnaround = useAnalytics<TurnaroundItem[]>("turnaround", "approval-turnaround", filters);
  const dept = useAnalytics<DeptItem[]>("dept", "department-activity", filters);
  const volume = useAnalytics<VolumeItem[]>("volume", "document-volume", filters);
  const uploaders = useAnalytics<UploaderItem[]>("uploaders", "top-uploaders", filters);

  return (
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#EDEDED] text-[#1F2933]">
      <div className="flex min-h-[69px] flex-col gap-3 bg-[#287EAD] px-5 py-3 text-white lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70">Manager workspace</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Analytics</h1>
        </div>
        <Link to="/" className="inline-flex h-9 items-center justify-center border border-white/20 bg-[#206D99] px-4 text-sm font-semibold text-white hover:bg-[#1B5F86]">
          Back to dashboard
        </Link>
      </div>

      <div className="space-y-4 p-4 pr-8">
        <FilterBar filters={filters} onChange={setFilters} departments={departments} docTypes={docTypes} />

        <KpiRow query={overview} />

        <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
          <ChartCard icon={AlertTriangle} title="SLA Breach Rate" subtitle="% of completed approvals that exceeded SLA per month"
            query={sla} exportName="sla-breach-rate" exportRows={(d) => d as any}>
            {(d) => <SlaBreachChart data={d} />}
          </ChartCard>

          <ChartCard icon={PieIcon} title="Status Distribution" subtitle="Documents by status in the selected period"
            query={status} exportName="status-distribution" exportRows={(d) => d as any}>
            {(d) => <StatusDonut data={d} />}
          </ChartCard>

          <ChartCard icon={Clock} title="Approval Turnaround" subtitle="Average hours per workflow step vs SLA target"
            query={turnaround} exportName="approval-turnaround" exportRows={(d) => d as any}>
            {(d) => <TurnaroundChart data={d} />}
          </ChartCard>

          <ChartCard icon={Building2} title="Department Activity" subtitle="Approvals, pending and rejections by department"
            query={dept} exportName="department-activity" exportRows={(d) => d as any}>
            {(d) => <DepartmentChart data={d} />}
          </ChartCard>

          <ChartCard icon={FileBarChart} title="Document Volume by Type" subtitle="Monthly upload breakdown across categories"
            query={volume} exportName="document-volume" exportRows={(d) => d as any}>
            {(d) => <VolumeChart data={d} />}
          </ChartCard>

          <ChartCard icon={Users} title="Top Uploaders" subtitle="Staff ranked by submissions this period"
            query={uploaders} exportName="top-uploaders" exportRows={(d) => d as any}>
            {(d) => <UploadersList data={d} />}
          </ChartCard>
        </div>
      </div>
    </div>
  );
}
