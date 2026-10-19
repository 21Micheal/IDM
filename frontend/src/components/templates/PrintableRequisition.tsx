import type { WorkflowStep } from "@/components/notifications/workflow-visualizer";
import { useQuery } from "@tanstack/react-query";
import { sunsystemsAPI } from "@/services/api";

type AnyRecord = Record<string, any>;

function text(value: unknown): string {
  if (value == null || value === "") return "";
  if (Array.isArray(value)) return value.map(text).filter(Boolean).join(", ");
  if (typeof value === "object") {
    const item = value as AnyRecord;
    if (item.data_url || item.dataUrl || item.image_data) return String(item.data_url || item.dataUrl || item.image_data);
    return String(item.label || item.name || item.description || item.code || item.value || "");
  }
  return String(value).trim();
}

function normalized(value: unknown): string {
  return text(value).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function fieldLabel(field: AnyRecord): string {
  return text(field.label || field.title || field.key);
}

function displayDate(value: unknown, includeTime = false): string {
  const raw = text(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!match) return raw;
  const date = `${match[3]}/${match[2]}/${match[1]}`;
  if (!includeTime || !match[4]) return date;
  const hour = Number(match[4]);
  const suffix = hour >= 12 ? "PM" : "AM";
  const hour12 = hour % 12 || 12;
  return `${date} ${hour12}:${match[5]} ${suffix}`;
}

function findField(fields: AnyRecord[], values: AnyRecord, patterns: RegExp[]): string {
  for (const field of fields) {
    const label = normalized(fieldLabel(field));
    if (!patterns.some((pattern) => pattern.test(label))) continue;
    const value = text(values[field.key]);
    if (value) return value;
  }
  return "";
}

function tableColumns(table: AnyRecord): AnyRecord[] {
  return (table.columns || []).filter((column: AnyRecord) => !column.hidden && column.key);
}

function cellValue(value: unknown): string {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const item = value as AnyRecord;
    if (item.data_url || item.dataUrl) return "Signature on file";
    if (item.account_code) {
      const codes = Object.entries(item)
        .filter(([key, code]) => /^\d{2}$/.test(key) && code)
        .map(([, code]) => text(code));
      return [text(item.account_code), ...codes].filter(Boolean).join(" · ");
    }
  }
  return text(value) || "—";
}

