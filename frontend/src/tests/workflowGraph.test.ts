import * as W from "../lib/workflowGraph";
import assert from "node:assert/strict";

const fields = W.fieldMap([
  ...W.SYSTEM_FIELDS,
  { id: "f_dept", label: "Department", type: "select", source: "form", options: [{ value: "IT", label: "IT" }, { value: "HR", label: "HR" }] },
  { id: "f_urgent", label: "Urgent", type: "boolean", source: "form" },
]);
const approval = (name: string, group = "g1"): W.Block => ({ kind: "approval", id: W.uid(), step: { name, step_type: "approval", assignee_group: group, assignee_type: "group_any", sla_hours: 24, allow_approve: true } });
const rule = (op: W.Operator, value: any, extra: Partial<W.ConditionRule> = {}): W.ConditionRule =>
  ({ ...W.newRule("amount", op), value, currency: "USD", ...extra });
const grp = (...c: W.ConditionRule[]): W.ConditionGroup => ({ ...W.newGroup("and"), children: c });

// amount < 1000 → 2 approvals; else amount > 20000 → 3; else fallback 1
const inner: W.IfElseBlock = {
  kind: "if_else", id: "ie2", branches: [{ id: "b2", when: grp(rule("gt", 20000)), blocks: [approval("A3"), approval("A4"), approval("A5")] }],
  else_blocks: [approval("Fallback")],
};
const root: W.IfElseBlock = {
  kind: "if_else", id: "ie1",
  branches: [{ id: "b1", when: grp(rule("lt", 1000)), blocks: [approval("A1"), approval("A2")] }],
  else_blocks: [inner],
};
const blocks: W.Block[] = [root, { kind: "notification", id: "n1", step: { name: "Tell finance", step_type: "notification" } }];

const sim = (amount: number, cur = "USD", extra: any = {}) =>
  W.simulate(blocks, fields, { amount: { amount, currency: cur }, ...extra }, { rates: { USD: 1, EUR: 1.1, KES: 0.0077 } });
const names = (r: W.SimResult) => r.chain.map((c) => c.step.name);

assert.deepEqual(names(sim(500)), ["A1", "A2", "Tell finance"]);
assert.deepEqual(names(sim(1000)), ["Fallback", "Tell finance"]);         // boundary: <1000 is exclusive
assert.deepEqual(names(sim(20000)), ["Fallback", "Tell finance"]);
assert.deepEqual(names(sim(25000)), ["A3", "A4", "A5", "Tell finance"]);

assert.deepEqual(names(sim(900, "EUR")), ["A1", "A2", "Tell finance"]);   // 900 EUR = 990 USD < 1000
assert.deepEqual(names(sim(950, "EUR")), ["Fallback", "Tell finance"]);   // 950 EUR = 1045 USD
assert.equal(sim(500).outcome, "pending_approvals");
// missing rates → warning, condition false (falls to else)
const noRate = W.simulate(blocks, fields, { amount: { amount: 5, currency: "XYZ" } });
assert.ok(noRate.warnings.some((w) => /exchange rate/.test(w)));
// missing amount: "lt" is false when empty → fallback chain
assert.deepEqual(W.simulate(blocks, fields, {}).chain.map((c) => c.step.name), ["Fallback", "Tell finance"]);
// decisions recorded
const d = sim(25000).decisions;
assert.equal(d.length, 2); assert.equal(d[0].matched_slot, "else"); assert.equal(d[1].matched_slot, "b2");

