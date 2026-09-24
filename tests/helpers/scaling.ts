/**
 * @fileoverview Scaling measurement for the normalization passes. A single timing against a
 * budget cannot tell linear from quadratic — the defect only shows as growth — so a case is
 * measured at three sizes and judged on the full-span ratio t(80k)/t(5k): 16 when the work is
 * linear, 256 when it is quadratic.
 * @module tests/helpers/scaling
 */

/** The input sizes, in characters, every scaling case is measured at. */
export const SCALING_SIZES = [5_000, 20_000, 80_000] as const;

/** Per-call time at each of `SCALING_SIZES`, and the full-span ratio between the ends. */
export interface Scaling {
  /** Best per-call milliseconds at 5k, 20k, and 80k characters. */
  readonly ms: readonly [number, number, number];
  /** t(80k) / t(5k). */
  readonly ratio: number;
}

/**
 * Time `run` over inputs `make` builds at each size. Every sample spends the same number of
 * characters — 16 calls at 5k, 4 at 20k, 1 at 80k — so the small sizes are not measured at the
 * timer's resolution, and the best of five samples is kept so one collection pause cannot
 * decide the ratio.
 */
export function measureScaling(
  make: (size: number) => string,
  run: (input: string) => unknown,
): Scaling {
  const ms = SCALING_SIZES.map((size) => {
    const input = make(size);
    if (input.length > size || input.length < size * 0.9) {
      throw new Error(`input built for ${size} characters has ${input.length}`);
    }
    const calls = SCALING_SIZES[2] / size;
    run(input);
    let best = Number.POSITIVE_INFINITY;
    for (let sample = 0; sample < 5; sample++) {
      const started = performance.now();
      for (let call = 0; call < calls; call++) run(input);
      best = Math.min(best, (performance.now() - started) / calls);
    }
    return best;
  }) as unknown as [number, number, number];
  return { ms, ratio: ms[2] / ms[0] };
}

/** `unit` repeated and cut to exactly `size` characters. */
export function repeatTo(unit: string, size: number): string {
  return unit.repeat(Math.ceil(size / unit.length)).slice(0, size);
}

/** `open` repeated as deep as `size` allows around `core`, closed by `close` as many times. */
export function nestTo(open: string, core: string, close: string, size: number): string {
  const depth = Math.floor((size - core.length) / (open.length + close.length));
  return `${open.repeat(depth)}${core}${close.repeat(depth)}`;
}
