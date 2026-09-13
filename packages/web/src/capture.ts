/**
 * Watching the game live, as a pane inside the app.
 *
 * `getDisplayMedia` is the same capability OBS uses -- one permission prompt,
 * pick a window or screen, get a live MediaStream. No install, no recording, no
 * process attached to the game, and the frames never leave the page.
 *
 * This is a MOUNTABLE pane rather than its own page, because the reason to
 * watch the game is to feed the planner, and a separate page can only tell the
 * player what it saw. Sharing one app means the state it reads can be pushed
 * straight into the turn advice.
 *
 * It owns its own DOM inside the host element and keeps its stream across tab
 * switches -- hiding a pane must not cost a permission prompt to get back.
 */
import { STATS } from "../../data/src/types";
import { findPanel, probeScreen } from "../../engine/src/vision/classify";
import { cropImage } from "../../engine/src/vision/layout";
import { readFrame, type FrameReading } from "../../engine/src/vision/read";
import { meanLuma, lumaStdDev, type Box } from "../../engine/src/vision/image";
import { turnCandidates, resolveTurn, calendarFor } from "../../engine/src/vision/turn";

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

export interface CaptureHandle {
  /** Stop the stream and the frame loop. */
  stop(): void;
}

/**
 * Mounted panes, so a second call cannot destroy a live stream.
 *
 * This is a guard against a specific mistake that already happened: a
 * search-and-replace put `mountCapture` inside an editor field's change
 * handler, so every keystroke in the advice pane rebuilt this one and dropped
 * the capture. It type-checked, because a nested function call and a
 * re-registered listener are both perfectly legal -- the damage was only
 * visible as "the recording UI goes back to its original state".
 *
 * Making a second mount a no-op rather than a teardown means the failure mode
 * is now a missing update rather than a lost permission grant. Cheap, and it
 * turns an invisible bug into an inert one.
 */
const mounted = new WeakMap<HTMLElement, CaptureHandle>();

