import { useEffect, useState, type ReactElement } from 'react';
import { A } from './router';
import { useNow, useQuery, useUi } from './AppContext';
import { dashboard } from './queries';
import { Icon } from '../ui/components';
import { st } from '../ui/style';
import { APP_NAME } from '../domain/settings';
import { GlobalSearch } from './GlobalSearch';
import { formatNumberIT } from '../domain/dates';

/** Two-letter monogram so a course never depends on colour alone ("Analisi 2" → "A2", "Meccanica razionale" → "MR"). */
export function monogram(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '?';
  const last = words[words.length - 1];
  if (words.length > 1 && /^\d+$/.test(last)) return (words[0][0] + last.slice(-1)).toUpperCase();
  if (words.length === 1) return words[0].slice(0, 2).replace(/^./, (c) => c.toUpperCase());
  return (words[0][0] + words[1][0]).toUpperCase();
}

export type Section = 'oggi' | 'cal' | 'uni' | 'doc' | 'sta' | 'imp';

const NAV: Array<{ key: Section; to: string; label: string; icon: ReactElement }> = [
  { key: 'oggi', to: '/oggi', label: 'Oggi', icon: Icon.grid },
  { key: 'cal', to: '/calendario', label: 'Calendario', icon: Icon.cal },
  { key: 'uni', to: '/universita', label: 'Università', icon: Icon.cap },
  { key: 'doc', to: '/documenti', label: 'Documenti', icon: Icon.folder },
  { key: 'sta', to: '/statistiche', label: 'Statistiche', icon: Icon.bars },
];

export function Sidebar({ active, overlay }: { active: Section; overlay?: boolean }) {
  const now = useNow();
  const dash = useQuery((r) => dashboard(r, now.local), [now.local.slice(0, 13)]);
  const threshold = useQuery((r) => r.getSettings().attendanceThreshold);
  const ui = useUi();
  const sem = dash.semester;
  const [open, setOpen] = useState(false);
  // On narrow windows the sidebar is a slide-over panel (design: Adattamenti). ⌘\ toggles it too.
  useEffect(() => {
    document.body.classList.toggle('sb-open', open);
    return () => document.body.classList.remove('sb-open');
  }, [open]);
  // overlay: the sidebar stays hidden at every width (reader) and slides over the page on demand.
  useEffect(() => {
    if (!overlay) return;
    document.body.classList.add('sb-overlay');
    return () => document.body.classList.remove('sb-overlay');
  }, [overlay]);
  // Swipe in from the left edge opens the panel, swipe left closes it (whenever the sidebar is a panel).
  useEffect(() => {
    let x0: number | null = null;
    let y0 = 0;
    const isPanel = () => document.body.classList.contains('sb-overlay') || window.matchMedia('(max-width: 1100px) and (min-width: 601px)').matches;
    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      x0 = isPanel() && (t.clientX < 24 || document.body.classList.contains('sb-open')) ? t.clientX : null;
      y0 = t.clientY;
    };
    const end = (e: TouchEvent) => {
      if (x0 === null) return;
      const t = e.changedTouches[0];
      const dx = t.clientX - x0;
      if (Math.abs(t.clientY - y0) < 60) {
        if (dx > 50) setOpen(true);
        else if (dx < -50) setOpen(false);
      }
      x0 = null;
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchend', end, { passive: true });
    return () => { window.removeEventListener('touchstart', start); window.removeEventListener('touchend', end); };
  }, []);
  useEffect(() => {
    const onToggle = () => setOpen((o) => !o);
    window.addEventListener('prcd:toggle-sidebar', onToggle);
    return () => window.removeEventListener('prcd:toggle-sidebar', onToggle);
  }, []);
  return (
    <>
    <button type="button" className="sb-toggle" aria-label="Mostra o nascondi la barra laterale" aria-expanded={open} onClick={() => setOpen((o) => !o)}>{Icon.sidebar}</button>
    <div className="sb-scrim" onClick={() => setOpen(false)} aria-hidden="true" />
    <nav className="sb" aria-label="Sezioni" onClick={(e) => (e.target as HTMLElement).closest('a') && setOpen(false)}>
      <div style={st('display:flex;align-items:center;justify-content:space-between;padding:0 4px 0 12px;height:44px')}>
        <span className="sb-title" style={st('font-size:22px;font-weight:800;letter-spacing:-0.03em')}>{APP_NAME}</span>
      </div>
      <button className="sb-search" type="button" onClick={() => ui.modal((close) => <GlobalSearch onClose={close} />)} aria-label="Cerca">
        {Icon.search}
        <span>Cerca</span>
      </button>
      <div style={st('display:flex;flex-direction:column;gap:2px')}>
        {NAV.map((n) => (
          <A key={n.key} to={n.to} className={`nv ${active === n.key ? 'on' : ''}`} aria-current={active === n.key ? 'page' : undefined} title={n.label}>
            {n.icon}
            <span className="label">{n.label}</span>
          </A>
        ))}
      </div>
      <div className="sb-section" style={st('margin:26px 12px 6px;font-size:13.2px;white-space:nowrap;color:#5F5F59;display:grid;grid-template-columns:minmax(0,1fr) auto;column-gap:10px')}>
        <span>Corsi del semestre</span>
        <span style={st('text-align:right')}>presenze</span>
      </div>
      <div style={st('display:flex;flex-direction:column')}>
        {dash.summaries.map((s) => {
          const pct = s.stats.percentage;
          const low = pct !== null && pct < threshold;
          return (
            <A key={s.course.id} to={`/corso/${s.course.id}`} className="cs" title={s.course.name}>
              <span className="sw" style={{ width: 10, height: 10, background: s.course.color }} />
              <span className="mono" style={{ background: s.course.color }} aria-hidden="true">{monogram(s.course.name)}</span>
              <span className="nm">{s.course.name}</span>
              <span className={`pc ${low ? 'lo' : ''}`} title={low ? `Sotto la soglia del ${threshold}%` : undefined}>
                {pct === null ? '–' : `${formatNumberIT(pct, 0)}%`}
              </span>
            </A>
          );
        })}
        {!dash.summaries.length && <span className="mu sb-section" style={st('padding:6px 12px;font-size:13px')}>Nessun corso</span>}
      </div>
      <div className="sb-progress" style={st('margin-top:auto;padding:0 12px 12px')}>
        {sem && dash.weekNumber ? (
          <>
            <div style={st('display:flex;justify-content:space-between;font-size:13px')}>
              <span>{sem.name}</span>
              <span className="mu">
                {dash.weekNumber.current} / {dash.weekNumber.total}
              </span>
            </div>
            <div style={st('height:3px;background:#DCDCD6;margin-top:8px')}>
              <div style={{ width: `${(dash.weekNumber.current / dash.weekNumber.total) * 100}%`, height: 3, background: '#000' }} />
            </div>
          </>
        ) : sem ? (
          <div className="mu" style={st('font-size:13px')}>{sem.name}</div>
        ) : null}
      </div>
      <A to="/impostazioni" className={`nv ${active === 'imp' ? 'on' : ''}`} aria-current={active === 'imp' ? 'page' : undefined} title="Impostazioni">
        {Icon.sliders}
        <span className="label">Impostazioni</span>
      </A>
    </nav>
    </>
  );
}
