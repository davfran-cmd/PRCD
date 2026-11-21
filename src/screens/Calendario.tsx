import { useEffect, useMemo, useRef, useState } from 'react';
import { Sidebar } from '../app/Sidebar';
import { A, navigate, useRoute } from '../app/router';
import { useNow, useQuery, useServices, useUi } from '../app/AppContext';
import { useCalendarState } from '../app/useCalendar';
import { buildTimeline, itemsOnDay, type TimelineItem } from '../app/timeline';
import { addDays, addMonths, endOfMonth, formatDayLong, formatMonthYear, hmToMin, isoWeekKey, parseISODate, startOfMonth, startOfWeek, WEEKDAYS_SHORT_IT, eachDay, weekdayISO, MONTHS_IT, type ISODate } from '../domain/dates';
import { Btn, Check, Icon, Seg, Swatch } from '../ui/components';
import { st } from '../ui/style';
import { EventModal } from './modals/EventModal';
import { LessonPopover } from './modals/LessonPopover';
import { AttemptModal } from './modals/AttemptModal';
import { CATEGORY_LABELS } from '../domain/settings';
import type { EventCategory } from '../domain/types';

type View = 'giorno' | 'settimana' | 'mese';
const HOUR_H = 47;

export function Calendario({ view }: { view: View }) {
  const { repo, calendar } = useServices();
  const ui = useUi();
  const now = useNow();
  const route = useRoute();
  const cal = useCalendarState();
  const settings = useQuery((r) => r.getSettings());
  const date: ISODate = route.query.get('d') || now.today;
  const [sel, setSel] = useState<ISODate>(date);
  useEffect(() => setSel(date), [date]);

  const range: [ISODate, ISODate] = useMemo(() => {
    if (view === 'giorno') return [date, date];
    if (view === 'settimana') return [startOfWeek(date), addDays(startOfWeek(date), 6)];
    const first = startOfWeek(startOfMonth(date));
    return [first, addDays(first, 41)];
  }, [view, date]);

  useEffect(() => {
    void calendar.ensureExternalRange(range[0], range[1]);
  }, [calendar, range, cal.enabled]);

  const items = useQuery((r) => buildTimeline(r, range[0], range[1]), [range[0], range[1], cal.lastSyncAt]);
  const go = (v: View, d: ISODate) => navigate(`/calendario/${v}?d=${d}`);
  const step = (dir: -1 | 1) => go(view, view === 'mese' ? addMonths(date, dir) : addDays(date, dir * (view === 'settimana' ? 7 : 1)));
  // Horizontal swipe on the calendar changes day / week / month (not from the left edge: that opens the sidebar).
  const swipe = useRef<{ x: number; y: number } | null>(null);
  const onSwipeStart = (e: React.TouchEvent) => {
    const t = e.touches[0];
    swipe.current = e.touches.length === 1 && t.clientX > 30 ? { x: t.clientX, y: t.clientY } : null;
  };
  const onSwipeEnd = (e: React.TouchEvent) => {
    const s0 = swipe.current;
    swipe.current = null;
    if (!s0 || document.querySelector('.scrim')) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - s0.x;
    const dy = t.clientY - s0.y;
    if (Math.abs(dx) > 70 && Math.abs(dx) > 2 * Math.abs(dy)) step(dx < 0 ? 1 : -1);
  };
  const openNew = (d: ISODate, time?: string) => ui.modal((close) => <EventModal date={d} time={time} onClose={close} />);

  const open = (i: TimelineItem) => {
    if (i.kind === 'lesson' && i.lessonId) ui.modal((close) => <LessonPopover lessonId={i.lessonId as string} onClose={close} />);
    else if (i.kind === 'event' && i.eventId) ui.modal((close) => <EventModal eventId={i.eventId} occurrenceDate={i.originalDate} onClose={close} />);
    else if (i.kind === 'exam' && i.attemptId && i.courseId) ui.modal((close) => <AttemptModal courseId={i.courseId as string} attemptId={i.attemptId} onClose={close} />);
    else ui.toast(`${i.title}: evento di ${i.calendarName || 'Calendario di Apple'}, solo lettura. Modificalo nell’app Calendario.`);
  };

  const title = view === 'giorno' ? formatDayLong(date) : view === 'settimana' ? `${formatMonthYear(addDays(startOfWeek(date), 3))}` : formatMonthYear(date);
  const toggleCategory = (c: EventCategory) => repo.updateSettings({ visibleCategories: settings.visibleCategories.includes(c) ? settings.visibleCategories.filter((x) => x !== c) : [...settings.visibleCategories, c] });
  const cap = title.charAt(0).toUpperCase() + title.slice(1);

  return (
    <div className="app">
      <Sidebar active="cal" />
      <main className="main" onTouchStart={onSwipeStart} onTouchEnd={onSwipeEnd}>
        <header style={st('min-height:72px;display:flex;align-items:center;gap:10px;padding:8px 20px 8px 24px;flex-wrap:wrap;flex:none')}>
          <h1 className="pt s" style={st('margin:0')}>{cap}</h1>
          {view === 'settimana' && <span className="mu" style={st('margin-left:4px')}>settimana {isoWeekKey(date).split('-W')[1].replace(/^0/, '')}</span>}
          <span style={st('flex:1')} />
          <span style={st('display:flex;gap:10px;align-items:center;flex-wrap:nowrap;flex:none')}>
            <Seg label="Vista" value={view} onChange={(v) => go(v, date)} options={[{ value: 'giorno', label: 'Giorno' }, { value: 'settimana', label: 'Settimana' }, { value: 'mese', label: 'Mese' }]} />
            <Btn onClick={() => go(view, now.today)}>Oggi</Btn>
            <button className="btn icon-btn" aria-label="Precedente" onClick={() => step(-1)}>{Icon.left}</button>
            <button className="btn icon-btn" aria-label="Successivo" onClick={() => step(1)}>{Icon.right}</button>
            <button className="btn p icon-btn" aria-label="Nuovo evento" onClick={() => openNew(view === 'mese' ? sel : date)}>{Icon.plus}</button>
          </span>
        </header>
        <div style={st('display:flex;align-items:center;gap:8px;padding:0 24px 10px;flex-wrap:wrap;flex:none')}>
          <button className={`chip ${settings.showLessons ? '' : 'off'}`} aria-pressed={settings.showLessons} onClick={() => repo.updateSettings({ showLessons: !settings.showLessons })}><Swatch color="#000" />Lezioni</button>
          {(['study', 'event', 'appointment', 'deadline'] as EventCategory[]).map((c) => (
            <button key={c} className={`chip ${settings.visibleCategories.includes(c) ? '' : 'off'}`} aria-pressed={settings.visibleCategories.includes(c)} onClick={() => toggleCategory(c)}>
              <Swatch color={c === 'study' ? '#1F35C7' : c === 'deadline' ? '#C2410C' : '#000'} hollow />
              {c === 'deadline' ? 'Scadenze ed esami' : CATEGORY_LABELS[c]}
            </button>
          ))}
          {cal.enabled && cal.calendars.filter((c) => c.visible && !c.isManaged).map((c) => (
            <button key={c.id} className="chip" onClick={() => calendar.setCalendarVisible(c.id, false)} title="Nascondi"><Swatch color={c.color} hollow />{c.sourceTitle}, {c.title}</button>
          ))}
          <A to="/calendari" style={st('font-size:13px;color:#1F35C7;text-decoration:none;margin-left:4px')}>Gestisci calendari</A>
          {cal.enabled && cal.conflicts.length > 0 && <A to="/calendari" style={st('font-size:13px;color:#B23A0A;text-decoration:none;margin-left:4px')}>{cal.conflicts.length} da risolvere con Apple</A>}
        </div>

        {view === 'mese' ? (
          <MonthView date={date} sel={sel} setSel={setSel} items={items} today={now.today} onOpen={open} onNew={openNew} />
        ) : (
          <TimeGrid days={view === 'giorno' ? [date] : eachDay(range[0], range[1])} items={items} today={now.today} nowLocal={now.local} onOpen={open} onNew={openNew} />
        )}
      </main>
    </div>
  );
}

