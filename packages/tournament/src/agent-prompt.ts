import type { Game, Player, Tournament } from './types.js';

export function agentPrompt(tournament: Tournament, game: Game, player: Player): string {
  const opponent = tournament.players.find(p => p.id === game.seats.find(id => id !== player.id))!;
  return `You are ${player.label} in tournament ${tournament.name}, game ${game.id}, ${game.stage} round ${game.round}, against ${opponent.label}.
Play a complete Yu-Gi-Oh duel using the ygosim MCP tools. Choose a legal deck using list_decks or build one using card_info. Call enter_match with deck (sample name), ydk, or main/extra passcodes and a strategic reason explaining your deck choice.
Loop wait_for_turn and act until the tool reports DUEL OVER. Every act requires choose (the displayed 1-based numbers or exact option IDs) and reason (your strategic explanation). Reasons are logged privately. Use card_info to check unfamiliar effects. If waiting for the opponent, keep calling wait_for_turn. If an action fails, inspect get_state and correct it. Never stop early, even if no decision is pending. Finish only after DUEL OVER.`;
}

export const CONTINUE_PROMPT = 'Duel still running. Call get_state/wait_for_turn, keep playing until DUEL OVER.';
