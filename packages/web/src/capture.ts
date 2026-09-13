/**
 * Layer 3, first slice: is the game visible to the browser at all?
 *
 * `getDisplayMedia` is the same capability OBS uses -- one permission prompt,
 * pick a window or screen, get a live MediaStream. No install, no recording, no
 * process attached to the game, and the frames never leave the page.
 *
 * WHY THIS EXISTS BEFORE THE CAPTURE LOOP. Some games render through a path
 * that screen capture returns as solid black, and it is not predictable from
 * the outside: a PrtScn screenshot can succeed on a window that
 * `getDisplayMedia` shows as black, because they are different mechanisms. If
 * that is the case here, the whole of layer 3 needs a different design -- a
 * virtual camera, or a native helper -- and it is much cheaper to find that out
 * from a page that does nothing else than from one with a turn log built into
 * it.
 *
 * So this reports the three things that decide it: whether frames arrive,
 * whether they are black, and whether `findPanel` and `readFrame` handle a live
 * frame the way they handle a screenshot.
 */
import { STATS } from "../../data/src/types";
import { findPanel, probeScreen } from "../../engine/src/vision/classify";
import { cropImage } from "../../engine/src/vision/layout";
import { readFrame } from "../../engine/src/vision/read";
import { meanLuma, lumaStdDev } from "../../engine/src/vision/image";

const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const statusEl = document.getElementById("status")!;
const readEl = document.getElementById("read")!;
const preview = document.getElementById("preview") as HTMLCanvasElement;

const video = document.createElement("video");
video.muted = true;
video.playsInline = true;

const work = document.createElement("canvas");
let stream: MediaStream | null = null;
let timer: number | null = null;
let frames = 0, panelsFound = 0, blackFrames = 0;

/**
 * The located panel, kept between frames.
 *
 * Searching every frame was wrong twice over. It cost ~300ms of a 500ms budget,
 * and it let the answer MOVE: the game window does not wander during a session,
 * but the search is a scored guess and a scored guess can land differently on
 * two frames of the same scene. Locking it means the panel is decided once and
 * every later read is against the same pixels.
 *
 * Re-searched only after several consecutive frames fail to verify -- one
 * failure is a menu or a race, which is normal and must not throw the lock
 * away.
 */
let locked: { x0: number; y0: number; x1: number; y1: number } | null = null;
let lockMisses = 0;
const RELOCK_AFTER = 12;

/**
 * The last few selections, for a majority vote.
 *
 * Per-frame the reader is right or it is nothing; across frames it can still
 * flicker while the game animates a chip sliding up. A short vote costs a
 * second of latency on a turn that lasts as long as the player takes to think,
 * and it is the difference between a log entry and a log of twitches.
 */
const recentSelected: Array<string | undefined> = [];
function voteSelected(v: string | undefined): string | undefined {
  recentSelected.push(v);
  if (recentSelected.length > 5) recentSelected.shift();
  const counts = new Map<string, number>();
  for (const s of recentSelected) if (s) counts.set(s, (counts.get(s) ?? 0) + 1);
  let best: string | undefined, n = 0;
  for (const [k, c] of counts) if (c > n) { n = c; best = k; }
  return n >= 2 ? best : undefined;
}

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]!));

function say(html: string): void { statusEl.innerHTML = html; }

async function start(): Promise<void> {
  try {
    // `preferCurrentTab: false` and a window-ish hint: capturing the game WINDOW
    // rather than the whole screen means the frame IS the panel, which lets
    // `findPanel` take its fast path instead of searching.
    stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: { ideal: 4, max: 10 } },
      audio: false,
    });
  } catch (e) {
    say(`<div class="banner">Could not start capture: ${esc(String(e))}</div>`);
    return;
  }
  video.srcObject = stream;
  await video.play();
  stream.getVideoTracks()[0]?.addEventListener("ended", () => stop());
  startBtn.hidden = true; stopBtn.hidden = false;
  frames = 0; panelsFound = 0; blackFrames = 0;
  locked = null; lockMisses = 0; recentSelected.length = 0;
  timer = window.setInterval(() => void tick(), 500);
}

