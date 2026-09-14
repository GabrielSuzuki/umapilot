/**
 * M3c, first slice: the per-turn panel over `plan()`.
 *
 * `interaction-design.md` settled how state gets in -- continuous passive
 * capture via getDisplayMedia, zero interactions a turn. That is layer three.
 * This is layer one, and it exists so the advice can be judged before any of
 * the capture work is built: if the recommendation does not read well typed in,
 * it will not read well captured either.
 *
 * WHAT THIS LEADS WITH is not the five facility gains. The game already prints
 * those, and a tool that reads them back is an expensive transcription device
 * (`interaction-design.md`). It leads with the three things the screen can never
 * say: what the turn is worth beyond the number on it, whether the build is
 * still on course, and what the shop is about to be able to afford.
 */
import { STATS, type Stat } from "../../data/src/types";
import { plan, type PlanResult } from "../../engine/src/planner";
import { EMPTY_TARGET, type RunTarget } from "../../engine/src/target";
import type { GcRunState } from "../../engine/src/scenarios/grand-concert";
import { loadDataset } from "./dataset";
import { defaultSetup, makeScenario, editableFrom, applyEditable, type Editable } from "./run";
import { imageFromFile, scanImage, applyScan, type ScanResult } from "./scan";
import { mountCapture, type TurnBoard } from "./capture";
import { assignPlacement, type ObservedKind } from "../../engine/src/placement";
import { mountSetup, loadStored, saveStored, storedFrom, setupFrom, type StoredSetup, type SetupPane } from "./setup";
import type { FrameReading } from "../../engine/src/vision/read";

const app = document.getElementById("app")!;
const paneAdvice = document.getElementById("pane-advice")!;
const paneCapture = document.getElementById("pane-capture")!;
const paneSetup = document.getElementById("pane-setup")!;
const maybe = loadDataset();
if ("error" in maybe) {
  paneAdvice.innerHTML = `<div class="err"><strong>No dataset.</strong><br>${maybe.error}</div>`;
  throw new Error(maybe.error);
}
const loaded = maybe;

/**
 * The run setup, and why the scenario is rebuilt rather than fixed.
 *
 * `defaultSetup()` is one captured career and was, until now, the only deck the
 * app could have. Changing a card changes what the engine IS -- rainbow
 * structure, friendship bonuses, the scenario-link count -- so the scenario
 * object is rebuilt from scratch on every edit rather than patched.
 */
const fallbackSetup = defaultSetup();
let stored: StoredSetup = loadStored() ?? storedFrom(fallbackSetup);
let setup = setupFrom(stored, loaded.supportCards);
if (setup.cards.length === 0) setup = fallbackSetup;   // empty deck: keep the app usable
let scenario = makeScenario(loaded.scenario, setup);
let edit: Editable = editableFrom(scenario.initialState());
let target: RunTarget = {
  ...EMPTY_TARGET,
  stats: { speed: 700, stamina: 300, power: 400, guts: 200, wit: 650 },
};

/** The last scan, so its result survives the re-render that follows it. */
let lastScan: ScanResult | null = null;

/**
 * The setup pane, held because BOTH ways into this app have caps to offer it.
 *
 * Declared up here rather than beside `mountSetup` because the drop handler and
 * the capture callback are both written before the pane is mounted, and both
 * push caps into it at runtime.
 */
let setupPane: SetupPane | null = null;

const num = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: 0 });
const esc = (s: string) =>
  s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

/**
 * P(every target met) for the recommended action.
 *
 * Never a bare percentage. It is a sampled estimate, so it carries its Wilson
 * interval and its sample count -- `planner/index.ts` makes that a rule, and a
 * UI that renders "62%" from 40 samples is exactly the false precision the rule
 * exists to prevent. At n=40 the interval is wide enough that seeing it is the
 * point.
 */
function goalLine(g?: { p: number; ci95: [number, number]; samples: number }): string {
  if (!g) return "";
  const pct = (x: number) => `${(100 * x).toFixed(0)}%`;
  const zero = g.ci95[1] < 0.005;
  return `<p class="goal">
    <span class="k">P(hitting every target)</span>
    <strong>${pct(g.p)}</strong>
    <span class="note">${pct(g.ci95[0])}–${pct(g.ci95[1])} at ${g.samples} samples${
      zero ? " · not one sample met every target, so this is an upper bound rather than a measurement" : ""
    }</span>
  </p>`;
}

