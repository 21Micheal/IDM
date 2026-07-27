// AnalyticsDashboard.tsx
// Enterprise analytics workspace for the Flaxem DMS.
//
//  • Global filters: period (3/6/12m) · department · document type — server-side.
//  • Executive KPI row with period-over-period trends (/analytics/overview).
//  • Six cards: SLA breach trend, status distribution, approval turnaround,
//    department activity, document volume by type, top uploaders.
//  • Per-card states (skeleton / empty / error+retry) and export (CSV / PNG / SVG).
//  Access: admins + HOD (department heads).

import { useMemo, useState, useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { toPng, toSvg } from "html-to-image";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { api, departmentsAPI, documentTypesAPI, normalizeListResponse } from "@/services/api";
import { QUERY_FIVE_MIN_STALE } from "@/lib/reactQueryDefaults";
import { exportCsv } from "@/lib/exportCsv";
import CustomListbox from "@/components/ui/CustomListbox";
import { WorkspaceCommandBar } from "@/components/shared/WorkspaceCommandBar";
import type { DocumentType } from "@/types";
import {
  BarChart, Bar, AreaChart, Area, PieChart, Pie,
  XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  ReferenceLine, Cell, LabelList,
} from "recharts";
import {
  AlertTriangle, Clock, FileBarChart, FileText, CheckCircle2, Hourglass,
  Users, Building2, PieChart as PieIcon, Download, Loader2, RefreshCw, Inbox, ShieldCheck,
  Image as ImageIcon, Code, TrendingUp, TrendingDown, Minus, ArrowLeft,
} from "lucide-react";
import { cn } from "@/lib/utils";

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
interface VolumeItem { month: string;[docType: string]: number | string }
interface UploaderItem { name: string; department: string; count: number; approved: number; pending: number; rejected: number }
interface StatusItem { status: string; label: string; count: number }
interface DeptItem { department: string; uploads: number; approved: number; pending: number; rejected: number }

type Period = 3 | 6 | 12;
interface Filters { months: Period; department: string; document_type: string }

/* ── Palette (chart-only) — page chrome uses semantic tokens ─────────────── */
const BRAND = {
  primary: "hsl(203,80%,42%)",
  accent: "hsl(240,40%,50%)",
  teal: "hsl(195,75%,45%)",
  success: "hsl(150,55%,42%)",
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
    <div className="border border-[#C8CDD2] bg-white px-3 py-2.5 text-xs shadow-lg" style={{ minWidth: 150 }}>
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

/* Export dropdown: chart data (CSV) plus the rendered chart as a raster (PNG)
   or vector (SVG) image. The image is snapshotted from the live card body, so
   it includes legends, chips and labels — not just the bare <svg>. */
const IMG_EXPORT_OPTS = { backgroundColor: "#ffffff", pixelRatio: 2, cacheBust: true };

function downloadDataUrl(dataUrl: string, filename: string) {
  const anchor = document.createElement("a");
  anchor.href = dataUrl;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
}

function ExportMenu({ name, captureRef, getRows, disabled }: {
  name: string;
  captureRef: React.RefObject<HTMLDivElement>;
  getRows?: () => Array<Record<string, unknown>>;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const rows = getRows?.() ?? [];

  const exportImage = async (kind: "png" | "svg") => {
    const node = captureRef.current;
    if (!node) return;
    setBusy(true);
    try {
      const dataUrl =
        kind === "png" ? await toPng(node, IMG_EXPORT_OPTS) : await toSvg(node, IMG_EXPORT_OPTS);
      downloadDataUrl(dataUrl, `${name}.${kind}`);
    } catch (err) {
      console.error("Chart image export failed", err);
      window.alert("Sorry — exporting the chart image failed. Please try again.");
    } finally {
      setBusy(false);
      setOpen(false);
    }
  };

  const itemCls =
    "flex w-full items-center gap-2 px-3 py-2 text-left text-xs text-foreground transition hover:bg-muted disabled:cursor-not-allowed disabled:opacity-40";

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={disabled || busy}
        title="Export chart"
        className="border border-[#C8CDD2] bg-white p-1.5 text-[#5E6870] transition hover:bg-[#F5F7F8] hover:text-[#1F2933] disabled:opacity-40"
      >
        {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-44 overflow-hidden border border-[#C8CDD2] bg-white py-1 shadow-lg">
          {getRows && (
            <button
              type="button"
              disabled={rows.length === 0}
              className={itemCls}
              onClick={() => { exportCsv(name, rows); setOpen(false); }}
            >
              <FileText className="h-3.5 w-3.5 text-primary" /> CSV (data)
            </button>
          )}
          <button type="button" className={itemCls} onClick={() => exportImage("png")}>
            <ImageIcon className="h-3.5 w-3.5 text-primary" /> PNG image
          </button>
          <button type="button" className={itemCls} onClick={() => exportImage("svg")}>
            <Code className="h-3.5 w-3.5 text-primary" /> SVG (vector)
          </button>
        </div>
      )}
    </div>
  );
}

/* Chart card — white surface, subtle tinted icon, refined header */
type CardTone = "primary" | "teal" | "accent" | "success" | "warning" | "danger";
const CARD_TONE: Record<CardTone, { icon: string }> = {
  primary: { icon: "bg-primary/10 text-primary" },
  teal: { icon: "bg-teal/10 text-teal" },
  accent: { icon: "bg-accent/10 text-accent" },
  success: { icon: "bg-[hsl(150,55%,42%)]/10 text-[hsl(150,55%,32%)]" },
  warning: { icon: "bg-[hsl(38,90%,50%)]/15 text-[hsl(28,80%,38%)]" },
  danger: { icon: "bg-destructive/10 text-destructive" },
};

function ChartCard<T>({
  icon: Icon, title, subtitle, tone = "primary", query, exportRows, exportName, headerExtra, children,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  tone?: CardTone;
  query: UseQueryResult<T>;
  exportRows?: (data: T) => Array<Record<string, unknown>>;
  exportName?: string;
  headerExtra?: React.ReactNode;
  children: (data: T) => React.ReactNode;
}) {
  const { data, isLoading, isError, refetch, isFetching } = query;
  const isEmpty = !isLoading && !isError && Array.isArray(data) && (data as any[]).length === 0;
  const bodyRef = useRef<HTMLDivElement>(null);
  const t = CARD_TONE[tone];

  return (
    <div className="flex flex-col overflow-hidden border border-[#C8CDD2] bg-white">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#C8CDD2] bg-[#F5F7F8] px-4 py-3">
        <div className="flex items-center gap-3">
          <div className={cn("flex h-9 w-9 items-center justify-center border border-white", t.icon)}>
            <Icon className="h-4 w-4" />
          </div>
          <div>
            <h3 className="text-sm font-semibold text-foreground leading-tight">{title}</h3>
            <p className="text-[11px] text-muted-foreground leading-tight mt-0.5">{subtitle}</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {headerExtra}
          {isFetching && !isLoading && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
          {exportName && (
            <ExportMenu
              name={exportName}
              captureRef={bodyRef}
              getRows={data && exportRows ? () => exportRows(data) : undefined}
              disabled={isLoading || isError || isEmpty || !data}
            />
          )}
        </div>
      </div>

      <div ref={bodyRef} className="flex-1 p-5">
        {isLoading ? (
          <div className="h-[260px] animate-pulse bg-[#EEF1F3]" />
        ) : isError ? (
          <div className="flex h-[260px] flex-col items-center justify-center gap-3 text-sm text-muted-foreground">
            <AlertTriangle className="h-6 w-6 text-destructive" />
            Could not load this chart.
            <button onClick={() => refetch()} className="inline-flex items-center gap-1.5 border border-[#C8CDD2] bg-white px-3 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F5F7F8]">
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

/* ── KPI row — tinted colored tiles ────────────────────────────────────────── */
type KpiTone = "primary" | "success" | "warning" | "teal" | "accent" | "indigo";
const KPI_TONE: Record<KpiTone, {
  bg: string; border: string;
  iconBg: string; iconText: string;
  label: string; value: string;
}> = {
  // Documents — primary blue
  primary: {
    bg: "bg-[hsl(203,80%,42%)]/[0.06]",
    border: "border-[hsl(203,80%,42%)]/25",
    iconBg: "bg-[hsl(203,80%,42%)]",
    iconText: "text-white",
    label: "text-[hsl(203,65%,32%)]",
    value: "text-[hsl(203,80%,30%)]",
  },
  // Approved — light green
  success: {
    bg: "bg-[hsl(150,55%,42%)]/[0.07]",
    border: "border-[hsl(150,55%,42%)]/25",
    iconBg: "bg-[hsl(150,55%,38%)]",
    iconText: "text-white",
    label: "text-[hsl(150,45%,28%)]",
    value: "text-[hsl(150,55%,26%)]",
  },
  // Pending — amber
  warning: {
    bg: "bg-[hsl(38,90%,50%)]/[0.08]",
    border: "border-[hsl(38,90%,50%)]/30",
    iconBg: "bg-[hsl(38,90%,46%)]",
    iconText: "text-white",
    label: "text-[hsl(28,80%,32%)]",
    value: "text-[hsl(28,80%,26%)]",
  },
  // Turnaround — teal
  teal: {
    bg: "bg-[hsl(195,75%,45%)]/[0.07]",
    border: "border-[hsl(195,75%,45%)]/25",
    iconBg: "bg-[hsl(195,75%,40%)]",
    iconText: "text-white",
    label: "text-[hsl(195,60%,28%)]",
    value: "text-[hsl(195,75%,26%)]",
  },
  // SLA — indigo/accent
  accent: {
    bg: "bg-[hsl(240,40%,50%)]/[0.07]",
    border: "border-[hsl(240,40%,50%)]/25",
    iconBg: "bg-[hsl(240,40%,48%)]",
    iconText: "text-white",
    label: "text-[hsl(240,35%,35%)]",
    value: "text-[hsl(240,40%,32%)]",
  },
  // Uploaders — indigo-blue (distinct from primary)
  indigo: {
    bg: "bg-[hsl(220,60%,50%)]/[0.07]",
    border: "border-[hsl(220,60%,50%)]/25",
    iconBg: "bg-[hsl(220,60%,46%)]",
    iconText: "text-white",
    label: "text-[hsl(220,50%,32%)]",
    value: "text-[hsl(220,60%,28%)]",
  },
};

function KpiTile({
  title, value, icon: Icon, tone, trend,
}: {
  title: string; value: string | number; icon: React.ElementType; tone: KpiTone;
  trend?: { value: number; isPositive: boolean; direction: "up" | "down" | "flat" };
}) {
  const t = KPI_TONE[tone];
  const TrendIcon = trend?.direction === "flat" ? Minus : trend?.direction === "up" ? TrendingUp : TrendingDown;
  return (
    <div className={cn("border p-4 transition", t.bg, t.border)}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className={cn("text-[10px] font-bold uppercase tracking-widest", t.label)}>{title}</p>
          <p className={cn("mt-2 text-[1.65rem] font-bold tracking-tight tabular-nums leading-none", t.value)}>{value}</p>
        </div>
        {/* Icon chip — square, slightly larger */}
        <div className={cn(
          "flex h-11 w-11 shrink-0 items-center justify-center shadow-sm",
          t.iconBg, t.iconText,
        )}>
          <Icon className="h-5 w-5" />
        </div>
      </div>
      {trend ? (
        <div className="mt-3 flex items-center gap-1.5">
          <span className={cn(
            "inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-bold",
            trend.isPositive
              ? "bg-[hsl(150,55%,42%)]/20 text-[hsl(150,45%,28%)]"
              : "bg-[hsl(0,84%,46%)]/15 text-[hsl(0,72%,38%)]",
          )}>
            <TrendIcon className="h-3 w-3" />
            {trend.value.toFixed(1)}%
          </span>
          <span className="text-[10px] text-muted-foreground">vs prev period</span>
        </div>
      ) : (
        /* spacer so all tiles are the same height */
        <div className="mt-3 h-[22px]" />
      )}
    </div>
  );
}

function kpiTrend(m: Metric | undefined, higherIsBetter: boolean) {
  if (!m || m.delta_pct === null || m.delta_pct === undefined) return undefined;
  const up = m.delta_pct >= 0;
  return {
    value: Math.abs(m.delta_pct),
    isPositive: higherIsBetter ? up : !up,
    direction: (m.delta_pct === 0 ? "flat" : up ? "up" : "down") as "up" | "down" | "flat",
  };
}
const fmt = (v: number | null | undefined, suffix = "") =>
  v === null || v === undefined ? "—" : `${Math.round(v * 10) / 10}${suffix}`;

function KpiRow({ query }: { query: UseQueryResult<Overview> }) {
  const { data, isLoading } = query;
  if (isLoading) {
    return (
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => <div key={i} className="h-[104px] animate-pulse border border-[#C8CDD2] bg-white" />)}
      </div>
    );
  }
  if (!data) return null;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-3 xl:grid-cols-6">
      <KpiTile title="Documents" value={data.documents.current ?? 0} icon={FileText} tone="primary" trend={kpiTrend(data.documents, true)} />
      <KpiTile title="Approved" value={data.approved.current ?? 0} icon={CheckCircle2} tone="success" trend={kpiTrend(data.approved, true)} />
      <KpiTile title="Pending backlog" value={data.pending_now} icon={Hourglass} tone="warning" />
      <KpiTile title="Avg turnaround" value={fmt(data.avg_turnaround_hours.current, "h")} icon={Clock} tone="teal" trend={kpiTrend(data.avg_turnaround_hours, false)} />
      <KpiTile title="SLA compliance" value={fmt(data.sla_compliance.current, "%")} icon={ShieldCheck} tone="accent" trend={kpiTrend(data.sla_compliance, true)} />
      <KpiTile title="Active uploaders" value={data.active_uploaders.current ?? 0} icon={Users} tone="indigo" trend={kpiTrend(data.active_uploaders, true)} />
    </div>
  );
}

function ExecutiveBrief({
  overview,
  sla,
  turnaround,
}: {
  overview: UseQueryResult<Overview>;
  sla: UseQueryResult<SlaItem[]>;
  turnaround: UseQueryResult<TurnaroundItem[]>;
}) {
  const data = overview.data;
  const slaRows = sla.data ?? [];
  const turnRows = turnaround.data ?? [];
  const avgBreach = slaRows.length
    ? slaRows.reduce((sum, row) => sum + row.breach_rate, 0) / slaRows.length
    : 0;
  const breachingSteps = turnRows.filter((row) => row.avg_hours > row.sla_hours);
  const backlog = data?.pending_now ?? 0;

  const items = [
    {
      label: "Manager focus",
      value: backlog > 0 ? `${backlog} pending document${backlog === 1 ? "" : "s"}` : "No pending backlog",
      detail: backlog > 0 ? "Prioritize ageing approvals and held tasks." : "Approval queue is currently clear.",
      tone: backlog > 0 ? "text-[hsl(28,80%,34%)]" : "text-[hsl(150,45%,30%)]",
    },
    {
      label: "SLA risk",
      value: `${Math.round(avgBreach * 10) / 10}% breach average`,
      detail: avgBreach > 10 ? "Above target; check bottleneck steps." : "Within the 10% breach target.",
      tone: avgBreach > 10 ? "text-destructive" : "text-[hsl(150,45%,30%)]",
    },
    {
      label: "Workflow bottlenecks",
      value: breachingSteps.length ? `${breachingSteps.length} step${breachingSteps.length === 1 ? "" : "s"} breaching` : "No breaching steps",
      detail: breachingSteps[0]?.step ? `Worst: ${breachingSteps[0].step}` : "Average step times are within target.",
      tone: breachingSteps.length ? "text-destructive" : "text-[hsl(150,45%,30%)]",
    },
  ];

  if (overview.isLoading || sla.isLoading || turnaround.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, index) => (
          <div key={index} className="h-[76px] animate-pulse border border-[#C8CDD2] bg-white" />
        ))}
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
      {items.map((item) => (
        <div key={item.label} className="border border-[#C8CDD2] bg-white px-4 py-3">
          <p className="text-[10px] font-bold uppercase tracking-wider text-[#5E6870]">{item.label}</p>
          <p className={`mt-1 text-sm font-bold ${item.tone}`}>{item.value}</p>
          <p className="mt-1 text-xs text-[#5E6870]">{item.detail}</p>
        </div>
      ))}
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
        <Bar dataKey="approved" name="Approved" stackId="a" fill={BRAND.success} maxBarSize={22} />
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
          <div key={t} className="flex items-center gap-1.5 border border-[#C8CDD2] bg-[#F5F7F8] px-2.5 py-1 text-[11px] font-semibold">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: colorFor(t, i) }} />
            <span className="text-muted-foreground">{t}</span>
            <span className="text-foreground">{totals[t]}</span>
            <span className="text-muted-foreground">({grand ? Math.round((totals[t] / grand) * 100) : 0}%)</span>
            <button type="button" onClick={() => setEditingType(editingType === t ? null : t)} className="ml-1 text-muted-foreground hover:text-foreground">edit</button>
            {editingType === t && (
              <input type="color" value={colorFor(t, i)} onChange={(e) => updateColor(t, e.target.value)} onBlur={() => setEditingType(null)} className="h-5 w-8" />
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
          <div key={p.name + i} className="flex items-center gap-4 px-5 py-3 transition hover:bg-muted/40">
            <span className="w-5 shrink-0 text-center text-[13px] font-black tabular-nums" style={{ color: i === 0 ? BRAND.warning : i < 3 ? BRAND.primary : "hsl(210,12%,60%)" }}>{i + 1}</span>
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-black text-primary-foreground" style={{ background: BRAND.primary }}>
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
                <span className="font-medium" style={{ color: approvedPct >= 80 ? BRAND.success : BRAND.warning }}>{approvedPct}% approved</span>
                {p.rejected > 0 && <><span className="text-muted-foreground">·</span><span className="font-medium" style={{ color: BRAND.danger }}>{p.rejected} rejected</span></>}
              </div>
              <div className="mt-1.5 h-1 w-full overflow-hidden bg-[#E3E7EA]">
                <div className="h-full transition-all duration-500" style={{ width: `${barWidth}%`, background: BRAND.primary, opacity: 0.85 }} />
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
  const selectCls = "h-9 border border-[#AEB5BB] bg-white px-2.5 text-sm text-[#1F2933] outline-none focus:border-[#287EAD] focus:ring-1 focus:ring-[#287EAD]";
  return (
    <div className="flex flex-wrap items-center gap-2">
      {/* Period toggle */}
      <div className="inline-flex border border-[#AEB5BB] bg-white">
        {periods.map((p) => (
          <button key={p} type="button" onClick={() => onChange({ ...filters, months: p })}
            className={cn(
              "px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wide transition-colors",
              filters.months === p ? "bg-[#287EAD] text-white" : "text-[#5E6870] hover:bg-[#F5F7F8] hover:text-[#1F2933]",
            )}>
            {p}m
          </button>
        ))}
      </div>
      <CustomListbox
        value={filters.department}
        onChange={(v) => onChange({ ...filters, department: v })}
        options={[{ value: "", label: "All departments" }, ...departments.map((d) => ({ value: d.id, label: d.name }))]}
        buttonClassName={selectCls}
        ariaLabel="Analytics department filter"
      />
      <CustomListbox
        value={filters.document_type}
        onChange={(v) => onChange({ ...filters, document_type: v })}
        options={[{ value: "", label: "All document types" }, ...docTypes.map((t) => ({ value: t.id, label: t.name }))]}
        buttonClassName={selectCls}
        ariaLabel="Analytics document type filter"
      />
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
    <div className="min-h-screen bg-[#EDEDED] text-[#1F2933]">
      <WorkspaceCommandBar
        actions={<FilterBar filters={filters} onChange={setFilters} departments={departments} docTypes={docTypes} />}
      >
        <div className="flex items-center gap-3">
          <Link
            to="/"
            className="inline-flex h-9 w-9 items-center justify-center border border-white/20 bg-[#206D99] text-white transition hover:bg-white/10"
            title="Back to Dashboard"
          >
            <ArrowLeft className="h-4 w-4" />
          </Link>
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-[0.22em] text-white/70">Manager workspace</p>
            <h1 className="mt-0.5 text-xl font-semibold tracking-tight">Analytics</h1>
          </div>
        </div>
      </WorkspaceCommandBar>

      {/* KPI strip */}
      <div className="space-y-4 border-b border-[#C8CDD2] bg-[#F5F7F8] px-5 py-4 pr-8">
        <KpiRow query={overview} />
        <ExecutiveBrief overview={overview} sla={sla} turnaround={turnaround} />
      </div>

      {/* Chart grid */}
      <div className="grid grid-cols-1 gap-4 p-4 pr-8 xl:grid-cols-2">
        <ChartCard icon={AlertTriangle} title="SLA Breach Rate" subtitle="% of completed approvals that exceeded SLA per month"
          tone="danger" query={sla} exportName="sla-breach-rate" exportRows={(d) => d as any}>
          {(d) => <SlaBreachChart data={d} />}
        </ChartCard>
        <ChartCard icon={PieIcon} title="Status Distribution" subtitle="Documents by status in the selected period"
          tone="primary" query={status} exportName="status-distribution" exportRows={(d) => d as any}>
          {(d) => <StatusDonut data={d} />}
        </ChartCard>
        <ChartCard icon={Clock} title="Approval Turnaround" subtitle="Average hours per workflow step vs SLA target"
          tone="teal" query={turnaround} exportName="approval-turnaround" exportRows={(d) => d as any}>
          {(d) => <TurnaroundChart data={d} />}
        </ChartCard>
        <ChartCard icon={Building2} title="Department Activity" subtitle="Approvals, pending and rejections by department"
          tone="accent" query={dept} exportName="department-activity" exportRows={(d) => d as any}>
          {(d) => <DepartmentChart data={d} />}
        </ChartCard>
        <ChartCard icon={FileBarChart} title="Document Volume by Type" subtitle="Monthly upload breakdown across categories"
          tone="primary" query={volume} exportName="document-volume" exportRows={(d) => d as any}>
          {(d) => <VolumeChart data={d} />}
        </ChartCard>
        <ChartCard icon={Users} title="Top Uploaders" subtitle="Staff ranked by submissions this period"
          tone="success" query={uploaders} exportName="top-uploaders" exportRows={(d) => d as any}>
          {(d) => <UploadersList data={d} />}
        </ChartCard>
      </div>
    </div>
  );
}
