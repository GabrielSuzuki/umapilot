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
  onApply: (reading: FrameReading) => void,
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
    </p>
    <div id="cap-status"></div>
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
    timer = window.setInterval(() => void tick(), 500);
  }

  function stop(): void {
    if (timer !== null) { clearInterval(timer); timer = null; }
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    startBtn.hidden = false; stopBtn.hidden = true; applyBtn.hidden = true;
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
      ...STATS.map((s) => row(`${s} lvl`, r.facilityLevels[s])),
      r.chipLevelsHidden
        ? `<p class="note">No chip printed a level — this is what summer camp looks like.</p>` : "",
    ].join("");
  }

  startBtn.addEventListener("click", () => void start());
  stopBtn.addEventListener("click", () => stop());
  applyBtn.addEventListener("click", () => { if (lastReading) onApply(lastReading); });

  const handle: CaptureHandle = { stop };
  mounted.set(host, handle);
  return handle;
}