function describe(a: { kind: string; facility?: Stat; companionCharaId?: number }): string {
  if (a.kind === "train") return `Train ${a.facility}`;
  if (a.kind === "recreation") return a.companionCharaId ? "Recreation (with a friend)" : "Recreation";
  return a.kind.charAt(0).toUpperCase() + a.kind.slice(1);
}

function render(r: PlanResult, state: GcRunState, ms: number) {
  const top = r.recommendations[0];
  const unreachable = (r.warning ?? "").includes("not projected to reach")
    ? (r.warning ?? "").split("The underlying simulator")[0]!.trim()
    : null;

  const outlook = r.outlook.map((o) => {
    const pct = Math.max(0, Math.min(1, o.projected / Math.max(1, o.want)));
    const cls = o.status === "on track" ? "ok" : o.status === "close" ? "close" : "no";
    return `<div class="out">
      <span>${o.stat}</span>
      <span class="bar"><i style="width:${(pct * 100).toFixed(0)}%"></i></span>
      <span class="n">${num(o.projected)} / ${num(o.want)} <span class="tag ${cls}">${o.status}</span></span>
    </div>`;
  }).join("");

  const alts = r.recommendations.slice(1, 5).map((rec) => `
    <div class="alt">
      <span>${esc(describe(rec.action as never))}</span>
      <span class="n">${rec.ev >= 0 ? "+" : ""}${rec.ev.toExponential(1)}</span>
      <span class="n">${rec.goalProbability ? (100 * rec.goalProbability.p).toFixed(0) + "%" : "—"}</span>
    </div>`).join("");

  const songs = r.songs.board.length
    ? r.songs.board.slice(0, 3).map((s) => `
        <div class="s">
          <div>${esc(s.name ?? String(s.id))}</div>
          <div class="meta">value ${s.value.toFixed(4)} ·
            ${s.deficitTotal === 0 ? "affordable now"
              : Number.isFinite(s.turnsToAfford) ? `~${s.turnsToAfford.toFixed(1)} turns away` : "unreachable at this income"}</div>
        </div>`).join("")
    : `<p class="note">The board is showing techniques, so there is no song to aim at.
       That is the honest answer rather than a gap: buying the techniques in front of
       you is also how the next song board is drawn.</p>`;

  paneAdvice.innerHTML = `
    <p class="sub">Turn ${state.turn} of ${scenario.careerTurns} · dataset ${loaded.sha} · advice in ${ms} ms</p>
    ${unreachable ? `<div class="banner">${esc(unreachable)}</div>` : ""}
    <div class="cols">
      <div>
        <section class="card">
          <h2>Read a screenshot</h2>
          <div id="drop" class="drop" tabindex="0">
            Drop a shot of the turn screen here, or click to choose one.
            <input id="file" type="file" accept="image/*" hidden />
          </div>
          <div id="scanout">${scanSummary()}</div>
        </section>
        <section class="card"><h2>This turn</h2><div id="editor"></div></section>
      </div>
      <div>
        <section class="card">
          <h2>Do this</h2>
          <div class="rec">
            <span class="what">${top ? esc(describe(top.action as never)) : "—"}</span>
            <span class="ev">${top ? `ev ${top.ev >= 0 ? "+" : ""}${top.ev.toExponential(2)}` : ""}</span>
            ${r.topIsClear ? "" : `<span class="tie">too close to call against the runner-up</span>`}
          </div>
          ${top ? `<p class="why">${esc(top.rationale)}</p>` : ""}
          ${goalLine(top?.goalProbability)}
          <div class="alts">
            <div class="alt" style="border-top:0"><span class="note">then</span><span class="n note">ev</span><span class="n note">P(goal)</span></div>
            ${alts}
          </div>
        </section>
        <section class="card">
          <h2>Is the build on course?</h2>
          ${outlook || `<p class="note">No stat targets set.</p>`}
          <p class="note" style="margin-top:10px">Projected from ${
            "" }rollouts of this exact state, not from a cap. "Not projected" means this
            model does not expect to get there — the captured career really did finish
            at 1635 Speed, so it is a statement about the model, not about the game.</p>
        </section>
        <section class="card songs">
          <h2>The shop</h2>${songs}
        </section>
        <details>
          <summary>What this is assuming (${r.assumptions.length})</summary>
          <ul>${r.assumptions.map((a) => `<li>${esc(a)}</li>`).join("")}</ul>
        </details>
      </div>
    </div>`;
  mountEditor();
  mountDrop();
}

