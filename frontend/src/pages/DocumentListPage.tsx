// /**
//  * pages/DocumentListPage.tsx
//  *
//  * Changes from previous version
//  * ──────────────────────────────
//  * 1. Three-tab layout: "All Documents" | "Workflow" | "My Documents"
//  *    - All:       no is_self_upload filter (admin/auditor view of everything)
//  *    - Workflow:  is_self_upload=false  (approval queue; hides personal docs)
//  *    - Personal:  is_self_upload=true   (uploader's own private documents)
//  *
//  * 2. Self-upload rows in the "All" tab get a subtle Lock pill so admins can
//  *    tell at a glance which documents are personal vs. workflow.
//  *
//  * 3. "My Documents" tab replaces the Status column with an "Actions" column
//  *    showing Archive and Delete quick-actions (no Submit button — personal
//  *    docs cannot enter a workflow).
//  *
//  * 4. Filters and pagination reset when switching tabs.
//  *
//  * 5. Empty states are tab-aware.
//  */
// import { useState } from "react";
// import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
// import { Link } from "react-router-dom";
// import {
//   FileText, UploadCloud, SortAsc, SortDesc, Lock, Users, LayoutList,
//   Archive, Trash2,
// } from "lucide-react";
// import { documentsAPI, documentTypesAPI } from "../services/api";
// import { format } from "date-fns";
// import { cn } from "../lib/utils";
// import { useDebounce } from "../hooks/useDebounce";
// import { toast } from "@/components/ui/vault-toast";

// // ── Status badge styles ────────────────────────────────────────────────────────

// const STATUS_STYLES: Record<string, string> = {
//   draft:            "bg-muted text-muted-foreground",
//   pending_review:   "bg-accent/15 text-accent-foreground border border-accent/30",
//   pending_approval: "bg-accent/15 text-accent-foreground border border-accent/30",
//   approved:         "bg-teal/15 text-teal border border-teal/30",
//   rejected:         "bg-destructive/10 text-destructive border border-destructive/30",
//   archived:         "bg-secondary text-secondary-foreground",
//   void:             "bg-muted text-muted-foreground/60",
// };

// // ── Types ──────────────────────────────────────────────────────────────────────

// type SortField =
//   | "created_at"
//   | "document_date"
//   | "amount"
//   | "title"
//   | "reference_number";

// type Tab = "all" | "workflow" | "personal";

// const TABS: { id: Tab; label: string; icon: React.ReactNode; tip: string }[] = [
//   {
//     id: "all",
//     label: "All Documents",
//     icon: <LayoutList className="w-4 h-4" />,
//     tip: "Every document you have access to",
//   },
//   {
//     id: "workflow",
//     label: "Workflow",
//     icon: <Users className="w-4 h-4" />,
//     tip: "Documents going through an approval process",
//   },
//   {
//     id: "personal",
//     label: "My Documents",
//     icon: <Lock className="w-4 h-4" />,
//     tip: "Your personal uploads — visible only to you and admins",
//   },
// ];

// // ── SortIcon helper ────────────────────────────────────────────────────────────

// function SortIcon({
//   field,
//   sort,
//   sortDir,
// }: {
//   field: SortField;
//   sort: SortField;
//   sortDir: "asc" | "desc";
// }) {
//   if (sort !== field) return null;
//   return sortDir === "desc" ? (
//     <SortDesc className="w-3.5 h-3.5 inline ml-1" />
//   ) : (
//     <SortAsc className="w-3.5 h-3.5 inline ml-1" />
//   );
// }

// // ── DocumentListPage ───────────────────────────────────────────────────────────

// export default function DocumentListPage() {
//   const queryClient = useQueryClient();

//   const [activeTab, setActiveTab] = useState<Tab>("workflow");
//   const [search, setSearch]       = useState("");
//   const [statusFilter, setStatusFilter] = useState("");
//   const [typeFilter, setTypeFilter]     = useState("");
//   const [sort, setSort]           = useState<SortField>("created_at");
//   const [sortDir, setSortDir]     = useState<"asc" | "desc">("desc");
//   const [page, setPage]           = useState(1);

