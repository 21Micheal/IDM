/**
 * TemplateForm — Finansys Unifi-style interactive renderer for a BUILT template.
 *
 * v2.0 — Full rewrite:
 *  - 12-column CSS grid with per-field colSpan (1–12) from builder
 *  - react-hook-form with full validation (required, regex, min/max, length)
 *  - Conditional visibility via visibleWhen rules
 *  - All field types: text, textarea, number, currency, date, datetime, time,
 *    email, phone, select, multi_select, radio, boolean, file, image, signature,
 *    reference, user, heading, divider, table
 *  - Table columns fully typed (currency symbol, select options, boolean, etc.)
 *  - Same public API as v1 — callers (UploadPage, DocumentDetailPage) need zero changes
 */
import { useState, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { useForm, Controller } from "react-hook-form";
import { useQuery } from "@tanstack/react-query";
import { AlertCircle, ChevronDown, Download, ExternalLink, Loader2, Pencil, Paperclip, Plus, Search, Trash2, X } from "lucide-react";
import type { ReactNode } from "react";
import { documentsAPI } from "@/services/api";
import { toast } from "@/components/ui/vault-toast";
import {
  resolveSource,
  isReferenceValue,
  referenceLabel,
  type ReferenceValue,
} from "@/components/templates/referenceSources";
import { resolveFormula, evaluateFormula, formulaLabel } from "@/components/templates/formulas";
import { useAuthStore } from "@/store/authStore";
import { Sparkles } from "lucide-react";

// ── Types ─────────────────────────────────────────────────────────────────────

type ColType =
  | "text" | "textarea" | "number" | "currency" | "date" | "datetime" | "time"
  | "select" | "boolean" | "email" | "phone" | "reference" | "user" | "file";

type Column = {
  id?: string; key?: string; label?: string; required?: boolean;
  type?: ColType | string; options?: string[]; currencySymbol?: string;
  tooltip?: string; additionalText?: string; readonly?: boolean; hidden?: boolean;
  defaultValue?: string; referenceSource?: string;
};

type VisibleWhen = {
  fieldKey: string;
  operator: "equals" | "not_equals" | "is_empty" | "is_not_empty" | string;
  value?: string;
};

type Field = {
  id?: string; key?: string; type?: string; label?: string;
  placeholder?: string; help_text?: string; helpText?: string;
  required?: boolean; colSpan?: number; width?: number;
  options?: string[]; columns?: Column[]; minRows?: number;
  currencySymbol?: string; referenceSource?: string; tooltip?: string; regex?: string;
  min?: number; max?: number; minLength?: number; maxLength?: number;
  defaultValue?: string; readonly?: boolean; hidden?: boolean;
  formula?: string;
  visibleWhen?: VisibleWhen | null;
};

type Section = { id?: string; title?: string; description?: string; fields?: Field[] };

export type TemplateFormValues = Record<string, unknown>;

type AttachmentValue = {
  type?: string;
  field_key?: string;
  name?: string;
  size?: number;
  content_type?: string;
  storage_path?: string;
};

function isAttachmentValue(value: unknown): value is AttachmentValue {
  return Boolean(value && typeof value === "object" && "storage_path" in value);
}

function formatFileSize(size?: number) {
  if (!size) return "";
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

// ── Reference / user picker ─────────────────────────────────────────────────────

/**
 * Searchable picker backed by a real backend source (users, groups, departments,
 * documents, document types). Stores `{ id, label, source }`. In read-only mode
 * it renders the stored label (documents link to the target).
 */
function ReferencePicker({ source, value, onChange, disabled, compact }: {
  source?: string;
  value: unknown;
  onChange: (v: ReferenceValue | undefined) => void;
  disabled?: boolean;
  compact?: boolean;
}) {
  const resolved = resolveSource(source);
  const selected = isReferenceValue(value) ? value : null;
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [coords, setCoords] = useState<{ top: number; left: number; width: number } | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  // Position the (portalled) dropdown under the trigger; reposition on
  // scroll/resize. The portal escapes the form section's `overflow-hidden`
  // (and the table's horizontal scroll) so results are never clipped.
  useEffect(() => {
    if (!open) return;
    const place = () => {
      const r = boxRef.current?.getBoundingClientRect();
      if (r) setCoords({ top: r.bottom + 4, left: r.left, width: r.width });
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
    };
  }, [open]);

  // Close on outside click (trigger and the portalled panel both count as inside).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (boxRef.current?.contains(t) || panelRef.current?.contains(t)) return;
      setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const { data: options = [], isFetching } = useQuery({
    queryKey: ["reference-source", resolved?.key, resolved?.serverSearch ? debounced : ""],
    queryFn: () => resolved!.fetch(debounced),
    enabled: open && Boolean(resolved),
    staleTime: 30_000,
  });

  // Client-side filter for sources without server search.
  const visibleOptions = resolved?.serverSearch
    ? options
    : options.filter((o) => o.label.toLowerCase().includes(debounced.toLowerCase()));

  // Read-only: show the stored label (documents become a link).
  if (disabled) {
    const label = referenceLabel(value);
    if (!label) return <span className="text-xs text-muted-foreground">—</span>;
    if (resolved?.key === "documents" && selected?.id) {
      return (
        <a href={`/documents/${selected.id}`} target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline">
          {label}<ExternalLink className="h-3 w-3" />
        </a>
      );
    }
    return <span className="text-sm text-foreground">{label}</span>;
  }

  // No known source — degrade to a plain text input so the form never breaks.
  if (!resolved) {
    return (
      <input
        type="text"
        value={referenceLabel(value)}
        disabled={disabled}
        className={compact ? "w-full bg-transparent py-0.5 text-sm outline-none" : "input"}
        onChange={(e) => onChange(e.target.value ? { id: "", label: e.target.value, source } : undefined)}
      />
    );
  }

  const triggerCls = compact
    ? "flex w-full items-center justify-between gap-1 bg-transparent py-0.5 text-sm outline-none text-foreground"
    : "input flex items-center justify-between gap-2";

  return (
    <div className="relative" ref={boxRef}>
      <button type="button" disabled={disabled} className={triggerCls}
        onClick={() => setOpen((o) => !o)}>
        <span className={selected ? "truncate text-foreground" : "truncate text-muted-foreground"}>
          {selected ? selected.label : `Select ${resolved.key.replace(/_/g, " ")}…`}
        </span>
        <span className="flex flex-shrink-0 items-center gap-1">
          {selected && (
            <X className="h-3.5 w-3.5 text-muted-foreground hover:text-red-500"
              onClick={(e) => { e.stopPropagation(); onChange(undefined); }} />
          )}
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
        </span>
      </button>

      {open && coords && createPortal(
        <div ref={panelRef}
          style={{ position: "fixed", top: coords.top, left: coords.left, width: Math.max(coords.width, 192) }}
          className="z-[100] rounded-md border border-border bg-card shadow-lg">
          <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
            <Search className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
            <input autoFocus value={search} onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
          </div>
          <div className="max-h-56 overflow-y-auto py-1">
            {isFetching && (
              <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" /> Loading…
              </div>
            )}
            {!isFetching && visibleOptions.length === 0 && (
              <div className="px-3 py-2 text-xs text-muted-foreground">No matches.</div>
            )}
            {visibleOptions.map((opt) => (
              <button key={opt.id} type="button"
                className="block w-full truncate px-3 py-1.5 text-left text-sm text-foreground hover:bg-muted/60"
                onClick={() => {
                  onChange({ id: opt.id, label: opt.label, source: resolved.key });
                  setOpen(false);
                  setSearch("");
                }}>
                {opt.label}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

// ── Conditional visibility ────────────────────────────────────────────────────

function evalVisible(field: Field, values: TemplateFormValues, allFields: Field[]): boolean {
  if (!field.visibleWhen) return true;
  const rule = field.visibleWhen;
  const sib = allFields.find((f) => f.key === rule.fieldKey);
  if (!sib) return true;
  const v = values[sib.key ?? ""];
  const sv = v == null ? "" : String(v);
  switch (rule.operator) {
    case "equals":       return sv === (rule.value ?? "");
    case "not_equals":   return sv !== (rule.value ?? "");
    case "is_empty":     return sv.trim() === "";
    case "is_not_empty": return sv.trim() !== "";
    default:             return true;
  }
}

// ── Table column cell ─────────────────────────────────────────────────────────

function TableFileCell({ value, onChange, disabled, documentId, attachmentKey }: {
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  documentId?: string;
  attachmentKey?: string;
}) {
  const [downloading, setDownloading] = useState(false);
  const descriptor = isAttachmentValue(value) ? value : null;
  const file = value instanceof File ? value : null;

  const download = async () => {
    if (!documentId || !attachmentKey || !descriptor) return;
    setDownloading(true);
    try {
      const response = await documentsAPI.downloadFormAttachment(documentId, attachmentKey);
      const blob = new Blob([response.data], {
        type: descriptor.content_type || response.data?.type || "application/octet-stream",
      });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = descriptor.name || "attachment";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Could not download this attachment.");
    } finally {
      setDownloading(false);
    }
  };

  if (file) {
    return (
      <div className="flex items-center gap-1 text-xs text-foreground">
        <Paperclip className="h-3 w-3 flex-shrink-0 text-primary" />
        <span className="min-w-0 truncate" title={file.name}>{file.name}</span>
        {!disabled && (
          <button type="button" onClick={() => onChange(undefined)}
            className="flex-shrink-0 text-muted-foreground hover:text-red-500">
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
    );
  }

  if (descriptor) {
    return (
      <div className="flex items-center gap-1.5 text-xs text-foreground">
        <Paperclip className="h-3 w-3 flex-shrink-0 text-primary" />
        <span className="min-w-0 truncate" title={descriptor.name}>{descriptor.name}</span>
        {documentId && attachmentKey && (
          <button type="button" onClick={download} disabled={downloading}
            className="flex-shrink-0 text-primary hover:text-primary/80 disabled:opacity-50">
            {downloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
          </button>
        )}
        {!disabled && (
          <label className="flex-shrink-0 cursor-pointer text-[10px] font-semibold text-primary hover:underline">
            Replace
            <input type="file" className="sr-only"
              onChange={(e) => onChange(e.target.files?.[0] ?? undefined)} />
          </label>
        )}
      </div>
    );
  }

  return (
    <input type="file" disabled={disabled} className="text-xs w-full"
      onChange={(e) => onChange(e.target.files?.[0] ?? undefined)} />
  );
}

function TableColInput({ col, value, onChange, readOnly, documentId, attachmentKey }: {
  col: Column; value: unknown; onChange: (v: unknown) => void; readOnly?: boolean;
  documentId?: string; attachmentKey?: string;
}) {
  const base = "w-full bg-transparent py-0.5 text-sm outline-none text-foreground placeholder:text-muted-foreground/50";
  if (col.hidden) return null;
  const type = (col.type ?? "text") as ColType;
  const dis = readOnly || col.readonly;

  if (type === "file") {
    return (
      <TableFileCell value={value} onChange={onChange} disabled={dis}
        documentId={documentId} attachmentKey={attachmentKey} />
    );
  }

  const sval = typeof value === "string" ? value : value == null ? "" : String(value);

  switch (type) {
    case "select":
      return (
        <select value={sval} onChange={(e) => onChange(e.target.value)} disabled={dis} className={base}>
          <option value="">—</option>
          {(col.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
        </select>
      );
    case "boolean":
      return <input type="checkbox" checked={sval === "true"} disabled={dis} onChange={(e) => onChange(e.target.checked ? "true" : "false")} className="h-4 w-4 accent-primary" />;
    case "textarea":
      return <textarea rows={1} value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={`${base} resize-none`} />;
    case "currency":
      return (
        <div className="flex items-center gap-1">
          <span className="text-[10px] text-muted-foreground flex-shrink-0">{col.currencySymbol ?? "KSh"}</span>
          <input type="number" step="0.01" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} placeholder="0.00" />
        </div>
      );
    case "number":
      return <input type="number" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "date":
      return <input type="date" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "datetime":
      return <input type="datetime-local" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "time":
      return <input type="time" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "email":
      return <input type="email" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "phone":
      return <input type="tel" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
    case "reference":
    case "user":
      return (
        <ReferencePicker
          source={col.referenceSource ?? (type === "user" ? "users" : "documents")}
          value={value}
          onChange={onChange}
          disabled={dis}
          compact
        />
      );
    default:
      return <input type="text" value={sval} disabled={dis} onChange={(e) => onChange(e.target.value)} className={base} />;
  }
}

// ── Table field ───────────────────────────────────────────────────────────────

function TableField({ field, value, onChange, readOnly, tableKey, documentId }: {
  field: Field;
  value: Record<string, unknown>[];
  onChange: (rows: Record<string, unknown>[]) => void;
  readOnly?: boolean;
  tableKey: string;
  documentId?: string;
}) {
  const cols = (field.columns ?? []).filter((c) => !c.hidden);
  const emptyRow = (): Record<string, unknown> => {
    const r: Record<string, unknown> = {};
    cols.forEach((c) => { if (c.defaultValue && c.key) r[c.key] = c.defaultValue; });
    return r;
  };
  const [rows, setRows] = useState<Record<string, unknown>[]>(() =>
    Array.isArray(value) && value.length > 0
      ? value
      : Array.from({ length: field.minRows ?? 1 }, emptyRow)
  );

  const update = (ri: number, key: string, val: unknown) => {
    const next = rows.map((r, i) => i === ri ? { ...r, [key]: val } : r);
    setRows(next); onChange(next);
  };
  const addRow = () => { const next = [...rows, emptyRow()]; setRows(next); onChange(next); };
  const removeRow = (i: number) => { const next = rows.filter((_, idx) => idx !== i); setRows(next); onChange(next); };

  return (
    <div className="col-span-12 space-y-2">
      <div className="text-xs font-semibold text-foreground">
        {field.label}
        {field.required && <span className="ml-1 text-red-500">*</span>}
        {(field.helpText ?? field.help_text) && (
          <span className="ml-2 font-normal text-muted-foreground">{field.helpText ?? field.help_text}</span>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/40">
              {cols.map((col, i) => (
                <th key={col.id ?? i} title={col.tooltip}
                    className="px-3 py-2 text-left text-[11px] font-semibold text-muted-foreground border-r border-border/50 last:border-0 whitespace-nowrap">
                  {col.label}{col.required && <span className="text-red-400 ml-0.5">*</span>}
                  {col.additionalText && <div className="text-[10px] font-normal opacity-70">{col.additionalText}</div>}
                </th>
              ))}
              {!readOnly && <th className="w-8" />}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, ri) => (
              <tr key={ri} className="border-b border-border/40 last:border-0 hover:bg-muted/20 transition-colors">
                {cols.map((col, ci) => {
                  const key = col.key ?? `col_${ci}`;
                  return (
                    <td key={col.id ?? ci} className="px-2 py-1.5 border-r border-border/30 last:border-0">
                      <TableColInput
                        col={col}
                        value={row[key] ?? ""}
                        onChange={(v) => update(ri, key, v)}
                        readOnly={readOnly}
                        documentId={documentId}
                        attachmentKey={`${tableKey}~${ri}~${key}`}
                      />
                    </td>
                  );
                })}
                {!readOnly && (
                  <td className="px-1 text-center">
                    {rows.length > 1 && (
                      <button type="button" onClick={() => removeRow(ri)} className="p-0.5 text-muted-foreground hover:text-red-500 transition-colors rounded">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!readOnly && (
        <button type="button" onClick={addRow} className="flex items-center gap-1.5 text-xs font-semibold text-primary hover:text-primary/80 transition-colors">
          <Plus className="h-3.5 w-3.5" /> Add row
        </button>
      )}
    </div>
  );
}

// ── File / Image attach field ──────────────────────────────────────────────────

function FileAttachField({ label, fieldKey, imageOnly, disabled, value, documentId, onChangeCb }: {
  label: string;
  fieldKey: string;
  imageOnly?: boolean;
  disabled?: boolean;
  value?: unknown;
  documentId?: string;
  onChangeCb: (key: string, val: unknown) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [downloading, setDownloading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const descriptor = isAttachmentValue(value) ? value : null;

  const pick = (f: File | null) => {
    setFile(f);
    onChangeCb(fieldKey, f ?? undefined);
  };

  const downloadAttachment = async () => {
    if (!documentId || !descriptor) return;
    setDownloading(true);
    try {
      const response = await documentsAPI.downloadFormAttachment(documentId, fieldKey);
      const blob = new Blob([response.data], { type: descriptor.content_type || response.data?.type || "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = descriptor.name || label || "attachment";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch {
      toast.error("Could not download this attachment.");
    } finally {
      setDownloading(false);
    }
  };

  return (
    <div>
      {!file && descriptor ? (
        // An attachment is already saved on the form. Show it (with download),
        // and — when editing — allow replacing it without losing the existing
        // file if the user leaves it untouched.
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
          <Paperclip className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">{descriptor.name || label}</span>
          {descriptor.size ? (
            <span className="flex-shrink-0 text-[10px] text-muted-foreground">{formatFileSize(descriptor.size)}</span>
          ) : null}
          {documentId && (
            <button
              type="button"
              onClick={downloadAttachment}
              disabled={downloading}
              className="flex-shrink-0 rounded border border-border bg-white px-2 py-1 text-[11px] font-semibold text-primary hover:bg-muted disabled:opacity-50"
            >
              {downloading ? <Loader2 className="h-3 w-3 animate-spin" /> : <Download className="h-3 w-3" />}
            </button>
          )}
          {!disabled && (
            <label className="flex-shrink-0 cursor-pointer rounded border border-border bg-white px-2 py-1 text-[11px] font-semibold text-primary hover:bg-muted">
              Replace
              <input
                type="file"
                accept={imageOnly ? "image/*" : undefined}
                className="sr-only"
                onChange={(e) => pick(e.target.files?.[0] ?? null)}
              />
            </label>
          )}
        </div>
      ) : file ? (
        <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2.5">
          <Paperclip className="h-4 w-4 flex-shrink-0 text-primary" />
          <span className="min-w-0 flex-1 truncate text-xs text-foreground">{file.name}</span>
          <span className="flex-shrink-0 text-[10px] text-muted-foreground">
            {(file.size / 1024).toFixed(0)} KB
          </span>
          {!disabled && (
            <button type="button" onClick={() => pick(null)}
              className="flex-shrink-0 rounded p-0.5 text-muted-foreground hover:text-red-500">
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ) : (
        <label className={`flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed
          border-border bg-muted/20 py-5 text-xs text-muted-foreground transition-colors
          hover:border-primary/50 hover:text-foreground ${disabled ? "pointer-events-none opacity-50" : ""}`}>
          <Paperclip className="h-5 w-5" />
          <span>Click to {imageOnly ? "upload image" : "attach file"}</span>
          <input
            ref={inputRef}
            type="file"
            accept={imageOnly ? "image/*" : undefined}
            disabled={disabled}
            className="sr-only"
            onChange={(e) => pick(e.target.files?.[0] ?? null)}
          />
        </label>
      )}
    </div>
  );
}

// ── Signature pad field ────────────────────────────────────────────────────────

function SignatureField({ fieldKey, disabled, value, onChangeCb }: {
  fieldKey: string;
  disabled?: boolean;
  value?: unknown;
  onChangeCb: (key: string, val: unknown) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const loadedRef = useRef<string | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [signed, setSigned] = useState(false);

  // Render an existing signature (stored as a PNG data URL) onto the canvas —
  // so it shows in read-only/approval view and when re-editing the form.
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const v = typeof value === "string" ? value : "";
    if (v.startsWith("data:image") && loadedRef.current !== v) {
      loadedRef.current = v;
      const img = new Image();
      img.onload = () => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
        setSigned(true);
      };
      img.src = v;
    }
  }, [value]);

  const getPos = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    const rect = canvasRef.current!.getBoundingClientRect();
    if ("touches" in e) {
      return { x: e.touches[0].clientX - rect.left, y: e.touches[0].clientY - rect.top };
    }
    return { x: (e as React.MouseEvent).clientX - rect.left, y: (e as React.MouseEvent).clientY - rect.top };
  };

  const startDraw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (disabled) return;
    const ctx = canvasRef.current!.getContext("2d")!;
    const { x, y } = getPos(e);
    ctx.beginPath();
    ctx.moveTo(x, y);
    setDrawing(true);
  };

  const draw = (e: React.MouseEvent<HTMLCanvasElement> | React.TouchEvent<HTMLCanvasElement>) => {
    if (!drawing || disabled) return;
    e.preventDefault();
    const ctx = canvasRef.current!.getContext("2d")!;
    ctx.lineWidth = 1.8;
    ctx.lineCap = "round";
    ctx.strokeStyle = "#0f172a";
    const { x, y } = getPos(e);
    ctx.lineTo(x, y);
    ctx.stroke();
    setSigned(true);
  };

  const endDraw = () => {
    if (!drawing) return;
    setDrawing(false);
    const dataUrl = canvasRef.current!.toDataURL("image/png");
    loadedRef.current = dataUrl; // our own stroke — don't reload it as an image
    onChangeCb(fieldKey, dataUrl);
  };

  const clear = () => {
    const canvas = canvasRef.current!;
    canvas.getContext("2d")!.clearRect(0, 0, canvas.width, canvas.height);
    loadedRef.current = null;
    setSigned(false);
    onChangeCb(fieldKey, undefined);
  };

  return (
    <div className="relative">
      <canvas
        ref={canvasRef}
        width={600}
        height={120}
        className={`w-full rounded-lg border-2 ${signed ? "border-primary/40" : "border-dashed border-border"}
          bg-white touch-none ${disabled ? "opacity-50" : "cursor-crosshair"}`}
        style={{ height: 120 }}
        onMouseDown={startDraw}
        onMouseMove={draw}
        onMouseUp={endDraw}
        onMouseLeave={endDraw}
        onTouchStart={startDraw}
        onTouchMove={draw}
        onTouchEnd={endDraw}
      />
      {!signed && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-1.5 text-xs text-muted-foreground">
          <Pencil className="h-3.5 w-3.5" /> Sign here
        </div>
      )}
      {signed && !disabled && (
        <button type="button" onClick={clear}
          className="absolute right-2 top-2 flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px]
            font-semibold text-muted-foreground hover:text-red-500 hover:bg-red-50 transition-colors">
          <X className="h-3 w-3" /> Clear
        </button>
      )}
    </div>
  );
}

// ── Single form field ─────────────────────────────────────────────────────────

const inp = "input";
const errCls = "mt-1 flex items-center gap-1 text-xs text-red-500";

function FormField({ field, control, errors, onChangeCb, readOnly, allValues }: {
  field: Field;
  control: any;
  errors: Record<string, any>;
  onChangeCb: (key: string, val: unknown) => void;
  readOnly?: boolean;
  allValues: TemplateFormValues;
}) {
  const key  = field.key ?? field.id ?? "";
  const type = field.type ?? "text";
  const label = field.label ?? key;
  const help  = field.helpText ?? field.help_text;
  const span  = Math.min(12, Math.max(1, field.colSpan ?? field.width ?? 6));
  const style = { gridColumn: `span ${span} / span ${span}` };
  const dis   = readOnly || field.readonly;
  const err   = errors[key]?.message as string | undefined;

  if (field.hidden) return null;

  // Layout-only elements
  if (type === "heading") return (
    <div style={{ gridColumn: "span 12 / span 12" }}>
      <h4 className="border-b border-border pb-1.5 pt-2 text-sm font-bold text-foreground">{label}</h4>
    </div>
  );
  if (type === "divider") return <div style={{ gridColumn: "span 12 / span 12" }}><hr className="border-border" /></div>;

  // Table handled separately (needs full width + local state)
  if (type === "table") return (
    <TableField
      field={field}
      value={Array.isArray(allValues[key]) ? (allValues[key] as Record<string, unknown>[]) : []}
      onChange={(rows) => onChangeCb(key, rows)}
      readOnly={readOnly}
      tableKey={key}
      documentId={allValues.__document_id as string | undefined}
    />
  );

  // Auto-fill (formula) fields: read-only, value is computed (client preview /
  // server-authoritative). Rendered the same way whether filling or approving.
  if (resolveFormula(field.formula)) {
    const shown = referenceLabel(allValues[key]);
    return (
      <div style={style}>
        <label className="mb-1.5 block text-xs font-semibold text-foreground">
          {label}
          {field.required && <span className="ml-1 text-red-500">*</span>}
          <span className="ml-2 inline-flex items-center gap-1 rounded bg-primary/10 px-1.5 py-0.5 align-middle text-[10px] font-medium text-primary">
            <Sparkles className="h-2.5 w-2.5" /> Auto · {formulaLabel(field.formula)}
          </span>
        </label>
        <div className={`${inp} flex items-center bg-muted/40 text-muted-foreground`}>
          {shown || <span className="italic">Filled automatically on save</span>}
        </div>
      </div>
    );
  }

  // Validation rules
  const rules: Record<string, any> = {};
  if (field.required && !readOnly && type !== "boolean" && type !== "checkbox")
    rules.required = `${label} is required`;
  if (field.regex)
    rules.pattern = { value: new RegExp(field.regex), message: "Invalid format" };
  if (field.minLength !== undefined)
    rules.minLength = { value: field.minLength, message: `Minimum ${field.minLength} characters` };
  if (field.maxLength !== undefined)
    rules.maxLength = { value: field.maxLength, message: `Maximum ${field.maxLength} characters` };
  if (field.min !== undefined)
    rules.min = { value: field.min, message: `Minimum value: ${field.min}` };
  if (field.max !== undefined)
    rules.max = { value: field.max, message: `Maximum value: ${field.max}` };

  // Checkbox / boolean — inline label layout
  if (type === "boolean" || type === "checkbox") {
    return (
      <div style={style}>
        <Controller control={control} name={key} render={({ field: f }) => (
          <label className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground">
            <input type="checkbox" checked={Boolean(f.value)} disabled={dis}
              className="h-4 w-4 rounded border-border accent-primary"
              onChange={(e) => { f.onChange(e.target.checked); onChangeCb(key, e.target.checked); }} />
            {label}
            {field.required && <span className="text-red-500">*</span>}
          </label>
        )} />
      </div>
    );
  }

  // Shared label element
  const labelEl = (
    <label className="mb-1.5 block text-xs font-semibold text-foreground">
      {label}
      {field.required && <span className="ml-1 text-red-500">*</span>}
      {field.tooltip && <span className="ml-1 cursor-help text-muted-foreground" title={field.tooltip}>(?)</span>}
      {help && <span className="ml-2 font-normal text-muted-foreground">{help}</span>}
    </label>
  );

  // Static / non-interactive types
  if (type === "signature") {
    return (
      <div style={style}>
        {labelEl}
        <SignatureField
          fieldKey={key}
          disabled={dis}
          value={allValues[key]}
          onChangeCb={onChangeCb}
        />
      </div>
    );
  }
  if (type === "file" || type === "image") {
    return (
      <div style={style}>
        {labelEl}
        <FileAttachField
          label={label}
          fieldKey={key}
          imageOnly={type === "image"}
          disabled={dis}
          value={allValues[key]}
          documentId={(allValues.__document_id as string | undefined)}
          onChangeCb={onChangeCb}
        />
      </div>
    );
  }

  // All other types via Controller
  let control_el: ReactNode;
  switch (type) {
    case "textarea":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <textarea {...f} value={String(f.value ?? "")} disabled={dis} placeholder={field.placeholder}
            rows={4} className={`${inp} resize-y`}
            onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }} />
        )} />
      );
      break;

    case "select":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <select {...f} value={String(f.value ?? "")} disabled={dis} className={inp}
            onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }}>
            <option value="">{field.placeholder ?? "Select an option…"}</option>
            {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )} />
      );
      break;

    case "multi_select":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <select multiple value={Array.isArray(f.value) ? f.value as string[] : []} disabled={dis}
            className={`${inp} h-auto min-h-[80px] py-2`}
            onChange={(e) => {
              const sel = Array.from(e.target.selectedOptions).map((o) => o.value);
              f.onChange(sel); onChangeCb(key, sel);
            }}>
            {(field.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )} />
      );
      break;

    case "radio":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <div className="flex flex-col gap-2 pt-1">
            {(field.options ?? []).map((o) => (
              <label key={o} className="flex cursor-pointer items-center gap-2.5 text-sm text-foreground">
                <input type="radio" value={o} checked={f.value === o} disabled={dis} className="h-4 w-4 accent-primary"
                  onChange={() => { f.onChange(o); onChangeCb(key, o); }} />
                {o}
              </label>
            ))}
          </div>
        )} />
      );
      break;

    case "currency":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <div className="relative">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm font-medium text-muted-foreground">
              {field.currencySymbol ?? "KSh"}
            </span>
            <input type="number" step="0.01" value={String(f.value ?? "")} disabled={dis}
              placeholder="0.00" min={field.min} max={field.max}
              className={`${inp} pl-14`}
              onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }} />
          </div>
        )} />
      );
      break;

    case "reference":
    case "user":
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <ReferencePicker
            source={field.referenceSource ?? (type === "user" ? "users" : "documents")}
            value={f.value}
            disabled={dis}
            onChange={(v) => { f.onChange(v); onChangeCb(key, v); }}
          />
        )} />
      );
      break;

    default: {
      // text, number, email, phone, date, datetime, time
      const htmlType =
        type === "number" ? "number"
        : type === "email" ? "email"
        : type === "phone" ? "tel"
        : type === "date" ? "date"
        : type === "datetime" ? "datetime-local"
        : type === "time" ? "time"
        : "text";
      control_el = (
        <Controller control={control} name={key} rules={rules} render={({ field: f }) => (
          <input type={htmlType} value={String(f.value ?? "")} disabled={dis}
            placeholder={field.placeholder} min={field.min} max={field.max}
            maxLength={field.maxLength} className={inp}
            onChange={(e) => { f.onChange(e.target.value); onChangeCb(key, e.target.value); }} />
        )} />
      );
    }
  }

  return (
    <div style={style}>
      {labelEl}
      {control_el}
      {err && (
        <p className={errCls}><AlertCircle className="h-3 w-3 flex-shrink-0" />{err}</p>
      )}
    </div>
  );
}