export function mountCapture(
  host: HTMLElement,
  /**
   * Hand a reading to the planner. `focus` is true only when the player asked
   * for it by pressing the button -- an automatic sync must never yank them to
   * another tab while they are looking at the game.
   */
  onApply: (reading: FrameReading, turn: number | null, focus: boolean) => void,
): CaptureHandle {
  const already = mounted.get(host);
  if (already) return already;

  host.innerHTML = `
    <p class="sub">
      Share the Umamusume window and this reads it live, about twice a second.
      Nothing is recorded and nothing leaves the page.
    </p>
    <p>
      <button id="cap-start" class="go">Share the game window</button>
      <button id="cap-stop" class="go" hidden>Stop</button>
      <button id="cap-apply" class="go" hidden>Use this state in Turn advice</button>
      <button id="cap-save" class="go" hidden>Save this frame</button>
      <label class="inline"><input type="checkbox" id="cap-auto" checked />
        keep Turn advice in sync</label>
    </p>
    <div id="cap-status"></div>
    <div id="cap-turn"></div>
    <div class="cols">
      <div><section class="card"><h2>What it reads</h2><div id="cap-read"></div></section></div>
      <div><section class="card"><h2>The frame</h2><canvas id="cap-preview"></canvas></section></div>
    </div>`;

  const startBtn = host.querySelector<HTMLButtonElement>("#cap-start")!;
  const stopBtn = host.querySelector<HTMLButtonElement>("#cap-stop")!;
  const applyBtn = host.querySelector<HTMLButtonElement>("#cap-apply")!;
  const statusEl = host.querySelector<HTMLElement>("#cap-status")!;
  const readEl = host.querySelector<HTMLElement>("#cap-read")!;
  const preview = host.querySelector<HTMLCanvasElement>("#cap-preview")!;
  const autoBox = host.querySelector<HTMLInputElement>("#cap-auto")!;
  const turnEl = host.querySelector<HTMLElement>("#cap-turn")!;
  const saveBtn = host.querySelector<HTMLButtonElement>("#cap-save")!;
  /** Whether `work` currently holds a frame worth saving. */
  let lastFrame = false;

  /** What was last pushed to the planner, and when -- see the sync rule below. */
  let lastSyncSig = "";
  let lastSyncAt = 0;

  const video = document.createElement("video");
  video.muted = true; video.playsInline = true;
  const work = document.createElement("canvas");

  let stream: MediaStream | null = null;
  let timer: number | null = null;
  let frames = 0, panelsFound = 0, blackFrames = 0;
  let lastReading: FrameReading | null = null;

  /**
   * The located panel, kept between frames.
   *
   * Searching every frame was wrong twice over. It cost ~300 ms of a 500 ms
   * budget, and it let the answer MOVE: the game window does not wander during
   * a session, but the search is a scored guess and a scored guess can land
   * differently on two frames of the same scene. Locking it means the panel is
   * decided once and every later read is against the same pixels.
   */
  let locked: Box | null = null;
  let lockMisses = 0;
  const RELOCK_AFTER = 12;

  /**
   * A short majority vote on the selected facility.
   *
   * Per frame the reader is right or it is nothing; across frames it can still
   * flicker while the game animates a chip sliding up. A second of latency on a
   * turn that lasts as long as the player takes to think is a good trade for
   * the difference between a log entry and a log of twitches.
   *
   * It lives here and not in the reader: temporal smoothing belongs to the
   * thing watching a stream, not to the thing reading a picture.
   */
  const recent: Array<string | undefined> = [];

  /**
   * The last level seen for each facility, carried between frames.
   *
   * The reader refuses the SELECTED chip's level on purpose: the game paints an
   * animated sparkle over it, and a holed glyph matches a different digit
   * rather than failing loudly (0028). Per frame that refusal is right. Across
   * a stream it is needlessly lossy, because a facility level does not change
   * while the player is looking at it -- it changes on the fourth use of that
   * facility, between turns.
   *
   * So the level read while a chip was NOT selected is still true when it
   * becomes selected, and remembering it costs nothing. It is shown marked, so
   * a carried value is never mistaken for something read from the frame in
   * front of you.
   */
  const rememberedLevels = new Map<string, number>();

  /**
   * The career turn, once known, and the frames still needed to confirm a read.
   *
   * TWO FRAMES MUST AGREE BEFORE ANYTHING IS PUSHED. A one-shot scan can afford
   * to trust a confident read, because the player is looking at the result. A
   * stream cannot: `applyScan` only overwrites the fields it managed to read, so
   * a single bad value is permanent -- later frames that REFUSE that field never
   * correct it. That is exactly what happened: one frame read speed as 1600,
   * every frame after it declined to read speed at all, and the planner carried
   * 1600 for the rest of the session.
   *
   * Agreement across two frames is cheap here because a stat only changes when a
   * turn is taken, so the true value is on screen for many frames, while a
   * misread is a one-off artefact of compression or animation.
   */
  let knownTurn: number | null = null;
  let pendingSig = "";
  let pendingCount = 0;
  function vote(v: string | undefined): string | undefined {
    recent.push(v);
    if (recent.length > 5) recent.shift();
    const counts = new Map<string, number>();
    for (const s of recent) if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
    let best: string | undefined, n = 0;
    for (const [k, c] of counts) if (c > n) { n = c; best = k; }
    return n >= 2 ? best : undefined;
  }

  async function start(): Promise<void> {
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 4, max: 10 } }, audio: false,
      });
    } catch (e) {
      statusEl.innerHTML = `<div class="banner">Could not start capture: ${esc(String(e))}</div>`;
      return;
    }
    video.srcObject = stream;
    await video.play();
    stream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
    startBtn.hidden = true; stopBtn.hidden = false;
    frames = 0; panelsFound = 0; blackFrames = 0;
    locked = null; lockMisses = 0; recent.length = 0;
    knownTurn = null; pendingSig = ""; pendingCount = 0;
    timer = window.setInterval(() => void tick(), 500);
  }

  function stop(): void {
    if (timer !== null) { clearInterval(timer); timer = null; }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    startBtn.hidden = false; stopBtn.hidden = true; applyBtn.hidden = true;
    saveBtn.hidden = true; lastFrame = false;
  }

  async function tick(): Promise<void> {
    const w = video.videoWidth, h = video.videoHeight;
    if (!w || !h) return;
    frames++;

    work.width = w; work.height = h;
    const ctx = work.getContext("2d", { willReadFrequently: true });
    if (!ctx) { statusEl.innerHTML = `<div class="banner">No 2d canvas context.</div>`; return; }
    ctx.drawImage(video, 0, 0, w, h);
    const img = ctx.getImageData(0, 0, w, h);
    lastFrame = true; saveBtn.hidden = false;

    // A capture that is not working is uniformly black; a dark game scene has
    // variation. Checking brightness alone would confuse the two, which are
    // opposite problems.
    const luma = meanLuma(img, { x0: 0, y0: 0, x1: w, y1: h });
    const spread = lumaStdDev(img, { x0: 0, y0: 0, x1: Math.min(w, 400), y1: Math.min(h, 400) });
    const black = luma < 4 && spread < 2;
    if (black) blackFrames++;

    const t0 = performance.now();
    let box = locked, relocated = false;
    if (box) {
      // A miss is usually a menu or a race, which is normal -- so the lock
      // survives a run of them rather than being dropped on the first.
      if (probeScreen(cropImage(img, box)).kind === "training") lockMisses = 0;
      else if (++lockMisses >= RELOCK_AFTER) { locked = null; box = null; }
    }
    if (!box) {
      const found = findPanel(img);
      if (found) { locked = found.box; box = found.box; lockMisses = 0; relocated = true; }
    }
    const ms = performance.now() - t0;
    if (box) panelsFound++;

    const scale = Math.min(1, 380 / w);
    preview.width = Math.round(w * scale); preview.height = Math.round(h * scale);
    const pctx = preview.getContext("2d");
    if (pctx) {
      pctx.drawImage(video, 0, 0, preview.width, preview.height);
      if (box) {
        pctx.strokeStyle = relocated ? "#e90" : "#3a7"; pctx.lineWidth = 2;
        pctx.strokeRect(box.x0 * scale, box.y0 * scale,
          (box.x1 - box.x0) * scale, (box.y1 - box.y0) * scale);
      }
    }

    statusEl.innerHTML = `<p class="note">
        frame ${w}&times;${h} &middot; ${frames} frames &middot;
        panel on ${panelsFound}/${frames} &middot;
        ${locked ? `locked at x=${locked.x0}` : "searching"} &middot; ${ms.toFixed(0)} ms
      </p>
      ${black ? `<div class="banner"><strong>Frames are coming through BLACK.</strong>
        Brightness ${luma.toFixed(1)}, variation ${spread.toFixed(1)} — that is a capture not
        seeing the game rather than a dark scene. ${blackFrames} of ${frames} frames so far.
        Try sharing the whole screen instead of the window, or running the game
        borderless-windowed rather than exclusive fullscreen.</div>` : ""}
      ${!box && !black ? `<p class="note">Frames are arriving, but no training screen in this one —
        expected on menus, races and dialogs.</p>` : ""}`;

    if (!box) {
      readEl.innerHTML = `<p class="note">Waiting for a training screen.</p>`;
      applyBtn.hidden = true;
      return;
    }

    const r = readFrame(cropImage(img, box));
    lastReading = r;
    const voted = vote(r.selected);
    applyBtn.hidden = false;
    for (const s2 of STATS) {
      const lv = r.facilityLevels[s2];
      if (lv !== undefined) rememberedLevels.set(s2, lv);
    }

    // AUTO-SYNC. The player asked for something that watches the game, and a
    // button they have to press is not that. But `plan()` costs hundreds of
    // milliseconds and blocks the thread, so it cannot run at capture rate.
    // Both constraints are satisfied by syncing on CHANGE rather than on
    // frames: the stats only move when a turn is taken, so a material change is
    // rare, and rate-limiting it stops a flickering read from thrashing the
    // search.
    const sig = STATS.map((s2) => r.stats[s2] ?? "-").join(",") + "|" + (r.skillPts ?? "-")
      + "|" + (r.concertIn ?? "-");
    if (sig === pendingSig) pendingCount++; else { pendingSig = sig; pendingCount = 1; }

    if (r.concertIn !== undefined) {
      const resolved = resolveTurn(r.concertIn, knownTurn);
      if (resolved !== null) knownTurn = resolved;
    }
    renderTurn(r);

    if (autoBox.checked && pendingCount >= 2) {
      const now = performance.now();
      if (sig !== lastSyncSig && now - lastSyncAt > 3000) {
        lastSyncSig = sig; lastSyncAt = now;
        onApply(r, knownTurn, false);
      }
    }

    const row = (k: string, v: unknown) =>
      `<div class="out"><span>${k}</span><span class="n">${v === undefined ? "—" : esc(String(v))}</span></div>`;
    readEl.innerHTML = [
      row("screen", r.screen.kind),
      row("selected", voted),
      row("selected (this frame)", r.selected),
      row("turns left", r.turnsLeft),
      row("concert in", r.concertIn),
      row("skill points", r.skillPts),
      ...STATS.map((s) => row(s, r.stats[s])),
      ...STATS.map((s) => {
        const live = r.facilityLevels[s];
        if (live !== undefined) return row(`${s} lvl`, live);
        const kept = rememberedLevels.get(s);
        return row(`${s} lvl`, kept === undefined ? undefined : `${kept} (remembered)`);
      }),
      r.chipLevelsHidden
        ? `<p class="note">No chip printed a level — this is what summer camp looks like.</p>` : "",
    ].join("");
  }

  /**
   * The turn, and the one question this pane ever asks.
   *
   * The concert countdown names five possible turns and nothing on screen
   * separates them, so the first reading is genuinely ambiguous. Rather than
   * guess -- the failure that put the planner on turn 1 while the player was on
   * turn 34 -- it offers the five calendars the game itself prints and takes one
   * click. After that the career is tracked forward and it never asks again.
   */
  /**
   * What the turn panel currently shows, so it is not rebuilt twice a second.
   *
   * `renderTurn` used to rewrite its own innerHTML on every frame. The panel
   * contains a `<select>` of all 72 turns, and a select that is destroyed and
   * recreated every ~500 ms cannot be used at all: the dropdown closes under the
   * player's cursor before he can scroll it. He reported it as "the which turn
   * are you on does not function since I am kicked out of it every update",
   * which is exactly what it was.
   *
   * The fix is to redraw only when the answer would differ -- the panel's whole
   * content is a function of the known turn and the concert countdown, and both
   * hold still for a whole turn at a time.
   */
  let turnSig = "";

  function renderTurn(r: FrameReading, force = false): void {
    // A rebuild while the player is inside the control is the bug itself, so it
    // is refused outright even if the signature moved. `force` is the one
    // exception: answering the question is the moment the panel MUST redraw,
    // and the control the player just used still has focus.
    if (!force && turnEl.contains(document.activeElement)) return;
    const sig = `${knownTurn ?? ""}|${r.concertIn ?? ""}`;
    if (sig === turnSig && !force) return;
    turnSig = sig;
    if (knownTurn !== null) {
      turnEl.innerHTML = `<p class="note">Career turn <strong>${knownTurn}</strong> &mdash;
        ${esc(calendarFor(knownTurn))}, ${72 - knownTurn} turns left in the career.</p>`;
      return;
    }
    // ALWAYS OFFER A WAY IN. The countdown is refused on plenty of frames, and
    // the first version of this left the player staring at "waiting to read the
    // concert countdown" with nothing to click -- blocked by a field they can
    // see perfectly well themselves. The candidates narrow the choice when the
    // countdown is readable; the full list is there when it is not.
    const cands = r.concertIn === undefined ? [] : turnCandidates(r.concertIn);
    const opts = (cands.length ? cands : [])
      .map((t) => `<button class="go pick" data-turn="${t}">${esc(calendarFor(t))}</button>`)
      .join(" ");
    const all = Array.from({ length: 72 }, (_, i) => i + 1)
      .map((t) => `<option value="${t}">${t} — ${esc(calendarFor(t))}</option>`).join("");
    turnEl.innerHTML = `<div class="banner">
      <strong>Which turn are you on?</strong>
      ${cands.length
        ? `The concert is ${r.concertIn} turns away, which is true on ${cands.length} turns.`
        : `The concert countdown was not readable on this frame, so pick it yourself.`}
      One answer and the career is tracked from here on.
      ${opts ? `<br>${opts}` : ""}
      <br><label class="inline">or choose:
        <select id="cap-turnpick"><option value="">—</option>${all}</select></label>
    </div>`;
  }

  const setTurn = (t: number): void => {
    knownTurn = t;
    (document.activeElement as HTMLElement | null)?.blur();
    if (lastReading) { renderTurn(lastReading, true); onApply(lastReading, knownTurn, false); }
  };
  turnEl.addEventListener("click", (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>(".pick");
    if (b) setTurn(Number(b.dataset.turn));
  });
  turnEl.addEventListener("change", (e) => {
    const sel = e.target as HTMLSelectElement;
    if (sel.id === "cap-turnpick" && sel.value) setTurn(Number(sel.value));
  });

  /**
   * Save the exact bytes the reader just saw.
   *
   * Everything about this module was built and calibrated against lossless
   * PNGs, and the live path has behaved differently in ways I have not been
   * able to reproduce offline -- JPEG artefacts and 4:2:0 chroma subsampling
   * were both simulated against the corpus and neither accounts for it. Rather
   * than keep guessing at what a captured frame looks like, this writes one
   * out: the full frame, and the cropped panel exactly as `readFrame` received
   * it, so the two can be compared against the same code.
   *
   * Nothing is uploaded. It is a download, to the player's own disk.
   */
  function saveFrame(): void {
    if (!lastFrame) return;
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const put = (canvas: HTMLCanvasElement, name: string) => {
      canvas.toBlob((blob) => {
        if (!blob) return;
        const a = document.createElement("a");
        a.href = URL.createObjectURL(blob);
        a.download = name;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
      }, "image/png");
    };
    put(work, `umapilot-frame-${stamp}.png`);
    if (locked) {
      const c = document.createElement("canvas");
      c.width = locked.x1 - locked.x0; c.height = locked.y1 - locked.y0;
      const cc = c.getContext("2d");
      if (cc) {
        cc.drawImage(work, locked.x0, locked.y0, c.width, c.height, 0, 0, c.width, c.height);
        put(c, `umapilot-panel-${stamp}.png`);
      }
    }
  }

  saveBtn.addEventListener("click", saveFrame);
  startBtn.addEventListener("click", () => void start());
  stopBtn.addEventListener("click", () => stop());
  applyBtn.addEventListener("click", () => { if (lastReading) onApply(lastReading, knownTurn, true); });

  const handle: CaptureHandle = { stop };
  mounted.set(host, handle);
  return handle;
}