//   const debouncedSearch = useDebounce(search, 300);

//   // ── Document types for the filter dropdown ─────────────────────────────────
//   const { data: typesData } = useQuery({
//     queryKey: ["document-types"],
//     queryFn: () => documentTypesAPI.list(),
//     select: (r) => (r.data.results ?? r.data) as any[],
//   });

//   // ── Build query params driven by active tab ────────────────────────────────
//   const params: Record<string, unknown> = {
//     search:        debouncedSearch || undefined,
//     status:        statusFilter || undefined,
//     document_type: typeFilter || undefined,
//     ordering:      `${sortDir === "desc" ? "-" : ""}${sort}`,
//     page,
//     page_size:     25,
//   };

//   if (activeTab === "workflow") params.is_self_upload = false;
//   if (activeTab === "personal") params.is_self_upload = true;

//   const { data, isLoading } = useQuery({
//     queryKey: ["documents", params],
//     queryFn: () => documentsAPI.list(params),
//     select: (r) => r.data,
//     placeholderData: (prev) => prev,
//   });

//   const docs = data?.results ?? [];

//   // ── Quick-action mutations (My Documents tab) ──────────────────────────────
//   const archiveMutation = useMutation({
//     mutationFn: (id: string) => documentsAPI.archive(id),
//     onSuccess: () => {
//       toast.success("Document archived.");
//       queryClient.invalidateQueries({ queryKey: ["documents"] });
//     },
//     onError: () => toast.error("Could not archive document."),
//   });

//   const deleteMutation = useMutation({
//     mutationFn: (id: string) => documentsAPI.delete(id),
//     onSuccess: () => {
//       toast.success("Document deleted.");
//       queryClient.invalidateQueries({ queryKey: ["documents"] });
//     },
//     onError: () => toast.error("Could not delete document."),
//   });

//   // ── Tab switch — reset filters & pagination ────────────────────────────────
//   const switchTab = (tab: Tab) => {
//     setActiveTab(tab);
//     setSearch("");
//     setStatusFilter("");
//     setTypeFilter("");
//     setPage(1);
//   };

//   // ── Sort handler ───────────────────────────────────────────────────────────
//   const handleSort = (field: SortField) => {
//     if (sort === field) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
//     else { setSort(field); setSortDir("desc"); }
//     setPage(1);
//   };

//   // ── Column definitions (vary by tab) ──────────────────────────────────────
//   type ColDef = { label: string; field: SortField | null };
//   const workflowColumns: ColDef[] = [
//     { label: "Reference",  field: "reference_number" },
//     { label: "Title",      field: "title"            },
//     { label: "Type",       field: null               },
//     { label: "Supplier",   field: null               },
//     { label: "Amount",     field: "amount"           },
//     { label: "Date",       field: "document_date"    },
//     { label: "Status",     field: null               },
//     { label: "Uploaded",   field: "created_at"       },
//   ];
//   const personalColumns: ColDef[] = [
//     { label: "Reference",  field: "reference_number" },
//     { label: "Title",      field: "title"            },
//     { label: "Type",       field: null               },
//     { label: "Supplier",   field: null               },
//     { label: "Amount",     field: "amount"           },
//     { label: "Date",       field: "document_date"    },
//     { label: "Uploaded",   field: "created_at"       },
//     { label: "Actions",    field: null               },
//   ];
//   const allColumns: ColDef[] = [
//     { label: "Reference",  field: "reference_number" },
//     { label: "Title",      field: "title"            },
//     { label: "Type",       field: null               },
//     { label: "Supplier",   field: null               },
//     { label: "Amount",     field: "amount"           },
//     { label: "Date",       field: "document_date"    },
//     { label: "Status",     field: null               },
//     { label: "Uploaded",   field: "created_at"       },
//   ];

