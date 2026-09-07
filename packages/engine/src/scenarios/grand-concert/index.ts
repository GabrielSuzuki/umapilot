/**
 * The Grand Concert scenario.
 *
 * The only implementation of `Scenario` so far. Everything scenario-specific
 * lives under this directory; nothing outside it may name Grand Concert.
 *
 * `step` and `buy` are pure functions of (state, action, rng). No module state,
 * no Math.random, no clock. That is what makes a full career reproducible from
 * a seed, which is what makes golden-file regression possible.
 */

import {
  STATS, TOKENS, ZERO_STATS, ZERO_TOKENS,
  canAfford, subtractTokens,
  type Stat, type StatVector, type Token, type TokenVector,
  type GrandConcertDataset,
} from "../../../../data/src/types";
import { weightedPick, chance, mulberry32, type Rng } from "../../rng";
import {
  decodeEffectText, accumulatePerTrainingBonuses, accumulateConcertBonuses,
} from "../../../../data/src/effects";
import {
  computeTraining, resolveBaseTraining, isRainbow,
  MOOD_VALUES, type Mood, type PlacedCard, type FacilityTable,
} from "./training";
import type { RunState, TurnAction, ShopAction, Scenario } from "../../scenario";
import {
  LESSON_OFFERS, drawBoard,
  TIER_GATE_SOURCE, SONG_GATE_SOURCE, OFFER_DRAW_SOURCE,
} from "./lesson-board";

/** The Grand Concert scenario id in master.mdb. */
const GRAND_CONCERT_SCENARIO_ID = 3;

/** An outing chain as the extractor emits it. */
interface RawOutingChain {
  kind?: "friend" | "group";
  charaId?: number;
  cardId?: number;
  name?: string;
  totalSteps: number;
  totalOutings?: number;
  memberOutings?: unknown[];
}

/** An outing chain normalised for scheduling. */
interface OutingChain {
  /** Friend: chara id. Group: card id. */
  companionId: number;
  kind: "friend" | "group";
  name?: string | undefined;
  /** Turns this companion will cost over the whole career. */
  totalOutings: number;
  /** Group cards only: how many bundled characters have their own outing. */
  memberCount: number;
}

// ---------------------------------------------------------------------------
// Scenario-specific state
// ---------------------------------------------------------------------------

export interface CardState {
  cardId: number;
  stat: Stat | null;
  /**
   * 0-100. Rainbow needs >= 80.
   *
   * Cards do NOT start at zero: `initial_friendship` (20-35 on the cards
   * checked) is granted at career start. Missing that was worth a third of the
   * distance to rainbow on every card, and rainbow is the largest multiplier in
   * the game -- so the omission compounded over an entire career.
   */
  bond: number;
  /**
   * "stat" | "friend" | "group". A friend card and a group card both have
   * `stat: null`, so this cannot be inferred -- and a group card that omits it
   * loses its friendship bonus silently. See contributesFriendship().
   */
  kind?: PlacedCard["kind"];
  effects: PlacedCard["effects"] & { initial_friendship?: number };
  bondThresholdEffects?: PlacedCard["bondThresholdEffects"];
}

export interface GrandConcertState {
  tokens: TokenVector;
  tokenCaps: TokenVector;
  songsOwned: number[];
  /**
   * Songs whose CONCERT BONUS is live.
   *
   * Separate from `songsOwned` because the two switch on at different moments,
   * and that difference is the whole reason song ordering matters. A Mastery
   * Bonus applies the instant the song is learned. A Concert Bonus applies from
   * the NEXT CONCERT to the end of the career -- so a song bought in Classic
   * June multiplies every remaining training, and the same song bought in
   * Senior November multiplies almost none.
   *
   * Collapsing the two would erase the time-value effect this project
   * identified as the single biggest gap in every rival planner.
   */
  concertBonusesActive: number[];
  /**
   * The three lessons currently on the board, as square ids.
   *
   * The game shows THREE, and buying one draws three more. It used to be
   * modelled as a catalogue -- every affordable technique, up to 248 -- which
   * let the planner name the globally cheapest one and call it advice, when
   * that square was almost certainly not on the player's screen.
   *
   * Re-rolled on every purchase, exactly as `placement` is re-rolled every
   * turn. That makes `buy` stochastic, which the beam search already handles.
   */
  offers: number[];
  /** Songs bought since the last concert. Indexes into the unlock sequence. */
  songsThisPhase: number;
  /** Techniques bought since the last concert. Gates the next song unlock. */
  techniquesThisPhase: number;
  techniquesTotal: number;
  concertsHeld: number;
  facilityLevels: Record<Stat, number>;
  /** How many times each facility has been trained. Drives level-ups. */
  facilityUses: Record<Stat, number>;
  cards: CardState[];
  /** Which cards are on which facility this turn. Re-rolled at the start of each turn. */
  placement: Record<Stat, number[]>;
  growthRate: Partial<Record<Stat, number>>;
  /**
   * Recreation outing progress, keyed by companion id -- a friend card's CHARA
   * id, or a group card's CARD id (group outings are keyed by card in
   * master.mdb, because the card bundles several characters).
   *
   * Deadline-constrained: the remaining outings have to fit in the turns left,
   * and each one displaces a training. The planner has to reserve those turns
   * rather than discover at turn 68 that it needs four more outings.
   *
   * Group cards make this materially harder. Team Sirius owes SEVEN outings
   * (six members plus its own one-step chain) against Light Hello's five, so a
   * deck with a group card in it has a much larger standing turn commitment.
   */
  friendEventProgress: Record<number, number>;
  /** Everything the projection rests on that has not been verified. */
  assumptions: string[];
}

