import { useState } from 'react';
import { Sidebar } from '../app/Sidebar';
import { A, navigate, useRoute } from '../app/router';
import { useNow, useQuery, useServices, useUi } from '../app/AppContext';
import { courseSummary, librettoEntries, slotLabel } from '../app/queries';
import { ATTENDANCE_LABELS, nextAttendanceStatus } from '../domain/attendance';
import { diffDays, formatDateMedium, formatDayLongLower, formatDayShort, formatNumberIT, formatMonthYear } from '../domain/dates';
import { formatGrade } from '../domain/grades';
import { Btn, Empty, Glyph, Icon, Modal, glyphOf } from '../ui/components';
import { st } from '../ui/style';
import { CourseModal } from './modals/CourseModal';
import { LessonEditModal } from './modals/LessonEditModal';
import { AttemptModal } from './modals/AttemptModal';
import { DeleteCourseDialog } from './Universita';
import { LinkDocumentModal } from './modals/LinkDocumentModal';

type Tab = 'panoramica' | 'lezioni' | 'esame' | 'materiali';
const TABS: Array<[Tab, string]> = [['panoramica', 'Panoramica'], ['lezioni', 'Lezioni'], ['esame', 'Esame'], ['materiali', 'Materiali']];

export function Corso({ id }: { id: string }) {
  const { repo, docs } = useServices();
  const ui = useUi();
  const now = useNow();
  const route = useRoute();
  const tab = (route.query.get('tab') as Tab) || 'panoramica';
  const course = useQuery((r) => r.course(id), [id]);
  const sem = useQuery((r) => (course ? r.semester(course.semesterId) : undefined), [course?.semesterId]);
  const summary = useQuery((r) => (r.course(id) ? courseSummary(r, r.course(id)!, now.local) : null), [id, now.local.slice(0, 13)]);
  const lessons = useQuery((r) => r.lessonsForCourse(id), [id]);
  const attempts = useQuery((r) => r.attempts(id), [id]);
  const topics = useQuery((r) => r.topics(id), [id]);
  const threshold = useQuery((r) => r.getSettings().attendanceThreshold);
  const materials = useQuery(() => docs.documents({ courseId: id }), [id]);
  const entry = useQuery((r) => librettoEntries(r).find((e) => e.course.id === id), [id]);
  const [newTopic, setNewTopic] = useState('');

  if (!course || !summary) {
    return (
      <div className="app">
        <Sidebar active="uni" />
        <main className="main" style={st('padding:32px')}>
          <Empty title="Corso non trovato" body="Potrebbe essere stato eliminato." actions={<A to="/universita" className="btn lg p">Torna a Università</A>} />
        </main>
      </div>
    );
  }
  const { stats } = summary;
  const upcoming = Math.max(0, stats.upcoming);
  const total = stats.attended + stats.absent + stats.recovered + upcoming;
  const lo = stats.percentage !== null && stats.percentage < threshold;
  const lastLessons = [...lessons].filter((l) => !l.cancelled && (l.attendance !== 'to_confirm' || `${l.date}T${l.startTime}` < now.local)).sort((a, b) => `${b.date}${b.startTime}`.localeCompare(`${a.date}${a.startTime}`));
  const setTab = (t: Tab) => navigate(`/corso/${id}?tab=${t}`);

  return (
    <div className="app">
      <Sidebar active="uni" />
      <main className="main">
        <header style={st('padding:22px 32px 0;flex:none')}>
          <A to="/universita" style={st('font-size:14px;color:#1F35C7;text-decoration:none')}>Università</A>
          <div style={st('display:flex;align-items:flex-end;gap:18px;margin-top:6px;flex-wrap:wrap')}>
            <span style={{ width: 44, height: 44, background: course.color, borderRadius: 3, flex: 'none', marginBottom: 6 }} />
            <h1 className="pt" style={st('font-size:64px;line-height:0.95;font-weight:780;letter-spacing:-0.045em')}>{course.name}</h1>
            <div className="mu" style={st('font-size:14px;line-height:1.35;margin-left:12px;padding-bottom:4px')}>
              {course.cfu} CFU{course.examKind === 'eligibility' ? ', idoneità' : ''}, {sem?.name}<br />
              {sem ? `${formatDateMedium(sem.startDate)} – ${formatDateMedium(sem.endDate)}` : ''}
            </div>
            <span style={st('flex:1')} />
            <div style={st('font-size:14px;line-height:1.5;text-align:right;padding-bottom:4px')}>
              {summary.slots.length ? summary.slots.map((s, i) => <div key={i}><b>{slotLabel(s).split(' ')[0]}</b> {s.startTime}–{s.endTime}</div>) : <span className="mu">Nessun orario</span>}
            </div>
            <div style={st('display:flex;gap:8px;margin-bottom:4px')}>
              <Btn onClick={() => ui.modal((close) => <CourseModal courseId={id} semesterId={course.semesterId} onClose={close} />)}>Modifica</Btn>
              <Btn style={st('color:#B23A0A')} onClick={() => ui.modal((close) => <DeleteCourseDialog courseId={id} onDone={() => navigate('/universita')} onClose={close} />)}>Elimina…</Btn>
            </div>
          </div>
          <nav className="tabs" style={st('margin-top:18px')} role="tablist">
            {TABS.map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>{l}</button>)}
          </nav>
        </header>

        {tab === 'panoramica' && (
          <div className="scroll grid-md-1" style={st('display:grid;grid-template-columns:350px 1fr 300px;flex:1;padding-left:10px')}>
            <section className="col" style={colStyle}>
              <h2 style={chStyle}>Presenze</h2>
              <div style={st('display:flex;align-items:baseline;gap:10px')}>
                <span style={{ fontSize: 52, fontWeight: 780, letterSpacing: '-0.04em', lineHeight: 1, color: lo ? '#B23A0A' : '#000' }}>{stats.percentage === null ? '–' : `${formatNumberIT(stats.percentage, 0)}%`}</span>
                <span className="mu" style={st('font-size:14px')}>{stats.attended} su {stats.held} lezioni svolte</span>
              </div>
              {total > 0 && (
                <div style={st('display:flex;height:8px;margin:14px 0 6px;gap:2px')} aria-hidden="true">
                  <div style={{ flex: stats.attended, background: '#000' }} />
                  <div style={{ flex: stats.recovered, background: 'linear-gradient(135deg,#000 50%,#fff 50%)', boxShadow: 'inset 0 0 0 1.5px #000' }} />
                  <div style={{ flex: stats.absent, background: '#fff', boxShadow: 'inset 0 0 0 1.5px #C2410C' }} />
                  <div style={{ flex: upcoming + stats.toConfirm, background: '#EBEBE6' }} />
                </div>
              )}
              <div className="mu" style={st('display:flex;justify-content:space-between;font-size:12px')}>
                <span>{stats.absent} assenze aperte, {stats.recovered} recuperate</span>
                <span>{upcoming} da svolgere</span>
              </div>
              {stats.toConfirm > 0 && <p style={st('font-size:13px;margin:10px 0 0;color:#1F35C7')}>{stats.toConfirm} {stats.toConfirm === 1 ? 'lezione' : 'lezioni'} da confermare. <A to="/presenze" style={st('color:#1F35C7')}>Registra</A></p>}
              <div style={st('margin-top:16px;font-size:13px;font-weight:600;display:flex;justify-content:space-between')}>
                <span>Ultime lezioni</span><span className="mu" style={st('font-weight:400')}>tocca il quadrato per cambiare</span>
              </div>
              <div style={st('margin-top:6px')}>
                {lastLessons.slice(0, 7).map((l) => (
                  <div key={l.id} className="lrow" style={lrStyle}>
                    <span style={st('font-weight:600')}>{formatDayShort(l.date).replace(/ \w+$/, '')}</span>
                    <span style={st('white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{l.topic || (l.timeUnknown ? 'orario non indicato' : `${l.startTime}–${l.endTime}`)}</span>
                    <button style={cycleBtn} onClick={() => void ui.run(() => repo.setAttendance(l.id, nextAttendanceStatus(l.attendance)))} aria-label={`Stato: ${ATTENDANCE_LABELS[l.attendance]}`}>
                      <span className={`g ${glyphOf(l.attendance)}`} />
                    </button>
                  </div>
                ))}
                {lastLessons.length === 0 && <p className="mu" style={st('font-size:14px')}>Le lezioni svolte compariranno qui.</p>}
              </div>
            </section>

            <section className="col" style={colStyle}>
              <h2 style={chStyle}>Esame</h2>
              <ExamBlock entry={entry} courseId={id} attempts={attempts} today={now.today} />
              <h2 style={{ ...chStyle, marginTop: 22 }}>Studio</h2>
              <div className="mu" style={st('font-size:13px;margin:-6px 0 8px')}>Argomenti del programma, segnati da te</div>
              {topics.map((t) => (
                <div key={t.id} style={st('padding:7px 0 8px;border-top:1px solid #EBEBE6;font-size:14px')}>
                  <div style={st('display:flex;justify-content:space-between;gap:12px')}>
                    <span style={st('white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0')}>{t.title}</span>
                    <span className="mu" style={st('font-size:13px;flex:none')}>{t.progress}%</span>
                  </div>
                  <input type="range" min={0} max={100} step={5} value={t.progress} aria-label={`Avanzamento: ${t.title}`} onChange={(e) => repo.setTopicProgress(t.id, Number(e.target.value))} style={{ width: '100%', accentColor: course.color, margin: '6px 0 0' }} />
                </div>
              ))}
              <form style={st('display:flex;gap:8px;margin-top:8px')} onSubmit={(e) => { e.preventDefault(); void ui.run(() => { repo.addTopic(id, newTopic); setNewTopic(''); }); }}>
                <input className="in" style={st('flex:1;height:36px;font-size:14px')} placeholder="Aggiungi un argomento" value={newTopic} onChange={(e) => setNewTopic(e.target.value)} aria-label="Nuovo argomento" />
                <Btn size="s" disabled={!newTopic.trim()}>Aggiungi</Btn>
              </form>
            </section>

            <MaterialsColumn courseId={id} materials={materials} />
          </div>
        )}

        {tab === 'lezioni' && (
          <div className="scroll" style={st('flex:1;padding:18px 32px')}>
            <LessonsList courseId={id} nowLocal={now.local} />
          </div>
        )}

        {tab === 'esame' && (
          <div className="scroll" style={st('flex:1;padding:18px 32px;max-width:760px')}>
            <ExamBlock entry={entry} courseId={id} attempts={attempts} today={now.today} full />
          </div>
        )}

        {tab === 'materiali' && (
          <div className="scroll" style={st('flex:1;padding:18px 32px;max-width:640px')}>
            <MaterialsColumn courseId={id} materials={materials} flat />
          </div>
        )}
      </main>
    </div>
  );
}

const colStyle: React.CSSProperties = { padding: '18px 22px', borderRight: '1px solid #DCDCD6', minWidth: 0 };
const chStyle: React.CSSProperties = { margin: '0 0 12px', fontSize: 17, fontWeight: 650 };
const lrStyle: React.CSSProperties = { display: 'grid', gridTemplateColumns: '62px 1fr 44px', alignItems: 'center', minHeight: 44, borderTop: '1px solid #EBEBE6', gap: 8, fontSize: 14 };
const cycleBtn: React.CSSProperties = { width: 44, height: 44, border: 0, background: 'transparent', display: 'flex', alignItems: 'center', justifyContent: 'center' };

function ExamBlock({ entry, courseId, attempts, today, full }: { entry: ReturnType<typeof librettoEntries>[number] | undefined; courseId: string; attempts: ReturnType<ReturnType<typeof useServices>['repo']['attempts']>; today: string; full?: boolean }) {
  const ui = useUi();
  const next = entry?.next;
  const final = entry?.final;
  return (
    <>
      <div style={st('display:flex;align-items:baseline;gap:12px;border-top:2px solid #000;padding-top:12px;flex-wrap:wrap')}>
        {final ? (
          <>
            <span style={st('font-size:22px;font-weight:700')}>{formatGrade(final)}{final.lode ? ' e lode' : ''}</span>
            <span className="mu">{final.date ? formatDateMedium(final.date) : ''}{entry && entry.attemptCount > 1 ? `, ${entry.attemptCount}° tentativo` : ''}</span>
          </>
        ) : next ? (
          <>
            <span style={st('font-size:22px;font-weight:700')}>{next.isMidterm ? (next.label || 'Prova in itinere') : 'Esame'}, {formatDayLongLower(next.date as string)}</span>
            <span className="mu">{diffDays(next.date as string, today) === 0 ? 'oggi' : diffDays(next.date as string, today) > 0 ? `tra ${diffDays(next.date as string, today)} giorni` : 'passato'}</span>
          </>
        ) : (
          <span style={st('font-size:18px;font-weight:650')}>Nessuna data fissata</span>
        )}
      </div>
      <div style={st('display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap')}>
        <A to="/libretto" style={st('font-size:14px;color:#1F35C7;text-decoration:none')}>Apri nel libretto</A>
        <Btn size="s" onClick={() => ui.modal((close) => <AttemptModal courseId={courseId} onClose={close} />)}>Aggiungi tentativo o prova</Btn>
      </div>
      <div style={st('margin-top:14px;font-size:14px')}>
        {attempts.map((a) => (
          <button key={a.id} onClick={() => ui.modal((close) => <AttemptModal courseId={courseId} attemptId={a.id} onClose={close} />)} style={st('display:flex;justify-content:space-between;gap:10px;padding:8px 0;border:0;border-top:1px solid #EBEBE6;background:transparent;width:100%;text-align:left')}>
            <span>{a.isMidterm ? (a.label || 'Prova in itinere') : a.component === 'oral' ? 'Orale' : a.component === 'project' ? 'Progetto' : 'Scritto'}{a.date ? `, ${formatDayShort(a.date)}` : ''}{!full && a.outcome === 'planned' ? '' : ''}</span>
            <span style={{ fontWeight: 650, color: a.outcome === 'failed' ? '#B23A0A' : a.outcome === 'planned' ? '#5F5F59' : '#000' }}>
              {a.outcome === 'planned' ? (a.booked ? 'prenotato' : 'in programma') : a.outcome === 'withdrawn' ? 'ritirato' : a.outcome === 'failed' ? `non superato${a.grade ? ` (${a.grade})` : ''}` : a.outcome === 'rejected' ? `respinto (${a.grade})` : a.eligible && a.grade === null ? 'idoneo' : `${a.grade}${a.lode ? 'L' : ''}/30`}
            </span>
          </button>
        ))}
        {attempts.length === 0 && <p className="mu" style={st('font-size:14px')}>Ancora nessun tentativo o prova in itinere.</p>}
      </div>
    </>
  );
}

function LessonsList({ courseId, nowLocal }: { courseId: string; nowLocal: string }) {
  const { repo } = useServices();
  const ui = useUi();
  const lessons = useQuery((r) => r.lessonsForCourse(courseId), [courseId]);
  const byMonth = new Map<string, typeof lessons>();
  for (const l of lessons) byMonth.set(l.date.slice(0, 7), [...(byMonth.get(l.date.slice(0, 7)) ?? []), l]);
  if (!lessons.length) return <Empty title="Nessuna lezione" body="Aggiungi giorni e orari al corso per generare le lezioni." />;
  return (
    <div style={st('max-width:760px')}>
      {[...byMonth].map(([m, ls]) => (
        <div key={m}>
          <div style={st('font-size:13px;font-weight:650;padding:14px 0 4px')}>{formatMonthYear(`${m}-01`)}</div>
          {ls.map((l) => {
            const past = `${l.date}T${l.startTime}` < nowLocal;
            return (
              <div key={l.id} style={{ display: 'grid', gridTemplateColumns: '90px 110px 1fr auto auto', gap: 10, alignItems: 'center', minHeight: 46, borderTop: '1px solid #EBEBE6', fontSize: 14, opacity: l.cancelled ? 0.55 : 1 }}>
                <span style={{ fontWeight: 600, textDecoration: l.cancelled ? 'line-through' : 'none' }}>{formatDayShort(l.date)}</span>
                <span>{l.timeUnknown ? 'orario n.d.' : `${l.startTime}–${l.endTime}`}</span>
                <span className="mu" style={st('white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{l.cancelled ? (l.cancelReason === 'holiday' ? 'festività' : 'annullata') : l.kind === 'extra' ? 'extra' : l.isException ? 'spostata' : ''} {l.topic}</span>
                <button style={cycleBtn} disabled={l.cancelled} onClick={() => void ui.run(() => repo.setAttendance(l.id, nextAttendanceStatus(l.attendance)))} aria-label={`Presenza: ${ATTENDANCE_LABELS[l.attendance]}`} title={ATTENDANCE_LABELS[l.attendance]}>
                  <Glyph s={l.attendance === 'to_confirm' && !past ? 'f' : glyphOf(l.attendance)} />
                </button>
                <Btn size="s" onClick={() => ui.modal((close) => <LessonEditModal lessonId={l.id} onClose={close} />)}>Modifica</Btn>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function MaterialsColumn({ courseId, materials, flat }: { courseId: string; materials: ReturnType<ReturnType<typeof useServices>['docs']['documents']>; flat?: boolean }) {
  const ui = useUi();
  const notes = materials.filter((d) => d.kind === 'markdown');
  const pdfs = materials.filter((d) => d.kind === 'pdf');
  const others = materials.filter((d) => d.kind === 'image');
  const { docs } = useServices();
  const row = (d: (typeof materials)[number]) => (
    <A key={d.id} to={`/documento/${d.id}`} className="dr" style={st('display:flex;align-items:center;gap:10px;min-height:44px;border-top:1px solid #EBEBE6;font-size:14px;color:#000;text-decoration:none')}>
      {d.kind === 'pdf' ? Icon.pdf : d.kind === 'image' ? Icon.image : Icon.doc}
      <span style={st('flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis')}>{d.favorite ? '★ ' : ''}{d.name}</span>
      <span className="mu" style={st('font-size:12px')}>{d.kind === 'pdf' ? (docs.pdfState(d.id) ? `p. ${docs.pdfState(d.id)!.lastPage}` : d.pageCount ? `${d.pageCount} pp.` : '') : d.lastOpenedAt ? formatDayShort(d.lastOpenedAt.slice(0, 10)) : ''}</span>
    </A>
  );
  return (
    <section className="col" style={{ ...colStyle, borderRight: 0, paddingRight: flat ? 0 : 32 }}>
      <h2 style={{ ...chStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        Materiali
        <A to={`/documenti?corso=${courseId}`} style={st('font-size:14px;color:#1F35C7;text-decoration:none;font-weight:400')}>Cartella</A>
      </h2>
      {materials.length === 0 && <p className="mu" style={st('font-size:14px')}>Nessun documento collegato a questo corso.</p>}
      {notes.length > 0 && <div className="mu" style={st('font-size:13px;margin-bottom:4px')}>Note</div>}
      {notes.map(row)}
      {pdfs.length > 0 && <div className="mu" style={st('font-size:13px;margin:14px 0 4px')}>PDF</div>}
      {pdfs.map(row)}
      {others.length > 0 && <div className="mu" style={st('font-size:13px;margin:14px 0 4px')}>Immagini</div>}
      {others.map(row)}
      <Btn style={st('margin-top:14px;width:100%;border-style:dashed')} onClick={() => ui.modal((close) => <LinkDocumentModal courseId={courseId} onClose={close} />)}>Collega un documento</Btn>
    </section>
  );
}

export { Modal };
