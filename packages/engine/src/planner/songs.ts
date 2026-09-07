/**
 * The song plan: which song to aim at next, what it is worth, and how far away
 * it is.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS ADVICE AND NOT A POLICY
 * ---------------------------------------------------------------------------
 *
 * The plan this file was built to make was a steering rule: pick the next song,
 * work out which currencies it needs, and let that decide what to train until
 * it is affordable. That rule was built, corrected twice, and measured three
 * times. It loses.
 *
 *   version 1  priced a token at `songValue / tokensStillNeeded`.  -156 stats
 *   version 2  priced it as turns of ownership gained (below).      -42
 *   version 3  same, against a training term that finally counted
 *              bonds, levels and energy (see `valuation.ts`).      -132
 *
 * The third number is the informative one, because by then the training side
 * was no longer being underpriced -- that same evaluator, with the song term
 * deleted, is worth +100 a career at n=300. So the steer is not losing to a
 * strawman. It is losing on its merits.
 *
 * The reason is in `lesson-board.ts` and it is structural: the nth song of a
 * phase unlocks on having bought a cumulative number of TECHNIQUES, and nothing
 * else. Tokens do not buy songs; techniques do, and tokens buy techniques of
 * any kind. Over sixteen careers spanning both policies, song count against
 * technique count fits at r^2 = 0.86, slope 0.29 -- one song per 3.4
 * techniques, with the policy that steered no better placed on that line than
 * the one that did not. Steering the currency MIX cannot move a gate that
 * counts purchases, so all it buys is worse trainings.
 *
 * `song-bottleneck.md` concluded that songs were the whole remaining gap and
 * that timing alone was worth +887. That still stands. What is now measured is
 * that the lever is TOTAL income, spent on whatever the board shows, and not
 * the mix -- which is why the steering rule is not here and `valuePolicy` is.
 *
 * What remains is worth having on its own, and is what a tracker should show:
 * the board's songs, priced, with what each is still short of and how long that
 * will take at the run's current income. That is advice a player acts on. It is
 * not a policy, and this file no longer pretends it is one.
 *
 * ---------------------------------------------------------------------------
 * WHY THE BOARD, NOT THE CATALOGUE
 * ---------------------------------------------------------------------------
 *
 * Only the three lessons on the board can be bought, the board is homogeneous
 * (all songs or all techniques), and NOTHING redraws it but a purchase. So
 * "aim at a song" can only ever mean a song currently on the board, and a plan
 * built from the catalogue would name squares the player cannot see. When the
 * board is showing techniques there is no song to aim at and this says so,
 * which is correct rather than a gap: the way to get a song board is to buy the
 * techniques in front of you -- and, per the gate above, that is also the way
 * to get the song.
 */

import {
  STATS, TOKENS, ZERO_TOKENS,
  type Stat, type TokenVector,
} from "../../../data/src/types";
import { decodeEffectText } from "../../../data/src/effects";
import type { GrandConcertScenario, GcRunState } from "../scenarios/grand-concert";
import type { CompiledTarget } from "./objective";
import { gainValue, trainingProfile } from "./valuation";

// ---------------------------------------------------------------------------
// Scoring helpers
// ---------------------------------------------------------------------------

export interface SongValuation {
  id: number;
  name: string | null;
  effect: string | null;
  cost: TokenVector;
  /** Granted once, at purchase. Timing-independent. */
  oneOffValue: number;
  /**
   * The per-training half, already multiplied by the trainings this run still
   * expects to take. This is the term that decays every turn it is deferred.
   */
  compoundingValue: number;
  value: number;
  /** Per currency, what is still missing. Zero everywhere means affordable. */
  deficit: TokenVector;
  deficitTotal: number;
  /** Turns of the run's current income needed to close the deficit. */
  turnsToAfford: number;
  /** Value per token still needed -- the exchange rate the policy trades at. */
  rate: number;
}

/**
 * What owning this song is worth, from this state, right now.
 *
 * The compounding half is MEASURED, not derived: `previewTraining` is called
 * twice per facility, once with the song owned and once without, and the
 * difference is the real gain after mood, growth, friendship, card count and
 * the rainbow multiplier have all been applied to it. Reading "+1" off the
 * effect text and calling it one stat point understates a rainbow speed
 * training by roughly an order of magnitude, and that understatement is
 * precisely why songs have never been bought early enough.
 *
 * It is a linearisation in one respect, flagged here rather than hidden: the
 * per-training delta is priced at TODAY's stats and multiplied by the trainings
 * still to come, while `shortfallScore` caps each stat's contribution at its
 * target. So a song boosting a stat that will cross its target part-way through
 * is valued slightly high. Correcting that needs a rollout, which is three
 * orders of magnitude more expensive than this and is what the beam is for.
 */
