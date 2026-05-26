// AnalyticsDashboard.tsx
// Manager-grade analytics section for the Flaxem DMS dashboard.
//
// Charts:
//   1. Approval Turnaround — avg hours per workflow step (BarChart)
//   2. SLA Breach Rate — % breached per month (AreaChart + reference line)
//   3. Document Volume by Type per Month (StackedBarChart)
//   4. Top Uploaders — leaderboard with relative bar (custom)
//
// Usage in DashboardPage.tsx (after the StatCard grid, before the 2-col section):
//   import { AnalyticsDashboard } from "@/components/dashboard/AnalyticsDashboard";
//   <AnalyticsDashboard />
//
// Backend integration notes (replace mock hooks with real useQuery calls):
//   GET /analytics/approval-turnaround/   → ApprovalTurnaroundItem[]
//   GET /analytics/sla-breach-rate/       → SlaBreachItem[]
//   GET /analytics/document-volume/       → VolumeItem[]
//   GET /analytics/top-uploaders/         → UploaderItem[]

import { useMemo, useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/services/api";
import { useAuthStore } from "@/store/authStore";
import { QUERY_FIVE_MIN_STALE } from "@/lib/reactQueryDefaults";
import {
  BarChart,
  Bar,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ReferenceLine,
  Cell,
  LabelList,
} from "recharts";
import {
  AlertTriangle,
  BarChart2,
  ChevronDown,
  Clock,
  FileBarChart,
  Layers,
  Loader2,
  TrendingDown,
  TrendingUp,
  Users,
} from "lucide-react";

/* ─────────────────────────────────────────────────────────────────────── */
/* Types                                                                    */
/* ─────────────────────────────────────────────────────────────────────── */

export interface ApprovalTurnaroundItem {
  step: string;          // e.g. "HOD Review"
  avg_hours: number;
  sla_hours: number;     // SLA target
  completed: number;     // sample size
}

export interface SlaBreachItem {
  month: string;         // "Jan 2025"
  total: number;
  breached: number;
  breach_rate: number;   // 0–100
}

export interface VolumeItem {
  month: string;         // "Jan 2025"
  [docType: string]: number | string; // doc type keys + "month"
}

export interface UploaderItem {
  name: string;
  department: string;
  count: number;
  approved: number;
  pending: number;
}

type AnalyticsRange = "3m" | "6m" | "12m";

/* ─────────────────────────────────────────────────────────────────────── */
/* Mock data — replace with real useQuery hooks                             */
/* ─────────────────────────────────────────────────────────────────────── */

const MOCK_TURNAROUND: ApprovalTurnaroundItem[] = [
  { step: "Initial Review",   avg_hours: 6.2,  sla_hours: 8,  completed: 142 },
  { step: "HOD Review",       avg_hours: 18.5, sla_hours: 16, completed: 118 },
  { step: "Finance Check",    avg_hours: 11.3, sla_hours: 12, completed: 95  },
  { step: "Legal Sign-Off",   avg_hours: 29.1, sla_hours: 24, completed: 72  },
  { step: "CEO Approval",     avg_hours: 9.8,  sla_hours: 12, completed: 61  },
  { step: "Archive",          avg_hours: 1.2,  sla_hours: 4,  completed: 58  },
];

const MOCK_SLA: SlaBreachItem[] = [
  { month: "Jan",  total: 108, breached: 9,  breach_rate: 8.3  },
  { month: "Feb",  total: 122, breached: 14, breach_rate: 11.5 },
  { month: "Mar",  total: 145, breached: 11, breach_rate: 7.6  },
  { month: "Apr",  total: 131, breached: 22, breach_rate: 16.8 },
  { month: "May",  total: 153, breached: 19, breach_rate: 12.4 },
  { month: "Jun",  total: 161, breached: 16, breach_rate: 9.9  },
  { month: "Jul",  total: 147, breached: 28, breach_rate: 19.0 },
  { month: "Aug",  total: 168, breached: 21, breach_rate: 12.5 },
  { month: "Sep",  total: 175, breached: 17, breach_rate: 9.7  },
  { month: "Oct",  total: 182, breached: 13, breach_rate: 7.1  },
  { month: "Nov",  total: 156, breached: 18, breach_rate: 11.5 },
  { month: "Dec",  total: 134, breached: 24, breach_rate: 17.9 },
];

const MOCK_VOLUME: VolumeItem[] = [
  { month: "Jan", Invoice: 34, Contract: 18, Report: 27, Policy: 12, Other: 17 },
  { month: "Feb", Invoice: 42, Contract: 21, Report: 31, Policy: 9,  Other: 19 },
  { month: "Mar", Invoice: 38, Contract: 25, Report: 28, Policy: 15, Other: 39 },
  { month: "Apr", Invoice: 51, Contract: 19, Report: 22, Policy: 11, Other: 28 },
  { month: "May", Invoice: 47, Contract: 30, Report: 36, Policy: 18, Other: 22 },
  { month: "Jun", Invoice: 55, Contract: 27, Report: 33, Policy: 14, Other: 32 },
  { month: "Jul", Invoice: 49, Contract: 22, Report: 29, Policy: 16, Other: 31 },
  { month: "Aug", Invoice: 61, Contract: 35, Report: 38, Policy: 20, Other: 14 },
  { month: "Sep", Invoice: 58, Contract: 31, Report: 42, Policy: 13, Other: 31 },
  { month: "Oct", Invoice: 67, Contract: 28, Report: 35, Policy: 22, Other: 30 },
  { month: "Nov", Invoice: 53, Contract: 24, Report: 31, Policy: 17, Other: 31 },
  { month: "Dec", Invoice: 45, Contract: 20, Report: 27, Policy: 10, Other: 32 },
];

const MOCK_UPLOADERS: UploaderItem[] = [
  { name: "Amina Ochieng",    department: "Finance",    count: 87, approved: 74, pending: 13 },
  { name: "David Kariuki",    department: "Legal",      count: 73, approved: 65, pending: 8  },
  { name: "Fatuma Hassan",    department: "Procurement",count: 61, approved: 51, pending: 10 },
  { name: "John Mwangi",      department: "HR",         count: 58, approved: 50, pending: 8  },
  { name: "Grace Njeri",      department: "Operations", count: 52, approved: 44, pending: 8  },
  { name: "Peter Otieno",     department: "Finance",    count: 49, approved: 41, pending: 8  },
  { name: "Zainab Ali",       department: "Legal",      count: 44, approved: 39, pending: 5  },
  { name: "Brian Mutua",      department: "IT",         count: 38, approved: 30, pending: 8  },
];

/* ─────────────────────────────────────────────────────────────────────── */
/* Palette — aligned with index.css brand tokens                           */
/* ─────────────────────────────────────────────────────────────────────── */

// Primary blue: hsl(203 80% 42%) ≈ #147eb3
// Accent indigo: hsl(240 40% 35%) ≈ #3d3d8f
// Teal: hsl(195 75% 45%) ≈ #1ba0b8
// Destructive: hsl(0 84% 38%) ≈ #b71c1c

const BRAND = {
  primary:     "hsl(203,80%,42%)",
  primaryLight:"hsl(203,80%,80%)",
  accent:      "hsl(240,40%,50%)",
  teal:        "hsl(195,75%,45%)",
  tealLight:   "hsl(195,75%,82%)",
  danger:      "hsl(0,84%,46%)",
  dangerLight: "hsl(0,84%,88%)",
  warning:     "hsl(38,90%,50%)",
  neutral:     "hsl(210,20%,88%)",
  muted:       "hsl(210,12%,55%)",
};

const DOC_TYPE_COLORS: Record<string, string> = {
  Invoice:  "hsl(203,80%,42%)",
  Contract: "hsl(240,40%,50%)",
  Report:   "hsl(195,75%,45%)",
  Policy:   "hsl(38,90%,50%)",
  Other:    "hsl(210,20%,68%)",
};

// Local persistence for user-customised doc-type colours
const DOC_TYPE_COLORS_STORAGE_KEY = "analytics.docTypeColors.v1";

function loadSavedDocTypeColors(): Record<string, string> {
  try {
    if (typeof window === "undefined") return {};
    const raw = localStorage.getItem(DOC_TYPE_COLORS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch (e) {
    return {};
  }
}

function saveDocTypeColors(map: Record<string, string>) {
  try {
    if (typeof window === "undefined") return;
    localStorage.setItem(DOC_TYPE_COLORS_STORAGE_KEY, JSON.stringify(map));
  } catch (e) {
    // ignore
  }
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Shared UI atoms                                                          */
/* ─────────────────────────────────────────────────────────────────────── */

function SectionHeader({
  icon: Icon,
  title,
  subtitle,
  children,
}: {
  icon: React.ElementType;
  title: string;
  subtitle: string;
  children?: React.ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border px-5 py-4">
      <div className="flex items-center gap-3">
        <div
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg text-primary-foreground"
          style={{ background: BRAND.primary }}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div>
          <h3 className="text-sm font-semibold text-foreground">{title}</h3>
          <p className="text-xs text-muted-foreground">{subtitle}</p>
        </div>
      </div>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  );
}

function RangeToggle({
  value,
  onChange,
}: {
  value: AnalyticsRange;
  onChange: (r: AnalyticsRange) => void;
}) {
  const options: AnalyticsRange[] = ["3m", "6m", "12m"];
  return (
    <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
      {options.map((opt) => (
        <button
          key={opt}
          type="button"
          onClick={() => onChange(opt)}
          className={`rounded-md px-3 py-1 text-[11px] font-semibold uppercase tracking-wide transition-all ${
            value === opt
              ? "bg-card text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          {opt}
        </button>
      ))}
    </div>
  );
}

function KpiChip({
  label,
  value,
  positive,
  icon: Icon,
}: {
  label: string;
  value: string;
  positive: boolean;
  icon: React.ElementType;
}) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs">
      <Icon
        className="h-3.5 w-3.5 shrink-0"
        style={{ color: positive ? BRAND.teal : BRAND.danger }}
      />
      <span className="text-muted-foreground">{label}:</span>
      <span
        className="font-bold"
        style={{ color: positive ? BRAND.teal : BRAND.danger }}
      >
        {value}
      </span>
    </div>
  );
}

/* Custom tooltip — styled to match the Flaxem card aesthetic */
function ChartTooltip({
  active,
  payload,
  label,
  formatter,
}: {
  active?: boolean;
  payload?: any[];
  label?: string;
  formatter?: (name: string, value: number) => string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div
      className="rounded-xl border border-border bg-card px-3 py-2.5 text-xs shadow-lg"
      style={{ minWidth: 140 }}
    >
      {label && (
        <p className="mb-1.5 font-semibold text-foreground border-b border-border pb-1">
          {label}
        </p>
      )}
      {payload.map((p, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <span
              className="inline-block h-2 w-2 rounded-full"
              style={{ background: p.color ?? p.fill }}
            />
            {p.name}
          </span>
          <span className="font-semibold text-foreground">
            {formatter ? formatter(p.name, p.value) : p.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Chart 1 — Approval Turnaround                                           */
/* ─────────────────────────────────────────────────────────────────────── */

function ApprovalTurnaroundChart({ data }: { data: ApprovalTurnaroundItem[] }) {
  const avgOverall = data.length
    ? (data.reduce((s, d) => s + d.avg_hours, 0) / data.length).toFixed(1)
    : "—";

  const breachCount = data.filter((d) => d.avg_hours > d.sla_hours).length;

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      style={{ boxShadow: "var(--shadow-card)" }}
    >
      <SectionHeader
        icon={Clock}
        title="Approval Turnaround"
        subtitle="Average hours per workflow step vs SLA target"
      >
        <KpiChip
          label="Avg"
          value={`${avgOverall}h`}
          positive={Number(avgOverall) < 16}
          icon={Clock}
        />
        {breachCount > 0 && (
          <KpiChip
            label="Breaching"
            value={`${breachCount} steps`}
            positive={false}
            icon={AlertTriangle}
          />
        )}
      </SectionHeader>

      <div className="p-5">
        <ResponsiveContainer width="100%" height={260}>
          <BarChart
            data={data}
            layout="vertical"
            margin={{ left: 0, right: 40, top: 4, bottom: 4 }}
            barCategoryGap="28%"
          >
            <CartesianGrid
              horizontal={false}
              strokeDasharray="3 3"
              stroke="hsl(210,20%,91%)"
            />
            <XAxis
              type="number"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "hsl(210,12%,55%)" }}
              tickFormatter={(v: number) => `${v}h`}
            />
            <YAxis
              type="category"
              dataKey="step"
              width={108}
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "hsl(210,12%,45%)", fontWeight: 500 }}
            />
            <Tooltip
              content={
                <ChartTooltip formatter={(_name: string, val: number) => `${val}h`} />
              }
            />
            <Bar dataKey="avg_hours" name="Avg Hours" radius={[0, 4, 4, 0]} maxBarSize={22}>
              {data.map((entry, index) => (
                <Cell
                  key={index}
                  fill={entry.avg_hours > entry.sla_hours ? BRAND.danger : BRAND.primary}
                  fillOpacity={0.88}
                />
              ))}
              <LabelList
                dataKey="avg_hours"
                position="right"
                formatter={(v: number) => `${v}h`}
                style={{ fontSize: 11, fontWeight: 600, fill: "hsl(222,30%,20%)" }}
              />
            </Bar>
            {/* SLA reference markers rendered as a scatter would overlap — */}
            {/* instead we show SLA as a second narrow bar for comparison.   */}
            <Bar
              dataKey="sla_hours"
              name="SLA Target"
              radius={[0, 4, 4, 0]}
              maxBarSize={8}
              fill={BRAND.neutral}
              fillOpacity={0.6}
            />
            <Legend
              iconType="circle"
              iconSize={8}
              wrapperStyle={{ fontSize: 11, paddingTop: 8 }}
              formatter={(value) =>
                value === "avg_hours" ? "Actual avg" : "SLA target"
              }
            />
          </BarChart>
        </ResponsiveContainer>

        <p className="mt-2 text-[11px] text-muted-foreground">
          Red bars indicate steps exceeding their SLA target.{" "}
          <span className="font-medium text-foreground">
            {breachCount} of {data.length} steps
          </span>{" "}
          are currently breaching.
        </p>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Chart 2 — SLA Breach Rate                                               */
/* ─────────────────────────────────────────────────────────────────────── */

function SlaBreachRateChart({
  data,
  range,
  onRangeChange,
}: {
  data: SlaBreachItem[];
  range: AnalyticsRange;
  onRangeChange: (r: AnalyticsRange) => void;
}) {
  const sliced = useMemo(() => {
    const n = range === "3m" ? 3 : range === "6m" ? 6 : 12;
    return data.slice(-n);
  }, [data, range]);

  const avg = sliced.length
    ? (sliced.reduce((s, d) => s + d.breach_rate, 0) / sliced.length).toFixed(1)
    : "—";

  const trend = sliced.length >= 2
    ? sliced[sliced.length - 1].breach_rate - sliced[0].breach_rate
    : 0;

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      style={{ boxShadow: "var(--shadow-card)" }}
    >
      <SectionHeader
        icon={AlertTriangle}
        title="SLA Breach Rate"
        subtitle="% of workflow instances that exceeded SLA per month"
      >
        <RangeToggle value={range} onChange={onRangeChange} />
      </SectionHeader>

      <div className="p-5">
        {/* KPI strip */}
        <div className="mb-4 flex flex-wrap gap-3">
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-center">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Avg Rate</p>
            <p
              className="mt-0.5 text-2xl font-black tabular-nums"
              style={{ color: Number(avg) > 10 ? BRAND.danger : BRAND.teal }}
            >
              {avg}%
            </p>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-center">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Trend</p>
            <div className="mt-0.5 flex items-center justify-center gap-1">
              {trend > 0 ? (
                <TrendingUp className="h-5 w-5" style={{ color: BRAND.danger }} />
              ) : (
                <TrendingDown className="h-5 w-5" style={{ color: BRAND.teal }} />
              )}
              <span
                className="text-2xl font-black tabular-nums"
                style={{ color: trend > 0 ? BRAND.danger : BRAND.teal }}
              >
                {Math.abs(trend).toFixed(1)}%
              </span>
            </div>
          </div>
          <div className="rounded-lg border border-border bg-muted/30 px-4 py-2.5 text-center">
            <p className="text-[10px] font-bold uppercase tracking-widest text-muted-foreground">Total Breaches</p>
            <p className="mt-0.5 text-2xl font-black tabular-nums text-foreground">
              {sliced.reduce((s, d) => s + d.breached, 0)}
            </p>
          </div>
        </div>

        <ResponsiveContainer width="100%" height={230}>
          <AreaChart
            data={sliced}
            margin={{ left: -10, right: 8, top: 4, bottom: 0 }}
          >
            <defs>
              <linearGradient id="slaGradient" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%"  stopColor={BRAND.danger} stopOpacity={0.22} />
                <stop offset="95%" stopColor={BRAND.danger} stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(210,20%,91%)" />
            <XAxis
              dataKey="month"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "hsl(210,12%,55%)" }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "hsl(210,12%,55%)" }}
              tickFormatter={(v: number) => `${v}%`}
              domain={[0, "dataMax + 5"]}
            />
            <Tooltip
              content={
                <ChartTooltip
                  formatter={(name: string, val: number) =>
                    name === "breach_rate" ? `${val}%` : String(val)
                  }
                />
              }
            />
            <ReferenceLine
              y={10}
              stroke={BRAND.warning}
              strokeDasharray="5 3"
              label={{
                value: "10% target",
                position: "right",
                fontSize: 10,
                fill: BRAND.warning,
              }}
            />
            <Area
              type="monotone"
              dataKey="breach_rate"
              name="Breach Rate"
              stroke={BRAND.danger}
              strokeWidth={2.5}
              fill="url(#slaGradient)"
              dot={{ r: 3, fill: BRAND.danger, strokeWidth: 0 }}
              activeDot={{ r: 5 }}
            />
          </AreaChart>
        </ResponsiveContainer>

        <p className="mt-2 text-[11px] text-muted-foreground">
          Dashed line shows the 10% SLA breach target. Values above it require process review.
        </p>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Chart 3 — Document Volume by Type                                       */
/* ─────────────────────────────────────────────────────────────────────── */

const DOC_TYPES = ["Invoice", "Contract", "Report", "Policy", "Other"];

function DocumentVolumeChart({
  data,
  range,
  onRangeChange,
}: {
  data: VolumeItem[];
  range: AnalyticsRange;
  onRangeChange: (r: AnalyticsRange) => void;
}) {
  const sliced = useMemo(() => {
    const n = range === "3m" ? 3 : range === "6m" ? 6 : 12;
    return data.slice(-n);
  }, [data, range]);

  // Discover document types from the incoming data (fallback to static DOC_TYPES)
  const docTypes = useMemo(() => {
    const set = new Set<string>();
    (data || []).forEach((row) => {
      Object.keys(row || {}).forEach((k) => {
        if (k !== "month") set.add(k);
      });
    });
    // Prefer the static order for known types, then append any extras
    const extras = Array.from(set).filter((k) => !DOC_TYPES.includes(k));
    const ordered = DOC_TYPES.filter((t) => set.has(t)).concat(extras);
    return ordered.length ? ordered : DOC_TYPES;
  }, [data]);

  // Build a color map for discovered types, preserving known colors
  const docTypeColors = useMemo(() => {
    const palette = [
      "#147eb3",
      "#3d3d8f",
      "#1ba0b8",
      "#b71c1c",
      "#d0d6e8",
      "#a78bfa",
      "#3cb371",
    ];
    const persisted = loadSavedDocTypeColors();
    const map: Record<string, string> = {};
    docTypes.forEach((t, i) => {
      if (persisted[t]) map[t] = persisted[t];
      else if (DOC_TYPE_COLORS[t]) map[t] = DOC_TYPE_COLORS[t];
      else map[t] = palette[i % palette.length];
    });
    return map;
  }, [docTypes]);

  // Saved colors in state so change reflects immediately in the UI
  const [savedColors, setSavedColors] = useState<Record<string, string>>(() => loadSavedDocTypeColors());
  const [editingType, setEditingType] = useState<string | null>(null);

  function updateSavedColor(type: string, color: string) {
    const next = { ...(savedColors || {}), [type]: color };
    setSavedColors(next);
    saveDocTypeColors(next);
    // also persist to server for org-wide settings
    try {
      api.post("/documents/doc-type-colors/", { mappings: [{ doc_type: type, color }] });
    } catch (e) {
      // ignore network errors for now
    }
  }

  // Load persisted mappings from server on mount and merge with local saved colors
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        const resp = await api.get("/documents/doc-type-colors/");
        if (!mounted) return;
        const payload = resp?.data || {};
        // payload expected as { doc_type: color, ... } or list
        const map: Record<string, string> = {};
        if (Array.isArray(payload)) {
          payload.forEach((item: any) => {
            if (item.doc_type && item.color) map[item.doc_type] = item.color;
          });
        } else {
          Object.assign(map, payload);
        }
        const merged = { ...(savedColors || {}), ...map };
        setSavedColors(merged);
        saveDocTypeColors(merged);
      } catch (err) {
        // ignore
      }
    })();
    return () => { mounted = false; };
  }, []);

  // Normalize rows to guarantee each discovered doc type key exists and is numeric
  const normalized = useMemo(() => {
    return sliced.map((row) => {
      const out: Record<string, any> = { month: row.month };
      docTypes.forEach((t) => {
        const raw = row[t] ?? row[t.toLowerCase()] ?? 0;
        out[t] = Number(raw) || 0;
      });
      return out as VolumeItem;
    });
  }, [sliced, docTypes]);

  const totals = useMemo(
    () =>
      docTypes.reduce((acc, t) => ({ ...acc, [t]: normalized.reduce((s, row) => s + (Number(row[t]) || 0), 0) }), {} as Record<string, number>),
    [normalized, docTypes],
  );

  const grandTotal = Object.values(totals).reduce((s, v) => s + v, 0);

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      style={{ boxShadow: "var(--shadow-card)" }}
    >
      <SectionHeader
        icon={FileBarChart}
        title="Document Volume by Type"
        subtitle="Monthly upload breakdown across document categories"
      >
        <RangeToggle value={range} onChange={onRangeChange} />
      </SectionHeader>

      <div className="p-5">
        {/* Type legend strips */}
        <div className="mb-4 flex flex-wrap gap-2">
          {docTypes.map((t) => (
            <div
              key={t}
              className="flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] font-semibold"
            >
              <span
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: savedColors[t] ?? docTypeColors[t] }}
              />
              <span className="text-muted-foreground">{t}</span>
              <span className="text-foreground">{totals[t]}</span>
              <span className="text-muted-foreground">
                ({grandTotal ? ((totals[t] / grandTotal) * 100).toFixed(0) : 0}%)
              </span>
              <button
                type="button"
                onClick={() => setEditingType(editingType === t ? null : t)}
                className="ml-2 text-xs text-muted-foreground hover:text-foreground"
              >
                edit
              </button>
              {editingType === t && (
                <div className="ml-2 flex items-center gap-2">
                  <input
                    type="color"
                    value={savedColors[t] ?? docTypeColors[t]}
                    onChange={(e) => updateSavedColor(t, e.target.value)}
                    className="h-6 w-10 rounded"
                  />
                  <button
                    type="button"
                    onClick={() => setEditingType(null)}
                    className="text-xs text-muted-foreground hover:text-foreground"
                  >
                    done
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>

        <ResponsiveContainer width="100%" height={260}>
          <BarChart
            data={normalized}
            margin={{ left: -10, right: 8, top: 4, bottom: 0 }}
            barCategoryGap="30%"
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(210,20%,91%)" vertical={false} />
            <XAxis
              dataKey="month"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "hsl(210,12%,55%)" }}
            />
            <YAxis
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: "hsl(210,12%,55%)" }}
            />
            <Tooltip content={<ChartTooltip />} />
            {docTypes.map((t) => (
              <Bar
                key={t}
                dataKey={t}
                stackId="a"
                fill={savedColors[t] ?? docTypeColors[t]}
                fillOpacity={0.88}
                radius={t === "Other" ? [4, 4, 0, 0] : [0, 0, 0, 0]}
              />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Chart 4 — Top Uploaders                                                 */
/* ─────────────────────────────────────────────────────────────────────── */

function TopUploadersChart({ data }: { data: UploaderItem[] }) {
  const max = Math.max(...data.map((d) => d.count), 1);

  const DEPT_COLORS: Record<string, string> = {
    Finance:     BRAND.primary,
    Legal:       BRAND.accent,
    Procurement: BRAND.teal,
    HR:          "hsl(38,90%,50%)",
    Operations:  "hsl(160,60%,40%)",
    IT:          "hsl(270,50%,55%)",
  };

  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-card"
      style={{ boxShadow: "var(--shadow-card)" }}
    >
      <SectionHeader
        icon={Users}
        title="Top Uploaders"
        subtitle="Staff ranked by document submissions this period"
      >
        <span className="rounded-full bg-primary/8 px-3 py-1 text-[11px] font-bold text-primary">
          {data.length} staff
        </span>
      </SectionHeader>

      <div className="divide-y divide-border">
        {data.map((person, i) => {
          const approvedPct = person.count
            ? Math.round((person.approved / person.count) * 100)
            : 0;
          const barWidth = Math.round((person.count / max) * 100);
          const deptColor = DEPT_COLORS[person.department] ?? BRAND.muted;

          return (
            <div key={person.name} className="flex items-center gap-4 px-5 py-3">
              {/* Rank */}
              <span
                className="w-6 shrink-0 text-center text-[13px] font-black tabular-nums"
                style={{
                  color: i === 0 ? "hsl(38,90%,45%)" : i < 3 ? BRAND.primary : "hsl(210,12%,60%)",
                }}
              >
                {i + 1}
              </span>

              {/* Avatar initials */}
              <div
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-black text-white"
                style={{ background: deptColor }}
              >
                {person.name
                  .split(" ")
                  .map((n) => n[0])
                  .join("")
                  .slice(0, 2)
                  .toUpperCase()}
              </div>

              {/* Name + dept + bar */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <p className="truncate text-sm font-semibold text-foreground">
                    {person.name}
                  </p>
                  <span className="shrink-0 text-sm font-black tabular-nums text-foreground">
                    {person.count}
                  </span>
                </div>
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="text-[11px] text-muted-foreground">{person.department}</span>
                  <span className="text-[10px] text-muted-foreground">·</span>
                  <span
                    className="text-[11px] font-medium"
                    style={{ color: approvedPct >= 80 ? BRAND.teal : BRAND.warning }}
                  >
                    {approvedPct}% approved
                  </span>
                </div>
                {/* Progress bar */}
                <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                  <div
                    className="h-full rounded-full transition-all duration-500"
                    style={{
                      width: `${barWidth}%`,
                      background: deptColor,
                      opacity: 0.75,
                    }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="border-t border-border bg-muted/30 px-5 py-2.5">
        <p className="text-[11px] text-muted-foreground">
          Showing top {data.length} uploaders. Approval rate reflects approved / total submissions.
        </p>
      </div>
    </div>
  );
}

/* ─────────────────────────────────────────────────────────────────────── */
/* Main export                                                              */
/* ─────────────────────────────────────────────────────────────────────── */

interface AnalyticsDashboardProps {
  /**
   * Replace these with real data from useQuery in production.
   * Signatures match the mock data structures above.
   */
  turnaroundData?: ApprovalTurnaroundItem[];
  slaData?: SlaBreachItem[];
  volumeData?: VolumeItem[];
  uploadersData?: UploaderItem[];
  isLoading?: boolean;
}

export function AnalyticsDashboard({
  turnaroundData = MOCK_TURNAROUND,
  slaData = MOCK_SLA,
  volumeData = MOCK_VOLUME,
  uploadersData = MOCK_UPLOADERS,
  isLoading = false,
}: AnalyticsDashboardProps) {
  const [slaRange, setSlaRange] = useState<AnalyticsRange>("12m");
  const [volRange, setVolRange] = useState<AnalyticsRange>("6m");
  const [collapsed, setCollapsed] = useState(false);

  if (isLoading) {
    return (
      <div className="flex h-40 items-center justify-center gap-2 rounded-xl border border-border bg-card text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading analytics…
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Section toggle header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <BarChart2 className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-bold uppercase tracking-[0.12em] text-muted-foreground">
            Analytics
          </h2>
        </div>
        <button
          type="button"
          onClick={() => setCollapsed((v) => !v)}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-muted-foreground transition hover:bg-muted hover:text-foreground"
        >
          {collapsed ? "Show" : "Hide"}
          <ChevronDown
            className={`h-3.5 w-3.5 transition-transform ${collapsed ? "-rotate-90" : ""}`}
          />
        </button>
      </div>

      {!collapsed && (
        <>
          {/* Row 1: Turnaround (wider) + SLA breach (narrower) */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
            <div className="xl:col-span-3">
              <ApprovalTurnaroundChart data={turnaroundData} />
            </div>
            <div className="xl:col-span-2">
              <SlaBreachRateChart
                data={slaData}
                range={slaRange}
                onRangeChange={setSlaRange}
              />
            </div>
          </div>

          {/* Row 2: Volume (wider) + Uploaders (narrower) */}
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-5">
            <div className="xl:col-span-3">
              <DocumentVolumeChart
                data={volumeData}
                range={volRange}
                onRangeChange={setVolRange}
              />
            </div>
            <div className="xl:col-span-2">
              <TopUploadersChart data={uploadersData} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default function AnalyticsDashboardPage() {
  const user = useAuthStore((state) => state.user);
  const enabled = Boolean(user?.has_admin_access);

  const { data: turnaroundData, isLoading: turnaroundLoading } = useQuery({
    queryKey: ["analytics", "turnaround"],
    queryFn: () => api.get("/analytics/approval-turnaround/").then((r) => r.data),
    enabled,
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: slaData, isLoading: slaLoading } = useQuery({
    queryKey: ["analytics", "sla-breach"],
    queryFn: () => api.get("/analytics/sla-breach-rate/").then((r) => r.data),
    enabled,
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: volumeData, isLoading: volumeLoading } = useQuery({
    queryKey: ["analytics", "document-volume"],
    queryFn: () => api.get("/analytics/document-volume/").then((r) => r.data),
    enabled,
    ...QUERY_FIVE_MIN_STALE,
  });

  const { data: uploadersData, isLoading: uploadersLoading } = useQuery({
    queryKey: ["analytics", "top-uploaders"],
    queryFn: () => api.get("/analytics/top-uploaders/").then((r) => r.data),
    enabled,
    ...QUERY_FIVE_MIN_STALE,
  });

  return (
    <div className="-m-6 min-h-[calc(100vh-3.5rem)] bg-[#EDEDED] text-[#1F2933]">
      <div className="flex min-h-[69px] flex-col gap-3 bg-[#287EAD] px-5 py-3 text-white lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.2em] text-white/70">Manager workspace</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">Analytics</h1>
        </div>
        <Link
          to="/"
          className="inline-flex h-9 items-center justify-center border border-white/20 bg-[#206D99] px-4 text-sm font-semibold text-white hover:bg-[#1B5F86]"
        >
          Back to dashboard
        </Link>
      </div>

      <div className="p-4 pr-8">
        {enabled ? (
          <AnalyticsDashboard
            turnaroundData={turnaroundData ?? []}
            slaData={slaData ?? []}
            volumeData={volumeData ?? []}
            uploadersData={uploadersData ?? []}
            isLoading={turnaroundLoading || slaLoading || volumeLoading || uploadersLoading}
          />
        ) : (
          <div className="border border-[#C8CDD2] bg-white p-6 text-sm text-[#5E6870]">
            Analytics is available to managers and administrators.
          </div>
        )}
      </div>
    </div>
  );
}
