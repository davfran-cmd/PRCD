import { useLayoutEffect, useRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react';
import { st } from './style';
import type { AttendanceStatus } from '../domain/types';
import type { StripGlyph } from '../domain/attendance';

export const Icon = {
  grid: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="3" width="7" height="7" /><rect x="14" y="3" width="7" height="7" /><rect x="3" y="14" width="7" height="7" /><rect x="14" y="14" width="7" height="7" /></svg>,
  cal: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="1" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>,
  cap: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M2 9l10-5 10 5-10 5z" /><path d="M6 11v5c0 1.5 3 3 6 3s6-1.5 6-3v-5" /></svg>,
  folder: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z" /></svg>,
  bars: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M5 20V11M11 20V5M17 20v-6M2 20h20" /></svg>,
  sliders: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h4M12 17h8" /><circle cx="16" cy="7" r="2" /><circle cx="10" cy="17" r="2" /></svg>,
  search: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-4-4" /></svg>,
  plus: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg>,
  left: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M15 5l-7 7 7 7" /></svg>,
  right: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M9 5l7 7-7 7" /></svg>,
  check: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" aria-hidden="true"><path d="M5 12l5 5 9-10" /></svg>,
  doc: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 3h9l4 4v14H6z" /><path d="M9 12h7M9 16h5" /></svg>,
  pdf: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M6 3h9l4 4v14H6z" /></svg>,
  dir: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="M3 6h6l2 2h10v11H3z" /></svg>,
  image: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="1" /><circle cx="9" cy="10" r="1.5" /><path d="M4 18l5-5 4 4 3-3 4 4" /></svg>,
  lock: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="1" /><path d="M8 11V7a4 4 0 018 0v4" /></svg>,
  sidebar: <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M9 4v16" /></svg>,
};

export function Glyph({ s, small }: { s: StripGlyph | 'a' | 'x' | 'r' | 't' | 'f'; small?: boolean }) {
  return <span className={`g ${s}${small ? ' sm' : ''}`} />;
}

/**
 * Attendance squares in one row that scrolls sideways. It opens on the most recent lessons (plus the next two
 * still to come, if any): scroll left to see the older ones.
 */
export function GlyphStrip({ glyphs, label, style }: { glyphs: Array<StripGlyph | 'a' | 'x' | 'r' | 't' | 'f'>; label?: string; style?: CSSProperties }) {
  const ref = useRef<HTMLSpanElement>(null);
  const key = glyphs.join('');
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !el.children.length) return;
    let last = -1;
    glyphs.forEach((g, i) => { if (g !== 'f') last = i; });
    const target = el.children[Math.min(glyphs.length - 1, Math.max(0, last + 2))] as HTMLElement;
    el.scrollLeft = Math.max(0, target.offsetLeft - el.offsetLeft + target.offsetWidth - el.clientWidth);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (
    <span ref={ref} className="gstrip" aria-label={label} style={style}>
      {glyphs.map((g, i) => <span key={i} className={`g ${g} lg`} />)}
    </span>
  );
}

const STATUS_GLYPH: Record<AttendanceStatus, 'a' | 'x' | 'r' | 't'> = { attended: 'a', absent: 'x', recovered: 'r', to_confirm: 't' };
export const glyphOf = (s: AttendanceStatus) => STATUS_GLYPH[s];

export function Swatch({ color, hollow, size = 10, style }: { color: string; hollow?: boolean; size?: number; style?: CSSProperties }) {
  return <span className="sw" style={{ width: size, height: size, ...(hollow ? { border: `1.5px solid ${color}` } : { background: color }), ...style }} />;
}

export function Btn({ variant, size, className = '', ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'p' | 'd' | 'ghost' | 'onp' | 'onx' | 'sel'; size?: 's' | 'lg' }) {
  return <button type="button" {...rest} className={`btn ${variant ?? ''} ${size ?? ''} ${className}`.trim()} />;
}