function PrintableTable({ table, rows, columns }: { table: AnyRecord; rows: AnyRecord[]; columns?: AnyRecord[] }) {
  const visibleColumns = columns ?? tableColumns(table);
  return (
    <table className="rq-print-table">
      <thead><tr>{visibleColumns.map((column) => <th key={column.key}>{fieldLabel(column)}</th>)}</tr></thead>
      <tbody>
        {rows.length ? rows.map((row, index) => (
          <tr key={index}>{visibleColumns.map((column) => <td key={column.key}>{["date", "datetime"].includes(column.type) ? displayDate(row?.[column.key], column.type === "datetime") || "—" : cellValue(row?.[column.key])}</td>)}</tr>
        )) : <tr><td colSpan={Math.max(visibleColumns.length, 1)}>—</td></tr>}
      </tbody>
      {(table.columns || []).some((column: AnyRecord) => column.showTotal && visibleColumns.includes(column)) && (
        <tfoot><tr>{visibleColumns.map((column, index) => {
          const firstTotalIndex = visibleColumns.findIndex((item) => item.showTotal);
          const total = column.showTotal
            ? rows.reduce((sum, row) => sum + (Number(String(row?.[column.key] ?? "").replace(/,/g, "")) || 0), 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : "";
          const labelCell = firstTotalIndex === 0 ? index === 0 : index === firstTotalIndex - 1;
          const content = firstTotalIndex === 0 && index === 0
            ? `${table.totalLabel || "Total"}: ${total}`
            : labelCell ? (table.totalLabel || "Total") : total;
          return <td key={column.key}>{content}</td>;
        })}</tr></tfoot>
      )}
    </table>
  );
}

function SignatureBlocks({ sections, values, match }: { sections: AnyRecord[]; values: AnyRecord; match?: RegExp }) {
  const blocks: Array<{ role: string; image: string; name: string; date: string }> = [];
  for (const section of sections) {
    const fields: AnyRecord[] = section.fields || [];
    const signatureFields = fields.filter((field) => field.type === "signature" || /signature|signed image/i.test(fieldLabel(field)));
    for (const signature of signatureFields) {
      const sectionLabel = text(section.label || section.title);
      if (match && !match.test(`${sectionLabel} ${fieldLabel(signature)} ${text(signature.key)}`)) continue;
      const imageValue = values[signature.key];
      const image = typeof imageValue === "string" ? imageValue : text(imageValue?.url || imageValue?.data_url || imageValue?.dataUrl || imageValue?.image_data);
      const base = normalized(fieldLabel(signature)).replace(/\b(signature|signed|image|sign)\b/g, " ").replace(/\s+/g, " ").trim();
      const related = fields.filter((field) => field.key !== signature.key && base && normalized(fieldLabel(field)).includes(base));
      const nameField = related.find((field) => /name|prepared by|approver|requester/i.test(fieldLabel(field)))
        || fields.find((field) => field.key !== signature.key && /^name$/i.test(fieldLabel(field)));
      const dateField = related.find((field) => /date/i.test(fieldLabel(field)))
        || fields.find((field) => field.key !== signature.key && /^date$/i.test(fieldLabel(field)));
      const name = text(values[nameField?.key]) || text(values[`${signature.key}_name`]);
      const date = displayDate(values[dateField?.key] || values[`${signature.key}_date`]);
      blocks.push({ role: fieldLabel(signature).replace(/signature/i, "").trim() || sectionLabel || "Signature", image, name, date });
    }
  }
  if (!blocks.length) return null;
  return <div className="rq-print-signatures">{blocks.map((block, index) => (
    <div className={`rq-print-signature${block.image ? " rq-print-signature-has-image" : ""}`} key={`${block.role}-${index}`}>
      <strong>{block.role}</strong>
      {block.image.startsWith("data:image/") || block.image.startsWith("http") || block.image.startsWith("/")
        ? <img src={block.image} alt={`${block.role} signature`} />
        : <div className="rq-print-signature-line" />}
      {!block.image && <><div>Name: {block.name || "—"}</div><div>Date: {block.date || "—"}</div></>}
    </div>
  ))}</div>;
}

type PrintSignatureMapping = { stage: string; step: string };

function WorkflowApprovalSignatures({
  document,
  workflowSteps,
  mapping,
  roleLabel,
  showPlaceholder = false,
}: {
  document: AnyRecord;
  workflowSteps: WorkflowStep[];
  mapping: PrintSignatureMapping;
  roleLabel?: string;
  showPlaceholder?: boolean;
}) {
  const signedRecords: AnyRecord[] = [
    ...(Array.isArray(document.signatures) ? document.signatures : []),
    ...(Array.isArray(document.approval_signatures) ? document.approval_signatures : []),
  ];
  const isApprovedTask = (step: WorkflowStep) =>
    step.kind === "task"
    && /completed|approved/i.test(String(step.status));
  const isImprestLane = mapping.stage === "imprest_request";
  const phase = isImprestLane ? undefined : mapping.stage;
  let approvedSteps = workflowSteps.filter((step) =>
    isApprovedTask(step)
    && (isImprestLane ? step.executionLane === "imprest_request" : !step.executionLane)
    && (!phase || step.phase === phase),
  );
  // Keep legacy workflow snapshots usable when phase metadata is absent.
  if (!approvedSteps.length && !isImprestLane && phase) {
    approvedSteps = workflowSteps.filter((step) =>
      isApprovedTask(step)
      && !step.executionLane
      && !["rfq", "lpo", "retirement"].includes(String(step.phase || "").toLowerCase()),
    );
  }
  approvedSteps.sort((a, b) => a.order - b.order);
  if (mapping.step === "__first__") approvedSteps = approvedSteps.slice(0, 1);
  else if (mapping.step === "__last__") approvedSteps = approvedSteps.slice(-1);
  else if (mapping.step.startsWith("__contains__:")) {
    const token = normalized(mapping.step.slice("__contains__:".length));
    approvedSteps = approvedSteps.filter((step) => normalized(step.name).includes(token));
  }
  else approvedSteps = approvedSteps.filter((step) => normalized(step.name) === normalized(mapping.step));
  if (!approvedSteps.length) {
    if (!showPlaceholder) return null;
    return (
      <div className="rq-print-signatures">
        <div className="rq-print-signature">
          <strong>{roleLabel || "Approver"}</strong>
          <div className="rq-print-signature-line" />
          <div>Name: —</div><div>Date: —</div>
        </div>
      </div>
    );
  }
  return <div className="rq-print-signatures">{approvedSteps.map((step, index) => {
    const record = signedRecords.find((item) => normalized(item.step_name) === normalized(step.name));
    const image = text(record?.signature_data);
    const name = text(record?.signer?.full_name || step.approver);
    const date = displayDate(record?.signed_at || step.completedAt);
    return (
      <div className={`rq-print-signature${image ? " rq-print-signature-has-image" : ""}`} key={`${step.id}-${index}`}>
        <strong>{roleLabel || step.name}</strong>
        {image ? <img src={image} alt={`${name} signature`} /> : <div className="rq-print-signature-line" />}
        <div>Name: {name || "—"}</div><div>Date: {date || "—"}</div>
      </div>
    );
  })}</div>;
}

export default function PrintableRequisition({
  title,
  reference,
  document,
  sections,
  values,
  workflowSteps,
  printConfig,
  accountingPeriod,
  businessUnit,
}: {
  title: string;
  reference: string;
  document: AnyRecord;
  sections: AnyRecord[];
  values: AnyRecord;
  workflowSteps: WorkflowStep[];
  printConfig?: AnyRecord;
  accountingPeriod?: string;
  businessUnit?: string;
}) {
  const configuredSlots = printConfig?.signatureSlots ?? {};
  const signatureSlots: Record<string, PrintSignatureMapping> = {
    budgetHolder: { stage: "requisition", step: "__contains__:budget holder" },
    lineManager: { stage: "requisition", step: "__first__" },
    finance: { stage: "requisition", step: "__contains__:finance" },
    bookingOfficer: { stage: "lpo", step: "__contains__:booking officer" },
    imprestRequest: { stage: "imprest_request", step: "__first__" },
    authorization: { stage: "lpo", step: "__last__" },
    ...configuredSlots,
  };
  const { data: activityCodes = [] } = useQuery({
    queryKey: ["print-analysis-codes", "10", businessUnit],
    queryFn: () => sunsystemsAPI.getAnalysisCodes({ dimension: "10", business_unit: businessUnit }).then((response) => response.data.analysis_codes ?? []),
    staleTime: 10 * 60 * 1000,
  });
  const { data: costCentreCodes = [] } = useQuery({
    queryKey: ["print-analysis-codes", "05", businessUnit],
    queryFn: () => sunsystemsAPI.getAnalysisCodes({ dimension: "05", business_unit: businessUnit }).then((response) => response.data.analysis_codes ?? []),
    staleTime: 10 * 60 * 1000,
  });
  const analysisName = (codes: typeof activityCodes, code: string) => text(codes.find((item) => item.analysis_code === code)?.name);
  const fields = sections.flatMap((section) => section.fields || []).filter((field) => field.type !== "table" && !field.hidden);
  const tables = sections.flatMap((section) => section.fields || []).filter((field) => field.type === "table");
  // Section B summarizes both posted funding lines. The separate detailed
  // Travel table is not printed; Section E contains the Travel Itinerary.
  // For Imprest, use the issued itinerary rather than the request table.
  const postingTables = tables.filter((table) => ["requisition_lines", "rfq_required_lines"].includes(table.workflowRole));
  const travelLines = postingTables.flatMap((table) => {
    const rows = Array.isArray(values[table.key]) ? values[table.key] : [];
    const cols = tableColumns(table);
    // Posting roles can be assigned to hidden calculated columns (for example,
    // the Travel table's LPO Amount). Keep those available for print mapping.
    const roleColumn = (role: string) => (table.columns || []).find((column: AnyRecord) => column.key && column.sunsystems?.role === role);
    const budgetColumn = cols.find((column) => column.type === "budget_line");
    const activityColumn = cols.find((column) => column.external?.source === "analysis_codes" && column.external?.dimension === "10");
    const costCentreColumn = cols.find((column) => column.external?.source === "analysis_codes" && column.external?.dimension === "05");
    const accountColumn = roleColumn("account_code");
    const amountColumn = roleColumn("line_amount");
    return rows.map((row: AnyRecord) => {
      const budget = budgetColumn && row?.[budgetColumn.key] && typeof row[budgetColumn.key] === "object" ? row[budgetColumn.key] : {};
      const activityCode = text(row?.[activityColumn?.key] || budget["10"]);
      const costCode = text(row?.[costCentreColumn?.key] || budget["05"]);
      const account = text(row?.[accountColumn?.key] || budget.account_code);
      const activityDescription = text(
        budget["10_description"]
        || budget["10_name"]
        || row?.[activityColumn?.external?.fillDescriptionColumn]
        || row?.[activityColumn?.key + "_description"],
      ) || analysisName(activityCodes, activityCode);
      const costCentreName = text(budget["05_description"] || budget["05_name"] || row?.[costCentreColumn?.external?.fillDescriptionColumn] || row?.[costCentreColumn?.key + "_description"]) || analysisName(costCentreCodes, costCode);
      return {
        activityCode: activityCode || "—",
        activityDescription: activityDescription || "—",
        costCentre: costCentreName || costCode || "—",
        accountCode: account || "—",
        description: table.workflowRole === "rfq_required_lines" ? "Imprest" : "Travel",
        estimated: text(row?.[amountColumn?.key]) || "—",
      };
    });
  });
  const isTravelItinerary = (table: AnyRecord) => {
    if (/itinerary/i.test(fieldLabel(table)) && !/imprest/i.test(fieldLabel(table))) return true;
    const labels = tableColumns(table).map((column) => normalized(fieldLabel(column))).join(" ");
    return /destination/.test(labels) && /(date|nights|accommodation|departure|arrival)/.test(labels) && table.workflowRole !== "rfq_required_lines";
  };
  const itinerary = tables.find(isTravelItinerary);
  // Only the approved/issued itinerary is printed here; never substitute the
  // requester-entered amount from the separate Imprest Request table.
  const imprestTables = tables.filter((table) => table.workflowRole === "rfq_required_lines").map((table) => ({
    table,
    rows: Array.isArray(values[table.key]) ? values[table.key] as AnyRecord[] : [],
  }));
  const itineraryRows = itinerary ? (Array.isArray(values[itinerary.key]) ? values[itinerary.key] : []) : [];
  const destination = itinerary ? (() => {
    const columns = tableColumns(itinerary);
    const destinationColumns = columns.filter((column) => /destination|city|location|to\b/.test(normalized(fieldLabel(column))));
    const entries = itineraryRows.flatMap((row: AnyRecord) => destinationColumns.map((column) => text(row?.[column.key])).filter(Boolean));
    return [...new Set(entries)].join(", ");
  })() : "";
  const financeSteps = workflowSteps.filter((step) => /finance|budget availability/i.test(step.name));
  const financeStatuses = financeSteps.map((step) => String(step.status).toLowerCase());
  const budgetAvailability = financeStatuses.some((status) => /reject/.test(status))
    ? "No"
    : financeStatuses.some((status) => /approv|complete/.test(status))
      ? "Yes"
      : "Pending confirmation";
  const lpoApprover = [...workflowSteps].reverse().find((step) => step.phase === "lpo" && /approv|complete/i.test(String(step.status)));
  const totalEstimated = travelLines.reduce((sum, line) => sum + (Number(String(line.estimated).replace(/,/g, "")) || 0), 0);
  const top = [
    ["Name of Requesting Officer", findField(fields, values, [/requesting officer/, /requester name/, /requisitioner/, /requested by/]) || text(document.uploaded_by?.full_name) || "—"],
    ["Position", findField(fields, values, [/^position$/])],
    ["Staff Code", findField(fields, values, [/staff code/, /employee number/])],
    ["Department", findField(fields, values, [/department/]) || text(document.uploaded_by_department_name || document.department_name || document.uploaded_by?.department_name || document.department) || "—"],
    ["Grade", findField(fields, values, [/^grade$/])],
    ["Accounting Period", accountingPeriod || findField(fields, values, [/accounting period/, /^period$/])],
    ["Purpose of Travel", findField(fields, values, [/activity description/, /purpose of travel/])],
    ["Destination", destination || findField(fields, values, [/destination/])],
    ["Workshop / Activity Dates", [
      findField(fields, values, [/activity start date/, /workshop.*from/, /travel start date/]),
      findField(fields, values, [/activity end date/, /workshop.*to/, /travel end date/]),
    ].filter(Boolean).map(displayDate).join(" – ")],
    ["Expected Travel Date", displayDate(findField(fields, values, [/expected.*travel date/, /travel date/]))],
  ];
  const fundingCoverage = fields
    .filter((field) => /fully|partially/i.test(fieldLabel(field)))
    .filter((field) => {
      const value = values[field.key];
      return value === true || value === "true" || value === "yes" || value === "1";
    })
    .map(fieldLabel)
    .join(" / ") || "—";

  return (
    <article className="rq-print-document">
      <div className="rq-print-org">EAST AFRICAN COMMUNITY CIVIL AVIATION SAFETY AND SECURITY OVERSIGHT AGENCY</div>
      <div className="rq-print-title"><h1>{title || "Travel Requisition"}</h1><span>{reference}</span></div>
      <section><h2>A. Details of Requesting Officer and the Trip</h2><div className="rq-print-details">
        {top.map(([label, value]) => <div key={label}><b>{label}</b><span>{value || "—"}</span></div>)}
      </div></section>
      <section><h2>B. Financing of the Trip &amp; Expense Analysis</h2>
        <div className="rq-print-details rq-print-details-two">
          <div><b>Trip Funded By</b><span>{findField(fields, values, [/trip funded by/, /funded by/])}</span></div>
          <div><b>Funding Coverage</b><span>{fundingCoverage}</span></div>
        </div>
        <table className="rq-print-table"><thead><tr>{["Activity Code", "Activity Description", "Cost Centre / Department", "Account Code", "Description of Input", "Estimated Costs", "Available Budget"].map((label) => <th key={label}>{label}</th>)}</tr></thead>
          <tbody>{travelLines.length ? travelLines.map((line, index) => <tr key={index}><td>{line.activityCode}</td><td>{line.activityDescription}</td><td>{line.costCentre}</td><td>{line.accountCode}</td><td>{line.description}</td><td>{line.estimated}</td><td /></tr>) : <tr><td colSpan={7}>—</td></tr>}</tbody>
          <tfoot><tr><td colSpan={5}>TOTAL</td><td>{totalEstimated.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td><td /></tr></tfoot>
        </table>
      </section>
      <section><h2>C. Applicant’s Signature</h2><SignatureBlocks sections={sections} values={values} match={/applicant|requester|requesting officer/i} /></section>
      <section><h2>Budget Holder and Line Manager Recommendations</h2>
        <div className="rq-print-signature-pair">
          <WorkflowApprovalSignatures document={document} workflowSteps={workflowSteps} mapping={signatureSlots.budgetHolder} roleLabel="Budget Holder" showPlaceholder />
          <WorkflowApprovalSignatures document={document} workflowSteps={workflowSteps} mapping={signatureSlots.lineManager} roleLabel="Line Manager" showPlaceholder />
        </div>
      </section>
      <section><h2>D. Finance Department Verification of Budget Availability</h2><div className="rq-print-answer"><b>Is budget available?</b><span>{budgetAvailability}</span><b>Comments:</b><span>—</span></div><WorkflowApprovalSignatures document={document} workflowSteps={workflowSteps} mapping={signatureSlots.finance} roleLabel="Finance" /></section>
      <section><h2>E. Travel Itinerary</h2>{itinerary ? <PrintableTable table={itinerary} rows={itineraryRows} /> : <p>—</p>}<WorkflowApprovalSignatures document={document} workflowSteps={workflowSteps} mapping={signatureSlots.bookingOfficer} roleLabel="Booking Officer" /></section>
      <section><h2>F. Travel Funds Requirement &amp; Computation of Funds Payable</h2>{imprestTables.length ? imprestTables.map(({ table, rows }) => <div key={table.key}><h3 className="rq-print-subheading">{fieldLabel(table)}</h3><PrintableTable table={table} rows={rows} /></div>) : <p>—</p>}<WorkflowApprovalSignatures document={document} workflowSteps={workflowSteps} mapping={signatureSlots.imprestRequest} roleLabel="Imprest Request" showPlaceholder /></section>
      <section><h2>G. Authorisation of the Trip</h2>
        <div className="rq-print-details rq-print-details-three"><div><b>Trip Authorised?</b><span>{lpoApprover ? "Yes" : "Pending"}</span></div><div><b>Authorised By</b><span>{lpoApprover?.approver || "—"}</span></div><div><b>Position / Date</b><span>{lpoApprover?.completedAt ? new Date(lpoApprover.completedAt).toLocaleDateString() : "—"}</span></div></div>
        <WorkflowApprovalSignatures document={document} workflowSteps={workflowSteps} mapping={signatureSlots.authorization} roleLabel="Trip authorization" />
      </section>
    </article>
  );
}
