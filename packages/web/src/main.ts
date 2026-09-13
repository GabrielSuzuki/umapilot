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
import { mountCapture } from "./capture";
import type { FrameReading } from "../../engine/src/vision/read";

const app = document.getElementById("app")!;
const paneAdvice = document.getElementById("pane-advice")!;
const paneCapture = document.getElementById("pane-capture")!;
const maybe = loadDataset();
if ("error" in maybe) {
  paneAdvice.innerHTML = `<div class="err"><strong>No dataset.</strong><br>${maybe.error}</div>`;
  throw new Error(maybe.error);
}
const loaded = maybe;

const setup = defaultSetup();
const scenario = makeScenario(loaded.scenario, setup);
let edit: Editable = editableFrom(scenario.initialState());
let target: RunTarget = {
  ...EMPTY_TARGET,
  stats: { speed: 700, stamina: 300, power: 400, guts: 200, wit: 650 },
};

/** The last scan, so its result survives the re-render that follows it. */
let lastScan: ScanResult | null = null;

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
 * What the scan found, and -- the part that matters -- what it did not.
 *
 * The reader reads 72% of fields and misreads none of them, so a scan is never
 * "your state is now correct". Listing the refusals by name is what makes the
 * remaining 28% visible work rather than an invisible gap: a field that was
 * left alone looks exactly like a field that was confirmed unless something
 * says otherwise.
 */
function scanSummary(): string {
  if (!lastScan) return "";
  if (!lastScan.ok) return `<p class="banner">${esc(lastScan.problem ?? "could not read that image")}</p>`;
  const lv = lastScan.facilityLevels ?? {};
  const levels = STATS.filter((s) => lv[s] !== undefined).map((s) => `${s} ${lv[s]}`);
  return `
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
      if (lastScan.ok && lastScan.reading) edit = applyScan(edit, lastScan.reading);
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

function field(label: string, value: number, on: (v: number) => void, min = 0, max = 9999) {
  const wrap = document.createElement("label");
  wrap.textContent = label;
  const input = document.createElement("input");
  input.type = "number"; input.value = String(Math.round(value));
  input.min = String(min); input.max = String(max);
  input.addEventListener("change", () => on(Number(input.value)));
  return [wrap, input] as const;
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
});

/**
 * What the capture pane hands back.
 *
 * Only the fields the reader actually read: `applyScan` leaves everything else
 * alone, so a frame it could not fully read does not blank the numbers the
 * player typed. Facility levels are read but deliberately not applied -- they
 * belong to the run setup rather than to this turn.
 */
function applyFromCapture(r: FrameReading, focus: boolean): void {
  edit = applyScan(edit, r);
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

recompute();
