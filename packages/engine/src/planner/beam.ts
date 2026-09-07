/**
 * The search.
 *
 * One beam over BOTH decision layers -- turn actions and shop purchases -- for
 * the reason docs/interaction-design.md gives: energy, mood and performance
 * tokens are resources whose value is entirely in what they buy later, so the
 * only way to price a rest against a training, or a held token against a spent
 * one, is to look forward. Splitting the layers would mean pricing tokens
 * without knowing what the trainings need, and pricing trainings without
 * knowing what the tokens will buy.
 *
 * Shape of a turn: purchases cost no turn, so they are not depth. A node may
 * buy several times and then take exactly one turn action, which advances it to
 * the next depth. Depth is measured in turns; `maxBuysPerTurn` bounds the
 * branching that free actions would otherwise make unbounded.
 *
 * ---------------------------------------------------------------------------
 * The part that is easy to get wrong: this is a STOCHASTIC domain
 * ---------------------------------------------------------------------------
 *
 * `step` rolls for training failure, token type and card placement. A beam that
 * samples one successor per action and keeps the best-scoring children does not
 * find the best actions -- it finds the actions that got the luckiest draw.
 * With a beam of 48 and a dozen actions, the winner is a 500-sample maximum of
 * noise, and the search reliably recommends whatever is highest-variance.
 * Optimism under sampling is the standard failure of beam search on MDPs and it
 * looks exactly like a working planner.
 *
 * Two mechanisms, both cheap:
 *
 * 1. COMMON RANDOM NUMBERS. Every expansion at a given depth draws from a fresh
 *    generator seeded from (world, depth). So all siblings face *identical*
 *    luck, and the difference between two actions is attributable to the
 *    actions. This does not remove the bias on its own, but it removes the part
 *    that comes from siblings being compared on different draws.
 *
 * 2. ROOT DETERMINIZATION. The whole search is repeated over `worlds`
 *    independent seeds, and a root action's score is its MEAN across worlds,
 *    not its best. An action that wins one world by luck and loses the rest
 *    does not survive averaging. `worlds` is the knob that trades runtime
 *    against how much of the remaining optimism is left.
 *
 * The spread across worlds is reported, not hidden. When it is wide relative to
 * the gap between the top two actions, the honest reading is that the model
 * cannot separate them, and the caller is expected to say so rather than draw a
 * confident arrow.
 */

import { mulberry32 } from "../rng";
import { STATS, tokenTotal, type Token, type TokenVector } from "../../../data/src/types";
import type { TurnAction, ShopAction } from "../scenario";
import { ENERGY_MAX, MOOD_MAX, type GrandConcertScenario, type GcRunState } from "../scenarios/grand-concert";
import { shortfallScore, type CompiledTarget } from "./objective";
import { stateValue, type RolloutOptions } from "./rollout";
import { resourceValue, type ShadowPrices } from "./shadow";

// ---------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------

/** One entry in a plan: what to do, and on which turn. */
export type PlannedAction =
  | { at: number; kind: "turn"; action: TurnAction }
  | { at: number; kind: "shop"; action: ShopAction };

export interface BeamOptions {
  width: number;
  /** Turns of explicit lookahead. Beyond this, the rollout policy takes over. */
  horizon: number;
  /** Independent root determinizations to average over. */
  worlds: number;
  maxBuysPerTurn: number;
  /**
   * Rollouts averaged per leaf.
   *
   * Was 1, on the reasoning that leaves share a seed so common random numbers
   * would cancel the variance. Measured on real data, they do not: the rollout
   * re-rolls card placement every turn and different leaf states consume the
   * generator at different rates, so the draws desynchronise within a few steps
   * -- over exactly the horizon where the signal lives.
   *
   * The signal being ranked is one training on a 3-card facility versus a
   * 1-card one, worth 5-15 stat points. The leaf value is a career whose spread
   * across seeds is 200+ points. At one sample that is a 1:20 signal-to-noise
   * ratio, and the resulting ranking was close to random: the search picked
   * facilities with 1.29 cards on them when 2.53 were available, barely better
   * than choosing blind.
   */
  leafSamples: number;
  /**
   * Turns of rollout behind each leaf value. 0 plays to the end of the career.
   *
   * The other half of the variance fix. The beam has already searched `horizon`
   * turns explicitly; the leaf only has to value the near future, and a
   * full-career rollout contributes far more variance than signal past a point.
   *
   * This is deliberately NOT applied to the reported goal probability, which
   * must play to turn 72 or it does not mean what it says.
   */
  leafTruncate: number;
  seed: number;
  rollout: RolloutOptions;
  /**
   * Companions whose outings the search may schedule.
   *
   * Empty by default, and that default is deliberate. The scenario tracks
   * outing chains from the dataset, but it does NOT model which companions are
   * in the player's deck -- so offering every incomplete chain would let the
   * planner schedule turns with a friend the player never brought. Passing the
   * list explicitly is the caller saying which companions are really there.
   */
  companions: number[];
}

