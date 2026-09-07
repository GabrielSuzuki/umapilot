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
import {
  BOND_GAIN_OWN,
  type GrandConcertScenario, type GcRunState, type CardState,
} from "../scenarios/grand-concert";
import { RAINBOW_BOND, cardKind } from "../scenarios/grand-concert/training";
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
   * The per-training half of the MASTERY bonus, already multiplied by the
   * trainings this run still expects to take. Decays every turn it is deferred.
   */
  compoundingValue: number;
  /**
   * The CONCERT bonus, over the trainings that come after both the next concert
   * and the point at which this run has friendship to multiply. Priced
   * separately from `compoundingValue` because it starts later and is gated on
   * something else -- see `concertValue`.
   */
  concertValue: number;
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

  // --- the concert half -----------------------------------------------------
  const concert = concertValue(scenario, state, songId, target);

  const value = compoundingValue + concert + oneOffValue;
  return {
    id: song.id,
    name: song.name,
    effect: song.mastery_bonus.text,
    cost: song.cost,
    oneOffValue,
    compoundingValue,
    concertValue: concert,
    value,
    deficit,
    deficitTotal,
    turnsToAfford,
    rate: deficitTotal === 0 ? Infinity : value / deficitTotal,
  };
}

/**
 * What this song's CONCERT BONUS is worth, over the part of the career where it
 * both exists and has something to multiply.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT PART OF THE DIFFERENCE ABOVE
 * ---------------------------------------------------------------------------
 *
 * The compounding half is measured by calling `previewTraining` twice with
 * different `songsOwned`. That difference CANNOT see a Concert Bonus, and for
 * two days nobody noticed: `previewTraining` reads concert bonuses from
 * `concertBonusesActive`, buying a song does not put it there until the next
 * concert, and so both sides of the difference carried identical concert terms
 * and the bonus cancelled to exactly zero.
 *
 * That was not a rounding error. Cross-tabbing `master.mdb`, the twenty-one
 * buyable songs partition perfectly: the nine with a one-off Mastery Bonus
 * ("Speed +22") are EXACTLY the nine carrying Friendship Training
 * Effectiveness, and the twelve with a compounding Mastery Bonus carry
 * Specialty Priority or Support Chain Event Frequency instead. Zero mixing. So
 * the nine songs whose only compounding effect is the Concert Bonus had their
 * whole compounding half priced at 0, and `explainSongPlan` printed "worth the
 * same whenever it is bought" for the +10% friendship song -- backwards.
 *
 * ---------------------------------------------------------------------------
 * THE TWO GATES
 * ---------------------------------------------------------------------------
 *
 * A Concert Bonus bought now pays nothing until BOTH of these have happened,
 * and it is worth what is left of the career after the later one:
 *
 *   THE CONCERT.  `maybeHoldConcert` sets `concertBonusesActive = songsOwned`,
 *                 so the bonus switches on at the next concert and not before.
 *                 A step function the scenario already models exactly.
 *
 *   THE FRIENDSHIP.  `computeTraining` applies the bonus only while some card
 *                 is actually contributing friendship, which is correct -- a
 *                 bonus to friendship training with no friendship training
 *                 under it is worth nothing. Measured over 40 careers on the
 *                 real deck, friendship > 1 on 15.1% of trainings taken: 0%
 *                 before turn 25, 61% in the last twelve turns. So pricing this
 *                 against TODAY's placement, as the compounding half does,
 *                 would read zero for the whole first third of the career --
 *                 which is exactly when buying the song is worth most.
 *
 * Both gates are read off the run rather than assumed. The concert turn comes
 * from the dataset. The friendship turn comes from each card's OWN BOND, whose
 * growth so far is the run's own history of where it has been training and what
 * has been placed there -- so no placement model and no new constant is
 * involved. `BOND_GAIN_OWN` supplies the prior for a run too young to have a
 * history, in the same shape and for the same reason `trainingProfile` does.
 *
 * The uplift itself is MEASURED, not derived, by the same trick the bond term
 * in `valuation.ts` uses: project the cards that could contribute friendship on
 * this facility to `RAINBOW_BOND`, then run `previewTraining` twice on that
 * projection -- once with this song's Concert Bonus active and once without --
 * and difference. That way whatever `contributesFriendship` decides, including
 * the unverified group-card reading, is what gets priced.
 *
 * KNOWN AND FLAGGED, in the same spirit as the linearisation on `valueSong`:
 * the arrival turn is projected from the bond a card has NOW at the rate it has
 * grown so far, so a run that changes where it trains will have this wrong in
 * the direction of that change. Correcting it needs a rollout, which is what
 * the beam is for.
 */
