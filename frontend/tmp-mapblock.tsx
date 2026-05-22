import React from "react";
const Q = (
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
);
