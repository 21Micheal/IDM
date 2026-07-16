import { describe, expect, it } from "vitest";
import { evaluateTableColumnFormulas } from "./calculations";

describe("evaluateTableColumnFormulas", () => {
  it("evaluates later table columns against earlier calculated values in the same row", () => {
    const columns = [
      { key: "qty", type: "number" },
      { key: "unit_price", type: "currency" },
      { key: "subtotal", type: "currency", calc: { expression: "qty * unit_price" } },
      { key: "vat", type: "currency", calc: { expression: "subtotal * 0.1" } },
    ];

    const rows = [{ qty: "2", unit_price: "10" }];

    const result = evaluateTableColumnFormulas(columns as any[], rows as any[], [], {});

    expect(result[0].subtotal).toBe("20");
    expect(result[0].vat).toBe("2");
  });
});
