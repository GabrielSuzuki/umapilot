/**
 * The run being advised: deck, caps, and the state the player is in right now.
 *
 * Per `interaction-design.md` the shipped answer is continuous passive capture
 * via `getDisplayMedia` -- zero interactions a turn. That is layer three. This
 * slice is layer one, so the state is typed in, and the fields are exactly the
 * ones a capture would fill: everything visible on the training screen without
 * hovering anything.
 */
import type { Stat, StatVector } from "../../data/src/types";
import { STATS } from "../../data/src/types";
import type { CardState, GcRunState } from "../../engine/src/scenarios/grand-concert";
import { GrandConcertScenario } from "../../engine/src/scenarios/grand-concert";
import type { GrandConcertDataset } from "../../data/src/types";
import realRun from "../../../examples/real-run.json";

export interface RunSetup {
  startingStats: StatVector;
  statCaps: StatVector;
  facilityLevels: Record<Stat, number>;
  cards: CardState[];
}

/**
 * The 2026-09-05 captured career, as the starting example.
 *
 * A real deck beats an invented one for a first screen: every number below came
 * off a real Legacy Select and a real Support Formation, so nothing here is a
 * placeholder pretending to be data. The deck screen (M3d) replaces this.
 */
export function defaultSetup(): RunSetup {
  const r = realRun as unknown as {
    startingStats: StatVector; statCaps: StatVector;
    facilityLevels: Record<Stat, number>; cards: CardState[];
  };
  return {
    startingStats: { ...r.startingStats },
    statCaps: { ...r.statCaps },
    facilityLevels: { ...r.facilityLevels },
    cards: r.cards.map((c) => ({ ...c, effects: { ...c.effects } })),
  };
}

export function makeScenario(
  dataset: GrandConcertDataset,
  setup: RunSetup,
): GrandConcertScenario {
  return new GrandConcertScenario(dataset, {
    cards: setup.cards.map((c) => ({ ...c, effects: { ...c.effects } })),
    startingStats: setup.startingStats,
    statCaps: setup.statCaps,
    facilityLevels: setup.facilityLevels,
  });
}

/** Fields the player edits, mirroring what a captured frame would carry. */
export interface Editable {
  turn: number;
  energy: number;
  mood: number;
  stats: StatVector;
  skillPoints: number;
  bonds: number[];
}

export function editableFrom(state: GcRunState): Editable {
  return {
    turn: state.turn,
    energy: state.energy,
    mood: state.mood,
    stats: { ...state.stats },
    skillPoints: state.skillPoints,
    bonds: state.scenario.cards.map((c) => c.bond),
  };
}

/** Apply the edited fields back onto a freshly-rolled state. */
export function applyEditable(state: GcRunState, e: Editable): GcRunState {
  const cards = state.scenario.cards.map((c, i) => ({
    ...c,
    bond: Math.max(0, Math.min(100, e.bonds[i] ?? c.bond)),
  }));
  const stats = { ...state.stats };
  for (const s of STATS) stats[s] = Math.max(0, e.stats[s]);
  return {
    ...state,
    turn: Math.max(1, e.turn),
    energy: Math.max(0, Math.min(100, e.energy)),
    mood: Math.max(-2, Math.min(2, e.mood)) as GcRunState["mood"],
    stats,
    skillPoints: Math.max(0, e.skillPoints),
    scenario: { ...state.scenario, cards },
  };
}