// ── operators ──
const env = (v: any) => W.makeEnv(v);
const R = (id: string, op: W.Operator, value?: any, more: Partial<W.ConditionRule> = {}) => ({ ...W.newRule(id, op), value, ...more });
assert.equal(W.evalRule(R("f_dept", "eq", "IT"), fields, env({ f_dept: "IT" })), true);
assert.equal(W.evalRule(R("f_dept", "in", ["IT", "HR"]), fields, env({ f_dept: "HR" })), true);
assert.equal(W.evalRule(R("f_dept", "not_in", ["IT"]), fields, env({})), true);           // empty + negative op
assert.equal(W.evalRule(R("f_dept", "eq", "IT"), fields, env({})), false);
assert.equal(W.evalRule(R("f_urgent", "is_true"), fields, env({ f_urgent: true })), true);
assert.equal(W.evalRule(R("f_urgent", "is_false"), fields, env({})), true);
assert.equal(W.evalRule(R("uploader.groups", "contains_any", ["finance"]), fields, env({ uploader: { groups: ["Finance", "HR"] } })), true);
assert.equal(W.evalRule(R("uploader.groups", "contains_all", ["finance", "ops"]), fields, env({ uploader: { groups: ["Finance"] } })), false);
assert.equal(W.evalRule(R("uploader.department", "contains", "fin"), fields, env({ uploader: { department: "Corporate Finance" } })), true);
assert.equal(W.evalRule(R("payment_run.line_count", "between", 5, { value2: 10 }), fields, env({ "payment_run.line_count": "7" })), true);
assert.equal(W.evalRule(R("amount", "between", 1000, { value2: 5000, currency: "USD" }), fields, env({ amount: { amount: "1,000.00", currency: "USD" } })), true); // inclusive
assert.equal(W.evalRule(R("document.created_at", "within_last_days", 7), fields, W.makeEnv({ "document.created_at": "2026-09-28" }, { now: new Date("2026-09-30") })), true);
assert.equal(W.evalRule(R("document.created_at", "before", "2026-01-01"), fields, env({ "document.created_at": "2026-09-28" })), false);
// field-to-field: amount > payment_run budget (both money)
const f2 = W.fieldMap([...W.SYSTEM_FIELDS, { id: "budget", label: "Budget", type: "money", source: "form" }]);
assert.equal(W.evalRule({ ...W.newRule("amount", "gt"), value_ref: "budget" }, f2, W.makeEnv({ amount: { amount: 120, currency: "USD" }, budget: { amount: 100, currency: "USD" } })), true);
// group semantics
const empty = W.newGroup();
const e1 = env({}); assert.equal(W.evalGroup(empty, fields, e1), false); assert.ok(e1.warnings.length);
const orG: W.ConditionGroup = { ...W.newGroup("or"), children: [R("f_dept", "eq", "IT"), R("f_urgent", "is_true")] };
assert.equal(W.evalGroup(orG, fields, env({ f_urgent: true })), true);
assert.equal(W.evalGroup({ ...orG, negate: true }, fields, env({ f_urgent: true })), false);
const nested: W.ConditionGroup = { ...W.newGroup("and"), children: [rule("gte", 1000), { ...W.newGroup("or"), children: [R("f_dept", "eq", "IT"), R("f_urgent", "is_true")] }] };
assert.equal(W.evalGroup(nested, fields, env({ amount: { amount: 2000, currency: "USD" }, f_dept: "IT" })), true);
assert.equal(W.evalGroup(nested, fields, env({ amount: { amount: 2000, currency: "USD" }, f_dept: "HR" })), false);

// ── switch + set_value + end ──
const sw: W.SwitchBlock = { kind: "switch", id: "sw", field_id: "f_dept", cases: [
  { id: "c1", values: ["IT"], blocks: [{ kind: "set_value", id: "sv", variable: "risk", value: "high" }] },
  { id: "c2", values: ["HR"], blocks: [{ kind: "end", id: "en", outcome: "approved", reason: "HR auto" }] },
], default_blocks: [approval("Default")] };
const after: W.IfElseBlock = { kind: "if_else", id: "ie3", branches: [{ id: "b3", when: grp({ ...W.newRule("var.risk", "eq"), value: "high" } as any), blocks: [approval("Risk review")] }], else_blocks: [approval("Std")] };
const prog: W.Block[] = [sw, after];
const F3 = W.fieldMap([...fields.values(), { id: "var.risk", label: "risk", type: "text", source: "variable" }]);
assert.deepEqual(W.simulate(prog, F3, { f_dept: "IT" }).chain.map((c) => c.step.name), ["Risk review"]);   // variable flows to later condition
assert.equal(W.simulate(prog, F3, { f_dept: "HR" }).outcome, "auto_approved");
assert.deepEqual(W.simulate(prog, F3, { f_dept: "ZZ" }).chain.map((c) => c.step.name), ["Default", "Std"]);