//   const columns =
//     activeTab === "personal"
//       ? personalColumns
//       : activeTab === "all"
//       ? allColumns
//       : workflowColumns;

//   const colSpan = columns.length;

//   // ── Empty state copy ───────────────────────────────────────────────────────
//   const emptyMessages: Record<Tab, { heading: string; sub: string }> = {
//     all: {
//       heading: "No documents found",
//       sub: "Try adjusting your search or filters.",
//     },
//     workflow: {
//       heading: "No workflow documents found",
//       sub: "Upload a document to start the approval process.",
//     },
//     personal: {
//       heading: "No personal documents yet",
//       sub: "Upload a document and toggle \"Personal document\" to save it here.",
//     },
//   };

//   return (
//     <div className="max-w-7xl mx-auto py-10 px-6 space-y-8">

//       {/* ── Header ──────────────────────────────────────────────────────────── */}
//       <div className="flex items-end justify-between">
//         <div>
//           <div className="flex items-center gap-3 mb-2">
//             <div className="w-10 h-10 rounded-xl bg-primary/10 flex items-center justify-center">
//               <FileText className="w-5 h-5 text-primary" />
//             </div>
//             <h1 className="text-3xl font-bold tracking-tight text-foreground">Documents</h1>
//           </div>
//           <p className="text-sm text-muted-foreground">Manage and track your document workflow and repositories.</p>
//         </div>
//         <Link
//           to="/documents/upload"
//           className="btn-primary"
//         >
//           <UploadCloud className="w-4 h-4" /> Upload
//         </Link>
//       </div>

//       {/* ── Tabs ────────────────────────────────────────────────────────────── */}
//       <div className="flex items-end gap-1 border-b border-border">
//         {TABS.map((tab) => (
//           <button
//             key={tab.id}
//             title={tab.tip}
//             onClick={() => switchTab(tab.id)}
//             className={cn(
//               "inline-flex items-center gap-2 px-6 py-3 text-sm font-medium rounded-t-lg border border-transparent transition-colors -mb-px",
//               activeTab === tab.id
//                 ? "border-border border-b-background bg-background text-accent shadow-sm"
//                 : "text-muted-foreground hover:text-foreground hover:bg-muted"
//             )}
//           >
//             {tab.icon}
//             {tab.label}
//             {/* Live count badge */}
//             {activeTab === tab.id && data && (
//               <span className="ml-1 inline-flex items-center justify-center px-2 py-0.5 text-[10px] font-bold rounded-full bg-accent/10 text-accent">
//                 {data.count.toLocaleString()}
//               </span>
//             )}
//           </button>
//         ))}
//       </div>

//       {/* ── Filters ─────────────────────────────────────────────────────────── */}
//       <div className="flex flex-wrap gap-3 items-center">
//         <input
//           value={search}
//           onChange={(e) => { setSearch(e.target.value); setPage(1); }}
//           placeholder="Search…"
//           className="w-60 input"
//         />

//         {/* Status filter — hidden in personal tab (all personal docs use draft by default) */}
//         {activeTab !== "personal" && (
//           <select
//             value={statusFilter}
//             onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }}
//             className="w-48 input"
//           >
//             <option value="">All statuses</option>
//             {Object.keys(STATUS_STYLES).map((s) => (
//               <option key={s} value={s}>
//                 {s.replace(/_/g, " ")}
//               </option>
//             ))}
//           </select>
//         )}

//         <select
//           value={typeFilter}
//           onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }}
//           className="w-48 input"
//         >
//           <option value="">All types</option>
//           {(typesData ?? []).map((t: any) => (
//             <option key={t.id} value={t.id}>{t.name}</option>
//           ))}
//         </select>

//         {data && (
//           <span className="ml-auto text-sm text-slate-500 self-center">
//             {data.count.toLocaleString()} document
//             {data.count !== 1 ? "s" : ""}
//           </span>
//         )}
//       </div>

