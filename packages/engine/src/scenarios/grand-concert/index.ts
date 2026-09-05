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
import { weightedPick, chance, type Rng } from "../../rng";
import {
  computeTraining, resolveBaseTraining, isRainbow,
  MOOD_VALUES, type Mood, type PlacedCard, type FacilityTable,
} from "./training";
import type { RunState, TurnAction, ShopAction, Scenario } from "../../scenario";

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
  effects: PlacedCard["effects"] & { initial_friendship?: number };
}

export interface GrandConcertState {
  tokens: TokenVector;
  tokenCaps: TokenVector;
  songsOwned: number[];
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
  /** Everything the projection rests on that has not been verified. */
  assumptions: string[];
}

export type GcRunState = RunState<GrandConcertState>;

const MOOD_ORDER: Mood[] = ["awful", "bad", "normal", "good", "great"];
const moodFromIndex = (i: number): Mood => MOOD_ORDER[Math.min(Math.max(i + 2, 0), 4)]!;

/** Token cap starts at 200 and rises 50 per concert held. */
export const TOKEN_CAP_BASE = 200;
export const TOKEN_CAP_PER_CONCERT = 50;

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

export interface GrandConcertSetup {
  startingStats?: Partial<StatVector>;
  statCaps?: Partial<StatVector>;
  cards: CardState[];
  growthRate?: Partial<Record<Stat, number>>;
  facilityLevels?: Partial<Record<Stat, number>>;
}

export class GrandConcertScenario
  implements Scenario<GrandConcertState, GrandConcertDataset>
{
  readonly id = "grand-concert";
  readonly displayName = "Brighter Together! Our Grand Concert";

  private readonly facilityTable: FacilityTable;
  private readonly failureRateBase: Record<string, Record<string, number>>;
  private readonly otherCommands: Record<string, {
    name?: string; kind?: string; variants?: Array<{ energy?: number; mood?: number }>;
  }>;
  private readonly caps: StatVector;

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
    this.caps = { ...dataset.constants.statCaps, ...setup.statCaps };
  }

  get statCaps(): StatVector {
    return { ...this.caps };
  }

  /** Failure chance for a facility in the given state. Used by policies. */
  failureChanceFor(state: GcRunState, facility: Stat): number {
    return this.failureChance(state.scenario, facility, state.energy);
  }

  initialState(): GcRunState {
    const cap = TOKEN_CAP_BASE;
    return {
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
        assumptions: [],
      },
    };
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

  legalShopActions(state: GcRunState): ShopAction[] {
    const s = state.scenario;
    const out: ShopAction[] = [];
    for (const t of this.dataset.techniques) {
      if (canAfford(s.tokens, t.cost)) out.push({ kind: "technique", id: t.id });
    }
    for (const song of this.dataset.songs) {
      if (s.songsOwned.includes(song.id)) continue;
      if (canAfford(s.tokens, song.cost)) out.push({ kind: "song", id: song.id });
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
        const result = computeTraining({
          facility: action.facility,
          facilityLevel: s.facilityLevels[action.facility],
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
          next.energy = clamp(next.energy - 10, 0, 100);
          next.mood = clamp(next.mood - 1, -2, 2) as GcRunState["mood"];
        } else {
          for (const stat of STATS) next.stats[stat] += result.gains[stat];
          next.skillPoints += result.skillPoints;
          next.energy = clamp(next.energy + result.energy, 0, 100);
          for (const a of result.assumptions) addAssumption(s, a);
          this.grantTokens(s, action.facility, placed.length, rng);
          this.growBonds(s, action.facility);
          this.levelUpFacility(s, action.facility);
        }
        break;
      }

      case "rest":
        next.energy = clamp(next.energy + 30 + Math.floor(rng() * 21), 0, 100);
        addAssumption(s, "rest energy gain is approximate; master.mdb command 303 gives +30/+20/+10 by variant");
        break;

      case "recreation": {
        // Destination payoffs are real, from master.mdb: Riverside +10 energy
        // +1 mood, Karaoke +2 mood, Shrine +30/+20/+10 energy +1 mood, Beach
        // +40 energy +1 mood. Which is offered is the game's choice, so with no
        // destination named we take the middle of the range and say so.
        const dest = this.recreation(action.destination, rng);
        next.mood = clamp(next.mood + (dest.mood ?? 0), -2, 2) as GcRunState["mood"];
        next.energy = clamp(next.energy + (dest.energy ?? 0), 0, 100);
        if (!action.destination) {
          addAssumption(s, "recreation destination not specified -- averaged across " +
            "the destinations master.mdb offers, which range from +0 to +40 energy");
        }
        break;
      }

      case "infirmary":
        next.energy = clamp(next.energy + 10, 0, 100);
        break;

      case "race":
        next.energy = clamp(next.energy - 15, 0, 100);
        next.skillPoints += 20;
        addAssumption(s, "race rewards are a placeholder; races are not modelled yet");
        break;
    }

    next.turn += 1;
    this.maybeHoldConcert(next);
    this.rollPlacement(next, rng);
    return next;
  }

  buy(state: GcRunState, action: ShopAction): GcRunState {
    const next = cloneState(state);
    const s = next.scenario;

    if (action.kind === "technique") {
      const tech = this.dataset.techniques.find((t) => t.id === action.id);
      if (!tech) throw new Error(`unknown technique ${action.id}`);
      if (!canAfford(s.tokens, tech.cost)) throw new Error(`cannot afford technique ${action.id}`);
      s.tokens = subtractTokens(s.tokens, tech.cost);
      s.techniquesThisPhase += 1;
      s.techniquesTotal += 1;
      return next;
    }

    const song = this.dataset.songs.find((x) => x.id === action.id);
    if (!song) throw new Error(`unknown song ${action.id}`);
    if (s.songsOwned.includes(song.id)) throw new Error(`song ${action.id} already learned`);
    if (!canAfford(s.tokens, song.cost)) throw new Error(`cannot afford song ${action.id}`);
    s.tokens = subtractTokens(s.tokens, song.cost);
    s.songsOwned.push(song.id);
    addAssumption(s, "song mastery and concert bonus effects are not decoded; their value is not yet modelled");
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
      return { cardId: c.cardId, bond: c.bond, stat: c.stat, effects: c.effects };
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
    // otherwise; F is facility level; C is the support count; L is the number of
    // scenario-linked cards, which we do not track yet.
    const S = facility === "wit" ? 5 : 9;
    const F = s.facilityLevels[facility];
    const amount = Math.floor((S + F) * Math.pow(1.15, cardCount));
    addAssumption(s, "token gain omits the scenario-link term (2L); linked cards are not tracked yet");

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
    const greatSuccess = s.songsOwned.length >= concert.songs_for_great_success;
    const statBump = greatSuccess ? 10 : 3;
    for (const stat of STATS) {
      state.stats[stat] = Math.min(state.stats[stat] + statBump, this.caps[stat]);
    }

    // Skill points paid out for everything bought since the last concert.
    state.skillPoints += s.techniquesThisPhase * 5;
    s.techniquesThisPhase = 0;

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
      assumptions: [...s.assumptions],
    },
  };
}

export { computeTraining, resolveBaseTraining, isRainbow, MOOD_VALUES };
export type { Mood, PlacedCard };
