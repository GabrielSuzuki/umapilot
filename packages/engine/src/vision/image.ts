/**
 * The smallest image type that works in both places this code has to run.
 *
 * In the browser a frame arrives as `ImageData` off a canvas; in Node the test
 * harness decodes a PNG to the same shape. `ImageData` is structurally exactly
 * this, so a browser caller passes one straight in with no adapter and no
 * copy -- which is the point. Nothing in `vision/` may import a DOM type or a
 * Node module, or that stops being true.
 */
export interface RgbaImage {
  readonly width: number;
  readonly height: number;
  /** RGBA, row-major, 4 bytes per pixel. */
  readonly data: Uint8ClampedArray;
}

/** A rectangle in pixels. `x1`/`y1` are exclusive. */
export interface Box { x0: number; y0: number; x1: number; y1: number }

export function clampBox(b: Box, w: number, h: number): Box {
  return {
    x0: Math.max(0, Math.min(w, Math.round(b.x0))),
    y0: Math.max(0, Math.min(h, Math.round(b.y0))),
    x1: Math.max(0, Math.min(w, Math.round(b.x1))),
    y1: Math.max(0, Math.min(h, Math.round(b.y1))),
  };
}

/** Mean luminance of a box, 0..255. Cheap, and the basis of most probes. */
export function meanLuma(img: RgbaImage, box: Box): number {
  const b = clampBox(box, img.width, img.height);
  let sum = 0, n = 0;
  for (let y = b.y0; y < b.y1; y++) {
    let i = (y * img.width + b.x0) * 4;
    for (let x = b.x0; x < b.x1; x++, i += 4) {
      sum += 0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!;
      n++;
    }
  }
  return n === 0 ? 0 : sum / n;
}

/** Mean RGB of a box. Used by the probes that key on the game's flat UI colours. */
export function meanRgb(img: RgbaImage, box: Box): [number, number, number] {
  const b = clampBox(box, img.width, img.height);
  let r = 0, g = 0, bl = 0, n = 0;
  for (let y = b.y0; y < b.y1; y++) {
    let i = (y * img.width + b.x0) * 4;
    for (let x = b.x0; x < b.x1; x++, i += 4) {
      r += img.data[i]!; g += img.data[i + 1]!; bl += img.data[i + 2]!; n++;
    }
  }
  return n === 0 ? [0, 0, 0] : [r / n, g / n, bl / n];
}

/**
 * How much the pixels in a box disagree with each other, as a standard
 * deviation of luminance.
 *
 * This is the modal-dialog detector. When the game opens a dialog it blurs and
 * dims everything behind it, and a blur is exactly a reduction in local
 * contrast -- so the header region, which is normally high-contrast text on
 * flat panels, goes quiet. Reading a blurred header as if it were sharp is how
 * a classifier silently reports the screen underneath a dialog.
 */
export function lumaStdDev(img: RgbaImage, box: Box): number {
  const b = clampBox(box, img.width, img.height);
  const vals: number[] = [];
  for (let y = b.y0; y < b.y1; y++) {
    let i = (y * img.width + b.x0) * 4;
    for (let x = b.x0; x < b.x1; x++, i += 4) {
      vals.push(0.299 * img.data[i]! + 0.587 * img.data[i + 1]! + 0.114 * img.data[i + 2]!);
    }
  }
  if (vals.length === 0) return 0;
  const m = vals.reduce((a, v) => a + v, 0) / vals.length;
  return Math.sqrt(vals.reduce((a, v) => a + (v - m) ** 2, 0) / vals.length);
}

/**
 * A binary ink mask over a box.
 *
 * `polarity` is the whole of the configuration and it is not a detail. The
 * game draws dark text on light panels (the stat row, the token column) AND
 * light text on saturated fills (the facility chips, the mood pill). One
 * threshold cannot serve both, and a reader that guesses will read the outline
 * of a glyph instead of the glyph.
 */
export interface Mask {
  readonly width: number;
  readonly height: number;
  /** 1 where ink, 0 where not. */
  readonly bits: Uint8Array;
}

/**
 * A threshold that adapts to the box it is applied to.
 *
 * The facility chips defeat every fixed threshold, and not by accident: each
 * chip prints its label in its OWN colour on a fill of the same hue -- blue on
 * light blue for Speed, orange on orange for Wit -- wrapped in a white outline.
 * Measured on one chip: the glyph core sits at white-distance 255, the fill at
 * 191, the outline at 31. A constant that separates those three for Speed sits
 * inside the gap for Wit.
 *
 * What IS constant is the ORDER: within the label's box, the glyph is always
 * the furthest thing from white. So the threshold is set as a fraction of the
 * box's own maximum, and the colour drops out of the problem entirely.
 */
export function fractionOfMaxThreshold(
  img: RgbaImage, box: Box, fraction: number,
): number {
  const b = clampBox(box, img.width, img.height);
  let max = 0;
  for (let y = b.y0; y < b.y1; y++) {
    let i = (y * img.width + b.x0) * 4;
    for (let x = b.x0; x < b.x1; x++, i += 4) {
      const d = whiteDistance(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
      if (d > max) max = d;
    }
  }
  return max * fraction;
}

export function inkMask(
  img: RgbaImage, box: Box, polarity: "dark" | "light", threshold: number,
): Mask {
  const b = clampBox(box, img.width, img.height);
  const w = Math.max(0, b.x1 - b.x0), h = Math.max(0, b.y1 - b.y0);
  const bits = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let i = ((b.y0 + y) * img.width + b.x0) * 4;
    for (let x = 0; x < w; x++, i += 4) {
      const d = whiteDistance(img.data[i]!, img.data[i + 1]!, img.data[i + 2]!);
      bits[y * w + x] = (polarity === "dark" ? d > threshold : d < threshold) ? 1 : 0;
    }
  }
  return { width: w, height: h, bits };
}

/**
 * How far a pixel is from white, as the largest single-channel shortfall.
 *
 * NOT luminance, and the difference is the whole reason this function exists.
 * The turn counter is a purple digit with a vertical GRADIENT -- pale lavender
 * at the top, saturated at the bottom -- printed on a white card. Threshold it
 * by luminance and the bottom half of the glyph is ink while the top bar is
 * background, so a "7" segments as a lone diagonal stroke and matches nothing.
 * Distance from white does not care that the purple got lighter, only that it
 * is not white, so the whole glyph survives.
 *
 * The same measure inverts for white text on a saturated fill: there the glyph
 * is the part that IS white, and `polarity: "light"` keeps pixels BELOW the
 * threshold. One measure, two signs, no second threshold to tune.
 */
export function whiteDistance(r: number, g: number, b: number): number {
  return 255 - Math.min(r, Math.min(g, b));
}

export function maskAt(m: Mask, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= m.width || y >= m.height) return 0;
  return m.bits[y * m.width + x]!;
}

/** Ink count per column. The basis of digit segmentation. */
export function columnProfile(m: Mask): number[] {
  const out = new Array<number>(m.width).fill(0);
  for (let y = 0; y < m.height; y++) {
    for (let x = 0; x < m.width; x++) if (m.bits[y * m.width + x]) out[x]!++;
  }
  return out;
}

export function rowProfile(m: Mask): number[] {
  const out = new Array<number>(m.height).fill(0);
  for (let y = 0; y < m.height; y++) {
    let n = 0;
    for (let x = 0; x < m.width; x++) if (m.bits[y * m.width + x]) n++;
    out[y] = n;
  }
  return out;
}
