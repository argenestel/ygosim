import { useCallback, useEffect, useRef, useState } from "react";
import type { Timeline, TimelineEvent } from "./api";

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
 * Follow a match timeline with the server's opaque cursor: each poll returns only new events.
 * Stops once the server says the stream is final.
 */
export function useTimeline(fetch: (cursor: string) => Promise<Timeline>, key: string, live: boolean, intervalMs = 2500) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [error, setError] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const fetchRef = useRef(fetch);
  fetchRef.current = fetch;
  const state = useRef({ key, cursor: "", final: false });

  useEffect(() => {
    if (state.current.key !== key) { state.current = { key, cursor: "", final: false }; setEvents([]); setLoaded(false); }
    let on = true, timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      if (!on || state.current.final) return;
      if (document.hidden) { timer = setTimeout(tick, 1000); return; }
      try {
        const page = await fetchRef.current(state.current.cursor);
        if (!on) return;
        state.current.cursor = page.cursor; state.current.final = page.final;
        if (page.events.length) setEvents((e) => [...e, ...page.events].sort((a, b) => a.at - b.at));
        setError(undefined); setLoaded(true);
        if (!page.final) timer = setTimeout(tick, live ? intervalMs : 4000);
      } catch (e) {
        if (!on) return;
        setError(String((e as Error)?.message ?? e)); setLoaded(true);
        timer = setTimeout(tick, 10_000);
      }
    };
    tick();
    return () => { on = false; clearTimeout(timer); };
  }, [key, live, intervalMs]);

  return { events, error, loaded };
}

/** While `follow` is on (live games), keep a scroll container pinned to its newest row unless the reader scrolled away. */
export function useFollow<E extends HTMLElement>(count: number, follow = true) {
  const ref = useRef<E>(null);
  const pinned = useRef(follow);
  const [away, setAway] = useState(false);
  const onScroll = useCallback(() => {
    const el = ref.current; if (!el) return;
    const atEnd = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    pinned.current = atEnd; setAway((a) => (a === !atEnd ? a : !atEnd));
  }, []);
  useEffect(() => { pinned.current = follow; if (!follow) setAway(false); }, [follow]);
  useEffect(() => { const el = ref.current; if (el && follow && pinned.current) el.scrollTop = el.scrollHeight; }, [count, follow]);
  const jump = useCallback(() => { const el = ref.current; if (el) { el.scrollTop = el.scrollHeight; pinned.current = true; setAway(false); } }, []);
  return { ref, onScroll, away, jump };
}