// ── paths ──
const { paths } = W.enumeratePaths(blocks, fields);
assert.equal(paths.length, 3);
assert.deepEqual(paths.map((p) => p.legs.filter((l) => l.kind === "approval").length), [2, 3, 1]);
assert.equal(W.enumeratePaths(prog, F3).paths.length, 5);  // IT:2, HR:1(end), default:2

// ── validation ──
assert.equal(W.validateDefinition(blocks, fields).filter((i) => i.severity === "error").length, 0);
const bad: W.Block[] = [{ ...W.newIfElse() }];
const badIssues = W.validateDefinition(bad, fields);
assert.ok(badIssues.some((i) => /pick a field/.test(i.message)));
assert.ok(badIssues.some((i) => /without any approval/.test(i.message)));
// unreachable branch: <1000 then <500
const shadow: W.IfElseBlock = { kind: "if_else", id: "sh", branches: [
  { id: "s1", when: grp(rule("lt", 1000)), blocks: [approval("x")] },
  { id: "s2", when: grp(rule("lt", 500)), blocks: [approval("y")] },
  { id: "s3", when: grp(rule("gte", 1000), rule("lt", 2000)), blocks: [approval("z")] },
], else_blocks: [approval("e")] };
const sh = W.validateDefinition([shadow], fields).filter((i) => /unreachable/.test(i.message));
assert.equal(sh.length, 1); assert.match(sh[0].message, /Branch 2/);
// coverage across two adjacent ranges: [0,1000) ∪ [1000,2000) covers [500,1500]
const I = (lo: number, loInc: boolean, hi: number, hiInc: boolean) => ({ lo, loInc, hi, hiInc });
assert.equal(W.isCovered([I(-Infinity, false, 1000, false), I(1000, true, 2000, false)], I(500, true, 1500, true)), true);
assert.equal(W.isCovered([I(-Infinity, false, 1000, false), I(1000, false, 2000, false)], I(500, true, 1500, true)), false); // hole at exactly 1000
// missing currency on a money rule
const noCur = W.validateDefinition([{ ...W.newIfElse(), branches: [{ id: "q", when: grp({ ...W.newRule("amount", "lt"), value: 5 } as any), blocks: [approval("a")] }] } as any], fields);
assert.ok(noCur.some((i) => /choose a currency/.test(i.message)));

// ── compile ──
const g = W.compileToGraph(blocks);
assert.equal(g.start, "ie1");
const ie1 = g.nodes["ie1"] as any;
assert.equal(ie1.branches[0].next, blocks[0].kind === "if_else" ? (root.branches[0].blocks[0] as any).id : null);
// last approval of a branch continues to the notification that follows the if/else
const a2 = g.nodes[(root.branches[0].blocks[1] as any).id] as any; assert.equal(a2.next, "n1");
assert.equal((g.nodes["n1"] as any).next, null);
assert.equal(W.flattenSteps(blocks).length, 7);
assert.deepEqual(W.flattenSteps(blocks).map((s) => s.order), [1, 2, 3, 4, 5, 6, 7]);

// ── pseudocode ──
const code = W.toPseudocode(blocks, fields, (id) => (id === "g1" ? "Finance" : "?"));
assert.match(code, /^IF Amount < 1,000 USD THEN/); assert.match(code, /\nELSE IF Amount > 20,000 USD THEN/); assert.ok(!/END IF\n\s*END IF/.test(code)); assert.match(code, /APPROVE "A1" by ANY of Finance/);

// ── clone gets fresh ids ──
const c = W.cloneBlock(root) as W.IfElseBlock; assert.notEqual(c.id, root.id); assert.notEqual(c.branches[0].id, "b1");

// ── tree edits ──
let t = W.editList(blocks, W.listKey("ie1", "b1"), (l) => [...l, approval("Added")]);
assert.equal(((W.findBlock(t, "ie1") as W.IfElseBlock).branches[0].blocks).length, 3);
t = W.removeBlock(t, "n1"); assert.equal(t.length, 1);
t = W.editList(t, W.listKey("ie2", "else"), (l) => [...l, approval("Deep")]);
assert.equal(((W.findBlock(t, "ie2") as W.IfElseBlock).else_blocks).length, 2);

