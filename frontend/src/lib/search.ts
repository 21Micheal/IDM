import type { SearchHit } from "@/types";

const SEARCH_HIGHLIGHT_FIELD_PRIORITY = [
  "content",
  "text",
  "body",
  "ocr_text",
  "extracted_text",
  "description",
  "supplier",
  "title",
  "reference_number",
];

export function escapeSearchRegex(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function highlightSearchText(text: string, term: string) {
  if (!text || !term.trim()) return text;
  const regex = new RegExp(`(${escapeSearchRegex(term.trim())})`, "gi");
  return text.replace(
    regex,
    '<mark class="rounded bg-accent/20 px-0.5 text-foreground">$1</mark>',
  );
}

export function getPreferredHighlights(hit: SearchHit, term: string) {
  const normalizedTerm = term.trim();
  const searchRegex = normalizedTerm ? new RegExp(escapeSearchRegex(normalizedTerm), "i") : null;

  return Object.entries(hit.highlights ?? {})
    .filter(([, snippet]) => !searchRegex || searchRegex.test(snippet))
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
