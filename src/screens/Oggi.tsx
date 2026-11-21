import { Sidebar } from '../app/Sidebar';
import { A, navigate } from '../app/router';
import { useNow, useQuery, useServices, useUi } from '../app/AppContext';
import { dashboard, whenLabel } from '../app/queries';
import { buildTimeline, itemsOnDay, type TimelineItem } from '../app/timeline';
import { addDays, formatDayLong, formatDayLongLower, formatDayShort, formatNumberIT, WEEKDAYS_IT, parseISODate, weekdayISO } from '../domain/dates';
import { ATTENDANCE_LABELS } from '../domain/attendance';
import { Btn, Check, Empty, Glyph, Icon, Swatch } from '../ui/components';
import { st } from '../ui/style';
import { EventModal } from './modals/EventModal';
import { LessonPopover } from './modals/LessonPopover';
import { CourseModal } from './modals/CourseModal';
import { SemesterModal } from './Universita';

export function Oggi() {
  const now = useNow();
  const { repo, docs } = useServices();
  const ui = useUi();
  const dash = useQuery((r) => dashboard(r, now.local), [now.local.slice(0, 15)]);
  const settings = useQuery((r) => r.getSettings());
  const timeline = useQuery((r) => buildTimeline(r, now.today, addDays(now.today, 14)), [now.today]);
  const recents = useQuery(() => docs.recentDocuments(4), []);
  const today = itemsOnDay(timeline, now.today);
  const tomorrow = itemsOnDay(timeline, addDays(now.today, 1));
  const toConfirm = dash.toConfirmAll.length;
  const nowHM = now.local.slice(11, 16);

  const title = formatDayLong(now.today);
  const sub = dash.weekNumber
    ? `Settimana ${dash.weekNumber.current} di ${dash.weekNumber.total}. ${toConfirm === 0 ? 'Tutte le presenze registrate.' : toConfirm === 1 ? 'Una presenza da confermare.' : `${toConfirm} presenze da confermare.`}`
    : dash.semester
      ? dash.semester.name
      : 'Nessun semestre in corso';

  // upcoming days with something to do: deadlines, events, study, exams
  const upcoming = (() => {
    const out: Array<{ date: string; item: TimelineItem }> = [];
    for (let i = 1; i <= 14 && out.length < 4; i++) {
      const d = addDays(now.today, i);
      const it = itemsOnDay(timeline, d).filter((x) => x.kind !== 'lesson')[0];
      if (it) out.push({ date: d, item: it });
    }
    return out;
  })();

  const hasContent = dash.semester && dash.summaries.length > 0;
  const mark = (lessonId: string, status: 'attended' | 'absent', current: string) => void ui.run(() => repo.setAttendance(lessonId, current === status ? 'to_confirm' : status));

  // Insert the "now" marker between today's timed items.
  const rows: Array<TimelineItem | 'now'> = [];
  let nowPlaced = false;
  for (const it of today.filter((i) => !i.allDay)) {
    if (!nowPlaced && it.start.slice(11, 16) > nowHM) {
      rows.push('now');
      nowPlaced = true;
    }
    rows.push(it);
  }
  if (!nowPlaced && rows.length) rows.push('now');

  return (
    <div className="app">
      <Sidebar active="oggi" />
      <main className="main" style={st('padding:26px 28px 22px;background:#F2F2EF')}>
        <header style={st('display:flex;align-items:flex-end;justify-content:space-between;gap:24px;flex:none;flex-wrap:wrap')}>
          <div style={st('min-width:0')}>
            <h1 className="pt" style={st('white-space:nowrap')}>{title}</h1>
            <p className="mu" style={st('margin:10px 0 0;font-size:16px')}>{sub}</p>
          </div>
          <div style={st('display:flex;gap:8px;flex:none')}>
            <Btn size="lg" onClick={() => ui.modal((close) => <EventModal date={now.today} onClose={close} />)}>
              {Icon.plus}Evento
            </Btn>
            <Btn size="lg" onClick={() => void ui.run(async () => { const n = await docs.createNote('Nuova nota', null); navigate(`/documento/${n.id}`); })}>Nota</Btn>
            <A to="/presenze" className="btn lg p">Registra presenze</A>
          </div>
        </header>

        {!hasContent ? (
          <div style={st('margin-top:28px')}>
            <Empty
              title={dash.semester ? 'Nessun corso in questo semestre' : 'Benvenuto in PRCD.'}
              body={dash.semester ? 'Aggiungi un corso con giorni e orari: PRCD crea da solo tutte le lezioni fino alla fine del semestre.' : 'Tutto resta su questo dispositivo, senza account. Inizia creando il semestre in corso, poi aggiungi i corsi con i loro orari.'}
              actions={
                <>
                  <Btn size="lg" variant="p" onClick={() => ui.modal((close) => (dash.semester ? <CourseModal semesterId={dash.semester.id} onClose={close} /> : <SemesterModal onClose={close} />))}>
                    {dash.semester ? 'Aggiungi il primo corso' : 'Crea il primo semestre'}
                  </Btn>
                  <Btn size="lg" onClick={() => navigate('/impostazioni/dati')}>Importa da Procedo o ripristina un archivio</Btn>
                </>
              }
            />
          </div>
        ) : (
          <div className="bento">
            <section className="tile" style={st('grid-column:1 / span 5;grid-row:1 / span 4')}>
              <div className="th">
                <h2>Oggi</h2>
                <A to="/calendario">Apri calendario</A>
              </div>
              {!today.length && <p className="mu" style={st('margin:8px 0')}>Nessuna lezione né impegno oggi.</p>}
              <div style={st('overflow:auto;min-height:0')}>
                {today.filter((i) => i.allDay).map((i) => (
                  <div key={i.key} className="ev" style={st('min-height:44px')}>
                    <span className="tm" style={st('font-size:12px')}>giornata</span>
                    <Swatch color={i.color} hollow />
                    <span className="nm"><b>{i.title}</b><span>{i.subtitle}</span></span>
                    <span />
                  </div>
                ))}
                {rows.map((r, idx) =>
                  r === 'now' ? (
                    <div key={`now${idx}`} style={st('display:flex;align-items:center;gap:12px;height:26px;color:#1F35C7;font-size:13px;font-weight:650')}>
                      <span style={st('width:52px')}>{nowHM}</span>
                      <span style={st('flex:1;height:2px;background:#1F35C7')} />
                    </div>
                  ) : (
                    <TodayRow key={r.key} item={r} nowLocal={now.local} onMark={mark} onOpen={() => r.lessonId && ui.modal((close) => <LessonPopover lessonId={r.lessonId as string} onClose={close} />)} />
                  ),
                )}
              </div>
              <div style={st('margin-top:auto;border-top:2px solid #000;padding-top:10px;display:flex;justify-content:space-between;gap:12px;align-items:baseline')}>
                <span style={st('font-weight:650')}>Domani, {WEEKDAYS_IT[weekdayISO(addDays(now.today, 1)) - 1]}</span>
                <span className="mu" style={st('font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{tomorrowSummary(tomorrow)}</span>
              </div>
            </section>

            <section className="tile dark" style={st('grid-column:6 / span 3;grid-row:1 / span 2')}>
              <div className="th">
                <h2>Prossimo esame</h2>
                <A to="/libretto">Tutti</A>
              </div>
              {dash.nextExam ? (
                <>
                  <div style={st('display:flex;align-items:baseline;gap:8px;margin-top:2px')}>
                    <span className="big" style={st('font-size:84px')}>{dash.nextExam.days}</span>
                    <span className="mu" style={st('font-size:16px')}>{dash.nextExam.days === 1 ? 'giorno' : 'giorni'}</span>
                  </div>
                  <div style={st('margin-top:auto;line-height:1.3')}>
                    <div style={st('font-weight:600')}>{dash.nextExam.course.name}{dash.nextExam.attempt.isMidterm ? `, ${(dash.nextExam.attempt.label || 'prova in itinere').toLowerCase()}` : ''}</div>
                    <div className="mu" style={st('font-size:14px')}>{formatDayLongLower(dash.nextExam.attempt.date as string)}</div>
                  </div>
                </>
              ) : (
                <div style={st('margin-top:auto')}>
                  <div style={st('font-weight:600')}>Nessun esame in programma</div>
                  <div className="mu" style={st('font-size:14px')}>Aggiungi una data dal libretto.</div>
                </div>
              )}
            </section>

            <section className="tile" style={st('grid-column:9 / span 4;grid-row:1 / span 2')}>
              <div className="th">
                <h2>Media ponderata</h2>
                <A to="/libretto">Libretto</A>
              </div>
              <div style={st('display:flex;align-items:baseline;gap:10px')}>
                <span className="big" style={st('font-size:64px')}>{dash.averages.weighted === null ? '–' : formatNumberIT(dash.averages.weighted, 2)}</span>
                <span className="mu" style={st('font-size:14px')}>su 30</span>
              </div>
              <div style={st('margin-top:auto')}>
                <div style={st('display:flex;justify-content:space-between;font-size:14px;margin-bottom:6px')}>
                  <span><b style={st('font-weight:650')}>{dash.averages.totalCfu}</b> <span className="mu">di {settings.degreeCfuTarget} CFU</span></span>
                  <span className="mu">base di laurea <b style={st('font-weight:650;color:#000')}>{dash.averages.graduationBase === null ? '–' : formatNumberIT(dash.averages.graduationBase, 1)}</b></span>
                </div>
                <div style={st('height:6px;background:#EBEBE6;display:flex;border-radius:1px')}>
                  <div style={{ width: `${Math.min(100, (dash.averages.totalCfu / settings.degreeCfuTarget) * 100)}%`, background: '#000' }} />
                  <div style={{ width: `${Math.min(100 - (dash.averages.totalCfu / settings.degreeCfuTarget) * 100, (dash.inProgressCfu / settings.degreeCfuTarget) * 100)}%`, background: 'repeating-linear-gradient(90deg,#9A9A93 0 2px,transparent 2px 4px)' }} />
                </div>
                <div className="mu" style={st('font-size:12px;margin-top:6px')}>Tratteggio: {dash.inProgressCfu} CFU in corso questo semestre</div>
              </div>
            </section>

            <section className="tile" style={st('grid-column:6 / span 7;grid-row:3 / span 2')}>
              <div className="th">
                <h2>Prossimi giorni</h2>
                <A to="/calendario/mese">Mese</A>
              </div>
              {upcoming.length === 0 ? (
                <p className="mu" style={st('margin:8px 0')}>Nessuna scadenza o evento nei prossimi 14 giorni.</p>
              ) : (
                <div className="days">
                  {upcoming.map(({ date, item }) => (
                    <div key={item.key} className={`day ${item.completed ? 'done' : ''}`}>
                      <span className="dn" style={item.category === 'deadline' || item.kind === 'exam' ? { color: '#B23A0A' } : undefined}>{parseISODate(date).d}</span>
                      <span className="dw">{WEEKDAYS_IT[weekdayISO(date) - 1]}</span>
                      <span className="dt">{item.title}</span>
                      <span className="dm">
                        {item.category === 'deadline' && item.eventId ? (
                          <>
                            <Check on={Boolean(item.completed)} label={`Completata: ${item.title}`} onChange={(v) => void ui.run(() => repo.updateEvent(item.eventId as string, { completed: v }))} />
                            <span style={item.completed ? undefined : { color: '#B23A0A', fontWeight: 600 }}>{item.completed ? 'fatto' : `scade ${whenLabel(date, now.today)}`}</span>
                          </>
                        ) : item.allDay ? (
                          'tutto il giorno'
                        ) : (
                          item.start.slice(11, 16)
                        )}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            <section className="tile" style={st('grid-column:1 / span 5;grid-row:5 / span 2')}>
              <div className="th">
                <h2>Presenze del semestre</h2>
                <A to="/universita">Dettaglio</A>
              </div>
              <div style={st('display:flex;flex-direction:column;gap:7px;overflow:auto;min-height:0')}>
                {dash.summaries.map((s) => {
                  const p = s.stats.percentage;
                  const lo = p !== null && p < settings.attendanceThreshold;
                  const held = s.strip.filter((g) => g !== 'f');
                  return (
                    <A key={s.course.id} to={`/corso/${s.course.id}`} style={st('display:grid;grid-template-columns:112px minmax(0,1fr) 38px;align-items:center;gap:10px;color:#000;text-decoration:none')}>
                      <span style={st('display:flex;align-items:center;gap:8px;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>
                        <Swatch color={s.course.color} />
                        {s.course.name}
                      </span>
                      <span className="strip" style={st('display:flex;gap:3px;flex-wrap:nowrap;min-width:0;overflow:hidden')}>
                        {held.slice(-12).map((g, i) => <Glyph key={i} s={g} />)}
                      </span>
                      <span style={{ textAlign: 'right', fontWeight: 650, fontSize: 14, color: lo ? '#B23A0A' : '#000' }}>{p === null ? '–' : `${formatNumberIT(p, 0)}%`}</span>
                    </A>
                  );
                })}
              </div>
              <div className="mu" style={st('display:flex;gap:12px;font-size:12px;margin-top:auto;padding-top:8px;white-space:nowrap;flex-wrap:wrap')}>
                <Legend g="a" l="presente" /><Legend g="x" l="assente" /><Legend g="r" l="recuperata" /><Legend g="t" l="da confermare" />
                <span style={st('margin-left:auto')}>ultime 12 lezioni</span>
              </div>
            </section>

            <section className="tile" style={st('grid-column:6 / span 4;grid-row:5 / span 2')}>
              <div className="th">
                <h2>Da recuperare</h2>
                <span className="mu" style={st('font-size:14px')}>{dash.recoveryDone} di {dash.recoveryTotal} fatte</span>
              </div>
              {dash.toRecover.length === 0 && <p className="mu" style={st('margin:4px 0')}>Nessuna assenza da recuperare.</p>}
              {dash.toRecover.slice(0, 2).map((l) => (
                <div key={l.id} className="rc">
                  <Swatch color={l.color} />
                  <span className="nm"><b>{l.courseName}</b><span>{formatDayShort(l.date)}</span></span>
                  <Btn size="s" onClick={() => void ui.run(() => repo.setAttendance(l.id, 'recovered'), 'Segnata come recuperata')}>Recuperata</Btn>
                </div>
              ))}
              {dash.toRecover.length > 2 && <A to="/presenze" style={st('margin-top:auto;font-size:14px;color:#1F35C7;text-decoration:none')}>Altre {dash.toRecover.length - 2} lezioni</A>}
            </section>

            <section className="tile" style={st('grid-column:10 / span 3;grid-row:5 / span 2')}>
              <div className="th"><h2>Aperti di recente</h2></div>
              {recents.length === 0 && <p className="mu" style={st('margin:4px 0;font-size:14px')}>Qui trovi gli ultimi documenti che apri.</p>}
              {recents.map((d) => (
                <A key={d.id} to={`/documento/${d.id}`} className="dc">
                  {d.kind === 'pdf' ? Icon.pdf : d.kind === 'image' ? Icon.image : Icon.doc}
                  <span>{d.name}{d.kind === 'pdf' && docs.pdfState(d.id) ? <span className="mu"> p. {docs.pdfState(d.id)!.lastPage}</span> : null}</span>
                </A>
              ))}
            </section>
          </div>
        )}
      </main>
    </div>
  );
}

function Legend({ g, l }: { g: 'a' | 'x' | 'r' | 't'; l: string }) {
  return <span style={st('display:flex;gap:5px;align-items:center')}><Glyph s={g} small />{l}</span>;
}

function tomorrowSummary(items: TimelineItem[]): string {
  const lessons = items.filter((i) => i.kind === 'lesson' && !i.cancelled);
  const others = items.filter((i) => i.kind !== 'lesson');
  const parts: string[] = [];
  parts.push(lessons.length ? `${lessons.length} ${lessons.length === 1 ? 'lezione' : 'lezioni'}` : 'Nessuna lezione');
  if (others.length) parts.push(`${others[0].title}${others[0].allDay ? '' : ` alle ${others[0].start.slice(11, 16)}`}`);
  return parts.join('. ');
}

function TodayRow({ item, nowLocal, onMark, onOpen }: { item: TimelineItem; nowLocal: string; onMark: (id: string, s: 'attended' | 'absent', cur: string) => void; onOpen: () => void }) {
  const isLesson = item.kind === 'lesson' && item.lessonId;
  const started = item.start <= nowLocal;
  const att = item.attendance ?? 'to_confirm';
  const right = (() => {
    if (!isLesson) return null;
    if (item.cancelled) return <span className="mu" style={st('font-size:14px')}>Annullata</span>;
    if (started) {
      const registered = att !== 'to_confirm';
      return (
        <span style={st('display:flex;gap:6px')}>
          <button className={`btn s ${att === 'attended' ? 'onp' : ''}`} onClick={() => onMark(item.lessonId as string, 'attended', att)} aria-pressed={att === 'attended'}>Presente</button>
          <button className={`btn s ${att === 'absent' ? 'onx' : ''}`} onClick={() => onMark(item.lessonId as string, 'absent', att)} aria-pressed={att === 'absent'}>Assente</button>
          {registered && att === 'recovered' && <span className="mu" style={st('align-self:center;font-size:14px')}>{ATTENDANCE_LABELS[att]}</span>}
        </span>
      );
    }
    return <span className="mu" style={st('display:flex;align-items:center;gap:8px;font-size:14px')}><Glyph s="f" />Da svolgere</span>;
  })();
  return (
    <div className={`ev ${item.cancelled ? 'cancelled' : ''}`} style={isLesson && started && att === 'to_confirm' ? { minHeight: 72 } : undefined}>
      <span className="tm">{item.start.slice(11, 16)}<span>{item.allDay || item.pointInTime ? '' : item.end.slice(11, 16)}</span></span>
      {item.kind === 'lesson' ? <Swatch color={item.color} /> : <Swatch color={item.category === 'study' ? '#1F35C7' : item.kind === 'external' ? '#8A8A83' : '#000'} hollow />}
      <button type="button" className="nm" onClick={isLesson ? onOpen : undefined} style={st('text-align:left;background:none;border:0;padding:0;cursor:pointer')}>
        <b>{item.title}</b>
        <span>{item.conflict ? 'Si sovrappone a un altro impegno' : item.subtitle || (item.moved ? 'spostata' : item.kind === 'lesson' ? slotLabelOf(item) : '')}</span>
      </button>
      {right ?? <span />}
    </div>
  );
}

function slotLabelOf(item: TimelineItem): string {
  return item.moved ? 'spostata' : `${item.start.slice(11, 16)}–${item.end.slice(11, 16)}`;
}