// ── Main export ───────────────────────────────────────────────────────────────

export default function TemplateForm({ sections, values, onChange, readOnly = false, documentId }: {
  sections: unknown[];
  values: TemplateFormValues;
  onChange: (key: string, value: unknown) => void;
  readOnly?: boolean;
  documentId?: string;
}) {
  const list = (Array.isArray(sections) ? sections : []) as Section[];
  const allFields = list.flatMap((s) => s.fields ?? []);

  // Derive a stable key from section IDs so we can detect template changes
  const sectionsKey = list.map((s) => s.id ?? "").join("|");
  const prevKeyRef = useRef(sectionsKey);

  const { control, formState: { errors }, reset, watch } = useForm<TemplateFormValues>({
    defaultValues: values,
    mode: "onBlur",
  });

  // When a different template is loaded (sections change), reset the form
  useEffect(() => {
    if (prevKeyRef.current !== sectionsKey) {
      prevKeyRef.current = sectionsKey;
      reset({});
    }
  }, [sectionsKey]);

  const currentUser = useAuthStore((s) => s.user);

  // Auto-fill formula fields with a client preview while filling a NEW form.
  // The server finalizes authoritative values on create; an existing document
  // keeps its frozen values, so we skip when editing/viewing one (documentId set).
  useEffect(() => {
    if (readOnly || documentId) return;
    for (const f of allFields) {
      const k = f.key ?? f.id ?? "";
      if (!k || !resolveFormula(f.formula)) continue;
      const current = values[k];
      const isEmpty = current == null || (typeof current === "string" && current.trim() === "");
      if (!isEmpty) continue;
      const computed = evaluateFormula(f.formula, { user: currentUser, now: new Date() });
      if (computed) onChange(k, computed);
    }
  }, [sectionsKey, currentUser, readOnly, documentId]);

  // Keep a live snapshot of form values for conditional visibility
  const liveValues = { ...values, ...(watch() as TemplateFormValues), __document_id: documentId };

  if (list.length === 0) {
    return <p className="text-sm text-muted-foreground">This form has no fields.</p>;
  }

  // Read-only mode: every editing control is individually `disabled`, so we must
  // NOT blanket the form in `pointer-events-none` — that would also block the
  // attachment download buttons (the approver needs to open attachments).
  return (
    <div className="space-y-6">
      {list.map((section, si) => {
        const visibleFields = (section.fields ?? []).filter((f) =>
          evalVisible(f, liveValues as TemplateFormValues, allFields)
        );
        return (
          <div key={section.id ?? si} className="rounded-xl border border-border bg-card shadow-sm overflow-hidden">
            {/* Section header */}
            <div className="border-b border-border bg-muted/40 px-5 py-3">
              <h3 className="text-sm font-bold text-foreground">{section.title ?? `Section ${si + 1}`}</h3>
              {section.description && (
                <p className="mt-0.5 text-xs text-muted-foreground">{section.description}</p>
              )}
            </div>
            {/* Fields — 12-column grid */}
            <div className="p-5 grid grid-cols-12 gap-x-4 gap-y-5">
              {visibleFields.map((f, fi) => (
                <FormField
                  key={f.id ?? fi}
                  field={f}
                  control={control}
                  errors={errors as Record<string, any>}
                  onChangeCb={onChange}
                  readOnly={readOnly}
                  allValues={liveValues as TemplateFormValues}
                />
              ))}
              {visibleFields.length === 0 && (
                <p className="col-span-12 text-sm text-muted-foreground">No fields in this section.</p>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Validation helper (unchanged signature) ───────────────────────────────────

/** Returns labels of required fields that are missing or fail basic validation. */
export function requiredFieldLabels(sections: unknown[], values: TemplateFormValues): string[] {
  const list = (Array.isArray(sections) ? sections : []) as Section[];
  const allFields = list.flatMap((s) => s.fields ?? []);
  const missing: string[] = [];
  for (const s of list) {
    for (const f of s.fields ?? []) {
      const type = f.type ?? "text";
      if (type === "divider" || type === "heading") continue;
      // Formula fields auto-fill (and the server finalizes them); never block on them.
      if (resolveFormula(f.formula)) continue;
      // Don't require a field the user can't see (hidden / conditionally hidden).
      if (f.hidden || !evalVisible(f, values, allFields)) continue;
      const key = f.key ?? "";
      const v   = values[key];
      if (f.required) {
        const empty =
          v === undefined || v === null ||
          (typeof v === "string" && v.trim() === "") ||
          (typeof v === "boolean" && !v) ||
          (Array.isArray(v) && v.length === 0);
        if (empty) { missing.push(f.label ?? key); continue; }
      }
      // Regex validation
      if (f.regex && typeof v === "string" && v) {
        try {
          if (!new RegExp(f.regex).test(v)) missing.push(`${f.label ?? key} (invalid format)`);
        } catch { /* bad regex — skip */ }
      }
    }
  }
  return missing;
}
