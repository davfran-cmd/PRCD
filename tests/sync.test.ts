import { describe, expect, it } from 'vitest';
import { MockCalendarBridge } from '../src/calendar/mock';
import { CalendarService } from '../src/calendar/service';
import { mergeFields, readMaps, type Fields } from '../src/calendar/sync';
import { parseMarker, markerUrl } from '../src/calendar/bridge';
import { clockAt, seedDesign } from './helpers';

async function setup(now = clockAt(2026, 11, 16, 9, 0)) {
  const ctx = await seedDesign(now);
  const bridge = new MockCalendarBridge();
  bridge.grant();
  const service = new CalendarService(ctx.repo, bridge, { clock: now, debounceMs: 5 });
  ctx.repo.updateSettings({ appleCalendarEnabled: true, appleSyncLessons: true });
  return { ...ctx, bridge, service };
}

const lessonEvents = (b: MockCalendarBridge) => b.eventsWithUrlPrefix('prcd://lesson/');

describe('Apple Calendar sync', () => {
  it('requests permission only when the user enables the integration, and creates the "Procedo" calendar once', async () => {
    const ctx = await seedDesign();
    const bridge = new MockCalendarBridge();
    const service = new CalendarService(ctx.repo, bridge, { clock: clockAt(2026, 11, 16), debounceMs: 5 });
    await service.init();
    expect(bridge.promptCount).toBe(0); // init never prompts
    expect(service.getState().auth).toBe('notDetermined');
    expect(await service.enable()).toBe('fullAccess');
    expect(bridge.promptCount).toBe(1);
    await service.syncNow();
    await service.syncNow();
    expect(bridge.calendars.filter((c) => c.title === 'Procedo')).toHaveLength(1);
    expect(ctx.repo.getSettings().appleManagedCalendarId).toBe(bridge.calendars.find((c) => c.title === 'Procedo')!.id);
    service.dispose();
  });

  it('a denied prompt leaves the integration off and the rest of the app untouched', async () => {
    const ctx = await seedDesign();
    const bridge = new MockCalendarBridge();
    bridge.promptResult = 'denied';
    const service = new CalendarService(ctx.repo, bridge, { clock: clockAt(2026, 11, 16) });
    expect(await service.enable()).toBe('denied');
    expect(ctx.repo.getSettings().appleCalendarEnabled).toBe(false);
    expect(service.getState().enabled).toBe(false);
    expect(ctx.repo.courses()).toHaveLength(3); // nothing broke
    expect(bridge.events.size).toBe(0);
  });

  it('write-only access (iOS 17 "add only") is not treated as sufficient', async () => {
    const ctx = await seedDesign();
    const bridge = new MockCalendarBridge();
    bridge.authStatus = 'writeOnly';
    const service = new CalendarService(ctx.repo, bridge, { clock: clockAt(2026, 11, 16) });
    expect(await service.enable()).toBe('writeOnly');
    expect(service.getState().enabled).toBe(false);
  });

  it('publishes every lesson as its own event (not one repeating event), with a stable marker', async () => {
    const { repo, bridge, service, meccanica } = await setup();
    await service.syncNow();
    const mine = repo.lessonsForCourse(meccanica.id).filter((l) => !l.cancelled && l.date >= '2026-10-17' && l.date <= '2027-01-15'); // within the window
    const events = lessonEvents(bridge);
    expect(events.length).toBeGreaterThan(30);
    for (const l of mine) {
      const ev = events.find((e) => parseMarker(e.url)?.id === l.id);
      expect(ev, `lesson ${l.date}`).toBeDefined();
      expect(ev).toMatchObject({ title: 'Meccanica razionale', start: `${l.date}T${l.startTime}`, end: `${l.date}T${l.endTime}`, allDay: false });
    }
    // no classroom/teacher information is ever sent
    expect(events.every((e) => e.location === '')).toBe(true);
    const maps = readMaps(repo);
    expect(maps.every((m) => m.status === 'synced')).toBe(true);
    service.dispose();
  });

  it('is idempotent and never creates duplicates, even when the id mapping is lost', async () => {
    const { repo, db, bridge, service } = await setup();
    await service.syncNow();
    const count = bridge.events.size;
    await service.syncNow();
    expect(bridge.events.size).toBe(count);
    // lose the whole mapping table (restore from an old backup, reinstall…)
    db.run('DELETE FROM sync_map');
    const report = await service.syncNow();
    expect(bridge.events.size).toBe(count); // adopted by marker, not recreated
    expect(report.adopted).toBe(count);
    expect(report.created).toBe(0);
    expect(readMaps(repo).every((m) => m.status === 'synced')).toBe(true);
    service.dispose();
  });

  it('survives EventKit changing an eventIdentifier (re-found by marker / external id)', async () => {
    const { repo, bridge, service, meccanica } = await setup();
    await service.syncNow();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-26')!;
    const old = lessonEvents(bridge).find((e) => parseMarker(e.url)!.id === l.id)!;
    const newId = bridge.changeIdentifier(old.ekEventId);
    const total = bridge.events.size;
    const report = await service.syncNow();
    expect(bridge.events.size).toBe(total); // no duplicate, no loss
    expect(report.created).toBe(0);
    expect(report.remoteDeleted).toBe(0);
    expect(readMaps(repo).find((m) => m.localId === l.id)!.ekEventId).toBe(newId);
    service.dispose();
  });

  it('moving a lesson in PRCD updates the Apple event; attendance is untouched', async () => {
    const { repo, bridge, service, meccanica } = await setup();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-26')!;
    repo.setAttendance(l.id, 'absent');
    await service.syncNow();
    repo.editLesson(l.id, 'one', { date: '2026-11-27', startTime: '16:30', endTime: '18:30' });
    await service.syncNow();
    const ev = lessonEvents(bridge).find((e) => parseMarker(e.url)!.id === l.id)!;
    expect(ev).toMatchObject({ start: '2026-11-27T16:30', end: '2026-11-27T18:30' });
    expect(repo.lesson(l.id)!.attendance).toBe('absent');
    service.dispose();
  });

  it('moving the event in Apple Calendar moves the local occurrence without touching attendance', async () => {
    const { repo, bridge, service, meccanica } = await setup();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-26')!;
    repo.setAttendance(l.id, 'recovered');
    await service.syncNow();
    const ev = lessonEvents(bridge).find((e) => parseMarker(e.url)!.id === l.id)!;
    bridge.userMoves(ev.ekEventId, '2026-11-28T09:00', '2026-11-28T11:00');
    await service.syncNow();
    const after = repo.lesson(l.id)!;
    expect(after).toMatchObject({ id: l.id, date: '2026-11-28', startTime: '09:00', endTime: '11:00', attendance: 'recovered', isException: true });
    expect(after.attendanceAt).toBe(repo.lesson(l.id)!.attendanceAt);
    expect(repo.rule(after.ruleId!)!.startTime).toBe('14:15'); // the rule is untouched: this is an exception
    service.dispose();
  });

  it('ignores a title edit on a lesson event (the title belongs to the course) and does not revert it needlessly', async () => {
    const { repo, bridge, service, meccanica } = await setup();
    await service.syncNow();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-26')!;
    const ev = lessonEvents(bridge).find((e) => parseMarker(e.url)!.id === l.id)!;
    bridge.userRenames(ev.ekEventId, 'Mecc. (aula nuova)');
    const report = await service.syncNow();
    expect(report.conflicts).toBe(0);
    expect(repo.course(meccanica.id)!.name).toBe('Meccanica razionale');
    service.dispose();
  });

  it('detects a conflict when both sides moved the same lesson, and overwrites neither', async () => {
    const { repo, bridge, service, meccanica } = await setup();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-26')!;
    await service.syncNow();
    const ev = lessonEvents(bridge).find((e) => parseMarker(e.url)!.id === l.id)!;
    repo.editLesson(l.id, 'one', { date: '2026-11-26', startTime: '16:00', endTime: '18:00' }); // local
    bridge.userMoves(ev.ekEventId, '2026-11-26T09:00', '2026-11-26T11:00'); // remote
    const report = await service.syncNow();
    expect(report.conflicts).toBe(1);
    expect(repo.lesson(l.id)).toMatchObject({ startTime: '16:00' }); // local untouched
    expect(bridge.events.get(ev.ekEventId)).toMatchObject({ start: '2026-11-26T09:00' }); // remote untouched
    expect(service.getState().conflicts).toHaveLength(1);
    // a second sync keeps the conflict (it does not silently resolve it)
    await service.syncNow();
    expect(service.getState().conflicts).toHaveLength(1);

    // user chooses Apple Calendar's version
    await service.resolve(service.getState().conflicts[0].map, 'keep_remote');
    expect(repo.lesson(l.id)).toMatchObject({ startTime: '09:00', endTime: '11:00' });
    expect(service.getState().conflicts).toHaveLength(0);
    service.dispose();
  });

  it('"keep mine" pushes the local version over the Apple one after an explicit choice', async () => {
    const { repo, bridge, service, meccanica } = await setup();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-12-03')!;
    await service.syncNow();
    const ev = lessonEvents(bridge).find((e) => parseMarker(e.url)!.id === l.id)!;
    repo.editLesson(l.id, 'one', { date: '2026-12-03', startTime: '16:00', endTime: '18:00' });
    bridge.userMoves(ev.ekEventId, '2026-12-03T09:00', '2026-12-03T11:00');
    await service.syncNow();
    await service.resolve(service.getState().conflicts[0].map, 'keep_local');
    expect(bridge.events.get(ev.ekEventId)).toMatchObject({ start: '2026-12-03T16:00', end: '2026-12-03T18:00' });
    expect(repo.lesson(l.id)!.startTime).toBe('16:00');
    service.dispose();
  });

  it('an event deleted in Apple Calendar is reported, never silently recreated or deleted locally', async () => {
    const { repo, bridge, service, meccanica } = await setup();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-26')!;
    repo.setAttendance(l.id, 'attended');
    await service.syncNow();
    const ev = lessonEvents(bridge).find((e) => parseMarker(e.url)!.id === l.id)!;
    bridge.userDeletes(ev.ekEventId);
    const before = bridge.events.size;
    const report = await service.syncNow();
    expect(report.remoteDeleted).toBe(1);
    expect(bridge.events.size).toBe(before); // not recreated behind the user's back
    expect(repo.lesson(l.id)).toBeDefined(); // local data intact
    const pending = service.getState().conflicts.find((c) => c.map.localId === l.id)!;
    expect(pending.kind).toBe('remote_deleted');

    await service.resolve(pending.map, 'recreate');
    expect(lessonEvents(bridge).some((e) => parseMarker(e.url)!.id === l.id)).toBe(true);
    service.dispose();
  });

  it('"remove locally" cancels a lesson softly: the row and its attendance stay', async () => {
    const { repo, bridge, service, meccanica } = await setup();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-26')!;
    repo.setAttendance(l.id, 'attended');
    await service.syncNow();
    bridge.userDeletes(lessonEvents(bridge).find((e) => parseMarker(e.url)!.id === l.id)!.ekEventId);
    await service.syncNow();
    await service.resolve(service.getState().conflicts.find((c) => c.map.localId === l.id)!.map, 'remove_local');
    expect(repo.lesson(l.id)).toMatchObject({ cancelled: true, attendance: 'attended' });
    service.dispose();
  });

  it('cancelling a lesson in PRCD removes its Apple event; restoring it creates it again', async () => {
    const { repo, bridge, service, meccanica } = await setup();
    const l = repo.lessonsForCourse(meccanica.id).find((x) => x.date === '2026-11-26')!;
    await service.syncNow();
    repo.cancelLesson(l.id, true);
    await service.syncNow();
    expect(lessonEvents(bridge).some((e) => parseMarker(e.url)!.id === l.id)).toBe(false);
    repo.cancelLesson(l.id, false);
    await service.syncNow();
    expect(lessonEvents(bridge).filter((e) => parseMarker(e.url)!.id === l.id)).toHaveLength(1);
    service.dispose();
  });

  it('never touches third-party events: they are cached read-only and only for the calendars the user picked', async () => {
    const { repo, bridge, service } = await setup();
    const dentist = bridge.addThirdParty('cal-icloud', { title: 'Dentista', start: '2026-11-24T17:30', end: '2026-11-24T18:30' });
    const fam = bridge.addThirdParty('cal-family', { title: 'Mercato', start: '2026-11-21T10:00', end: '2026-11-21T12:00' });
    await service.syncNow();
    const cached = repo.db.all<{ title: string }>('SELECT title FROM external_events ORDER BY title').map((r) => r.title);
    expect(cached).toEqual(['Dentista', 'Mercato']);
    service.setCalendarVisible('cal-family', false);
    expect(repo.db.all<{ title: string }>('SELECT title FROM external_events').map((r) => r.title)).toEqual(['Dentista']);
    // deleting everything PRCD made must not remove their events
    await service.removeLessonEventsFromApple();
    expect(bridge.events.has(dentist.ekEventId)).toBe(true);
    expect(bridge.events.has(fam.ekEventId)).toBe(true);
    service.dispose();
  });

  it('personal events: created in a chosen calendar, edited both ways, deleted with their Apple event', async () => {
    const { repo, bridge, service } = await setup();
    const e = repo.createEvent({ title: 'Studio Fisica 2', category: 'study', start: '2026-11-26T15:00', end: '2026-11-26T17:00', appleCalendarId: 'cal-icloud' });
    await service.syncNow();
    const remote = bridge.eventsWithUrlPrefix(markerUrl('event', e.id))[0];
    expect(remote).toMatchObject({ calendarId: 'cal-icloud', title: 'Studio Fisica 2' });
    // local edit → Apple
    repo.updateEvent(e.id, { title: 'Studio Fisica 2: induzione' });
    await service.syncNow();
    expect(bridge.events.get(remote.ekEventId)!.title).toBe('Studio Fisica 2: induzione');
    // Apple edit → local (all fields are pulled for personal events)
    bridge.userMoves(remote.ekEventId, '2026-11-27T10:00', '2026-11-27T12:00');
    await service.syncNow();
    expect(repo.event(e.id)).toMatchObject({ start: '2026-11-27T10:00', end: '2026-11-27T12:00' });
    // local delete → Apple event removed
    repo.deleteEvent(e.id);
    await service.syncNow();
    expect(bridge.events.has(remote.ekEventId)).toBe(false);
    service.dispose();
  });

  it('recurring personal events sync occurrence by occurrence, honouring cancelled occurrences', async () => {
    const { repo, bridge, service } = await setup();
    const e = repo.createEvent({ title: 'Palestra', category: 'event', start: '2026-11-16T18:30', end: '2026-11-16T20:00', recurrence: { freq: 'weekly', interval: 1, until: '2026-12-31' }, appleCalendarId: 'managed' });
    await service.syncNow();
    const mine = () => bridge.eventsWithUrlPrefix(`prcd://event/${encodeURIComponent(`${e.id}@`)}`);
    const n = mine().length;
    expect(n).toBeGreaterThan(5);
    repo.setEventException(e.id, '2026-11-23', { cancelled: true });
    await service.syncNow();
    expect(mine()).toHaveLength(n - 1);
    expect(mine().some((x) => x.start.startsWith('2026-11-23'))).toBe(false);
    service.dispose();
  });

  it('revoked permission pauses sync without breaking the app, keeps every mapping, and resumes when re-granted', async () => {
    const { repo, bridge, service } = await setup();
    await service.syncNow();
    const mapCount = readMaps(repo).length;
    bridge.revoke();
    const report = await service.syncNow();
    expect(report.created + report.updated).toBe(0);
    expect(service.getState().auth).toBe('denied');
    expect(service.getState().error).toMatch(/revocato/);
    expect(readMaps(repo)).toHaveLength(mapCount); // nothing forgotten
    expect(repo.courses()).toHaveLength(3); // app unaffected
    repo.cancelLesson(repo.lessonsForCourse(repo.courses()[0].id)[10].id, true); // local edits keep working
    bridge.grant();
    await service.syncNow();
    expect(service.getState().auth).toBe('fullAccess');
    expect(service.getState().error).toBeNull();
    service.dispose();
  });

  it('refreshes when EventKit reports a store change and when the app returns to the foreground (debounced)', async () => {
    const { repo, bridge, service } = await setup();
    await service.init();
    await service.enable();
    const l = repo.lessonsForCourse(repo.courses()[0].id).find((x) => x.date >= '2026-11-17')!;
    const ev = lessonEvents(bridge).find((e) => parseMarker(e.url)!.id === l.id)!;
    bridge.userMoves(ev.ekEventId, `${l.date}T07:00`, `${l.date}T09:00`); // emits a store change
    await new Promise((r) => setTimeout(r, 120));
    expect(repo.lesson(l.id)!.startTime).toBe('07:00');
    service.dispose();
  });

  it('is single-flight: overlapping sync requests never run concurrently', async () => {
    const { bridge, service } = await setup();
    const a = service.syncNow();
    const b = service.syncNow();
    await Promise.all([a, b]);
    await new Promise((r) => setTimeout(r, 30));
    expect(bridge.calendars.filter((c) => c.title === 'Procedo')).toHaveLength(1);
    service.dispose();
  });
});

