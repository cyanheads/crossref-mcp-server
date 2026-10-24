/**
 * @fileoverview Shared metadata coverage projection and rendering tests.
 * @module tests/tools/metadata-coverage.test
 */
import { describe, expect, it } from 'vitest';
import { coverageLines, normalizeCoverage } from '@/mcp-server/tools/metadata-coverage.js';

describe('metadata coverage', () => {
  it('renders exact fractions without losing small values or absent sides', () => {
    expect(
      coverageLines([
        { category: 'abstracts', current: 0.2485188506887631, backfile: 0.07025946968480713 },
        { category: 'licenses', current: 0, backfile: 0.9992563673545269 },
        { category: 'tiny', current: 0.0000138 },
      ]),
    ).toEqual([
      '**Metadata coverage (0–1 fractions, current / backfile):**',
      '- abstracts: 0.2485188506887631 / 0.07025946968480713',
      '- licenses: 0 / 0.9992563673545269',
      '- tiny: 0.0000138 / n/a',
    ]);
  });
  it('preserves zero, absent sides, category ordering, and empty coverage', () => {
    expect(normalizeCoverage()).toBeUndefined();
    expect(normalizeCoverage({})).toEqual([]);
    expect(normalizeCoverage({ 'z-current': 0, 'a-backfile': 1, ignored: 42 })).toEqual([
      { category: 'a', backfile: 1 },
      { category: 'z', current: 0 },
    ]);
  });
});
