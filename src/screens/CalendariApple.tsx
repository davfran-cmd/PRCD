import { useEffect, useState } from 'react';
import { Sidebar } from '../app/Sidebar';
import { A } from '../app/router';
import { useQuery, useServices, useUi } from '../app/AppContext';
import { useCalendarState } from '../app/useCalendar';
import { Btn, ConfirmDialog, Swatch, Toggle } from '../ui/components';
import { st } from '../ui/style';
import { formatDayShort } from '../domain/dates';
import { selectAll } from '../db/rows';
import type { PendingConflict, Fields } from '../calendar/sync';

const AUTH_TEXT: Record<string, { title: string; body: string }> = {
  unavailable: { title: 'Non disponibile su questa piattaforma', body: 'L’integrazione con Calendario di Apple usa EventKit e funziona solo nell’app per iPad o iPhone. Qui puoi comunque usare il calendario locale di PRCD.' },
  notDetermined: { title: 'Non ancora attivato', body: 'PRCD legge i calendari che scegli tu e scrive solo quando aggiungi o modifichi un evento. Non invia nulla fuori dal dispositivo.' },
  fullAccess: { title: 'Accesso completo: lettura e scrittura', body: 'Per revocare l’accesso usa Impostazioni > Privacy > Calendari. PRCD continuerà a funzionare con i soli calendari locali.' },
  denied: { title: 'Accesso negato', body: 'Per vedere i tuoi impegni accanto alle lezioni consenti l’accesso completo da Impostazioni iPad > Privacy > Calendari. Nel frattempo tutto il resto di PRCD funziona normalmente.' },
  restricted: { title: 'Accesso limitato da restrizioni del dispositivo', body: 'Un profilo o il controllo genitori impedisce l’accesso ai calendari. PRCD funziona con i soli calendari locali.' },
  writeOnly: { title: 'Solo aggiunta di eventi', body: 'Hai concesso l’accesso in sola scrittura. Per leggere e sincronizzare serve l’accesso completo: Impostazioni iPad > Privacy > Calendari > PRCD.' },
};

function fmtFields(f: Fields | null): string {
  if (!f) return '—';
  return `${f.title}${f.title ? ', ' : ''}${f.start.slice(0, 10)} ${f.start.slice(11, 16)}–${f.end.slice(11, 16)}`;
}

