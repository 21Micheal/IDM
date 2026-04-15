/**
 * WorkflowBuilderPage.tsx
 *
 * Architecture: each DocumentType owns exactly one WorkflowTemplate.
 *
 * Layout
 * ──────
 *  Left panel  — document types list. Clicking a type opens its template
 *                in the editor (or a "Create template" prompt if none exists).
 *  Right panel — three tabs:
 *    Steps   — drag-and-drop step builder
 *    Preview — live SVG flow diagram of the current steps
 *    Rules   — amount-threshold routing tiers
 *
 * Bug fix
 * ───────
 *  The previous 400 error was caused by sending `assignee_user_name`
 *  (a read-only SerializerMethodField) inside the nested steps payload.
 *  Fixed in serializers.py (WorkflowStepWriteSerializer) and here by
 *  using stepToPayload() which strips that field before every API call.
 */
import {
  useState, useCallback, useRef, useEffect, type DragEvent,
} from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { workflowAPI, documentTypesAPI, usersAPI } from "@/services/api";
import {
  Plus, GripVertical, Trash2, ChevronDown, ChevronUp,
  Save, GitBranch, Loader2, X, ArrowDown,
  Settings2, Eye, AlertCircle, Info, TriangleAlert,
  Clock, FileText, CheckCircle2,
} from "lucide-react";
import { toast } from "react-toastify";
import clsx from "clsx";

// ── Types ──────────────────────────────────────────────────────────────────────

interface StepDraft {
  _key:           string;
  id?:            string;
  name:           string;
  status_label:   string;
  assignee_type:  "any_role" | "specific_user";
  assignee_role:  string;
  assignee_user:  string | null;
  assignee_user_name?: string;  // READ ONLY — never sent to API
  sla_hours:      number;
  allow_resubmit: boolean;
  instructions:   string;
}

interface Template {
  id: string; name: string; description: string;
  is_active: boolean; steps: StepDraft[]; step_count: number;
}

interface DocType {
  id: string; name: string; code: string; reference_prefix: string;
  workflow_template: string | null;
}

interface Rule {
  id: string; document_type: string; document_type_name: string;
  template: string; template_name: string;
  amount_threshold: string; currency: string; label: string; is_active: boolean;
}

interface AppUser { id: string; full_name: string; email: string; role: string }

// ── Constants ──────────────────────────────────────────────────────────────────

const ROLES = [
  { value: "admin",   label: "Administrator" },
  { value: "finance", label: "Finance Staff"  },
  { value: "auditor", label: "Auditor"         },
  { value: "viewer",  label: "Viewer"           },
];
const CURRENCIES = ["USD","EUR","GBP","KES","ZAR","NGN","GHS","AED","INR"];
const STATUS_PRESETS = [
  "Pending Approval","Pending Finance Review","Pending Senior Review",
  "Pending Board Approval","Pending Legal Review","Awaiting Sign-off",
];
const ROLE_COLORS: Record<string,string> = {
  admin:"#6366f1", finance:"#0ea5e9", auditor:"#f59e0b", viewer:"#10b981",
};

function uid() { return Math.random().toString(36).slice(2,10); }

function blankStep(): StepDraft {
  return {
    _key:uid(), name:"", status_label:"Pending Approval",
    assignee_type:"any_role", assignee_role:"finance",
    assignee_user:null, sla_hours:48, allow_resubmit:true, instructions:"",
  };
}

/** Strip read-only and local fields before sending to API */
function stepToPayload(s: StepDraft) {
  const { _key, assignee_user_name, ...rest } = s;
  return rest;
}

// ── Shared primitives ──────────────────────────────────────────────────────────

const inp = "w-full px-3 py-2 text-sm bg-white border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-400 transition placeholder-slate-400";

function Label({ children, required }: { children: React.ReactNode; required?: boolean }) {
  return (
    <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wide mb-1.5">
      {children}{required && <span className="text-red-500 ml-0.5">*</span>}
    </label>
  );
}

function SlaBadge({ hours }: { hours: number }) {
  const color = hours<=24?"bg-red-50 text-red-600 border-red-200"
              : hours<=72?"bg-amber-50 text-amber-600 border-amber-200"
              :"bg-slate-100 text-slate-500 border-slate-200";
  const label = hours<24?`${hours}h`: hours%24===0?`${hours/24}d`:`${Math.floor(hours/24)}d ${hours%24}h`;
  return (
    <span className={clsx("inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full border",color)}>
      <Clock className="w-3 h-3"/>{label}
    </span>
  );
}

// ── SVG Flow Preview ───────────────────────────────────────────────────────────

