/**
 * signature-image.ts
 *
 * Client-side image curation for *uploaded* signatures: turns a photo or scan
 * of a signature (paper texture, shadows, phone-camera lighting, colored
 * background) into a clean TRANSPARENT PNG that contains only the ink.
 *
 * Pipeline
 *  1. decode + downscale to a workable size
 *  2. illumination estimate (dilate + blur on a thumbnail) -> divide, which
 *     flattens shadows and uneven paper lighting
 *  3. background colour estimate from the border ring -> chroma distance, so
 *     coloured / non-white backgrounds also drop out
 *  4. soft threshold -> per-pixel alpha (anti-aliased edges, no jaggies)
 *  5. despeckle via connected-component area filter (kills paper grain, dust)
 *  6. optional ink recolour + contrast boost
 *  7. tight transparent crop
 *
 * Everything is pure canvas/typed-array work: no network, no dependency.
 */

export interface CurateOptions {
  /** 0..100 — how aggressively pixels are treated as background. */
  threshold: number;
  /** 0..100 — edge softness (anti-aliasing band width). */
  softness: number;
  /** 0..100 — minimum blob size kept. */
  despeckle: number;
  /** 0..100 — darkens/strengthens the surviving ink. */
  inkStrength: number;
  /** When set, all surviving ink is recoloured to this hex value. */
  recolor: string | null;
}

export const DEFAULT_CURATE_OPTIONS: CurateOptions = {
  threshold: 55,
  softness: 35,
  despeckle: 25,
  inkStrength: 60,
  recolor: null,
};

const MAX_EDGE = 1600;

/* ------------------------------------------------------------------ utils */

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not read that image."));
    img.src = src;
  });
}

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h
          .split("")
          .map((c) => c + c)
          .join("")
      : h;
  const n = parseInt(full, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Trim fully-transparent padding for a tight crop. */
export function trimTransparent(source: HTMLCanvasElement, pad = 10): HTMLCanvasElement {
  const ctx = source.getContext("2d");
  if (!ctx) return source;
  const { width, height } = source;
  if (!width || !height) return source;
  const { data } = ctx.getImageData(0, 0, width, height);
  let top = height,
    left = width,
    right = 0,
    bottom = 0,
    found = false;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > 8) {
        found = true;
        if (x < left) left = x;
        if (x > right) right = x;
        if (y < top) top = y;
        if (y > bottom) bottom = y;
      }
    }
  }
  if (!found) return source;
  left = Math.max(0, left - pad);
  top = Math.max(0, top - pad);
  right = Math.min(width - 1, right + pad);
  bottom = Math.min(height - 1, bottom + pad);
  const w = right - left + 1;
  const h = bottom - top + 1;
  const out = document.createElement("canvas");
  out.width = w;
  out.height = h;
  out.getContext("2d")!.drawImage(source, left, top, w, h, 0, 0, w, h);
  return out;
}

/* ------------------------------------------------- illumination flattening */

/** Downscaled grayscale + dilate + blur => per-pixel background luminance. */
function illuminationMap(lum: Float32Array, w: number, h: number) {
  const tw = Math.max(16, Math.min(96, Math.round((96 * w) / Math.max(w, h))));
  const th = Math.max(16, Math.round((tw * h) / w));
  const small = new Float32Array(tw * th);

  // area-average downsample
  for (let y = 0; y < th; y++) {
    const y0 = Math.floor((y * h) / th);
    const y1 = Math.max(y0 + 1, Math.floor(((y + 1) * h) / th));
    for (let x = 0; x < tw; x++) {
      const x0 = Math.floor((x * w) / tw);
      const x1 = Math.max(x0 + 1, Math.floor(((x + 1) * w) / tw));
      let sum = 0,
        n = 0;
      for (let yy = y0; yy < y1 && yy < h; yy++)
        for (let xx = x0; xx < x1 && xx < w; xx++) {
          sum += lum[yy * w + xx]!;
          n++;
        }
      small[y * tw + x] = sum / Math.max(1, n);
    }
  }

  // dilate (max filter) so ink strokes don't drag the estimate down
  const dil = new Float32Array(tw * th);
  const r = 2;
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      let m = 0;
      for (let dy = -r; dy <= r; dy++) {
        const yy = Math.min(th - 1, Math.max(0, y + dy));
        for (let dx = -r; dx <= r; dx++) {
          const xx = Math.min(tw - 1, Math.max(0, x + dx));
          const v = small[yy * tw + xx]!;
          if (v > m) m = v;
        }
      }
      dil[y * tw + x] = m;
    }

  // box blur the dilated map
  const blur = new Float32Array(tw * th);
  const br = 3;
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      let sum = 0,
        n = 0;
      for (let dy = -br; dy <= br; dy++) {
        const yy = Math.min(th - 1, Math.max(0, y + dy));
        for (let dx = -br; dx <= br; dx++) {
          const xx = Math.min(tw - 1, Math.max(0, x + dx));
          sum += dil[yy * tw + xx]!;
          n++;
        }
      }
      blur[y * tw + x] = sum / n;
    }

  return { map: blur, tw, th };
}

