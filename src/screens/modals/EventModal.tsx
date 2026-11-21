import { useState } from 'react';
import { useQuery, useServices, useUi } from '../../app/AppContext';
import { useCalendarState } from '../../app/useCalendar';
import { Btn, ConfirmDialog, Field, Modal } from '../../ui/components';
import { st } from '../../ui/style';
import { addDays, addMinutes, durationMinutes, formatDayLongLower, hmToMin, isHM, isISODate, splitLocalDateTime, weekdayISO, type ISODate } from '../../domain/dates';
import { describeRecurrence } from '../../domain/recurrence';
import type { CalendarEvent, EventCategory, Recurrence } from '../../domain/types';
import { CATEGORY_LABELS } from '../../domain/settings';

const TYPES: EventCategory[] = ['event', 'deadline', 'appointment', 'study'];
const DEFAULT_DUR: Record<EventCategory, number> = { event: 120, appointment: 30, study: 180, deadline: 0 };
const CTA: Record<EventCategory, string> = { event: 'Aggiungi evento', deadline: 'Aggiungi scadenza', appointment: 'Aggiungi appuntamento', study: 'Aggiungi sessione' };
const DURS: Array<[number, string]> = [[30, '30 min'], [60, '1 h'], [120, '2 h'], [180, '3 h']];
const REMINDERS: Array<[number | null, string]> = [[null, 'Nessuno'], [0, 'All’ora'], [15, '15 minuti prima'], [60, '1 ora prima'], [1440, '1 giorno prima']];
const COLORS: Array<[string | null, string]> = [
  [null, 'Automatico (colore del corso o della categoria)'],
  ['#1F35C7', 'Oltremare'],
  ['#6A4FB3', 'Viola'],
  ['#93306E', 'Prugna'],
  ['#B42318', 'Rosso'],
  ['#B7791F', 'Ocra'],
  ['#3F7D3A', 'Muschio'],
  ['#1F7A8C', 'Petrolio'],
  ['#5F5F59', 'Grafite'],
  ['#000000', 'Inchiostro'],
];

type RepeatKind = 'never' | 'daily' | 'weekly' | 'custom';

interface Props {
  date?: ISODate;
  time?: string;
  eventId?: string;
  occurrenceDate?: ISODate;
  onClose: () => void;
}