export function CalendariApple() {
  const { repo, calendar } = useServices();
  const ui = useUi();
  const cal = useCalendarState();
  const settings = useQuery((r) => r.getSettings());
  const lessonsCount = useQuery((r) => r.courses({ semesterId: r.currentSemester()?.id }).length, []);
  const groups = new Map<string, typeof cal.calendars>();
  for (const c of cal.calendars) groups.set(c.sourceTitle || 'Altri', [...(groups.get(c.sourceTitle || 'Altri') ?? []), c]);
  const writable = cal.calendars.filter((c) => c.allowsModifications && !c.isManaged);
  const toggleCat = (c: 'study' | 'deadline') => repo.updateSettings({ visibleCategories: settings.visibleCategories.includes(c) ? settings.visibleCategories.filter((x) => x !== c) : [...settings.visibleCategories, c] });

  // duplicates: a local event and a third-party event with the same title starting at the same moment
  const duplicates = useQuery(
    (r) => {
      const ext = selectAll<{ id: string; title: string; start: string; end: string; calendarId: string }>(r.db, 'SELECT id, title, starts_at, ends_at, calendar_id FROM external_events');
      const titles = new Map(cal.calendars.map((c) => [c.id, `${c.sourceTitle}, ${c.title}`]));
      const out: Array<{ key: string; eventId: string; local: string; ext: string; extCal: string; localTitle: string; localWhen: string }> = [];
      for (const e of r.events()) {
        if (e.recurrence) continue;
        const m = ext.find((x) => x.title.trim().toLowerCase() === e.title.trim().toLowerCase() && x.start.slice(0, 10) === e.start.slice(0, 10) && Math.abs(Number(x.start.slice(11, 13)) * 60 + Number(x.start.slice(14, 16)) - (Number(e.start.slice(11, 13)) * 60 + Number(e.start.slice(14, 16)))) <= 30);
        const key = `${e.id}::${m?.id}`;
        if (m && !r.getSettings().dismissedDuplicates.includes(key)) out.push({ key, eventId: e.id, localTitle: e.title, localWhen: `${formatDayShort(e.start.slice(0, 10))}, ${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`, local: 'PRCD', ext: `${formatDayShort(m.start.slice(0, 10))}, ${m.start.slice(11, 16)}–${m.end.slice(11, 16)}`, extCal: titles.get(m.calendarId) ?? 'Apple Calendario' });
      }
      return out;
    },
    [cal.lastSyncAt, cal.calendars.length],
  );

  const connected = cal.available && cal.enabled && cal.auth === 'fullAccess';
  const toggleConnection = (v: boolean) => void ui.run(async () => {
    if (!v) return calendar.disable();
    if (['denied', 'restricted', 'writeOnly'].includes(cal.auth)) return void calendar.openSystemSettings();
    const a = await calendar.enable();
    if (a !== 'fullAccess') ui.toast('Accesso non concesso. Puoi cambiarlo in Impostazioni iPad > Privacy > Calendari.', { error: true });
  });
  const allVisible = cal.calendars.length > 0 && cal.calendars.every((c) => c.visible);
  const syncLabel = cal.syncing ? 'Sincronizzazione in corso…' : cal.error ? cal.error : cal.lastSyncAt ? `Ultima sincronizzazione alle ${new Date(cal.lastSyncAt).toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit' })}` : 'Non ancora sincronizzato';

  return (
    <div className="app">
      <Sidebar active="cal" />
      <main className="main scroll">
        <div style={st('padding:24px 32px 40px;max-width:820px;display:flex;flex-direction:column;gap:30px')}>
          <div>
            <A to="/calendario" style={st('font-size:15px;color:#1F35C7;text-decoration:none')}>Calendario</A>
            <h1 className="pt s" style={st('margin:4px 0 0')}>Calendari</h1>
          </div>

          {/* 1. one master switch: is PRCD connected to Apple Calendar at all? */}
          <section>
            <h2 style={H2}>Calendario di Apple</h2>
            <div style={st('display:flex;align-items:center;gap:14px;padding:16px 0;border-top:2px solid #000;border-bottom:1px solid #EBEBE6')}>
              <span style={{ width: 12, height: 12, borderRadius: 6, flex: 'none', background: connected ? '#3F7D3A' : cal.auth === 'denied' || cal.auth === 'restricted' ? '#C2410C' : '#9A9A93' }} />
              <span style={st('flex:1')}>
                <b style={st('font-size:18px;font-weight:650')}>{connected ? 'Collegato' : 'Non collegato'}</b>
                <span className="mu" style={st('display:block;font-size:15px')}>{connected ? 'PRCD legge i calendari che accendi qui sotto e scrive in Apple solo ciò che scegli nella sezione “Cosa PRCD scrive”.' : cal.available ? 'Accendi per vedere in PRCD i tuoi impegni di Apple e, se vuoi, pubblicare le lezioni in Apple.' : AUTH_TEXT.unavailable.body}</span>
              </span>
              {cal.available && <Toggle on={connected} onChange={toggleConnection} label="Collega a Calendario di Apple" />}
            </div>
            {cal.available && !connected && ['denied', 'restricted', 'writeOnly'].includes(cal.auth) && <p style={st('font-size:15px;color:#B23A0A;margin:8px 0 0')}>{AUTH_TEXT[cal.auth].body}</p>}
            {connected && (
              <div className="mu" style={st('display:flex;align-items:center;gap:10px;font-size:15px;margin-top:10px;flex-wrap:wrap')}>
                <span style={{ width: 8, height: 8, borderRadius: 4, background: cal.error ? '#C2410C' : cal.syncing ? '#B7791F' : '#3F7D3A' }} />
                <span style={st('flex:1;min-width:240px')}>{syncLabel}. Si sincronizza da solo: all’apertura, quando cambi qualcosa qui o in Apple, e ogni 5 minuti.</span>
                <Btn size="s" disabled={cal.syncing} onClick={() => void ui.run(async () => { const r = await calendar.syncNow('manual'); ui.toast(`Sincronizzato: ${r.created} creati, ${r.updated + r.pulled} aggiornati${r.conflicts ? `, ${r.conflicts} da risolvere` : ''}`); })}>Sincronizza ora</Btn>
              </div>
            )}
          </section>

          {/* 2. reading: which Apple calendars appear in PRCD */}
          {connected && (
            <section>
              <h2 style={H2}>Cosa PRCD legge da Apple</h2>
              <div style={st('display:flex;align-items:baseline;justify-content:space-between;gap:12px;border-bottom:2px solid #000;padding-bottom:8px')}>
                <span className="mu" style={st('font-size:15px')}>Gli eventi dei calendari accesi compaiono nel calendario di PRCD. PRCD non li modifica.</span>
                <button className="lnk" style={st('font-size:15px;white-space:nowrap')} onClick={() => cal.calendars.forEach((c) => c.visible === allVisible && calendar.setCalendarVisible(c.id, !allVisible))}>{allVisible ? 'Spegni tutti' : 'Accendi tutti'}</button>
              </div>
              {[...groups].map(([source, cs]) => (
                <div key={source}>
                  <Group title={source} />
                  {cs.map((c) => <Row key={c.id} swatch={<Swatch color={c.color} size={14} hollow />} name={c.title} sub={c.isManaged ? 'creato da PRCD per le lezioni' : !c.allowsModifications ? 'sola lettura' : undefined} on={c.visible} onChange={(v) => calendar.setCalendarVisible(c.id, v)} />)}
                </div>
              ))}
            </section>
          )}

          {/* 3. writing: what goes from PRCD into Apple */}
          {connected && (
            <section>
              <h2 style={H2}>Cosa PRCD scrive in Apple</h2>
              <div style={st('display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-top:2px solid #000;gap:16px')}>
                <span>Pubblica le lezioni<br /><span className="mu" style={st('font-size:15px')}>Ogni lezione diventa un evento nel calendario «{settings.appleManagedCalendarName}». Spostare una lezione qui o lì aggiorna l’altra; le presenze restano in PRCD.</span></span>
                <Toggle on={settings.appleSyncLessons} label="Pubblica lezioni" onChange={(v) => {
                  if (v) calendar.setPublishLessons(true);
                  else ui.modal((close) => <ConfirmDialog title="Smettere di pubblicare le lezioni?" body="Gli eventi già creati restano in Apple Calendario finché non li rimuovi." confirmLabel="Smetti e rimuovi gli eventi" extra={<Btn size="lg" onClick={() => { calendar.setPublishLessons(false); close(); }}>Smetti, lascia gli eventi</Btn>} onConfirm={() => void ui.run(async () => { calendar.setPublishLessons(false); const n = await calendar.removeLessonEventsFromApple(); ui.toast(`${n} eventi rimossi da Apple Calendario`); })} onClose={close} />);
                }} />
              </div>
              <div style={st('display:flex;align-items:center;justify-content:space-between;padding:14px 0;border-top:1px solid #EBEBE6;gap:16px;flex-wrap:wrap')}>
                <span>Dove salvare i nuovi eventi<br /><span className="mu" style={st('font-size:15px')}>Si può cambiare per ogni evento quando lo crei.</span></span>
                <select className="in" aria-label="Calendario predefinito" value={settings.appleDefaultCalendarId ?? ''} onChange={(e) => calendar.setDefaultCalendar(e.target.value || null)}>
                  <option value="">Solo in PRCD (non in Apple)</option>
                  <option value="managed">{settings.appleManagedCalendarName}</option>
                  {writable.map((c) => <option key={c.id} value={c.id}>{c.sourceTitle}, {c.title}</option>)}
                </select>
              </div>
            </section>
          )}

          {/* 4. PRCD's own items */}
          <section>
            <h2 style={H2}>Cosa mostra il calendario di PRCD</h2>
            <div style={st('border-top:2px solid #000')}>
              <Row swatch={<Swatch color="#000" size={14} />} name="Lezioni" sub={`generate dall'orario, ${lessonsCount} ${lessonsCount === 1 ? 'corso' : 'corsi'}`} on={settings.showLessons} onChange={(v) => repo.updateSettings({ showLessons: v })} />
              <Row swatch={<Swatch color="#1F35C7" size={14} hollow />} name="Sessioni di studio" on={settings.visibleCategories.includes('study')} onChange={() => toggleCat('study')} />
              <Row swatch={<Swatch color="#C2410C" size={14} hollow />} name="Scadenze ed esami" on={settings.visibleCategories.includes('deadline')} onChange={() => toggleCat('deadline')} />
            </div>
          </section>

          {cal.conflicts.length > 0 && (
            <div>
              <h2 style={st('margin:0 0 4px;font-size:17px;font-weight:650')}>Da risolvere</h2>
              <p className="mu" style={st('margin:0 0 10px;font-size:14px')}>Questi elementi sono cambiati in modo diverso qui e in Apple Calendario. Nulla è stato sovrascritto: scegli cosa tenere.</p>
              {cal.conflicts.map((c) => <ConflictCard key={`${c.map.localKind}:${c.map.localId}`} c={c} />)}
            </div>
          )}

          {duplicates.length > 0 && (
            <div>
              <h2 style={st('margin:0 0 4px;font-size:17px;font-weight:650')}>Possibili duplicati</h2>
              <p className="mu" style={st('margin:0 0 10px;font-size:14px')}>Stesso titolo e orario in due calendari. Scegli cosa tenere.</p>
              {duplicates.slice(0, 5).map((d, i) => (
                <div key={d.key} style={st('border:1px solid #CFCFC9;border-radius:8px;overflow:hidden;margin-bottom:10px')}>
                  <div style={st('display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #EBEBE6')}>
                    <div style={st('padding:12px 14px;border-right:1px solid #EBEBE6')}><div style={st('font-weight:650')}>{d.localTitle}</div><div className="mu" style={st('font-size:13px')}>{d.localWhen}</div><div style={st('font-size:13px;margin-top:6px')}>PRCD</div></div>
                    <div style={st('padding:12px 14px')}><div style={st('font-weight:650')}>{d.localTitle}</div><div className="mu" style={st('font-size:13px')}>{d.ext}</div><div style={st('font-size:13px;margin-top:6px')}>{d.extCal}</div></div>
                  </div>
                  <div style={st('display:flex;gap:8px;padding:10px 14px;background:#FAFAF8;align-items:center;flex-wrap:wrap')}>
                    <Btn variant="p" onClick={() => ui.modal((close) => <ConfirmDialog title={`Eliminare «${d.localTitle}» da PRCD?`} body="Resta l’evento di Apple Calendario." confirmLabel="Elimina quello di PRCD" danger onConfirm={() => repo.deleteEvent(d.eventId)} onClose={close} />)}>Tieni quello di Apple</Btn>
                    <Btn onClick={() => repo.updateSettings({ dismissedDuplicates: [...settings.dismissedDuplicates, d.key] })}>Tieni entrambi</Btn>
                    <span style={st('flex:1')} /><span className="mu" style={st('font-size:13px')}>{i + 1} di {duplicates.length}</span>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}

const H2: React.CSSProperties = { margin: '0 0 10px', fontSize: 20, fontWeight: 750 };

function Group({ title, right }: { title: string; right?: string }) {
  return <div style={st('font-size:13px;color:#5F5F59;font-weight:500;margin:22px 0 4px;display:flex;justify-content:space-between')}><span>{title}</span><span>{right}</span></div>;
}

function Row({ swatch, name, sub, right, on, onChange }: { swatch: React.ReactNode; name: string; sub?: string; right?: string; on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div style={st('display:grid;grid-template-columns:16px 1fr auto auto;gap:12px;align-items:center;min-height:56px;border-top:1px solid #EBEBE6')}>
      {swatch}
      <span>{name}{sub && <><br /><span className="mu" style={st('font-size:13px')}>{sub}</span></>}</span>
      <span className="mu" style={st('font-size:14px')}>{right}</span>
      <Toggle on={on} onChange={onChange} label={`Mostra ${name}`} />
    </div>
  );
}

function ConflictCard({ c }: { c: PendingConflict }) {
  const { calendar } = useServices();
  const ui = useUi();
  const [remote, setRemote] = useState<Fields | null>(null);
  useEffect(() => {
    let alive = true;
    void calendar.remoteSnapshot(c.map).then((r) => alive && setRemote(r));
    return () => { alive = false; };
  }, [calendar, c.map]);
  const isConflict = c.kind === 'conflict';
  return (
    <div style={st('border:1px solid #CFCFC9;border-radius:8px;overflow:hidden;margin-bottom:10px')}>
      <div style={st('padding:12px 14px;border-bottom:1px solid #EBEBE6')}>
        <div style={st('font-weight:650')}>{c.title}</div>
        <div className="mu" style={st('font-size:13px')}>{isConflict ? 'Modificato in entrambi i posti.' : 'Eliminato da Apple Calendario.'}</div>
        <div style={st('display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:8px;font-size:13px')}>
          <div><span className="mu">PRCD</span><br />{fmtFields(c.local)}</div>
          <div><span className="mu">Apple Calendario</span><br />{isConflict ? fmtFields(remote) : 'non esiste più'}</div>
        </div>
      </div>
      <div style={st('display:flex;gap:8px;padding:10px 14px;background:#FAFAF8;flex-wrap:wrap')}>
        {isConflict ? (
          <>
            <Btn variant="p" onClick={() => void ui.run(() => calendar.resolve(c.map, 'keep_local'), 'Tenuta la versione di PRCD')}>Tieni quella di PRCD</Btn>
            <Btn onClick={() => void ui.run(() => calendar.resolve(c.map, 'keep_remote'), 'Tenuta la versione di Apple')}>Tieni quella di Apple</Btn>
          </>
        ) : (
          <>
            <Btn variant="p" onClick={() => void ui.run(() => calendar.resolve(c.map, 'recreate'), 'Ricreato in Apple Calendario')}>Ricrea in Apple</Btn>
            <Btn onClick={() => ui.modal((close) => <ConfirmDialog title="Rimuovere anche da PRCD?" body={c.map.localKind === 'lesson' ? 'La lezione verrà segnata come annullata. Presenza e storico restano.' : 'L’evento verrà eliminato da PRCD.'} confirmLabel={c.map.localKind === 'lesson' ? 'Annulla la lezione' : 'Elimina evento'} danger onConfirm={() => void ui.run(() => calendar.resolve(c.map, 'remove_local'))} onClose={close} />)}>{c.map.localKind === 'lesson' ? 'Annulla la lezione qui' : 'Elimina anche qui'}</Btn>
            <Btn onClick={() => void ui.run(() => calendar.resolve(c.map, 'unlink'))}>Smetti di sincronizzare</Btn>
          </>
        )}
      </div>
    </div>
  );
}
