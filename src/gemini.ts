// Gemini's visible watermark: a white sparkle alpha-blended near the bottom-right corner.
// Layouts change (logo 36-96 px, margin 32-192 px), but the right and bottom margins are always
// equal and within about three logo widths, so the search runs along that stretch of the corner
// diagonal at every plausible size. Both the corner and the sparkle are high-passed first so
// smooth backgrounds do not dominate. The same search in the other three corners measures how
// sparkle-like the image is by chance.

import type { Evidence } from './index.ts';
import type { Pixels } from './pixels.ts';
import { SPARKLE, SPARKLE_SIZE } from './sparkle.ts';

const ALPHA = Buffer.from(SPARKLE, 'base64');
const REGION = 360; // margin 192 + logo 96, plus slack for resized images
const MIN_SIZE = 32;
const MAX_SIZE = 112;
const MIN_MARGIN = 0.55; // × logo size; known layouts span 0.67 to 2.67
const MAX_MARGIN = 2.8;
const BLUR = 8; // high-pass radius, px

// Calibrated on 43 real Gemini images and 1,080 crops of 45 other images: no crop scored above
// 0.43, and 31 of the 43 watermarks clear both bars (the rest are barely visible).
const MIN_SCORE = 0.5;
const MIN_LEAD = 0.15;

export function geminiWatermark(img: Pixels): Evidence[] {
  const m = findSparkle(img);
  if (!m || m.score < MIN_SCORE || m.score - m.baseline < MIN_LEAD) return [];
  return [{
    source: 'watermark',
    confidence: 'claimed',
    origin: 'generated',
    generator: 'Google Gemini',
    detail: `Gemini's visible sparkle watermark, ${m.size} px, ${m.margin} px from the corner (match ${m.score.toFixed(2)}).`,
  }];
}

export interface SparkleMatch {
  size: number;
  margin: number;
  /** Normalized cross-correlation with the sparkle in the bottom-right corner, -1 to 1. */
  score: number;
  /** Best score found in the other three corners. */
  baseline: number;
}

interface Template { size: number; weights: Float32Array; norm: number }
const templates = new Map<number, Template>();

export function findSparkle(img: Pixels): SparkleMatch | undefined {
  const n = Math.min(REGION, img.width, img.height);
  if (n < MIN_SIZE * 2) return undefined;
  const corners = ([[1, 1], [0, 1], [1, 0], [0, 0]] as const).map(([r, b]) => search(highPass(corner(img, n, r, b), n), n));
  return { ...corners[0]!, baseline: Math.max(...corners.slice(1).map((c) => c.score)) };
}

// Luma of an n×n corner, mirrored so the corner always sits at the bottom right.
function corner(img: Pixels, n: number, right: 0 | 1, bottom: 0 | 1): Float32Array {
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const sy = bottom ? img.height - n + y : n - 1 - y;
    for (let x = 0; x < n; x++) {
      const sx = right ? img.width - n + x : n - 1 - x;
      const i = (sy * img.width + sx) * 4;
      out[y * n + x] = img.data[i]! + img.data[i + 1]! + img.data[i + 2]!;
    }
  }
  return out;
}

// Grid search with step 2, then refine around the best few candidates.
function search(img: Float32Array, n: number) {
  const fits = (s: number, m: number) => m >= MIN_MARGIN * s && m <= MAX_MARGIN * s && m + s <= n;
  const coarse: { size: number; margin: number; score: number }[] = [];
  for (let s = MIN_SIZE; s <= Math.min(MAX_SIZE, n); s += 2) {
    for (let m = Math.ceil(MIN_MARGIN * s); fits(s, m); m += 2) {
      coarse.push({ size: s, margin: m, score: ncc(img, n, n - m - s, template(s)) });
    }
  }
  coarse.sort((a, b) => b.score - a.score);

  let best = { size: 0, margin: 0, score: -1 };
  for (const c of coarse.slice(0, 3)) {
    for (let s = Math.max(MIN_SIZE, c.size - 2); s <= Math.min(MAX_SIZE, c.size + 2); s++) {
      for (let m = c.margin - 2; m <= c.margin + 2; m++) {
        if (!fits(s, m)) continue;
        const score = ncc(img, n, n - m - s, template(s));
        if (score > best.score) best = { size: s, margin: m, score };
      }
    }
  }
  return best;
}

// Correlation of the template with the patch whose top-left corner is (at, at).
function ncc(img: Float32Array, n: number, at: number, t: Template): number {
  let sum = 0, sumSq = 0, dot = 0;
  for (let y = 0; y < t.size; y++) {
    const row = (at + y) * n + at;
    for (let x = 0; x < t.size; x++) {
      const p = img[row + x]!;
      sum += p;
      sumSq += p * p;
      dot += p * t.weights[y * t.size + x]!;
    }
  }
  const variance = sumSq - (sum * sum) / (t.size * t.size);
  return variance > 1e-3 ? dot / Math.sqrt(variance) / t.norm : 0;
}

// The sparkle box-filtered to size×size, high-passed like the image (on a zero background,
// as the logo sits inside its box), then made zero-mean.
function template(size: number): Template {
  let t = templates.get(size);
  if (t) return t;
  const padded = size + BLUR * 2;
  const canvas = new Float32Array(padded * padded);
  const step = SPARKLE_SIZE / size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let sum = 0, count = 0;
      for (let sy = Math.floor(y * step); sy < Math.ceil((y + 1) * step); sy++) {
        for (let sx = Math.floor(x * step); sx < Math.ceil((x + 1) * step); sx++) {
          sum += ALPHA[sy * SPARKLE_SIZE + sx]!;
          count++;
        }
      }
      canvas[(y + BLUR) * padded + x + BLUR] = sum / count;
    }
  }
  const filtered = highPass(canvas, padded);
  const weights = new Float32Array(size * size);
  for (let y = 0; y < size; y++) weights.set(filtered.subarray((y + BLUR) * padded + BLUR, (y + BLUR) * padded + BLUR + size), y * size);
  const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
  let norm = 0;
  for (let i = 0; i < weights.length; i++) {
    weights[i] = weights[i]! - mean;
    norm += weights[i]! ** 2;
  }
  templates.set(size, (t = { size, weights, norm: Math.sqrt(norm) }));
  return t;
}

// Subtracts a (2·BLUR+1)² box blur, computed with an integral image.
function highPass(img: Float32Array, n: number): Float32Array {
  const w = n + 1;
  const sat = new Float64Array(w * w);
  for (let y = 0; y < n; y++) {
    let row = 0;
    for (let x = 0; x < n; x++) {
      row += img[y * n + x]!;
      sat[(y + 1) * w + x + 1] = sat[y * w + x + 1]! + row;
    }
  }
  const out = new Float32Array(n * n);
  for (let y = 0; y < n; y++) {
    const y0 = Math.max(0, y - BLUR), y1 = Math.min(n, y + BLUR + 1);
    for (let x = 0; x < n; x++) {
      const x0 = Math.max(0, x - BLUR), x1 = Math.min(n, x + BLUR + 1);
      const box = sat[y1 * w + x1]! - sat[y0 * w + x1]! - sat[y1 * w + x0]! + sat[y0 * w + x0]!;
      out[y * n + x] = img[y * n + x]! - box / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}
