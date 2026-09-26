/**
 * SuppliersPage
 *
 * Dedicated SunSystems suppliers & vendors directory under the Requisition
 * system. Suppliers are fetched LIVE from SunSystems via sunsystemsAPI.getAccounts
 * (filtered by account_type: "supplier" / "creditor") with live search, account
 * code display, and a quick-action button to raise a requisition for that supplier.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  Building2, Search as SearchIcon, Plus, Loader2,
  RefreshCw, CheckCircle2, AlertTriangle, ExternalLink
} from "lucide-react";
import { sunsystemsAPI, SunSystemsAccount } from "@/services/api";
import { cn } from "@/lib/utils";

export default function SuppliersPage() {
  const navigate = useNavigate();
  const [search, setSearch] = useState("");
  const [businessUnit, setBusinessUnit] = useState("");

  // Live SunSystems accounts query (account_type: "supplier")
  const {
    data: accountsData,
    isLoading,
    isRefetching,
    refetch,
    error,
  } = useQuery({
    queryKey: ["sunsystems", "suppliers", businessUnit],
    queryFn: () =>
      sunsystemsAPI
        .getAccounts({
          account_type: "supplier",
          business_unit: businessUnit || undefined,
        })
        .then((res) => res.data),
    staleTime: 5 * 60_000,
  });

  const suppliers: SunSystemsAccount[] = accountsData?.accounts ?? [];
  const isConnected = accountsData?.ok !== false && !error;

  const filteredSuppliers = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return suppliers;
    return suppliers.filter(
      (s) =>
        s.account_code?.toLowerCase().includes(q) ||
        s.description?.toLowerCase().includes(q) ||
        s.account_type?.toLowerCase().includes(q)
    );
  }, [suppliers, search]);

  return (
    <div className="mx-auto max-w-[1400px] space-y-6 p-6">
      {/* Header */}
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight text-[#1F2933]">
              SunSystems Suppliers
            </h1>
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium",
                isConnected
                  ? "bg-emerald-50 text-emerald-700 border border-emerald-200"
                  : "bg-amber-50 text-amber-700 border border-amber-200"
              )}
            >
              <span
                className={cn(
                  "h-1.5 w-1.5 rounded-full",
                  isConnected ? "bg-emerald-500 animate-pulse" : "bg-amber-500"
                )}
              />
              {isConnected ? "Live SunSystems Sync" : "Sync Attention"}
            </span>
          </div>
          <p className="mt-1 text-sm text-[#5E6870]">
            Live vendor directory pulled directly from Infor SunSystems ERP.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => refetch()}
            disabled={isRefetching}
            className="inline-flex items-center gap-2 rounded-lg border border-[#E4E7EB] bg-white px-3.5 py-2 text-sm font-semibold text-[#1F2933] hover:bg-slate-50 disabled:opacity-50"
          >
            <RefreshCw className={cn("h-4 w-4", isRefetching && "animate-spin")} />
            Refresh
          </button>
          <button
            type="button"
            onClick={() => navigate("/new")}
            className="inline-flex items-center gap-2 bg-[#287EAD] px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-[#1E6F99] rounded-lg"
          >
            <Plus className="h-4 w-4" /> Raise Requisition
          </button>
        </div>
      </div>

      {/* Filter and search bar */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-[#E4E7EB] bg-white p-4 shadow-sm">
        <div className="relative min-w-[260px] flex-1">
          <SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#9AA5B1]" />
          <input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search by supplier name or account code (e.g. SUP-001)..."
            className="w-full rounded-lg border border-[#E4E7EB] py-2 pl-9 pr-3 text-sm focus:border-[#287EAD] focus:outline-none"
          />
        </div>
        <input
          value={businessUnit}
          onChange={(e) => setBusinessUnit(e.target.value)}
          placeholder="Filter Business Unit (e.g. PKL)"
          className="w-48 rounded-lg border border-[#E4E7EB] px-3 py-2 text-sm focus:border-[#287EAD] focus:outline-none"
        />
      </div>

      {/* Suppliers Table */}
      <div className="overflow-hidden rounded-xl border border-[#E4E7EB] bg-white shadow-sm">
        {isLoading ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3">
            <Loader2 className="h-7 w-7 animate-spin text-[#287EAD]" />
            <p className="text-sm text-[#5E6870]">Fetching live vendors from SunSystems...</p>
          </div>
        ) : filteredSuppliers.length === 0 ? (
          <div className="flex h-64 flex-col items-center justify-center gap-3 p-6 text-center">
            <Building2 className="h-10 w-10 text-[#C1C7CD]" />
            <h3 className="text-base font-semibold text-[#1F2933]">No suppliers found</h3>
            <p className="max-w-md text-sm text-[#5E6870]">
              {search
                ? `No SunSystems suppliers matched "${search}".`
                : "No supplier accounts returned from SunSystems for this business unit."}
            </p>
          </div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-[#E4E7EB] bg-slate-50/50 text-xs uppercase tracking-wide text-[#5E6870]">
                <th className="px-6 py-3 font-medium">Account Code</th>
                <th className="px-6 py-3 font-medium">Supplier / Vendor Name</th>
                <th className="px-6 py-3 font-medium">Account Type</th>
                <th className="px-6 py-3 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#F0F2F4]">
              {filteredSuppliers.map((supplier) => (
                <tr key={supplier.account_code} className="hover:bg-[#F8FAFB] transition-colors">
                  <td className="px-6 py-4 font-mono font-semibold text-[#287EAD]">
                    {supplier.account_code}
                  </td>
                  <td className="px-6 py-4 font-medium text-[#1F2933]">
                    {supplier.description || "—"}
                  </td>
                  <td className="px-6 py-4 text-[#5E6870]">
                    <span className="inline-flex items-center rounded bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 uppercase">
                      {supplier.account_type || "Creditor"}
                    </span>
                  </td>
                  <td className="px-6 py-4 text-right">
                    <button
                      type="button"
                      onClick={() =>
                        navigate(`/new?supplier_code=${encodeURIComponent(supplier.account_code)}&supplier_name=${encodeURIComponent(supplier.description)}`)
                      }
                      className="inline-flex items-center gap-1.5 rounded-md bg-[#287EAD]/10 px-3 py-1.5 text-xs font-semibold text-[#287EAD] hover:bg-[#287EAD] hover:text-white transition-colors"
                    >
                      <Plus className="h-3.5 w-3.5" />
                      Raise Requisition
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