export type GcRunState = RunState<GrandConcertState>;

/**
 * The bounds every clamp in `step` enforces.
 *
 * Named because the planner has to reason about them: an action whose only
 * effect is to raise a resource that is already at its ceiling does nothing at
 * all, and a search that cannot see that will branch on it.
 */
export const ENERGY_MIN = 0;
export const ENERGY_MAX = 100;
export const MOOD_MIN = -2;
export const MOOD_MAX = 2;

const MOOD_ORDER: Mood[] = ["awful", "bad", "normal", "good", "great"];
const moodFromIndex = (i: number): Mood => MOOD_ORDER[Math.min(Math.max(i + 2, 0), 4)]!;

/** Token cap starts at 200 and rises 50 per concert held. */
export const TOKEN_CAP_BASE = 200;
export const TOKEN_CAP_PER_CONCERT = 50;

/** Fixed so `initialState()` with no argument is still reproducible. */
const INITIAL_PLACEMENT_SEED = 0x5eed;

const EMPTY_SONG_BONUSES: { stats: Partial<Record<Stat, number>>; skillPoints: number } =
  { stats: {}, skillPoints: 0 };

const EMPTY_CONCERT_BONUSES = {
  friendshipTrainingEffectiveness: 0,
  supportChainEventFrequency: 0,
  specialityPriority: 0,
  unparsed: [] as string[],
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export interface GrandConcertSetup {
  startingStats?: Partial<StatVector>;
  statCaps?: Partial<StatVector>;
  cards: CardState[];
  growthRate?: Partial<Record<Stat, number>>;
  facilityLevels?: Partial<Record<Stat, number>>;
  /**
   * Simulate a deck containing a card this scenario bans.
   *
   * Off by default, and it should stay off outside experiments: a plan built on
   * a deck the game will not let you field is worse than no plan, because it
   * looks actionable. See `restrictedCards()`.
   */
  allowRestrictedCards?: boolean;
}

export class GrandConcertScenario
  implements Scenario<GrandConcertState, GrandConcertDataset>
{
  readonly id = "grand-concert";
  readonly displayName = "Brighter Together! Our Grand Concert";

  private readonly facilityTable: FacilityTable;
  private readonly failureRateBase: Record<string, Record<string, number>>;
  private readonly outingChains: OutingChain[];
  private readonly otherCommands: Record<string, {
    name?: string; kind?: string; variants?: Array<{ energy?: number; mood?: number }>;
  }>;
  private readonly caps: StatVector;
  /**
   * `L` in the performance-point grant: how many cards in THIS deck are linked
   * to this scenario. Fixed for the run, so computed once.
   */
  private readonly linkedCardCount: number;
  private readonly songBonusCache = new Map<
    string,
    { stats: Partial<Record<Stat, number>>; skillPoints: number }
  >();
  private readonly concertBonusCache = new Map<
    string,
    ReturnType<typeof accumulateConcertBonuses>
  >();

  constructor(
    readonly dataset: GrandConcertDataset,
    private readonly setup: GrandConcertSetup,
  ) {
    const training = (dataset as unknown as {
      training?: {
        facilities: FacilityTable;
        failureRateBase?: Record<string, Record<string, number>>;
        otherCommands?: Record<string, {
          name?: string; kind?: string; variants?: Array<{ energy?: number; mood?: number }>;
        }>;
      };
    }).training;
    if (!training?.facilities) {
      throw new Error(
        "dataset has no training section -- regenerate it with a current extractor",
      );
    }
    this.facilityTable = training.facilities;
    this.failureRateBase = training.failureRateBase ?? {};
    this.otherCommands = training.otherCommands ?? {};
    // Prefer `outingChains`, which covers group cards as well as friends.
    // `friendEvents` is the older key and holds only the friend subset, so an
    // older dataset still loads -- with group outings missing rather than wrong.
    const ds = dataset as unknown as {
      outingChains?: RawOutingChain[];
      friendEvents?: RawOutingChain[];
    };
    const raw = ds.outingChains ?? ds.friendEvents ?? [];
    this.outingChains = raw.map((o) => ({
      // A friend chain is keyed by chara id; a group card's outings are keyed by
      // card id, because the card bundles several characters.
      companionId: o.kind === "group" ? o.cardId! : o.charaId!,
      kind: o.kind ?? "friend",
      name: o.name,
      // What actually has to be scheduled: for a group card that is every
      // member's outing PLUS the card's own chain, not just the chain.
      totalOutings: o.totalOutings ?? o.totalSteps,
      memberCount: o.memberOutings?.length ?? 0,
    }));
    this.caps = { ...dataset.constants.statCaps, ...setup.statCaps };

    // Datasets extracted before 2026-09-07 carry no link list, so L is 0 there
    // -- exactly the old behaviour rather than a silently wrong answer.
    const linked = new Set(dataset.scenarioLinkedCards?.cardIds ?? []);
    this.linkedCardCount = setup.cards.filter((c) => linked.has(c.cardId)).length;

    // Refuse a deck the game will not let the player field. Modelling it would
    // produce a confident recommendation for a run that cannot happen.
    if (!setup.allowRestrictedCards) {
      const banned = GrandConcertScenario.findRestricted(dataset, setup.cards);
      if (banned.length > 0) {
        const names = banned.map((b) => `${b.cardName ?? b.cardId} (${b.cardId})`).join(", ");
        throw new Error(
          `Grand Concert does not allow ${names}. ` +
          `single_mode_restrict_support bans it from this scenario, confirmed in game. ` +
          `Remove it from the deck, or pass allowRestrictedCards to simulate anyway.`,
        );
      }
    }
  }

  get statCaps(): StatVector {
    return { ...this.caps };
  }

  /** Failure chance for a facility in the given state. Used by policies. */
  failureChanceFor(state: GcRunState, facility: Stat): number {
    return this.failureChance(state.scenario, facility, state.energy);
  }

  /**
   * Fresh state at turn 1.
   *
   * Rolls the opening card placement, which it did NOT used to do. The first
   * version left `placement` empty and only filled it at the END of `step`, so
   * the first turn of every simulated career trained with zero support cards on
   * every facility -- no friendship bonus, no card-count multiplier, no bond
   * growth. One turn in seventy-two is a small error in a projection, but it is
   * a large one in a RECOMMENDATION: turn 1 is the first advice a player ever
   * sees, and it was computed against a board that does not exist in the game.
   *
   * `rng` is optional so the common case stays a constant expression. The
   * default seed is fixed rather than arbitrary, because a career has to be
   * reproducible from `initialState()` alone -- the golden-file regression
   * depends on it.
   */
  initialState(rng: Rng = mulberry32(INITIAL_PLACEMENT_SEED)): GcRunState {
    const cap = TOKEN_CAP_BASE;
    const state: GcRunState = {
      turn: 1,
      stats: { ...ZERO_STATS, ...this.setup.startingStats },
      energy: 100,
      mood: 0,
      skillPoints: 0,
      acquiredSkills: [],
      scenario: {
        tokens: { ...ZERO_TOKENS },
        tokenCaps: { dance: cap, passion: cap, vocal: cap, visual: cap, mental: cap },
        songsOwned: [],
        concertBonusesActive: [],
        offers: [],
        songsThisPhase: 0,
        techniquesThisPhase: 0,
        techniquesTotal: 0,
        concertsHeld: 0,
        facilityLevels: { speed: 1, stamina: 1, power: 1, guts: 1, wit: 1, ...this.setup.facilityLevels },
        facilityUses: { speed: 0, stamina: 0, power: 0, guts: 0, wit: 0 },
        // Apply initial_friendship. A card with initial_friendship 35 starts at
        // bond 35, not 0.
        cards: this.setup.cards.map((c) => ({
          ...c,
          bond: Math.max(c.bond, c.effects.initial_friendship ?? 0),
        })),
        placement: { speed: [], stamina: [], power: [], guts: [], wit: [] },
        growthRate: this.setup.growthRate ?? {},
        friendEventProgress: Object.fromEntries(
          this.outingChains.map((f) => [f.companionId, 0]),
        ),
        assumptions: [],
      },
    };
    this.rollPlacement(state, rng);
    this.rollBoard(state, rng);
    return state;
  }

  /**
   * Draw the three lessons on offer.
   *
   * Called at career start and after every purchase -- not every turn. The
   * board persists across turns; only buying changes it.
   */
  private rollBoard(state: GcRunState, rng: Rng): void {
    const s = state.scenario;
    s.offers = drawBoard(this.dataset, {
      concertsHeld: s.concertsHeld,
      techniquesThisPhase: s.techniquesThisPhase,
      songsThisPhase: s.songsThisPhase,
      songsOwned: s.songsOwned,
    }, rng, LESSON_OFFERS);
    addAssumption(s, TIER_GATE_SOURCE);
    addAssumption(s, SONG_GATE_SOURCE);
    addAssumption(s, OFFER_DRAW_SOURCE);
  }

  // -------------------------------------------------------------------------
  // Legal actions
  // -------------------------------------------------------------------------

  legalTurnActions(state: GcRunState): TurnAction[] {
    const out: TurnAction[] = [
      { kind: "rest" },
      { kind: "recreation" },
      { kind: "infirmary" },
      { kind: "race" },
    ];
    for (const facility of STATS) {
      // Training below 20 energy is possible in game but reliably a mistake;
      // it stays legal here because the engine must model what the player can
      // actually do, not what it would advise.
      if (state.energy > 0) out.push({ kind: "train", facility });
    }
    return out;
  }

  /**
   * What can be bought right now: the affordable subset of the three lessons on
   * the board.
   *
   * NOT the affordable subset of the catalogue, which is what this returned
   * until 2026-09-06 and which made every technique recommendation
   * unactionable. `offersOnBoard()` exposes all three including the ones that
   * cannot be paid for, because a UI has to show those too -- the game does,
   * greyed, with the shortfall on the point bar.
   */
  legalShopActions(state: GcRunState): ShopAction[] {
    const s = state.scenario;
    const out: ShopAction[] = [];
    for (const id of s.offers) {
      const song = this.dataset.songs.find((x) => x.id === id);
      if (song) {
        if (s.songsOwned.includes(song.id)) continue;
        if (canAfford(s.tokens, song.cost)) out.push({ kind: "song", id: song.id });
        continue;
      }
      const tech = this.dataset.techniques.find((x) => x.id === id);
      if (tech && canAfford(s.tokens, tech.cost)) {
        out.push({ kind: "technique", id: tech.id });
      }
    }
    return out;
  }

  /**
   * The whole board, affordable or not, with what each costs and whether it can
   * be paid for. What a lesson screen renders.
   */
  offersOnBoard(state: GcRunState): Array<{
    action: ShopAction;
    name: string | null;
    effect: string | null;
    cost: TokenVector;
    affordable: boolean;
  }> {
    const s = state.scenario;
    const out = [];
    for (const id of s.offers) {
      const song = this.dataset.songs.find((x) => x.id === id);
      if (song) {
        out.push({
          action: { kind: "song", id: song.id },
          name: song.name,
          effect: song.mastery_bonus.text,
          cost: song.cost,
          affordable: canAfford(s.tokens, song.cost) && !s.songsOwned.includes(song.id),
        });
        continue;
      }
      const tech = this.dataset.techniques.find((x) => x.id === id);
      if (!tech) continue;
      out.push({
        action: { kind: "technique", id: tech.id },
        name: tech.name,
        effect: tech.effect.text,
        cost: tech.cost,
        affordable: canAfford(s.tokens, tech.cost),
      });
    }
    return out;
  }

  // -------------------------------------------------------------------------
  // Transitions
  // -------------------------------------------------------------------------

  step(state: GcRunState, action: TurnAction, rng: Rng): GcRunState {
    const next = cloneState(state);
    const s = next.scenario;

    switch (action.kind) {
      case "train": {
        const placed = this.placedCards(next, action.facility);
        const songs = this.songBonuses(s.songsOwned);
        const concert = this.concertBonuses(s.concertBonusesActive);
        if (concert.friendshipTrainingEffectiveness > 0) {
          addAssumption(s,
            "a song's Concert Bonus of \"Friendship Training Effectiveness +N%\" is " +
            "applied as a multiplier on the friendship term. The game's wording is " +
            "unambiguous about WHAT it boosts but not about HOW it composes -- this " +
            "reads it as scaling the whole friendship term, rather than adding N " +
            "percentage points to each contributing card's own bonus. The two differ " +
            "once several cards contribute, and one logged run separates them.");
        }
        for (const u of concert.unparsed) {
          addAssumption(s, `unrecognised Concert Bonus clause, contributing nothing: ${u}`);
        }
        const result = computeTraining({
          facility: action.facility,
          facilityLevel: s.facilityLevels[action.facility],
          songBonuses: songs.stats,
          songSkillPointBonus: songs.skillPoints,
          concertFriendshipBonus: concert.friendshipTrainingEffectiveness,
          mood: moodFromIndex(next.mood),
          growthRate: s.growthRate,
          cards: placed,
          facilityTable: this.facilityTable,
          statCaps: this.caps,
          currentStats: next.stats,
        });

        const failChance = this.failureChance(s, action.facility, next.energy);
        const failed = chance(rng, failChance);
        addAssumption(s,
          "failure rate uses the real per-facility base from master.mdb, but the " +
          "energy scaling curve is an approximation -- the training screen displays " +
          "the true percentage, so it is directly calibratable from logged captures");

        if (failed) {
          next.energy = clamp(next.energy - 10, ENERGY_MIN, ENERGY_MAX);
          next.mood = clamp(next.mood - 1, MOOD_MIN, MOOD_MAX) as GcRunState["mood"];
        } else {
          for (const stat of STATS) next.stats[stat] += result.gains[stat];
          next.skillPoints += result.skillPoints;
          next.energy = clamp(next.energy + result.energy, ENERGY_MIN, ENERGY_MAX);
          for (const a of result.assumptions) addAssumption(s, a);
          this.grantTokens(s, action.facility, placed.length, rng);
          this.growBonds(s, action.facility);
          this.levelUpFacility(s, action.facility);
        }
        break;
      }

      case "rest":
        next.energy = clamp(next.energy + 30 + Math.floor(rng() * 21), ENERGY_MIN, ENERGY_MAX);
        addAssumption(s, "rest energy gain is approximate; master.mdb command 303 gives +30/+20/+10 by variant");
        break;

      case "recreation": {
        // Destination payoffs are real, from master.mdb: Riverside +10 energy
        // +1 mood, Karaoke +2 mood, Shrine +30/+20/+10 energy +1 mood, Beach
        // +40 energy +1 mood. Which is offered is the game's choice, so with no
        // destination named we take the middle of the range and say so.
        const dest = this.recreation(action.destination, rng);
        next.mood = clamp(next.mood + (dest.mood ?? 0), MOOD_MIN, MOOD_MAX) as GcRunState["mood"];
        next.energy = clamp(next.energy + (dest.energy ?? 0), ENERGY_MIN, ENERGY_MAX);
        if (!action.destination) {
          addAssumption(s, "recreation destination not specified -- averaged across " +
            "the destinations master.mdb offers, which range from +0 to +40 energy");
        }

        // Going with a companion advances their outings. `companionCharaId` is
        // a friend's chara id or a group card's card id.
        if (action.companionCharaId !== undefined) {
          const chain = this.outingChains.find((f) => f.companionId === action.companionCharaId);
          if (chain) {
            const now = s.friendEventProgress[chain.companionId] ?? 0;
            if (now < chain.totalOutings) {
              s.friendEventProgress[chain.companionId] = now + 1;
              addAssumption(s,
                "outing rewards are not modelled -- the step is tracked, but its " +
                "payout lives in the story assets, not master.mdb");
            }
          }
        }
        break;
      }

      case "infirmary":
        next.energy = clamp(next.energy + 10, ENERGY_MIN, ENERGY_MAX);
        break;

      case "race":
        next.energy = clamp(next.energy - 15, ENERGY_MIN, ENERGY_MAX);
        next.skillPoints += 20;
        addAssumption(s, "race rewards are a placeholder; races are not modelled yet");
        break;

      default: {
        // An unrecognised action used to fall straight through this switch and
        // burn a turn doing nothing -- the quietest possible failure. It bit:
        // test/simulator.ts kept passing `{ kind: "outing" }` long after the
        // action was renamed to "recreation", so the golden career contained
        // turns that silently did nothing at all, and nothing failed.
        //
        // The search added at M3 makes that far more dangerous, because it
        // enumerates actions programmatically. A no-op action that costs a turn
        // and yields nothing is a free "pass" move the game does not offer, and
        // a beam search will happily discover and exploit one.
        const never: never = action;
        throw new Error(
          `unknown turn action: ${JSON.stringify(never)}`,
        );
      }
    }

    next.turn += 1;
    this.maybeHoldConcert(next);
    this.rollPlacement(next, rng);
    return next;
  }

  buy(state: GcRunState, action: ShopAction, rng: Rng): GcRunState {
    const next = cloneState(state);
    const s = next.scenario;

    // Buying anything redraws the board. That is the mechanic, and it is why
    // this takes an rng: the shop is a stochastic transition, not a lookup.
    if (action.kind === "technique") {
      const tech = this.dataset.techniques.find((t) => t.id === action.id);
      if (!tech) throw new Error(`unknown technique ${action.id}`);
      if (!canAfford(s.tokens, tech.cost)) throw new Error(`cannot afford technique ${action.id}`);
      s.tokens = subtractTokens(s.tokens, tech.cost);
      s.techniquesThisPhase += 1;
      s.techniquesTotal += 1;
      this.rollBoard(next, rng);
      return next;
    }

    const song = this.dataset.songs.find((x) => x.id === action.id);
    if (!song) throw new Error(`unknown song ${action.id}`);
    if (s.songsOwned.includes(song.id)) throw new Error(`song ${action.id} already learned`);
    if (!canAfford(s.tokens, song.cost)) throw new Error(`cannot afford song ${action.id}`);
    s.tokens = subtractTokens(s.tokens, song.cost);
    s.songsOwned.push(song.id);
    s.songsThisPhase += 1;

    // The Mastery Bonus applies immediately. Its per-training half is picked up
    // by songBonuses() on every subsequent training; the one-off half is granted
    // here.
    //
    // This used to do nothing at all. The decoder in packages/data/src/effects.ts
    // was written, computeTraining() was given `songBonuses` and
    // `songSkillPointBonus` parameters to receive it, and then nothing ever
    // passed them -- so every song in the model was a pure token sink with no
    // effect whatsoever. The consequence was not a small under-projection: it
    // made a performance token worth ZERO at the margin, which made the entire
    // lesson-shop layer an unconstrained problem with no gradient. A planner
    // cannot schedule purchases whose payoff its own model prices at nothing.
    const mastery = decodeEffectText(song.mastery_bonus.text);
    for (const stat of STATS) {
      const grant = mastery.oneOffStat[stat];
      if (grant) next.stats[stat] = Math.min(this.caps[stat], next.stats[stat] + grant);
    }
    next.skillPoints += mastery.oneOffSkillPoints;
    if (mastery.oneOffEnergy) {
      next.energy = clamp(next.energy + mastery.oneOffEnergy, ENERGY_MIN, ENERGY_MAX);
    }
    for (const u of mastery.unparsed) {
      addAssumption(s, `unparsed song effect clause, contributing nothing: ${u}`);
    }
    this.rollBoard(next, rng);
    if (song.concert_bonus_type !== null) {
      addAssumption(s,
        "Concert Bonus opcodes are NOT decoded -- master.mdb stores the type as an " +
        "integer with no shipped description, so a song's permanent from-next-concert " +
        "effect is stored, flagged, and not applied. This is the largest known gap in " +
        "the value of any purchase.");
    }
    return next;
  }

  isTerminal(state: GcRunState): boolean {
    return state.turn > this.dataset.constants.careerTurns;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private placedCards(state: GcRunState, facility: Stat): PlacedCard[] {
    const s = state.scenario;
    return s.placement[facility].map((idx) => {
      const c = s.cards[idx]!;
      // `kind` and `bondThresholdEffects` MUST be forwarded. Dropping `kind`
      // here would make every group card look like a friend card to
      // contributesFriendship(), which is precisely the bug this plumbing exists
      // to prevent -- and it would fail silently, as a slightly low projection.
      return {
        cardId: c.cardId,
        bond: c.bond,
        stat: c.stat,
        ...(c.kind !== undefined ? { kind: c.kind } : {}),
        effects: c.effects,
        ...(c.bondThresholdEffects !== undefined
          ? { bondThresholdEffects: c.bondThresholdEffects }
          : {}),
      };
    });
  }

  /** Support cards scatter across facilities each turn. */
  private rollPlacement(state: GcRunState, rng: Rng): void {
    const s = state.scenario;
    const placement: Record<Stat, number[]> = {
      speed: [], stamina: [], power: [], guts: [], wit: [],
    };
    s.cards.forEach((card, idx) => {
      // A card favours its own facility; the exact weighting is not decoded, so
      // this is a deliberately simple 2:1 bias, flagged as such.
      const weights = {} as Record<Stat, number>;
      for (const f of STATS) weights[f] = card.stat === f ? 2 : 1;
      placement[weightedPick(rng, weights)].push(idx);
    });
    s.placement = placement;
    addAssumption(s, "support card placement weighting is a 2:1 approximation, not decoded");
  }

  private grantTokens(s: GrandConcertState, facility: Stat, cardCount: number, rng: Rng): void {
    const map = this.dataset.constants.facilityTokens[facility];
    const w = this.dataset.constants.tokenRollWeights;
    const roll = weightedPick(rng, { primary: w.primary, secondary: w.secondary, other: w.other });

    let token: Token;
    if (roll === "primary") token = map.primary;
    else if (roll === "secondary") token = map.secondary;
    else {
      const others = TOKENS.filter((t) => t !== map.primary && t !== map.secondary);
      token = others[Math.floor(rng() * others.length)]!;
    }

    // PerformanceToken = floor((S + F) * 1.15^C + 2L). S is 5 for Wit, 9
    // otherwise; F is facility level; C is the support count on this facility;
    // L is the number of scenario-linked cards in the deck.
    //
    // The 2L term was omitted entirely until 2026-09-07, because nothing said
    // which cards were linked. It is not a rounding detail: measured against a
    // real career (60 captured lesson boards, >=1325 points earned, ~59
    // purchases) the model earned roughly HALF, bought 15 lessons, and spent 64
    // of 72 turns unable to afford anything on the board.
    //
    // `single_mode_special_chara` names the five linked characters for this
    // scenario, resolved through support_card_data to 17 cards. That part is
    // extracted. The 2L coefficient is community-sourced, and so is the reading
    // that L counts linked cards DECK-WIDE rather than only those sitting on
    // the facility being trained -- the two differ a lot on a deck where the
    // linked cards cluster, and one logged run separates them.
    const S = facility === "wit" ? 5 : 9;
    const F = s.facilityLevels[facility];
    const L = this.linkedCardCount;
    const amount = Math.floor((S + F) * Math.pow(1.15, cardCount) + 2 * L);
    if (L > 0) {
      addAssumption(s,
        `token gain includes the scenario-link term 2L with L=${L} deck-wide. ` +
        `Which cards are linked is extracted from single_mode_special_chara; the ` +
        `2L coefficient and the deck-wide reading of L are community-sourced.`);
    } else if (!this.dataset.scenarioLinkedCards) {
      addAssumption(s,
        "token gain omits the scenario-link term (2L) -- this dataset predates " +
        "the link list; re-run `npm run extract`");
    }

    s.tokens[token] = Math.min(s.tokens[token] + amount, s.tokenCaps[token]);
  }

  /**
   * Facilities level up as they are used.
   *
   * The real thresholds are not in master.mdb and are not decoded. Leaving the
   * mechanic out entirely is a *larger* error than approximating it -- facility
   * level is worth roughly +50% base value from 1 to 5, so a model that pins
   * every facility at its starting level under-projects a whole career badly.
   * So it is modelled, and flagged, rather than omitted and silently wrong.
   */
  private levelUpFacility(s: GrandConcertState, facility: Stat): void {
    s.facilityUses[facility] += 1;
    const level = Math.min(5, 1 + Math.floor(s.facilityUses[facility] / 4));
    if (level > s.facilityLevels[facility]) s.facilityLevels[facility] = level;
    addAssumption(s, "facility level-up thresholds are approximated (one level per 4 uses), not decoded");
  }

  /**
   * Chance a training fails.
   *
   * The per-facility base comes from `single_mode_training.failure_rate`, and it
   * encodes something players know well: Wit is structurally much safer than
   * everything else. Wit sits at 320-324 across levels while Guts runs 532-548,
   * roughly 40% lower. Combined with Wit being the only facility that *restores*
   * energy (+5 rather than -19 to -26), that is why Wit clicks are the standard
   * way to spend a low-energy turn.
   *
   * What is NOT decoded is how the base scales with energy. The shape below
   * hits zero at full energy and rises as energy drains, which is the right
   * qualitative behaviour, but the curve is a guess. It is calibratable: the
   * training screen displays the true "Failure N%", so logged captures pin it
   * exactly. Until then this is flagged in every projection.
   */
  private failureChance(s: GrandConcertState, facility: Stat, energy: number): number {
    const level = String(s.facilityLevels[facility]);
    const base = this.failureRateBase[facility]?.[level];
    if (base === undefined) return 0;

    // Normalise the raw table value into a per-facility weight, then scale by
    // how far energy has fallen. Quadratic so failure stays negligible while
    // energy is healthy and climbs sharply when it is not.
    const weight = base / 10000;
    const drain = Math.max(0, (100 - energy) / 100);
    return Math.min(0.95, weight * drain * drain * 4);
  }

  /** Resolve a recreation destination's payoff from the extracted table. */
  private recreation(destination: string | undefined, rng: Rng): { energy?: number; mood?: number } {
    const table = this.otherCommands;
    const entries = Object.values(table).filter((e) => e.kind === "recreation");
    if (entries.length === 0) return { energy: 20, mood: 1 };

    const named = destination
      ? entries.find((e) => e.name?.toLowerCase() === destination.toLowerCase())
      : undefined;
    const chosen = named ?? entries[Math.floor(rng() * entries.length)]!;
    const variants = chosen.variants ?? [];
    if (variants.length === 0) return { energy: 0, mood: 1 };
    return variants[Math.floor(rng() * variants.length)]!;
  }

  /**
   * Outings still outstanding per companion, and whether they still fit.
   *
   * Surfaced so a planner can reserve turns rather than discover at turn 68 that
   * it owes four outings it can no longer afford.
   *
   * `remaining` counts OUTINGS, not chain steps, which is the number that
   * matters for scheduling and the two differ for group cards: Team Sirius's
   * "chain" is one step, but playing it out costs seven turns.
   *
   * The two kinds also fail differently. A friend chain is ordered and pays out
   * at the end, so running out of turns wastes every outing already spent. A
   * group card's member outings are independent one-step events, so an
   * unfinished group card has simply left value on the table -- no cliff. A
   * planner should not treat the two deadlines as equally hard.
   */
  friendChainStatus(state: GcRunState): Array<{
    charaId: number;
    kind: "friend" | "group";
    name?: string | undefined;
    done: number;
    total: number;
    remaining: number;
    turnsLeft: number;
    feasible: boolean;
    /** True when abandoning it part-way wastes the outings already spent. */
    allOrNothing: boolean;
  }> {
    const turnsLeft = this.dataset.constants.careerTurns - state.turn + 1;
    return this.outingChains.map((f) => {
      const done = state.scenario.friendEventProgress[f.companionId] ?? 0;
      const remaining = Math.max(0, f.totalOutings - done);
      return {
        charaId: f.companionId,
        kind: f.kind,
        name: f.name,
        done,
        total: f.totalOutings,
        remaining,
        turnsLeft,
        feasible: remaining <= turnsLeft,
        allOrNothing: f.kind === "friend",
      };
    });
  }

  /**
   * Cards in this deck that Grand Concert BANS.
   *
   * `single_mode_restrict_support` lists exactly one: [Passing the Dream On]
   * Team Sirius (30081). The table does not say which way "restrict" points, so
   * this shipped undecided; verified in game 2026-09-06, the card is absent from
   * the Grand Concert support selection screen. It means banned from.
   *
   * So Grand Concert has exactly ONE usable group card, Heirs to the Throne.
   * That is worth knowing before spending anything on the other one.
   *
   * The constructor refuses such a deck outright rather than quietly modelling
   * it, because a plan built on a deck the game will not let you field is worse
   * than no plan -- it looks actionable. This method exists so a deck screen can
   * explain the refusal, and for the `allowRestrictedCards` escape hatch.
   */
  restrictedCards(): Array<{ cardId: number; cardName?: string | undefined; semantics: string }> {
    return GrandConcertScenario.findRestricted(this.dataset, this.setup.cards);
  }

  private static findRestricted(
    dataset: GrandConcertDataset,
    cards: Array<{ cardId: number }>,
  ): Array<{ cardId: number; cardName?: string | undefined; semantics: string }> {
    const r = (dataset as unknown as {
      scenarioRestrictions?: {
        rows?: Array<{ scenarioId: number; cardId: number; cardName?: string }>;
        semantics?: string;
      };
    }).scenarioRestrictions;
    if (!r?.rows) return [];
    // An older dataset predates the in-game check and cannot support a refusal.
    if (r.semantics !== "banned_from") return [];
    const deck = new Set(cards.map((c) => c.cardId));
    return r.rows
      .filter((row) => row.scenarioId === GRAND_CONCERT_SCENARIO_ID && deck.has(row.cardId))
      .map((row) => ({
        cardId: row.cardId,
        cardName: row.cardName,
        semantics: r.semantics!,
      }));
  }

  /**
   * Per-training bonuses from every song currently owned.
   *
   * Cached because this sits in the innermost loop of the planner -- a search
   * runs `step` tens of thousands of times per recommendation, and re-parsing
   * the English text of every owned song each time would dominate the runtime.
   * The key is the owned set, so the cache is correct across states and across
   * runs of a career; it is bounded by the number of distinct song sets a search
   * actually visits.
   */
  private songBonuses(songsOwned: number[]): {
    stats: Partial<Record<Stat, number>>; skillPoints: number;
  } {
    if (songsOwned.length === 0) return EMPTY_SONG_BONUSES;
    const key = songsOwned.slice().sort((a, b) => a - b).join(",");
    const hit = this.songBonusCache.get(key);
    if (hit) return hit;

    const texts = songsOwned.map(
      (id) => this.dataset.songs.find((x) => x.id === id)?.mastery_bonus.text ?? null,
    );
    const acc = accumulatePerTrainingBonuses(texts);
    const value = { stats: acc.stats, skillPoints: acc.skillPoints };
    this.songBonusCache.set(key, value);
    return value;
  }

  /**
   * Concert Bonuses currently running, summed.
   *
   * Cached on the active set for the same reason `songBonuses` is: the search
   * calls `step` tens of thousands of times per recommendation.
   *
   * Only the friendship term is applied. "Support Chain Event Frequency Lvl +N"
   * raises how often support events fire, and event outcomes are not in
   * master.mdb at all (see docs/events.md); "Speciality Priority Up" is a
   * race-side effect this engine does not simulate. Both are decoded, carried,
   * and deliberately not converted into a number the projection would then be
   * pretending to know.
   */
  private concertBonuses(active: number[]): ReturnType<typeof accumulateConcertBonuses> {
    if (active.length === 0) return EMPTY_CONCERT_BONUSES;
    const key = active.slice().sort((a, b) => a - b).join(",");
    const hit = this.concertBonusCache.get(key);
    if (hit) return hit;
    const texts = active.map(
      (id) => this.dataset.songs.find((x) => x.id === id)?.concert_bonus?.text ?? null,
    );
    const value = accumulateConcertBonuses(texts);
    this.concertBonusCache.set(key, value);
    return value;
  }

  private growBonds(s: GrandConcertState, facility: Stat): void {
    for (const idx of s.placement[facility]) {
      const card = s.cards[idx]!;
      card.bond = Math.min(100, card.bond + (card.stat === facility ? 7 : 5));
    }
    addAssumption(s, "bond gain per training is approximate, not decoded");
  }

  private maybeHoldConcert(state: GcRunState): void {
    const s = state.scenario;
    const concert = this.dataset.concerts.find((c) => c.turn === state.turn - 1);
    if (!concert) return;

    s.concertsHeld += 1;

    // Every song owned when the concert happens now has its Concert Bonus
    // running, for the rest of the career. Buying one turn later than this
    // costs you the whole concert's worth of multiplier.
    s.concertBonusesActive = [...s.songsOwned];

    const greatSuccess = s.songsOwned.length >= concert.songs_for_great_success;
    const statBump = greatSuccess ? 10 : 3;
    for (const stat of STATS) {
      state.stats[stat] = Math.min(state.stats[stat] + statBump, this.caps[stat]);
    }

    // Skill points paid out for everything bought since the last concert.
    state.skillPoints += s.techniquesThisPhase * 5;
    // Both counters reset: the song unlock sequence starts again each phase.
    s.techniquesThisPhase = 0;
    s.songsThisPhase = 0;

    const newCap = TOKEN_CAP_BASE + TOKEN_CAP_PER_CONCERT * s.concertsHeld;
    for (const t of TOKENS) s.tokenCaps[t] = newCap;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

function addAssumption(s: GrandConcertState, text: string): void {
  if (!s.assumptions.includes(text)) s.assumptions.push(text);
}

/** Deep enough clone that `step` never mutates its input. */
function cloneState(state: GcRunState): GcRunState {
  const s = state.scenario;
  return {
    ...state,
    stats: { ...state.stats },
    acquiredSkills: [...state.acquiredSkills],
    scenario: {
      ...s,
      tokens: { ...s.tokens },
      tokenCaps: { ...s.tokenCaps },
      songsOwned: [...s.songsOwned],
      concertBonusesActive: [...s.concertBonusesActive],
      offers: [...s.offers],
      facilityLevels: { ...s.facilityLevels },
      cards: s.cards.map((c) => ({ ...c, effects: { ...c.effects } })),
      placement: {
        speed: [...s.placement.speed],
        stamina: [...s.placement.stamina],
        power: [...s.placement.power],
        guts: [...s.placement.guts],
        wit: [...s.placement.wit],
      },
      facilityUses: { ...s.facilityUses },
      growthRate: { ...s.growthRate },
      friendEventProgress: { ...s.friendEventProgress },
      assumptions: [...s.assumptions],
    },
  };
}

export { computeTraining, resolveBaseTraining, isRainbow, MOOD_VALUES };
export type { Mood, PlacedCard };