//       {/* ── Personal tab explainer banner ───────────────────────────────────── */}
//       {activeTab === "personal" && (
//         <div className="flex items-start gap-3 rounded-xl border border-accent/30 bg-accent/10 px-4 py-3 text-sm text-accent-foreground">
//           <Lock className="w-4 h-4 mt-0.5 flex-shrink-0 text-accent" />
//           <span>
//             These documents are private to you. They are not part of any
//             approval workflow and are visible only to you and administrators.
//           </span>
//         </div>
//       )}

//       {/* ── Table ───────────────────────────────────────────────────────────── */}
//       <div className="card overflow-hidden">
//         <div className="overflow-x-auto">
//           <table className="w-full text-sm">
//             <thead>
//               <tr className="border-b border-border bg-muted/50">
//                 {columns.map(({ label, field }) => (
//                   <th
//                     key={label}
//                     onClick={field ? () => handleSort(field) : undefined}
//                     className="px-6 py-4 text-left text-xs font-bold text-muted-foreground uppercase tracking-wider whitespace-nowrap"
//                   >
//                     {label}
//                     {field && (
//                       <SortIcon field={field} sort={sort} sortDir={sortDir} />
//                     )}
//                   </th>
//                 ))}
//               </tr>
//             </thead>

//             <tbody className="divide-y divide-border">
//               {isLoading ? (
//                 // Skeleton rows
//                 [...Array(8)].map((_, i) => (
//                   <tr key={i}>
//                     {[...Array(colSpan)].map((_, j) => (
//                       <td key={j} className="px-6 py-4">
//                         <div className="h-4 bg-muted rounded animate-pulse" />
//                       </td>
//                     ))}
//                   </tr>
//                 ))
//               ) : docs.length === 0 ? (
//                 <tr>
//                   <td colSpan={colSpan} className="text-center py-20 text-muted-foreground">
//                     <FileText className="w-12 h-12 mx-auto mb-4 text-muted/40" />
//                     <p className="font-semibold text-foreground">
//                       {emptyMessages[activeTab].heading}
//                     </p>
//                     <p className="text-sm mt-1">
//                       {emptyMessages[activeTab].sub}
//                     </p>
//                   </td>
//                 </tr>
//               ) : (
//                 docs.map((doc: any) => (
//                   <tr
//                     key={doc.id}
//                     className={cn(
//                       "hover:bg-muted/40 transition-colors group",
//                       // Subtle tint on personal rows in the "All" tab
//                       activeTab === "all" && doc.is_self_upload && "bg-primary/5"
//                     )}
//                   >
//                     {/* Reference */}
//                     <td className="px-6 py-4">
//                       <div className="flex items-center gap-1.5">
//                         <Link
//                           to={`/documents/${doc.id}`}
//                           className="font-mono text-xs bg-muted text-muted-foreground px-2 py-0.5 rounded hover:bg-primary/10 hover:text-primary transition-colors"
//                         >
//                           {doc.reference_number}
//                         </Link>
//                         {/* Personal badge — visible in "all" tab only */}
//                         {activeTab === "all" && doc.is_self_upload && (
//                           <span
//                             title="Personal document"
//                             className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded-full text-[10px] font-bold bg-primary/10 text-primary uppercase tracking-wider"
//                           >
//                             <Lock className="w-2.5 h-2.5" />
//                             Personal
//                           </span>
//                         )}
//                       </div>
//                     </td>

//                     {/* Title */}
//                     <td className="px-6 py-4 max-w-xs">
//                       <Link
//                         to={`/documents/${doc.id}`}
//                         className="text-foreground group-hover:text-primary font-semibold truncate block transition-colors"
//                       >
//                         {doc.title}
//                       </Link>
//                     </td>

//                     {/* Type */}
//                     <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
//                       {doc.document_type_name}
//                     </td>

