import { describe, expect, it } from 'vitest';
import { clampPage, matchRects, pageItems, pageText, searchPdf, type PdfDocLike } from '../src/documents/pdf';
import { DocsRepo } from '../src/documents/docsRepo';
import { MemoryFileStore } from '../src/storage/fileStore';
import { seedDesign } from './helpers';

/** Builds a valid minimal PDF (Helvetica text, one line per page) with correct xref offsets. */
function makePdf(pages: string[]): Uint8Array {
  const objs: string[] = [];
  const kids = pages.map((_, i) => `${4 + i * 2} 0 R`).join(' ');
  objs.push('<< /Type /Catalog /Pages 2 0 R >>');
  objs.push(`<< /Type /Pages /Kids [${kids}] /Count ${pages.length} >>`);
  objs.push('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  pages.forEach((text, i) => {
    const content = `BT /F1 24 Tf 72 700 Td (${text.replace(/[()\\]/g, '\\$&')}) Tj ET`;
    objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`);
    objs.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  });
  let out = '%PDF-1.4\n';
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(out);
}

async function load(bytes: Uint8Array): Promise<PdfDocLike & { destroy(): Promise<void> }> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const task = pdfjs.getDocument({ data: bytes.slice(), useSystemFonts: true, verbosity: 0 });
  const doc = (await task.promise) as unknown as PdfDocLike;
  return Object.assign(doc, { destroy: () => task.destroy() });
}

describe('PDF documents', () => {
  const bytes = makePdf(['Capitolo uno: elettrostatica', 'Legge di Ampere e circuitazione', 'Induzione elettromagnetica e circuitazione']);

  it('loads a PDF from local bytes and reports its page count', async () => {
    const doc = await load(bytes);
    expect(doc.numPages).toBe(3);
    await doc.destroy();
  });

  it('extracts the text of each page', async () => {
    const doc = await load(bytes);
    expect(await pageText(doc, 1)).toContain('elettrostatica');
    expect(await pageText(doc, 2)).toContain('Ampere');
    await doc.destroy();
  });

  it('searches the text across pages, case- and accent-insensitively, reporting pages and snippets', async () => {
    const doc = await load(bytes);
    const hits = await searchPdf(doc, 'CIRCUITAZIONE');
    expect(hits.map((h) => h.page)).toEqual([2, 3]);
    expect(hits[0].snippet.toLowerCase()).toContain('circuitazione');
    expect((await searchPdf(doc, 'induzióne')).map((h) => h.page)).toEqual([3]);
    expect(await searchPdf(doc, 'nonpresente')).toEqual([]);
    expect(await searchPdf(doc, '   ')).toEqual([]);
    await doc.destroy();
  });

  it('can be aborted when the query changes', async () => {
    const doc = await load(bytes);
    const hits = await searchPdf(doc, 'circuitazione', { shouldStop: () => true });
    expect(hits).toEqual([]);
    await doc.destroy();
  });

  it('computes highlight rectangles for matching text runs', async () => {
    const doc = await load(bytes);
    const items = await pageItems(doc, 2);
    const rects = matchRects(items, 'ampere');
    expect(rects).toHaveLength(1);
    expect(rects[0].x).toBeCloseTo(72, 0);
    expect(rects[0].w).toBeGreaterThan(100);
    await doc.destroy();
  });

  it('clamps page navigation', () => {
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(99, 10)).toBe(10);
    expect(clampPage(Number.NaN, 10)).toBe(1);
    expect(clampPage(4.7, 10)).toBe(4);
  });

  it('is stored in the local file store, read back byte for byte, and remembers the reading position and bookmarks', async () => {
    const ctx = await seedDesign();
    const files = new MemoryFileStore();
    const docs = new DocsRepo(ctx.repo, files);
    const rec = await docs.addDocument({ data: bytes, fileName: 'Mazzoldi.pdf', folderId: null });
    expect(rec.kind).toBe('pdf');
    const back = new Uint8Array(await (await docs.getBlob(rec.id)).arrayBuffer());
    expect(back).toEqual(bytes);
    const doc = await load(back);
    docs.setPageCount(rec.id, doc.numPages);
    expect(docs.document(rec.id)!.pageCount).toBe(3);
    docs.savePdfState(rec.id, 2, 0);
    expect(docs.pdfState(rec.id)).toMatchObject({ lastPage: 2, zoom: 0 });
    docs.addBookmark(rec.id, 3, 'Induzione');
    expect(docs.bookmarks(rec.id)[0]).toMatchObject({ page: 3, label: 'Induzione' });
    await doc.destroy();
  });
});
