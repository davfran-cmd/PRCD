import { useEffect, useMemo, useRef, useState } from 'react';
import 'katex/dist/katex.min.css';
import { Sidebar } from '../app/Sidebar';
import { A, navigate, useRoute } from '../app/router';
import { useQuery, useServices, useUi } from '../app/AppContext';
import { renderMarkdown, resolveReference } from '../documents/markdown';
import { PdfViewer } from '../documents/PdfViewer';
import { Btn, Empty, Icon } from '../ui/components';
import { st } from '../ui/style';
import type { DocumentRecord } from '../domain/types';
import { formatDateMedium } from '../domain/dates';

const SIZES = [16, 18.5, 21];
function loadIndexOpen(): boolean {
  try {
    return localStorage.getItem('prcd.reader.index') !== 'off';
  } catch {
    return true;
  }
}

function loadSize(): number {
  try {
    const v = Number(localStorage.getItem('prcd.reader.size'));
    return SIZES.includes(v) ? v : 18.5;
  } catch {
    return 18.5; // storage unavailable: the reader still works
  }
}

export function Reader({ id }: { id: string }) {
  const { docs } = useServices();
  const doc = useQuery(() => docs.document(id), [id]);
  const route = useRoute();
  const [immersive, setImmersive] = useState(false);
  const course = useQuery((r) => (doc?.courseId ? r.course(doc.courseId) : undefined), [doc?.courseId]);

  if (!doc) {
    return (
      <div className="app">
        <Sidebar active="doc" />
        <main className="main" style={st('padding:32px')}>
          <Empty title="Documento non trovato" body="Potrebbe essere stato spostato o eliminato." actions={<A to="/documenti" className="btn lg p">Torna ai documenti</A>} />
        </main>
      </div>
    );
  }
  const back = doc.folderId ? `/documenti?f=${doc.folderId}` : '/documenti';
  return (
    <div className="app">
      {!immersive && <Sidebar active="doc" overlay />}
      <main className="main reader-main">
        {!immersive && (
          <header style={st('display:flex;align-items:center;gap:12px;padding:12px 20px 12px 64px;border-bottom:1px solid #DCDCD6;flex:none;flex-wrap:wrap')}>
            <A to={back} className="btn s" aria-label="Indietro">{Icon.left}Libreria</A>
            {course && <span style={st('display:flex;align-items:center;gap:6px;font-size:13px')}><span className="sw" style={{ background: course.color }} />{course.name}</span>}
            <h1 style={st('margin:0;font-size:20px;font-weight:700;letter-spacing:-0.01em;flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{doc.name}</h1>
            <Btn size="s" aria-pressed={doc.favorite} onClick={() => docs.setFavorite(doc.id, !doc.favorite)}>{doc.favorite ? '★ Preferito' : '☆ Preferito'}</Btn>
          </header>
        )}
        {doc.kind === 'markdown' && <MarkdownView key={doc.id} doc={doc} anchor={route.query.get('a')} />}
        {doc.kind === 'pdf' && <PdfViewer key={doc.id} doc={doc} immersive={immersive} onImmersive={setImmersive} />}
        {doc.kind === 'image' && <ImageView doc={doc} />}
        {doc.kind === 'other' && <div style={st('padding:32px')}><Empty title="Formato non supportato" body="PRCD legge note Markdown, PDF e immagini." /></div>}
      </main>
    </div>
  );
}

function ImageView({ doc }: { doc: DocumentRecord }) {
  const { docs } = useServices();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let u: string | null = null;
    void docs.getBlob(doc.id).then((b) => { u = URL.createObjectURL(b); setUrl(u); docs.markOpened(doc.id); });
    return () => { if (u) URL.revokeObjectURL(u); };
  }, [docs, doc.id]);
  return <div className="scroll" style={st('flex:1;display:flex;align-items:center;justify-content:center;background:#E9E9E5;padding:16px')}>{url && <img src={url} alt={doc.name} style={st('max-width:100%;max-height:100%')} />}</div>;
}

