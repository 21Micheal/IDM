import { describe, expect, it } from "vitest";
import {
  activeSections,
  addedSectionIds,
  materializeSections,
  withSectionAdded,
  withSectionRemoved,
} from "./formBlocks";

function sec(id: string, onDemand = false, fields: any[] = []) {
  return { id, title: id, onDemand, fields };
}
function addBtn(sid: string, target: string, placement: string, anchor?: string) {
  return {
    id: `btn_${sid}`,
    key: `btn_${sid}`,
    type: "button",
    label: "Add",
    button: { action: "add_block", targetSectionId: target, placement, ...(anchor ? { anchorSectionId: anchor } : {}) },
  };
}
const ids = (sections: any[], values: any) => activeSections(sections, values).map((s) => s.id);

const sections = [
  sec("s1", false, [
    addBtn("end", "od_end", "end_of_form"),
    addBtn("b1", "od_b1", "below_button"),
    addBtn("b2", "od_b2", "below_button"),
  ]),
  sec("s2"),
  sec("s3", false, [addBtn("after", "od_after", "after_section", "s3")]),
  sec("od_end", true),
  sec("od_b1", true),
  sec("od_b2", true),
  sec("od_after", true),
];

// These expectations are duplicated verbatim in
// apps/templates_engine/tests/test_blocks.py — the two orderings must match.
describe("activeSections ordering (mirrors active_sections)", () => {
  it("no additions", () => {
    expect(ids(sections, {})).toEqual(["s1", "s2", "s3"]);
  });
  it("end of form", () => {
    expect(ids(sections, { __sections_added: ["od_end"] })).toEqual(["s1", "s2", "s3", "od_end"]);
  });
  it("below button", () => {
    expect(ids(sections, { __sections_added: ["od_b1"] })).toEqual(["s1", "od_b1", "s2", "s3"]);
  });
  it("after section", () => {
    expect(ids(sections, { __sections_added: ["od_after"] })).toEqual(["s1", "s2", "s3", "od_after"]);
  });
  it("two blocks under the same anchor stack in click order", () => {
    expect(ids(sections, { __sections_added: ["od_b1", "od_b2"] })).toEqual(["s1", "od_b1", "od_b2", "s2", "s3"]);
  });
  it("unknown anchor falls back to the end", () => {
    const list = [sec("s1", false, [addBtn("x", "od", "after_section", "nope")]), sec("od", true)];
    expect(ids(list, { __sections_added: ["od"] })).toEqual(["s1", "od"]);
  });
  it("duplicate ids are de-duplicated", () => {
    expect(ids(sections, { __sections_added: ["od_end", "od_end"] })).toEqual(["s1", "s2", "s3", "od_end"]);
  });
  it("unknown ids are ignored", () => {
    expect(ids(sections, { __sections_added: ["ghost"] })).toEqual(["s1", "s2", "s3"]);
  });
});

describe("addedSectionIds", () => {
  it("tolerates junk and de-duplicates", () => {
    expect(addedSectionIds({ __sections_added: "od_end, od_end,, 7" })).toEqual(["od_end", "7"]);
    expect(addedSectionIds({ __sections_added: [1, "1", " x "] })).toEqual(["1", "x"]);
    expect(addedSectionIds({ __sections_added: null })).toEqual([]);
    expect(addedSectionIds(null)).toEqual([]);
  });
  it("withSectionAdded / withSectionRemoved preserve order", () => {
    expect(withSectionAdded({ __sections_added: ["a"] }, "b")).toEqual(["a", "b"]);
    expect(withSectionAdded({ __sections_added: ["a"] }, "a")).toEqual(["a"]);
    expect(withSectionRemoved({ __sections_added: ["a", "b"] }, "a")).toEqual(["b"]);
  });
});

describe("materializeSections", () => {
  it("turns an embed reference into a table from the snapshot, stripping bindings", () => {
    const input = [sec("s1", false, [{
      key: "linked", type: "reference", referenceSource: "table",
      tableRef: {
        scope: "this_form", tableKey: "src", mode: "embed",
        snapshot: { columns: [{ key: "gross", label: "Gross", sunsystems: { role: "amount" } }], minRows: 2 },
      },
    }])];
    const out = materializeSections(input as any, false);
    expect(out[0].fields?.[0].type).toBe("table");
    expect((out[0].fields?.[0].columns as any)[0].sunsystems).toBeUndefined();
    expect(out[0].fields?.[0].minRows).toBe(2);
    expect(input[0].fields?.[0].type).toBe("reference"); // never mutated
  });
  it("turns a row_picker into text only on the server", () => {
    const input = [sec("s1", false, [{
      key: "pick", type: "reference", referenceSource: "table",
      tableRef: { scope: "this_form", tableKey: "src", mode: "row_picker", displayColumn: "name" },
    }])];
    expect(materializeSections(input as any, false)[0].fields?.[0].type).toBe("reference");
    const server = materializeSections(input as any, true)[0].fields?.[0];
    expect(server.type).toBe("text");
    expect((server as any).referenceSource).toBeUndefined();
  });
  it("effectiveSections materialises and activates", () => {
    const list = [
      sec("s1", false, [addBtn("a", "od", "end_of_form")]),
      sec("od", true, [{
        key: "linked", type: "reference", referenceSource: "table",
        tableRef: { scope: "this_form", tableKey: "src", mode: "embed", snapshot: { columns: [{ key: "v" }] } },
      }]),
    ];
    // Server-equivalent composition (row pickers become text there).
    const eff = activeSections(materializeSections(list as any, true), { __sections_added: ["od"] });
    expect(eff.map((s) => s.id)).toEqual(["s1", "od"]);
    expect(eff[1].fields?.[0].type).toBe("table");
  });
});
