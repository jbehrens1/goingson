// Pure text utilities — no Node.js APIs so this file is safe to import
// from client components. Lives separate from lib/util.ts (which uses
// node:crypto) because Next.js won't bundle node: imports into client code.

/** Clean up a description string for display.
 *
 * Upstream feeds vary wildly: some give us plain text, some give us raw HTML
 * (`<p>Body...</p>`), some give us HTML that's been HTML-escaped for embedding
 * in XML/JSON (`&lt;p&gt;Body...&lt;/p&gt;`), and some give us a mix. We render
 * a max-200-char preview snippet in the events list and pipe descriptions
 * into iCal/Google Calendar bodies — markup adds no value, just noise.
 *
 * Order matters: decode entities FIRST so that escaped tags like `&lt;p&gt;`
 * become real `<p>` and get stripped by the next pass. Otherwise the escape
 * survives and renders verbatim in the UI (the bug a user reported).
 *
 * Returns undefined when the input is empty/whitespace so we don't store
 * empty-string descriptions. */
export function cleanDescription(raw: string | undefined | null): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&mdash;/g, "—")
    .replace(/&ndash;/g, "–")
    .replace(/&#x?[0-9a-f]+;/gi, "") // any remaining numeric/hex entities
    // Replace common block-level tags with a paragraph break, then strip
    // the rest. Keeps paragraph structure readable in the iCal body.
    .replace(/<\/?(p|div|br|li)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    // Collapse runs of whitespace but preserve paragraph breaks.
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return cleaned || undefined;
}