export function valueSong(
  scenario: GrandConcertScenario,
  state: GcRunState,
  songId: number,
  target: CompiledTarget,
): SongValuation | null {
  const song = scenario.songs.find((x) => x.id === songId);
  if (!song) return null;
  const s = state.scenario;

  const owned = s.songsOwned;
  const withSong = owned.includes(songId) ? owned : [...owned, songId];

  // --- the compounding half -------------------------------------------------
  const { remainingTrainings, share } = trainingProfile(scenario, state);
  let compoundingValue = 0;
  for (const facility of STATS) {
    const before = scenario.previewTraining(state, facility, { songsOwned: owned });
    const after = scenario.previewTraining(state, facility, { songsOwned: withSong });
    const delta: Partial<Record<Stat, number>> = {};
    let any = false;
    for (const stat of STATS) {
      const d = after.gains[stat] - before.gains[stat];
      if (d !== 0) { delta[stat] = d; any = true; }
    }
    const spDelta = after.skillPoints - before.skillPoints;
    if (!any && spDelta === 0) continue;
    compoundingValue +=
      gainValue(state, target, delta, spDelta) * remainingTrainings * share[facility];
  }

  // --- the one-off half -----------------------------------------------------
  const mastery = decodeEffectText(song.mastery_bonus.text);
  const oneOffValue = gainValue(
    state, target, mastery.oneOffStat, mastery.oneOffSkillPoints,
  );

  // --- what it still costs --------------------------------------------------
  const deficit: TokenVector = { ...ZERO_TOKENS };
  let deficitTotal = 0;
  for (const t of TOKENS) {
    const short = Math.max(0, song.cost[t] - s.tokens[t]);
    deficit[t] = short;
    deficitTotal += short;
  }

  // Currencies accrue in parallel, so the wait is set by the slowest one, not
  // by the sum. A song short 30 dance and 30 visual on a Speed deck is much
  // closer than one short 60 mental.
  const income = expectedIncome(scenario, state);
  let turnsToAfford = 0;
  for (const t of TOKENS) {
    if (deficit[t] === 0) continue;
    turnsToAfford = Math.max(
      turnsToAfford,
      income[t] > 0 ? deficit[t] / income[t] : Infinity,
    );
  }

  const value = compoundingValue + oneOffValue;
  return {
    id: song.id,
    name: song.name,
    effect: song.mastery_bonus.text,
    cost: song.cost,
    oneOffValue,
    compoundingValue,
    value,
    deficit,
    deficitTotal,
    turnsToAfford,
    rate: deficitTotal === 0 ? Infinity : value / deficitTotal,
  };
}

/**
 * Performance points per turn, per currency, at the run's current habits.
 *
 * The scenario owns the payout formula and the roll weights; this weights them
 * by where this run actually trains and how often. Nothing here restates the
 * arithmetic in `grantTokens` -- see `tokenYield`.
 */
