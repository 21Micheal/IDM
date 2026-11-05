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

const MARK_CLASS = "rounded bg-[#FEF08A] text-[#1F2933] font-semibold px-1 py-0.5 shadow-sm";

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
  return String(value || "").replace(/<\/?(?:em|mark)[^>]*>/gi, "");
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

export function highlightSearchText(text: string, term: string): string {
  if (!text) return "";
  const raw = String(text);

  // If text already contains <mark> or <em> tags from backend search / highlight:
  if (/<(?:mark|em)[^>]*>/i.test(raw)) {
    const tokens = raw.split(/(<\/?(?:mark|em)[^>]*>)/gi);
    const regex = buildSearchRegex(term);
    let inMark = false;

    return tokens
      .map((token) => {
        if (/^<(?:mark|em)[^>]*>$/i.test(token)) {
          inMark = true;
          return `<mark class="${MARK_CLASS}">`;
        }
        if (/^<\/(?:mark|em)>$/i.test(token)) {
          inMark = false;
          return "</mark>";
        }
        const safe = escapeHtml(token);
        if (inMark || !regex) return safe;
        return safe.replace(regex, `<mark class="${MARK_CLASS}">$1</mark>`);
      })
      .join("");
  }

  // Plain text: escape HTML and highlight matching terms
  const safeText = escapeHtml(raw);
  const regex = buildSearchRegex(term);
  if (!safeText || !regex) return safeText;

  return safeText.replace(regex, `<mark class="${MARK_CLASS}">$1</mark>`);
}

export function getPreferredHighlights(hit: SearchHit, term: string) {
  const searchRegex = buildSearchRegex(term);

  return Object.entries(hit.highlights ?? {})
    .filter(([, snippet]) => {
      if (!snippet) return false;
      // If the snippet already has mark or em tags from the backend highlighter, it's a confirmed match
      if (/<(?:mark|em)[^>]*>/i.test(snippet)) return true;
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

  const fallbackSource = hit.supplier || hit.title || hit.reference_number || hit.file_name || "";
  return {
    snippet: highlightSearchText(fallbackSource, term),
    isFallback: true,
  };
}
