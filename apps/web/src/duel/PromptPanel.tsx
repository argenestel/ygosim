import { useEffect, useRef, useState } from "react";
import type { Prompt, PromptOption } from "@ygosim/protocol";
import { validateSelection } from "@ygosim/protocol";
import { CardFace } from "./CardView";
import { useCardData } from "./Inspector";
import { CardIcon, CardTypeBadges } from "./CardTypeBadges";

const MULTI_KINDS = new Set<Prompt["kind"]>(["select_card", "select_tribute", "select_sum", "select_counter", "select_place"]);
export const isMulti = (p: Prompt) => p.constraints?.kind !== "interactive" &&
  (p.constraints?.kind === "tribute" || p.constraints?.kind === "sum" || MULTI_KINDS.has(p.kind) && ((p.max ?? 1) > 1 || p.min === 0));
export const isBoardMenu = (p: Prompt) => p.kind === "idle" || p.kind === "battle_idle";

interface Props {
  prompt: Prompt;
  selected: string[];
  toggle: (id: string) => void;
  submit: (ids: string[]) => void;
}

function Opt({ o, on, disabled, onClick }: { o: PromptOption; on?: boolean; disabled?: boolean; onClick: () => void }) {
  const data = useCardData(o.card?.code);
  return (
    <button className={`opt${on ? " on" : ""}${o.card?.code ? " has-card" : ""}`} disabled={disabled} onClick={onClick}>
      {o.card?.code !== undefined && <span className="opt-thumb"><CardFace code={o.card.code} /></span>}
      <span className="opt-label"><span>{o.label}</span>{data && <CardTypeBadges types={data.type} />}</span>
    </button>
  );
}

/** Data-driven decision UI: works for every Prompt.kind the engine can send. */
export function PromptPanel({ prompt, selected, toggle, submit }: Props) {
  const multi = isMulti(prompt);
  const min = prompt.min ?? 1, max = prompt.max ?? 1;
  const validity = validateSelection(prompt, selected);
  const constraints = prompt.constraints;
  const standalone = constraints?.kind === "tribute" || constraints?.kind === "count" ? constraints.cancel : undefined;
  let requirement = `Select ${min === max ? min : `${min}–${max}`} · ${selected.length} chosen`;
  if (constraints?.kind === "tribute") {
    const total = selected.reduce((n, id) => n + (constraints.values[id] ?? 0), 0);
    requirement = `Tribute value: ${total} / ${constraints.required} required · up to ${max} cards`;
  } else if (constraints?.kind === "sum") {
    const values = [...constraints.mandatory, ...selected.map((id) => constraints.values[id] ?? [])];
    const low = values.reduce((n, v) => n + (v.length ? Math.min(...v) : 0), 0);
    const high = values.reduce((n, v) => n + (v.length ? Math.max(...v) : 0), 0);
    requirement = `Selected contribution: ${low === high ? low : `${low}–${high}`} · ${constraints.mode === "exact" ? "exactly" : "at least"} ${constraints.target} required${constraints.mandatory.length ? " (includes mandatory materials)" : ""}`;
  }

  if (isBoardMenu(prompt)) return <ActionDock prompt={prompt} submit={submit} />;

  const yesNo = prompt.kind === "select_yesno" || prompt.kind === "select_effect_yn";
  return (
    <div className={`prompt-panel kind-${prompt.kind}`}>
      <div className="prompt-title">{prompt.kind === "select_place" ? "Choose a zone — click a glowing zone on the field" : prompt.text}</div>
      {multi && <div className="prompt-sub">{requirement}</div>}
      <div className={`opts${yesNo ? " row" : ""}`}>
        {prompt.options.map((o) => (
          <Opt key={o.id} o={o} on={selected.includes(o.id)} disabled={!multi && !validateSelection(prompt, [o.id]).valid}
            onClick={() => (multi && o.id !== standalone ? toggle(o.id) : submit([o.id]))} />
        ))}
      </div>
      {multi && (
        <>
          {!validity.valid && <div className="prompt-sub" role="status">{validity.reason}</div>}
          <button className="confirm" disabled={!validity.valid} onClick={() => submit(selected)}>Confirm</button>
        </>
      )}
    </div>
  );
}

