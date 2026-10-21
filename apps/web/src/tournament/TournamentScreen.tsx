// Agent Arena: hub → tournament → match, each with its own URL (?tournament=<id>&game=<id>).
import { useEffect, useState } from "react";
import { listTournaments, stateOf, type GameView } from "./api";
import { EventPage } from "./EventPage";
import { usePoll } from "./hooks";
import { Hub } from "./Hub";
import { MatchPage } from "./MatchPage";

interface Route { tid?: string; gid?: string }
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function readRoute(): Route {
  const q = new URLSearchParams(location.search);
  const tid = q.get("tournament"), gid = q.get("game");
  return tid && tid !== "board" && ID.test(tid) ? { tid, gid: gid && ID.test(gid) ? gid : undefined } : {};
}

function writeRoute(r: Route, push: boolean) {
  const q = new URLSearchParams(location.search);
  q.delete("tournament"); q.delete("game");
  if (r.tid) q.set("tournament", r.tid);
  if (r.tid && r.gid) q.set("game", r.gid);
  const url = `${location.pathname}${q.size ? `?${q}` : ""}${location.hash}`;
  if (url !== `${location.pathname}${location.search}${location.hash}`) history[push ? "pushState" : "replaceState"](null, "", url);
}

export function TournamentScreen({ onReplay }: { onReplay: (v: GameView) => void }) {
  const [route, setRoute] = useState<Route>(readRoute);
  const [list, listErr] = usePoll(listTournaments, [], (l) => (l?.some((t) => stateOf(t) === "live") ? 5000 : 20_000));

  useEffect(() => {
    const onPop = () => setRoute(readRoute());
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);
  useEffect(() => { document.querySelector(".page")?.scrollTo({ top: 0 }); }, [route.tid, route.gid]);

  const go = (r: Route) => { writeRoute(r, true); setRoute(r); };

  if (route.tid && route.gid) return <MatchPage key={`${route.tid}/${route.gid}`} tid={route.tid} gid={route.gid} onBack={() => go({ tid: route.tid })} onReplay={onReplay} />;
  if (route.tid) return <EventPage key={route.tid} tid={route.tid} onBack={() => go({})} onGame={(gid) => go({ tid: route.tid, gid })} />;
  return <Hub list={list} error={listErr} onOpen={(tid) => go({ tid })} />;
}

/** True when the page was opened on an arena URL, so the app can start on the Tournament tab. */
export const hasArenaRoute = () => !!readRoute().tid;
