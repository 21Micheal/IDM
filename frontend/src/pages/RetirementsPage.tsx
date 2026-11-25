import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowUpRight, CalendarClock, CheckCircle2, Clock3, Loader2, WalletCards } from "lucide-react";
import { format, parseISO } from "date-fns";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "@/store/authStore";
import { fetchMyUnreconciledTravelRequisitions, myRetirementsQueryKey } from "@/lib/retirements";
import { cn } from "@/lib/utils";

function displayDate(value?: string | null) {
  if (!value) return "Return date not set";
  try {
    return format(parseISO(value), "d MMM yyyy");
  } catch {
    return value;
  }
}

export default function RetirementsPage() {
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState<"ready" | "upcoming">("ready");
  const userId = useAuthStore((state) => state.user?.id);
  const { data: documents = [], isLoading, isError } = useQuery({
    queryKey: myRetirementsQueryKey(userId),
    queryFn: () => fetchMyUnreconciledTravelRequisitions(userId),
    enabled: Boolean(userId),
    staleTime: 5_000,
    refetchInterval: 10_000,
    refetchOnWindowFocus: true,
    refetchOnMount: "always",
  });

  const readyDocuments = documents.filter((doc: any) => doc.can_submit_retirement);
  const upcomingDocuments = documents.filter((doc: any) => !doc.can_submit_retirement);
  const visibleDocuments = activeTab === "ready" ? readyDocuments : upcomingDocuments;

  return (
    <main className="mx-auto max-w-[1200px] space-y-6 p-5 lg:p-8">
      <header className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.18em] text-[#287EAD]">My travel</p>
          <h1 className="mt-1 text-2xl font-bold tracking-tight text-[#1F2933]">Retirements</h1>
          <p className="mt-1 max-w-2xl text-sm text-[#6E767D]">
            Track your unreconciled requisitions and open a retirement when it is ready to submit.
          </p>
        </div>
        {!isLoading && documents.length > 0 && (
          <div className="flex items-center gap-2 text-sm text-[#5E6870]">
            <Clock3 className="h-4 w-4 text-[#287EAD]" />
            <span>{readyDocuments.length} ready to submit</span>
          </div>
        )}
      </header>

      <section className="overflow-hidden rounded-xl border border-[#E1E7EB] bg-white shadow-sm">
        {isLoading ? (
          <div className="flex items-center justify-center gap-2 px-6 py-16 text-sm text-[#6E767D]">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading your retirements…
          </div>
        ) : isError ? (
          <div className="px-6 py-12 text-center text-sm text-red-700">
            Retirements could not be loaded. Refresh the page to try again.
          </div>
        ) : documents.length === 0 ? (
          <div className="flex flex-col items-center px-6 py-16 text-center">
            <span className="flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-700">
              <CheckCircle2 className="h-6 w-6" />
            </span>
            <h2 className="mt-4 text-base font-semibold text-[#1F2933]">You’re all reconciled</h2>
            <p className="mt-1 max-w-md text-sm text-[#6E767D]">
              Requisitions needing retirement will appear here. Reconciled requisitions are removed automatically.
            </p>
          </div>
        ) : (
          <>
            <div className="flex gap-1 border-b border-[#E1E7EB] bg-[#F8FAFB] px-4 pt-3" role="tablist" aria-label="Retirement status">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "ready"}
                onClick={() => setActiveTab("ready")}
                className={cn(
                  "rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors",
                  activeTab === "ready"
                    ? "border-[#287EAD] bg-white text-[#206D99]"
                    : "border-transparent text-[#6E767D] hover:text-[#1F2933]",
                )}
              >
                Ready to retire <span className="ml-1.5 rounded-full bg-[#EAF3F8] px-2 py-0.5 text-xs">{readyDocuments.length}</span>
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === "upcoming"}
                onClick={() => setActiveTab("upcoming")}
                className={cn(
                  "rounded-t-lg border-b-2 px-4 py-2.5 text-sm font-semibold transition-colors",
                  activeTab === "upcoming"
                    ? "border-[#287EAD] bg-white text-[#206D99]"
                    : "border-transparent text-[#6E767D] hover:text-[#1F2933]",
                )}
              >
                Not ready yet <span className="ml-1.5 rounded-full bg-[#EEF1F3] px-2 py-0.5 text-xs">{upcomingDocuments.length}</span>
              </button>
            </div>
            {visibleDocuments.length === 0 ? (
              <div className="px-6 py-14 text-center">
                <h2 className="text-sm font-semibold text-[#1F2933]">
                  {activeTab === "ready" ? "No requisitions are ready to retire yet" : "No other outstanding retirements"}
                </h2>
                <p className="mt-1 text-sm text-[#6E767D]">
                  {activeTab === "ready"
                    ? "Requisitions will appear here when their workflow reaches the retirement stage."
                    : "All your outstanding retirements are ready to submit."}
                </p>
              </div>
            ) : (
              <div className="divide-y divide-[#EDF0F2]" role="tabpanel">
                {visibleDocuments.map((doc: any) => {
                  const retirement = doc.form_summary?.retirement ?? {};
                  const ready = Boolean(doc.can_submit_retirement);
                  const label = retirement.label || "Retirement pending";
                  return (
                    <article key={doc.id} className="flex flex-col gap-4 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
                      <div className="flex min-w-0 items-start gap-3">
                        <span className={cn(
                          "mt-0.5 flex h-10 w-10 shrink-0 items-center justify-center rounded-lg",
                          ready ? "bg-[#EAF3F8] text-[#287EAD]" : "bg-[#F3F5F6] text-[#6E767D]",
                        )}>
                          <WalletCards className="h-5 w-5" />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate text-sm font-semibold text-[#1F2933]">
                            {doc.reference_number || doc.title || "Travel requisition"}
                          </p>
                          <p className="mt-0.5 truncate text-xs text-[#6E767D]">{doc.title || "Travel requisition"}</p>
                          <p className="mt-2 inline-flex items-center gap-1.5 text-xs text-[#6E767D]">
                            <CalendarClock className="h-3.5 w-3.5" />
                            {retirement.due_date ? `Due ${displayDate(retirement.due_date)}` : label}
                          </p>
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
                        <span className={cn(
                          "rounded-full px-2.5 py-1 text-xs font-semibold",
                          ready ? "bg-[#EAF3F8] text-[#206D99]" : "bg-amber-50 text-amber-800",
                        )}>
                          {ready ? "Ready to submit" : label}
                        </span>
                        <button
                          type="button"
                          onClick={() => navigate(`/${doc.id}`)}
                          className={cn(
                            "inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors",
                            ready
                              ? "bg-[#287EAD] text-white hover:bg-[#1E6F99]"
                              : "border border-[#D9E0E5] bg-white text-[#42515C] hover:bg-[#F5F7F8]",
                          )}
                        >
                          {ready ? "Submit retirement" : "Open requisition"}
                          <ArrowUpRight className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            )}
          </>
        )}
      </section>
    </main>
  );
}
