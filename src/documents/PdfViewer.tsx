import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjs from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { useServices, useUi } from '../app/AppContext';
import { clampPage, matchRects, pageItems, searchPdf, type PdfSearchHit, type TextItem } from './pdf';
import { Btn, Icon } from '../ui/components';
import { st } from '../ui/style';
import { WEEKDAYS_IT, todayISO, weekdayISO } from '../domain/dates';
import type { DocumentRecord } from '../domain/types';

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl; // bundled locally: works offline

const THUMB_W = 110;

interface Props {
  doc: DocumentRecord;
  immersive: boolean;
  onImmersive: (v: boolean) => void;
}

export function PdfViewer({ doc, immersive, onImmersive }: Props) {
  const { docs } = useServices();
  const ui = useUi();
  const [pdf, setPdf] = useState<PDFDocumentProxy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const saved = useMemo(() => docs.pdfState(doc.id), [docs, doc.id]);
  const [page, setPage] = useState(saved?.lastPage ?? 1);
  const [zoom, setZoom] = useState(saved?.zoom ?? 0); // 0 = fit width
  const [panel, setPanel] = useState<'none' | 'thumbs' | 'marks'>('none');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<PdfSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [bookmarks, setBookmarks] = useState(() => docs.bookmarks(doc.id));
  const [pageSize, setPageSize] = useState<{ w: number; h: number }>({ w: 595, h: 842 });
  const [containerW, setContainerW] = useState(800);
  const scroller = useRef<HTMLDivElement>(null);
  const initialScroll = useRef(true);
  const searchToken = useRef(0);

  // ---- load
  useEffect(() => {
    let alive = true;
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    let url: string | null = null;
    setLoading(true);
    setError(null);
    (async () => {
      try {
        const blob = await docs.getBlob(doc.id);
        url = URL.createObjectURL(blob);
        task = pdfjs.getDocument({ url });
        const loaded = await task.promise;
        if (!alive) return void task?.destroy();
        const p1 = await loaded.getPage(1);
        const vp = p1.getViewport({ scale: 1 });
        setPageSize({ w: vp.width, h: vp.height });
        setPdf(loaded);
        if (doc.pageCount !== loaded.numPages) docs.setPageCount(doc.id, loaded.numPages);
        docs.markOpened(doc.id);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Impossibile aprire il PDF');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
      void task?.destroy();
      if (url) URL.revokeObjectURL(url);
    };
  }, [docs, doc.id, doc.pageCount]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, [pdf]);

  const scale = zoom === 0 ? Math.max(0.2, (containerW - 32) / pageSize.w) : zoom;
  const total = pdf?.numPages ?? 0;
  const pageH = pageSize.h * scale;

  // ---- pinch with two fingers to zoom: live preview with a CSS transform, then re-render at the new scale
  const pagesBox = useRef<HTMLDivElement>(null);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let start: { d: number; cx: number; cy: number; s: number } | null = null;
    let ratio = 1;
    const dist = (t: TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 2) return;
      const rect = el.getBoundingClientRect();
      start = { d: dist(e.touches), cx: (e.touches[0].clientX + e.touches[1].clientX) / 2 - rect.left, cy: (e.touches[0].clientY + e.touches[1].clientY) / 2 - rect.top, s: scaleRef.current };
      ratio = 1;
    };
    const onMove = (e: TouchEvent) => {
      if (!start || e.touches.length !== 2) return;
      e.preventDefault();
      ratio = Math.min(4 / start.s, Math.max(0.4 / start.s, dist(e.touches) / start.d));
      const box = pagesBox.current;
      if (box) {
        box.style.transformOrigin = `${el.scrollLeft + start.cx}px ${el.scrollTop + start.cy}px`;
        box.style.transform = `scale(${ratio})`;
      }
    };
    const onEnd = () => {
      if (!start) return;
      const st0 = start;
      start = null;
      const box = pagesBox.current;
      if (box) box.style.transform = '';
      if (Math.abs(ratio - 1) < 0.03) return;
      const next = +(st0.s * ratio).toFixed(2);
      const top = (el.scrollTop + st0.cy) * ratio - st0.cy;
      const left = (el.scrollLeft + st0.cx) * ratio - st0.cx;
      setZoom(next);
      requestAnimationFrame(() => requestAnimationFrame(() => { el.scrollTop = top; el.scrollLeft = left; }));
    };
    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd);
    el.addEventListener('touchcancel', onEnd);
    return () => { el.removeEventListener('touchstart', onStart); el.removeEventListener('touchmove', onMove); el.removeEventListener('touchend', onEnd); el.removeEventListener('touchcancel', onEnd); };
  }, [pdf]);

  // ---- restore the last reading position once, after layout
  useEffect(() => {
    if (!pdf || !scroller.current || !initialScroll.current) return;
    initialScroll.current = false;
    scroller.current.scrollTop = (clampPage(saved?.lastPage ?? 1, pdf.numPages) - 1) * (pageH + 12);
    if (saved && saved.lastPage > 1) {
      const day = saved.updatedAt.slice(0, 10);
      const when = day === todayISO() ? 'oggi' : WEEKDAYS_IT[weekdayISO(day) - 1];
      ui.toast(`Ripreso da p. ${clampPage(saved.lastPage, pdf.numPages)}, dove avevi lasciato ${when}.`);
    }
  }, [pdf, pageH, saved, ui]);

  const goTo = useCallback((n: number) => {
    const el = scroller.current;
    if (!el || !pdf) return;
    const target = clampPage(n, pdf.numPages);
    el.scrollTo({ top: (target - 1) * (pageH + 12), behavior: 'auto' });
    setPage(target);
  }, [pdf, pageH]);

  const onScroll = useCallback(() => {
    const el = scroller.current;
    if (!el || !pdf) return;
    const cur = clampPage(Math.round(el.scrollTop / (pageH + 12)) + 1, pdf.numPages);
    setPage((p) => (p === cur ? p : cur));
  }, [pdf, pageH]);

  // ---- remember the reading position and zoom (debounced)
  useEffect(() => {
    if (!pdf) return;
    const t = setTimeout(() => docs.savePdfState(doc.id, page, zoom), 400);
    return () => clearTimeout(t);
  }, [docs, doc.id, pdf, page, zoom]);

  // keyboard: arrows page by page
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) return;
      if (e.key === 'ArrowRight' || e.key === 'PageDown') goTo(page + 1);
      else if (e.key === 'ArrowLeft' || e.key === 'PageUp') goTo(page - 1);
      else if (e.key === 'Escape' && immersive) onImmersive(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [goTo, page, immersive, onImmersive]);

  // ---- search (incremental, abortable)
  useEffect(() => {
    if (!pdf) return;
    const token = ++searchToken.current;
    setHits([]);
    if (!query.trim()) return void setSearching(false);
    setSearching(true);
    const t = setTimeout(() => {
      void searchPdf(pdf, query, { limit: 200, shouldStop: () => token !== searchToken.current, onHit: (h) => token === searchToken.current && setHits((cur) => [...cur, h]) }).finally(() => token === searchToken.current && setSearching(false));
    }, 300);
    return () => clearTimeout(t);
  }, [pdf, query]);

  const marked = bookmarks.find((b) => b.page === page);
  const toggleBookmark = () => {
    if (marked) docs.removeBookmark(marked.id);
    else docs.addBookmark(doc.id, page);
    setBookmarks(docs.bookmarks(doc.id));
  };

  if (error) {
    return (
      <div style={st('padding:32px')}>
        <div className="banner" role="alert">
          <div style={st('font-weight:650')}>Impossibile aprire «{doc.name}»</div>
          <div style={st('font-size:13.5px;color:#3A3A36;margin-top:4px')}>{error}. Il file potrebbe essere danneggiato o protetto da password.</div>
        </div>
      </div>
    );
  }

  return (
    <div style={st('display:flex;flex-direction:column;flex:1;min-height:0')}>
      <div style={st('display:flex;align-items:center;gap:8px;padding:8px 16px;border-bottom:1px solid #DCDCD6;flex-wrap:wrap;flex:none;background:#fff')}>
        <Btn size="s" aria-pressed={panel === 'thumbs'} className={panel === 'thumbs' ? 'sel' : ''} onClick={() => setPanel(panel === 'thumbs' ? 'none' : 'thumbs')}>Pagine</Btn>
        <Btn size="s" aria-pressed={panel === 'marks'} className={panel === 'marks' ? 'sel' : ''} onClick={() => setPanel(panel === 'marks' ? 'none' : 'marks')}>Segnalibri{bookmarks.length ? ` (${bookmarks.length})` : ''}</Btn>
        <span style={st('flex:1')} />
        <button className="btn s icon-btn" style={st('height:34px;width:34px')} aria-label="Pagina precedente" onClick={() => goTo(page - 1)} disabled={page <= 1}>{Icon.left}</button>
        <input className="in" type="number" min={1} max={total || 1} value={page} onChange={(e) => goTo(Number(e.target.value))} aria-label="Pagina" style={st('width:64px;height:34px;text-align:center;padding:0 4px')} />
        <span className="mu" style={st('font-size:14px')}>di {total || '–'}</span>
        <input type="range" min={1} max={Math.max(1, total)} value={page} onChange={(e) => goTo(Number(e.target.value))} aria-label="Scorri le pagine" style={{ width: 140, accentColor: '#000' }} />
        <button className="btn s icon-btn" style={st('height:34px;width:34px')} aria-label="Pagina successiva" onClick={() => goTo(page + 1)} disabled={page >= total}>{Icon.right}</button>
        <span style={st('width:8px')} />
        <button className="btn s" style={st('width:34px;padding:0')} aria-label="Riduci" onClick={() => setZoom(Math.max(0.4, +(scale - 0.2).toFixed(2)))}>−</button>
        <Btn size="s" className={zoom === 0 ? 'sel' : ''} onClick={() => setZoom(0)}>Adatta larghezza</Btn>
        <span className="mu" style={st('font-size:13px;width:40px;text-align:center')}>{Math.round(scale * 100)}%</span>
        <button className="btn s" style={st('width:34px;padding:0')} aria-label="Ingrandisci" onClick={() => setZoom(Math.min(4, +(scale + 0.2).toFixed(2)))}>+</button>
        <span style={st('width:8px')} />
        <Btn size="s" className={marked ? 'sel' : ''} aria-pressed={Boolean(marked)} onClick={toggleBookmark}>{marked ? '★ Segnalibro' : '☆ Segnalibro'}</Btn>
        <Btn size="s" onClick={() => onImmersive(!immersive)}>{immersive ? 'Esci da schermo intero' : 'Schermo intero'}</Btn>
        <input className="in" placeholder="Cerca nel testo" aria-label="Cerca nel testo" value={query} onChange={(e) => setQuery(e.target.value)} style={st('height:34px;width:180px;font-size:14px')} />
      </div>

      <div style={st('display:flex;flex:1;min-height:0')}>
        {panel !== 'none' && (
          <aside style={st('width:150px;border-right:1px solid #DCDCD6;overflow:auto;padding:10px;background:#FAFAF8;flex:none')}>
            {panel === 'thumbs' && pdf && <Thumbs pdf={pdf} current={page} onPick={goTo} />}
            {panel === 'marks' && (
              <div>
                {bookmarks.length === 0 && <p className="mu" style={st('font-size:13px')}>Nessun segnalibro. Usa ☆ per segnare la pagina.</p>}
                {bookmarks.map((b) => (
                  <div key={b.id} style={st('display:flex;align-items:center;gap:4px;border-top:1px solid #EBEBE6')}>
                    <button onClick={() => goTo(b.page)} style={st('flex:1;text-align:left;background:none;border:0;padding:8px 0;font-size:13px')}>{b.label}</button>
                    <button aria-label="Rimuovi segnalibro" onClick={() => { docs.removeBookmark(b.id); setBookmarks(docs.bookmarks(doc.id)); }} style={st('background:none;border:0;color:#B23A0A')}>×</button>
                  </div>
                ))}
              </div>
            )}
          </aside>
        )}
        <div ref={scroller} onScroll={onScroll} className="scroll" style={st('flex:1;min-width:0;background:#E9E9E5;padding:12px 0;touch-action:pan-x pan-y')}>
          {loading && <p className="mu" style={st('text-align:center;padding:40px')}>Apro il PDF…</p>}
          <div ref={pagesBox} style={{ minWidth: 'min-content' }}>
            {pdf && Array.from({ length: total }, (_, i) => i + 1).map((n) => <PageView key={n} pdf={pdf} n={n} scale={scale} size={pageSize} near={Math.abs(n - page) <= 2} query={query} />)}
          </div>
        </div>
        {query.trim() && (
          <aside style={st('width:230px;border-left:1px solid #DCDCD6;overflow:auto;padding:10px 12px;background:#fff;flex:none')}>
            <div className="mu" style={st('font-size:13px;margin-bottom:6px')}>{searching ? 'Cerco…' : `${hits.length} ${hits.length === 1 ? 'pagina' : 'pagine'} con «${query}»`}</div>
            {hits.map((h) => (
              <button key={h.page} onClick={() => goTo(h.page)} style={st('display:block;width:100%;text-align:left;background:none;border:0;border-top:1px solid #EBEBE6;padding:8px 0;font-size:13px')}>
                <b>p. {h.page}</b> <span className="mu">({h.count})</span>
                <span style={st('display:block;color:#3A3A36')}>{h.snippet}</span>
              </button>
            ))}
          </aside>
        )}
      </div>
    </div>
  );
}

