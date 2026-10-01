import type { CardData, Deck } from "@ygosim/protocol";

const img = (code: number) => `https://images.ygoprodeck.com/images/cards/${code}.jpg`;
type Partial = Omit<CardData, "imageUrl">;
const list: Partial[] = [
  { code: 46986414, name: "Dark Magician", desc: "The ultimate wizard in terms of attack and defense.", type: ["Monster", "Normal"], attribute: "DARK", race: "Spellcaster", level: 7, atk: 2500, def: 2100 },
  { code: 89631139, name: "Blue-Eyes White Dragon", desc: "This legendary dragon is a powerful engine of destruction.", type: ["Monster", "Normal"], attribute: "LIGHT", race: "Dragon", level: 8, atk: 3000, def: 2500 },
  { code: 55144522, name: "Pot of Greed", desc: "Draw 2 cards.", type: ["Spell", "Normal"] },
  { code: 44095762, name: "Mirror Force", desc: "When an opponent's monster declares an attack: Destroy all your opponent's Attack Position monsters.", type: ["Trap", "Normal"] },
  { code: 5318639, name: "Mystical Space Typhoon", desc: "Target 1 Spell/Trap on the field; destroy that target.", type: ["Spell", "Quick-Play"] },
  { code: 24094653, name: "Polymerization", desc: "Fusion Summon 1 Fusion Monster from your Extra Deck, using monsters from your hand or field as Fusion Material.", type: ["Spell", "Normal"] },
  { code: 23995346, name: "Blue-Eyes Ultimate Dragon", desc: "\"Blue-Eyes White Dragon\" + \"Blue-Eyes White Dragon\" + \"Blue-Eyes White Dragon\"", type: ["Monster", "Fusion"], attribute: "LIGHT", race: "Dragon", level: 12, atk: 4500, def: 3800 },
  { code: 44508094, name: "Stardust Dragon", desc: "1 Tuner + 1+ non-Tuner monsters. When a card or effect is activated that would destroy a card(s) on the field (Quick Effect): You can Tribute this card; negate the activation, and if you do, destroy it.", type: ["Monster", "Synchro", "Effect"], attribute: "WIND", race: "Dragon", level: 8, atk: 2500, def: 2000 },
  { code: 63977008, name: "Junk Synchron", desc: "When this card is Normal Summoned: You can target 1 Level 2 or lower monster in your GY; Special Summon it in Defense Position, but negate its effects.", type: ["Monster", "Tuner", "Effect"], attribute: "DARK", race: "Warrior", level: 3, atk: 1300, def: 500 },
  { code: 84013237, name: "Number 39: Utopia", desc: "2 Level 4 monsters. When a monster declares an attack: You can detach 1 material from this card; negate the attack.", type: ["Monster", "Xyz", "Effect"], attribute: "LIGHT", race: "Warrior", level: 4, atk: 2500, def: 2000 },
  { code: 1861629, name: "Decode Talker", desc: "2+ Effect Monsters. Gains 500 ATK for each monster it points to.", type: ["Monster", "Link", "Effect"], attribute: "DARK", race: "Cyberse", atk: 2300, linkMarkers: ["Top", "Bottom-Left", "Bottom-Right"] },
  { code: 16178681, name: "Odd-Eyes Pendulum Dragon", desc: "Pendulum Effect: You can reduce the battle damage you take from an attack involving a Pendulum Monster you control to 0.", type: ["Monster", "Pendulum", "Effect"], attribute: "DARK", race: "Dragon", level: 7, atk: 2500, def: 2000, scale: 4 },
  { code: 5405694, name: "Black Luster Soldier", desc: "You can Ritual Summon this card with \"Black Luster Ritual\".", type: ["Monster", "Ritual"], attribute: "EARTH", race: "Warrior", level: 8, atk: 3000, def: 2500 },
  { code: 40640057, name: "Kuriboh", desc: "During damage calculation (Quick Effect): You can discard this card; you take no battle damage from that battle.", type: ["Monster", "Effect"], attribute: "DARK", race: "Fiend", level: 1, atk: 300, def: 200 },
  { code: 54652250, name: "Man-Eater Bug", desc: "FLIP: Target 1 monster on the field; destroy that target.", type: ["Monster", "Flip", "Effect"], attribute: "EARTH", race: "Insect", level: 2, atk: 450, def: 600 },
  { code: 83764718, name: "Monster Reborn", desc: "Target 1 monster in either GY; Special Summon it.", type: ["Spell", "Normal"] },
  { code: 70095154, name: "Cyber Dragon", desc: "If only your opponent controls a monster, you can Special Summon this card (from your hand).", type: ["Monster", "Effect"], attribute: "LIGHT", race: "Machine", level: 5, atk: 2100, def: 1600 },
  { code: 10000080, name: "Gogogo Golem", desc: "", type: ["Monster", "Normal"], level: 4, atk: 1800, def: 1500 },
];
export const MOCK_CARDS: Record<number, CardData> = Object.fromEntries(list.map((c) => [c.code, { ...c, imageUrl: img(c.code) }]));

export const MOCK_DECK: Deck = {
  main: [46986414, 46986414, 89631139, 89631139, 89631139, 55144522, 44095762, 5318639, 24094653, 63977008, 40640057, 54652250, 83764718, 70095154, 70095154, 16178681, 5405694, 46986414, 40640057, 54652250],
  extra: [23995346, 44508094, 84013237, 1861629],
  side: [],
};
