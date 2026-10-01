/**
 * BranchedWorkflowEditor — visual editor for a v2 workflow definition.
 *
 * The Flow view is a top-to-bottom flowchart. Every If/Else or Switch FANS OUT into
 * side-by-side lanes (one per branch / case / else), each lane being its own vertical
 * chain, and the lanes re-join underneath:
 *
 *                 ▶ Submitted
 *                      │
 *                 ◇ If / Else
 *        ┌─────────────┼─────────────┐
 *   IF Amount<1,000  ELSE IF >20,000   ELSE
 *        │              │               │
 *      ✔ A1           ✔ A3            ✔ Fallback
 *      ✔ A2           ✔ A4               │
 *        └─────────────┼─────────────┘
 *                 ⚑ Completed
 *
 * Outcome model: approvals decide the outcome. Approve → next step; after the last one
 * the workflow is *Completed* as Approved. Reject → the workflow ends right there as
 * Rejected (later steps never run). Always. Return is a separate approver ACTION
 * (to the previous step or to the submitter), enabled per step in the step panel; it
 * pauses the workflow rather than completing it, so it is not a block in the graph.
 *
 * The step inspector for approval / notification blocks is *injected* via
 * `renderStepPanel` so the existing <StepEditPanel/> is reused untouched.
 */
import { Fragment, useMemo, useState, type ReactNode } from "react";
import {
  Plus, Trash2, GitBranch, Copy, ArrowUp, ArrowDown, Bell, CheckCircle2, Flag, Play,
  X, AlertCircle, Braces, Code2, FlaskConical, ListTree, Split, Clock, Users,
} from "lucide-react";
import clsx from "clsx";
import {
  type Block, type ApprovalBlock, type NotificationBlock, type IfElseBlock, type SwitchBlock,
  type SetValueBlock, type EndBlock, type ApproverAction, type ConditionGroup, type ConditionRule, type WorkflowField,
  type StepData, type Operator, type FieldType, type Issue, type ListKey,
  OPERATOR_META, OPERATORS_BY_TYPE,
  childLists, cloneBlock, collectFieldRefs, declaredVariables, describeGroup, editList, enumeratePaths,
  fieldMap, findBlock, listKey, moveInList, newEnd, newGroup, newIfElse, newRule, newSetValue,
  newSwitch, removeBlock, simulate, toPseudocode, availableActions, uid, updateBlock, validateDefinition, walk,
} from "@/lib/workflowGraph";

