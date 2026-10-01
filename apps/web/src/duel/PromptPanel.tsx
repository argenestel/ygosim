import type { Prompt, PromptOption } from "@ygosim/protocol";
import { CardFace } from "./CardView";

const MULTI_KINDS = new Set<Prompt["kind"]>(["select_card", "select_tribute", "select_sum", "select_counter"]);
export const isMulti = (p: Prompt) => MULTI_KINDS.has(p.kind) && (p.max ?? 1) > 1;
export const isBoardMenu = (p: Prompt) => p.kind === "idle" || p.kind === "battle_idle";

interface Props {
  prompt: Prompt;
  selected: string[];
  toggle: (id: string) => void;
  submit: (ids: string[]) => void;
}

function Opt({ o, on, onClick }: { o: PromptOption; on?: boolean; onClick: () => void }) {
  return (
    <button className={`opt${on ? " on" : ""}${o.card?.code ? " has-card" : ""}`} onClick={onClick}>
      {o.card?.code !== undefined && <span className="opt-thumb"><CardFace code={o.card.code} /></span>}
      <span>{o.label}</span>
    </button>
  );
}

/** Data-driven decision UI: works for every Prompt.kind the engine can send. */
export function PromptPanel({ prompt, selected, toggle, submit }: Props) {
  const multi = isMulti(prompt);
  const min = prompt.min ?? 1, max = prompt.max ?? 1;

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
      <div className="prompt-title">{prompt.text}</div>
      {multi && <div className="prompt-sub">Select {min === max ? min : `${min}–${max}`} · {selected.length} chosen</div>}
      <div className={`opts${yesNo ? " row" : ""}`}>
        {prompt.options.map((o) => (
          <Opt key={o.id} o={o} on={selected.includes(o.id)} onClick={() => (multi ? toggle(o.id) : submit([o.id]))} />
        ))}
      </div>
      {multi && (
        <button className="confirm" disabled={selected.length < min || selected.length > max} onClick={() => submit(selected)}>
          Confirm
        </button>
      )}
    </div>
  );
}

/** Pop-up menu of the actions a single card offers during idle/battle. */
export function CardMenu({ options, onPick, onClose }: { options: PromptOption[]; onPick: (id: string) => void; onClose: () => void }) {
  return (
    <div className="card-menu-backdrop" onClick={onClose}>
      <div className="card-menu" onClick={(e) => e.stopPropagation()}>
        {options[0]?.card?.code !== undefined && <div className="card-menu-art"><CardFace code={options[0].card!.code!} /></div>}
        <div className="card-menu-list">
          {options.map((o) => <button key={o.id} onClick={() => onPick(o.id)}>{o.label}</button>)}
          <button className="ghost" onClick={onClose}>Cancel</button>
        </div>
      </div>
    </div>
  );
}
