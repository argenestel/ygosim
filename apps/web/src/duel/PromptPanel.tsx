import type { Prompt, PromptOption } from "@ygosim/protocol";
import { validateSelection } from "@ygosim/protocol";
import { CardFace } from "./CardView";

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
  return (
    <button className={`opt${on ? " on" : ""}${o.card?.code ? " has-card" : ""}`} disabled={disabled} onClick={onClick}>
      {o.card?.code !== undefined && <span className="opt-thumb"><CardFace code={o.card.code} /></span>}
      <span>{o.label}</span>
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

  if (isBoardMenu(prompt)) {
    // Card-bound options are picked on the board; only global ones go in the rail.
    const global = prompt.options.filter((o) => !o.card);
    return (
      <div className="phase-actions">
        <div className="hint-text">{prompt.text}</div>
        {global.map((o) => <button key={o.id} className="phase-btn" onClick={() => submit([o.id])}>{o.label}</button>)}
      </div>
    );
  }

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
  // Pop up next to the clicked card (clamped on screen); centre as a fallback.
  const style = at ? { position: "absolute" as const, left: Math.min(Math.max(12, at.x + 14), window.innerWidth - 300), top: Math.min(Math.max(12, at.y - 60), window.innerHeight - 60 - options.length * 46) } : undefined;
  return (
    <div className={`card-menu-backdrop${at ? " anchored" : ""}`} onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }}>
      <div className={`card-menu${at ? " compact" : ""}`} style={style} onClick={(e) => e.stopPropagation()}>
        {!at && options[0]?.card?.code !== undefined && <div className="card-menu-art"><CardFace code={options[0].card!.code!} /></div>}
        <div className="card-menu-list">
          {options.map((o) => {
            const duplicates = options.filter(choice => choice.label === o.label);
            const ordinal = duplicates.findIndex(choice => choice.id === o.id) + 1;
            return <button key={o.id} data-action-id={o.id} onClick={() => onPick(o.id)}>
              {o.label}{duplicates.length > 1 ? ` (${o.id.startsWith("special_summon:") ? "procedure" : "choice"} ${ordinal} of ${duplicates.length})` : ""}
            </button>;
          })}
          <button className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