export const DEFAULT_BEAM: Omit<BeamOptions, "rollout"> = {
  width: 24,
  horizon: 6,
  worlds: 4,
  maxBuysPerTurn: 2,
  leafSamples: 8,
  leafTruncate: 15,
  seed: 1,
  companions: [],
};

// ---------------------------------------------------------------------------
// Nodes
// ---------------------------------------------------------------------------

interface Node {
  state: GcRunState;
  /** Everything done since the root, in order. */
  path: PlannedAction[];
  /** Which root turn action this node descends from. Set on the first advance. */
  rootKey: string | null;
  rootAction: TurnAction | null;
  /** Ordering score while inside the beam. Replaced by the leaf value at horizon. */
  score: number;
  buysThisTurn: number;
  /** Purchases made anywhere on this path. Used to keep the beam diverse. */
  buysOnPath: number;
}

export function actionKey(a: TurnAction): string {
  switch (a.kind) {
    case "train": return `train:${a.facility}`;
    case "recreation":
      return a.companionCharaId === undefined ? "recreation" : `recreation:${a.companionCharaId}`;
    default: return a.kind;
  }
}

/** Turn actions to branch on, including companion outings the caller allowed. */
/**
 * Actions the model itself makes pointless, and which must not be branched on.
 *
 * `legalTurnActions` answers a different question -- what the PLAYER may do --
 * and is right to include these: the game lets you rest at full energy, and an
 * engine that claims otherwise is lying about the game. The search is asking
 * something narrower: what is worth considering. An action whose entire effect
 * is to raise a resource that is already at its ceiling raises nothing, because
 * `step` clamps it; the successor differs from the current state only by the
 * turn counter. It cannot beat any training that gains a single point, and
 * offering it costs a beam slot.
 *
 * That is not a heuristic. It is the arithmetic in `step` read back out, which
 * is why it lives here as a filter over legal actions rather than as a weight
 * on their scores.
 *
 * It mattered: with these on the menu, the search chose rest at 100 energy and
 * infirmary at full health inside a measured career -- pure wasted turns that
 * the leaf estimator's noise made look like the best available play a few
 * percent of the time. Removing the option removes the failure mode outright,
 * where tuning the estimator only makes it rarer.
 *
 * The infirmary case is the one to revisit. It is dominated only because this
 * model has no conditions or injuries for it to clear, so it is a +10 energy
 * button that rest strictly beats. When conditions are modelled it must come
 * back, and `plan()` says so in its assumptions rather than leaving the
 * omission silent.
 */
function isDominated(state: GcRunState, action: TurnAction): boolean {
  switch (action.kind) {
    case "rest":
      return state.energy >= ENERGY_MAX;

    case "infirmary":
      // +10 energy and nothing else, against rest's +30 to +50. Strictly worse
      // whenever rest is available, which is every turn.
      return true;

    case "recreation":
      // Energy and mood, both clamped. A companion outing also advances a
      // friend chain, which is never nothing -- but a bare recreation with both
      // meters full is.
      return action.companionCharaId === undefined
        && state.energy >= ENERGY_MAX
        && state.mood >= MOOD_MAX;

    default:
      return false;
  }
}

