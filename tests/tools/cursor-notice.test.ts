/**
 * @fileoverview Cursor plausibility is advisory and keeps DOI punctuation intact.
 * @module tests/tools/cursor-notice.test
 */
import { describe, expect, it } from 'vitest';
import { cursorNotice } from '@/mcp-server/tools/cursor-notice.js';
import { expectLinearScaling, repeatTo } from '../helpers/scaling.js';

describe('cursor advisory', () => {
  it.each([
    [undefined, false],
    ['*', false],
    [btoa('123,10.5555%2Farticle,a'), false],
    [btoa('score,10.5555/a'), false],
    ['bogus', true],
    ['garbage', true],
    [btoa('123,1'), true],
    [btoa(',10.5555/a'), true],
    [btoa(' ,10.5555/a'), true],
    [btoa('123,doi:10.5555/a'), true],
    [btoa('123,10.5555%ZZ/a'), true],
    [btoa('123,10.5555%2Fa%20b'), true],
    [btoa('123,'), true],
  ])('classifies %s without rejecting it', (cursor, warning) => {
    expect(cursorNotice(cursor) !== undefined).toBe(warning);
  });

  it.each([
    ['invalid DOI tail', (size: number) => btoa(`123,10.${'5'.repeat(Math.floor(size * 0.7))}`)],
    ['malformed escapes', (size: number) => btoa(`1,${repeatTo('%', Math.floor(size * 0.7))}`)],
    ['line breaks', (size: number) => repeatTo('YWJj\n', size)],
    ['unclosed prefix', (size: number) => repeatTo('a', size)],
  ])('stays linear on %s', (_name, make) => {
    expectLinearScaling(make, cursorNotice);
  });
});
