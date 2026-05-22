import React from "react";
const Q = (
    <div className="rounded-2xl border border-border bg-background shadow-sm">
      <div className="border-b border-border px-5 py-5">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="min-w-0">
            <p className="text-xs font-semibold uppercase tracking-[0.3em] text-muted-foreground">
              Workflow Status
            </p>
            <h3 className="mt-2 text-lg font-semibold text-foreground">
              {documentTitle ?? "Workflow Progress"}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              {submittedBy && <>Submitted by <span className="font-medium text-foreground">{submittedBy}</span></>}
              {submittedDate && <> · {formatTime(submittedDate)}</>}
            </p>
          </div>
          <div className="flex min-w-[250px] flex-col gap-2 sm:items-end">
            <div className="text-[11px] uppercase tracking-wide text-muted-foreground">
              Overall progress
            </div>
            <div className="flex w-full max-w-[220px] items-center gap-3">
              <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${progress}%` }}
                />
              </div>
              <span className="text-sm font-semibold tabular-nums text-foreground">{progress}%</span>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4 px-5 py-5">
        <div className="grid gap-3 sm:grid-cols-4">
          <SummaryCard
            label="Approved"
            value={counts.completed}
            icon={<CheckCircle2 className="h-4 w-4" />}
            tone="emerald"
          />
          <SummaryCard
            label="In Progress"
            value={counts["in-progress"]}
            icon={<Loader2 className="h-4 w-4 animate-spin" />}
            tone="blue"
          />
          <SummaryCard
            label="Pending"
            value={counts.pending}
            icon={<Clock className="h-4 w-4" />}
            tone="slate"
          />
          <SummaryCard
            label="Rejected"
            value={counts.rejected}
            icon={<XCircle className="h-4 w-4" />}
            tone="red"
          />
        </div>

        {/* Diagram toolbar */}
        <div className="flex items-center justify-between border-t border-border px-5 py-2">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          <ChevronDown
            className={clsx(
              "h-4 w-4 transition-transform",
              !expanded && "-rotate-90"
            )}
          />
          Workflow Diagram
        </button>
        <div className="flex items-center gap-1">
          <ZoomBtn onClick={() => setZoom((z) => Math.max(0.5, z - 0.1))}>
            <Minus className="h-3.5 w-3.5" />
          </ZoomBtn>
          <span className="w-10 text-center text-[11px] tabular-nums text-muted-foreground">
            {Math.round(zoom * 100)}%
          </span>
          <ZoomBtn onClick={() => setZoom((z) => Math.min(2, z + 0.1))}>
            <Plus className="h-3.5 w-3.5" />
          </ZoomBtn>
          <ZoomBtn onClick={() => setZoom(1)}>
            <RotateCcw className="h-3.5 w-3.5" />
          </ZoomBtn>
        </div>
      </div>

      {/* Diagram canvas */}
      {expanded && (
        <div className="overflow-auto border-t border-border bg-background">
          <div
            style={{
              width: width * zoom,
              height: height * zoom,
              minWidth: "100%",
            }}
          >
            <svg
              width={width * zoom}
              height={height * zoom}
              viewBox={`0 0 ${width} ${height}`}
              className="block"
            >
              <defs>
                <marker
                  id="arrow-default"
                  markerWidth="10"
                  markerHeight="10"
                  refX="9"
                  refY="3"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M0,0 L0,6 L9,3 z" fill="#cbd5e1" />
                </marker>
                <marker
                  id="arrow-active"
                  markerWidth="10"
                  markerHeight="10"
                  refX="9"
                  refY="3"
                  orient="auto"
                  markerUnits="strokeWidth"
                >
                  <path d="M0,0 L0,6 L9,3 z" fill="#10b981" />
                </marker>
              </defs>

              {/* Edges first so nodes paint on top */}
              {edges.map((e, i) => {
                const from = nodes.find((n) => n.id === e.from);
                const to = nodes.find((n) => n.id === e.to);
                if (!from || !to) return null;
                return (
                  <Edge
                    key={i}
                    from={from}
                    to={to}
                    label={e.label}
                    active={e.active}
                  />
                );
              })}

              {/* Nodes */}
              {nodes.map((n) => (
                <NodeShape key={n.id} node={n} />
              ))}
            </svg>
          </div>
        </div>
      )}

      {/* Step details list */}
      <div className="space-y-2 border-t border-border px-5 py-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
          Step Details
        </div>
        <ul className="divide-y divide-border">
          {steps
            .filter((s) => !s.kind || s.kind === "task")
            .sort((a, b) => a.order - b.order)
            .map((s) => {
              const tone = TONE[s.status];
              return (
                <li key={s.id} className="flex items-start gap-3 py-3">
                  <div
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-white"
                    style={{ background: tone.stroke }}
                  >
                    <StatusIcon status={s.status} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {s.name}
                      </span>
                      <span
                        className={clsx(
                          "inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold",
                          tone.badge
                        )}
                      >
                        {tone.label}
                      </span>
                    </div>
                    <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-muted-foreground">
                      <span className="inline-flex items-center gap-1">
                        <User className="h-3 w-3" />
                        {s.approver || "Unassigned"}
                      </span>
                      {s.completedAt && (
                        <span className="inline-flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {formatTime(s.completedAt)}
                        </span>
                      )}
                    </div>
                    {s.comment && (
                      <div
                        className={clsx(
                          "mt-1.5 rounded-md border px-2.5 py-1.5 text-xs",
                          s.status === "rejected"
                            ? "border-red-200 bg-red-50 text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-300"
                            : "border-border bg-muted/40 text-foreground"
                        )}
                      >
                        <div className="flex items-start gap-1.5">
                          <MessageSquare className="mt-0.5 h-3 w-3 shrink-0 opacity-70" />
                          <span>{s.comment}</span>
                        </div>
                      </div>
                    )}
                  </div>
                </li>
              );
            })}
        </ul>
      </div>
    </div>
  );
);