export function EventModal({ date, time, eventId, occurrenceDate, onClose }: Props) {
  const { repo, calendar } = useServices();
  const ui = useUi();
  const cal = useCalendarState();
  const existing = useQuery((r) => (eventId ? r.event(eventId) : undefined), [eventId]);
  const courses = useQuery((r) => r.courses({ semesterId: r.currentSemester()?.id }), []);
  const settings = useQuery((r) => r.getSettings());

  const startDate = existing ? splitLocalDateTime(existing.start).date : date ?? new Date().toISOString().slice(0, 10);
  const [category, setCategory] = useState<EventCategory>(existing?.category ?? 'event');
  const [title, setTitle] = useState(existing?.title ?? '');
  const [description, setDescription] = useState(existing?.description ?? '');
  const [courseId, setCourseId] = useState<string | null>(existing?.courseId ?? null);
  const [d, setD] = useState<ISODate>(occurrenceDate ?? startDate);
  const [start, setStart] = useState(existing ? splitLocalDateTime(existing.start).time : time ?? '15:00');
  const [dur, setDur] = useState<number>(existing ? Math.max(0, durationMinutes(splitLocalDateTime(existing.start).time, splitLocalDateTime(existing.end).time)) : DEFAULT_DUR[category]);
  const [endCustom, setEndCustom] = useState<string | null>(null);
  const [allDay, setAllDay] = useState(existing?.allDay ?? false);
  const [repeat, setRepeat] = useState<RepeatKind>(existing?.recurrence ? (existing.recurrence.freq === 'daily' && existing.recurrence.interval === 1 ? 'daily' : existing.recurrence.freq === 'weekly' && existing.recurrence.interval === 1 && !existing.recurrence.byWeekday && !existing.recurrence.until ? 'weekly' : 'custom') : 'never');
  const [custom, setCustom] = useState<Recurrence>(existing?.recurrence ?? { freq: 'weekly', interval: 1, until: null });
  const [dest, setDest] = useState<string | null>(existing?.appleCalendarId ?? null);
  const [color, setColor] = useState<string | null>(existing?.color ?? null);
  const [reminder, setReminder] = useState<number | null>(existing?.reminderMinutes ?? (category === 'deadline' ? 1440 : 15));

  const isDeadline = category === 'deadline';
  const endTime = endCustom ?? (isDeadline ? start : addMinutes(start, dur || 60));
  const crossesMidnight = !isDeadline && !allDay && hmToMin(start) + (dur || 60) >= 1440 && endCustom === null;
  const endDate = crossesMidnight ? addDays(d, 1) : d;

  const errors: string[] = [];
  if (!title.trim()) errors.push('Scrivi un titolo');
  if (!isISODate(d)) errors.push('Data non valida');
  if (!allDay && (!isHM(start) || !isHM(endTime))) errors.push('Orario non valido');
  if (!allDay && !isDeadline && isHM(start) && isHM(endTime) && endDate === d && hmToMin(endTime) < hmToMin(start)) errors.push('La fine precede l’inizio');

  const recurrence: Recurrence | null = repeat === 'never' ? null : repeat === 'daily' ? { freq: 'daily', interval: 1 } : repeat === 'weekly' ? { freq: 'weekly', interval: 1 } : { ...custom, interval: Math.max(1, custom.interval || 1) };
  const isRecurring = Boolean(existing?.recurrence);
  const appleEnabled = cal.enabled && cal.auth === 'fullAccess';
  const writable = cal.calendars.filter((c) => c.allowsModifications);

  const buildFields = (): Omit<CalendarEvent, 'id' | 'createdAt' | 'updatedAt' | 'completed'> => ({
    category,
    title: title.trim(),
    description,
    courseId,
    allDay,
    start: allDay ? `${d}T00:00` : `${d}T${start}`,
    end: allDay ? `${d}T23:59` : `${endDate}T${endTime}`,
    recurrence,
    reminderMinutes: reminder,
    color,
    appleCalendarId: dest,
  });

  const save = async (scope: 'one' | 'following' | 'all' = 'all') => {
    await ui.run(async () => {
      const f = buildFields();
      if (!existing) {
        const e = repo.createEvent(f);
        if (appleEnabled && dest) await calendar.syncNow('event-created');
        onClose();
        ui.toast(dest && appleEnabled ? `${e.title} aggiunto e inviato a Calendario di Apple` : 'Evento salvato');
        return;
      }
      if (isRecurring && occurrenceDate) {
        if (scope === 'one') {
          repo.setEventException(existing.id, occurrenceDate, { start: f.start, end: f.end, title: f.title });
        } else if (scope === 'following') {
          repo.splitEventSeries(existing.id, occurrenceDate, { ...f, recurrence: f.recurrence });
        } else repo.updateEvent(existing.id, { ...f, start: `${startDate}T${f.start.slice(11)}`, end: `${addDays(startDate, Math.round((Date.parse(f.end.slice(0, 10)) - Date.parse(f.start.slice(0, 10))) / 86_400_000))}T${f.end.slice(11)}` });
      } else repo.updateEvent(existing.id, f);
      if (appleEnabled) await calendar.syncNow('event-edited');
      onClose();
      ui.toast('Modifiche salvate');
    });
  };

  const trySave = () => {
    if (errors.length) return;
    if (existing && isRecurring && occurrenceDate) {
      ui.modal((close) => <ScopeDialog verb="Modifica" onPick={(s) => { close(); void save(s); }} onClose={close} />);
    } else void save();
  };

  const remove = () => {
    if (!existing) return;
    const doDelete = async (scope: 'one' | 'following' | 'all') => {
      await ui.run(async () => {
        if (isRecurring && occurrenceDate && scope === 'one') repo.setEventException(existing.id, occurrenceDate, { cancelled: true });
        else if (isRecurring && occurrenceDate && scope === 'following' && occurrenceDate > startDate) repo.updateEvent(existing.id, { recurrence: { ...existing.recurrence!, until: addDays(occurrenceDate, -1), count: null } });
        else repo.deleteEvent(existing.id);
        if (appleEnabled) await calendar.syncNow('event-deleted');
        onClose();
        ui.toast('Evento eliminato');
      });
    };
    if (isRecurring && occurrenceDate) ui.modal((close) => <ScopeDialog verb="Elimina" danger onPick={(s) => { close(); void doDelete(s); }} onClose={close} />);
    else ui.modal((close) => <ConfirmDialog title={`Eliminare «${existing.title}»?`} body={existing.appleCalendarId ? 'Verrà rimosso anche da Calendario di Apple.' : 'L’evento verrà eliminato da questo dispositivo.'} confirmLabel="Elimina" danger onConfirm={() => void doDelete('all')} onClose={close} />);
  };

  return (
    <Modal
      title={existing ? 'Modifica evento' : 'Nuovo evento'}
      onClose={onClose}
      actions={<Btn variant="p" disabled={errors.length > 0} onClick={trySave}>{existing ? 'Salva' : CTA[category]}</Btn>}
    >
      <div style={st('padding:18px 28px 0')}>
        <div role="tablist" aria-label="Tipo" style={st('display:flex;gap:2px;padding:3px;background:#F2F2EF;border-radius:8px')}>
          {TYPES.map((t) => (
            <button
              key={t}
              role="tab"
              aria-selected={category === t}
              onClick={() => { setCategory(t); setDur(DEFAULT_DUR[t]); setEndCustom(null); if (!existing) setReminder(t === 'deadline' ? 1440 : 15); }}
              style={{ flex: 1, height: 40, border: 0, background: category === t ? '#fff' : 'transparent', fontSize: 14, borderRadius: 5, fontWeight: category === t ? 650 : 400, boxShadow: category === t ? '0 0 0 1px #CFCFC9' : 'none' }}
            >
              {CATEGORY_LABELS[t]}
            </button>
          ))}
        </div>
        <label htmlFor="ev-title" className="sr-only">Titolo</label>
        <input id="ev-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder={isDeadline ? 'Es. Consegna esercizi' : 'Titolo'} style={st('width:100%;margin-top:18px;border:0;border-bottom:2px solid #000;font:inherit;font-size:28px;font-weight:700;letter-spacing:-0.02em;padding:6px 0 8px;color:#000;background:transparent;outline:none')} />
        <label htmlFor="ev-desc" className="sr-only">Descrizione</label>
        <textarea id="ev-desc" rows={2} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Descrizione" style={st('width:100%;margin-top:10px;border:0;font:inherit;font-size:15px;color:#5F5F59;resize:none;background:transparent;outline:none')} />
        <div style={st('margin-top:6px')}>
          <Field label="Corso">
            <select className="in" aria-label="Corso" value={courseId ?? ''} onChange={(e) => setCourseId(e.target.value || null)} style={st('min-width:200px')}>
              <option value="">Nessuno</option>
              {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </Field>
          <Field label="Data">
            <input className="in" type="date" aria-label="Data" value={d} onChange={(e) => setD(e.target.value)} style={st('width:142px;padding:0 8px')} />
            {!isDeadline && !allDay && (
              <>
                <input className="in" type="time" aria-label="Inizio" value={start} onChange={(e) => { setStart(e.target.value); }} style={st('width:98px;padding:0 8px')} />
                <span className="mu">–</span>
                <input className="in emph" type="time" aria-label="Fine" value={endTime} onChange={(e) => setEndCustom(e.target.value)} style={st('width:98px;padding:0 8px')} />
              </>
            )}
            {isDeadline && <><span className="mu">entro le</span><input className="in" type="time" aria-label="Ora di scadenza" value={start} onChange={(e) => setStart(e.target.value)} style={st('width:110px')} /></>}
            {crossesMidnight && <span className="mu" style={st('font-size:13px')}>finisce {formatDayLongLower(endDate)}</span>}
          </Field>
          {!isDeadline && (
            <Field label="Durata">
              <span role="radiogroup" aria-label="Durata" style={st('display:flex;gap:6px;align-items:center;flex-wrap:wrap')}>
                {DURS.map(([m, l]) => (
                  <button key={m} className={`pill ${endCustom === null && dur === m && !allDay ? 'on' : ''}`} role="radio" aria-checked={endCustom === null && dur === m && !allDay} onClick={() => { setAllDay(false); setDur(m); setEndCustom(null); }}>{l}</button>
                ))}
                <button className={`pill ${allDay ? 'on' : ''}`} role="radio" aria-checked={allDay} onClick={() => setAllDay((v) => !v)}>Tutto il giorno</button>
              </span>
            </Field>
          )}
          <Field label="Ripeti">
            <span style={st('display:flex;gap:6px;flex-wrap:wrap')}>
              {([['never', 'Mai'], ['daily', 'Ogni giorno'], ['weekly', 'Ogni settimana'], ['custom', 'Personalizza']] as Array<[RepeatKind, string]>).map(([k, l]) => (
                <button key={k} className={`pill ${repeat === k ? 'on' : ''}`} onClick={() => setRepeat(k)}>{l}</button>
              ))}
            </span>
          </Field>
          {repeat === 'custom' && (
            <div className="row" style={st('grid-template-columns:150px 1fr')}>
              <span className="lb">Ripetizione</span>
              <span style={st('display:flex;gap:8px;align-items:center;flex-wrap:wrap')}>
                <span className="mu">ogni</span>
                <input className="in" type="number" min={1} aria-label="Intervallo" value={custom.interval} onChange={(e) => setCustom({ ...custom, interval: Number(e.target.value) })} style={st('width:70px')} />
                <select className="in" aria-label="Frequenza" value={custom.freq} onChange={(e) => setCustom({ ...custom, freq: e.target.value as Recurrence['freq'] })}>
                  <option value="daily">giorni</option><option value="weekly">settimane</option><option value="monthly">mesi</option><option value="yearly">anni</option>
                </select>
                <span className="mu">fino al</span>
                <input className="in" type="date" aria-label="Fino al" value={custom.until ?? ''} onChange={(e) => setCustom({ ...custom, until: e.target.value || null })} />
                {custom.freq === 'weekly' && (
                  <span style={st('display:flex;gap:4px;width:100%')}>
                    {['L', 'M', 'M', 'G', 'V', 'S', 'D'].map((l, i) => {
                      const sel = (custom.byWeekday ?? [weekdayISO(d)]).includes(i + 1);
                      return <button key={i} className={`pill ${sel ? 'on' : ''}`} style={st('width:36px;padding:0;justify-content:center')} aria-pressed={sel} onClick={() => { const cur = custom.byWeekday ?? [weekdayISO(d)]; const next = sel ? cur.filter((x) => x !== i + 1) : [...cur, i + 1]; setCustom({ ...custom, byWeekday: next.length ? next : cur }); }}>{l}</button>;
                    })}
                  </span>
                )}
              </span>
            </div>
          )}
          {repeat !== 'never' && <p className="mu" style={st('font-size:13px;margin:0 0 6px 162px')}>{describeRecurrence(recurrence)}</p>}
          <Field label="Calendario" hint={dest ? 'Sincronizzato con Calendario di Apple' : 'Solo su questo dispositivo'}>
            <select className="in" aria-label="Calendario" value={dest ?? ''} onChange={(e) => setDest(e.target.value || null)} style={st('min-width:250px')}>
              <option value="">PRCD, solo su questo dispositivo</option>
              {appleEnabled && <option value="managed">{settings.appleManagedCalendarName} (Apple Calendario)</option>}
              {appleEnabled && writable.filter((c) => !c.isManaged).map((c) => <option key={c.id} value={c.id}>{c.sourceTitle}, {c.title}</option>)}
            </select>
            {!appleEnabled && <span className="mu" style={st('font-size:13px')}>Per inviare eventi ad Apple attiva l’integrazione in Calendari.</span>}
          </Field>
          <Field label="Colore">
            <span style={st('display:flex;gap:8px;align-items:center;flex-wrap:wrap')}>
              {COLORS.map(([c, name]) => (
                <button key={name} type="button" title={name} aria-label={name} aria-pressed={color === c} onClick={() => setColor(c)} style={{ width: 28, height: 28, borderRadius: 4, padding: 0, border: c === null ? '1.5px dashed #5F5F59' : 'none', background: c ?? '#fff', boxShadow: color === c ? '0 0 0 2px #fff,0 0 0 3px #000' : 'none', fontSize: 10, color: '#5F5F59' }}>{c === null ? 'A' : ''}</button>
              ))}
            </span>
          </Field>
          <Field label="Promemoria">
            <select className="in" aria-label="Promemoria" value={reminder === null ? '' : String(reminder)} onChange={(e) => setReminder(e.target.value === '' ? null : Number(e.target.value))}>
              {REMINDERS.map(([m, l]) => <option key={String(m)} value={m === null ? '' : String(m)}>{l}</option>)}
            </select>
          </Field>
        </div>
        {errors.length > 0 && title.length + description.length > 0 && <p style={st('color:#B23A0A;font-size:13px;margin:8px 0 0')}>{errors[0]}.</p>}
      </div>
      {existing && (
        <footer style={st('padding:12px 28px;border-top:1px solid #EBEBE6;display:flex;justify-content:flex-end;align-items:center;margin-top:12px')}>
          <button className="btn ghost" style={st('color:#B23A0A;height:32px')} onClick={remove}>Elimina evento</button>
        </footer>
      )}
    </Modal>
  );
}

function ScopeDialog({ verb, onPick, onClose, danger }: { verb: string; onPick: (s: 'one' | 'following' | 'all') => void; onClose: () => void; danger?: boolean }) {
  return (
    <div className="scrim" style={{ zIndex: 60 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dlg" role="alertdialog" aria-labelledby="sc-t">
        <h2 id="sc-t">{verb} un evento ricorrente</h2>
        <p>A quali occorrenze si applica?</p>
        <div style={st('display:flex;flex-direction:column;gap:8px')}>
          <Btn size="lg" variant={danger ? 'd' : undefined} onClick={() => onPick('one')}>Solo questa occorrenza</Btn>
          <Btn size="lg" variant={danger ? 'd' : undefined} onClick={() => onPick('following')}>Questa e le successive</Btn>
          <Btn size="lg" variant={danger ? 'd' : undefined} onClick={() => onPick('all')}>Tutta la serie</Btn>
          <Btn size="lg" variant="ghost" onClick={onClose}>Annulla</Btn>
        </div>
      </div>
    </div>
  );
}