// ── migration ──
const tplA = { id: "A", name: "Small", steps: [{ name: "Mgr", step_type: "approval" as const, order: 1 }] };
const tplB = { id: "B", name: "Medium", steps: [{ name: "Fin", step_type: "approval" as const, order: 1 }, { name: "CFO", step_type: "approval" as const, order: 2 }] };
const tplC = { id: "C", name: "Large", steps: [{ name: "Board", step_type: "approval" as const, order: 1 }] };
const mig = W.migrateLegacyRules([tplA, tplB, tplC], [
  { template: "A", amount_min: 0, amount_max: 1000, currency: "USD" },
  { template: "B", amount_min: 1000, amount_max: 20000, currency: "USD" },
  { template: "C", amount_min: 20000, amount_max: null, currency: "USD" },
], { maxInclusive: false });
const mp = W.enumeratePaths(mig.definition.blocks, fields).paths;
assert.equal(mp.length, 3);
const run = (a: number) => W.simulate(mig.definition.blocks, fields, { amount: { amount: a, currency: "USD" } }).chain.map((x) => x.step.name);
assert.deepEqual(run(999), ["Mgr"]); assert.deepEqual(run(1000), ["Fin", "CFO"]); assert.deepEqual(run(19999), ["Fin", "CFO"]); assert.deepEqual(run(20000), ["Board"]);
assert.equal(W.validateDefinition(mig.definition.blocks, fields).filter((i) => i.severity === "error").length, 0);
// multi-phase → switch on context.phase
const mig2 = W.migrateLegacyRules([tplA, tplB], [
  { template: "A", phase: "requisition", amount_min: 0, amount_max: null, currency: "USD" },
  { template: "B", phase: "rfq", amount_min: 0, amount_max: null, currency: "USD" },
]);
assert.equal(mig2.definition.blocks[0].kind, "switch");
assert.deepEqual(W.simulate(mig2.definition.blocks, fields, { "context.phase": "rfq" }).chain.map((x) => x.step.name), ["Fin", "CFO"]);