function FlowPreview({ steps, name }: { steps: StepDraft[]; name: string }) {
  const NW=220,NH=80,GAP=52,PAD=28;
  const total = steps.length + 2;
  const svgH  = PAD*2 + total*NH + (total-1)*GAP;
  const svgW  = NW + PAD*2;
  const cx    = PAD + NW/2;
  const ny    = (i:number) => PAD + i*(NH+GAP);

  if (steps.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 text-slate-400 gap-3">
        <GitBranch className="w-10 h-10 opacity-20"/>
        <p className="text-sm">Add steps in the Steps tab to see the flow diagram.</p>
      </div>
    );
  }

  return (
    <div className="overflow-auto flex justify-center py-6">
      <svg width={svgW} height={svgH} viewBox={`0 0 ${svgW} ${svgH}`}
        style={{fontFamily:"system-ui,sans-serif"}}>
        <defs>
          <marker id="arr" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto">
            <path d="M0,0 L0,6 L8,3 z" fill="#cbd5e1"/>
          </marker>
          <filter id="sh"><feDropShadow dx="0" dy="2" stdDeviation="3" floodColor="#00000010"/></filter>
        </defs>

        {/* START */}
        {(()=>{const y=ny(0); return (
          <g>
            <rect x={PAD} y={y} width={NW} height={NH} rx={40}
              fill="#f0fdf4" stroke="#86efac" strokeWidth={1.5} filter="url(#sh)"/>
            <text x={cx} y={y+28} textAnchor="middle" fontSize={10} fill="#16a34a" fontWeight={700} letterSpacing={1.5}>START</text>
            <text x={cx} y={y+52} textAnchor="middle" fontSize={12} fill="#15803d" fontWeight={700}>Document Submitted</text>
            <line x1={cx} y1={y+NH} x2={cx} y2={y+NH+GAP} stroke="#cbd5e1" strokeWidth={1.5} strokeDasharray="4 3" markerEnd="url(#arr)"/>
          </g>
        );})()}

        {/* STEPS */}
        {steps.map((step,i)=>{
          const y = ny(i+1);
          const rc = ROLE_COLORS[step.assignee_role]??"#6366f1";
          const isLast = i===steps.length-1;
          const assigneeLabel = step.assignee_type==="any_role"
            ? (ROLES.find(r=>r.value===step.assignee_role)?.label ?? step.assignee_role)
            : (step.assignee_user_name ?? "Specific user");
          const stepName = step.name.length>22? step.name.slice(0,20)+"…":step.name;
          const statusLbl = step.status_label.length>22? step.status_label.slice(0,20)+"…":step.status_label;

          return (
            <g key={step._key}>
              <rect x={PAD} y={y} width={NW} height={NH} rx={10}
                fill="white" stroke={rc} strokeWidth={1.5} filter="url(#sh)"/>
              {/* colour stripe */}
              <rect x={PAD} y={y+10} width={4} height={NH-20} rx={2} fill={rc}/>
              {/* step badge */}
              <circle cx={PAD+24} cy={y+NH/2} r={13} fill={rc}/>
              <text x={PAD+24} y={y+NH/2+5} textAnchor="middle" fontSize={12} fill="white" fontWeight={800}>{i+1}</text>
              {/* name */}
              {step.name
                ? <text x={PAD+46} y={y+30} fontSize={13} fill="#1e293b" fontWeight={700}>{stepName}</text>
                : <text x={PAD+46} y={y+30} fontSize={12} fill="#94a3b8" fontStyle="italic">Unnamed step</text>}
              {/* assignee */}
              <text x={PAD+46} y={y+50} fontSize={10.5} fill="#64748b">{assigneeLabel}</text>
              {/* SLA */}
              <text x={PAD+NW-8} y={y+30} textAnchor="end" fontSize={10} fill="#94a3b8">SLA {step.sla_hours}h</text>
              {/* status label */}
              <text x={PAD+NW-8} y={y+50} textAnchor="end" fontSize={9.5} fill="#94a3b8" fontStyle="italic">{statusLbl}</text>
              {/* connector */}
              {!isLast && <line x1={cx} y1={y+NH} x2={cx} y2={y+NH+GAP}
                stroke="#cbd5e1" strokeWidth={1.5} strokeDasharray="4 3" markerEnd="url(#arr)"/>}
            </g>
          );
        })}

        {/* END */}
        {(()=>{const y=ny(steps.length+1); return (
          <g>
            <line x1={cx} y1={ny(steps.length)+NH} x2={cx} y2={y}
              stroke="#cbd5e1" strokeWidth={1.5} strokeDasharray="4 3" markerEnd="url(#arr)"/>
            <rect x={PAD} y={y} width={NW} height={NH} rx={40}
              fill="#eff6ff" stroke="#93c5fd" strokeWidth={1.5} filter="url(#sh)"/>
            <text x={cx} y={y+28} textAnchor="middle" fontSize={10} fill="#2563eb" fontWeight={700} letterSpacing={1.5}>END</text>
            <text x={cx} y={y+52} textAnchor="middle" fontSize={12} fill="#1d4ed8" fontWeight={700}>Document Approved</text>
          </g>
        );})()}
      </svg>
    </div>
  );
}