function sampleBilinear(map: Float32Array, tw: number, th: number, fx: number, fy: number) {
  const x = Math.min(tw - 1, Math.max(0, fx * (tw - 1)));
  const y = Math.min(th - 1, Math.max(0, fy * (th - 1)));
  const x0 = Math.floor(x),
    y0 = Math.floor(y);
  const x1 = Math.min(tw - 1, x0 + 1),
    y1 = Math.min(th - 1, y0 + 1);
  const ax = x - x0,
    ay = y - y0;
  const a = map[y0 * tw + x0]!,
    b = map[y0 * tw + x1]!,
    c = map[y1 * tw + x0]!,
    d = map[y1 * tw + x1]!;
  return a * (1 - ax) * (1 - ay) + b * ax * (1 - ay) + c * (1 - ax) * ay + d * ax * ay;
}

/* ------------------------------------------------------------- despeckling */

/** Zero out connected alpha blobs smaller than `minArea` (4-connectivity). */
function despeckleAlpha(alpha: Float32Array, w: number, h: number, minArea: number) {
  const labels = new Int32Array(w * h).fill(-1);
  const stack = new Int32Array(w * h);
  const sizes: number[] = [];
  let next = 0;
  const ON = 0.12;

  for (let i = 0; i < w * h; i++) {
    if (alpha[i]! <= ON || labels[i] !== -1) continue;
    let sp = 0;
    stack[sp++] = i;
    labels[i] = next;
    let count = 0;
    while (sp > 0) {
      const p = stack[--sp]!;
      count++;
      const x = p % w;
      const y = (p / w) | 0;
      const push = (q: number) => {
        if (alpha[q]! > ON && labels[q] === -1) {
          labels[q] = next;
          stack[sp++] = q;
        }
      };
      if (x > 0) push(p - 1);
      if (x < w - 1) push(p + 1);
      if (y > 0) push(p - w);
      if (y < h - 1) push(p + w);
    }
    sizes.push(count);
    next++;
  }

  if (!sizes.length) return;
  const largest = Math.max(...sizes);
  for (let i = 0; i < w * h; i++) {
    const l = labels[i]!;
    if (l >= 0) {
      const size = sizes[l]!;
      if (size < minArea && size < largest) alpha[i] = 0;
    }
  }
}

/* ---------------------------------------------------------------- pipeline */

export interface CurateResult {
  /** Transparent PNG data URL, tightly cropped. */
  dataUrl: string;
  /** Share of pixels kept as ink (0..1) — used to warn about over/under-cutting. */
  inkRatio: number;
  width: number;
  height: number;
}

/**
 * Remove the background of an uploaded signature image and return a
 * transparent, tightly-cropped PNG.
 */
