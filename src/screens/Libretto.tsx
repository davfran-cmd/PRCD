import { useMemo, useState } from 'react';
import { Sidebar } from '../app/Sidebar';
import { A } from '../app/router';
import { useNow, useQuery, useServices, useUi } from '../app/AppContext';
import { librettoAverages, librettoEntries } from '../app/queries';
import { computeAttendance } from '../domain/attendance';
import { formatDateMedium, formatDayShort, formatNumberIT } from '../domain/dates';
import { formatGrade, requiredAverageForTarget, simulateAverages, averagesFromEntries, type LibrettoEntry } from '../domain/grades';
import { Btn, Modal, PageHeader } from '../ui/components';
import { st } from '../ui/style';
import { AttemptModal } from './modals/AttemptModal';

const COLS = '22px 1fr 50px 70px 100px 90px';

export function Libretto() {
  const { repo } = useServices();
  const ui = useUi();
  const now = useNow();
  const settings = useQuery((r) => r.getSettings());
  const entries = useQuery((r) => librettoEntries(r), []);
  const avg = useQuery((r) => librettoAverages(r), []);
  const semesters = useQuery((r) => new Map(r.semesters().map((s) => [s.id, s])), []);
  const [open, setOpen] = useState<string | null>(null);

  const done = entries.filter((e) => e.final);
  const pending = entries.filter((e) => !e.final && !e.course.archived && !e.course.hidden);
  const groups = new Map<string, LibrettoEntry[]>();
  for (const e of done) {
    const g = semesters.get(e.course.semesterId)?.name ?? 'Altro';
    groups.set(g, [...(groups.get(g) ?? []), e]);
  }
  for (const [k, v] of groups) groups.set(k, v.sort((a, b) => (a.final?.date ?? '').localeCompare(b.final?.date ?? '')));

  const [sim, setSim] = useState<Record<string, number>>({});
  const base = avg.weighted === null ? 26 : Math.round(avg.weighted);
  const simGrade = (id: string) => sim[id] ?? base;
  const result = useMemo(
    () => simulateAverages(entries, pending.map((e) => ({ courseId: e.course.id, cfu: e.cfu, grade: simGrade(e.course.id) })), { lodeValue: settings.lodeValue, graduationScale: settings.graduationScale }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [entries, pending.length, sim, base, settings.lodeValue, settings.graduationScale],
  );
  const nowW = avg.weighted;
  const [target, setTarget] = useState(27);
  const gradedSum = (avg.weighted ?? 0) * avg.gradedCfu;
  const pendingGradedCfu = pending.filter((e) => e.kind === 'graded').reduce((a, e) => a + e.cfu, 0);
  const needed = requiredAverageForTarget(gradedSum, avg.gradedCfu, pendingGradedCfu, target);
  const pct = (v: number) => `${Math.max(0, Math.min(100, ((v - 18) / 12) * 100)).toFixed(1)}%`;

  const attendanceOf = (e: LibrettoEntry) => {
    const lessons = repo.lessonsForCourse(e.course.id);
    if (!lessons.length) return 'n/d';
    const p = computeAttendance(lessons, now.local, settings).percentage;
    return p === null ? 'n/d' : `${formatNumberIT(p, 0)}%`;
  };

  return (
    <div className="app">
      <Sidebar active="uni" />
      <main className="main stack-md" style={st('display:grid;grid-template-columns:1fr 330px;overflow:hidden')}>
        <section className="scroll" style={st('padding:24px 26px 24px 32px;min-width:0')}>
          <PageHeader
            size="m"
            title="Libretto"
            back={<A to="/universita" style={st('font-size:14px;color:#1F35C7;text-decoration:none')}>Università</A>}
            actions={
              <>
                <Btn onClick={() => window.print()}>Stampa o PDF</Btn>
                <Btn variant="p" onClick={() => ui.modal((close) => <PickCourseModal onClose={close} />)}>Registra esito</Btn>
              </>
            }
          />
          <div style={st('margin-top:16px;border-top:2px solid #000;overflow-x:auto')}>
            <div style={{ minWidth: 560 }}>
              <div className="tr th" style={{ gridTemplateColumns: COLS, gap: 10 }}>
                <span /><span>Esame</span><span style={st('text-align:right')}>CFU</span><span style={st('text-align:right')}>Voto</span><span>Data</span><span>Tentativi</span>
              </div>
              {done.length === 0 && <p className="mu" style={st('padding:16px 0')}>Ancora nessun esame superato. Quando registri un esito, compare qui e entra nelle medie.</p>}
              {[...groups].map(([name, es]) => (
                <div key={name}>
                  <div style={st('font-size:13px;font-weight:650;padding:8px 0 4px')}>{name}</div>
                  {es.map((e) => (
                    <div key={e.course.id}>
                      <button className="tr" onClick={() => setOpen(open === e.course.id ? null : e.course.id)} aria-expanded={open === e.course.id} style={{ gridTemplateColumns: COLS, gap: 10, minHeight: 40, width: '100%', background: 'transparent', border: 0, borderTop: '1px solid #EBEBE6', textAlign: 'left', padding: 0, fontSize: 14 }}>
                        <span style={{ width: 10, height: 10, borderRadius: 2, background: '#000' }} />
                        <span style={st('font-weight:550')}>{e.course.name}{e.kind === 'eligibility' ? <span className="mu" style={st('font-weight:400')}> · idoneità, non fa media</span> : null}</span>
                        <span style={st('text-align:right')}>{e.cfu}</span>
                        <span style={st('font-size:20px;font-weight:700;text-align:right;font-variant-numeric:tabular-nums')}>{e.final ? formatGrade(e.final) : '–'}</span>
                        <span>{e.final?.date ? formatDateMedium(e.final.date) : ''}</span>
                        <span className="mu">{e.attemptCount > 1 ? `${e.attemptCount} tentativi` : '1'}</span>
                      </button>
                      {open === e.course.id && (
                        <div style={st('margin:0 0 8px 32px;padding:10px 14px;background:#F2F2EF;border-radius:6px;font-size:13.5px')}>
                          {e.history.map((h) => (
                            <button key={h.id} onClick={() => ui.modal((close) => <AttemptModal courseId={e.course.id} attemptId={h.id} onClose={close} />)} style={st('display:grid;grid-template-columns:110px 1fr auto;gap:8px;padding:3px 0;width:100%;border:0;background:transparent;text-align:left;font-size:13.5px')}>
                              <span className="mu">{h.date ? formatDateMedium(h.date) : 'senza data'}</span>
                              <span>{h.isMidterm ? (h.label || 'prova in itinere') : h.component === 'written' ? 'scritto' : h.component === 'oral' ? 'orale' : h.component === 'written_oral' ? 'scritto e orale' : h.component}</span>
                              <span style={st('font-weight:650')}>{outcomeLabel(h)}</span>
                            </button>
                          ))}
                          <div className="mu" style={st('margin-top:6px')}>Presenza al corso: {attendanceOf(e)}{e.final?.note ? `. Note: ${e.final.note}` : ''}</div>
                          <Btn size="s" style={st('margin-top:8px')} onClick={() => ui.modal((close) => <AttemptModal courseId={e.course.id} onClose={close} />)}>Aggiungi tentativo</Btn>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              {pending.length > 0 && (
                <>
                  <div style={st('font-size:13px;font-weight:650;padding:14px 0 4px;display:flex;justify-content:space-between')}>
                    <span>Da sostenere</span><span className="mu" style={st('font-weight:400')}>voti simulati in blu</span>
                  </div>
                  {pending.map((e) => (
                    <button key={e.course.id} className="tr" onClick={() => ui.modal((close) => <AttemptModal courseId={e.course.id} onClose={close} />)} style={{ gridTemplateColumns: COLS, gap: 10, minHeight: 40, width: '100%', background: 'transparent', border: 0, borderTop: '1px solid #EBEBE6', textAlign: 'left', padding: 0, fontSize: 14 }}>
                      <span style={{ width: 10, height: 10, borderRadius: 2, border: '1.5px dashed #5F5F59' }} />
                      <span>{e.course.name}</span>
                      <span style={st('text-align:right')}>{e.cfu}</span>
                      <span style={{ fontSize: 20, fontWeight: 700, textAlign: 'right', color: '#1F35C7', fontVariantNumeric: 'tabular-nums' }}>{e.kind === 'eligibility' ? 'idon.' : simGrade(e.course.id)}</span>
                      <span>{e.next?.date ? formatDayShort(e.next.date) : 'da fissare'}</span>
                      <span className="mu">{e.status === 'booked' ? 'prenotato' : e.next ? 'in programma' : ''}</span>
                    </button>
                  ))}
                </>
              )}
            </div>
          </div>
        </section>

        <aside style={st('border-left:1px solid #DCDCD6;padding:24px 22px;display:flex;flex-direction:column;background:#FAFAF8;overflow:auto')}>
          <div className="mu" style={st('font-size:13px')}>Media ponderata</div>
          <div style={st('font-size:60px;font-weight:780;letter-spacing:-0.045em;line-height:1')}>{avg.weighted === null ? '–' : formatNumberIT(avg.weighted, 2)}</div>
          <div className="mu" style={st('font-size:13px;margin-top:4px')}>su {avg.gradedExams} {avg.gradedExams === 1 ? 'esame' : 'esami'}, {avg.gradedCfu} CFU con voto</div>
          <div style={st('margin-top:14px;border-top:1px solid #DCDCD6')}>
            <Line l="Media aritmetica" v={avg.arithmetic === null ? '–' : formatNumberIT(avg.arithmetic, 2)} />
            <Line l={`Base di laurea su ${settings.graduationScale}`} v={avg.graduationBase === null ? '–' : formatNumberIT(avg.graduationBase, 1)} />
            <Line l="CFU acquisiti" v={<>{avg.totalCfu} <span className="mu" style={st('font-weight:400')}>/ {settings.degreeCfuTarget}</span></>} last />
          </div>
          {avg.eligibilityCfu > 0 && <p className="mu" style={st('font-size:12px;margin:6px 0 0')}>Inclusi {avg.eligibilityCfu} CFU di idoneità, che non entrano nelle medie.</p>}

          {pending.length > 0 && (
            <>
              <div style={st('margin-top:18px;border-top:2px solid #000;padding-top:10px')}>
                <h2 style={st('margin:0;font-size:16px;font-weight:650')}>Simula i prossimi voti</h2>
                <p className="mu" style={st('margin:2px 0 4px;font-size:13px')}>Prova dei voti per vedere l’effetto. Non viene salvato.</p>
              </div>
              {pending.filter((e) => e.kind === 'graded').map((e) => (
                <div key={e.course.id} style={st('display:flex;align-items:center;gap:10px;min-height:46px;border-top:1px solid #EBEBE6')}>
                  <span style={{ width: 10, height: 10, borderRadius: 2, background: e.course.color }} />
                  <span style={st('flex:1;font-size:14px')}>{e.course.name}</span>
                  <div className="stp">
                    <button onClick={() => setSim({ ...sim, [e.course.id]: Math.max(18, simGrade(e.course.id) - 1) })} aria-label="Diminuisci">−</button>
                    <span>{simGrade(e.course.id)}</span>
                    <button onClick={() => setSim({ ...sim, [e.course.id]: Math.min(30, simGrade(e.course.id) + 1) })} aria-label="Aumenta">+</button>
                  </div>
                </div>
              ))}
              <div style={st('margin-top:10px;background:#EEF0FC;border-radius:6px;padding:12px 14px')}>
                <div style={st('display:flex;align-items:baseline;justify-content:space-between')}>
                  <span style={st('font-size:13px;color:#1F35C7;font-weight:600')}>Media con questi voti</span>
                  <span style={st('font-size:13px;font-weight:650;color:#1F35C7')}>{result.deltaWeighted === null ? '' : `${result.deltaWeighted >= 0 ? '+' : '−'}${formatNumberIT(Math.abs(result.deltaWeighted), 2)} rispetto a ora`}</span>
                </div>
                <div style={st('font-size:28px;font-weight:750;letter-spacing:-0.03em;line-height:1.1;color:#1F35C7')}>{result.weighted === null ? '–' : formatNumberIT(result.weighted, 2)}</div>
                {result.weighted !== null && (
                  <div style={st('position:relative;height:16px;margin:8px 0 2px')} aria-hidden="true">
                    <span style={st('position:absolute;left:0;right:0;top:7px;height:2px;background:#C9CFF3')} />
                    {nowW !== null && <span style={{ position: 'absolute', top: 2, left: pct(nowW), width: 2, height: 12, background: '#000', marginLeft: -1 }} />}
                    <span style={{ position: 'absolute', top: 3, left: pct(result.weighted), width: 10, height: 10, borderRadius: 5, background: '#1F35C7', marginLeft: -5 }} />
                  </div>
                )}
                <div style={st('display:flex;justify-content:space-between;font-size:11px;color:#3A3A36')}><span>18</span><span>{nowW === null ? '' : `ora ${formatNumberIT(nowW, 2)}`}</span><span>30</span></div>
                <div style={st('display:flex;justify-content:space-between;font-size:13px;margin-top:8px;color:#1F35C7')}>
                  <span>aritmetica <b>{result.arithmetic === null ? '–' : formatNumberIT(result.arithmetic, 2)}</b></span>
                  <span>base <b>{result.graduationBase === null ? '–' : formatNumberIT(result.graduationBase, 1)}</b></span>
                  <span>CFU <b>{result.totalCfu}</b></span>
                </div>
              </div>
              <div style={st('margin-top:12px;font-size:13px;display:flex;align-items:center;gap:8px;flex-wrap:wrap')}>
                <span>Per chiudere a media</span>
                <input className="in" type="number" min={18} max={30} step={0.5} value={target} onChange={(e) => setTarget(Number(e.target.value))} aria-label="Media obiettivo" style={st('width:72px;height:32px;font-size:14px')} />
                <span>servono in media</span>
                <b>{needed === null ? '–' : needed > 30 ? 'oltre 30, non raggiungibile' : needed < 18 ? 'qualsiasi voto' : formatNumberIT(needed, 1)}</b>
              </div>
            </>
          )}
          <p className="mu" style={st('font-size:12px;margin:auto 0 0;padding-top:12px')}>La lode vale {settings.lodeValue} nel calcolo. Puoi cambiarlo in Impostazioni.</p>
        </aside>
      </main>
    </div>
  );
}

function Line({ l, v, last }: { l: string; v: React.ReactNode; last?: boolean }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '7px 0', borderBottom: last ? 0 : '1px solid #EBEBE6', fontSize: 14 }}>
      <span>{l}</span>
      <b>{v}</b>
    </div>
  );
}

function outcomeLabel(h: LibrettoEntry['history'][number]): string {
  switch (h.outcome) {
    case 'planned': return 'in programma';
    case 'withdrawn': return 'ritirato';
    case 'failed': return `${h.grade ?? 'non superato'}${h.grade ? ', respinto' : ''}`;
    case 'rejected': return `${h.grade}, rifiutato`;
    default: return h.eligible && h.grade === null ? 'idoneo' : `${h.lode ? '30 e lode' : h.grade}${h.isMidterm ? '' : ', accettato'}`;
  }
}

function PickCourseModal({ onClose }: { onClose: () => void }) {
  const ui = useUi();
  const courses = useQuery((r) => r.courses({ includeArchived: false }), []);
  return (
    <Modal title="Registra esito: quale corso?" onClose={onClose} width={460}>
      <div style={st('padding:8px 24px 20px')}>
        {courses.length === 0 && <p className="mu">Aggiungi prima un corso in Università.</p>}
        {courses.map((c) => (
          <button key={c.id} onClick={() => { onClose(); ui.modal((close) => <AttemptModal courseId={c.id} onClose={close} />); }} style={st('display:flex;align-items:center;gap:10px;width:100%;min-height:46px;border:0;border-top:1px solid #EBEBE6;background:transparent;text-align:left;font-size:15px')}>
            <span className="sw" style={{ width: 12, height: 12, background: c.color }} />
            <span style={st('flex:1')}>{c.name}</span><span className="mu">{c.cfu} CFU</span>
          </button>
        ))}
      </div>
    </Modal>
  );
}

export { averagesFromEntries };
