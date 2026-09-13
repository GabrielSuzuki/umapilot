/**
 * The run: which cards, what caps, where the facilities started.
 *
 * This existed only as `examples/real-run.json` -- one captured career, loaded
 * unconditionally. Every recommendation the app has ever given was therefore
 * computed against that deck. Which facilities a deck can rainbow is the
 * largest single lever on what gets recommended (`deck-and-rainbow.md`), so a
 * wrong deck is not a small approximation: it is a wrong premise under a
 * correct calculation, and the correctness of the calculation makes it harder
 * to notice rather than easier.
 *
 * Cards are PICKED FROM THE PLAYER'S OWN EXTRACT rather than typed. Hand-entry
 * of friendship bonuses and mood effects would be both tedious and wrong, and
 * the real values are already sitting in the dataset built from their
 * `master.mdb`. Choosing by name also makes the scenario-link count correct for
 * free: the engine derives it from card IDs against
 * `dataset.scenarioLinkedCards`, so a real ID is a real link.
 */
import { STATS, type Stat, type StatVector } from "../../data/src/types";
import type { RunSetup } from "./run";
import { resolveCard, sortCards, CARD_LEVELS } from "./deck";
import type { SupportCardRecord } from "./dataset";

const STORE_KEY = "umapilot.runsetup.v1";

export interface StoredSetup {
  cards: Array<{ id: number; level: number } | null>;
  startingStats: StatVector;
  statCaps: StatVector;
  facilityLevels: Record<Stat, number>;
}

/**
 * Saved between sessions, because a deck is entered once per career and asking
 * again on every reload would guarantee it goes stale instead.
 *
 * Wrapped, because storage throws in a private window and returns nothing after
 * the player clears site data -- and a setup pane that cannot render is worse
 * than one that starts from the default.
 */
export function loadStored(): StoredSetup | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as StoredSetup) : null;
  } catch { return null; }
}

export function saveStored(s: StoredSetup): void {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(s)); } catch { /* not fatal */ }
}

export function storedFrom(setup: RunSetup): StoredSetup {
  return {
    cards: setup.cards.map((c) => ({ id: c.cardId, level: 50 })),
    startingStats: { ...setup.startingStats },
    statCaps: { ...setup.statCaps },
    facilityLevels: { ...setup.facilityLevels },
  };
}

/** Build the engine's setup from what the player chose. */
export function setupFrom(
  stored: StoredSetup, catalogue: readonly SupportCardRecord[],
): RunSetup {
  const byId = new Map(catalogue.map((c) => [c.id, c]));
  const cards = stored.cards
    .map((slot) => (slot ? byId.get(slot.id) && resolveCard(byId.get(slot.id)!, slot.level) : null))
    .filter((c): c is NonNullable<typeof c> => !!c);
  return {
    startingStats: { ...stored.startingStats },
    statCaps: { ...stored.statCaps },
    facilityLevels: { ...stored.facilityLevels },
    cards,
  };
}

export interface SetupPane {
  stop(): void;
  /**
   * Push caps read off the game into the pane.
   *
   * Here rather than in the turn state because a cap is a property of the RUN,
   * and it is pushed rather than typed because it MOVES: the captured career
   * shows speed going 1625 -> 1630 -> 1635 and stamina 1332 -> 1336 -> 1342,
   * each step on the first turn of a new year. A player who typed the caps off
   * Legacy Select in Junior year would be running on stale numbers for two
   * thirds of the career and would have no reason to suspect it.
   *
   * Returns whether anything changed, so the caller only pays for a scenario
   * rebuild when it did -- which is twice in seventy-two turns.
   */
  setCaps(caps: Partial<Record<Stat, number>>): boolean;
}

