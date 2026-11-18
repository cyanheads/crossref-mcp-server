/**
 * @fileoverview Scaling assertion for the normalization passes. A single timing against a budget
 * cannot tell linear from quadratic — the defect only shows as growth — so a case is measured at
 * every doubling from 5k to 320k characters and judged on the full-span ratio t(320k)/t(5k): 64
 * when the work is linear, 4096 when it is quadratic. Time is the calling thread's CPU time,
 * never wall clock, so other work on the machine does not move the ratio. A test calling it sets
 * vitest's per-test timeout to 0: the body is synchronous, so vitest cannot interrupt it and only
 * compares wall time after it returns, which fails linear work on a loaded machine and stops no
 * hang; the per-size CPU cap is what stops a super-linear case.
 * @module tests/helpers/scaling
 */

import { expect } from 'vitest';

/** The input sizes, in characters: each double the last, a 64× span from end to end. */
const SIZES = [5_000, 10_000, 20_000, 40_000, 80_000, 160_000, 320_000] as const;

/** Upper bound on t(320k)/t(5k): four times the linear 64, a sixteenth of the quadratic 4096. */
const RATIO_LIMIT = 256;

/**
 * Upper bound on one call's CPU milliseconds at any size, checked before the next size runs, so
 * a quadratic fails at the first size it overruns instead of spending seconds per call at the
 * top of the ladder. The linear cases stay under 40 ms at 320k on both runtimes.
 */
const CAP_MS = 250;

/** CPU milliseconds a sample spends before its total is divided by its calls. */
const SAMPLE_MS = 20;

/** Samples per size; the cheapest is kept, so one collection pause cannot decide the ratio. */
const SAMPLES = 3;

/** The calling thread's user plus system CPU time, in milliseconds. */
function threadCpuMs(): number {
  const { user, system } = process.threadCpuUsage();
  return (user + system) / 1000;
}

/** Cheapest per-call CPU milliseconds of `run(input)`, after one warm-up call. */
function perCallMs(run: (input: string) => unknown, input: string): number {
  run(input);
  let best = Number.POSITIVE_INFINITY;
  for (let sample = 0; sample < SAMPLES; sample++) {
    const started = threadCpuMs();
    let calls = 0;
    let spent = 0;
    do {
      run(input);
      calls++;
      spent = threadCpuMs() - started;
    } while (spent < SAMPLE_MS);
    best = Math.min(best, spent / calls);
  }
  return best;
}

/** `make(size)`, refused when it misses the size by more than a tenth. */
function build(make: (size: number) => string, size: number): string {
  const input = make(size);
  if (input.length > size || input.length < size * 0.9) {
    throw new Error(`input built for ${size} characters has ${input.length}`);
  }
  return input;
}

/**
 * Assert that `run` costs time linear in the size of the inputs `make` builds: every size under
 * `CAP_MS` of CPU per call, checked as each size finishes, and t(320k)/t(5k) under `RATIO_LIMIT`.
 * The 5k baseline is timed again beside every larger size and the ratio takes the slowest of
 * those timings: a baseline timed once can run on a performance core while 320k runs on an
 * efficiency core several times slower, which reads as super-linear growth on linear code.
 * Throws through `expect` at the first bound broken.
 */
export function expectLinearScaling(
  make: (size: number) => string,
  run: (input: string) => unknown,
): void {
  const [baseSize, ...larger] = SIZES;
  const baseInput = build(make, baseSize);
  const baselines = [perCallMs(run, baseInput)];
  const ms: number[] = [];
  const ladder = () =>
    `CPU ms per call = ${ms.map((t) => t.toFixed(3)).join(' / ')}; ${baseSize} characters = ${baselines.map((t) => t.toFixed(3)).join(' / ')}`;
  for (const size of larger) {
    const t = perCallMs(run, build(make, size));
    ms.push(t);
    baselines.push(perCallMs(run, baseInput));
    expect(t, `${size} characters, ${ladder()}`).toBeLessThan(CAP_MS);
  }
  const last = ms.at(-1) ?? 0;
  expect(last / Math.max(...baselines), ladder()).toBeLessThan(RATIO_LIMIT);
}

/** `unit` repeated and cut to exactly `size` characters. */
export function repeatTo(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

/** `unit` repeated as many whole times as fit in `size` characters, never cut mid-unit. */
export function repeatWhole(unit: string, size: number): string {
  return unit.repeat(Math.floor(size / unit.length));
}

/** `open` repeated as deep as `size` allows around `core`, closed by `close` as many times. */
export function nestTo(open: string, core: string, close: string, size: number): string {
  const depth = Math.floor((size - core.length) / (open.length + close.length));
  return `${open.repeat(depth)}${core}${close.repeat(depth)}`;
}