/**
 * How much of this turn's board the click-through log has seen.
 *
 * Shown on the advice pane rather than only on the capture pane, because the
 * advice is what the player is reading when it matters: "computed from 2 of 5
 * facilities" and "computed from all 5" are very different claims about the
 * same recommendation, and the difference is entirely in his hands -- two more
 * clicks fix it.
 */
function boardSummary(): string {
  if (!lastBoard) return "";
  const { seen, ambiguous, unmatched } = lastBoard;
  const cls = seen === STATS.length ? "scanok" : "scanno";
  const caveats = [
    ambiguous ? `${ambiguous} card${ambiguous > 1 ? "s" : ""} could have been either of two of the same type` : "",
    unmatched ? `${unmatched} badge${unmatched > 1 ? "s" : ""} matched no card in your deck` : "",
  ].filter(Boolean);
  return `<p class="${cls}"><strong>Board:</strong> ${seen} of ${STATS.length} facilities
    seen this turn${seen < STATS.length ? " — click through the rest and this advice sharpens" : ""}.
    ${caveats.length ? esc(caveats.join("; ")) + "." : ""}</p>`;
}

/**
 * What the scan found, and -- the part that matters -- what it did not.
 *
 * The reader reads 77% of cross-validated fields and misreads one in 916, so a
 * scan is never
 * "your state is now correct". Listing the refusals by name is what makes the
 * remaining 28% visible work rather than an invisible gap: a field that was
 * left alone looks exactly like a field that was confirmed unless something
 * says otherwise.
 */
function scanSummary(): string {
  if (!lastScan && !lastBoard) return "";
  if (!lastScan) return boardSummary();
  if (!lastScan.ok) return `<p class="banner">${esc(lastScan.problem ?? "could not read that image")}</p>`;
  const lv = lastScan.facilityLevels ?? {};
  const levels = STATS.filter((s) => lv[s] !== undefined).map((s) => `${s} ${lv[s]}`);
  return `
    ${boardSummary()}
    <p class="note">Read in ${lastScan.ms.toFixed(0)} ms.</p>
    <p class="scanok"><strong>Took from the frame:</strong> ${esc(lastScan.filled.join(", ") || "nothing")}</p>
    ${lastScan.refused.length ? `<p class="scanno"><strong>Could not read, so left alone:</strong>
      ${esc(lastScan.refused.join(", "))}. These are refusals, not guesses — check them yourself.</p>` : ""}
    ${levels.length ? `<p class="note">Facility levels on screen: ${esc(levels.join(" · "))}.
      Not applied — levels belong to the run setup, not to this turn.</p>` : ""}
    ${lastScan.reading?.chipLevelsHidden ? `<p class="note">No chip printed a level, which is what
      summer camp looks like: the game hides them and shows Lvl 5 on the banner regardless of the
      real level. Nothing was read from that banner.</p>` : ""}`;
}

