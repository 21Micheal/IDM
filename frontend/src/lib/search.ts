import type { SearchHit } from "@/types";

const SEARCH_HIGHLIGHT_FIELD_PRIORITY = [
  "extracted_text",
  "ocr_text",
  "content",
  "text",
  "body",
  "metadata_text",
  "description",
  "supplier",
  "title",
  "reference_number",
];

export function escapeSearchRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function stripSearchMarkup(value: string) {
  return String(value || "").replace(/<\/?em>/g, "");
}

export function getSearchTerms(term: string) {
  const normalized = term.trim().toLowerCase();
  const terms = normalized.match(/[\w-]+/g) ?? [];
  return Array.from(new Set(terms.filter((item) => item.length >= 2)));
}

function buildSearchRegex(term: string) {
  const normalizedTerm = term.trim();
  const parts = [
    normalizedTerm,
    ...getSearchTerms(normalizedTerm),
  ]
    .map((item) => item.trim())
    .filter(Boolean);

  const uniqueParts = Array.from(new Set(parts))
    .sort((a, b) => b.length - a.length)
    .map(escapeSearchRegex);

  return uniqueParts.length ? new RegExp(`(${uniqueParts.join("|")})`, "gi") : null;
}

export function highlightSearchText(text: string, term: string) {
  const safeText = escapeHtml(stripSearchMarkup(text));
  const regex = buildSearchRegex(term);
  if (!safeText || !regex) return safeText;

  return safeText.replace(
    regex,
    '<mark class="rounded bg-accent/20 px-0.5 text-foreground">$1</mark>',
  );
}

export function getPreferredHighlights(hit: SearchHit, term: string) {
  const searchRegex = buildSearchRegex(term);

  return Object.entries(hit.highlights ?? {})
    .filter(([, snippet]) => {
      if (!searchRegex) return true;
      searchRegex.lastIndex = 0;
      return searchRegex.test(stripSearchMarkup(snippet));
    })
    .sort(([fieldA], [fieldB]) => {
      const rankA = SEARCH_HIGHLIGHT_FIELD_PRIORITY.indexOf(fieldA);
      const rankB = SEARCH_HIGHLIGHT_FIELD_PRIORITY.indexOf(fieldB);
      const normalizedRankA = rankA === -1 ? SEARCH_HIGHLIGHT_FIELD_PRIORITY.length : rankA;
      const normalizedRankB = rankB === -1 ? SEARCH_HIGHLIGHT_FIELD_PRIORITY.length : rankB;
      return normalizedRankA - normalizedRankB;
    });
}

export function getQuickSearchSnippet(hit: SearchHit, term: string) {
  const preferredHighlight = getPreferredHighlights(hit, term)[0];

  if (preferredHighlight?.[1]) {
    return {
      snippet: preferredHighlight[1],
      isFallback: false,
    };
  }

  const fallbackSource = hit.supplier || hit.title || hit.reference_number;
  return {
    snippet: highlightSearchText(fallbackSource, term),
    isFallback: true,
  };
}