// ------------------------------------------------------------------------------------ week / day

function laneLayout(dayItems: TimelineItem[]): Map<string, { lane: number; lanes: number }> {
  const out = new Map<string, { lane: number; lanes: number }>();
  const sorted = [...dayItems].sort((a, b) => a.start.localeCompare(b.start));
  let cluster: Array<{ i: TimelineItem; lane: number }> = [];
  let clusterEnd = '';
  const flush = () => {
    const lanes = Math.max(1, ...cluster.map((c) => c.lane + 1));
    for (const c of cluster) out.set(c.i.key, { lane: c.lane, lanes });
    cluster = [];
  };
  for (const i of sorted) {
    const end = i.end > i.start ? i.end : addMinutesIso(i.start, 30);
    if (cluster.length && i.start >= clusterEnd) flush();
    const used = new Set(cluster.filter((c) => (c.i.end > c.i.start ? c.i.end : addMinutesIso(c.i.start, 30)) > i.start).map((c) => c.lane));
    let lane = 0;
    while (used.has(lane)) lane++;
    cluster.push({ i, lane });
    clusterEnd = clusterEnd > end ? clusterEnd : end;
  }
  flush();
  return out;
}

function addMinutesIso(dt: string, m: number): string {
  const total = hmToMin(dt.slice(11, 16)) + m;
  return `${dt.slice(0, 10)}T${String(Math.min(23, Math.floor(total / 60))).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Black or white text, whichever reads better on a course colour (imported colours can be light, e.g. yellow). */
function textOn(hex: string): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return '#fff';
  const n = parseInt(m[1], 16);
  const lin = (c: number) => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  const L = 0.2126 * lin((n >> 16) & 255) + 0.7152 * lin((n >> 8) & 255) + 0.0722 * lin(n & 255);
  return (1.05 / (L + 0.05)) >= ((L + 0.05) / 0.05) ? '#fff' : '#000';
}

function eventStyle(i: TimelineItem): React.CSSProperties {
  if (i.kind === 'lesson') {
    if (i.cancelled) return { background: '#fff', border: '1.5px dashed #77776F', color: '#77776F', textDecoration: 'line-through' };
    return { background: i.color, color: textOn(i.color), ...(i.moved ? { boxShadow: 'inset 0 0 0 2px #fff' } : {}) };
  }
  if (i.kind === 'external') return { background: '#fff', border: '1.5px solid #8A8A83', color: '#000' };
  if (i.kind === 'exam' || i.category === 'deadline') return { background: '#FFF3EC', border: '1.5px solid #C2410C', color: '#7A2A08' };
  if (i.category === 'study') return { background: '#fff', border: '2px solid #1F35C7', color: '#000' };
  return { background: '#fff', border: `1.5px solid ${i.color}`, color: '#000' };
}

function TimeGrid({ days, items, today, nowLocal, onOpen, onNew }: { days: ISODate[]; items: TimelineItem[]; today: ISODate; nowLocal: string; onOpen: (i: TimelineItem) => void; onNew: (d: ISODate, t?: string) => void }) {
  const timed = items.filter((i) => !i.allDay);
  const startH = Math.min(8, ...timed.map((i) => Math.floor(hmToMin(i.start.slice(11, 16)) / 60)));
  const endH = Math.max(21, ...timed.map((i) => Math.min(23, Math.ceil(hmToMin(i.end.slice(11, 16)) / 60))));
  const hours = Array.from({ length: endH - startH + 1 }, (_, k) => startH + k);
  const height = (endH - startH) * HOUR_H;
  const allDay = items.filter((i) => i.allDay);
  const yOf = (hm: string) => ((hmToMin(hm) - startH * 60) / 60) * HOUR_H;

  return (
    <div className="scroll" style={st('flex:1;border-top:1px solid #DCDCD6')}>
      <div style={{ minWidth: days.length > 1 ? 720 : 0 }}>
        <div style={{ display: 'grid', gridTemplateColumns: `50px repeat(${days.length}, minmax(0, 1fr))`, borderBottom: '1px solid #DCDCD6', position: 'sticky', top: 0, background: '#fff', zIndex: 5, paddingLeft: 20 }}>
          <span />
          {days.map((d) => {
            const isToday = d === today;
            return (
              <button key={d} onClick={() => navigate(`/calendario/giorno?d=${d}`)} style={{ height: 50, padding: '4px 8px', display: 'flex', alignItems: 'baseline', gap: 6, color: isToday ? '#1F35C7' : '#000', background: 'transparent', border: 0, textAlign: 'left' }}>
                <span style={st('font-size:13px')}>{WEEKDAYS_SHORT_IT[weekdayISO(d) - 1]}</span>
                <span style={{ fontSize: 24, fontWeight: isToday ? 750 : 450, letterSpacing: '-0.02em' }}>{parseISODate(d).d}</span>
              </button>
            );
          })}
        </div>
        {allDay.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: `50px repeat(${days.length}, minmax(0, 1fr))`, borderBottom: '1px solid #DCDCD6', minHeight: 30, alignItems: 'start', paddingLeft: 20 }}>
            <span className="mu" style={st('font-size:11px;padding-top:8px')}>giornata</span>
            {days.map((d) => (
              <div key={d} style={st('padding:4px 2px;display:flex;flex-direction:column;gap:2px;min-width:0')}>
                {itemsOnDay(allDay, d).map((i) => <button key={i.key} onClick={() => onOpen(i)} title={i.title} style={{ ...eventStyleBar(i) }}>{i.title}</button>)}
              </div>
            ))}
          </div>
        )}
        <div style={{ position: 'relative', height, margin: '10px 0 14px', paddingLeft: 20 }}>
          <div style={{ position: 'absolute', left: 20, top: 0, width: 50 }}>
            {hours.map((h) => <div key={h} className="mu" style={{ position: 'absolute', top: (h - startH) * HOUR_H, fontSize: 11, transform: 'translateY(-7px)' }}>{h}:00</div>)}
          </div>
          <div style={{ position: 'absolute', left: 70, right: 0, top: 0, height }}>
            {hours.map((h) => <div key={h} className="hl" style={{ top: (h - startH) * HOUR_H }} />)}
          </div>
          <div style={{ position: 'absolute', left: 70, right: 0, top: 0, height, display: 'grid', gridTemplateColumns: `repeat(${days.length}, minmax(0, 1fr))` }}>
            {days.map((d) => {
              const dayItems = itemsOnDay(timed, d).filter((i) => i.start.slice(0, 10) === d);
              const lanes = laneLayout(dayItems);
              return (
                <div
                  key={d}
                  onClick={(e) => {
                    if (e.target !== e.currentTarget) return;
                    const rect = e.currentTarget.getBoundingClientRect();
                    const mins = Math.round(((e.clientY - rect.top) / HOUR_H) * 4) * 15 + startH * 60;
                    onNew(d, `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`);
                  }}
                  style={{ position: 'relative', height, borderLeft: '1px solid #EBEBE6', background: d === today ? '#FAFAFD' : 'transparent' }}
                >
                  {dayItems.map((i) => {
                    const l = lanes.get(i.key) ?? { lane: 0, lanes: 1 };
                    const top = yOf(i.start.slice(11, 16));
                    const h = i.pointInTime || i.end <= i.start ? 26 : Math.max(22, yOf(i.end.slice(11, 16)) - top - 2);
                    return (
                      <button key={i.key} className="cal-ev" onClick={() => onOpen(i)} title={`${i.title} ${i.start.slice(11, 16)}${i.end > i.start ? `–${i.end.slice(11, 16)}` : ''}`} style={{ top, height: h, left: `calc(${(l.lane / l.lanes) * 100}% + 2px)`, width: `calc(${100 / l.lanes}% - 5px)`, ...eventStyle(i), zIndex: i.conflict ? 3 : 1, outline: i.conflict ? '2px solid #C2410C' : 'none', outlineOffset: 1 }}>
                        <b>{i.title}</b>
                        <span>{i.start.slice(11, 16)}{i.end > i.start && !i.pointInTime ? `–${i.end.slice(11, 16)}` : ''}{i.cancelled ? ', annullata' : i.moved ? ', spostata' : ''}{i.conflict ? ', si sovrappone' : ''}</span>
                      </button>
                    );
                  })}
                  {d === today && nowLocal.slice(0, 10) === d && hmToMin(nowLocal.slice(11, 16)) >= startH * 60 && hmToMin(nowLocal.slice(11, 16)) <= endH * 60 && (
                    <>
                      <div style={{ position: 'absolute', left: 0, right: 0, top: yOf(nowLocal.slice(11, 16)), height: 2, background: '#1F35C7', zIndex: 4 }} />
                      <div style={{ position: 'absolute', left: -5, top: yOf(nowLocal.slice(11, 16)) - 4, width: 10, height: 10, borderRadius: 5, background: '#1F35C7', zIndex: 4 }} />
                    </>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

function eventStyleBar(i: TimelineItem): React.CSSProperties {
  const base: React.CSSProperties = { height: 22, borderRadius: 4, background: '#F2F2EF', fontSize: 12, padding: '0 6px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', border: i.kind === 'external' ? '1px solid #8A8A83' : 0, textAlign: 'left', width: '100%' };
  // Lessons without a time (imported from Procedo) sit in this row: same course colour as the timed blocks.
  if (i.kind === 'lesson') return { ...base, ...eventStyle(i), fontWeight: 550 };
  return base;
}

// ------------------------------------------------------------------------------------ month

function MonthView({ date, sel, setSel, items, today, onOpen, onNew }: { date: ISODate; sel: ISODate; setSel: (d: ISODate) => void; items: TimelineItem[]; today: ISODate; onOpen: (i: TimelineItem) => void; onNew: (d: ISODate) => void }) {
  const { repo } = useServices();
  const ui = useUi();
  const first = startOfWeek(startOfMonth(date));
  const cells = Array.from({ length: 42 }, (_, i) => addDays(first, i));
  const month = parseISODate(date).m;
  const monthItems = items.filter((i) => parseISODate(i.date).m === month);
  const selItems = itemsOnDay(items, sel);
  const lessons = monthItems.filter((i) => i.kind === 'lesson');
  const deadlines = monthItems.filter((i) => i.category === 'deadline' || i.kind === 'exam');

  return (
    <div className="stack-md" style={st('display:flex;flex:1;min-height:0;border-top:1px solid #DCDCD6')}>
      <div style={st('flex:1;min-width:0;padding-left:20px;display:flex;flex-direction:column;min-height:0')}>
        <div style={st('display:grid;grid-template-columns:repeat(7,minmax(0,1fr));height:30px;align-items:center;flex:none')}>
          {WEEKDAYS_SHORT_IT.map((w) => <span key={w} className="mu" style={st('font-size:13px;padding-left:7px')}>{w}</span>)}
        </div>
        <div style={st('display:grid;grid-template-columns:repeat(7,minmax(0,1fr));grid-template-rows:repeat(6,minmax(96px,1fr));border-top:1px solid #000;border-left:1px solid #EBEBE6;flex:1;min-height:0;overflow:auto')}>
          {cells.map((d) => {
            const inMonth = parseISODate(d).m === month;
            const dayItems = itemsOnDay(items, d);
            const lessonColors = [...new Set(dayItems.filter((i) => i.kind === 'lesson' && !i.cancelled).map((i) => i.color))];
            const rest = dayItems.filter((i) => i.kind !== 'lesson');
            const cancelled = dayItems.filter((i) => i.kind === 'lesson' && i.cancelled);
            const isToday = d === today;
            return (
              <button key={d} className="cellm" onClick={() => setSel(d)} onDoubleClick={() => onNew(d)} aria-label={`${formatDayLong(d)}, ${dayItems.length} impegni`} style={{ background: weekdayISO(d) > 5 ? '#FAFAF8' : '#fff', boxShadow: sel === d ? 'inset 0 0 0 2px #000' : 'none' }}>
                <span style={st('display:flex;align-items:center;justify-content:space-between')}>
                  <span style={{ fontSize: 16, fontWeight: isToday ? 750 : 500, color: !inMonth ? '#9A9A93' : isToday ? '#1F35C7' : '#000' }}>{parseISODate(d).d}</span>
                  {isToday && <span style={st('font-size:11px;color:#fff;background:#1F35C7;border-radius:3px;padding:0 5px')}>oggi</span>}
                </span>
                <span style={st('display:flex;gap:2px;height:5px')}>{lessonColors.map((c) => <span key={c} style={{ width: 16, height: 5, background: c }} />)}</span>
                {cancelled.slice(0, 1).map((i) => <span key={i.key} className="it" style={{ color: '#5F5F59', textDecoration: 'line-through' }}>{i.title} annullata</span>)}
                {rest.slice(0, 2).map((i) => (
                  <span key={i.key} className="it" style={i.kind === 'exam' ? { background: '#000', color: '#fff', padding: '0 4px', borderRadius: 2, fontWeight: 600 } : i.category === 'deadline' ? { color: '#B23A0A', fontWeight: 650 } : i.category === 'study' ? { color: '#1F35C7' } : i.kind === 'external' ? { color: '#5F5F59' } : undefined}>{i.title}</span>
                ))}
                {rest.length > 2 && <span className="it mu">+{rest.length - 2} altri</span>}
              </button>
            );
          })}
        </div>
      </div>
      <aside style={st('width:min(340px,40%);border-left:1px solid #DCDCD6;padding:20px 22px;display:flex;flex-direction:column;gap:6px;min-width:0;overflow:auto')}>
        <div style={st('font-size:26px;font-weight:750;letter-spacing:-0.02em;line-height:1.1')}>{formatDayLong(sel)}</div>
        <div className="mu" style={st('font-size:14px;margin-bottom:10px')}>{selItems.length ? `${selItems.length} impegni` : 'Nessun impegno. Tocca + per aggiungerne uno.'}</div>
        {selItems.map((i) => (
          <div key={i.key} style={st('display:flex;gap:10px;align-items:baseline;padding:8px 0;border-top:1px solid #EBEBE6')}>
            <span style={st('width:44px;font-weight:600;font-size:14px')}>{i.allDay ? '' : i.category === 'deadline' ? 'entro' : i.start.slice(11, 16)}</span>
            {i.category === 'deadline' && i.eventId ? <span style={st('align-self:center')}><Check on={Boolean(i.completed)} label={`Completata: ${i.title}`} onChange={(v) => void ui.run(() => repo.updateEvent(i.eventId as string, { completed: v }))} /></span> : <Swatch color={i.kind === 'external' ? '#8A8A83' : i.color} hollow={i.kind !== 'lesson'} />}
            <button onClick={() => onOpen(i)} style={{ flex: 1, textAlign: 'left', background: 'none', border: 0, padding: 0, fontSize: 14, textDecoration: i.completed || i.cancelled ? 'line-through' : 'none', color: i.completed ? '#77776F' : '#000' }}>
              {i.title}
              {i.conflict && <span style={st('color:#B23A0A;font-size:12px')}> · si sovrappone</span>}
              {i.kind === 'lesson' && !i.cancelled && <span className="mu" style={st('font-size:12px')}> {i.start.slice(11, 16)}–{i.end.slice(11, 16)}</span>}
            </button>
          </div>
        ))}
        <Btn style={st('margin-top:8px')} onClick={() => onNew(sel)}>Aggiungi evento</Btn>
        <div style={st('margin-top:auto;border-top:2px solid #000;padding-top:12px')}>
          <div style={st('font-size:15px;font-weight:650;margin-bottom:8px')}>{MONTHS_IT[month - 1].replace(/^./, (c) => c.toUpperCase())}</div>
          <Stat l="Lezioni in calendario" v={lessons.filter((l) => !l.cancelled && parseISODate(l.date).m === month).length} />
          <Stat l="Lezioni annullate" v={lessons.filter((l) => l.cancelled).length} />
          <Stat l="Scadenze ed esami" v={deadlines.length} warn />
        </div>
      </aside>
    </div>
  );
}

function Stat({ l, v, warn }: { l: string; v: number; warn?: boolean }) {
  return (
    <div style={st('display:flex;justify-content:space-between;font-size:14px;padding:4px 0')}>
      <span>{l}</span>
      <span style={{ fontWeight: 600, color: warn && v > 0 ? '#B23A0A' : '#000' }}>{v}</span>
    </div>
  );
}

export { endOfMonth };