function stop(): void {
  if (timer !== null) { clearInterval(timer); timer = null; }
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  startBtn.hidden = false; stopBtn.hidden = true;
}

async function tick(): Promise<void> {
  const w = video.videoWidth, h = video.videoHeight;
  if (!w || !h) return;
  frames++;

  work.width = w; work.height = h;
  const ctx = work.getContext("2d", { willReadFrequently: true });
  if (!ctx) { say(`<div class="banner">No 2d canvas context.</div>`); return; }
  ctx.drawImage(video, 0, 0, w, h);
  const img = ctx.getImageData(0, 0, w, h);

  // THE BLACK-FRAME TEST, and it is not just "is it dark". A genuinely black
  // capture is uniformly black: zero brightness AND zero variation. A dark game
  // scene has variation. Checking both is what separates "capture is not
  // working" from "the game is in a dark room".
  const luma = meanLuma(img, { x0: 0, y0: 0, x1: w, y1: h });
  const spread = lumaStdDev(img, { x0: 0, y0: 0, x1: Math.min(w, 400), y1: Math.min(h, 400) });
  const black = luma < 4 && spread < 2;
  if (black) blackFrames++;

  const t0 = performance.now();
  let box = locked;
  let relocated = false;
  if (box) {
    // Cheap check: does the locked crop still look like a training screen?
    // A miss is usually just a menu, so the lock survives a run of them.
    const probe = probeScreen(cropImage(img, box));
    if (probe.kind === "training") lockMisses = 0;
    else if (++lockMisses >= RELOCK_AFTER) { locked = null; box = null; }
  }
  if (!box) {
    const found = findPanel(img);
    if (found) { locked = found.box; box = found.box; lockMisses = 0; relocated = true; }
  }
  const ms = performance.now() - t0;
  if (box) panelsFound++;

  // Preview at a readable size.
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

  say(`<p class="note">
      frame ${w}&times;${h} &middot; ${frames} frames &middot;
      panel on ${panelsFound}/${frames} &middot;
      ${locked ? `locked at x=${locked.x0}` : "searching"} &middot; ${ms.toFixed(0)} ms
    </p>
    ${black ? `<div class="banner"><strong>Frames are coming through BLACK.</strong>
      Brightness ${luma.toFixed(1)}, variation ${spread.toFixed(1)} — that is a capture
      that is not seeing the game rather than a dark scene. ${blackFrames} of ${frames}
      frames so far. Try sharing the whole screen instead of the window, or running the
      game borderless-windowed rather than exclusive fullscreen.</div>` : ""}
    ${!box && !black ? `<p class="note">Frames are arriving, but no training screen in this one —
      that is expected on menus, races and dialogs.</p>` : ""}`);

  if (!box) { readEl.innerHTML = `<p class="note">Waiting for a training screen.</p>`; return; }

  const r = readFrame(cropImage(img, box));
  const voted = voteSelected(r.selected);
  const row = (k: string, v: unknown) =>
    `<div class="out"><span>${k}</span><span class="n">${v === undefined ? "—" : esc(String(v))}</span></div>`;
  readEl.innerHTML = [
    row("screen", r.screen.kind),
    row("turns left", r.turnsLeft),
    row("concert in", r.concertIn),
    row("skill points", r.skillPts),
    row("selected", voted),
    row("selected (this frame)", r.selected),
    ...STATS.map((s) => row(s, r.stats[s])),
    ...STATS.map((s) => row(`${s} lvl`, r.facilityLevels[s])),
    r.chipLevelsHidden ? `<p class="note">No chip printed a level — this is what summer camp looks like.</p>` : "",
  ].join("");
}

startBtn.addEventListener("click", () => void start());
stopBtn.addEventListener("click", () => stop());