// ── StepCard ───────────────────────────────────────────────────────────────────

function StepCard({
  step,index,users,isDragOver,onChange,onRemove,
  onDragStart,onDragOver,onDragEnd,onDrop,
}:{
  step:StepDraft; index:number; users:AppUser[]; isDragOver:boolean;
  onChange:(p:Partial<StepDraft>)=>void; onRemove:()=>void;
  onDragStart:(e:DragEvent)=>void; onDragOver:(e:DragEvent)=>void;
  onDragEnd:(e:DragEvent)=>void; onDrop:(e:DragEvent)=>void;
}) {
  const [expanded,setExpanded] = useState(true);
  const rc = ROLE_COLORS[step.assignee_role]??"#6366f1";

  return (
    <div
      draggable onDragStart={onDragStart} onDragOver={onDragOver}
      onDragEnd={onDragEnd} onDrop={onDrop}
      className={clsx(
        "rounded-xl border transition-all bg-white overflow-hidden select-none",
        isDragOver?"border-indigo-400 ring-2 ring-indigo-200 shadow-lg":"border-slate-200 hover:border-slate-300 shadow-sm hover:shadow",
      )}
    >
      {/* Header */}
      <div className="flex items-center gap-2.5 px-4 py-3 bg-slate-50 border-b border-slate-100"
        style={{borderLeft:`4px solid ${rc}`}}>
        <span className="cursor-grab text-slate-300 hover:text-slate-500"><GripVertical className="w-4 h-4"/></span>
        <span className="w-6 h-6 rounded-full text-white text-xs font-bold flex items-center justify-center"
          style={{background:rc}}>{index+1}</span>
        <input value={step.name} onChange={e=>onChange({name:e.target.value})}
          className="flex-1 bg-transparent text-sm font-semibold text-slate-800 outline-none placeholder-slate-300 min-w-0"
          placeholder="Step name, e.g. Finance Manager Review"/>
        <SlaBadge hours={step.sla_hours}/>
        <div className="flex items-center gap-0.5 ml-1">
          <button onClick={()=>setExpanded(!expanded)}
            className="p-1.5 text-slate-400 hover:text-slate-600 rounded">
            {expanded?<ChevronUp className="w-3.5 h-3.5"/>:<ChevronDown className="w-3.5 h-3.5"/>}
          </button>
          <button onClick={onRemove} className="p-1.5 text-slate-300 hover:text-red-500 rounded">
            <Trash2 className="w-3.5 h-3.5"/>
          </button>
        </div>
      </div>

      {/* Body */}
      {expanded && (
        <div className="p-4 grid grid-cols-1 sm:grid-cols-2 gap-x-5 gap-y-4">
          <div className="sm:col-span-2">
            <Label>Document status while pending this step</Label>
            <input list={`sp-${step._key}`} value={step.status_label}
              onChange={e=>onChange({status_label:e.target.value})}
              className={inp} placeholder="e.g. Pending Finance Review"/>
            <datalist id={`sp-${step._key}`}>
              {STATUS_PRESETS.map(p=><option key={p} value={p}/>)}
            </datalist>
          </div>

          <div>
            <Label>Assign to</Label>
            <select value={step.assignee_type}
              onChange={e=>onChange({assignee_type:e.target.value as StepDraft["assignee_type"],assignee_role:"finance",assignee_user:null})}
              className={inp}>
              <option value="any_role">Any user with role</option>
              <option value="specific_user">Specific user</option>
            </select>
          </div>

          {step.assignee_type==="any_role"?(
            <div>
              <Label required>Role</Label>
              <select value={step.assignee_role} onChange={e=>onChange({assignee_role:e.target.value})} className={inp}>
                <option value="">— Select role —</option>
                {ROLES.map(r=><option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </div>
          ):(
            <div>
              <Label required>User</Label>
              <select value={step.assignee_user??""} onChange={e=>onChange({assignee_user:e.target.value||null})} className={inp}>
                <option value="">— Select user —</option>
                {users.map(u=><option key={u.id} value={u.id}>{u.full_name} · {u.role}</option>)}
              </select>
            </div>
          )}

          <div>
            <Label>SLA hours until escalation</Label>
            <div className="flex items-center gap-2">
              <input type="number" min={1} max={720} value={step.sla_hours}
                onChange={e=>onChange({sla_hours:Math.max(1,Number(e.target.value))})}
                className={clsx(inp,"w-24")}/>
              <span className="text-xs text-slate-400">= {Math.floor(step.sla_hours/24)}d {step.sla_hours%24}h</span>
            </div>
          </div>

          <div className="flex items-start gap-3 pt-4">
            <input type="checkbox" id={`rs-${step._key}`} checked={step.allow_resubmit}
              onChange={e=>onChange({allow_resubmit:e.target.checked})}
              className="mt-0.5 w-4 h-4 rounded border-slate-300 text-indigo-600"/>
            <label htmlFor={`rs-${step._key}`} className="text-sm text-slate-700 leading-snug cursor-pointer">
              Allow resubmission after rejection at this step
            </label>
          </div>

          <div className="sm:col-span-2">
            <Label>Approver instructions <span className="font-normal text-slate-400 normal-case">(optional)</span></Label>
            <textarea value={step.instructions} rows={2}
              onChange={e=>onChange({instructions:e.target.value})}
              className={inp} placeholder="What should the approver verify before actioning?"/>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Routing rules panel ────────────────────────────────────────────────────────

function RoutingRulesPanel({templateId,templateName}:{templateId:string;templateName:string}) {
  const qc = useQueryClient();
  const [showAdd,setShowAdd] = useState(false);
  const [form,setForm] = useState({document_type:"",amount_threshold:"0",currency:"USD",label:""});

  const {data:rules,isLoading} = useQuery<Rule[]>({
    queryKey:["workflow-rules",templateId],
    queryFn:()=>workflowAPI.listRules({template:templateId}).then(r=>r.data.results??r.data),
  });
  const {data:docTypes} = useQuery<DocType[]>({
    queryKey:["document-types"],
    queryFn:()=>documentTypesAPI.list().then(r=>r.data.results ?? r.data as DocType[]),
  });
  
  const createRule = useMutation({
    mutationFn:()=>workflowAPI.createRule({...form,template:templateId}),
    onSuccess:()=>{
      toast.success("Threshold tier created");
      qc.invalidateQueries({queryKey:["workflow-rules",templateId]});
      setShowAdd(false);
      setForm({document_type:"",amount_threshold:"0",currency:"USD",label:""});
    },
    onError:()=>toast.error("Failed to create tier"),
  });
  const deleteRule = useMutation({
    mutationFn:(id:string)=>workflowAPI.deleteRule(id),
    onSuccess:()=>{toast.success("Tier removed");qc.invalidateQueries({queryKey:["workflow-rules",templateId]});},
  });

  const grouped = (rules??[]).reduce<Record<string,Rule[]>>((acc,r)=>{
    const key=r.document_type_name??"Unknown";
    (acc[key]??=[]).push(r);
    return acc;
  },{});

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="font-semibold text-slate-800 text-sm">Amount-threshold tiers</h3>
          <p className="text-xs text-slate-500 mt-0.5 max-w-md">
            This template is the primary workflow for the document type. Add threshold tiers to
            escalate high-value documents to a different (senior) template automatically.
          </p>
        </div>
        <button onClick={()=>setShowAdd(true)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 transition-colors flex-shrink-0">
          <Plus className="w-3.5 h-3.5"/> Add tier
        </button>
      </div>

      <div className="flex items-start gap-2 p-3 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-700">
        <Info className="w-3.5 h-3.5 mt-0.5 flex-shrink-0"/>
        <span>Threshold 0 = catch-all. Higher thresholds are selected when document amount ≥ that value.</span>
      </div>

      {showAdd && (
        <div className="rounded-xl border-2 border-indigo-200 bg-indigo-50/40 p-4 space-y-3">
          <h4 className="text-sm font-semibold text-slate-800">New threshold tier</h4>
          <div className="grid grid-cols-2 gap-3">
            <div className="col-span-2">
              <Label required>Document type</Label>
              <select value={form.document_type} onChange={e=>setForm(f=>({...f,document_type:e.target.value}))} className={inp}>
                <option value="">— Select —</option>
                {docTypes?.map(dt=><option key={dt.id} value={dt.id}>{dt.name}</option>)}
              </select>
            </div>
            <div>
              <Label>Min. amount (≥)</Label>
              <input type="number" min={0} step="0.01" value={form.amount_threshold}
                onChange={e=>setForm(f=>({...f,amount_threshold:e.target.value}))}
                className={inp} placeholder="0 = catch-all"/>
            </div>
            <div>
              <Label>Currency</Label>
              <select value={form.currency} onChange={e=>setForm(f=>({...f,currency:e.target.value}))} className={inp}>
                {CURRENCIES.map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="col-span-2">
              <Label>Label</Label>
              <input value={form.label} onChange={e=>setForm(f=>({...f,label:e.target.value}))}
                className={inp} placeholder="e.g. Standard, High-value, Board-level"/>
            </div>
          </div>
          <div className="flex gap-2">
            <button onClick={()=>createRule.mutate()} disabled={!form.document_type||createRule.isPending}
              className="flex items-center gap-1.5 px-4 py-2 text-xs font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors">
              {createRule.isPending&&<Loader2 className="w-3 h-3 animate-spin"/>} Save tier
            </button>
            <button onClick={()=>setShowAdd(false)} className="px-4 py-2 text-xs font-medium text-slate-600 bg-white border border-slate-200 rounded-lg hover:bg-slate-50 transition-colors">
              Cancel
            </button>
          </div>
        </div>
      )}

      {isLoading&&<div className="space-y-2">{[1,2].map(i=><div key={i} className="h-14 bg-slate-100 rounded-lg animate-pulse"/>)}</div>}

      {!isLoading&&Object.keys(grouped).length===0&&!showAdd&&(
        <div className="text-center py-10 text-slate-400">
          <AlertCircle className="w-7 h-7 mx-auto mb-2 opacity-30"/>
          <p className="text-sm">No threshold tiers yet.</p>
        </div>
      )}

      {Object.entries(grouped).map(([dtName,dtRules])=>{
        const sorted=[...dtRules].sort((a,b)=>Number(a.amount_threshold)-Number(b.amount_threshold));
        return (
          <div key={dtName} className="space-y-1.5">
            <p className="text-xs font-semibold text-slate-500 uppercase tracking-widest">{dtName}</p>
            {sorted.map((rule,idx)=>{
              const t=Number(rule.amount_threshold);
              const next=sorted[idx+1];
              return (
                <div key={rule.id} className="flex items-center gap-3 px-4 py-3 rounded-xl border border-slate-100 bg-white hover:border-slate-200 group">
                  <div className={clsx("w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold",
                    t===0?"bg-slate-100 text-slate-500":"bg-indigo-50 text-indigo-600")}>{idx+1}</div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-slate-800">
                      {rule.label||(t===0?"Default (catch-all)":`Tier ${idx+1}: ≥ ${t.toLocaleString()} ${rule.currency}`)}
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {t===0?"Applies when no higher threshold matches"
                        :next?`${t.toLocaleString()} – ${(Number(next.amount_threshold)-0.01).toLocaleString()} ${rule.currency}`
                        :`≥ ${t.toLocaleString()} ${rule.currency}`}
                    </p>
                  </div>
                  <button onClick={()=>deleteRule.mutate(rule.id)} disabled={deleteRule.isPending}
                    className="opacity-0 group-hover:opacity-100 p-1.5 text-slate-300 hover:text-red-400 rounded">
                    <X className="w-4 h-4"/>
                  </button>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ── Template editor ────────────────────────────────────────────────────────────

function TemplateEditor({template,docType,onSaved}:{
  template:Template|null; docType:DocType; onSaved:(t:Template,isNew:boolean)=>void;
}) {
  const qc = useQueryClient();
  const [name,setName]   = useState(template?.name??`${docType.name} Approval`);
  const [desc,setDesc]   = useState(template?.description??"");
  const [steps,setSteps] = useState<StepDraft[]>(
    ()=>template?.steps?.map(s=>({...s,_key:uid()}))??[]
  );
  const [activeTab,setTab] = useState<"steps"|"preview"|"rules">("steps");
  const [isDirty,setDirty] = useState(!template);

  const dragIdx = useRef<number|null>(null);
  const overIdx = useRef<number|null>(null);
  const [dragOver,setDragOver] = useState<number|null>(null);

  const {data:users} = useQuery<AppUser[]>({
    queryKey:["users-all"],
    queryFn:()=>usersAPI.list({page_size:200}).then(r=>r.data.results??r.data),
  });

  const reorderMutation = useMutation({
    mutationFn:(ids:string[])=>workflowAPI.reorderSteps(template!.id,ids),
    onError:()=>toast.error("Could not persist step order — please re-save."),
  });

  const saveMutation = useMutation({
    mutationFn:(payload:object)=>
      template ? workflowAPI.updateTemplate(template.id,payload) : workflowAPI.createTemplate(payload),
    onSuccess:async ({data})=>{
      toast.success(template?"Template saved":"Template created");
      setDirty(false);
      if(!template){
        try {
          await documentTypesAPI.update(docType.id,{workflow_template:data.id});
        } catch {
          toast.warning("Template created but could not link to document type");
        }
      }
      qc.invalidateQueries({queryKey:["workflow-templates"]});
      qc.invalidateQueries({queryKey:["document-types"]});
      onSaved(data, !template);
    },
    onError:(err:{response?:{data?:Record<string,string[]>}})=>{
      const first=Object.values(err?.response?.data??{}).flat()[0];
      toast.error(first??"Save failed");
    },
  });

  const patchStep = useCallback((i:number,patch:Partial<StepDraft>)=>{
    setSteps(p=>{const n=[...p];n[i]={...n[i],...patch};return n;});
    setDirty(true);
  },[]);

  const addStep    = ()=>{setSteps(p=>[...p,blankStep()]);setDirty(true);};
  const removeStep = (i:number)=>{setSteps(p=>p.filter((_,j)=>j!==i));setDirty(true);};

  const handleDragStart = (i:number)=>(e:DragEvent)=>{
    dragIdx.current=i; e.dataTransfer.effectAllowed="move";
    setTimeout(()=>setDragOver(i),0);
  };
  const handleDragOver = (i:number)=>(e:DragEvent)=>{
    e.preventDefault(); e.dataTransfer.dropEffect="move";
    if(overIdx.current!==i){overIdx.current=i;setDragOver(i);}
  };
  const handleDragEnd = ()=>{dragIdx.current=null;overIdx.current=null;setDragOver(null);};
  const handleDrop = (targetIdx:number)=>(e:DragEvent)=>{
    e.preventDefault();
    const from=dragIdx.current;
    if(from===null||from===targetIdx){handleDragEnd();return;}
    setSteps(prev=>{
      const next=[...prev];
      const [item]=next.splice(from,1);
      next.splice(targetIdx,0,item);
      if(template){
        const ids=next.filter(s=>s.id).map(s=>s.id!);
        if(ids.length===next.length) reorderMutation.mutate(ids);
      }
      return next;
    });
    setDirty(true);
    handleDragEnd();
  };

  const handleSave = ()=>{
    if(!name.trim()){toast.error("Template name is required");return;}
    if(steps.length===0){toast.error("Add at least one approval step");return;}
    for(const s of steps){
      if(!s.name.trim()){toast.error("All steps need a name");return;}
      if(s.assignee_type==="any_role"&&!s.assignee_role){toast.error(`"${s.name}" needs a role`);return;}
      if(s.assignee_type==="specific_user"&&!s.assignee_user){toast.error(`"${s.name}" needs a user`);return;}
    }
    saveMutation.mutate({name:name.trim(),description:desc.trim(),steps:steps.map(stepToPayload)});
  };

  const TABS=[
    {id:"steps",   label:`Steps (${steps.length})`, Icon:GitBranch},
    {id:"preview", label:"Flow preview",             Icon:Eye      },
    ...(template?[{id:"rules",label:"Threshold tiers",Icon:Settings2}]:[]),
  ] as {id:string;label:string;Icon:React.ElementType}[];

  return (
    <div className="flex flex-col h-full min-h-0">
      {isDirty&&(
        <div className="flex items-center gap-2 px-3 py-2 mb-3 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700 flex-shrink-0">
          <TriangleAlert className="w-3.5 h-3.5"/>Unsaved changes
        </div>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-4 pb-4 border-b border-slate-200 mb-4 flex-shrink-0">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <div className="mt-1 w-9 h-9 rounded-lg bg-indigo-50 border border-indigo-100 flex items-center justify-center flex-shrink-0">
            <FileText className="w-4 h-4 text-indigo-600"/>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-xs text-slate-400 font-medium mb-0.5">{docType.name}</p>
            <input value={name} onChange={e=>{setName(e.target.value);setDirty(true);}}
              className="w-full text-base font-bold text-slate-900 bg-transparent border-0 outline-none placeholder-slate-300"
              placeholder="Template name…"/>
            <input value={desc} onChange={e=>{setDesc(e.target.value);setDirty(true);}}
              className="w-full text-sm text-slate-400 bg-transparent border-0 outline-none placeholder-slate-300"
              placeholder="Short description (optional)"/>
          </div>
        </div>
        <button onClick={handleSave}
          disabled={saveMutation.isPending||(!isDirty&&!!template)}
          className="flex items-center gap-2 px-4 py-2 text-sm font-medium bg-indigo-600 text-white rounded-lg hover:bg-indigo-700 disabled:opacity-50 transition-colors flex-shrink-0">
          {saveMutation.isPending?<Loader2 className="w-4 h-4 animate-spin"/>:<Save className="w-4 h-4"/>}
          {template?"Save":"Create"}
        </button>
      </div>

      {/* Tabs */}
      <div className="border-b border-slate-200 mb-4 flex gap-0 flex-shrink-0">
        {TABS.map(({id,label,Icon})=>(
          <button key={id} onClick={()=>setTab(id as typeof activeTab)}
            className={clsx("flex items-center gap-1.5 px-4 py-2.5 text-sm font-medium border-b-2 transition-colors",
              activeTab===id?"border-indigo-500 text-indigo-600":"border-transparent text-slate-500 hover:text-slate-700")}>
            <Icon className="w-3.5 h-3.5"/>{label}
          </button>
        ))}
      </div>

      {/* Tab: Steps */}
      {activeTab==="steps"&&(
        <div className="flex-1 overflow-y-auto pr-1 space-y-2.5 min-h-0">
          {steps.length===0&&(
            <div className="flex flex-col items-center justify-center py-16 text-slate-400 gap-3">
              <GitBranch className="w-10 h-10 opacity-20"/>
              <p className="text-sm font-medium text-slate-500">No steps yet</p>
              <p className="text-xs">Define the approval chain for {docType.name} documents.</p>
            </div>
          )}
          {steps.map((step,i)=>(
            <div key={step._key}>
              <StepCard step={step} index={i} users={users??[]} isDragOver={dragOver===i}
                onChange={p=>patchStep(i,p)} onRemove={()=>removeStep(i)}
                onDragStart={handleDragStart(i)} onDragOver={handleDragOver(i)}
                onDragEnd={handleDragEnd} onDrop={handleDrop(i)}/>
              {i<steps.length-1&&(
                <div className="flex justify-center py-0.5">
                  <ArrowDown className="w-4 h-4 text-slate-300"/>
                </div>
              )}
            </div>
          ))}
          <button onClick={addStep}
            className="w-full mt-1 border-2 border-dashed border-slate-200 rounded-xl py-4 text-sm text-slate-400 hover:border-indigo-300 hover:text-indigo-500 hover:bg-indigo-50/40 flex items-center justify-center gap-2 transition-all">
            <Plus className="w-4 h-4"/> Add approval step
          </button>
          {steps.length>0&&(
            <p className="text-center text-xs text-slate-400 pb-2">
              {steps.length} step{steps.length!==1?"s":""} · Drag <GripVertical className="inline w-3 h-3"/> to reorder
            </p>
          )}
        </div>
      )}

      {/* Tab: Preview */}
      {activeTab==="preview"&&(
        <div className="flex-1 overflow-y-auto min-h-0 bg-slate-50 rounded-xl border border-slate-100">
          <div className="p-4 border-b border-slate-100 bg-white rounded-t-xl flex items-center justify-between flex-wrap gap-3">
            <div>
              <p className="text-sm font-semibold text-slate-800">{name||"Untitled template"}</p>
              <p className="text-xs text-slate-400 mt-0.5">{docType.name} · {steps.length} step{steps.length!==1?"s":""}</p>
            </div>
            <div className="flex items-center gap-3 flex-wrap">
              {ROLES.map(r=>(
                <span key={r.value} className="flex items-center gap-1.5 text-xs text-slate-500">
                  <span className="w-2.5 h-2.5 rounded-full" style={{background:ROLE_COLORS[r.value]}}/>
                  {r.label}
                </span>
              ))}
            </div>
          </div>
          <FlowPreview steps={steps} name={name}/>
        </div>
      )}

      {/* Tab: Rules */}
      {activeTab==="rules"&&template&&(
        <div className="flex-1 overflow-y-auto min-h-0">
          <RoutingRulesPanel templateId={template.id} templateName={template.name}/>
        </div>
      )}
    </div>
  );
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function WorkflowBuilderPage() {
  const qc = useQueryClient();
  const [selectedDocType,setSelectedDocType] = useState<DocType|null>(null);
  const [activeTemplate, setActiveTemplate]  = useState<Template|null>(null);
  const [search,setSearch] = useState("");

  const {data:docTypes,isLoading:dtLoading} = useQuery<DocType[]>({
    queryKey:["document-types"],
    queryFn:()=>documentTypesAPI.list().then(r=>r.data.results??r.data as DocType[]),
  });

  const {data:selectedTemplate, isFetching:selectedTemplateLoading} = useQuery<Template | null>({
    queryKey:["workflow-template", selectedDocType?.workflow_template],
    queryFn: async () => {
      if (!selectedDocType?.workflow_template) return null;
      const response = await workflowAPI.getTemplate(selectedDocType.workflow_template);
      return response.data;
    },
    enabled: !!selectedDocType?.workflow_template,
    staleTime: 1000 * 60 * 5,
  });

  const [savedConfirmation, setSavedConfirmation] = useState<{ docTypeName: string; templateName: string } | null>(null);

  const handleDocTypeClick = (dt:DocType)=>{
    setSelectedDocType(dt);
    setSavedConfirmation(null);
    setActiveTemplate(null);
  };

  useEffect(() => {
    if (selectedTemplate === undefined) return;
    setActiveTemplate(selectedTemplate);
  }, [selectedTemplate]);

  const handleSaved = (t:Template, isNew: boolean)=>{
    if (selectedDocType) {
      const updatedType = { ...selectedDocType, workflow_template: t.id };
      if (isNew) {
        setSavedConfirmation({ docTypeName: selectedDocType.name, templateName: t.name });
        setSelectedDocType(null);
        setActiveTemplate(null);
      } else {
        setSelectedDocType(updatedType);
        setActiveTemplate(t);
      }
    }
    qc.invalidateQueries({queryKey:["document-types"]});
    qc.invalidateQueries({queryKey:["workflow-templates"]});
  };

  const docTypesArray = Array.isArray(docTypes) ? docTypes : [];
  const filtered = docTypesArray.filter(dt=>dt.name.toLowerCase().includes(search.toLowerCase()));
  const withTemplate    = docTypesArray.filter(d=>d.workflow_template).length;
  const withoutTemplate = docTypesArray.length - withTemplate;

  return (
    <div className="flex gap-5 h-[calc(100vh-7rem)] min-h-0">

      {/* Left: document type list */}
      <aside className="w-72 flex-shrink-0 flex flex-col gap-3 min-h-0">
        <div>
          <h1 className="text-base font-bold text-slate-900">Workflow Builder</h1>
          <p className="text-xs text-slate-400 mt-0.5">
            {withTemplate} / {docTypesArray.length} types configured
          </p>
        </div>

        {docTypesArray.length>0&&(
          <div className="flex rounded-lg overflow-hidden border border-slate-200 text-xs">
            <div className="flex-1 flex items-center gap-1.5 px-3 py-2 bg-green-50">
              <CheckCircle2 className="w-3 h-3 text-green-500"/>
              <span className="text-green-700 font-medium">{withTemplate} ready</span>
            </div>
            <div className="flex-1 flex items-center gap-1.5 px-3 py-2 bg-amber-50 border-l border-slate-200">
              <AlertCircle className="w-3 h-3 text-amber-500"/>
              <span className="text-amber-700 font-medium">{withoutTemplate} pending</span>
            </div>
          </div>
        )}

        <input value={search} onChange={e=>setSearch(e.target.value)}
          placeholder="Search document types…"
          className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-500/40 bg-white placeholder-slate-400"/>

        <div className="flex-1 overflow-y-auto space-y-1 min-h-0">
          {dtLoading&&Array.from({length:5}).map((_,i)=>(
            <div key={i} className="h-16 bg-slate-100 rounded-xl animate-pulse"/>
          ))}
          {filtered.map(dt=>{
            const hasTemplate=!!dt.workflow_template;
            const isSelected=selectedDocType?.id===dt.id;
            return (
              <button key={dt.id} onClick={()=>handleDocTypeClick(dt)}
                className={clsx("w-full text-left rounded-xl px-3.5 py-3 transition-all border",
                  isSelected?"bg-indigo-50 border-indigo-200 shadow-sm"
                  :"bg-white border-slate-100 hover:border-slate-200 hover:bg-slate-50")}>
                <div className="flex items-start gap-2.5">
                  <div className={clsx("w-2 h-2 rounded-full flex-shrink-0 mt-2",
                    hasTemplate?"bg-green-400":"bg-amber-400")}/>
                  <div className="flex-1 min-w-0">
                    <p className={clsx("font-semibold text-sm truncate",
                      isSelected?"text-indigo-700":"text-slate-800")}>{dt.name}</p>
                    <p className="text-xs text-slate-400 mt-0.5">
                      {dt.reference_prefix}-XXXXX · {hasTemplate?"Template assigned":"No template"}
                    </p>
                  </div>
                  {!hasTemplate&&<span className="text-xs text-amber-500 font-medium flex-shrink-0 mt-0.5">Setup</span>}
                </div>
              </button>
            );
          })}
          {!dtLoading&&filtered.length===0&&(
            <div className="text-center py-10 text-slate-400">
              <FileText className="w-7 h-7 mx-auto mb-2 opacity-20"/>
              <p className="text-xs">{search?"No matches.":"No document types found."}</p>
            </div>
          )}
        </div>
      </aside>

      {/* Right: editor */}
      <main className="flex-1 min-w-0 bg-white rounded-2xl border border-slate-200 p-6 overflow-hidden flex flex-col shadow-sm">
        {!selectedDocType&&savedConfirmation&&(
          <div className="flex-1 flex flex-col items-center justify-center text-center gap-4 text-slate-600">
            <div className="w-16 h-16 rounded-2xl bg-green-50 border border-green-100 flex items-center justify-center">
              <CheckCircle2 className="w-8 h-8 text-green-600"/>
            </div>
            <div>
              <p className="font-semibold text-slate-900">Workflow template saved</p>
              <p className="text-sm text-slate-500 mt-1">
                {savedConfirmation.templateName} is now assigned to {savedConfirmation.docTypeName}.
              </p>
            </div>
            <button
              onClick={()=>setSavedConfirmation(null)}
              className="btn-primary"
            >
              Continue
            </button>
          </div>
        )}
        {!selectedDocType&&!savedConfirmation&&(
          <div className="flex-1 flex flex-col items-center justify-center text-center text-slate-400 gap-4">
            <div className="w-16 h-16 rounded-2xl bg-slate-100 flex items-center justify-center">
              <GitBranch className="w-8 h-8 opacity-25"/>
            </div>
            <div>
              <p className="font-semibold text-slate-600 text-sm">Select a document type</p>
              <p className="text-xs text-slate-400 mt-1">
                Each document type has its own approval workflow template.
              </p>
            </div>
            {withoutTemplate>0&&(
              <div className="flex items-center gap-2 px-4 py-2.5 bg-amber-50 border border-amber-200 rounded-lg text-xs text-amber-700">
                <TriangleAlert className="w-3.5 h-3.5"/>
                {withoutTemplate} type{withoutTemplate!==1?"s":""} still need{withoutTemplate===1?"s":""} a workflow template
              </div>
            )}
          </div>
        )}
        {selectedDocType&&(
          <TemplateEditor
            key={selectedDocType.id}
            docType={selectedDocType}
            template={activeTemplate}
            onSaved={handleSaved}
          />
        )}
      </main>
    </div>
  );
}