export async function curateSignatureImage(
  src: string | HTMLImageElement,
  options: Partial<CurateOptions> = {},
): Promise<CurateResult> {
  const opts: CurateOptions = { ...DEFAULT_CURATE_OPTIONS, ...options };
  const img = typeof src === "string" ? await loadImage(src) : src;

  const scale = Math.min(1, MAX_EDGE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));

  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, w, h);
  const image = ctx.getImageData(0, 0, w, h);
  const px = image.data;
  const n = w * h;

  // If the source already has meaningful transparency, respect it and only
  // clean it up (common case: a real transparent PNG re-uploaded).
  let transparentPixels = 0;
  for (let i = 0; i < n; i++) if (px[i * 4 + 3]! < 250) transparentPixels++;
  const preTransparent = transparentPixels / n > 0.05;

  const lum = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lum[i] = 0.299 * px[i * 4]! + 0.587 * px[i * 4 + 1]! + 0.114 * px[i * 4 + 2]!;
  }

  // border-ring background colour estimate (handles coloured backgrounds)
  let br = 0,
    bg = 0,
    bb = 0,
    bc = 0;
  const ring = Math.max(2, Math.round(Math.min(w, h) * 0.04));
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const onBorder = x < ring || y < ring || x >= w - ring || y >= h - ring;
      if (!onBorder) continue;
      const i = (y * w + x) * 4;
      if (px[i + 3]! < 8) continue;
      br += px[i]!;
      bg += px[i + 1]!;
      bb += px[i + 2]!;
      bc++;
    }
  }
  if (bc) {
    br /= bc;
    bg /= bc;
    bb /= bc;
  } else {
    br = bg = bb = 255;
  }

  const { map, tw, th } = illuminationMap(lum, w, h);

  // threshold in "normalized darkness" space: 0 = same as local background
  const t = 0.06 + (opts.threshold / 100) * 0.5; // 0.06 .. 0.56
  const soft = 0.02 + (opts.softness / 100) * 0.35;
  const alpha = new Float32Array(n);

  for (let y = 0; y < h; y++) {
    const fy = h > 1 ? y / (h - 1) : 0;
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const o = i * 4;

      if (preTransparent && px[o + 3]! < 8) {
        alpha[i] = 0;
        continue;
      }

      const bgLum = Math.max(24, sampleBilinear(map, tw, th, w > 1 ? x / (w - 1) : 0, fy));
      // 0 where the pixel matches local paper, 1 where it is much darker
      const darkness = Math.max(0, 1 - lum[i]! / bgLum);

      // chroma distance from the estimated background colour (coloured paper,
      // blue ink on a grey card, etc.)
      const dr = px[o]! - br;
      const dg = px[o + 1]! - bg;
      const db = px[o + 2]! - bb;
      const chroma = Math.min(1, Math.sqrt(dr * dr + dg * dg + db * db) / 190);

      const score = Math.max(darkness, chroma * 0.9);
      let a = (score - (t - soft)) / (2 * soft);
      a = a < 0 ? 0 : a > 1 ? 1 : a;
      if (preTransparent) a = Math.min(a, px[o + 3]! / 255);
      alpha[i] = a;
    }
  }

  // despeckle: min blob area scales with image size and the slider
  if (opts.despeckle > 0) {
    const minArea = Math.round((opts.despeckle / 100) * (n / 4000) + opts.despeckle / 8);
    despeckleAlpha(alpha, w, h, minArea);
  }

  // ink strength (gamma on alpha) + optional recolour
  const gamma = 1.35 - (opts.inkStrength / 100) * 0.95; // 1.35 (light) .. 0.4 (bold)
  const recolor = opts.recolor ? hexToRgb(opts.recolor) : null;
  let inkPixels = 0;

  for (let i = 0; i < n; i++) {
    let a = alpha[i]!;
    if (a > 0) a = Math.pow(a, gamma);
    const o = i * 4;
    if (a <= 0.004) {
      px[o + 3] = 0;
      continue;
    }
    if (a > 0.35) inkPixels++;
    if (recolor) {
      px[o] = recolor[0];
      px[o + 1] = recolor[1];
      px[o + 2] = recolor[2];
    } else {
      // deepen surviving ink so faint pen strokes stay legible when printed
      const boost = 0.55 + (1 - opts.inkStrength / 100) * 0.45;
      px[o] = Math.round(px[o]! * boost);
      px[o + 1] = Math.round(px[o + 1]! * boost);
      px[o + 2] = Math.round(px[o + 2]! * boost);
    }
    px[o + 3] = Math.round(Math.min(1, a) * 255);
  }

  ctx.putImageData(image, 0, 0);
  const trimmed = trimTransparent(canvas, 12);

  return {
    dataUrl: trimmed.toDataURL("image/png"),
    inkRatio: inkPixels / n,
    width: trimmed.width,
    height: trimmed.height,
  };
}