export function turnCandidates(
  scenario: GrandConcertScenario,
  state: GcRunState,
  companions: number[],
): TurnAction[] {
  const base = scenario.legalTurnActions(state).filter((a) => !isDominated(state, a));
  if (companions.length === 0) return base;

  const status = new Map(scenario.friendChainStatus(state).map((s) => [s.charaId, s]));
  const out: TurnAction[] = [];
  for (const a of base) {
    out.push(a);
    if (a.kind !== "recreation") continue;
    for (const id of companions) {
      const st = status.get(id);
      // An outing that cannot be finished before turn 72 is not worth branching
      // on for a friend chain, which pays out only at the end. A group card's
      // outings are independent, so an infeasible one is merely capped, not
      // wasted -- friendChainStatus() reports which is which.
      if (!st || st.remaining <= 0) continue;
      if (!st.feasible && st.allOrNothing) continue;
      out.push({ kind: "recreation", companionCharaId: id });
    }
  }
  return out;
}

/**
 * Shop purchases worth branching on.
 *
 * The board offers up to 248 techniques and 21 songs. Branching on all of them
 * would swamp the beam with choices that are not really different: a technique
 * is a technique, they all pay +5 SP at the next concert and all count once
 * toward the song unlock gate, so the only thing distinguishing two affordable
 * ones is which currencies they drain. Two cheapest is enough to express "spend
 * now" versus "spend on the least scarce currency".
 *
 * Songs are the real decision and are NOT collapsed -- which song, and whether
 * to buy it now or bank for a better one, is the question Layer B exists to
 * answer, and it is the one the existing community planners get wrong by
 * ignoring time-value.
 */
export function shopCandidates(
  scenario: GrandConcertScenario,
  state: GcRunState,
  maxSongs = 6,
): ShopAction[] {
  const legal = scenario.legalShopActions(state);
  const songs: ShopAction[] = [];
  const techs: Array<{ a: ShopAction; cost: number }> = [];

  const techCost = new Map<number, number>();
  for (const t of scenario.dataset.techniques) techCost.set(t.id, tokenTotal(t.cost));
  const songCost = new Map<number, number>();
  for (const s of scenario.dataset.songs) songCost.set(s.id, tokenTotal(s.cost));

  for (const a of legal) {
    if (a.kind === "song") songs.push(a);
    else techs.push({ a, cost: techCost.get(a.id) ?? Infinity });
  }

  songs.sort((x, y) => (songCost.get(x.id) ?? 0) - (songCost.get(y.id) ?? 0));
  techs.sort((x, y) => x.cost - y.cost);

  return [...songs.slice(0, maxSongs), ...techs.slice(0, 2).map((t) => t.a)];
}

// ---------------------------------------------------------------------------
// The search
// ---------------------------------------------------------------------------

export interface RootScore {
  key: string;
  action: TurnAction;
  /** Mean leaf value across worlds. The ranking number. */
  mean: number;
  /** Sample standard deviation across worlds. Wide means "cannot separate". */
  spread: number;
  /** Per-world values, so a caller can see the disagreement rather than a summary. */
  perWorld: number[];
  /** The best continuation found for this action, for display as a plan. */
  bestPath: PlannedAction[];
}

export interface BeamResult {
  roots: RootScore[];
  /** Best full path found, across all root actions and worlds. */
  bestPath: PlannedAction[];
  /** State at the end of that path, so the caller can project past the horizon. */
  bestLeaf: GcRunState | null;
  /** Seed the best leaf was evaluated under, so a projection matches its value. */
  bestLeafSeed: number;
  nodesExpanded: number;
  rollouts: number;
}