function mountDrop(): void {
  const zone = document.getElementById("drop");
  const input = document.getElementById("file") as HTMLInputElement | null;
  if (!zone || !input) return;

  const handle = async (file: File | undefined) => {
    if (!file) return;
    zone.classList.add("busy");
    try {
      const img = await imageFromFile(file);
      lastScan = scanImage(img);
      if (lastScan.ok && lastScan.reading) {
        edit = applyScan(edit, lastScan.reading);
        // A dropped screenshot carries the caps as surely as a live frame does,
        // and the caps move mid-run -- so the drop path offers them too rather
        // than leaving one of the two ways into this app on a stale ceiling.
        setupPane?.setCaps(lastScan.reading.statCaps);
      }
    } catch (e) {
      lastScan = { ok: false, problem: `could not decode that file: ${String(e)}`, filled: [], refused: [], ms: 0 };
    } finally {
      zone.classList.remove("busy");
    }
    recompute();
  };

  zone.addEventListener("click", () => input.click());
  zone.addEventListener("keydown", (e) => { if ((e as KeyboardEvent).key === "Enter") input.click(); });
  input.addEventListener("change", () => void handle(input.files?.[0]));
  zone.addEventListener("dragover", (e) => { e.preventDefault(); zone.classList.add("over"); });
  zone.addEventListener("dragleave", () => zone.classList.remove("over"));
  zone.addEventListener("drop", (e) => {
    e.preventDefault();
    zone.classList.remove("over");
    void handle((e as DragEvent).dataTransfer?.files?.[0]);
  });
}

/** A labelled <select>, for the fields that are a choice rather than a number. */
function choice(
  label: string, value: string, options: Array<[string, string]>, on: (v: string) => void,
) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const sel = document.createElement("select");
  for (const [v, text] of options) {
    const o = document.createElement("option");
    o.value = v; o.textContent = text; o.selected = v === value;
    sel.append(o);
  }
  sel.addEventListener("change", () => on(sel.value));
  return [wrap, sel] as const;
}

function field(label: string, value: number, on: (v: number) => void, min = 0, max = 9999) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement("input");
  input.type = "number"; input.value = String(Math.round(value));
  input.min = String(min); input.max = String(max);
  input.addEventListener("change", () => on(Number(input.value)));
  return [wrap, input] as const;
}

/**
 * Redraw the editor, unless the player is inside it.
 *
 * The capture pane writes `placement` into `edit`, and a set of dropdowns that
 * disagrees with what the planner is using is worse than no dropdowns. But a
 * redraw while a field has focus is how the turn picker became unusable, so the
 * rule is the same one: never while someone is in there.
 */
function syncEditor(): void {
  const host = document.getElementById("editor");
  if (!host || host.contains(document.activeElement)) return;
  mountEditor();
}

function mountEditor() {
  const host = document.getElementById("editor");
  if (!host) return;
  const g = document.createElement("div");
  g.className = "grid";
  const add = (l: string, v: number, on: (n: number) => void, min = 0, max = 9999) => {
    const [a, b] = field(l, v, (n) => { on(n); recompute(); }, min, max);
    g.append(a, b);
  };
  add("Turn", edit.turn, (n) => (edit.turn = n), 1, scenario.careerTurns);
  add("Energy", edit.energy, (n) => (edit.energy = n), 0, 100);
  add("Mood (−2…2)", edit.mood, (n) => (edit.mood = n), -2, 2);
  add("Skill points", edit.skillPoints, (n) => (edit.skillPoints = n));
  const hr = document.createElement("div"); hr.className = "hr"; hr.style.gridColumn = "1 / -1";
  g.append(hr);
  for (const s of STATS) add(s, edit.stats[s], (n) => (edit.stats[s] = n), 0, 2000);
  const hr2 = document.createElement("div"); hr2.className = "hr"; hr2.style.gridColumn = "1 / -1";
  g.append(hr2);
  edit.bonds.forEach((b, i) => {
    const c = setup.cards[i];
    add(`bond · ${c?.stat ?? "friend"}`, b, (n) => (edit.bonds[i] = n), 0, 100);
  });

  /*
   * WHERE THE CARDS ARE STANDING THIS TURN.
   *
   * The engine re-rolls this every turn, so before this existed the advice was
   * computed against a board the game never showed -- and rainbow is the largest
   * multiplier there is, so on any given turn that is not a detail, it is most
   * of the answer. "Seems to always recommend speed regardless of friendship
   * training" is what an engine that cannot see the board says.
   *
   * Six selects is more clicking than anyone wants every turn, and that is the
   * argument for the click-through capture rather than for guessing on the
   * player's behalf.
   */
  const hrP = document.createElement("div"); hrP.className = "hr"; hrP.style.gridColumn = "1 / -1";
  g.append(hrP);
  const note = document.createElement("p");
  note.className = "note"; note.style.gridColumn = "1 / -1"; note.style.margin = "0 0 2px";
  note.textContent = "Which facility is each card on this turn? This is what decides rainbow, "
    + "and the engine can only guess it.";
  g.append(note);
  const where: Array<[string, string]> = [
    ["", "— not out —"], ...STATS.map((s2) => [s2, s2] as [string, string]),
  ];
  setup.cards.forEach((c, i) => {
    const [a, b] = choice(
      `on · ${c.stat ?? "friend"}`,
      edit.placement[i] ?? "",
      where,
      (v) => { edit.placement[i] = (v || null) as Stat | null; recompute(); },
    );
    g.append(a, b);
  });

  /*
   * WHAT THE LESSON BOARD IS SHOWING.
   *
   * Same problem, smaller: the board is rolled, so the shop panel was answering
   * "what should I buy" about three offers the player is not looking at. "The
   * shop isn't working" was the report, and it was working perfectly against
   * the wrong board.
   */
  const hrB = document.createElement("div"); hrB.className = "hr"; hrB.style.gridColumn = "1 / -1";
  g.append(hrB);
  const songOpts: Array<[string, string]> = [
    ["", "— techniques —"],
    ...[...loaded.scenario.songs]
      .sort((x, y) => x.name.localeCompare(y.name))
      .map((so) => [String(so.id), so.name] as [string, string]),
  ];
  for (let slot = 0; slot < 3; slot++) {
    const cur = edit.offers?.[slot];
    const [a, b] = choice(`board ${slot + 1}`, cur === undefined ? "" : String(cur), songOpts, (v) => {
      const next = [...(edit.offers ?? [])];
      if (v) next[slot] = Number(v); else next.splice(slot, 1);
      edit.offers = next.filter((n) => Number.isFinite(n)).length ? next : null;
      recompute();
    });
    g.append(a, b);
  }
  const hr3 = document.createElement("div"); hr3.className = "hr"; hr3.style.gridColumn = "1 / -1";
  g.append(hr3);
  for (const s of STATS) {
    add(`target ${s}`, target.stats[s] ?? 0, (n) => {
      target = { ...target, stats: { ...target.stats, [s]: n > 0 ? n : null } };
    }, 0, 2000);
  }
  host.replaceChildren(g);
}

