/** PDF helpers independent of the DOM (so they can be tested in Node). Rendering lives in PdfViewer.tsx. */

export interface TextItem {
  str: string;
  transform: number[];
  width: number;
  height: number;
}

export interface PdfPageLike {
  getTextContent(): Promise<{ items: Array<TextItem | { type?: string }> }>;
}

export interface PdfDocLike {
  numPages: number;
  getPage(n: number): Promise<PdfPageLike>;
}

const isText = (i: unknown): i is TextItem => typeof (i as TextItem).str === 'string';

export async function pageItems(doc: PdfDocLike, n: number): Promise<TextItem[]> {
  const page = await doc.getPage(n);
  const content = await page.getTextContent();
  return content.items.filter(isText);
}

export async function pageText(doc: PdfDocLike, n: number): Promise<string> {
  return (await pageItems(doc, n)).map((i) => i.str).join(' ').replace(/\s+/g, ' ').trim();
}

const norm = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

export interface PdfSearchHit {
  page: number;
  count: number;
  snippet: string;
}

/**
 * Searches page by page (diacritic- and case-insensitive), yielding hits as they are found so the UI
 * stays responsive on large documents. `shouldStop` lets the caller abort when the query changes.
 */
export async function searchPdf(doc: PdfDocLike, query: string, opts: { limit?: number; shouldStop?: () => boolean; onHit?: (h: PdfSearchHit) => void } = {}): Promise<PdfSearchHit[]> {
  const q = norm(query.trim());
  const hits: PdfSearchHit[] = [];
  if (!q) return hits;
  for (let p = 1; p <= doc.numPages; p++) {
    if (opts.shouldStop?.()) break;
    const text = await pageText(doc, p);
    const t = norm(text);
    let count = 0;
    let first = -1;
    for (let i = t.indexOf(q); i >= 0; i = t.indexOf(q, i + q.length)) {
      count += 1;
      if (first < 0) first = i;
    }
    if (count) {
      const hit = { page: p, count, snippet: text.slice(Math.max(0, first - 30), first + q.length + 50) };
      hits.push(hit);
      opts.onHit?.(hit);
      if (opts.limit && hits.length >= opts.limit) break;
    }
    if (p % 8 === 0) await new Promise((r) => setTimeout(r, 0)); // let the UI breathe
  }
  return hits;
}

/** Rectangles (in unscaled PDF user space: x, y-from-bottom, width, height) of text runs containing the query. */
export function matchRects(items: TextItem[], query: string): Array<{ x: number; y: number; w: number; h: number }> {
  const q = norm(query.trim());
  if (!q) return [];
  return items
    .filter((i) => norm(i.str).includes(q))
    .map((i) => ({ x: i.transform[4], y: i.transform[5], w: i.width, h: i.height || Math.abs(i.transform[3]) }));
}

export function clampPage(page: number, total: number): number {
  return Math.max(1, Math.min(total, Math.floor(page) || 1));
}