export function beamSearch(
  scenario: GrandConcertScenario,
  root: GcRunState,
  target: CompiledTarget,
  prices: ShadowPrices,
  opts: BeamOptions,
): BeamResult {
  const perWorld = new Map<string, { action: TurnAction; values: number[]; best: { v: number; path: PlannedAction[] } }>();
  let nodesExpanded = 0;
  let rollouts = 0;
  let globalBest = { v: -Infinity, path: [] as PlannedAction[], leaf: null as GcRunState | null, seed: 0 };

  for (let w = 0; w < opts.worlds; w++) {
    const worldSeed = (opts.seed + w * 7919) >>> 0;

    let frontier: Node[] = [{
      state: root,
      path: [],
      rootKey: null,
      rootAction: null,
      score: shortfallScore(root, target) + resourceValue(root, prices),
      buysThisTurn: 0,
      buysOnPath: 0,
    }];

    for (let depth = 0; depth < opts.horizon; depth++) {
      // Common random numbers: one generator seed per (world, depth). Every
      // expansion at this depth makes a FRESH generator from it, so siblings
      // draw the identical sequence and differ only by their action.
      const drawSeed = (worldSeed ^ ((depth + 1) * 2654435761)) >>> 0;

      const advanced: Node[] = [];
      let pool = frontier;

      for (let b = 0; b <= opts.maxBuysPerTurn && pool.length > 0; b++) {
        const bought: Node[] = [];

        for (const node of pool) {
          if (scenario.isTerminal(node.state)) { advanced.push(node); continue; }

          for (const action of turnCandidates(scenario, node.state, opts.companions)) {
            const next = scenario.step(node.state, action, mulberry32(drawSeed));
            nodesExpanded++;
            const key = node.rootKey ?? actionKey(action);
            advanced.push({
              state: next,
              path: [...node.path, { at: node.state.turn, kind: "turn", action }],
              rootKey: key,
              rootAction: node.rootAction ?? action,
              score: shortfallScore(next, target) + resourceValue(next, prices),
              buysThisTurn: 0,
              buysOnPath: node.buysOnPath,
            });
          }

          if (b < opts.maxBuysPerTurn) {
            for (const buy of shopCandidates(scenario, node.state)) {
              // Buying redraws the board, so it needs its own generator. Seeded
              // from (depth, buys-so-far) rather than shared with the turn
              // draws, so two candidate purchases at the same point face the
              // same replacement board -- common random numbers again, applied
              // to the shop.
              const next = scenario.buy(
                node.state, buy, mulberry32((drawSeed ^ ((b + 1) * 40503)) >>> 0),
              );
              nodesExpanded++;
              bought.push({
                state: next,
                path: [...node.path, { at: node.state.turn, kind: "shop", action: buy }],
                rootKey: node.rootKey,
                rootAction: node.rootAction,
                score: shortfallScore(next, target) + resourceValue(next, prices),
                buysThisTurn: node.buysThisTurn + 1,
                buysOnPath: node.buysOnPath + 1,
              });
            }
          }
        }

        pool = prune(bought, opts.width);
      }

      // Keep the beam broad across root actions AND across how much has been
      // spent -- see pruneByRoot. Both are search artefacts that masquerade as
      // findings about the game if left alone.
      frontier = pruneByRoot(advanced, opts.width);
      if (frontier.length === 0) break;
    }

    // Leaf evaluation. Leaves share a seed base for the same reason siblings do.
    const leafSeed = (worldSeed ^ 0x5f356495) >>> 0;
    // Leaf evaluation runs on a truncated rollout; the goal probability
    // reported at the root does not, and must not.
    const leafRollout = opts.leafTruncate > 0
      ? { ...opts.rollout, truncateAfter: opts.leafTruncate }
      : opts.rollout;
    const bestForRoot = new Map<string, { v: number; path: PlannedAction[] }>();

    for (const leaf of frontier) {
      if (leaf.rootKey === null || leaf.rootAction === null) continue;
      const v = stateValue(scenario, leaf.state, target, leafSeed, opts.leafSamples, leafRollout);
      rollouts += opts.leafSamples;
      const cur = bestForRoot.get(leaf.rootKey);
      if (!cur || v > cur.v) bestForRoot.set(leaf.rootKey, { v, path: leaf.path });
      if (v > globalBest.v) globalBest = { v, path: leaf.path, leaf: leaf.state, seed: leafSeed };
    }

    for (const leaf of frontier) {
      if (leaf.rootKey === null || leaf.rootAction === null) continue;
      if (!perWorld.has(leaf.rootKey)) {
        perWorld.set(leaf.rootKey, { action: leaf.rootAction, values: [], best: { v: -Infinity, path: [] } });
      }
    }
    for (const [key, best] of bestForRoot) {
      const entry = perWorld.get(key)!;
      entry.values.push(best.v);
      if (best.v > entry.best.v) entry.best = best;
    }
  }

  const roots: RootScore[] = [];
  for (const [key, e] of perWorld) {
    if (e.values.length === 0) continue;
    const mean = e.values.reduce((a, b) => a + b, 0) / e.values.length;
    const variance = e.values.length < 2
      ? 0
      : e.values.reduce((a, b) => a + (b - mean) ** 2, 0) / (e.values.length - 1);
    roots.push({
      key,
      action: e.action,
      mean,
      spread: Math.sqrt(variance),
      perWorld: e.values,
      bestPath: e.best.path,
    });
  }
  roots.sort((a, b) => b.mean - a.mean);

  return {
    roots,
    bestPath: globalBest.path,
    bestLeaf: globalBest.leaf,
    bestLeafSeed: globalBest.seed,
    nodesExpanded,
    rollouts,
  };
}