// ── approver actions: Reject ALWAYS completes as Rejected; Return is a per-step action that pauses ──
{
  const mk = (name: string, extra: any = {}) => { const b = approval(name) as W.ApprovalBlock; b.step = { ...b.step, allow_reject: true, ...extra }; return b; };
  const s1 = mk("S1", { allow_return: true, allow_return_submitter: true }), s2 = mk("S2", { allow_return: true, allow_return_submitter: true }), s3 = mk("S3", { allow_return: true });
  const flow: W.Block[] = [s1, s2, s3, { kind: "notification", id: "nn", step: { name: "Tell", step_type: "notification" } }];
  const act = (blocksArg: W.Block[], id: string, action: W.ApproverAction, vals: any = {}) => W.simulate(blocksArg, fields, vals, { actAt: { id, action } });

  const none = W.simulate(flow, fields, {});
  assert.equal(none.outcome, "pending_approvals"); assert.equal(none.acted, undefined);

  // Reject: ends right there; S3 and the notification never run; last-step reject is also Rejected
  const rej = act(flow, s2.id, "reject");
  assert.equal(rej.outcome, "rejected"); assert.deepEqual(names(rej), ["S1", "S2"]); assert.ok(!rej.visited.has(s3.id));
  assert.equal(act(flow, s3.id, "reject").outcome, "rejected");

  // Return to previous → the previous approval on this path; to submitter → null
  const rp = act(flow, s3.id, "return_previous");
  assert.equal(rp.outcome, "returned"); assert.equal(rp.acted?.return_target, s2.id); assert.deepEqual(names(rp), ["S1", "S2", "S3"]);
  const rs = act(flow, s2.id, "return_submitter");
  assert.equal(rs.outcome, "returned"); assert.equal(rs.acted?.return_target, null);

  // No previous approval on the first step → that action is unavailable and ignored; the submitter return still works
  assert.deepEqual(W.availableActions(s1.step, false), ["reject", "return_submitter"]);
  assert.deepEqual(W.availableActions(s2.step, true), ["reject", "return_previous", "return_submitter"]);
  assert.equal(act(flow, s1.id, "return_previous").outcome, "pending_approvals");
  assert.equal(act(flow, s1.id, "return_submitter").outcome, "returned");
  // actions a step doesn't allow are ignored, never silently applied
  const noRej = mk("NR", { allow_reject: false });
  assert.equal(act([noRej], noRej.id, "reject").outcome, "pending_approvals");
  assert.equal(act([s3], s3.id, "return_submitter").outcome, "pending_approvals");

  // "previous" follows the path actually taken, not document order
  const brA = mk("BranchA"), inner = mk("Inner", { allow_return: true });
  const cond: W.IfElseBlock = { kind: "if_else", id: "cx", branches: [{ id: "cxb", when: grp(rule("gt", 10)), blocks: [brA, inner] }], else_blocks: [inner] };
  const big = { amount: { amount: 99, currency: "USD" } }, small = { amount: { amount: 1, currency: "USD" } };
  assert.equal(act([cond], inner.id, "return_previous", big).acted?.return_target, brA.id);
  assert.equal(act([cond], inner.id, "return_previous", small).outcome, "pending_approvals");   // ELSE path: nothing earlier, button hidden

  // compile: no special reject/return graph wiring; the flags ride on the step
  const cg = W.compileToGraph(flow);
  assert.equal((cg.nodes[s2.id] as any).next, s3.id); assert.equal((cg.nodes[s2.id] as any).on_reject, undefined);
  assert.equal((cg.nodes[s2.id] as any).step.allow_return_submitter, true);
  assert.equal(W.flattenSteps(flow).length, 4);

  // pseudocode shows what the approver can do
  assert.match(W.toPseudocode(flow, fields), /APPROVE "S2"[^\n]*\n\s+CAN RETURN to previous step or submitter/);
  assert.match(W.toPseudocode(flow, fields), /APPROVE "S3"[^\n]*\n\s+CAN RETURN to previous step\n/);
  assert.match(W.toPseudocode([{ kind: "end", id: "e", outcome: "approved", reason: "small" }], fields), /COMPLETE as APPROVED/);

  // validation: returning to "previous" from the very first approval can't work → warning, not error
  const v = W.validateDefinition([s1, s2], fields);
  assert.ok(v.some((i) => i.severity === "warning" && /first approval/.test(i.message) && i.block_id === s1.id));
  assert.ok(!v.some((i) => i.block_id === s2.id && /first approval/.test(i.message)));
  assert.equal(W.validateDefinition([mk("OnlySubmitter", { allow_return_submitter: true })], fields).filter((i) => /first approval/.test(i.message)).length, 0);
  assert.equal(W.validateDefinition(flow, fields).filter((i) => i.severity === "error").length, 0);

  // there is no Return block any more
  assert.ok(!("newReturn" in W));
}

// ── migration regression: several open-ended bands used to drop all but the last ──
{
  const mk = (id: string) => ({ id, name: id, steps: [{ name: id + "-step", step_type: "approval" as const, order: 1 }] });
  const m3 = W.migrateLegacyRules([mk("A"), mk("B"), mk("C")], [
    { template: "A", amount_min: 0, amount_max: 1000, currency: "USD" },
    { template: "B", amount_min: 1000, amount_max: null, currency: "USD" },
    { template: "C", amount_min: 5000, amount_max: null, currency: "USD" },
  ], { maxInclusive: false });
  const at = (a: number) => W.simulate(m3.definition.blocks, fields, { amount: { amount: a, currency: "USD" } }).chain.map((x) => x.step.name);
  assert.deepEqual(at(500), ["A-step"]); assert.deepEqual(at(2000), ["B-step"]); assert.deepEqual(at(5000), ["C-step"]); assert.deepEqual(at(90000), ["C-step"]);
  assert.ok(m3.notes.some((n) => /stops where/.test(n)));
  // gap + below-minimum are reported instead of silently mapping to the top chain
  const m4 = W.migrateLegacyRules([mk("A"), mk("B")], [
    { template: "A", amount_min: 100, amount_max: 1000, currency: "USD" },
    { template: "B", amount_min: 1500, amount_max: null, currency: "USD" },
  ], { maxInclusive: false });
  assert.ok(m4.notes.some((n) => /below 100/.test(n))); assert.ok(m4.notes.some((n) => /Gap/.test(n)));
}