/** Pop-up menu of the actions a single card offers during idle/battle. */
export function CardMenu({ options, at, onPick, onClose }: { options: PromptOption[]; at?: { x: number; y: number }; onPick: (id: string) => void; onClose: () => void }) {
  const data = useCardData(options[0]?.card?.code);
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const dismiss = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node)) onClose(); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [onClose]);
  const top = at ? Math.max(12, Math.min(at.y - 60, window.innerHeight - Math.min(window.innerHeight - 24, options.length * 52 + 120))) : Math.min(160, window.innerHeight / 3);
  const style = { left: at ? Math.max(12, Math.min(at.x + 14, window.innerWidth - 292)) : 16, top, maxHeight: window.innerHeight - top - 12 };
  return (
      <div ref={panel} className="card-menu compact floating" style={style} role="dialog" aria-label="Card actions">
        {data && <header className="card-menu-heading"><b>{data.name}</b><CardTypeBadges types={data.type} /></header>}
        <div className="card-menu-list">
          {options.map((o) => {
            const duplicates = options.filter(choice => choice.label === o.label);
            const ordinal = duplicates.findIndex(choice => choice.id === o.id) + 1;
            const kind = o.id.startsWith("attack") ? "Equip" : o.id.startsWith("pos_change") ? "Counter"
              : o.id.startsWith("special_summon") ? data?.type.find(type => ["Fusion", "Synchro", "Xyz", "Link", "Pendulum", "Ritual"].includes(type)) ?? "Monster"
              : data?.type.includes("Trap") ? "Trap" : data?.type.includes("Spell") ? "Spell" : "Monster";
            return <button key={o.id} data-action-id={o.id} onClick={() => onPick(o.id)}>
              <span className="card-action-icon"><CardIcon kind={kind} /></span>
              <span>{o.label}{duplicates.length > 1 ? ` (${o.id.startsWith("special_summon:") ? "procedure" : "choice"} ${ordinal} of ${duplicates.length})` : ""}</span>
            </button>;
          })}
          <button className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
  );
}

const PRIMARY = [/battle phase/i, /main phase 2/i, /end (phase|turn)/i];

/** Bottom-right dock: one clear "next step" button, the rest tucked behind ⋯. */
export function ActionDock({ prompt, submit, disabled }: { prompt: Prompt; submit: (ids: string[]) => void; disabled?: boolean }) {
  const [more, setMore] = useState(false);
  const global = prompt.options.filter((o) => !o.card);
  const steps = PRIMARY.map((re) => global.find((o) => re.test(o.label))).filter((o): o is PromptOption => !!o);
  const primary = steps[0];
  const rest = global.filter((o) => o !== primary);
  const playable = prompt.options.length - global.length;
  return (
    <div className={`action-dock${disabled ? " held" : ""}`}>
      <div className="hint-text">{disabled ? "Resolving…" : playable > 0 ? `${playable} action${playable > 1 ? "s" : ""} available — click a glowing card` : prompt.text}</div>
      <div className="dock-row">
        {rest.length > 0 && (
          <div className="dock-more">
            <button className="ghost" aria-label="More actions" disabled={disabled} onClick={() => setMore((m) => !m)}>⋯</button>
            {more && (
              <div className="dock-menu" onMouseLeave={() => setMore(false)}>
                {rest.map((o) => <button key={o.id} onClick={() => { setMore(false); submit([o.id]); }}>{o.label}</button>)}
              </div>
            )}
          </div>
        )}
        {primary && <button className="primary dock-main" disabled={disabled} onClick={() => submit([primary.id])}>{primary.label.replace(/^Go to /, "")} →</button>}
      </div>
    </div>
  );
}