export function mountSetup(
  host: HTMLElement,
  catalogue: readonly SupportCardRecord[],
  initial: StoredSetup,
  onChange: (s: StoredSetup) => void,
): SetupPane {
  let state: StoredSetup = JSON.parse(JSON.stringify(initial)) as StoredSetup;
  const sorted = sortCards(catalogue);

  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

  function render(): void {
    const cardRows = Array.from({ length: 6 }, (_, i) => {
      const slot = state.cards[i] ?? null;
      const opts = sorted.map((c) =>
        `<option value="${c.id}"${slot?.id === c.id ? " selected" : ""}>${esc(c.rarity)} · ${esc(c.name)}</option>`).join("");
      const lvls = CARD_LEVELS.map((l) =>
        `<option value="${l}"${slot?.level === l ? " selected" : ""}>Lv ${l}</option>`).join("");
      return `<div class="slot">
        <select data-slot="${i}" class="cardpick">
          <option value="">— empty —</option>${opts}
        </select>
        <select data-slot="${i}" class="lvlpick">${lvls}</select>
      </div>`;
    }).join("");

    const statRow = (label: string, key: keyof StoredSetup) => `
      <div class="setrow"><span>${label}</span>${STATS.map((s) =>
        `<label>${s.slice(0, 2)}<input type="number" data-group="${key}" data-stat="${s}"
          value="${(state[key] as Record<string, number>)[s]}" min="0" max="2000"></label>`).join("")}</div>`;

    host.innerHTML = `
      <p class="sub">The deck, the caps and the starting line. Until this existed the
        app used one captured career's deck for every recommendation — and which
        facilities can rainbow is the biggest single lever on what it tells you.</p>
      <section class="card">
        <h2>Support deck</h2>
        <p class="note">Picked from your own extract, so the effects and the
          scenario-link count are the real ones rather than typed approximations.</p>
        ${cardRows}
      </section>
      <section class="card">
        <h2>The run</h2>
        ${statRow("Starting stats", "startingStats")}
        ${statRow("Stat caps", "statCaps")}
        ${statRow("Facility levels", "facilityLevels")}
        <p class="note">Caps are per-run, not per-scenario — legacy raises them, so
          read them off Legacy Select. They also rise <em>during</em> a run: the
          captured career went 1625 → 1630 → 1635 on speed, each step on the first
          turn of a new year. Live capture reads the cap row every turn and raises
          these for you, so you should not have to come back here.</p>
      </section>
      <p><button class="go" id="set-reset">Back to the captured career</button></p>`;
  }

  host.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    const slotAttr = t.getAttribute("data-slot");
    if (slotAttr !== null) {
      const i = Number(slotAttr);
      const sel = t as HTMLSelectElement;
      const cur = state.cards[i] ?? { id: 0, level: 50 };
      if (t.classList.contains("cardpick")) {
        state.cards[i] = sel.value ? { id: Number(sel.value), level: cur.level } : null;
      } else {
        state.cards[i] = cur.id ? { id: cur.id, level: Number(sel.value) } : null;
      }
      onChange(state);
      return;
    }
    const group = t.getAttribute("data-group") as keyof StoredSetup | null;
    const stat = t.getAttribute("data-stat");
    if (group && stat) {
      const n = Number((t as HTMLInputElement).value);
      if (Number.isFinite(n)) {
        (state[group] as Record<string, number>)[stat] = Math.max(0, n);
        onChange(state);
      }
    }
  });

  host.addEventListener("click", (e) => {
    if ((e.target as HTMLElement).id !== "set-reset") return;
    state = JSON.parse(JSON.stringify(initial)) as StoredSetup;
    render();
    onChange(state);
  });

  render();
  return {
    stop() { /* nothing to tear down */ },
    setCaps(caps) {
      let changed = false;
      for (const s of STATS) {
        const v = caps[s];
        // Only ever upward. The caps in this game rise and do not fall, so a
        // lower reading is a misread or a stale frame, and accepting it would
        // tell the planner a stat it has already trained past is worthless.
        if (typeof v === "number" && v > state.statCaps[s]) { state.statCaps[s] = v; changed = true; }
      }
      if (!changed) return false;
      render();
      onChange(state);
      return true;
    },
  };
}