//                     {/* Supplier */}
//                     <td className="px-6 py-4 text-muted-foreground max-w-[8rem] truncate">
//                       {doc.supplier || "—"}
//                     </td>

//                     {/* Amount */}
//                     <td className="px-6 py-4 text-foreground whitespace-nowrap font-bold">
//                       {doc.amount
//                         ? `${Number(doc.amount).toLocaleString(undefined, {
//                             minimumFractionDigits: 2,
//                           })} ${doc.currency}`
//                         : "—"}
//                     </td>

//                     {/* Date */}
//                     <td className="px-6 py-4 text-muted-foreground whitespace-nowrap">
//                       {doc.document_date
//                         ? format(new Date(doc.document_date), "dd MMM yyyy")
//                         : "—"}
//                     </td>

//                     {/* Status (workflow + all tabs) OR Uploaded (personal tab) */}
//                     {activeTab !== "personal" ? (
//                       <td className="px-6 py-4">
//                         <span
//                           className={cn(
//                             "badge text-xs",
//                             STATUS_STYLES[doc.status] ?? "bg-slate-100 text-slate-500"
//                           )}
//                         >
//                           {doc.status.replace(/_/g, " ")}
//                         </span>
//                       </td>
//                     ) : null}

//                     {/* Uploaded */}
//                     <td className="px-6 py-4 text-muted-foreground whitespace-nowrap text-xs">
//                       {format(new Date(doc.created_at), "dd MMM yyyy")}
//                     </td>

//                     {/* Quick actions — personal tab only */}
//                     {activeTab === "personal" && (
//                       <td className="px-6 py-4">
//                         <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
//                           {/* Archive — only if not already archived/void */}
//                           {!["archived", "void"].includes(doc.status) && (
//                             <button
//                               title="Archive"
//                               onClick={() => {
//                                 if (
//                                   window.confirm(
//                                     "Archive this personal document?"
//                                   )
//                                 )
//                                   archiveMutation.mutate(doc.id);
//                               }}
//                             className="p-2 rounded-lg hover:bg-accent/15 text-muted-foreground hover:text-accent transition-all"
//                             >
//                               <Archive className="w-4 h-4" />
//                             </button>
//                           )}
//                           {/* Delete (soft — marks void) */}
//                           <button
//                             title="Delete"
//                             onClick={() => {
//                               if (
//                                 window.confirm(
//                                   "Delete this personal document? This cannot be undone."
//                                 )
//                               )
//                                 deleteMutation.mutate(doc.id);
//                             }}
//                             className="p-2 rounded-lg hover:bg-destructive/10 text-muted-foreground hover:text-destructive transition-all"
//                           >
//                             <Trash2 className="w-4 h-4" />
//                           </button>
//                         </div>
//                       </td>
//                     )}
//                   </tr>
//                 ))
//               )}
//             </tbody>
//           </table>
//         </div>

//         {/* ── Pagination ───────────────────────────────────────────────────── */}
//         {data && data.count > 25 && (
//           <div className="flex items-center justify-between px-6 py-4 border-t border-border bg-muted/40">
//             <span className="text-xs text-muted-foreground font-medium">
//               Showing{" "}
//               {Math.min((page - 1) * 25 + 1, data.count)}–
//               {Math.min(page * 25, data.count)} of{" "}
//               {data.count.toLocaleString()}
//             </span>
//             <div className="flex gap-3">
//               <button
//                 onClick={() => setPage((p) => Math.max(1, p - 1))}
//                 disabled={page === 1}
//                 className="btn-secondary text-xs px-4"
//               >
//                 Previous
//               </button>
//               <button
//                 onClick={() => setPage((p) => p + 1)}
//                 disabled={page * 25 >= data.count}
//                 className="btn-secondary text-xs px-4"
//               >
//                 Next
//               </button>
//             </div>
//           </div>
//         )}
//       </div>
//     </div>
//   );
// }