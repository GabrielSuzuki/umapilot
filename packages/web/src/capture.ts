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
import { findPanel } from "../../engine/src/vision/classify";
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
  const found = findPanel(img);
  const ms = performance.now() - t0;
  if (found) panelsFound++;

  // Preview at a readable size.
  const scale = Math.min(1, 380 / w);
  preview.width = Math.round(w * scale); preview.height = Math.round(h * scale);
  const pctx = preview.getContext("2d");
  if (pctx) {
    pctx.drawImage(video, 0, 0, preview.width, preview.height);
    if (found) {
      pctx.strokeStyle = "#3a7"; pctx.lineWidth = 2;
      pctx.strokeRect(found.box.x0 * scale, found.box.y0 * scale,
        (found.box.x1 - found.box.x0) * scale, (found.box.y1 - found.box.y0) * scale);
    }
  }

  say(`<p class="note">
      frame ${w}&times;${h} &middot; ${frames} frames &middot;
      panel found on ${panelsFound}/${frames} &middot; ${ms.toFixed(0)} ms to locate
    </p>
    ${black ? `<div class="banner"><strong>Frames are coming through BLACK.</strong>
      Brightness ${luma.toFixed(1)}, variation ${spread.toFixed(1)} — that is a capture
      that is not seeing the game rather than a dark scene. ${blackFrames} of ${frames}
      frames so far. Try sharing the whole screen instead of the window, or running the
      game borderless-windowed rather than exclusive fullscreen.</div>` : ""}
    ${!found && !black ? `<p class="note">Frames are arriving, but no training screen in this one —
      that is expected on menus, races and dialogs.</p>` : ""}`);

  if (!found) { readEl.innerHTML = `<p class="note">Waiting for a training screen.</p>`; return; }

  const r = readFrame(cropImage(img, found.box));
  const row = (k: string, v: unknown) =>
    `<div class="out"><span>${k}</span><span class="n">${v === undefined ? "—" : esc(String(v))}</span></div>`;
  readEl.innerHTML = [
    row("screen", r.screen.kind),
    row("turns left", r.turnsLeft),
    row("concert in", r.concertIn),
    row("skill points", r.skillPts),
    row("selected", r.selected),
    ...STATS.map((s) => row(s, r.stats[s])),
    ...STATS.map((s) => row(`${s} lvl`, r.facilityLevels[s])),
    r.chipLevelsHidden ? `<p class="note">No chip printed a level — this is what summer camp looks like.</p>` : "",
  ].join("");
}

startBtn.addEventListener("click", () => void start());
stopBtn.addEventListener("click", () => stop());