function prune(nodes: Node[], width: number): Node[] {
  if (nodes.length <= width) return nodes;
  return nodes.sort((a, b) => b.score - a.score).slice(0, width);
}

/** Buy-count buckets the beam keeps separate. Beyond this they share one. */
const BUY_BUCKETS = 4;

/**
 * Prune to `width` while guaranteeing a share to every root action AND to every
 * level of spending.
 *
 * Two starvation problems, and the second one is subtle enough that it shipped
 * broken once.
 *
 * ROOT STARVATION. A plain top-N cut lets one strong opening monopolise the
 * beam by depth two, after which the other openings are scored from whatever
 * thin remnant survived. That makes the search unfalsifiable: every action it
 * pruned early comes back looking worst, whether or not it was.
 *
 * SPENDING STARVATION. A purchase costs tokens and pays off later -- at the
 * next concert, or through a bonus that compounds over the remaining turns. So
 * at the moment of buying, a buy-node scores no better than the hold-node it
 * branched from, and with token prices near zero it scores exactly the same.
 * Ties then resolve by insertion order, which favours holding, so purchase
 * lines were being cut at depth 0 and 1 and never reached the concert that
 * would have justified them. The search was not deciding not to buy; it was
 * never pricing the option at all.
 *
 * Bucketing by (root action, purchases so far) fixes it without inventing any
 * value for a purchase: lines that spent and lines that held are both carried
 * forward to the depth where the difference actually shows up, and the leaf
 * evaluation decides. That is the whole argument for searching instead of
 * scoring, applied to the search's own pruning rule.
 */
function pruneByRoot(nodes: Node[], width: number): Node[] {
  if (nodes.length <= width) return nodes;

  const byRoot = new Map<string, Node[]>();
  for (const n of nodes) {
    const k = `${n.rootKey ?? ""}|${Math.min(n.buysOnPath, BUY_BUCKETS - 1)}`;
    const list = byRoot.get(k);
    if (list) list.push(n); else byRoot.set(k, [n]);
  }
  for (const list of byRoot.values()) list.sort((a, b) => b.score - a.score);

  const out: Node[] = [];
  const lists = [...byRoot.values()];
  for (let i = 0; out.length < width; i++) {
    let added = false;
    for (const list of lists) {
      if (i < list.length) { out.push(list[i]!); added = true; }
      if (out.length >= width) break;
    }
    if (!added) break;
  }
  return out;
}

/** Turn a path into the shop schedule a human can act on. */
export function shopPlan(path: PlannedAction[]): Array<{ turn: number; action: ShopAction }> {
  return path
    .filter((p): p is Extract<PlannedAction, { kind: "shop" }> => p.kind === "shop")
    .map((p) => ({ turn: p.at, action: p.action }));
}

export type { Token, TokenVector, ShopAction, TurnAction };
export { STATS };