function recompute() {
  app.classList.add("busy");
  // A TIMEOUT, NOT requestAnimationFrame. The whole point of the capture pane
  // is that the player is looking at the GAME, not at this window -- and rAF is
  // throttled or suspended when the page is not being painted. Advice that only
  // recomputes while you are watching it recompute is no use to someone playing
  // on the other monitor.
  setTimeout(() => {
    const base = scenario.initialState();
    const state = applyEditable(base, edit);
    const t0 = performance.now();
    const r = plan(scenario, state, target, {
      width: 8, horizon: 3, worlds: 3,
      shadowSamples: 3, probabilitySamples: 40, probabilityFor: 3,
      seed: 1,
    });
    render(r, state, Math.round(performance.now() - t0));
    app.classList.remove("busy");
  }, 0);
}

/**
 * Tabs, and why the capture pane is mounted once and merely hidden.
 *
 * `render()` rewrites the advice pane on every recompute. The capture pane owns
 * a live MediaStream, a video element and a canvas, so rebuilding it would drop
 * the stream -- and re-acquiring one costs the player another permission
 * prompt. So the two panes are siblings, the advice pane is the only thing
 * re-rendered, and switching tabs toggles `hidden` and nothing else. The
 * capture loop keeps running while the player reads the advice, which is the
 * behaviour you want anyway: the game does not pause to be looked at.
 */
const tabs = document.getElementById("tabs")!;
tabs.addEventListener("click", (e) => {
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(".tab");
  if (!btn) return;
  const want = btn.dataset.pane;
  for (const t of tabs.querySelectorAll<HTMLButtonElement>(".tab")) {
    t.classList.toggle("on", t === btn);
  }
  paneAdvice.hidden = want !== "advice";
  paneCapture.hidden = want !== "capture";
  paneSetup.hidden = want !== "setup";
});

/**
 * What the capture pane hands back.
 *
 * Only the fields the reader actually read: `applyScan` leaves everything else
 * alone, so a frame it could not fully read does not blank the numbers the
 * player typed. Facility levels are read but deliberately not applied -- they
 * belong to the run setup rather than to this turn.
 */
