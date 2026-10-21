// Small shared pieces for the arena pages: who an agent is, what state an event is in.
import { useEffect, useState, type ReactNode } from "react";
import { cropUrl, getCard, onCardCache, peekCard } from "../api";
import { BrandMark, HostMark, brandInfo, identifyBrand, type BrandInfo } from "./brandMarks";
import type { TKind, TPlayer, TState } from "./api";

export type AgentRef = Pick<TPlayer, "id" | "label" | "model" | "provider" | "host" | "effort"> & { cli?: string };

export function brandOf(p: AgentRef): BrandInfo {
  return p.provider ? brandInfo(p.provider, p.host) : identifyBrand([p.id, p.label, p.model]);
}

const CLI: Record<string, string> = { codex: "Codex CLI", pi: "pi", claude: "Claude Code", agy: "Antigravity" };
export const cliText = (cli: string) => CLI[cli] ?? cli;

/** Provider mark + agent name; `detail` adds model and harness underneath. */
export function Agent({ p, detail, size = "sm", align = "left" }: { p: AgentRef; detail?: boolean; size?: "sm" | "md" | "lg"; align?: "left" | "right" }) {
  const brand = brandOf(p);
  return (
    <span className={`ar-agent ar-agent-${size}${align === "right" ? " right" : ""}`}>
      <BrandMark brand={brand} size={size} className="ar-agent-mark" />
      <span className="ar-agent-text">
        <b>{p.label}</b>
        {detail && <small>{p.model}{p.effort && p.effort !== "default" ? ` · ${p.effort}` : ""}{p.cli ? ` · ${cliText(p.cli)}` : ""}{brand.host ? " · " : ""}{brand.host && <HostMark />}</small>}
      </span>
    </span>
  );
}

export function StatePill({ state }: { state: TState }) {
  return <span className={`ar-pill ar-pill-${state}`}>{state === "live" ? <><i />Live</> : state === "paused" ? "Paused" : "Finished"}</span>;
}

export function KindTag({ kind }: { kind: TKind }) {
  return <span className={`ar-kind ar-kind-${kind}`}>{kind === "scored" ? "Scored" : kind === "validation" ? "Validation run" : "Legacy"}</span>;
}

/** Faded card art behind a block, the way the home screen's mode tiles use it. */
export function ArtBg({ code, side = "left" }: { code?: number; side?: "left" | "right" }) {
  if (!code) return null;
  return <span className={`ar-art ar-art-${side}`} style={{ backgroundImage: `url(${cropUrl(code)})` }} aria-hidden="true" />;
}

/** Card names/types for a set of codes; re-renders as the shared card cache fills. */
export function useCards(codes: number[]) {
  const [, bump] = useState(0);
  const key = codes.join(",");
  useEffect(() => {
    codes.forEach((c) => { if (!peekCard(c)) getCard(c); });
    return onCardCache(() => bump((n) => n + 1));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  return (code: number) => peekCard(code);
}

/** Re-render on an interval so relative times and live clocks stay honest without refetching. */
export function useNow(active: boolean, ms = 1000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { if (!active) return; const id = setInterval(() => setNow(Date.now()), ms); return () => clearInterval(id); }, [active, ms]);
  return now;
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return <div className="ar-empty"><span className="eyebrow">{title}</span>{children && <p>{children}</p>}</div>;
}

export function Back({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return <button className="ar-back" onClick={onClick}><span aria-hidden="true">←</span> {children}</button>;
}

/** Options that mean "do nothing here" — collapsed in the play-by-play by default. */
export const isRoutinePass = (kind: string, choice: string[]) =>
  ["select_chain", "select_effect_yn", "select_yesno"].includes(kind) && choice.length === 1 && /^(?:pass|no|do not activate|do not activate \/ pass|cancel)$/i.test(choice[0]!.trim());