export function expectedIncome(
  scenario: GrandConcertScenario,
  state: GcRunState,
): TokenVector {
  const { remainingTrainings, share } = trainingProfile(scenario, state);
  const remainingTurns = Math.max(1, scenario.careerTurns - state.turn + 1);
  const trainingsPerTurn = remainingTrainings / remainingTurns;

  const out = {} as TokenVector;
  for (const t of TOKENS) out[t] = 0;
  for (const facility of STATS) {
    const y = scenario.tokenYield(state, facility);
    for (const t of TOKENS) {
      out[t] += y.expected[t] * share[facility] * trainingsPerTurn;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The plan
// ---------------------------------------------------------------------------

export interface SongPlan {
  /** The song to aim at, or null when the board is showing techniques. */
  aim: SongValuation | null;
  /** Every song on the board, valued, best first. Null when there are none. */
  board: SongValuation[];
}

/**
 * Choose the next song to aim at.
 *
 * Ranked by value per turn of waiting, not by value: a song worth twice as much
 * but four times as far away is the worse thing to steer toward, and steering
 * toward it is what produced the frozen boards. An already-affordable song has
 * no wait at all and wins outright, which is the same preference `greedyShop`
 * has and keeps the two consistent.
 */
export function songPlan(
  scenario: GrandConcertScenario,
  state: GcRunState,
  target: CompiledTarget,
): SongPlan {
  const s = state.scenario;
  const board: SongValuation[] = [];
  for (const id of s.offers) {
    if (s.songsOwned.includes(id)) continue;
    const v = valueSong(scenario, state, id, target);
    if (v) board.push(v);
  }
  if (board.length === 0) return { aim: null, board };

  board.sort((a, b) => rank(b) - rank(a));
  const aim = board[0]!;
  // A song whose remaining value is zero is not worth steering toward -- it
  // happens once every stat it touches is already at target.
  return { aim: aim.value > 0 ? aim : null, board };
}

function rank(v: SongValuation): number {
  if (v.deficitTotal === 0) return Infinity;
  if (!Number.isFinite(v.turnsToAfford)) return -Infinity;
  return v.value / Math.max(1, v.turnsToAfford);
}

// ---------------------------------------------------------------------------
// The policy
// ---------------------------------------------------------------------------

/**
 * What owning this song is worth if it arrives in `wait` turns.
 *
 * ---------------------------------------------------------------------------
 * THE CORRECTION THAT MADE THIS WORK
 * ---------------------------------------------------------------------------
 *
 * The first version of this priced a token as `songValue / tokensStillNeeded`
 * and lost 156 stat points a career against doing nothing. The error was not
 * the size of the number, it was its meaning: it valued a token as if not
 * steering meant never owning the song. It does not. `greedyShop` buys the song
 * the turn it becomes affordable whatever the policy does, so steering does not
 * BUY the song -- it buys the song EARLIER, and what a turn of steering is
 * worth is the extra turns of ownership it wins.
 *
 * That distinction is the whole file. It says, correctly and without a tuning
 * constant, that:
 *
 *   - a compounding song ("Training Speed Gain +2") is worth steering for,
 *     because every turn earlier is another turn of every training being
 *     bigger;
 *   - a one-off song ("Speed +22") is worth NOTHING to steer for, because it
 *     grants the same 22 points on turn 65 as on turn 25 -- right up until the
 *     career would end before it is affordable, at which point it is worth all
 *     of it;
 *   - paying a currency the run is already flush with advances nothing, because
 *     the wait is set by the currency furthest behind.
 */
export function valueAtArrival(v: SongValuation, wait: number, remainingTurns: number): number {
  if (!Number.isFinite(wait) || wait > remainingTurns) return 0;
  const live = Math.max(0, remainingTurns - wait) / Math.max(1, remainingTurns);
  return v.compoundingValue * live + v.oneOffValue;
}

/**
 * When this song becomes affordable if this turn's income comes from `facility`
 * and every turn after it follows the run's usual mix.
 *
 * A critical path, not a total: currencies accrue in parallel, so the wait is
 * whichever one is furthest behind. That is what makes "train guts for the
 * visual" a real recommendation and "train power for the vocal you already
 * have 200 of" not one.
 */
export function waitAfterTraining(
  scenario: GrandConcertScenario,
  state: GcRunState,
  facility: Stat,
  deficit: TokenVector,
  income: TokenVector,
): number {
  const yields = scenario.tokenYield(state, facility).expected;
  let wait = 0;
  for (const t of TOKENS) {
    const left = Math.max(0, deficit[t] - yields[t]);
    if (left === 0) continue;
    if (income[t] <= 0) return Infinity;
    wait = Math.max(wait, left / income[t]);
  }
  return 1 + wait;
}

/**
 * Which facility brings the aimed-at song closest, and by how much.
 *
 * The steering RULE is gone (see the header); the question it answered is
 * still a real one a player asks at the lesson screen, and answering it as
 * advice costs nothing and misleads nobody. The difference is who decides: a
 * player who can see that Guts is the only facility paying the visual they are
 * frozen on can weigh that against the speed training they wanted, with the
 * numbers in front of them, and they will be right more often than a rule that
 * always takes the trade.
 */
export function fastestTowardSong(
  scenario: GrandConcertScenario,
  state: GcRunState,
  aim: SongValuation,
): Array<{ facility: Stat; wait: number; turnsSaved: number }> {
  const income = expectedIncome(scenario, state);
  const out = STATS.map((facility) => ({
    facility,
    wait: waitAfterTraining(scenario, state, facility, aim.deficit, income),
  }));
  const slowest = out.reduce((a, b) => Math.max(a, Number.isFinite(b.wait) ? b.wait : a), 0);
  return out
    .map((o) => ({ ...o, turnsSaved: Number.isFinite(o.wait) ? slowest - o.wait : 0 }))
    .sort((a, b) => a.wait - b.wait);
}

/** Explaining a plan: the board, valued, in the order the planner ranks it. */
export function explainSongPlan(plan: SongPlan): string[] {
  if (plan.board.length === 0) return ["board is showing techniques -- no song to aim at"];
  return plan.board.map((v) => {
    const short = TOKENS.filter((t) => v.deficit[t] > 0)
      .map((t) => `${t} ${v.deficit[t]}`)
      .join(", ");
    const wait = v.deficitTotal === 0
      ? "affordable now"
      : Number.isFinite(v.turnsToAfford)
        ? `~${v.turnsToAfford.toFixed(1)} turns (short ${short})`
        : `unreachable at current income (short ${short})`;
    const kind = v.compoundingValue > 0 && v.oneOffValue > 0 ? "compounding + one-off"
      : v.compoundingValue > 0 ? "compounding -- worth more the earlier it is bought"
      : "one-off -- worth the same whenever it is bought";
    return `${v.name ?? v.id}: value ${v.value.toFixed(4)} (${kind}), ${wait}`;
  });
}