/** What the click-through log last said, so the advice pane can show it. */
let lastBoard: { seen: number; ambiguous: number; unmatched: number } | null = null;

function applyFromCapture(
  r: FrameReading, turn: number | null, focus: boolean, board: TurnBoard,
): void {
  edit = applyScan(edit, r);
  const readSomething = r.skillPts !== undefined || STATS.some((s) => r.stats[s] !== undefined);

  /*
   * THE CLICK-THROUGH LOG BECOMES THE PLACEMENT.
   *
   * This is the point of the whole capture pane. The player clicks through the
   * five facilities before deciding -- he was doing that anyway -- and each
   * screen shows which support cards are standing there. Collected, that is
   * `placement`, which the engine was otherwise rolling dice for and which
   * decides where rainbow is. Nothing here asks him to do anything he was not
   * already doing.
   */
  const observed: Partial<Record<Stat, ObservedKind[]>> = {};
  for (const s of STATS) {
    const slots = board[s];
    if (slots) observed[s] = slots.map((z) => z.kind ?? null);
  }
  if (Object.keys(observed).length > 0) {
    const got = assignPlacement({ cards: setup.cards, observed, previous: edit.placement });
    const moved = got.placement.some((x, i) => x !== edit.placement[i]);
    edit.placement = got.placement;
    lastBoard = { seen: got.seen.length, ambiguous: got.ambiguous, unmatched: got.unmatched.length };
    // Keep the dropdowns honest about what the planner is actually using --
    // but never redraw the editor out from under someone typing in it, which
    // is the bug the turn picker had.
    if (moved) syncEditor();
  }
  // THE CAPS ARE NOT CONSTANT. They were treated as a per-run number read once
  // off Legacy Select until the cap row was read on all 58 captured training
  // frames: speed 1625 -> 1630 -> 1635, stamina 1332 -> 1336 -> 1342, power
  // 1332 -> 1337 -> 1343, raised by the inheritance events on turns 30 and 54. So every
  // frame offers its caps to the setup, which takes them only when they rise
  // and only then pays for a scenario rebuild.
  setupPane?.setCaps(r.statCaps);
  // The turn is the one field the scan path deliberately never set, because
  // `turnsLeft` on the screen counts to the next GOAL and is not the career
  // position. The capture pane derives the real turn from the concert
  // countdown, and without it the planner solves the wrong problem: on the
  // frame that exposed this it believed 71 turns remained when 38 did.
  if (turn !== null) edit.turn = turn;
  // Only report a scan that read something. A frame the reader declined whole
  // used to overwrite the last good report with six refusals, so the advice
  // pane's standing message was "Took from the frame: nothing" even when the
  // numbers beside it had just been filled in correctly from an earlier frame.
  if (!readSomething) { recompute(); return; }
  lastScan = {
    ok: true,
    filled: [
      ...(r.skillPts !== undefined ? ["skill points"] : []),
      ...STATS.filter((s) => r.stats[s] !== undefined),
    ],
    refused: [
      ...(r.skillPts === undefined ? ["skill points"] : []),
      ...STATS.filter((s) => r.stats[s] === undefined),
    ],
    ms: 0,
    reading: r,
  };
  if (focus) (tabs.querySelector<HTMLButtonElement>('.tab[data-pane="advice"]'))?.click();
  recompute();
}

mountCapture(paneCapture, applyFromCapture);

/**
 * Rebuilding on a setup change keeps the turn state the player has entered.
 *
 * A new deck does not mean a new turn, new stats or a new target -- it means
 * the same situation evaluated against a different run. Resetting the editable
 * fields on every card change would make the setup pane unusable, because
 * entering six cards would wipe the state six times.
 */
setupPane = mountSetup(paneSetup, loaded.supportCards, stored, (next) => {
  stored = next;
  saveStored(next);
  const rebuilt = setupFrom(next, loaded.supportCards);
  if (rebuilt.cards.length === 0) return;             // mid-edit, not yet a deck
  setup = rebuilt;
  scenario = makeScenario(loaded.scenario, setup);
  recompute();
});

recompute();
