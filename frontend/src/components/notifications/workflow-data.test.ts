import { describe, expect, it } from "vitest";
import { phaseOrdersFromDefinition, PROCUREMENT_PHASE_ORDER } from "@/components/notifications/workflow-data";

const step = (name: string) => ({ name, order: 0, step_type: "approval", status_label: `Pending ${name}` });

const procurementDefinition = {
  version: 2,
  blocks: [
    {
      id: "switch_phase",
      kind: "switch",
      field_id: "context.phase",
      cases: [
        { id: "case_lpo", label: "lpo", values: ["lpo"], blocks: [{ kind: "approval", step: step("Procurement Approval") }] },
        {
          id: "case_rfq",
          label: "rfq",
          values: ["rfq"],
          blocks: [
            { kind: "approval", step: step("Finance Approval") },
            { kind: "notification", step: { ...step("Send Notification"), step_type: "notification" } },
          ],
        },
        {
          id: "case_req",
          label: "requisition",
          values: ["requisition"],
          blocks: [
            { kind: "approval", step: step("Manager Approval") },
            { kind: "approval", step: step("Finance Review") },
            { kind: "approval", step: step("Booking Officer Review") },
          ],
        },
      ],
      default_blocks: [{ kind: "end", outcome: "rejected" }],
    },
  ],
};

describe("phaseOrdersFromDefinition", () => {
  it("maps each switch case to the flat mirror orders it owns", () => {
    const map = phaseOrdersFromDefinition(procurementDefinition);
    expect(map).toEqual({
      lpo: [1],
      rfq: [2, 3],
      requisition: [4, 5, 6],
    });
  });

  it("returns null for legacy/linear templates", () => {
    expect(phaseOrdersFromDefinition({ version: 1, blocks: [] })).toBeNull();
    expect(phaseOrdersFromDefinition(null)).toBeNull();
    expect(
      phaseOrdersFromDefinition({
        version: 2,
        blocks: [{ kind: "approval", step: step("Only step") }],
      }),
    ).toBeNull();
  });

  it("keeps the lifecycle order used for toggling earlier phases", () => {
    expect(PROCUREMENT_PHASE_ORDER).toEqual(["requisition", "rfq", "lpo"]);
  });
});
