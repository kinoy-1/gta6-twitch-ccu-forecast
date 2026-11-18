// gta6-twitch-ccu-forecast-01: forecast GTA VI's launch-day Twitch viewers, hour by hour.
//
// The program reads one case file (schema "makefun/twitch-ccu-case/v1") and writes
// /output/<id>.out with five quantiles (0.05, 0.25, 0.5, 0.75, 0.95) of the Twitch
// category's concurrent viewers for each of hours 2..24 of the release day (UTC).
//
// Model (written from the kit's specification; no data leaves the case file):
//   Launch-day Twitch curves share one shape in UTC hours because every big console
//   game unlocks at local midnight, rolling around the world: hour 1 (00:00 UTC) only
//   holds the UK / central-Europe / New Zealand unlock, hour 5 (04:00 UTC) adds the US
//   east coast, hour 9 (08:00 UTC) the US west coast, and the evening hours 17..22
//   (UTC) are prime time in the Americas. The shape is therefore predictable in
//   *ratios to hour 1's print* — but the ratio curve depends strongly on how big hour
//   1 already is: a launch whose hour 1 is small (a US-skewed audience, or a smaller
//   game) grows several-fold into the evening, while a launch that is already huge at
//   00:00 UTC barely doubles. So for each forecast hour we fit, over the case's
//   `comparables` (past big launches' release days), the log-ratio
//   ln(viewers_h / viewers_1) as a function of ln(viewers_1):
//     - a Gaussian-kernel weighted local-linear regression (bandwidth 2.0 in log
//       space), evaluated at the case's own log hour-1 print, clamped to the range of
//       hour-1 sizes the comparables actually show, so a GTA-VI-sized print never
//       extrapolates a straight line into the void; the fitted median is blended
//       0.7 / 0.3 with the plain kernel-weighted mean, which steadies the fit at the
//       edges of the size range;
//     - the spread is the fit's weighted residual standard deviation (floored at
//       0.25 log units, shrunk by 0.6 — the raw cross-game spread overstates the
//       conditional spread once size is accounted for), giving honest quantiles
//       q_tau = p1 * exp(median + z_tau * spread).
//   Fallbacks keep every case valid: if no comparable yields a usable curve the
//   program falls back to persistence (every hour at hour 1's print, spread widening
//   like a random walk); a missing or zero hour-1 print falls back to 1 viewer; a
//   missing `known` row falls back to the last hourly history point.
//   Everything is deterministic (no randomness, no clock, no network): two runs on
//   the same case write byte-identical output.
//
// Node 22, standard library only. Run locally with:
//   MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level. */
const Z = [-1.645, -0.674, 0, 0.674, 1.645];

/** Kernel bandwidth (log-viewer units) for weighting comparables by launch size. */
const BANDWIDTH = 2.0;
/** Floor on the log-spread of any hour, so no hour is ever forecast overconfidently. */
const SPREAD_FLOOR = 0.25;
/** Shrinkage applied to the residual spread (cross-game spread overstates it). */
const SPREAD_MULT = 0.6;
/** Fallback (persistence) spread growth per square-root hour, as in the baseline. */
const FALLBACK_SIGMA = 0.15;
/** Weight of the local-linear fit in the blended median (rest: kernel mean). */
const LOCLIN_WEIGHT = 0.7;
/** A comparable must supply this many of the 23 hourly ratios to be usable. */
const MIN_RATIOS = 18;

interface CaseFile {
  levels?: number[];
  known?: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  history_hourly?: Array<{ from: string; viewers: number }>;
  comparables?: Array<{
    name: string;
    day_start: string;
    unlock?: string;
    hourly: Array<{ from: string; viewers: number }>;
  }>;
}

/** One comparable's launch-day curve, as log-ratios to its hour-1 print. */
interface Curve {
  /** ln(hour-1 viewers). */
  logV1: number;
  /** log-ratio ln(viewers_h / viewers_1) for hour index h = 1..23 (hour h+1), null if missing. */
  ratios: Array<number | null>;
}

const isFiniteNumber = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

/** x rounded to 2 decimals (half up), matching the output format. */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Clamp x into [lo, hi]. */
const clamp = (x: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, x));

/**
 * Extract the usable launch-day curves from the case's comparables: for each past
 * launch, its 24 hourly counts aligned to its release day's 00:00 UTC, turned into
 * log-ratios to its hour-1 count. Entries that are not a launch day (for example the
 * target game's own pre-release category history) and launches without a usable
 * hour-1 print are skipped; a curve needs most of its hours present.
 */
function extractCurves(comparables: CaseFile['comparables']): Curve[] {
  const curves: Curve[] = [];
  for (const comp of comparables ?? []) {
    if (typeof comp.unlock === 'string' && /not a launch/i.test(comp.unlock)) continue;
    const dayStart = Date.parse(comp.day_start);
    if (!Number.isFinite(dayStart)) continue;
    const byHour = new Map<number, number>();
    for (const pt of comp.hourly ?? []) {
      const t = Date.parse(pt.from);
      if (!Number.isFinite(t) || !isFiniteNumber(pt.viewers)) continue;
      const h = Math.round((t - dayStart) / 3_600_000);
      if (h >= 0 && h < 24 && pt.viewers >= 0) byHour.set(h, pt.viewers);
    }
    const v1 = byHour.get(0);
    if (v1 === undefined || v1 <= 0) continue;
    const ratios: Array<number | null> = [];
    let present = 0;
    for (let h = 1; h < 24; h++) {
      const v = byHour.get(h);
      if (v !== undefined && v > 0) {
        ratios.push(Math.log(v / v1));
        present++;
      } else {
        ratios.push(null);
      }
    }
    if (present >= MIN_RATIOS) curves.push({ logV1: Math.log(v1), ratios });
  }
  return curves;
}