// ── Props ────────────────────────────────────────────────────────────────────
export interface BranchedWorkflowEditorProps {
  blocks: Block[];
  onChange: (blocks: Block[]) => void;
  /** System + form fields (see buildFieldCatalog in INTEGRATION.md). */
  fields: WorkflowField[];
  groups: { id: string; name: string }[];
  currencies: string[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  /** Blank step factories from the page (blankStep / blankNotificationStep). */
  makeApprovalStep: () => StepData;
  makeNotificationStep: () => StepData;
  /** Renders the existing StepEditPanel for the selected approval/notification block. */
  renderStepPanel: (args: {
    block: ApprovalBlock | NotificationBlock; index: number; total: number;
    onChange: (patch: Partial<StepData>) => void; onClose: () => void; onDelete: () => void;
  }) => ReactNode;
  /** Re-uses the page's per-step checks (name, group, recipients …). */
  validateStep?: (step: StepData) => string | null;
  /** rates[c] = value of 1 unit of c in a common base. Enables cross-currency conditions in the tester. */
  rates?: Record<string, number>;
}

const inp = "input";
const Lbl = ({ children }: { children: ReactNode }) => (
  <label className="block text-[11px] font-medium text-muted-foreground mb-1">{children}</label>
);

// ── Small field/value helpers ────────────────────────────────────────────────
function withGroupOptions(fields: WorkflowField[], groups: { id: string; name: string }[]): WorkflowField[] {
  const opts = groups.map((g) => ({ value: g.id, label: g.name }));
  return fields.map((f) => (!f.options && (f.type === "group" || f.id === "uploader.groups") ? { ...f, options: opts } : f));
}

const SOURCE_LABEL: Record<WorkflowField["source"], string> = { system: "Document", form: "Form fields", variable: "Variables" };

function FieldSelect({ value, fields, onChange, types, placeholder = "Select field…", className }: {
  value: string; fields: WorkflowField[]; onChange: (id: string) => void; types?: FieldType[]; placeholder?: string; className?: string;
}) {
  const usable = types ? fields.filter((f) => types.includes(f.type)) : fields;
  const orphan = value && !fields.some((f) => f.id === value);
  return (
    <select className={clsx(inp, className)} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">{placeholder}</option>
      {orphan && <option value={value}>⚠ {value} (missing)</option>}
      {(["form", "system", "variable"] as const).map((src) => {
        const list = usable.filter((f) => f.source === src);
        return list.length ? (
          <optgroup key={src} label={SOURCE_LABEL[src]}>
            {list.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </optgroup>
        ) : null;
      })}
    </select>
  );
}

/** Multi-value input: option chips when the field has options, else comma-separated text. */
function ListValueInput({ field, value, onChange }: { field?: WorkflowField; value: unknown; onChange: (v: string[]) => void }) {
  const arr = Array.isArray(value) ? value.map(String) : typeof value === "string" && value ? value.split(",").map((s) => s.trim()) : [];
  if (field?.options?.length) {
    return (
      <div className="flex flex-wrap gap-1.5">
        {field.options.map((o) => {
          const on = arr.includes(o.value);
          return (
            <button key={o.value} type="button"
              onClick={() => onChange(on ? arr.filter((x) => x !== o.value) : [...arr, o.value])}
              className={clsx("px-2 py-1 rounded-md text-[11px] border transition-colors",
                on ? "bg-accent/15 border-accent text-accent font-medium" : "border-border text-muted-foreground hover:border-foreground/30")}>
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }
  return (
    <input className={inp} placeholder="value1, value2, …" defaultValue={arr.join(", ")}
      key={`${field?.id}|${arr.join(",")}`}
      onBlur={(e) => onChange(e.target.value.split(",").map((s) => s.trim()).filter(Boolean))} />
  );
}

// ── Condition builder ────────────────────────────────────────────────────────
function RuleRow({ rule, fields, currencies, onChange, onRemove }: {
  rule: ConditionRule; fields: WorkflowField[]; currencies: string[];
  onChange: (r: ConditionRule) => void; onRemove: () => void;
}) {
  const field = fields.find((f) => f.id === rule.field_id);
  const type: FieldType = field?.type ?? "text";
  const ops = OPERATORS_BY_TYPE[type];
  const meta = OPERATOR_META[rule.op];
  const canRef = ["number", "money", "text", "date"].includes(type) && meta?.arity !== 0 && meta?.arity !== "list";
  const set = (patch: Partial<ConditionRule>) => onChange({ ...rule, ...patch });

  const scalar = (v: unknown, onV: (x: string | number) => void, ph = "") => {
    if (type === "number" || type === "money") {
      return <input type="number" step="any" className={inp} placeholder={ph || "0"} value={v === undefined || v === null ? "" : String(v)}
        onChange={(e) => onV(e.target.value === "" ? "" : Number(e.target.value))} />;
    }
    if (type === "date") {
      return rule.op === "within_last_days"
        ? <input type="number" min={1} className={inp} placeholder="days" value={String(v ?? "")} onChange={(e) => onV(Number(e.target.value))} />
        : <input type="date" className={inp} value={String(v ?? "")} onChange={(e) => onV(e.target.value)} />;
    }
    if (field?.options?.length) {
      return (
        <select className={inp} value={String(v ?? "")} onChange={(e) => onV(e.target.value)}>
          <option value="">Select…</option>
          {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    }
    return <input className={inp} placeholder={ph || "Value"} value={String(v ?? "")} onChange={(e) => onV(e.target.value)} />;
  };

  return (
    <div className="flex flex-wrap items-start gap-2 p-2 rounded-lg bg-muted/40 border border-border/60">
      <div className="w-44 min-w-[9rem]">
        <FieldSelect value={rule.field_id} fields={fields}
          onChange={(id) => {
            const nf = fields.find((f) => f.id === id);
            const nOps = OPERATORS_BY_TYPE[nf?.type ?? "text"];
            onChange({ ...rule, field_id: id, op: nOps.includes(rule.op) ? rule.op : nOps[0],
              value: undefined, value2: undefined, value_ref: undefined,
              currency: nf?.type === "money" ? (rule.currency || currencies[0]) : undefined });
          }} />
      </div>
      <div className="w-40 min-w-[8rem]">
        <select className={inp} value={rule.op} disabled={!rule.field_id}
          onChange={(e) => set({ op: e.target.value as Operator, value: undefined, value2: undefined })}>
          {ops.map((o) => <option key={o} value={o}>{OPERATOR_META[o].label}</option>)}
        </select>
      </div>

      {meta && meta.arity !== 0 && (
        <div className="flex-1 min-w-[10rem] flex flex-wrap items-center gap-2">
          {rule.value_ref !== undefined ? (
            <div className="flex-1 min-w-[9rem]">
              <FieldSelect value={rule.value_ref} fields={fields.filter((f) => f.id !== rule.field_id)} types={[type]}
                placeholder="Compare to field…" onChange={(id) => set({ value_ref: id })} />
            </div>
          ) : meta.arity === "list" ? (
            <div className="flex-1"><ListValueInput field={field} value={rule.value} onChange={(v) => set({ value: v })} /></div>
          ) : (
            <>
              <div className="flex-1 min-w-[7rem]">{scalar(rule.value, (v) => set({ value: v }))}</div>
              {meta.arity === 2 && (<><span className="text-[11px] text-muted-foreground">and</span>
                <div className="flex-1 min-w-[7rem]">{scalar(rule.value2, (v) => set({ value2: v }))}</div></>)}
            </>
          )}
          {type === "money" && rule.value_ref === undefined && (
            <select className={clsx(inp, "w-24")} value={rule.currency ?? ""} onChange={(e) => set({ currency: e.target.value })}>
              <option value="">Cur.</option>
              {currencies.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
          )}
          {canRef && (
            <button type="button" title={rule.value_ref !== undefined ? "Use a fixed value" : "Compare with another field"}
              onClick={() => rule.value_ref !== undefined ? set({ value_ref: undefined }) : set({ value_ref: "", value: undefined, value2: undefined })}
              className={clsx("px-2 py-1.5 rounded-md border text-[11px]",
                rule.value_ref !== undefined ? "border-accent text-accent bg-accent/10" : "border-border text-muted-foreground hover:text-foreground")}>
              ⇄ field
            </button>
          )}
        </div>
      )}
      <button type="button" onClick={onRemove} className="p-1.5 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive" title="Remove condition">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

function ConditionBuilder({ group, fields, currencies, onChange, onRemove, depth = 0 }: {
  group: ConditionGroup; fields: WorkflowField[]; currencies: string[];
  onChange: (g: ConditionGroup) => void; onRemove?: () => void; depth?: number;
}) {
  const setChild = (i: number, c: ConditionRule | ConditionGroup) =>
    onChange({ ...group, children: group.children.map((x, j) => (j === i ? c : x)) });
  const delChild = (i: number) => onChange({ ...group, children: group.children.filter((_, j) => j !== i) });
  return (
    <div className={clsx("rounded-xl border p-2.5 space-y-2", depth === 0 ? "border-border bg-card" : "border-dashed border-accent/40 bg-accent/5")}>
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[11px] text-muted-foreground">{group.negate ? "NOT — match" : "Match"}</span>
        <select className={clsx(inp, "w-28")} value={group.combinator}
          onChange={(e) => onChange({ ...group, combinator: e.target.value as "and" | "or" })}>
          <option value="and">ALL of</option>
          <option value="or">ANY of</option>
        </select>
        <label className="flex items-center gap-1 text-[11px] text-muted-foreground cursor-pointer">
          <input type="checkbox" checked={!!group.negate} onChange={(e) => onChange({ ...group, negate: e.target.checked })} /> invert (NOT)
        </label>
        {onRemove && (
          <button type="button" onClick={onRemove} className="ml-auto text-[11px] text-muted-foreground hover:text-destructive">Remove group</button>
        )}
      </div>
      {group.children.length === 0 && <p className="text-[11px] text-destructive">Add at least one condition — an empty condition never matches.</p>}
      {group.children.map((c, i) => c.kind === "group" ? (
        <ConditionBuilder key={c.id} group={c} fields={fields} currencies={currencies} depth={depth + 1}
          onChange={(g) => setChild(i, g)} onRemove={() => delChild(i)} />
      ) : (
        <RuleRow key={c.id} rule={c} fields={fields} currencies={currencies} onChange={(r) => setChild(i, r)} onRemove={() => delChild(i)} />
      ))}
      <div className="flex gap-2">
        <button type="button" className="text-[11px] font-medium text-accent hover:underline inline-flex items-center gap-1"
          onClick={() => onChange({ ...group, children: [...group.children, newRule()] })}>
          <Plus className="w-3 h-3" /> Condition
        </button>
        {depth < 3 && (
          <button type="button" className="text-[11px] font-medium text-accent hover:underline inline-flex items-center gap-1"
            onClick={() => onChange({ ...group, children: [...group.children, { ...newGroup("or"), children: [newRule()] }] })}>
            <Plus className="w-3 h-3" /> Group
          </button>
        )}
      </div>
    </div>
  );
}

// ── Inspectors (non-step blocks) ─────────────────────────────────────────────
function InspectorShell({ title, icon, onClose, children }: { title: string; icon: ReactNode; onClose: () => void; children: ReactNode }) {
  return (
    <div className="h-full flex flex-col">
      <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-2 text-sm font-semibold text-foreground">{icon}{title}</div>
        <button onClick={onClose} className="p-1 rounded hover:bg-muted"><X className="w-4 h-4 text-muted-foreground" /></button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 space-y-4">{children}</div>
    </div>
  );
}

function IfElseInspector({ block, fields, currencies, onChange, onClose }: {
  block: IfElseBlock; fields: WorkflowField[]; currencies: string[]; onChange: (b: IfElseBlock) => void; onClose: () => void;
}) {
  const move = (i: number, d: -1 | 1) => {
    const j = i + d; if (j < 0 || j >= block.branches.length) return;
    const br = [...block.branches]; [br[i], br[j]] = [br[j], br[i]]; onChange({ ...block, branches: br });
  };
  const fm = useMemo(() => fieldMap(fields), [fields]);
  return (
    <InspectorShell title="If / Else" icon={<GitBranch className="w-4 h-4 text-amber-600" />} onClose={onClose}>
      <div>
        <Lbl>Label (optional)</Lbl>
        <input className={inp} value={block.label ?? ""} placeholder="e.g. Approval level by amount" onChange={(e) => onChange({ ...block, label: e.target.value })} />
      </div>
      <p className="text-[11px] text-muted-foreground bg-muted/50 rounded-lg p-2.5">
        Branches are checked <b>top to bottom</b> and the <b>first match wins</b>. If none match, the <b>ELSE</b> path runs. Leave ELSE empty to simply <b>skip</b> — that is how you add an optional step (e.g. <i>add a Director if Amount &gt; 10,000</i>). Several separate If blocks in a row each decide independently, so their steps add up.
      </p>
      {block.branches.map((br, i) => (
        <div key={br.id} className="rounded-xl border border-border p-3 space-y-2.5">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-amber-100 text-amber-800">{i === 0 ? "IF" : "ELSE IF"}</span>
            <input className={clsx(inp, "flex-1")} placeholder="Branch label (optional)" value={br.label ?? ""}
              onChange={(e) => onChange({ ...block, branches: block.branches.map((x) => (x.id === br.id ? { ...x, label: e.target.value } : x)) })} />
            <button className="p-1 rounded hover:bg-muted disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} title="Move up"><ArrowUp className="w-3.5 h-3.5" /></button>
            <button className="p-1 rounded hover:bg-muted disabled:opacity-30" disabled={i === block.branches.length - 1} onClick={() => move(i, 1)} title="Move down"><ArrowDown className="w-3.5 h-3.5" /></button>
            <button className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-30" disabled={block.branches.length === 1}
              onClick={() => onChange({ ...block, branches: block.branches.filter((x) => x.id !== br.id) })} title="Delete branch"><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
          <ConditionBuilder group={br.when} fields={fields} currencies={currencies}
            onChange={(g) => onChange({ ...block, branches: block.branches.map((x) => (x.id === br.id ? { ...x, when: g } : x)) })} />
          <p className="text-[11px] text-muted-foreground">Reads as: <span className="text-foreground">{describeGroup(br.when, fm)}</span></p>
        </div>
      ))}
      <button className="btn-secondary text-xs" onClick={() => onChange({ ...block, branches: [...block.branches,
        { id: uid("br"), label: "", when: { ...newGroup(), children: [newRule()] }, blocks: [] }] })}>
        <Plus className="w-3.5 h-3.5" /> Add ELSE IF branch
      </button>
    </InspectorShell>
  );
}

function SwitchInspector({ block, fields, onChange, onClose }: {
  block: SwitchBlock; fields: WorkflowField[]; onChange: (b: SwitchBlock) => void; onClose: () => void;
}) {
  const field = fields.find((f) => f.id === block.field_id);
  const setCase = (id: string, patch: Partial<SwitchBlock["cases"][number]>) =>
    onChange({ ...block, cases: block.cases.map((c) => (c.id === id ? { ...c, ...patch } : c)) });
  return (
    <InspectorShell title="Switch" icon={<Split className="w-4 h-4 text-violet-600" />} onClose={onClose}>
      <div>
        <Lbl>Branch on field</Lbl>
        <FieldSelect value={block.field_id} fields={fields} types={["select", "text", "user", "group", "boolean", "multiselect"]}
          onChange={(id) => onChange({ ...block, field_id: id, cases: block.cases.map((c) => ({ ...c, values: [] })) })} />
        <p className="text-[11px] text-muted-foreground mt-1">Use a Switch when one field decides everything (department, phase, cost centre). For ranges or several fields, use If / Else.</p>
      </div>
      {block.cases.map((c, i) => (
        <div key={c.id} className="rounded-xl border border-border p-3 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold px-2 py-0.5 rounded bg-violet-100 text-violet-800">CASE {i + 1}</span>
            <input className={clsx(inp, "flex-1")} placeholder="Label (optional)" value={c.label ?? ""} onChange={(e) => setCase(c.id, { label: e.target.value })} />
            <button className="p-1 rounded hover:bg-destructive/10 text-muted-foreground hover:text-destructive disabled:opacity-30" disabled={block.cases.length === 1}
              onClick={() => onChange({ ...block, cases: block.cases.filter((x) => x.id !== c.id) })}><Trash2 className="w-3.5 h-3.5" /></button>
          </div>
          <Lbl>When the value is any of</Lbl>
          <ListValueInput field={field} value={c.values} onChange={(v) => setCase(c.id, { values: v })} />
        </div>
      ))}
      <button className="btn-secondary text-xs" onClick={() => onChange({ ...block, cases: [...block.cases, { id: uid("case"), label: "", values: [], blocks: [] }] })}>
        <Plus className="w-3.5 h-3.5" /> Add case
      </button>
    </InspectorShell>
  );
}

function SetValueInspector({ block, fields, onChange, onClose }: { block: SetValueBlock; fields: WorkflowField[]; onChange: (b: SetValueBlock) => void; onClose: () => void }) {
  return (
    <InspectorShell title="Set variable" icon={<Braces className="w-4 h-4 text-teal" />} onClose={onClose}>
      <div><Lbl>Variable name</Lbl>
        <input className={inp} value={block.variable} placeholder="e.g. risk_level" onChange={(e) => onChange({ ...block, variable: e.target.value })} /></div>
      <div><Lbl>Value</Lbl>
        {block.value_ref !== undefined ? (
          <FieldSelect value={block.value_ref} fields={fields} onChange={(id) => onChange({ ...block, value_ref: id })} />
        ) : (
          <input className={inp} value={String(block.value ?? "")} onChange={(e) => onChange({ ...block, value: e.target.value })} />
        )}
        <button className="text-[11px] text-accent mt-1 hover:underline"
          onClick={() => onChange(block.value_ref !== undefined ? { ...block, value_ref: undefined, value: "" } : { ...block, value_ref: "", value: undefined })}>
          {block.value_ref !== undefined ? "Use a fixed value" : "Copy from a field instead"}
        </button>
      </div>
      <p className="text-[11px] text-muted-foreground bg-muted/50 rounded-lg p-2.5">
        Later If / Else and Switch blocks can test this as <code>var.{block.variable || "name"}</code> — handy for deriving a value once (e.g. risk level) and branching on it in several places.
      </p>
    </InspectorShell>
  );
}

function EndInspector({ block, onChange, onClose }: { block: EndBlock; onChange: (b: EndBlock) => void; onClose: () => void }) {
  return (
    <InspectorShell title="Complete early" icon={<Flag className="w-4 h-4 text-primary" />} onClose={onClose}>
      <div><Lbl>Outcome</Lbl>
        <select className={inp} value={block.outcome} onChange={(e) => onChange({ ...block, outcome: e.target.value as EndBlock["outcome"] })}>
          <option value="approved">Approved automatically</option>
          <option value="rejected">Rejected automatically</option>
        </select></div>
      <div><Lbl>Reason (shown in the audit trail)</Lbl>
        <input className={inp} value={block.reason ?? ""} placeholder="e.g. Below auto-approval limit" onChange={(e) => onChange({ ...block, reason: e.target.value })} /></div>
      <p className="text-[11px] text-muted-foreground bg-muted/50 rounded-lg p-2.5">
        Completes the workflow on this path immediately with the outcome above; anything after it is skipped.
        Normally the outcome comes from the approval steps themselves — use this only to auto-approve or auto-reject without asking anyone.
      </p>
    </InspectorShell>
  );
}

// ── Test panel ───────────────────────────────────────────────────────────────
const OUTCOME_TEXT: Record<ReturnType<typeof simulate>["outcome"], string> = {
  pending_approvals: "Goes to approvers", auto_approved: "Completed · auto-approved", auto_rejected: "Completed · auto-rejected",
  no_approvers: "No approvers — fix this path", rejected: "Completed · Rejected", returned: "Returned — not completed",
};

function TestPanel({ fields, refs, values, setValues, currencies, result, groupName, actionOptions, act, setAct }: {
  fields: WorkflowField[]; refs: string[]; values: Record<string, any>; setValues: (v: Record<string, any>) => void;
  currencies: string[]; result: ReturnType<typeof simulate>; groupName: (id?: string | null) => string;
  /** Every approver action available on the current path — for the "what if" picker. value = "<blockId>|<action>". */
  actionOptions: { value: string; label: string }[]; act: string; setAct: (v: string) => void;
}) {
  const set = (id: string, v: unknown) => setValues({ ...values, [id]: v });
  const used = refs.map((id) => fields.find((f) => f.id === id)).filter(Boolean) as WorkflowField[];
  const badge = {
    pending_approvals: "bg-accent/15 text-accent", auto_approved: "bg-teal/15 text-teal",
    auto_rejected: "bg-destructive/10 text-destructive", no_approvers: "bg-amber-100 text-amber-800",
    rejected: "bg-destructive/10 text-destructive", returned: "bg-amber-100 text-amber-800",
  }[result.outcome];
  const outcomeText = OUTCOME_TEXT[result.outcome];
  const acted = result.acted;
  const returnedTo = acted && acted.action !== "reject"
    ? (acted.return_target === null || acted.return_target === undefined ? "the submitter" : `“${result.chain.find((c) => c.id === acted.return_target)?.step.name ?? "an earlier step"}”`) : null;
  return (
    <div className="h-full overflow-y-auto p-4 space-y-4">
      <div>
        <h3 className="text-sm font-semibold text-foreground flex items-center gap-2"><FlaskConical className="w-4 h-4" /> Test with sample data</h3>
        <p className="text-[11px] text-muted-foreground mt-1">Enter values a document might have. The path it takes is highlighted on the canvas.</p>
      </div>
      {used.length === 0 && <p className="text-xs text-muted-foreground">Add an If / Else or Switch block to test it.</p>}
      {used.map((f) => (
        <div key={f.id}>
          <Lbl>{f.label}</Lbl>
          {f.type === "money" ? (
            <div className="flex gap-2">
              <input type="number" className={inp} placeholder="0" value={values[f.id]?.amount ?? ""}
                onChange={(e) => set(f.id, { amount: e.target.value === "" ? "" : Number(e.target.value), currency: values[f.id]?.currency ?? currencies[0] })} />
              <select className={clsx(inp, "w-24")} value={values[f.id]?.currency ?? currencies[0]}
                onChange={(e) => set(f.id, { amount: values[f.id]?.amount ?? "", currency: e.target.value })}>
                {currencies.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
          ) : f.type === "number" ? (
            <input type="number" className={inp} value={values[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value === "" ? "" : Number(e.target.value))} />
          ) : f.type === "boolean" ? (
            <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={!!values[f.id]} onChange={(e) => set(f.id, e.target.checked)} /> Yes</label>
          ) : f.type === "date" ? (
            <input type="date" className={inp} value={values[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value)} />
          ) : f.type === "multiselect" ? (
            <ListValueInput field={f} value={values[f.id]} onChange={(v) => set(f.id, v)} />
          ) : f.options?.length ? (
            <select className={inp} value={values[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value)}>
              <option value="">(empty)</option>{f.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          ) : (
            <input className={inp} value={values[f.id] ?? ""} onChange={(e) => set(f.id, e.target.value)} />
          )}
        </div>
      ))}

      {actionOptions.length > 0 && (
        <div className="border-t border-border pt-4">
          <Lbl>What if an approver…</Lbl>
          <select className={inp} value={act} onChange={(e) => setAct(e.target.value)}>
            <option value="">Everyone approves</option>
            {actionOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
          <p className="text-[11px] text-muted-foreground mt-1">Reject ends the workflow as Rejected — later steps never run. Return sends the document back and pauses the workflow.</p>
        </div>
      )}

      <div className="border-t border-border pt-4 space-y-3">
        <span className={clsx("inline-block text-xs font-semibold px-2.5 py-1 rounded-full", badge)}>{outcomeText}</span>
        {result.chain.length > 0 && (
          <ol className="space-y-1.5">
            {result.chain.map((c, i) => (
              <li key={c.id} className="flex items-center gap-2 text-xs">
                <span className="w-5 h-5 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold">{i + 1}</span>
                <span className={clsx("font-medium", acted?.block_id === c.id ? (acted.action === "reject" ? "text-destructive" : "text-amber-700") : "text-foreground")}>{c.step.name || "Untitled"}</span>
                <span className="text-muted-foreground">{c.kind === "notification" ? "· notification" : `· ${groupName(c.step.assignee_group)}`}</span>
                {acted?.block_id === c.id && (acted.action === "reject"
                  ? <span className="text-destructive font-semibold">✕ rejected</span>
                  : <span className="text-amber-700 font-semibold">↩ returned</span>)}
              </li>
            ))}
          </ol>
        )}
        {acted && (
          <p className="text-[11px] text-muted-foreground">
            {acted.action === "reject" ? "The workflow ends here as Rejected; later steps do not run." : `It goes back to ${returnedTo}; the workflow is paused, not completed.`}
          </p>
        )}
        {result.decisions.length > 0 && (
          <div className="space-y-1">
            <p className="text-[11px] font-semibold text-muted-foreground uppercase tracking-wider">Why</p>
            {result.decisions.map((d) => (
              <p key={d.block_id} className="text-[11px] text-muted-foreground">
                {d.kind === "if_else" ? "IF" : "SWITCH"} → <span className="text-foreground font-medium">{d.matched_label}</span>
              </p>
            ))}
          </div>
        )}
        {result.warnings.map((w, i) => (
          <p key={i} className="text-[11px] text-amber-700 bg-amber-50 rounded-md p-2 flex gap-1.5"><AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />{w}</p>
        ))}
      </div>
    </div>
  );
}

// ── Main editor ──────────────────────────────────────────────────────────────
type ViewMode = "flow" | "code" | "paths";
type SidePanel = "inspect" | "test";

const CARD = "w-72"; // every node card and lane header share this width so lanes line up

export default function BranchedWorkflowEditor(props: BranchedWorkflowEditorProps) {
  const { blocks, onChange, groups, currencies, selectedId, onSelect, validateStep, rates } = props;
  const fields = useMemo(
    () => [...withGroupOptions(props.fields, groups), ...declaredVariables(blocks)],
    [props.fields, groups, blocks],
  );
  const fm = useMemo(() => fieldMap(fields), [fields]);
  const groupName = (id?: string | null) => groups.find((g) => g.id === id)?.name ?? (id ? "Unknown group" : "No group");

  const [view, setView] = useState<ViewMode>("flow");
  const [panel, setPanel] = useState<SidePanel>("inspect");
  const [menuAt, setMenuAt] = useState<string | null>(null);
  const [testValues, setTestValues] = useState<Record<string, any>>({});
  const [act, setAct] = useState("");
  const [showIssues, setShowIssues] = useState(false);
  const [zoom, setZoom] = useState(1);

  const issues = useMemo<Issue[]>(() => validateDefinition(blocks, fm, validateStep), [blocks, fm, validateStep]);
  const errors = issues.filter((i) => i.severity === "error");
  const issueByBlock = useMemo(() => {
    const m = new Map<string, Issue[]>();
    issues.forEach((i) => { if (i.block_id) m.set(i.block_id, [...(m.get(i.block_id) ?? []), i]); });
    return m;
  }, [issues]);

  // 1-based number for every approval/notification, in document order
  const ordinals = useMemo(() => {
    const m = new Map<string, number>(); let n = 0;
    walk(blocks, (b) => { if (b.kind === "approval" || b.kind === "notification") m.set(b.id, ++n); });
    return m;
  }, [blocks]);
  const testing = panel === "test";
  const simBase = useMemo(() => (testing ? simulate(blocks, fm, testValues, { rates }) : null), [testing, blocks, fm, testValues, rates]);
  /** Every approver action available on the path this sample takes (Return-to-previous only where an earlier approval exists). */
  const actionOptions = useMemo(() => {
    if (!simBase) return [];
    const out: { value: string; label: string }[] = [];
    let seenApproval = false;
    for (const c of simBase.chain) {
      if (c.kind !== "approval") continue;
      const nm = c.step.name || "Untitled";
      for (const a of availableActions(c.step, seenApproval))
        out.push({ value: `${c.id}|${a}`, label: `${nm}: ${a === "reject" ? "rejects" : a === "return_previous" ? "returns to previous step" : "returns to submitter"}` });
      seenApproval = true;
    }
    return out;
  }, [simBase]);
  const effAct = actionOptions.some((o) => o.value === act) ? act : "";
  const actAt = useMemo(() => { if (!effAct) return undefined; const [id, action] = effAct.split("|"); return { id, action: action as ApproverAction }; }, [effAct]);
  const sim = useMemo(
    () => (testing && actAt ? simulate(blocks, fm, testValues, { rates, actAt }) : simBase),
    [testing, actAt, blocks, fm, testValues, rates, simBase],
  );
  const refs = useMemo(() => collectFieldRefs(blocks), [blocks]);

  const selected = selectedId ? findBlock(blocks, selectedId) : null;
  const patch = (id: string, fn: (b: Block) => Block) => onChange(updateBlock(blocks, id, fn));
  const insert = (key: ListKey, index: number, block: Block) => {
    onChange(editList(blocks, key, (l) => [...l.slice(0, index), block, ...l.slice(index)]));
    setMenuAt(null); onSelect(block.id); setPanel("inspect");
  };
  const remove = (id: string) => { onChange(removeBlock(blocks, id)); if (selectedId === id) onSelect(null); };
  const duplicate = (key: ListKey, b: Block) => {
    const c = cloneBlock(b);
    onChange(editList(blocks, key, (l) => { const i = l.findIndex((x) => x.id === b.id); return [...l.slice(0, i + 1), c, ...l.slice(i + 1)]; }));
  };
  const move = (key: ListKey, id: string, dir: -1 | 1) => onChange(editList(blocks, key, (l) => moveInList(l, id, dir)));
  const makeBlock = (kind: string): Block => {
    switch (kind) {
      case "approval": return { kind: "approval", id: uid(), step: props.makeApprovalStep() };
      case "notification": return { kind: "notification", id: uid(), step: props.makeNotificationStep() };
      case "if_else": return newIfElse();
      case "switch": return newSwitch();
      case "set_value": return newSetValue();
      default: return newEnd(kind === "end_rejected" ? "rejected" : "approved");
    }
  };

  const MENU = [
    { k: "approval", t: "Approval step", d: "Someone must approve", i: <CheckCircle2 className="w-3.5 h-3.5" />, c: "bg-accent/15 text-accent" },
    { k: "notification", t: "Notification", d: "Send an email, auto-advance", i: <Bell className="w-3.5 h-3.5" />, c: "bg-sky-100 text-sky-600" },
    { k: "if_else", t: "If / Else", d: "Optional step, or branch by field", i: <GitBranch className="w-3.5 h-3.5" />, c: "bg-amber-100 text-amber-700" },
    { k: "switch", t: "Switch", d: "One field, many outcomes", i: <Split className="w-3.5 h-3.5" />, c: "bg-violet-100 text-violet-700" },
    { k: "set_value", t: "Set variable", d: "Derive a value to branch on", i: <Braces className="w-3.5 h-3.5" />, c: "bg-teal/15 text-teal" },
    { k: "end_approved", t: "Complete early", d: "Auto-approve / auto-reject", i: <Flag className="w-3.5 h-3.5" />, c: "bg-primary/10 text-primary" },
  ];

  const dim = (id: string) => !!sim && !sim.visited.has(id);

  // ── Flow rendering helpers (plain functions, not components, so nothing remounts on each keystroke) ──

  /** The "+" sitting on a connector line. `empty` = the lane has no blocks yet. */
  const insertPoint = (lk: ListKey, index: number, empty = false): ReactNode => {
    const id = `${lk}@${index}`;
    const open = menuAt === id;
    const menu = open && (
      <div className="absolute left-1/2 -translate-x-1/2 top-full z-30 mt-1 w-64 bg-card border border-border rounded-xl shadow-elegant overflow-hidden text-left" onClick={(e) => e.stopPropagation()}>
        {MENU.map((m, i) => (
          <button key={m.k} onClick={() => insert(lk, index, makeBlock(m.k))}
            className={clsx("w-full flex items-start gap-3 px-3 py-2 text-left hover:bg-muted/60", i > 0 && "border-t border-border")}>
            <span className={clsx("w-7 h-7 rounded-md flex items-center justify-center flex-shrink-0", m.c)}>{m.i}</span>
            <span><span className="block text-xs font-semibold text-foreground">{m.t}</span><span className="block text-[11px] text-muted-foreground">{m.d}</span></span>
          </button>
        ))}
      </div>
    );
    const toggle = (e: React.MouseEvent) => { e.stopPropagation(); setMenuAt(open ? null : id); };
    if (empty) {
      return (
        <div key={id} className={clsx("relative flex flex-col items-center", open && "z-30")}>
          <div className="w-px h-5 bg-border" />
          <button onClick={toggle} className="flex items-center gap-1 px-3 py-1 rounded-full border border-dashed border-border bg-card text-[11px] text-muted-foreground hover:text-accent hover:border-accent transition-colors">
            <Plus className="w-3 h-3" /> Add step
          </button>
          {menu}
        </div>
      );
    }
    return (
      <div key={id} className={clsx("relative h-8 w-full flex justify-center", open && "z-30")}>
        <div className="w-px h-full bg-border" />
        <button onClick={toggle} title="Add block here"
          className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-5 h-5 flex items-center justify-center rounded-full border border-dashed border-border bg-card text-muted-foreground hover:text-accent hover:border-accent transition-colors">
          <Plus className="w-3 h-3" />
        </button>
        {menu}
      </div>
    );
  };

  /** Hover toolbar: move / duplicate / delete. */
  const actions = (lk: ListKey, b: Block, index: number, count: number) => (
    <div className="absolute -top-3 right-2 z-10 hidden group-hover:flex items-center gap-0.5 rounded-md border border-border bg-card px-0.5 shadow-sm" onClick={(e) => e.stopPropagation()}>
      <button className="p-1 rounded hover:bg-muted disabled:opacity-30" disabled={index === 0} onClick={() => move(lk, b.id, -1)} title="Move up"><ArrowUp className="w-3 h-3" /></button>
      <button className="p-1 rounded hover:bg-muted disabled:opacity-30" disabled={index === count - 1} onClick={() => move(lk, b.id, 1)} title="Move down"><ArrowDown className="w-3 h-3" /></button>
      <button className="p-1 rounded hover:bg-muted" onClick={() => duplicate(lk, b)} title="Duplicate"><Copy className="w-3 h-3" /></button>
      <button className="p-1 rounded hover:bg-destructive/10 text-destructive" onClick={() => remove(b.id)} title="Delete"><Trash2 className="w-3 h-3" /></button>
    </div>
  );

  /** A vertical chain of blocks with "+" connectors between them. */
  const renderChain = (list: Block[], lk: ListKey): ReactNode => (
    <div className="flex flex-col items-center">
      {list.length === 0 ? insertPoint(lk, 0, true) : (
        <>
          {insertPoint(lk, 0)}
          {list.map((b, i) => (
            <Fragment key={b.id}>
              {renderBlock(b, lk, i, list.length)}
              {/* nothing can follow a trailing "Complete early" — the path stops there */}
              {!(b.kind === "end" && i === list.length - 1) && insertPoint(lk, i + 1)}
            </Fragment>
          ))}
        </>
      )}
    </div>
  );

  const renderBlock = (b: Block, lk: ListKey, index: number, count: number): ReactNode => {
    const isSel = selectedId === b.id;
    const bad = issueByBlock.get(b.id)?.some((x) => x.severity === "error");
    const click = (e: React.MouseEvent) => { e.stopPropagation(); onSelect(b.id); setPanel("inspect"); };
    const shell = (accent: string, extra?: string) => clsx(
      "group relative rounded-xl border-2 bg-card p-3 cursor-pointer transition-all shadow-sm hover:shadow-md", CARD,
      isSel ? `${accent} ring-4 ring-accent/10` : bad ? "border-destructive/50" : "border-border",
      dim(b.id) && "opacity-40", extra,
    );

    if (b.kind === "if_else" || b.kind === "switch") return renderBranch(b, lk, index, count, click);

    if (b.kind === "approval" || b.kind === "notification") {
      const n = ordinals.get(b.id) ?? 0;
      const s = b.step; const isN = b.kind === "notification";
      const actedHere = sim?.acted?.block_id === b.id ? sim.acted.action : null;
      return (
        <div className={clsx(shell(isN ? "border-sky-500" : "border-accent", isN ? "border-dashed" : undefined),
          actedHere === "reject" && "!border-destructive ring-4 ring-destructive/15", actedHere && actedHere !== "reject" && "!border-amber-500 ring-4 ring-amber-500/15")} onClick={click}>
          <div className="flex items-center gap-2">
            <span className={clsx("w-7 h-7 rounded-lg flex items-center justify-center text-white text-xs font-bold flex-shrink-0", isN ? "bg-sky-500" : "bg-accent")}>
              {isN ? <Bell className="w-3.5 h-3.5" /> : n}
            </span>
            <div className="min-w-0 flex-1">
              <p className={clsx("text-sm font-semibold truncate", s.name ? "text-foreground" : "text-muted-foreground italic")}>{s.name || "Click to configure"}</p>
              <p className="text-[11px] text-muted-foreground truncate flex items-center gap-1.5">
                {isN ? <>Email · {s.notify_user_name || s.notify_email || (s.notify_emails?.length ? `${s.notify_emails.length} recipients` : "no recipient")}</>
                  : <><Users className="w-3 h-3" />{s.assignee_group_name || groupName(s.assignee_group)}
                    {s.sla_hours ? <><Clock className="w-3 h-3 ml-1" />{s.sla_hours < 24 ? `${s.sla_hours}h` : `${Math.floor(s.sla_hours / 24)}d`}</> : null}</>}
              </p>
            </div>
            {bad && <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />}
          </div>

          {/* Approve → next. (Reject / Return are configured in the step panel, not drawn on the node.) */}
          {b.kind === "approval" && s.allow_approve !== false && (
            <div className="mt-2.5 pt-2 border-t border-dashed border-border text-[10px] font-medium">
              <span className="inline-flex items-center gap-1 text-teal"><span className="w-2 h-2 rounded-full bg-teal" />Approved → next</span>
            </div>
          )}
          {actions(lk, b, index, count)}
        </div>
      );
    }

    if (b.kind === "set_value" || b.kind === "end") {
      const isEnd = b.kind === "end";
      return (
        <div className={shell(isEnd ? "border-primary" : "border-teal")} onClick={click}>
          <div className="flex items-center gap-2">
            <span className={clsx("w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0", isEnd ? "bg-primary/10 text-primary" : "bg-teal/15 text-teal")}>
              {isEnd ? <Flag className="w-3.5 h-3.5" /> : <Braces className="w-3.5 h-3.5" />}
            </span>
            <p className="flex-1 min-w-0 text-sm text-foreground break-words">
              {isEnd ? <>Completed early · <b>{b.outcome === "approved" ? "Approved" : "Rejected"}</b>{b.reason ? <span className="text-muted-foreground"> — {b.reason}</span> : null}</>
                : <>Set <code className="text-xs">var.{b.variable || "?"}</code> = <b>{b.value_ref ? `[${fm.get(b.value_ref)?.label ?? b.value_ref}]` : String(b.value ?? "")}</b></>}
            </p>
            {bad && <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />}
          </div>
          {actions(lk, b, index, count)}
        </div>
      );
    }

    return null;
  };

  /** If/Else or Switch: header card, then one lane per branch side by side, re-joining below. */
  const renderBranch = (b: IfElseBlock | SwitchBlock, lk: ListKey, index: number, count: number, click: (e: React.MouseEvent) => void): ReactNode => {
    const isIf = b.kind === "if_else";
    const isSel = selectedId === b.id;
    const bad = issueByBlock.get(b.id)?.some((x) => x.severity === "error");
    const tone = isIf
      ? { bd: "border-amber-300", bg: "bg-amber-50/60", chip: "bg-amber-100 text-amber-800", pill: "border-amber-300 bg-amber-50" }
      : { bd: "border-violet-300", bg: "bg-violet-50/60", chip: "bg-violet-100 text-violet-800", pill: "border-violet-300 bg-violet-50" };
    const lists = childLists(b);
    const optional = isIf && (b as IfElseBlock).branches.length === 1 && (b as IfElseBlock).else_blocks.length === 0;   // stacked "add this step if…"
    const title = b.label || (optional ? `If ${describeGroup((b as IfElseBlock).branches[0].when, fm)}` : isIf ? "If / Else" : `Switch on ${fm.get((b as SwitchBlock).field_id)?.label ?? "…"}`);
    const sub = optional ? "optional · skipped when it doesn't match · click to edit" : isIf ? `${(b as IfElseBlock).branches.length} condition${(b as IfElseBlock).branches.length > 1 ? "s" : ""} + else · first match wins`
      : `${(b as SwitchBlock).cases.length} case${(b as SwitchBlock).cases.length > 1 ? "s" : ""} + default`;

    return (
      <div className="flex flex-col items-center">
        <div className={clsx("group relative rounded-xl border-2 p-3 cursor-pointer shadow-sm hover:shadow-md transition-all", CARD, tone.bd, tone.bg, isSel && "ring-4 ring-accent/10", bad && !isSel && "border-destructive/50", dim(b.id) && "opacity-40")} onClick={click}>
          <div className="flex items-center gap-2">
            {isIf ? <GitBranch className="w-4 h-4 text-amber-700 flex-shrink-0" /> : <Split className="w-4 h-4 text-violet-700 flex-shrink-0" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground truncate">{title}</p>
              <p className="text-[11px] text-muted-foreground truncate">{sub} · click to edit</p>
            </div>
            {bad && <AlertCircle className="w-4 h-4 text-destructive flex-shrink-0" />}
          </div>
          {actions(lk, b, index, count)}
        </div>
        <div className="w-px h-5 bg-border" />

        {/* Lanes */}
        <div className="flex items-stretch">
          {lists.map((cl, i) => {
            const n = lists.length;
            const taken = !!sim?.takenSlots.has(`${b.id}:${cl.slot}`);
            const endsInEnd = cl.blocks[cl.blocks.length - 1]?.kind === "end";   // that path stops; it doesn't rejoin
            const seg = i === 0 ? "left-1/2 right-0" : i === n - 1 ? "left-0 right-1/2" : "left-0 right-0";
            const line = taken ? "bg-accent" : "bg-border";

            let label = cl.label; let text: ReactNode;
            const skip = isIf && cl.slot === "else" && cl.blocks.length === 0;   // empty ELSE = "skip this block"
            if (isIf) {
              const br = (b as IfElseBlock).branches.find((x) => x.id === cl.slot);
              text = br ? <>{br.label ? <b>{br.label} — </b> : null}{describeGroup(br.when, fm)}</>
                : <span className="text-muted-foreground">{skip ? "no match → skip, continue" : "no earlier condition matched (fallback)"}</span>;
            } else {
              const c = (b as SwitchBlock).cases.find((x) => x.id === cl.slot);
              label = c ? "CASE" : "DEFAULT";
              text = c ? <>{c.label ? <b>{c.label} — </b> : null}{c.values.join(" | ") || <i className="text-muted-foreground">choose values</i>}</>
                : <span className="text-muted-foreground">any other value</span>;
            }
            return (
              <div key={cl.slot} className={clsx("relative flex flex-col items-center px-4 pt-5 pb-5", sim && !taken && "opacity-50")}>
                <div className={clsx("absolute top-0 h-px", seg, line)} />
                <div className={clsx("absolute top-0 left-1/2 w-px h-5", line)} />
                <div className={clsx("absolute bottom-0 h-px", seg, line)} />
                {!endsInEnd && <div className={clsx("absolute bottom-0 left-1/2 w-px h-5", line)} />}

                <div onClick={click} title="Edit conditions"
                  className={clsx("rounded-lg border px-3 py-1.5 text-center cursor-pointer", skip ? "w-44" : CARD, taken ? "border-accent bg-accent/10 ring-2 ring-accent/20" : tone.pill)}>
                  <span className={clsx("inline-block text-[10px] font-bold px-1.5 py-0.5 rounded", tone.chip)}>{label}{taken ? " ✓ taken" : ""}</span>
                  <p className="mt-1 text-[11px] leading-snug text-foreground break-words">{text}</p>
                </div>
                {renderChain(cl.blocks, listKey(b.id, cl.slot))}
              </div>
            );
          })}
        </div>
      </div>
    );
  };

  // ── Inspector ──
  const inspector = (): ReactNode => {
    if (!selected) {
      return (
        <div className="p-6 text-center text-xs text-muted-foreground space-y-2">
          <GitBranch className="w-6 h-6 mx-auto opacity-40" />
          <p>Select a block to edit it, or use <b>+</b> to add one.</p>
          <p>Use <b>If / Else</b> to send different documents down different approval chains — each branch gets its own lane.</p>
          <p>Rejecting ends the workflow as <b>Rejected</b>. Approvers who need changes use <b>Return</b> (to the previous step or the submitter), which you enable per step.</p>
        </div>
      );
    }
    const close = () => onSelect(null);
    if (selected.kind === "approval" || selected.kind === "notification") {
      return props.renderStepPanel({
        block: selected, index: (ordinals.get(selected.id) ?? 1) - 1, total: ordinals.size,
        onChange: (p) => patch(selected.id, (b) => (b.kind === "approval" || b.kind === "notification" ? { ...b, step: { ...b.step, ...p } } : b)),
        onClose: close, onDelete: () => remove(selected.id),
      });
    }
    if (selected.kind === "if_else") return <IfElseInspector block={selected} fields={fields} currencies={currencies} onChange={(nb) => patch(nb.id, () => nb)} onClose={close} />;
    if (selected.kind === "switch") return <SwitchInspector block={selected} fields={fields} onChange={(nb) => patch(nb.id, () => nb)} onClose={close} />;
    if (selected.kind === "set_value") return <SetValueInspector block={selected} fields={fields} onChange={(nb) => patch(nb.id, () => nb)} onClose={close} />;
    return <EndInspector block={selected} onChange={(nb) => patch(nb.id, () => nb)} onClose={close} />;
  };

  const code = useMemo(() => toPseudocode(blocks, fm, groupName), [blocks, fm, groups]); // eslint-disable-line react-hooks/exhaustive-deps
  const { paths, truncated } = useMemo(() => (view === "paths" ? enumeratePaths(blocks, fm) : { paths: [], truncated: false }), [view, blocks, fm]);

  const finalNote = !sim ? null
    : sim.outcome === "auto_approved" ? "Approved (auto)"
    : sim.outcome === "auto_rejected" ? "Rejected (auto)"
    : sim.outcome === "rejected" ? `Rejected at “${(findBlock(blocks, sim.acted!.block_id) as ApprovalBlock | null)?.step.name ?? "a step"}”`
    : sim.outcome === "returned" ? "Not completed — returned"
    : sim.outcome === "pending_approvals" ? "Approved once every step approves" : "No approvers on this path";
  const finalReached = !sim || (sim.outcome !== "returned");

  return (
    <div className="flex-1 min-h-0 flex gap-4" onClick={() => setMenuAt(null)}>
      {/* Canvas column */}
      <div className="flex-1 min-w-0 flex flex-col rounded-xl border border-border bg-muted/30 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card flex-shrink-0 flex-wrap">
          <div className="flex bg-muted rounded-lg p-0.5">
            {([["flow", "Flow", <GitBranch key="f" className="w-3.5 h-3.5" />], ["code", "Pseudocode", <Code2 key="c" className="w-3.5 h-3.5" />], ["paths", "All paths", <ListTree key="p" className="w-3.5 h-3.5" />]] as const).map(([k, l, ic]) => (
              <button key={k} onClick={() => setView(k)} className={clsx("px-2.5 py-1 text-xs font-medium rounded-md inline-flex items-center gap-1.5",
                view === k ? "bg-card shadow-sm text-foreground" : "text-muted-foreground hover:text-foreground")}>{ic}{l}</button>
            ))}
          </div>
          <button onClick={() => setPanel(testing ? "inspect" : "test")}
            className={clsx("px-2.5 py-1 text-xs font-medium rounded-md inline-flex items-center gap-1.5 border",
              testing ? "border-accent text-accent bg-accent/10" : "border-border text-muted-foreground hover:text-foreground")}>
            <FlaskConical className="w-3.5 h-3.5" /> Test
          </button>
          {view === "flow" && (
            <div className="flex items-center rounded-md border border-border text-xs text-muted-foreground">
              <button className="px-2 py-1 hover:text-foreground disabled:opacity-30" disabled={zoom <= 0.4} onClick={() => setZoom((z) => Math.max(0.4, +(z - 0.1).toFixed(2)))} title="Zoom out">−</button>
              <button className="px-1.5 py-1 w-11 hover:text-foreground tabular-nums" onClick={() => setZoom(1)} title="Reset zoom">{Math.round(zoom * 100)}%</button>
              <button className="px-2 py-1 hover:text-foreground disabled:opacity-30" disabled={zoom >= 1.4} onClick={() => setZoom((z) => Math.min(1.4, +(z + 0.1).toFixed(2)))} title="Zoom in">+</button>
            </div>
          )}
          <button onClick={() => setShowIssues((v) => !v)}
            className={clsx("ml-auto px-2.5 py-1 text-xs font-medium rounded-md inline-flex items-center gap-1.5",
              errors.length ? "bg-destructive/10 text-destructive" : issues.length ? "bg-amber-100 text-amber-800" : "bg-teal/15 text-teal")}>
            {errors.length ? <AlertCircle className="w-3.5 h-3.5" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
            {errors.length ? `${errors.length} error${errors.length > 1 ? "s" : ""}` : issues.length ? `${issues.length} warning${issues.length > 1 ? "s" : ""}` : "No issues"}
          </button>
        </div>

        {showIssues && issues.length > 0 && (
          <div className="max-h-40 overflow-y-auto border-b border-border bg-card px-3 py-2 space-y-1">
            {issues.map((i, k) => (
              <button key={k} onClick={() => { if (i.block_id) { onSelect(i.block_id); setPanel("inspect"); } }}
                className={clsx("w-full text-left text-[11px] flex gap-1.5", i.severity === "error" ? "text-destructive" : "text-amber-700")}>
                <AlertCircle className="w-3.5 h-3.5 flex-shrink-0" />{i.message}
              </button>
            ))}
          </div>
        )}

        <div className="flex-1 overflow-auto p-5" onClick={() => onSelect(null)}>
          {view === "flow" && (
            <div className="min-w-max mx-auto flex flex-col items-center pb-10" style={{ zoom }}>
              <div className={clsx("flex items-center gap-2 px-3 py-2 rounded-2xl border-2 border-teal/50 bg-card", CARD)}>
                <span className="w-7 h-7 rounded-lg bg-teal/15 flex items-center justify-center"><Play className="w-3.5 h-3.5 text-teal" /></span>
                <span className="text-xs font-semibold">Submitted</span>
              </div>
              {renderChain(blocks, "root")}
              <div className={clsx("rounded-2xl border-2 bg-card px-3 py-2.5", CARD,
                !sim ? "border-primary/40" : finalReached ? "border-primary ring-2 ring-accent/20" : "border-border opacity-50")}>
                <div className="flex items-center gap-2">
                  <span className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center"><Flag className="w-3.5 h-3.5 text-primary" /></span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-foreground">Completed</p>
                    {finalNote && <p className="text-[11px] font-medium text-accent">{finalNote}</p>}
                  </div>
                </div>
                <p className="mt-2 text-[10px] leading-snug text-muted-foreground">
                  The outcome comes from the approvals: <b className="text-teal">Approved</b> when every step approves,
                  {" "}<b className="text-destructive">Rejected</b> as soon as one rejects (later steps don't run). Approvers can also <b className="text-accent">Return</b> a document instead, which pauses it.
                </p>
              </div>
            </div>
          )}
          {view === "code" && (
            <div className="max-w-3xl mx-auto" onClick={(e) => e.stopPropagation()}>
              <div className="flex justify-end mb-2">
                <button className="btn-secondary text-xs" onClick={() => navigator.clipboard?.writeText(code)}><Copy className="w-3.5 h-3.5" /> Copy</button>
              </div>
              <pre className="text-xs leading-relaxed font-mono bg-card border border-border rounded-xl p-4 overflow-x-auto whitespace-pre">{code || "// empty workflow"}</pre>
            </div>
          )}
          {view === "paths" && (
            <div className="max-w-3xl mx-auto space-y-3" onClick={(e) => e.stopPropagation()}>
              <p className="text-xs text-muted-foreground">Every distinct route a document can take ({paths.length}{truncated ? "+" : ""}). If a route looks wrong or is missing, your conditions have a gap.</p>
              {paths.map((p, i) => {
                const bad = p.terminal === "complete" && !p.legs.some((l) => l.kind === "approval");
                return (
                  <div key={i} className={clsx("rounded-xl border bg-card p-3", bad ? "border-destructive/50" : "border-border")}>
                    <div className="flex flex-wrap gap-1.5 mb-2">
                      {p.conditions.length === 0 ? <span className="text-[11px] px-2 py-0.5 rounded bg-muted text-muted-foreground">Always</span>
                        : p.conditions.map((c, k) => <span key={k} className="text-[11px] px-2 py-0.5 rounded bg-amber-100 text-amber-900">{c}</span>)}
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-xs">
                      {p.legs.length === 0 && <span className="text-destructive">No steps</span>}
                      {p.legs.map((l, k) => (
                        <span key={k} className="inline-flex items-center gap-1.5">
                          {k > 0 && <span className="text-muted-foreground">→</span>}
                          <span className={clsx("px-2 py-0.5 rounded-md border", l.kind === "approval" ? "border-accent/40 bg-accent/10" : l.kind === "notification" ? "border-dashed border-sky-400 bg-sky-50" : "border-primary/40 bg-primary/10")}>{l.kind === "end" ? `Complete early: ${l.name}` : l.name}</span>
                        </span>
                      ))}
                      {p.terminal === "complete" && p.legs.length > 0 && (<><span className="text-muted-foreground">→</span><span className="px-2 py-0.5 rounded-md border border-primary/40 text-primary">Completed</span></>)}
                    </div>
                    {bad && <p className="text-[11px] text-destructive mt-2">This route finishes without any approval.</p>}
                  </div>
                );
              })}
              {truncated && <p className="text-xs text-amber-700">Showing the first {paths.length} routes only.</p>}
            </div>
          )}
        </div>
      </div>

      {/* Side panel — StepEditPanel is already a bordered 420px <aside>, so it renders unwrapped */}
      {testing && sim ? (
        <div className="w-[420px] flex-shrink-0 rounded-xl border border-border bg-card overflow-hidden">
          <TestPanel fields={fields} refs={refs} values={testValues} setValues={setTestValues} currencies={currencies} result={sim} groupName={groupName}
            actionOptions={actionOptions} act={effAct} setAct={setAct} />
        </div>
      ) : selected && (selected.kind === "approval" || selected.kind === "notification") ? (
        inspector()
      ) : (
        <div className="w-[420px] flex-shrink-0 rounded-xl border border-border bg-card overflow-hidden">{inspector()}</div>
      )}
    </div>
  );
}