function MarkdownView({ doc, anchor }: { doc: DocumentRecord; anchor: string | null }) {
  const { docs } = useServices();
  const ui = useUi();
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const body = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(loadSize);
  const [pct, setPct] = useState(0);
  const [indexOpen, setIndexOpen] = useState(loadIndexOpen);
  const toggleIndex = () => setIndexOpen((v) => {
    try {
      localStorage.setItem('prcd.reader.index', v ? 'off' : 'on');
    } catch {
      /* not persisted: fine */
    }
    return !v;
  });
  const course = useQuery((r) => (doc.courseId ? r.course(doc.courseId) : undefined), [doc.courseId]);
  const backlinks = useQuery(() => docs.backlinks(doc), [doc.id, text]);
  const version = useQuery(() => `${doc.id}:${docs.document(doc.id)?.updatedAt}`, [doc.id]);

  useEffect(() => {
    let alive = true;
    setError(null);
    docs.getText(doc.id).then((t) => { if (alive) { setText(t); docs.markOpened(doc.id); } }, (e: Error) => alive && setError(e.message));
    return () => { alive = false; };
  }, [docs, doc.id, version]);

  // Rendering can take a while on very large notes: keep it out of the first paint.
  const rendered = useMemo(() => (text === null ? null : renderMarkdown(text)), [text]);
  const index = useMemo(() => docs.pathIndex().map((e) => ({ path: e.path, id: e.doc.id })), [docs, rendered]);
  const myPath = useMemo(() => docs.pathOf(doc), [docs, doc]);

  // After the sanitized HTML is in the DOM: resolve local images, mark missing ones, wire links.
  useEffect(() => {
    const root = body.current;
    if (!root || !rendered) return;
    const urls: string[] = [];
    let alive = true;
    root.querySelectorAll<HTMLImageElement>('img[data-prcd-src]').forEach((img) => {
      const src = img.dataset.prcdSrc ?? '';
      if (img.dataset.prcdBlocked) return void replaceWithBox(img, 'Immagine bloccata', 'Il riferimento non è un percorso locale valido.');
      if (/^https?:/i.test(src)) return void replaceWithBox(img, 'Immagine remota non caricata', `${src} — PRCD non scarica nulla da internet.`);
      if (src.startsWith('data:')) { img.src = src; return; }
      const hit = resolveReference(src, myPath, index);
      if (!hit) {
        const box = replaceWithBox(img, `Immagine non trovata: ${src.split('/').pop()}`, `Cercata nella cartella della nota e in tutta la libreria. Forse è stata rinominata o non è stata importata.`);
        const btn = document.createElement('button');
        btn.textContent = 'Scegli il file';
        btn.className = 'btn s';
        btn.style.marginTop = '10px';
        btn.onclick = () => pickImage(src);
        box.appendChild(btn);
        return;
      }
      void docs.getBlob(hit.id).then((b) => {
        if (!alive) return;
        const u = URL.createObjectURL(b);
        urls.push(u);
        img.src = u;
      }, () => replaceWithBox(img, `File non leggibile: ${src}`, 'Il file è nella libreria ma non si riesce a leggerlo.'));
    });
    return () => { alive = false; urls.forEach((u) => URL.revokeObjectURL(u)); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rendered, index, myPath]);

  useEffect(() => {
    if (!rendered || !anchor) return;
    const id = `h-${anchor.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-')}`;
    requestAnimationFrame(() => document.getElementById(id)?.scrollIntoView());
  }, [rendered, anchor]);

  const pickImage = (name: string) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = () => {
      const f = input.files?.[0];
      if (!f) return;
      void ui.run(async () => {
        // The picked file is *copied* into the library next to the note under the referenced name; the original is untouched.
        await docs.addDocument({ data: f, fileName: name.split('/').pop() || f.name, folderId: doc.folderId });
        ui.toast('Immagine aggiunta alla libreria');
        setText((t) => (t === null ? t : `${t}`));
        navigate(`/documento/${doc.id}`, { replace: true });
      });
    };
    input.click();
  };

  const onClick = (e: React.MouseEvent) => {
    const a = (e.target as HTMLElement).closest('a');
    if (!a) return;
    e.preventDefault();
    const wiki = a.getAttribute('data-prcd-wiki');
    const rel = a.getAttribute('data-prcd-href');
    const href = a.getAttribute('href') ?? '';
    if (wiki) {
      const hit = resolveReference(wiki, myPath, index, { markdown: true });
      const anchorText = a.getAttribute('data-prcd-anchor');
      if (hit) navigate(`/documento/${hit.id}${anchorText ? `?a=${encodeURIComponent(anchorText)}` : ''}`);
      else ui.toast(`Nota non trovata: ${wiki}`, { error: true });
    } else if (rel) {
      const hit = resolveReference(rel, myPath, index, { markdown: true });
      const [, frag] = rel.split('#');
      if (hit) navigate(`/documento/${hit.id}${frag ? `?a=${encodeURIComponent(frag)}` : ''}`);
      else ui.toast(`Documento non trovato: ${decodeURIComponent(rel.split('#')[0])}`, { error: true });
    } else if (href.startsWith('#') && href.length > 1) document.getElementById(href.slice(1))?.scrollIntoView();
    else if (/^https?:|^mailto:|^tel:/i.test(href)) window.open(href, '_blank', 'noopener,noreferrer');
  };

  const save = () => void ui.run(async () => { await docs.updateNoteText(doc.id, draft); setEditing(false); }, 'Nota salvata');
  useEffect(() => {
    if (!editing) return;
    const onKey = (e: KeyboardEvent) => { if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); } };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, draft]);

  if (error) return <div style={st('padding:32px')}><div className="banner" role="alert"><b>Impossibile aprire la nota</b><div style={st('font-size:13.5px;margin-top:4px')}>{error}</div></div></div>;
  if (!rendered) return <p className="mu" style={st('padding:32px')}>Apro la nota…</p>;

  const words = (text ?? '').split(/\s+/).filter(Boolean).length;
  const minutes = Math.max(1, Math.round(words / 200));
  const onScroll = () => {
    const el = scroller.current;
    if (el) setPct(el.scrollHeight - el.clientHeight > 0 ? el.scrollTop / (el.scrollHeight - el.clientHeight) : 1);
  };
  const cycleSize = () => {
    const next = SIZES[(SIZES.indexOf(size) + 1) % SIZES.length];
    setSize(next);
    try {
      localStorage.setItem('prcd.reader.size', String(next));
    } catch {
      /* not persisted: fine */
    }
  };
  const fm = rendered.frontmatter;
  const tags = Array.isArray(fm.tags) ? fm.tags.map(String) : typeof fm.tags === 'string' ? fm.tags.split(/[ ,]+/) : [];
  const props = Object.entries(fm).filter(([k]) => k !== 'tags' && k !== 'title');

  return (
    <div style={st('display:flex;flex:1;min-height:0')}>
      {rendered.headings.length > 1 && !editing && indexOpen && (
        <nav aria-label="Indice" className="scroll" style={st('width:220px;border-right:1px solid #DCDCD6;padding:18px 14px;flex:none;background:#FAFAF8')}>
          <div className="mu" style={st('font-size:13px;margin-bottom:8px')}>Indice</div>
          {rendered.headings.map((h) => <button key={h.id} onClick={() => document.getElementById(h.id)?.scrollIntoView()} style={{ display: 'block', width: '100%', textAlign: 'left', background: 'none', border: 0, padding: `4px 0 4px ${(h.level - 1) * 12}px`, fontSize: 13.5, color: '#3A3A36' }}>{h.text}</button>)}
          <div className="mu" style={st('font-size:12px;margin-top:26px')}>Lettura</div>
          <div style={st('height:3px;background:#EBEBE6;margin-top:6px')}><div style={{ width: `${Math.round(pct * 100)}%`, height: 3, background: '#000' }} /></div>
          <div className="mu" style={st('font-size:12px;margin-top:6px')}>circa {minutes} {minutes === 1 ? 'minuto' : 'minuti'}</div>
        </nav>
      )}
      <div ref={scroller} onScroll={onScroll} className="scroll" style={st('flex:1;min-width:0;padding:28px 32px 60px')}>
        <div style={st('max-width:720px;margin:0 auto')}>
          <div style={st('display:flex;align-items:center;gap:8px;margin-bottom:14px;flex-wrap:wrap')}>
            {tags.map((t) => <span key={t} className="tag">{t.startsWith('#') ? t : `#${t}`}</span>)}
            <span style={st('flex:1')} />
            {rendered.headings.length > 1 && !editing && <Btn size="s" aria-pressed={indexOpen} onClick={toggleIndex}>{indexOpen ? 'Nascondi indice' : 'Indice'}</Btn>}
            <span className="mu" style={st('font-size:12px')}>{formatDateMedium(doc.updatedAt.slice(0, 10))} · {doc.size < 1024 ? `${doc.size} B` : `${Math.round(doc.size / 1024)} KB`}</span>
            <Btn size="s" aria-label="Dimensione del testo" title="Dimensione del testo" onClick={cycleSize}><span style={{ fontFamily: 'var(--serif)', fontSize: 17 }}>Aa</span></Btn>
            {doc.editable && !editing && <Btn size="s" onClick={() => { setDraft(text ?? ''); setEditing(true); }}>Modifica</Btn>}
            {!doc.editable && <span className="mu" style={st('font-size:12px')} title="Le note importate restano di sola lettura: l’originale non viene mai modificato">sola lettura</span>}
          </div>
          {editing ? (
            <>
              <textarea value={draft} onChange={(e) => setDraft(e.target.value)} aria-label="Testo della nota" style={st('width:100%;min-height:60vh;font-family:var(--mono);font-size:14px;line-height:1.6;border:1px solid #CFCFC9;border-radius:6px;padding:14px')} autoFocus />
              <div style={st('display:flex;gap:8px;margin-top:10px')}><Btn variant="p" onClick={save}>Salva</Btn><Btn onClick={() => setEditing(false)}>Annulla</Btn></div>
            </>
          ) : (
            <>
              {props.length > 0 && (
                <dl className="reader-inline-props" style={st('display:grid;grid-template-columns:120px 1fr;gap:4px 12px;font-size:13px;margin:0 0 18px;padding:10px 14px;background:#F2F2EF;border-radius:6px')}>
                  {props.map(([k, v]) => <div key={k} style={st('display:contents')}><dt className="mu">{k}</dt><dd style={st('margin:0')}>{String(typeof v === 'object' ? JSON.stringify(v) : v)}</dd></div>)}
                </dl>
              )}
              {/* HTML below is produced by renderMarkdown(): raw HTML dropped, allow-list sanitised. */}
              <div ref={body} className="reading" style={{ fontSize: size }} onClick={onClick} dangerouslySetInnerHTML={{ __html: rendered.html }} />
            </>
          )}
        </div>
      </div>
      <aside className="reader-aside scroll" aria-label="Proprietà" style={st('width:230px;border-left:1px solid #DCDCD6;padding:28px 18px 0;flex:none;font-size:13.5px')}>
        <div style={st('font-weight:650;margin-bottom:6px')}>Proprietà</div>
        <div style={st('display:grid;grid-template-columns:70px 1fr;row-gap:6px;padding-bottom:14px;border-bottom:1px solid #DCDCD6')}>
          <span className="mu">corso</span><span style={st('display:flex;align-items:center;gap:6px')}>{course ? <><span className="sw" style={{ width: 9, height: 9, background: course.color }} />{course.name}</> : '—'}</span>
          {props.map(([k, v]) => <div key={k} style={st('display:contents')}><span className="mu">{k}</span><span>{String(typeof v === 'object' ? JSON.stringify(v) : v)}</span></div>)}
          <span className="mu">tag</span><span>{tags.length ? tags.join(', ') : '—'}</span>
        </div>
        <div style={st('font-weight:650;margin:14px 0 6px')}>Note che citano questa</div>
        {backlinks.length === 0 && <div className="mu" style={st('font-size:13px')}>Nessuna.</div>}
        {backlinks.map((b) => <A key={b.id} to={`/documento/${b.id}`} className="lnk" style={st('display:block;padding:4px 0')}>{b.name}</A>)}
      </aside>
    </div>
  );
}

function replaceWithBox(img: HTMLElement, title: string, detail: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'banner';
  box.setAttribute('role', 'note');
  box.style.margin = '12px 0';
  box.style.fontFamily = 'var(--sans)';
  const b = document.createElement('div');
  b.style.fontWeight = '650';
  b.textContent = title;
  const d = document.createElement('div');
  d.style.cssText = 'font-size:13.5px;color:#3A3A36;margin-top:4px;word-break:break-all';
  d.textContent = detail;
  box.append(b, d);
  img.replaceWith(box);
  return box;
}