/**
 * For one forecast hour, fit the log-ratio against launch size over the usable
 * curves: a Gaussian-kernel weighted local-linear regression in ln(viewers_1),
 * evaluated at lp (the case's own log hour-1 print). Returns the fitted median
 * log-ratio and the weighted residual spread of the fit, plus the plain
 * kernel-weighted mean log-ratio: the final median blends the two (0.7 local-linear,
 * 0.3 kernel mean), which on the four practice launches kept the worst case lower
 * than either estimator alone — the local slope can overshoot for very large or
 * very small launches, and the mean anchors it.
 */
function fitHour(curves: Curve[], hourIndex: number, lp: number): { median: number; spread: number } {
  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  const points: Array<[number, number, number]> = [];
  for (const c of curves) {
    const r = c.ratios[hourIndex];
    if (r === null || r === undefined) continue;
    const w = Math.exp(-((c.logV1 - lp) ** 2) / (2 * BANDWIDTH * BANDWIDTH));
    points.push([c.logV1, r, w]);
    sw += w;
    sx += w * c.logV1;
    sy += w * r;
    sxx += w * c.logV1 * c.logV1;
    sxy += w * c.logV1 * r;
  }
  if (points.length === 0 || sw <= 0) return { median: 0, spread: SPREAD_FLOOR };
  const den = sw * sxx - sx * sx;
  let intercept = sy / sw;
  let slope = 0;
  if (Math.abs(den) > 1e-12) {
    slope = (sw * sxy - sx * sy) / den;
    intercept = (sy - slope * sx) / sw;
  }
  const kernelMean = sy / sw;
  const localLinear = intercept + slope * lp;
  const median = LOCLIN_WEIGHT * localLinear + (1 - LOCLIN_WEIGHT) * kernelMean;
  let residual = 0;
  for (const [x, y, w] of points) residual += w * (y - (intercept + slope * x)) ** 2;
  const spread = Math.max(SPREAD_FLOOR, SPREAD_MULT * Math.sqrt(residual / sw));
  return { median, spread };
}

/** The persistence fallback of one hour: hour 1's print, spread widening over the day. */
function fallbackQuantiles(p1: number, hour: number): number[] {
  return Z.map((z) => round2(p1 * Math.exp(z * FALLBACK_SIGMA * Math.sqrt(hour - 1))));
}

/** Hour 1's print for the case, with fallbacks that never let a case go invalid. */
function hourOnePrint(c: CaseFile): number {
  const row = (c.known ?? []).find((k) => k.hour === 1);
  if (row !== undefined && isFiniteNumber(row.viewers) && row.viewers > 0) return row.viewers;
  const hist = c.history_hourly ?? [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const v = hist[i]?.viewers;
    if (isFiniteNumber(v) && v > 0) return v;
  }
  return 1;
}

/** The forecast rows for one case. */
function forecastCase(c: CaseFile): Array<{ hour: number; q: number[] }> {
  const p1 = Math.max(1, hourOnePrint(c));
  const curves = extractCurves(c.comparables);
  const logV1s = curves.map((x) => x.logV1);
  // Never extrapolate the size regression past the launches actually observed.
  const lp = logV1s.length > 0 ? clamp(Math.log(p1), Math.min(...logV1s), Math.max(...logV1s)) : Math.log(p1);
  const hours = (c.forecast ?? []).map(({ hour }) => ({ hour }));
  const rows: Array<{ hour: number; q: number[] }> = [];
  for (const { hour } of hours) {
    if (!Number.isInteger(hour) || hour < 2 || hour > 24) continue;
    let q: number[];
    if (curves.length === 0) {
      q = fallbackQuantiles(p1, hour);
    } else {
      // ratios[0] is hour 2's log-ratio, so hour h uses index h - 2.
      const { median, spread } = fitHour(curves, hour - 2, lp);
      q = Z.map((z) => round2(p1 * Math.exp(median + z * spread)));
    }
    // Enforce the output contract: finite, > 0, <= 1e9, non-decreasing.
    let prev = 0;
    q = q.map((v) => {
      const clean = Number.isFinite(v) ? clamp(v, 1, 1_000_000_000) : p1;
      const out = Math.max(clean, prev);
      prev = out;
      return out;
    });
    rows.push({ hour, q });
  }
  // If the case listed no forecast hours (it should list 2..24), emit the full set.
  if (rows.length === 0) {
    for (let hour = 2; hour <= 24; hour++) {
      rows.push({ hour, q: fallbackQuantiles(p1, hour) });
    }
  }
  rows.sort((a, b) => a.hour - b.hour);
  return rows;
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (c.levels !== undefined && (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j]))) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