export function concertValue(
  scenario: GrandConcertScenario,
  state: GcRunState,
  songId: number,
  target: CompiledTarget,
): number {
  const s = state.scenario;
  const active = s.concertBonusesActive;
  // Already running: there is nothing left to buy.
  if (active.includes(songId)) return 0;

  const song = scenario.songs.find((x) => x.id === songId);
  if (!song?.concert_bonus) return 0;

  // Gate 1. No concert left means the bonus never switches on at all.
  const nextConcert = scenario.nextConcertTurn(state.turn);
  if (nextConcert === null) return 0;

  const withSong = [...active, songId];
  const { remainingTrainings, share } = trainingProfile(scenario, state);
  const remainingTurns = Math.max(1, scenario.careerTurns - state.turn + 1);
  const elapsed = Math.max(0, state.turn - 1);

  let total = 0;
  for (const facility of STATS) {
    const futureF = remainingTrainings * share[facility];
    if (futureF <= 0) continue;
    const perTurn = futureF / remainingTurns;
    if (perTurn <= 0) continue;

    // Gate 2. When does this facility first have friendship to multiply?
    const arrival = friendshipArrival(state, facility, elapsed, perTurn);
    if (arrival === null) continue;

    const from = Math.max(nextConcert, arrival.turn);
    const trainings = Math.max(0, scenario.careerTurns - from + 1) * perTurn;
    if (trainings <= 0) continue;

    // The uplift, measured where the friendship term actually exists.
    const glow = rainbowProjection(state, facility, arrival.cardIndex);
    const before = scenario.previewTraining(glow, facility, { concertBonusesActive: active });
    const after = scenario.previewTraining(glow, facility, { concertBonusesActive: withSong });

    const delta: Partial<Record<Stat, number>> = {};
    let any = false;
    for (const stat of STATS) {
      const d = after.gains[stat] - before.gains[stat];
      if (d !== 0) { delta[stat] = d; any = true; }
    }
    const spDelta = after.skillPoints - before.skillPoints;
    if (!any && spDelta === 0) continue;

    total += gainValue(state, target, delta, spDelta) * trainings;
  }
  return total;
}

/**
 * Can this card ever contribute friendship on this facility?
 *
 * Mirrors `contributesFriendship`'s structure with the bond test removed, since
 * the question here is what the card will do once its bond is full rather than
 * what it does now.
 */
function couldContributeFriendship(card: CardState, facility: Stat): boolean {
  const kind = cardKind(card);
  if (kind === "stat") return card.stat === facility;
  return kind === "group";
}

/**
 * The FIRST card to start contributing friendship on this facility, and when.
 * Null if none of its cards can ever get there.
 *
 * The rate comes from the card's own bond: a card at bond 42 on turn 30 has
 * been gaining about 1.4 a turn, whatever mixture of placements and facilities
 * produced that, and projecting the same rate forward asks nothing further of
 * the model -- no placement model, no new constant. A run with no history yet
 * gets the prior instead: `BOND_GAIN_OWN` at this facility's own training rate,
 * which is what a card gains if it is there when the facility is trained. That
 * is the same shape of prior, for the same reason, as `trainingProfile`'s.
 *
 * Only the FIRST card is returned, and only it is projected below. Projecting
 * every card that could eventually rainbow would price the uplift against a
 * friendship term stacking all of them at once, which happens late in a career
 * if at all -- and the count this multiplies starts at the first arrival, so
 * the conservative card is the consistent one.
 */
function friendshipArrival(
  state: GcRunState,
  facility: Stat,
  elapsed: number,
  perTurn: number,
): { turn: number; cardIndex: number } | null {
  const s = state.scenario;
  let best: { turn: number; cardIndex: number } | null = null;
  s.cards.forEach((card, cardIndex) => {
    if (!couldContributeFriendship(card, facility)) return;
    if (card.bond >= RAINBOW_BOND) {
      if (best === null || state.turn < best.turn) best = { turn: state.turn, cardIndex };
      return;
    }
    const observed = elapsed > 0 && card.bond > 0 ? card.bond / elapsed : 0;
    const rate = observed > 0 ? observed : BOND_GAIN_OWN * perTurn;
    if (rate <= 0) return;
    const turn = state.turn + (RAINBOW_BOND - card.bond) / rate;
    if (best === null || turn < best.turn) best = { turn, cardIndex };
  });
  return best;
}

/**
 * The state as it will be on a turn when this card is at full bond AND standing
 * on this facility. Bonds and placement both move, because `previewTraining`
 * reads today's placement and a card that is not there contributes nothing --
 * projecting the bond alone would leave the friendship term at 1 and price the
 * whole Concert Bonus at zero all over again, for a second reason.
 *
 * Placing the card also changes the card-count multiplier, but that term is
 * identical on both sides of the difference this feeds and cancels exactly.
 * Only the concert friendship multiplier differs between them.
 */
function rainbowProjection(
  state: GcRunState, facility: Stat, cardIndex: number,
): GcRunState {
  const s = state.scenario;
  const card = s.cards[cardIndex];
  if (!card) return state;

  const cards = s.cards.slice();
  cards[cardIndex] = { ...card, bond: Math.max(card.bond, RAINBOW_BOND) };

  const placement = { ...s.placement };
  for (const f of STATS) placement[f] = [...s.placement[f]];
  if (!placement[facility].includes(cardIndex)) placement[facility].push(cardIndex);

  return { ...state, scenario: { ...s, cards, placement } };
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
  return (v.compoundingValue + v.concertValue) * live + v.oneOffValue;
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
    // Every song in this scenario compounds. The nine with a one-off Mastery
    // Bonus are exactly the nine carrying Friendship Training Effectiveness, so
    // "one-off -- worth the same whenever it is bought" was never true of any
    // song; it was true of the half this used to be able to see.
    const compounds = v.compoundingValue + v.concertValue;
    const parts: string[] = [];
    if (v.compoundingValue > 0) parts.push("per-training");
    if (v.concertValue > 0) parts.push("concert bonus");
    if (v.oneOffValue > 0) parts.push("one-off");
    const kind = compounds > 0
      ? `${parts.join(" + ")} -- worth more the earlier it is bought`
      : parts.length > 0
        ? `${parts.join(" + ")} -- nothing left that compounds`
        : "nothing left to gain";
    return `${v.name ?? v.id}: value ${v.value.toFixed(4)} (${kind}), ${wait}`;
  });
}
