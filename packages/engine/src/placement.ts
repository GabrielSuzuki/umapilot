/**
 * Turning what the rail showed into which card is on which facility.
 *
 * The reader can say "there are two Speed badges and a Friend badge on Wit this
 * turn". The engine needs card INDICES, because a card carries a bond, a level
 * and its own effects. This is the step between, and it is deliberately dull:
 * match a badge to an unused card of that type, and report anything that does
 * not match rather than forcing it.
 *
 * WHAT IT REFUSES TO DO is guess. A badge whose colour the reader could not
 * name matches nothing, even though something is plainly standing there --
 * putting an arbitrary card in that slot would hand the planner a rainbow it
 * cannot see, which is the same class of error as a misread stat and lasts
 * exactly as long.
 *
 * WHERE IT IS HONESTLY UNSURE is a deck with two cards of one type. Two Wit
 * cards and one Wit badge is a real ambiguity, and the two cards are usually
 * near-substitutes -- but not always, since they can differ in level and
 * effects. It picks the first unused one and says how often it had to.
 */
import { STATS, type Stat } from "../../data/src/types";

/** What a badge said the card was. `null` when the reader would not name it. */
export type ObservedKind = Stat | "friend" | null;

export interface PlacementInput {
  /** The deck, in the order the engine holds it. */
  cards: ReadonlyArray<{ stat: Stat | null; kind: string }>;
  /** What the rail showed, per facility the player has actually opened. */
  observed: Partial<Record<Stat, ReadonlyArray<ObservedKind>>>;
  /** Where the cards were before; kept for any card this reading cannot place. */
  previous: ReadonlyArray<Stat | null>;
}

export interface PlacementResult {
  placement: Array<Stat | null>;
  /** Badges with no unused card of that type to match. */
  unmatched: Array<{ facility: Stat; kind: ObservedKind }>;
  /** How many cards were chosen from more than one equally good candidate. */
  ambiguous: number;
  /** Facilities the player has opened this turn. */
  seen: Stat[];
}

function matches(card: { stat: Stat | null; kind: string }, badge: ObservedKind): boolean {
  if (badge === null) return false;
  // A group card wears the same smiling badge a friend card does -- neither has
  // a stat, and both are "the one that is not a training type".
  if (badge === "friend") return card.kind === "friend" || card.kind === "group";
  return card.stat === badge;
}

export function assignPlacement(input: PlacementInput): PlacementResult {
  const { cards, observed, previous } = input;
  const seen = STATS.filter((s) => observed[s] !== undefined);
  const used = new Array<boolean>(cards.length).fill(false);
  const placement: Array<Stat | null> = cards.map(() => null);
  const unmatched: PlacementResult["unmatched"] = [];
  let ambiguous = 0;

  for (const facility of seen) {
    for (const badge of observed[facility] ?? []) {
      const candidates: number[] = [];
      for (let i = 0; i < cards.length; i++) {
        if (!used[i] && matches(cards[i]!, badge)) candidates.push(i);
      }
      if (candidates.length === 0) { unmatched.push({ facility, kind: badge }); continue; }
      if (candidates.length > 1) ambiguous++;
      const pick = candidates[0]!;
      used[pick] = true;
      placement[pick] = facility;
    }
  }

  // A CARD NOBODY SAW IS NOT A CARD THAT IS OUT OF PLAY.
  //
  // Only once every facility has been opened does "not seen" mean "not on the
  // board". Until then the card may simply be standing somewhere the player has
  // not clicked yet, and overwriting its last known position with `null` would
  // quietly strip a rainbow off the board as a REWARD for looking at four
  // facilities instead of five.
  const allSeen = seen.length === STATS.length;
  if (!allSeen) {
    for (let i = 0; i < cards.length; i++) {
      if (used[i]) continue;
      const was = previous[i] ?? null;
      // Keep it unless it was on a facility we have now looked at and not found
      // it on -- that is real evidence it moved.
      placement[i] = was !== null && seen.includes(was) ? null : was;
    }
  }

  return { placement, unmatched, ambiguous, seen };
}
