import { useEffect, useState } from 'react';
import { Sidebar } from '../app/Sidebar';
import { useRoute, navigate } from '../app/router';
import { useNow, useQuery, useServices, useUi } from '../app/AppContext';
import { ATTENDANCE_LABELS } from '../domain/attendance';
import { addDays, formatDayLong, formatDayShort, startOfWeek, WEEKDAYS_IT, parseISODate, MONTHS_IT } from '../domain/dates';
import { Btn, Empty, Icon, PageHeader, glyphOf } from '../ui/components';
import { st } from '../ui/style';
import type { AttendanceStatus } from '../domain/types';
import { lessonStart } from '../domain/timetable';

const OPTS: Array<{ s: AttendanceStatus; l: string; cls: string }> = [
  { s: 'attended', l: 'Presente', cls: 'sa' },
  { s: 'absent', l: 'Assente', cls: 'sx' },
  { s: 'recovered', l: 'Recuperata', cls: 'sr2' },
  { s: 'to_confirm', l: 'Da conf.', cls: 'st2' },
];

export function Presenze() {
  const { repo } = useServices();
  const ui = useUi();
  const now = useNow();
  const route = useRoute();
  const week = startOfWeek(route.query.get('w') || now.today);
  const sem = useQuery((r) => r.currentSemester());
  const settings = useQuery((r) => r.getSettings());
  const courses = useQuery((r) => new Map(r.courses({ includeArchived: true, includeHidden: true }).map((c) => [c.id, c])), []);
  const lessons = useQuery((r) => r.lessonsInRange(week, addDays(week, 6)).filter((l) => !l.cancelled || l.attendance !== 'to_confirm'), [week]);
  const pendingAll = useQuery((r) => (sem ? r.lessonsForSemester(sem.id).filter((l) => !l.cancelled && l.attendance === 'to_confirm' && lessonStart(l) < now.local).length : 0), [sem?.id, now.local.slice(0, 13)]);
  const [sel, setSel] = useState<string | null>(null);

  const weekEnd = addDays(week, 6);
  const rangeLabel = `${parseISODate(week).d}–${parseISODate(weekEnd).d} ${MONTHS_IT[parseISODate(weekEnd).m - 1]}`;
  const toConfirmWeek = lessons.filter((l) => !l.cancelled && l.attendance === 'to_confirm' && lessonStart(l) < now.local);

  const setStatus = (id: string, s: AttendanceStatus) => void ui.run(() => repo.setAttendance(id, s));

  // Keyboard: P / A / R / T set the selected row, ArrowDown goes to the next lesson.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement).tagName;
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(tag) || e.metaKey || e.ctrlKey || e.altKey) return;
      const ids = lessons.filter((l) => !l.cancelled).map((l) => l.id);
      const i = sel ? ids.indexOf(sel) : -1;
      const k = e.key.toLowerCase();
      const map: Record<string, AttendanceStatus> = { p: 'attended', a: 'absent', r: 'recovered', t: 'to_confirm' };
      if (map[k] && sel) {
        e.preventDefault();
        setStatus(sel, map[k]);
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSel(ids[Math.min(ids.length - 1, i + 1)] ?? ids[0] ?? null);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSel(ids[Math.max(0, i - 1)] ?? null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lessons, sel]);

  const days: Array<{ date: string; items: typeof lessons }> = [];
  for (const l of lessons) {
    const last = days.at(-1);
    if (last && last.date === l.date) last.items.push(l);
    else days.push({ date: l.date, items: [l] });
  }

  return (
    <div className="app">
      <Sidebar active="uni" />
      <main className="main stack-md" style={st('display:grid;grid-template-columns:1fr 280px;overflow:hidden')}>
        <section className="scroll" style={st('padding:24px 28px 24px 32px;display:flex;flex-direction:column;min-width:0')}>
          <PageHeader
            size="m"
            title="Registra presenze"
            sub={`Settimana ${rangeLabel}. ${toConfirmWeek.length ? (toConfirmWeek.length === 1 ? '1 lezione da confermare.' : `${toConfirmWeek.length} lezioni da confermare.`) : 'Tutto registrato.'}`}
            actions={
              <>
                <button className="btn icon-btn" aria-label="Settimana precedente" onClick={() => navigate(`/presenze?w=${addDays(week, -7)}`)}>{Icon.left}</button>
                <button className="btn" onClick={() => navigate('/presenze')}>Questa settimana</button>
                <button className="btn icon-btn" aria-label="Settimana successiva" onClick={() => navigate(`/presenze?w=${addDays(week, 7)}`)}>{Icon.right}</button>
                <Btn disabled={!toConfirmWeek.length} onClick={() => void ui.run(() => repo.setAttendanceBulk(toConfirmWeek.map((l) => l.id), 'attended'), `${toConfirmWeek.length} lezioni segnate come presenti`)}>Segna da confermare come presenti</Btn>
              </>
            }
          />
          <div style={st('margin-top:18px;border-top:2px solid #000')}>
            {days.length === 0 && (
              <div style={st('padding:24px 0')}><Empty glyphs={3} title="Nessuna lezione questa settimana" body="Usa le frecce per scegliere un’altra settimana." /></div>
            )}
            {days.map((d) => (
              <div key={d.date}>
                <div style={st('font-size:13px;font-weight:650;padding:10px 0 4px')}>{formatDayLong(d.date)}</div>
                {d.items.map((l) => {
                  const c = courses.get(l.courseId);
                  const future = lessonStart(l) > now.local;
                  return (
                    <div key={l.id} className="lr" onClick={() => setSel(l.id)} style={{ background: l.attendance === 'to_confirm' && !future && !l.cancelled ? '#F4F5FD' : sel === l.id ? '#FAFAF8' : 'transparent', outline: sel === l.id ? '2px solid #1F35C7' : 'none', outlineOffset: -2, opacity: l.cancelled ? 0.5 : 1 }}>
                      <span style={st('width:44px;font-weight:600;font-size:14px')} title={l.timeUnknown ? 'Orario non indicato' : undefined}>{l.timeUnknown ? '—' : l.startTime}</span>
                      <span className="sw" style={{ background: c?.color ?? '#000' }} />
                      <span style={st('flex:1;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>
                        {c?.name}
                        {l.cancelled && <span className="mu" style={st('font-size:13px')}> · annullata</span>}
                        {l.isException && !l.cancelled && <span className="mu" style={st('font-size:13px')}> · spostata</span>}
                        {future && !l.cancelled && <span className="mu" style={st('font-size:13px')}> · da svolgere</span>}
                      </span>
                      <div className="st" role="radiogroup" aria-label={`Presenza ${c?.name ?? ''}`}>
                        {OPTS.map((o) => (
                          <button key={o.s} role="radio" aria-checked={l.attendance === o.s} disabled={l.cancelled} className={l.attendance === o.s ? o.cls : ''} onClick={() => setStatus(l.id, o.s)}>
                            <span className={`g ${glyphOf(o.s)}`} />
                            {o.l}
                          </button>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
          {pendingAll > toConfirmWeek.length && <p className="mu" style={st('font-size:13px;margin-top:14px')}>Altre {pendingAll - toConfirmWeek.length} lezioni di altre settimane aspettano una conferma.</p>}
        </section>

        <aside style={st('border-left:1px solid #DCDCD6;background:#FAFAF8;padding:24px 22px;display:flex;flex-direction:column;gap:18px;overflow:auto')}>
          <div>
            <h2 style={st('margin:0 0 10px;font-size:15px;font-weight:650')}>Alla fine della lezione</h2>
            <p className="mu" style={st('font-size:13px;margin:0')}>
              {settings.endOfLessonReminder ? 'Una notifica locale chiede “Eri a lezione?” con Presente e Assente: si risponde senza aprire l’app.' : 'Le notifiche di fine lezione sono disattivate. Puoi riattivarle da Impostazioni → Presenze.'}
            </p>
          </div>
          <div style={st('border-top:1px solid #DCDCD6;padding-top:16px;font-size:14px')}>
            <h2 style={st('margin:0 0 10px;font-size:15px;font-weight:650')}>Tastiera</h2>
            <div style={st('display:grid;grid-template-columns:44px 1fr;row-gap:6px')}>
              <b>P</b><span>presente</span><b>A</b><span>assente</span><b>R</b><span>recuperata</span><b>T</b><span>da confermare</span><b>↓ ↑</b><span>lezione successiva / precedente</span>
            </div>
            <p className="mu" style={st('font-size:12px;margin:10px 0 0')}>Tocca una riga per selezionarla.</p>
          </div>
          <p className="mu" style={st('font-size:13px;margin:auto 0 0')}>Le lezioni non registrate restano “da confermare” e non contano nella percentuale finché non le confermi.</p>
          <p className="mu" style={st('font-size:12px;margin:0')}>{ATTENDANCE_LABELS.recovered}: l’assenza è stata recuperata. {settings.recoveredCountsAsAttended ? 'Conta come presenza.' : 'Non cambia la percentuale di presenza.'} {formatDayShort(now.today)}</p>
        </aside>
      </main>
    </div>
  );
}

export { WEEKDAYS_IT };
