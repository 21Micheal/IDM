/**
 * JournalPayloadModal — preview the exact SunSystems journal payload.
 *
 * Shows the `<SSC>` XML (and the full SOAP request) that *would* be posted to
 * SunSystems for this form, compiled from the live values + field mappings — so
 * the payload can be reviewed and exported without tracing every field by hand.
 * Read-only; nothing is posted.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, CheckCircle2, Copy, Download, Loader2, Scale, X,
} from "lucide-react";
import { sunsystemsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";

type Props = {
  documentId?: string;
  templateId?: string;
  values?: Record<string, unknown>;
  /** Inline journal mapping (builder preview, before the template is saved). */
  mapping?: Record<string, unknown> | null;
  /** Mark the payload as built from placeholder/sample values (builder preview). */
  sample?: boolean;
  /** Used for the downloaded file name. */
  title?: string;
  onClose: () => void;
  /** Available stages for multi-stage journal posting (e.g., [1, 2] for request/retirement). */
  availableStages?: number[];
};

type View = "ssc" | "soap";

function slugify(s: string) {
  return (s || "journal").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);
}

function decodeHtmlEntities(text: string): string {
  const textArea = document.createElement("textarea");
  textArea.innerHTML = text;
  return textArea.value;
}

export default function JournalPayloadModal({ documentId, templateId, values, mapping, sample, title, onClose, availableStages }: Props) {
  const [view, setView] = useState<View>("ssc");
  const [stage, setStage] = useState<number>(1);

  const { data, isLoading, isError } = useQuery({
    queryKey: ["sunsystems-journal-preview", documentId, templateId, JSON.stringify(values ?? {}), JSON.stringify(mapping ?? null), stage],
    queryFn: () =>
      sunsystemsAPI
        .journalPreview({ document_id: documentId, template_id: templateId, values, mapping: mapping ?? undefined, stage })
        .then((r) => r.data),
  });

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const xml = useMemo(() => {
    if (!data?.ok) return "";
    const rawXml = view === "ssc" ? (data.ssc_xml ?? "") : (data.soap_xml ?? "");
    return decodeHtmlEntities(rawXml);
  }, [data, view]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(xml);
      toast.success("XML copied to clipboard.");
    } catch {
      toast.error("Could not copy — select and copy manually.");
    }
  };

  const download = () => {
    const blob = new Blob([xml], { type: "application/xml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${slugify(title ?? "")}-${view === "ssc" ? "journal" : "soap"}.xml`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const balanced = data?.balanced;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-black/40" onClick={onClose}>
      <div
        className="m-auto flex h-[88vh] w-[min(960px,94vw)] flex-col border border-[#C8CDD2] bg-white shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[#C8CDD2] bg-[#287EAD] px-5 py-3 text-white">
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-white/60">SunSystems</p>
            <h2 className="text-sm font-bold">Journal payload preview</h2>
          </div>
          <button onClick={onClose} className="rounded p-1.5 text-white/70 hover:bg-white/15 hover:text-white">
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="flex min-h-0 flex-1 flex-col">
          {isLoading && (
            <div className="flex flex-1 items-center justify-center text-[#5E6870]">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" /> Compiling payload…
            </div>
          )}

          {!isLoading && (isError || !data?.ok) && (
            <div className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
              <AlertTriangle className="h-8 w-8 text-amber-500" />
              <p className="text-sm font-semibold text-[#1F2933]">
                {data?.enabled === false ? "Journal posting isn't configured" : "Couldn't build the payload"}
              </p>
              <p className="max-w-md text-xs text-[#5E6870]">
                {data?.error ||
                  (data?.enabled === false
                    ? "Enable journal posting and bind at least one amount field in the template, then try again."
                    : "Check the journal mapping in the template builder.")}
              </p>
            </div>
          )}

          {!isLoading && data?.ok && (
            <>
              {/* Summary bar */}
              <div className="flex flex-shrink-0 flex-wrap items-center gap-x-5 gap-y-2 border-b border-[#EEF0F2] bg-[#F8FAFB] px-5 py-3 text-xs">
                <span className="text-[#1F2933]">
                  <b>{data.component}</b> · {data.method}
                </span>
                {data.business_unit && <span className="text-[#5E6870]">BU <b className="text-[#1F2933]">{data.business_unit}</b></span>}
                <span className="text-[#5E6870]">{data.line_count} line{data.line_count !== 1 ? "s" : ""}</span>
                <span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 font-semibold ${balanced ? "bg-emerald-50 text-emerald-700" : "bg-red-50 text-red-700"}`}>
                  {balanced ? <CheckCircle2 className="h-3.5 w-3.5" /> : <Scale className="h-3.5 w-3.5" />}
                  Dr {data.debit_total} / Cr {data.credit_total}{balanced ? " · balanced" : " · unbalanced"}
                </span>
              </div>

              {sample && (
                <div className="flex-shrink-0 border-b border-sky-200 bg-sky-50 px-5 py-2 text-xs text-sky-800">
                  Built from <b>sample values</b> — real account codes/structure are exact; amounts and
                  text come from the filled form, so totals here won't necessarily balance.
                </div>
              )}
              {(data.warnings?.length ?? 0) > 0 && (
                <div className="flex-shrink-0 border-b border-amber-200 bg-amber-50 px-5 py-2 text-xs text-amber-800">
                  {data.warnings!.map((w, i) => <div key={i}>⚠ {w}</div>)}
                </div>
              )}

              {/* Toolbar */}
              <div className="flex flex-shrink-0 items-center justify-between border-b border-[#EEF0F2] px-5 py-2">
                <div className="flex items-center gap-3">
                  {/* Stage toggle for multi-stage workflows */}
                  {(availableStages ?? []).length > 1 && (
                    <div className="inline-flex overflow-hidden rounded border border-[#C8CDD2]">
                      {availableStages!.map((s) => (
                        <button
                          key={s}
                          onClick={() => setStage(s)}
                          className={`px-3 py-1.5 text-xs font-semibold ${stage === s ? "bg-[#287EAD] text-white" : "bg-white text-[#5E6870] hover:bg-[#F3F5F6]"}`}
                        >
                          Stage {s}
                        </button>
                      ))}
                    </div>
                  )}
                  {/* XML view toggle */}
                  <div className="inline-flex overflow-hidden rounded border border-[#C8CDD2]">
                    {(["ssc", "soap"] as View[]).map((v) => (
                      <button
                        key={v}
                        onClick={() => setView(v)}
                        className={`px-3 py-1.5 text-xs font-semibold ${view === v ? "bg-[#287EAD] text-white" : "bg-white text-[#5E6870] hover:bg-[#F3F5F6]"}`}
                      >
                        {v === "ssc" ? "Journal (SSC)" : "Full SOAP request"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={copy} className="inline-flex items-center gap-1.5 border border-[#AEB5BB] bg-white px-2.5 py-1.5 text-xs font-semibold text-[#1F2933] hover:bg-[#F3F5F6]">
                    <Copy className="h-3.5 w-3.5" /> Copy
                  </button>
                  <button onClick={download} className="inline-flex items-center gap-1.5 bg-[#287EAD] px-3 py-1.5 text-xs font-semibold text-white hover:bg-[#1E6F99]">
                    <Download className="h-3.5 w-3.5" /> Export .xml
                  </button>
                </div>
              </div>

              {/* XML */}
              <pre className="min-h-0 flex-1 overflow-auto bg-[#1E2530] px-5 py-4 font-mono text-[12px] leading-relaxed text-[#D6E2EC]">
                {view === "soap" && (
                  <div className="mb-2 text-[11px] italic text-[#8CA0B3]">
                    {"// the {{SECURITY_TOKEN}} placeholder is replaced with a live token at post time"}
                  </div>
                )}
                {xml}
              </pre>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
