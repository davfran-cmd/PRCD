/**
 * End-of-lesson reminders ("Eri a lezione?" with Presente / Assente actions), scheduled as *local*
 * notifications — nothing leaves the device. Native only (@capacitor/local-notifications); a no-op on the web.
 * NOTE: not yet exercised on a simulator/device (see docs/IOS_BUILD.md).
 */
import { Capacitor } from '@capacitor/core';
import type { Repo } from '../db/repo';
import { lessonEnd } from '../domain/timetable';
import { localToDate } from '../domain/dates';

const ACTION_TYPE = 'ATTENDANCE';
const MAX_PENDING = 40; // iOS keeps at most 64 pending local notifications

const isNative = () => Capacitor.isNativePlatform();

export async function requestNotificationPermission(): Promise<boolean> {
  if (!isNative()) return false;
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  const cur = await LocalNotifications.checkPermissions();
  if (cur.display === 'granted') return true;
  return (await LocalNotifications.requestPermissions()).display === 'granted';
}

/** Hash a lesson id into the 31-bit integer id that the plugin needs. */
function numericId(id: string): number {
  let h = 5381;
  for (let i = 0; i < id.length; i++) h = ((h << 5) + h + id.charCodeAt(i)) | 0;
  return Math.abs(h) % 2_000_000_000;
}

export async function scheduleLessonReminders(repo: Repo, now = new Date()): Promise<void> {
  if (!isNative()) return;
  const settings = repo.getSettings();
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) await LocalNotifications.cancel({ notifications: pending.notifications });
  if (!settings.endOfLessonReminder) return;
  const perm = await LocalNotifications.checkPermissions();
  if (perm.display !== 'granted') return;
  const courses = new Map(repo.courses({ includeArchived: true }).map((c) => [c.id, c.name]));
  const lessons = repo
    .lessonsInRange(now.toISOString().slice(0, 10), new Date(now.getTime() + 21 * 86_400_000).toISOString().slice(0, 10))
    .filter((l) => !l.cancelled && l.attendance === 'to_confirm' && localToDate(lessonEnd(l)) > now)
    .slice(0, MAX_PENDING);
  await LocalNotifications.registerActionTypes({
    types: [{ id: ACTION_TYPE, actions: [{ id: 'present', title: 'Presente' }, { id: 'absent', title: 'Assente' }] }],
  });
  await LocalNotifications.schedule({
    notifications: lessons.map((l) => ({
      id: numericId(l.id),
      title: `${courses.get(l.courseId) ?? 'Lezione'} è finita`,
      body: `Eri a lezione oggi, ${l.startTime}–${l.endTime}?`,
      schedule: { at: localToDate(lessonEnd(l)) },
      actionTypeId: ACTION_TYPE,
      extra: { lessonId: l.id },
    })),
  });
}

/** Wire the notification actions to attendance changes. Returns a cleanup function. */
export async function listenForAttendanceActions(repo: Repo): Promise<() => void> {
  if (!isNative()) return () => {};
  const { LocalNotifications } = await import('@capacitor/local-notifications');
  const handle = await LocalNotifications.addListener('localNotificationActionPerformed', (e) => {
    const lessonId = (e.notification.extra as { lessonId?: string } | undefined)?.lessonId;
    if (!lessonId) return;
    if (e.actionId === 'present') repo.setAttendance(lessonId, 'attended');
    else if (e.actionId === 'absent') repo.setAttendance(lessonId, 'absent');
  });
  return () => void handle.remove();
}
