/**
 * SidePanel — the right-hand configuration panel. Renders the form for the
 * active tool (watermark, page numbers, split, convert, secure, …) and calls
 * the matching callback when applied.
 */
import { useRef, useState } from "react";
import { X, ArrowUp, ArrowDown } from "lucide-react";
import clsx from "clsx";
import type {
  BatesConfig, CompressLevel, ConvertConfig, HeaderFooterConfig,
  MetadataConfig, PageNumberConfig, PagePosition, SplitConfig, ToolId,
  WatermarkConfig,
} from "../types";

const POSITIONS: PagePosition[] = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
];

interface Props {
  tool: ToolId;
  pageCount: number;
  onMerge: (files: File[]) => void;
  onInsertFiles: (files: File[]) => void;
  onWatermark: (c: WatermarkConfig) => void;
  onPageNumbers: (c: PageNumberConfig) => void;
  onHeaderFooter: (c: HeaderFooterConfig) => void;
  onBates: (c: BatesConfig) => void;
  onMetadata: (c: MetadataConfig) => void;
  onSplit: (c: SplitConfig) => void;
  onCompress: (level: CompressLevel) => void;
  onConvert: (c: ConvertConfig) => void;
  onProtect: (password: string, permissions: string[]) => void;
  onUnlock: (password: string) => void;
}

export default function SidePanel(props: Props) {
  switch (props.tool) {
    case "merge": return <MergePanel onMerge={props.onMerge} />;
    case "insert": return <InsertPanel onInsert={props.onInsertFiles} />;
    case "split": return <SplitPanel pageCount={props.pageCount} onSplit={props.onSplit} />;
    case "watermark": return <WatermarkPanel onApply={props.onWatermark} />;
    case "page_numbers": return <PageNumbersPanel onApply={props.onPageNumbers} />;
    case "header_footer": return <HeaderFooterPanel onApply={props.onHeaderFooter} />;
    case "bates": return <BatesPanel onApply={props.onBates} />;
    case "metadata": return <MetadataPanel onApply={props.onMetadata} />;
    case "compress": return <CompressPanel onApply={props.onCompress} />;
    case "convert": return <ConvertPanel onApply={props.onConvert} />;
    case "protect": return <ProtectPanel onApply={props.onProtect} />;
    case "unlock": return <UnlockPanel onApply={props.onUnlock} />;
    default: return null;
  }
}