describe('three-way field merge', () => {
  const base: Fields = { title: 'A', notes: '', start: '2026-11-26T10:00', end: '2026-11-26T12:00', allDay: false };
  it('pushes local-only and pulls remote-only changes', () => {
    expect(mergeFields('event', { ...base, title: 'B' }, base, base, base)).toEqual({ push: { title: 'B' }, pull: {}, conflicts: [] });
    expect(mergeFields('event', base, { ...base, start: '2026-11-26T11:00' }, base, base)).toEqual({ push: {}, pull: { start: '2026-11-26T11:00' }, conflicts: [] });
  });
  it('merges changes to different fields without conflict, flags the same field changed differently', () => {
    const r = mergeFields('event', { ...base, title: 'B' }, { ...base, start: '2026-11-26T11:00' }, base, base);
    expect(r.conflicts).toEqual([]);
    expect(r.push).toEqual({ title: 'B' });
    expect(r.pull).toEqual({ start: '2026-11-26T11:00' });
    expect(mergeFields('event', { ...base, title: 'B' }, { ...base, title: 'C' }, base, base).conflicts).toEqual(['title']);
    expect(mergeFields('event', { ...base, title: 'B' }, { ...base, title: 'B' }, base, base).conflicts).toEqual([]); // same change on both sides
  });
});
