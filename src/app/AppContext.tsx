import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import type { Database } from '../db/database';
import { Repo, ValidationError } from '../db/repo';
import { TimetableError } from '../domain/timetable';
import { ArchiveError } from '../db/backup';
import type { FileStore } from '../storage/fileStore';
import { localNow, todayISO } from '../domain/dates';
import type { Settings } from '../domain/types';
import type { CalendarService } from '../calendar/service';

export interface Services {
  db: Database;
  repo: Repo;
  files: FileStore;
  calendar: CalendarService;
}

const Ctx = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <Ctx.Provider value={services}>{children}</Ctx.Provider>;
}

export function useServices(): Services {
  const s = useContext(Ctx);
  if (!s) throw new Error('ServicesProvider missing');
  return s;
}

/** Re-runs `fn` whenever the database changes (any table) or `deps` change. */
export function useQuery<T>(fn: (repo: Repo) => T, deps: unknown[] = []): T {
  const { db, repo } = useServices();
  const version = useDbVersion(db);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => fn(repo), [repo, version, ...deps]);
}

const versions = new WeakMap<Database, { n: number; listeners: Set<() => void>; unsub: () => void }>();
function useDbVersion(db: Database): number {
  let entry = versions.get(db);
  if (!entry) {
    const listeners = new Set<() => void>();
    const e = { n: 0, listeners, unsub: () => {} };
    e.unsub = db.subscribe(() => {
      e.n += 1;
      listeners.forEach((l) => l());
    });
    versions.set(db, e);
    entry = e;
  }
  const e = entry;
  return useSyncExternalStore(
    (cb) => {
      e.listeners.add(cb);
      return () => e.listeners.delete(cb);
    },
    () => e.n,
  );
}

/** Wall-clock "now", refreshed every 30 s so the "now" line and today's agenda stay current. */
export function useNow(): { date: Date; local: string; today: string } {
  const [date, setDate] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setDate(new Date()), 30_000);
    const vis = () => document.visibilityState === 'visible' && setDate(new Date());
    document.addEventListener('visibilitychange', vis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', vis);
    };
  }, []);
  return useMemo(() => ({ date, local: localNow(date), today: todayISO(date) }), [date]);
}

export function useSettings(): Settings {
  return useQuery((r) => r.getSettings());
}

// ---------------------------------------------------------------------------- toasts & errors

interface ToastState {
  id: number;
  text: string;
  actionLabel?: string;
  onAction?: () => void;
  error?: boolean;
}

interface UiApi {
  toast: (text: string, opts?: { actionLabel?: string; onAction?: () => void; error?: boolean; ms?: number }) => void;
  modal: (render: (close: () => void) => ReactNode) => void;
  closeModal: () => void;
  /** Runs `fn`, shows a readable message on failure instead of crashing or failing silently. */
  run: <T>(fn: () => T | Promise<T>, okMessage?: string) => Promise<T | undefined>;
}

const UiCtx = createContext<UiApi | null>(null);
export const useUi = (): UiApi => {
  const u = useContext(UiCtx);
  if (!u) throw new Error('UiProvider missing');
  return u;
};

export function messageOf(e: unknown): string {
  if (e instanceof ValidationError || e instanceof TimetableError || e instanceof ArchiveError) return e.message;
  if (e instanceof Error) return /constraint|UNIQUE|FOREIGN KEY/i.test(e.message) ? 'Operazione non consentita: i dati sono collegati ad altri elementi.' : `Errore: ${e.message}`;
  return 'Errore sconosciuto';
}

export function UiProvider({ children }: { children: ReactNode }) {
  const [toastState, setToast] = useState<ToastState | null>(null);
  const [modalStack, setModalStack] = useState<Array<{ id: number; render: (close: () => void) => ReactNode }>>([]);
  const counter = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const toast = useCallback<UiApi['toast']>((text, opts = {}) => {
    const id = ++counter.current;
    setToast({ id, text, actionLabel: opts.actionLabel, onAction: opts.onAction, error: opts.error });
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast((t) => (t?.id === id ? null : t)), opts.ms ?? (opts.actionLabel ? 8000 : 4000));
  }, []);

  const closeModal = useCallback(() => setModalStack((s) => s.slice(0, -1)), []);
  const modal = useCallback<UiApi['modal']>((render) => setModalStack((s) => [...s, { id: ++counter.current, render }]), []);

  const run = useCallback<UiApi['run']>(
    async (fn, okMessage) => {
      try {
        const r = await fn();
        if (okMessage) toast(okMessage);
        return r;
      } catch (e) {
        toast(messageOf(e), { error: true, ms: 6000 });
        return undefined;
      }
    },
    [toast],
  );

  useEffect(() => {
    if (!modalStack.length) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeModal();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [modalStack.length, closeModal]);

  const api = useMemo(() => ({ toast, modal, closeModal, run }), [toast, modal, closeModal, run]);
  return (
    <UiCtx.Provider value={api}>
      {children}
      {modalStack.map((m) => (
        <div key={m.id}>{m.render(closeModal)}</div>
      ))}
      {toastState && (
        <div className={`toast${toastState.error ? ' err' : ''}`} role="status" aria-live="polite">
          <span style={{ flex: 1 }}>{toastState.text}</span>
          {toastState.actionLabel && (
            <button
              onClick={() => {
                toastState.onAction?.();
                setToast(null);
              }}
            >
              {toastState.actionLabel}
            </button>
          )}
        </div>
      )}
    </UiCtx.Provider>
  );
}