/* ---------- shared atoms ---------- */
const Field = ({ label, children }: { label: string; children: React.ReactNode }) => (
  <label className="block space-y-1">
    <span className="text-xs font-medium text-[#5E6870]">{label}</span>
    {children}
  </label>
);
const inputCls = "w-full rounded-md border border-[#C8CDD2] px-2.5 py-1.5 text-sm outline-none focus:border-[#287EAD]";
const Apply = ({ onClick, label = "Apply" }: { onClick: () => void; label?: string }) => (
  <button onClick={onClick} className="w-full rounded-md bg-[#287EAD] px-3 py-2 text-sm font-medium text-white hover:bg-[#216C95]">
    {label}
  </button>
);
const Wrap = ({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) => (
  <div className="flex h-full flex-col gap-3 overflow-auto p-4">
    <div>
      <h3 className="text-sm font-semibold text-[#2A3138]">{title}</h3>
      {hint && <p className="mt-0.5 text-xs text-[#5E6870]">{hint}</p>}
    </div>
    {children}
  </div>
);
const PositionGrid = ({ value, onChange }: { value: PagePosition; onChange: (p: PagePosition) => void }) => (
  <div className="grid grid-cols-3 gap-1">
    {POSITIONS.map((p) => (
      <button key={p} onClick={() => onChange(p)}
        className={clsx("h-8 rounded border text-[10px]", value === p ? "border-[#287EAD] bg-[#EEF6FB] text-[#287EAD]" : "border-[#C8CDD2] text-[#5E6870]")}>
        {p.split("-").map((s) => s[0].toUpperCase()).join("")}
      </button>
    ))}
  </div>
);

/* ---------- panels ---------- */
/** Pick files first, review the list, then confirm — so the action that
 *  actually merges/inserts is explicit (not a silent on-pick side effect). */
function FilePickPanel({
  title, hint, accept, chooseLabel, confirmLabel, onConfirm,
}: {
  title: string; hint: string; accept: string;
  chooseLabel: string; confirmLabel: (n: number) => string;
  onConfirm: (files: File[]) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);

  const move = (i: number, dir: -1 | 1) => {
    setFiles((prev) => {
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  return (
    <Wrap title={title} hint={hint}>
      <input
        ref={ref} type="file" accept={accept} multiple hidden
        onChange={(e) => { if (e.target.files) setFiles((prev) => [...prev, ...e.target.files!]); e.target.value = ""; }}
      />
      <button
        onClick={() => ref.current?.click()}
        className="w-full rounded-md border border-dashed border-[#C8CDD2] px-3 py-2 text-sm text-[#5E6870] hover:border-[#287EAD] hover:bg-[#EEF6FB]"
      >
        {chooseLabel}
      </button>

      {files.length > 0 && (
        <>
          <p className="text-xs font-medium uppercase tracking-wide text-[#9AA4AD]">
            Order — top is added first
          </p>
          <ul className="space-y-1">
            {files.map((f, i) => (
              <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded border border-[#E3E7EA] bg-white px-2 py-1.5 text-sm">
                <span className="w-4 shrink-0 text-center text-xs font-semibold text-[#5E6870]">{i + 1}</span>
                <span className="flex-1 truncate text-[#1F2933]" title={f.name}>{f.name}</span>
                <button onClick={() => move(i, -1)} disabled={i === 0}
                  className="shrink-0 rounded p-0.5 text-[#5E6870] hover:text-[#287EAD] disabled:opacity-30" title="Move up">
                  <ArrowUp className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => move(i, 1)} disabled={i === files.length - 1}
                  className="shrink-0 rounded p-0.5 text-[#5E6870] hover:text-[#287EAD] disabled:opacity-30" title="Move down">
                  <ArrowDown className="h-3.5 w-3.5" />
                </button>
                <button onClick={() => setFiles((prev) => prev.filter((_, j) => j !== i))}
                  className="shrink-0 rounded p-0.5 text-[#9AA4AD] hover:text-red-600" title="Remove">
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          <p className="text-[11px] text-[#9AA4AD]">
            Added after the current document. Fine-tune any page order afterwards in the Pages tab.
          </p>
          <Apply onClick={() => { onConfirm(files); setFiles([]); }} label={confirmLabel(files.length)} />
        </>
      )}
    </Wrap>
  );
}

function MergePanel({ onMerge }: { onMerge: (f: File[]) => void }) {
  return (
    <FilePickPanel
      title="Merge PDFs"
      hint="Choose PDFs to append after the current document, then merge."
      accept="application/pdf"
      chooseLabel="+ Choose PDFs to add"
      confirmLabel={(n) => (n ? `Merge ${n} PDF${n === 1 ? "" : "s"}` : "Merge")}
      onConfirm={onMerge}
    />
  );
}

function InsertPanel({ onInsert }: { onInsert: (f: File[]) => void }) {
  return (
    <FilePickPanel
      title="Insert pages"
      hint="Choose PDFs or images to insert after the current page, then insert."
      accept="application/pdf,image/*"
      chooseLabel="+ Choose files to insert"
      confirmLabel={(n) => (n ? `Insert ${n} file${n === 1 ? "" : "s"}` : "Insert")}
      onConfirm={onInsert}
    />
  );
}

function SplitPanel({ pageCount, onSplit }: { pageCount: number; onSplit: (c: SplitConfig) => void }) {
  const [mode, setMode] = useState<SplitConfig["mode"]>("ranges");
  const [ranges, setRanges] = useState("1-" + pageCount);
  const [everyN, setEveryN] = useState(1);
  const [count, setCount] = useState(2);
  return (
    <Wrap title="Split document" hint={`${pageCount} pages. Each part downloads as a separate PDF.`}>
      <Field label="Mode">
        <select className={inputCls} value={mode} onChange={(e) => setMode(e.target.value as SplitConfig["mode"])}>
          <option value="ranges">By ranges</option>
          <option value="everyN">Every N pages</option>
          <option value="byCount">Into N files</option>
          <option value="individual">One file per page</option>
        </select>
      </Field>
      {mode === "ranges" && <Field label="Ranges (comma-separated)"><input className={inputCls} value={ranges} onChange={(e) => setRanges(e.target.value)} placeholder="1-3, 4-6, 7" /></Field>}
      {mode === "everyN" && <Field label="Pages per file"><input type="number" min={1} className={inputCls} value={everyN} onChange={(e) => setEveryN(+e.target.value)} /></Field>}
      {mode === "byCount" && <Field label="Number of files"><input type="number" min={1} className={inputCls} value={count} onChange={(e) => setCount(+e.target.value)} /></Field>}
      <Apply onClick={() => onSplit({ mode, ranges, everyN, count })} label="Split & download" />
    </Wrap>
  );
}

function WatermarkPanel({ onApply }: { onApply: (c: WatermarkConfig) => void }) {
  const [text, setText] = useState("CONFIDENTIAL");
  const [opacity, setOpacity] = useState(0.2);
  const [rotation, setRotation] = useState(45);
  const [fontSize, setFontSize] = useState(60);
  const [color, setColor] = useState("#999999");
  const [position, setPosition] = useState<WatermarkConfig["position"]>("middle-center");
  return (
    <Wrap title="Watermark">
      <Field label="Text"><input className={inputCls} value={text} onChange={(e) => setText(e.target.value)} /></Field>
      <Field label={`Opacity ${Math.round(opacity * 100)}%`}><input type="range" min={5} max={100} value={opacity * 100} onChange={(e) => setOpacity(+e.target.value / 100)} className="w-full" /></Field>
      <Field label={`Rotation ${rotation}°`}><input type="range" min={-90} max={90} value={rotation} onChange={(e) => setRotation(+e.target.value)} className="w-full" /></Field>
      <Field label="Font size"><input type="number" className={inputCls} value={fontSize} onChange={(e) => setFontSize(+e.target.value)} /></Field>
      <Field label="Colour"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-full rounded-md border border-[#C8CDD2]" /></Field>
      <Field label="Placement">
        <select className={inputCls} value={position} onChange={(e) => setPosition(e.target.value as WatermarkConfig["position"])}>
          <option value="middle-center">Centre</option>
          <option value="tiled">Tiled</option>
        </select>
      </Field>
      <Apply onClick={() => onApply({ type: "text", text, opacity, rotation, fontSize, color, position })} />
    </Wrap>
  );
}

function PageNumbersPanel({ onApply }: { onApply: (c: PageNumberConfig) => void }) {
  const [position, setPosition] = useState<PagePosition>("bottom-center");
  const [startAt, setStartAt] = useState(1);
  const [fontSize, setFontSize] = useState(11);
  const [color, setColor] = useState("#444444");
  const [format, setFormat] = useState("Page {n} of {total}");
  return (
    <Wrap title="Page numbers">
      <Field label="Format"><input className={inputCls} value={format} onChange={(e) => setFormat(e.target.value)} placeholder="{n} / {total}" /></Field>
      <Field label="Start at"><input type="number" className={inputCls} value={startAt} onChange={(e) => setStartAt(+e.target.value)} /></Field>
      <Field label="Font size"><input type="number" className={inputCls} value={fontSize} onChange={(e) => setFontSize(+e.target.value)} /></Field>
      <Field label="Colour"><input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="h-9 w-full rounded-md border border-[#C8CDD2]" /></Field>
      <Field label="Position"><PositionGrid value={position} onChange={setPosition} /></Field>
      <Apply onClick={() => onApply({ position, startAt, fontSize, color, format, marginX: 36, marginY: 28 })} />
    </Wrap>
  );
}

function HeaderFooterPanel({ onApply }: { onApply: (c: HeaderFooterConfig) => void }) {
  const [hf, setHf] = useState<HeaderFooterConfig>({
    header: { left: "", center: "", right: "" },
    footer: { left: "", center: "", right: "" },
    fontSize: 10, color: "#444444", margin: 28,
  });
  const set = (band: "header" | "footer", slot: "left" | "center" | "right", v: string) =>
    setHf((s) => ({ ...s, [band]: { ...s[band], [slot]: v } }));
  const Row = ({ band }: { band: "header" | "footer" }) => (
    <div className="grid grid-cols-3 gap-1.5">
      {(["left", "center", "right"] as const).map((slot) => (
        <input key={slot} className={inputCls} placeholder={slot}
          value={(hf[band] as Record<string, string>)?.[slot] ?? ""}
          onChange={(e) => set(band, slot, e.target.value)} />
      ))}
    </div>
  );
  return (
    <Wrap title="Header & footer">
      <Field label="Header"><Row band="header" /></Field>
      <Field label="Footer"><Row band="footer" /></Field>
      <Field label="Font size"><input type="number" className={inputCls} value={hf.fontSize} onChange={(e) => setHf({ ...hf, fontSize: +e.target.value })} /></Field>
      <Apply onClick={() => onApply(hf)} />
    </Wrap>
  );
}

function BatesPanel({ onApply }: { onApply: (c: BatesConfig) => void }) {
  const [cfg, setCfg] = useState<BatesConfig>({ prefix: "BATES-", suffix: "", startAt: 1, digits: 6, position: "bottom-right", fontSize: 9, color: "#333333" });
  return (
    <Wrap title="Bates numbering" hint="Sequential legal numbering across pages.">
      <Field label="Prefix"><input className={inputCls} value={cfg.prefix} onChange={(e) => setCfg({ ...cfg, prefix: e.target.value })} /></Field>
      <Field label="Suffix"><input className={inputCls} value={cfg.suffix} onChange={(e) => setCfg({ ...cfg, suffix: e.target.value })} /></Field>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Start"><input type="number" className={inputCls} value={cfg.startAt} onChange={(e) => setCfg({ ...cfg, startAt: +e.target.value })} /></Field>
        <Field label="Digits"><input type="number" className={inputCls} value={cfg.digits} onChange={(e) => setCfg({ ...cfg, digits: +e.target.value })} /></Field>
      </div>
      <Field label="Position"><PositionGrid value={cfg.position} onChange={(p) => setCfg({ ...cfg, position: p })} /></Field>
      <Apply onClick={() => onApply(cfg)} />
    </Wrap>
  );
}

function MetadataPanel({ onApply }: { onApply: (c: MetadataConfig) => void }) {
  const [m, setM] = useState<MetadataConfig>({});
  const F = (k: keyof MetadataConfig, label: string) => (
    <Field label={label}><input className={inputCls} value={m[k] ?? ""} onChange={(e) => setM({ ...m, [k]: e.target.value })} /></Field>
  );
  return (
    <Wrap title="Document properties">
      {F("title", "Title")}{F("author", "Author")}{F("subject", "Subject")}
      {F("keywords", "Keywords")}{F("creator", "Creator")}{F("producer", "Producer")}
      <Apply onClick={() => onApply(m)} />
    </Wrap>
  );
}

function CompressPanel({ onApply }: { onApply: (l: CompressLevel) => void }) {
  const [level, setLevel] = useState<CompressLevel>("medium");
  const levels: Array<{ id: CompressLevel; label: string; hint: string }> = [
    { id: "low", label: "Low", hint: "Best quality" },
    { id: "medium", label: "Recommended", hint: "Good balance" },
    { id: "high", label: "High", hint: "Smaller size" },
    { id: "extreme", label: "Extreme", hint: "Smallest size" },
  ];
  return (
    <Wrap title="Compress" hint="Reduce file size. Deep compression runs on your backend.">
      <div className="space-y-1.5">
        {levels.map((l) => (
          <button key={l.id} onClick={() => setLevel(l.id)}
            className={clsx("flex w-full items-center justify-between rounded-md border px-3 py-2 text-sm", level === l.id ? "border-[#287EAD] bg-[#EEF6FB]" : "border-[#C8CDD2]")}>
            <span className="font-medium text-[#2A3138]">{l.label}</span>
            <span className="text-xs text-[#5E6870]">{l.hint}</span>
          </button>
        ))}
      </div>
      <Apply onClick={() => onApply(level)} label="Compress" />
    </Wrap>
  );
}

function ConvertPanel({ onApply }: { onApply: (c: ConvertConfig) => void }) {
  const [target, setTarget] = useState<ConvertConfig["target"]>("pdf-to-jpg");
  const [dpi, setDpi] = useState(150);
  const clientSide = target === "pdf-to-jpg" || target === "pdf-to-png" || target === "jpg-to-pdf";
  return (
    <Wrap title="Convert">
      <Field label="Target format">
        <select className={inputCls} value={target} onChange={(e) => setTarget(e.target.value as ConvertConfig["target"])}>
          <optgroup label="From PDF (in-browser)">
            <option value="pdf-to-jpg">PDF → JPG images</option>
            <option value="pdf-to-png">PDF → PNG images</option>
          </optgroup>
          <optgroup label="From PDF (backend)">
            <option value="pdf-to-docx">PDF → Word</option>
            <option value="pdf-to-xlsx">PDF → Excel</option>
            <option value="pdf-to-pptx">PDF → PowerPoint</option>
            <option value="pdf-to-text">PDF → Text</option>
          </optgroup>
          <optgroup label="To PDF">
            <option value="jpg-to-pdf">Images → PDF (in-browser)</option>
          </optgroup>
        </select>
      </Field>
      {(target === "pdf-to-jpg" || target === "pdf-to-png") && (
        <Field label={`Resolution ${dpi} DPI`}><input type="range" min={72} max={300} value={dpi} onChange={(e) => setDpi(+e.target.value)} className="w-full" /></Field>
      )}
      <p className="text-xs text-[#5E6870]">{clientSide ? "Runs locally — downloads instantly." : "Sent to your backend job pipeline."}</p>
      <Apply onClick={() => onApply({ target, dpi })} label="Convert" />
    </Wrap>
  );
}

function ProtectPanel({ onApply }: { onApply: (pw: string, perms: string[]) => void }) {
  const [pw, setPw] = useState("");
  const all = ["print", "copy", "modify", "annotate"];
  const [perms, setPerms] = useState<string[]>(all);
  return (
    <Wrap title="Protect with password" hint="Encryption is performed by your backend.">
      <Field label="Password"><input type="password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      <Field label="Allowed actions">
        <div className="space-y-1">
          {all.map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm text-[#5E6870]">
              <input type="checkbox" checked={perms.includes(p)}
                onChange={(e) => setPerms((s) => e.target.checked ? [...s, p] : s.filter((x) => x !== p))} />
              {p}
            </label>
          ))}
        </div>
      </Field>
      <Apply onClick={() => onApply(pw, perms)} label="Encrypt" />
    </Wrap>
  );
}

function UnlockPanel({ onApply }: { onApply: (pw: string) => void }) {
  const [pw, setPw] = useState("");
  return (
    <Wrap title="Remove password" hint="Decryption is performed by your backend.">
      <Field label="Current password"><input type="password" className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      <Apply onClick={() => onApply(pw)} label="Unlock" />
    </Wrap>
  );
}