// ── independent (stacked, non-nested) IFs: each decides on its own and steps accumulate ──
{
  const ap2 = (name: string, group: string, type = "group_any"): W.Block => ({ kind: "approval", id: W.uid(), step: { name, step_type: "approval", assignee_group: group, assignee_type: type, sla_hours: 48, allow_approve: true, allow_reject: true } });
  const gtG = (n: number) => grp(rule("gt", n));
  const onlyIf = (id: string, n: number, step: W.Block): W.IfElseBlock => ({ kind: "if_else", id, branches: [{ id: id + "b", when: gtG(n), blocks: [step] }], else_blocks: [] });
  const swp: W.SwitchBlock = { kind: "switch", id: "swp", field_id: "context.phase", cases: [{ id: "c1", label: "Request stage", values: ["request"], blocks: [
    ap2("Manager Approval", "Administrators", "group_specific"),
    onlyIf("i1", 1000, ap2("Finance Review", "HOD")), onlyIf("i2", 10000, ap2("Director Approval", "Directors")), onlyIf("i3", 20000, ap2("VP Approval", "VPs")),
  ] }], default_blocks: [ap2("Fallback", "g1")] };
  const at = (a: number) => names(W.simulate([swp], fields, { "context.phase": "request", amount: { amount: a, currency: "USD" } }));
  assert.deepEqual(at(500), ["Manager Approval"]);
  assert.deepEqual(at(1000), ["Manager Approval"]);                                   // > is exclusive
  assert.deepEqual(at(5000), ["Manager Approval", "Finance Review"]);
  assert.deepEqual(at(15000), ["Manager Approval", "Finance Review", "Director Approval"]);
  assert.deepEqual(at(25000), ["Manager Approval", "Finance Review", "Director Approval", "VP Approval"]);
  assert.deepEqual(names(W.simulate([swp], fields, { "context.phase": "lpo", amount: { amount: 99999, currency: "USD" } })), ["Fallback"]);
  // empty ELSE is not noise
  assert.equal(W.validateDefinition([swp], fields).length, 0);
  // reads as plain IF … END IF, with no dangling ELSE
  const txt = W.toPseudocode([swp], fields, (id) => id ?? "?");
  assert.ok(!/ELSE\s+\/\/ fallback\n\s+END IF/.test(txt));
  assert.match(txt, /IF Amount > 1,000 USD THEN\n\s+APPROVE "Finance Review" by ANY of HOD  \[SLA 48h\]\n\s+END IF/);
  assert.match(txt, /APPROVE "Manager Approval" by SPECIFIC member of Administrators/);
  // 4 independent yes/no decisions inside the case → 2^3 = 8 routes + the DEFAULT route
  assert.equal(W.enumeratePaths([swp], fields).paths.length, 9);
  // an empty DEFAULT is still caught (that route would finish with nobody approving)
  const noDef: W.SwitchBlock = { ...swp, default_blocks: [] };
  assert.ok(W.validateDefinition([noDef], fields).some((i) => i.severity === "error" && /without any approval/.test(i.message)));
  // rejection inside a stacked IF ends the whole workflow there: later IFs never run
  const vpId = (swp.cases[0].blocks[2] as W.IfElseBlock).branches[0].blocks[0].id;   // Director Approval
  const r = W.simulate([swp], fields, { "context.phase": "request", amount: { amount: 25000, currency: "USD" } }, { actAt: { id: vpId, action: "reject" } });
  assert.deepEqual(names(r), ["Manager Approval", "Finance Review", "Director Approval"]); assert.equal(r.outcome, "rejected");
}

console.log("ALL TESTS PASSED");