import test from "node:test";
import assert from "node:assert/strict";

import type { SearchHit } from "@/types";
import {
  escapeSearchRegex,
  getPreferredHighlights,
  getQuickSearchSnippet,
  highlightSearchText,
} from "./search";

function createSearchHit(overrides: Partial<SearchHit> = {}): SearchHit {
  return {
    id: "doc-1",
    score: 1,
    title: "Invoice for ACME Cement",
    reference_number: "INV-2026-001",
    document_type: "Invoice",
    supplier: "ACME Supplies",
    amount: 5000,
    status: "approved",
    document_date: "2026-04-25",
    highlights: {},
    ...overrides,
  };
}

test("escapeSearchRegex escapes regex metacharacters safely", () => {
  assert.equal(
    escapeSearchRegex("invoice(1)+draft?"),
    "invoice\\(1\\)\\+draft\\?",
  );
});

test("highlightSearchText marks the matched term", () => {
  const result = highlightSearchText("Invoice for ACME", "invoice");
  assert.match(result, /<mark/);
  assert.match(result, /Invoice/);
});

test("highlightSearchText escapes snippet html before adding marks", () => {
  const result = highlightSearchText("<script>alert('x')</script> ACME", "ACME");

  assert.match(result, /&lt;script&gt;/);
  assert.doesNotMatch(result, /<script>/);
  assert.match(result, />ACME<\/mark>/);
});

test("getPreferredHighlights keeps snippets that match any search term", () => {
  const hit = createSearchHit({
    highlights: {
      extracted_text: "The delivery sentence contains cement only.",
      title: "Invoice summary",
    },
  });

  const preferred = getPreferredHighlights(hit, "ACME cement");

  assert.equal(preferred.length, 1);
  assert.equal(preferred[0][0], "extracted_text");
});

test("getPreferredHighlights prioritizes content-like fields ahead of metadata", () => {
  const hit = createSearchHit({
    highlights: {
      title: "Invoice for <em>cement</em> order",
      extracted_text: "Payment terms for <em>cement</em> delivery within 14 days",
    },
  });

  const preferred = getPreferredHighlights(hit, "cement");

  assert.equal(preferred[0][0], "extracted_text");
  assert.match(preferred[0][1], /delivery within 14 days/);
});

test("getQuickSearchSnippet falls back to highlighted metadata when no backend snippet exists", () => {
  const hit = createSearchHit({
    supplier: "Blue Nile Trading",
    highlights: {},
  });

  const snippet = getQuickSearchSnippet(hit, "Blue");

  assert.equal(snippet.isFallback, true);
  assert.match(snippet.snippet, /<mark/);
  assert.match(snippet.snippet, /Nile Trading/);
  assert.match(snippet.snippet, />Blue<\/mark>/);
});
