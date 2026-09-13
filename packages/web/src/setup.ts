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
   * each step on Early Apr, turns 31 and 55. A player who typed the caps off
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

  /**
   * A card is TYPED, not scrolled to.
   *
   * The first version put all 250 cards in a `<select>` per slot. The player's
   * report was "can you add a search bar for the support cards to make it easier
   * to find the cards", which is the polite version of: a 250-item dropdown is
   * not a picker, it is a list you scroll through six times.
   *
   * A text input with a `<datalist>` is the whole fix and costs no code -- the
   * browser filters as you type, natively, and one shared list serves all six
   * slots. What it does need is a resolver, because a typed name is text and the
   * engine wants a card id.
   */
  const label = (c: SupportCardRecord) => `${c.rarity} · ${c.name}`;
  const byLabel = new Map(sorted.map((c) => [label(c).toLowerCase(), c]));
  const byName = new Map(sorted.map((c) => [c.name.toLowerCase(), c]));

  /**
   * Resolve typed text to one card, or say why it could not.
   *
   * Three chances, narrowest first: the exact label the datalist offers (what a
   * click produces), the card's own name (what someone types from memory), and
   * finally a unique substring, so "kitasan" lands without the brackets. A
   * substring matching several cards resolves to NOTHING and says how many --
   * picking the first would silently give the player a different card, and the
   * whole point of this pane is that the deck is the one premise the app cannot
   * guess.
   */
  function resolveTyped(text: string): { card?: SupportCardRecord; matches: number } {
    const q = text.trim().toLowerCase();
    if (!q) return { matches: 0 };
    const exact = byLabel.get(q) ?? byName.get(q);
    if (exact) return { card: exact, matches: 1 };
    const hits = sorted.filter((c) => label(c).toLowerCase().includes(q));
    return hits.length === 1 ? { card: hits[0]!, matches: 1 } : { matches: hits.length };
  }

  function render(): void {
    const catalogueList = `<datalist id="cardnames">${
      sorted.map((c) => `<option value="${esc(label(c))}"></option>`).join("")}</datalist>`;

    const cardRows = Array.from({ length: 6 }, (_, i) => {
      const slot = state.cards[i] ?? null;
      const card = slot ? sorted.find((c) => c.id === slot.id) : undefined;
      const lvls = CARD_LEVELS.map((l) =>
        `<option value="${l}"${slot?.level === l ? " selected" : ""}>Lv ${l}</option>`).join("");
      return `<div class="slot">
        <input class="cardpick" data-slot="${i}" list="cardnames" spellcheck="false"
          placeholder="type part of a card or uma name" value="${card ? esc(label(card)) : ""}">
        <span class="found" data-found="${i}">${card ? "ok" : ""}</span>
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
          scenario-link count are the real ones rather than typed approximations.
          Type any part of a card's title or the uma's name; the list filters as
          you go. A name that matches more than one card is not guessed at.</p>
        ${catalogueList}
        ${cardRows}
      </section>
      <section class="card">
        <h2>The run</h2>
        ${statRow("Starting stats", "startingStats")}
        ${statRow("Stat caps", "statCaps")}
        ${statRow("Facility levels", "facilityLevels")}
        <p class="note">Caps are per-run, not per-scenario — legacy raises them, so
          read them off Legacy Select. They also rise <em>during</em> a run: the
          captured career went 1625 → 1630 → 1635 on speed, both steps on Early
          Apr. Live capture reads the cap row every turn and follows them for you,
          so you should not have to come back here — including into a new career,
          where the caps are usually lower than the last one's.</p>
      </section>
      <p><button class="go danger" id="set-reset">Discard this deck and load the captured career</button></p>
      <p class="note">That button replaces everything on this page. It is the one
        destructive control here, so it asks twice.</p>`;
  }

  /**
   * Card text is handled on `input`, not `change`.
   *
   * `change` on a text input fires when it loses focus, so a player who typed a
   * name and went straight back to the game would have had the slot stay empty
   * with no sign anything was wrong. On `input` the match, or the reason there
   * isn't one, appears as they type.
   */
  host.addEventListener("input", (e) => {
    const t = e.target as HTMLElement;
    if (!t.classList.contains("cardpick")) return;
    const i = Number(t.getAttribute("data-slot"));
    const input = t as HTMLInputElement;
    const found = host.querySelector<HTMLElement>(`[data-found="${i}"]`);
    const cur = state.cards[i] ?? { id: 0, level: 50 };
    const { card, matches } = resolveTyped(input.value);
    input.classList.toggle("unmatched", input.value.trim() !== "" && !card);
    if (found) {
      found.textContent = input.value.trim() === "" ? "" : card ? "ok" : matches === 0 ? "no match" : `${matches} match`;
      found.classList.toggle("no", input.value.trim() !== "" && !card);
    }
    const next = card ? { id: card.id, level: cur.level } : null;
    const same = (next?.id ?? null) === (state.cards[i]?.id ?? null);
    if (same) return;
    state.cards[i] = next;
    onChange(state);
  });

  host.addEventListener("change", (e) => {
    const t = e.target as HTMLElement;
    const slotAttr = t.getAttribute("data-slot");
    if (slotAttr !== null && !t.classList.contains("cardpick")) {
      const i = Number(slotAttr);
      const sel = t as HTMLSelectElement;
      const cur = state.cards[i] ?? { id: 0, level: 50 };
      state.cards[i] = cur.id ? { id: cur.id, level: Number(sel.value) } : null;
      onChange(state);
      return;
    }
    if (slotAttr !== null) return;
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

  /**
   * The reset button asks twice, and that is not politeness.
   *
   * It used to fire on one click, while being rendered as a white bar with
   * invisible text (a hard-coded `background: #fff` in a themed stylesheet). The
   * player clicked it to find out what it was and lost the deck he had just
   * entered -- six cards, typed by hand, gone with no undo and no warning. The
   * label now says what it does, the colour says it is destructive, and the
   * first click only arms it.
   */
  let armed: number | null = null;
  /** Cap values seen once and waiting for a second sighting -- see `setCaps`. */
  const pending: Partial<Record<Stat, number>> = {};
  host.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>("#set-reset");
    if (!btn) return;
    if (armed === null) {
      btn.classList.add("armed");
      btn.textContent = "Click again to discard this deck";
      armed = window.setTimeout(() => {
        armed = null;
        btn.classList.remove("armed");
        btn.textContent = "Discard this deck and load the captured career";
      }, 4000);
      return;
    }
    window.clearTimeout(armed);
    armed = null;
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
        if (typeof v !== "number" || v === state.statCaps[s]) { pending[s] = undefined; continue; }
        // A CHANGE IS TAKEN ON THE SECOND SIGHTING, IN EITHER DIRECTION.
        //
        // The first version accepted only increases, on the reasoning that caps
        // rise within a run and never fall. True, and it made the pane unable to
        // follow the player into a NEW career: he started one with a 1600 speed
        // cap while this held 1625 from the last one, and no amount of looking
        // at the right screen would ever have corrected it. A rule that cannot
        // be wrong about the direction is worth less than one that can be
        // corrected by the evidence.
        //
        // So the guard is repetition instead of direction. A cap that reads the
        // same on two consecutive syncs is what the screen says; a single odd
        // frame is discarded. This is the same two-frame agreement the stats
        // already use, and for the same reason -- one bad read used to be
        // permanent.
        if (pending[s] === v) { state.statCaps[s] = v; pending[s] = undefined; changed = true; }
        else pending[s] = v;
      }
      if (!changed) return false;
      render();
      onChange(state);
      return true;
    },
  };
}
