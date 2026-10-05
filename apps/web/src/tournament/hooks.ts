import { useCallback, useEffect, useRef, useState } from "react";
import type { Tail } from "./api";

/**
 * Poll `load` while `every(value)` returns a delay (ms); return false/0 to stop.
 * Unchanged responses keep the previous object so React skips the re-render
 * (the UI used to redraw everything every few seconds). Hidden tabs don't fetch.
 */
export function usePoll<T>(load: () => Promise<T>, deps: unknown[], every: (v: T | undefined) => number | false) {
  const [value, setValue] = useState<T>();
  const [error, setError] = useState<string>();
  const loadRef = useRef(load), everyRef = useRef(every);
  loadRef.current = load; everyRef.current = every;

  useEffect(() => {
    let on = true, timer: ReturnType<typeof setTimeout> | undefined, last = "";
    setValue(undefined); setError(undefined);
    const schedule = (ms: number) => { clearTimeout(timer); if (on && ms > 0) timer = setTimeout(tick, ms); };
    const tick = () => {
      if (document.hidden) return schedule(1000);
      loadRef.current().then((x) => {
        if (!on) return;
        const json = JSON.stringify(x);
        if (json !== last) { last = json; setValue(x); }
        setError(undefined);
        schedule(everyRef.current(x) || 0);
      }).catch((e) => { if (!on) return; setError(String(e?.message ?? e)); schedule(10_000); });
    };
    const wake = () => { if (!document.hidden) { clearTimeout(timer); tick(); } };
    document.addEventListener("visibilitychange", wake);
    tick();
    return () => { on = false; clearTimeout(timer); document.removeEventListener("visibilitychange", wake); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return [value, error] as const;
}

/**
 * Accumulate an append-only server list by asking only for rows after the ones
 * we already have. Keeps tailing while `live`, and makes one last fetch when the
 * game ends so the final rows are never missed.
 */
export function useTail<T>(fetchFrom: (from: number) => Promise<Tail<T>>, key: string, live: boolean, intervalMs = 2500) {
  const [rows, setRows] = useState<T[]>([]);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const fetchRef = useRef(fetchFrom);
  fetchRef.current = fetchFrom;
  const state = useRef({ key, from: 0 });

  useEffect(() => {
    if (state.current.key !== key) { state.current = { key, from: 0 }; setRows([]); setLoaded(false); }
    let on = true, timer: ReturnType<typeof setTimeout> | undefined, finals = live ? 0 : 1;
    const tick = async () => {
      if (!on) return;
      if (document.hidden) { timer = setTimeout(tick, 1000); return; }
      try {
        const { rows: next, total } = await fetchRef.current(state.current.from);
        if (!on) return;
        if (total < state.current.from) {
          // The source restarted (a resumed game starts fresh logs): drop stale rows and re-read from the top.
          state.current.from = 0; setRows([]); timer = setTimeout(tick, 0); return;
        }
        state.current.from = total;
        if (next.length) setRows((r) => [...r, ...next]);
        setError(undefined); setLoaded(true);
        if (live) timer = setTimeout(tick, intervalMs);
      } catch (e) {
        if (!on) return;
        setError(String((e as Error)?.message ?? e)); setLoaded(true);
        if (live || finals-- > 0) timer = setTimeout(tick, live ? 10_000 : 3000);
      }
    };
    tick();
    return () => { on = false; clearTimeout(timer); };
  }, [key, live, intervalMs]);

  return { rows, error, loaded };
}

/** Keep a scroll container pinned to its newest row unless the reader scrolled away. */
export function useFollow<E extends HTMLElement>(count: number) {
  const ref = useRef<E>(null);
  const pinned = useRef(true);
  const [away, setAway] = useState(false);
  const onScroll = useCallback(() => {
    const el = ref.current; if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    pinned.current = atEnd; setAway((a) => (a === !atEnd ? a : !atEnd));
  }, []);
  useEffect(() => { const el = ref.current; if (el && pinned.current) el.scrollTop = el.scrollHeight; }, [count]);
  const jump = useCallback(() => { const el = ref.current; if (el) { el.scrollTop = el.scrollHeight; pinned.current = true; setAway(false); } }, []);
  return { ref, onScroll, away, jump };
}