function PageView({ pdf, n, scale, size, near, query }: { pdf: PDFDocumentProxy; n: number; scale: number; size: { w: number; h: number }; near: boolean; query: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const holder = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [rects, setRects] = useState<Array<{ x: number; y: number; w: number; h: number }>>([]);
  const [dims, setDims] = useState(size);
  const items = useRef<TextItem[] | null>(null);

  useEffect(() => {
    const el = holder.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting), { rootMargin: '600px 0px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  useEffect(() => {
    if (!(visible || near)) {
      // far from the viewport: release the bitmap
      if (canvas.current) {
        canvas.current.width = 0;
        canvas.current.height = 0;
      }
      return;
    }
    let cancelled = false;
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null;
    (async () => {
      const p = await pdf.getPage(n);
      if (cancelled || !canvas.current) return;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const vp = p.getViewport({ scale });
      const c = canvas.current;
      c.width = Math.floor(vp.width * dpr);
      c.height = Math.floor(vp.height * dpr);
      c.style.width = `${Math.floor(vp.width)}px`;
      c.style.height = `${Math.floor(vp.height)}px`;
      setDims({ w: vp.width / scale, h: vp.height / scale });
      renderTask = p.render({ canvas: c, viewport: p.getViewport({ scale: scale * dpr }) });
      try {
        await renderTask.promise;
      } catch {
        /* cancelled by a newer render */
      }
    })();
    return () => {
      cancelled = true;
      renderTask?.cancel();
    };
  }, [pdf, n, scale, visible, near]);

  useEffect(() => {
    if (!query.trim() || !(visible || near)) return void setRects([]);
    let alive = true;
    void (async () => {
      items.current ??= await pageItems(pdf as never, n);
      if (alive) setRects(matchRects(items.current, query));
    })();
    return () => {
      alive = false;
    };
  }, [pdf, n, query, visible, near]);

  const w = dims.w * scale;
  const h = dims.h * scale;
  return (
    <div ref={holder} data-page={n} style={{ width: w, height: h, margin: '0 auto 12px', background: '#fff', position: 'relative', boxShadow: '0 1px 4px rgba(0,0,0,.18)' }}>
      <canvas ref={canvas} aria-label={`Pagina ${n}`} />
      {rects.map((r, i) => (
        <span key={i} style={{ position: 'absolute', left: r.x * scale, top: h - (r.y + r.h) * scale, width: r.w * scale, height: r.h * scale * 1.1, background: 'rgba(31,53,199,.28)', mixBlendMode: 'multiply', pointerEvents: 'none' }} />
      ))}
    </div>
  );
}

function Thumbs({ pdf, current, onPick }: { pdf: PDFDocumentProxy; current: number; onPick: (n: number) => void }) {
  return (
    <div style={st('display:flex;flex-direction:column;gap:10px')}>
      {Array.from({ length: pdf.numPages }, (_, i) => i + 1).map((n) => <Thumb key={n} pdf={pdf} n={n} active={n === current} onPick={onPick} />)}
    </div>
  );
}

function Thumb({ pdf, n, active, onPick }: { pdf: PDFDocumentProxy; n: number; active: boolean; onPick: (n: number) => void }) {
  const ref = useRef<HTMLButtonElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [visible, setVisible] = useState(false);
  const done = useRef(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => e.isIntersecting && setVisible(true), { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || done.current) return;
    done.current = true;
    void (async () => {
      const p = await pdf.getPage(n);
      const vp0 = p.getViewport({ scale: 1 });
      const vp = p.getViewport({ scale: THUMB_W / vp0.width });
      const c = canvas.current;
      if (!c) return;
      c.width = vp.width;
      c.height = vp.height;
      await p.render({ canvas: c, viewport: vp }).promise;
    })();
  }, [visible, pdf, n]);
  return (
    <button ref={ref} onClick={() => onPick(n)} aria-label={`Vai a pagina ${n}`} style={{ border: active ? '2px solid #1F35C7' : '1px solid #CFCFC9', background: '#fff', padding: 0, minHeight: 130 }}>
      <canvas ref={canvas} style={{ width: THUMB_W, display: 'block' }} />
      <span style={{ fontSize: 11 }}>{n}</span>
    </button>
  );
}
