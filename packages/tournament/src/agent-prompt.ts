import type { Game, Player, Tournament } from './types.js';

export function agentPrompt(tournament: Tournament, game: Game, player: Player): string {
  const opponent = tournament.players.find(p => p.id === game.seats.find(id => id !== player.id))!;
  const customOnly = (tournament.deckPolicy ?? tournament.audit?.deckPolicy ?? 'choice') === 'custom-only';
  const deckInstructions = customOnly
    ? `You MUST independently build a legal TCG deck before entering. NO provided/sample decks exist in this game: list_decks does not exist; never ask for, select, or copy one. Workflow:
1. First call card_info with code, name, or query to research passcodes, effects, the TCG banlist (Forbidden/Limited/Semi-Limited), and pick a coherent archetype/strategy. Obey max 3 copies per card.
2. Build 40–60 main cards with a win condition and monster/spell/trap ratio; up to 15 extra cards, only Fusion/Synchro/Xyz/Link; and up to 15 side cards. Choose staples and hand traps deliberately.
3. Call enter_match with your own main/extra/side passcode arrays or YDK. In reason explain the archetype, win condition/matchup plan, monster/spell/trap ratio, staples/hand traps, and extra-deck plan. Never use a sample name or copy a supplied list.
4. If enter_match rejects the deck, read the exact game validation error, fix and retry. Check counts, banlist status, unknown passcodes, and exact sample-copy rejection; never give up or fall back to a sample. The runner saves JSON and YDK; no filesystem tools are needed.`
    : 'Choose a legal deck using list_decks or build one using card_info. Call enter_match with deck (sample name), ydk, or main/extra passcodes and a strategic reason explaining your deck choice. The runner saves your exact chosen deck as JSON and YDK.';
  return `You are ${player.label} in tournament ${tournament.name}, game ${game.id}, ${game.stage} round ${game.round}, against ${opponent.label}.${tournament.series ? ' This is a first-to-two-wins, best-of-three series with alternating seats. Choose a legal deck for this duel; each game is a separate duel.' : ''}
Play a complete Yu-Gi-Oh duel using the ygosim MCP tools. ${deckInstructions}
Then play until the tool reports DUEL OVER: use wait_for_turn while waiting, and on every act provide choose (the displayed 1-based number or exact option ID) plus reason (your strategic explanation). Use get_state to inspect the duel; if an act fails, call get_state, correct the choice, and act again. Use card_info whenever an effect is unfamiliar. Never stop early, even when no decision is pending. Finish only after DUEL OVER.`;
}

export const CONTINUE_PROMPT = 'Duel still running. Call get_state/wait_for_turn, keep playing until DUEL OVER.';
