import { describe, expect, it } from "vitest";
import {
  ANALYSIS_DIMENSIONS,
  ANALYSIS_PANEL_SLOTS,
  analysisDimensionName,
  analysisSlotDimension,
} from "@/lib/analysisDimensions";

describe("analysisDimensions", () => {
  it("maps the ten panel slots to the ledger dimensions in order", () => {
    expect(ANALYSIS_PANEL_SLOTS).toEqual([
      "04", "05", "06", "03", "08", "09", "10", "11", "07", "12",
    ]);
    expect(analysisSlotDimension(1)).toBe("04");
    expect(analysisSlotDimension(10)).toBe("12");
    expect(analysisSlotDimension(11)).toBe("");
  });

  it("resolves dimension names, falling back to the id", () => {
    expect(analysisDimensionName("04")).toBe("Project");
    expect(analysisDimensionName("12")).toBe("Tax");
    expect(analysisDimensionName("99")).toBe("Dimension 99");
    expect(analysisDimensionName(undefined)).toBe("");
  });

  it("has a unique id for every dimension and covers the panel slots", () => {
    const ids = ANALYSIS_DIMENSIONS.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const slot of ANALYSIS_PANEL_SLOTS) {
      expect(ids).toContain(slot);
    }
  });
});
