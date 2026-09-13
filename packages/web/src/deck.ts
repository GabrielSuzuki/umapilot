/**
 * Turning a chosen support card into the state the engine wants.
 *
 * The extractor emits each card's effects as a table keyed by card level --
 * `{"0": 5, "5": 5, ..., "50": 15}` -- because that is how `master.mdb` stores
 * them. The engine wants the values that apply at ONE level. This resolves the
 * table; it does not interpolate, because the game does not: an effect holds
 * its value until the next tabled level.
 */
import type { CardState } from "../../engine/src/scenarios/grand-concert";
import type { Stat } from "../../data/src/types";
import type { SupportCardRecord } from "./dataset";

/** The value an effect has at `level`: the highest tabled level at or below it. */
export function effectAt(table: Record<string, number>, level: number): number {
  let best = 0, bestKey = -1;
  for (const [k, v] of Object.entries(table)) {
    const at = Number(k);
    if (Number.isFinite(at) && at <= level && at > bestKey) { bestKey = at; best = v; }
  }
  return best;
}

export function resolveCard(card: SupportCardRecord, level: number): CardState {
  const effects: Record<string, number> = {};
  for (const [name, table] of Object.entries(card.effects ?? {})) {
    const v = effectAt(table, level);
    if (v !== 0) effects[name] = v;
  }
  return {
    cardId: card.id,
    stat: (card.stat as Stat | null) ?? null,
    // Bond starts at zero and the engine grants `initial_friendship` itself --
    // see CardState. Writing the initial bond here as well would grant it twice.
    bond: 0,
    kind: card.kind,
    effects: effects as CardState["effects"],
  };
}

/** Card levels the game actually offers, for a picker that cannot be wrong. */
export const CARD_LEVELS = [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50] as const;

/** Sort for a picker: by rarity then name, so SSRs are not buried. */
export function sortCards(cards: readonly SupportCardRecord[]): SupportCardRecord[] {
  const rank = (r: string) => (r === "SSR" ? 0 : r === "SR" ? 1 : 2);
  return [...cards].sort((a, b) => rank(a.rarity) - rank(b.rarity) || a.name.localeCompare(b.name));
}
