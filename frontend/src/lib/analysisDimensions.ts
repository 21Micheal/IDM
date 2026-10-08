/**
 * SunSystems analysis dimensions.
 *
 * Each code (Item, Project, Cost Centre, ...) belongs to one AnalysisDimensionId.
 * ANALYSIS_DIMENSIONS is the full directory; ANALYSIS_PANEL_SLOTS is the order of
 * the ten slots shown on the ledger analysis panel (see the builder's
 * "Analysis Dimensions" field), taken from the PK1 ledger setup.
 */
export interface AnalysisDimension {
  id: string;
  name: string;
}

export const ANALYSIS_DIMENSIONS: AnalysisDimension[] = [
  { id: "26", name: "ASSET CONDITION" },
  { id: "15", name: "ASSET ENGAGEMENT NUMBER" },
  { id: "28", name: "ASSET VALUE" },
  { id: "10", name: "Activity" },
  { id: "17", name: "Asset Location" },
  { id: "05", name: "Cost Centre" },
  { id: "18", name: "Currency" },
  { id: "11", name: "Donor Activity" },
  { id: "16", name: "Item Vat" },
  { id: "24", name: "LOCATION" },
  { id: "25", name: "ORGAN" },
  { id: "06", name: "Objective" },
  { id: "03", name: "Priority" },
  { id: "04", name: "Project" },
  { id: "14", name: "REVENUES & EXPENSES" },
  { id: "27", name: "Reporting Code" },
  { id: "19", name: "SUPPLIER VAT" },
  { id: "07", name: "Staff" },
  { id: "13", name: "State" },
  { id: "20", name: "Stock Category" },
  { id: "21", name: "Stock Sub-Category" },
  { id: "08", name: "Strategic Intervention" },
  { id: "22", name: "TIN NUMBER" },
  { id: "09", name: "Target" },
  { id: "12", name: "Tax" },
  { id: "23", name: "VAT REGISTRATION NUMBER" },
];

/** The ten ledger analysis slots, in on-screen order. */
export const ANALYSIS_PANEL_SLOTS: string[] = [
  "04", // 1 Project
  "05", // 2 Cost Centre
  "06", // 3 Objective
  "03", // 4 Priority
  "08", // 5 Strategic Intervention
  "09", // 6 Target
  "10", // 7 Activity
  "11", // 8 Donor Activity
  "07", // 9 Staff
  "12", // 10 Tax
];

export function analysisDimensionName(id: string | undefined): string {
  if (!id) return "";
  return ANALYSIS_DIMENSIONS.find((d) => d.id === id)?.name ?? `Dimension ${id}`;
}

/** Slot number ("1".."10") -> AnalysisDimensionId. */
export function analysisSlotDimension(slot: number): string {
  return ANALYSIS_PANEL_SLOTS[slot - 1] ?? "";
}