export function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: Array<{ value: T; label: string }>; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map((o) => (
        <button key={o.value} type="button" className={o.value === value ? 'on' : ''} aria-pressed={o.value === value} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" className={`tg ${on ? '' : 'off'}`} role="switch" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      <span />
    </button>
  );
}

export function Check({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button type="button" className={`ck ${on ? 'on' : ''}`} role="checkbox" aria-checked={on} aria-label={label} onClick={() => onChange(!on)}>
      {on && Icon.check}
    </button>
  );
}

export function Modal({ title, onClose, width = 620, children, actions, leading }: { title: string; onClose: () => void; width?: number; children: ReactNode; actions?: ReactNode; leading?: ReactNode }) {
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label={title} style={{ maxWidth: width, maxHeight: 'calc(100vh - 48px)' }}>
        <header style={st('justify-content:space-between;padding:14px 16px')}>
          <button type="button" className="btn ghost" onClick={onClose}>
            Annulla
          </button>
          <h2 style={st('display:flex;align-items:center;gap:10px')}>
            {leading}
            {title}
          </h2>
          <span style={st('min-width:84px;display:flex;justify-content:flex-end')}>{actions}</span>
        </header>
        <div className="body">{children}</div>
      </section>
    </div>
  );
}

/** Alert-style confirmation (design: Stati → "Conferma"). */
export function ConfirmDialog({ title, body, confirmLabel, danger, onConfirm, onClose, extra }: { title: string; body: ReactNode; confirmLabel: string; danger?: boolean; onConfirm: () => void; onClose: () => void; extra?: ReactNode }) {
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dlg" role="alertdialog" aria-labelledby="dlg-t">
        <h2 id="dlg-t">{title}</h2>
        <p>{body}</p>
        <div style={st('display:flex;flex-direction:column;gap:8px')}>
          <Btn size="lg" variant={danger ? 'd' : 'p'} onClick={() => { onConfirm(); onClose(); }}>
            {confirmLabel}
          </Btn>
          {extra}
          <Btn size="lg" variant="ghost" onClick={onClose}>
            Annulla
          </Btn>
        </div>
      </div>
    </div>
  );
}

export function Empty({ title, body, actions, glyphs = 4 }: { title: string; body: ReactNode; actions?: ReactNode; glyphs?: number }) {
  return (
    <div className="empty" style={st('max-width:520px')}>
      <div style={st('display:flex;gap:4px;margin-bottom:12px')}>
        {Array.from({ length: glyphs }, (_, i) => (
          <span key={i} style={st('width:18px;height:18px;border:1.5px dashed #9A9A93;border-radius:2px')} />
        ))}
      </div>
      <h2>{title}</h2>
      <p className="mu" style={st('font-size:14px;margin:0')}>{body}</p>
      {actions && <div style={st('display:flex;flex-direction:column;gap:8px;margin-top:14px')}>{actions}</div>}
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="row">
      <span className="lb">{label}</span>
      <span style={st('display:flex;gap:8px;align-items:center;flex-wrap:wrap;min-width:0')}>
        {children}
        {hint && <span className="mu" style={st('font-size:13px')}>{hint}</span>}
      </span>
    </div>
  );
}

export function PageHeader({ title, sub, back, actions, size = 'm' }: { title: ReactNode; sub?: ReactNode; back?: ReactNode; actions?: ReactNode; size?: 'l' | 'm' | 's' }) {
  return (
    <header style={st('display:flex;align-items:flex-end;gap:12px;flex:none;flex-wrap:wrap')}>
      <div style={st('flex:1 1 300px;min-width:0')}>
        {back}
        <h1 className={`pt ${size === 'm' ? 'm' : size === 's' ? 's' : ''}`} style={st('margin-top:2px')}>{title}</h1>
        {sub && <p className="mu" style={st('margin:8px 0 0')}>{sub}</p>}
      </div>
      <div style={st('display:flex;gap:8px;flex-wrap:wrap')}>{actions}</div>
    </header>
  );
}
