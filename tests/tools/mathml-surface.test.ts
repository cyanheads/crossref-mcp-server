/**
 * @fileoverview A MathML formula on both result surfaces, end to end: the real tool definitions
 * and the real `CrossrefService` behind a fetch fake answering with captured Crossref records.
 * `structuredContent` carries the formula as normalization reads it — the deposited TeX
 * annotation, or the presentation tree written out — and `content[]` carries the same text with
 * only the escape a Markdown reader needs, so a TeX subscript keeps its underscore when a
 * CommonMark renderer reads it.
 * @module tests/tools/mathml-surface.test
 */

import { readFileSync } from 'node:fs';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { HtmlRenderer, Parser } from 'commonmark';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { textOf, workList } from '../helpers/crossref-responses.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    mailto: 'test@example.com',
    baseUrl: 'https://api.crossref.test',
    timeoutMs: 10_000,
  }),
}));

import { getWorkTool, searchWorksTool } from '@/mcp-server/tools/definitions/index.js';
import { initCrossrefService } from '@/services/crossref/crossref-service.js';

/** A captured `/works/{doi}` response body. */
function captured(doi: string): { message: Record<string, unknown> } {
  const file = new URL(`../fixtures/mathml/${doi.replace('/', '-')}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8')) as { message: Record<string, unknown> };
}

/** What a CommonMark reader shows for a Markdown document, as HTML. */
function commonmark(markdown: string): string {
  return new HtmlRenderer().render(new Parser().parse(markdown));
}

const http = createFetchMock();

beforeEach(() => {
  http.reset();
  http.install();
  initCrossrefService();
});

afterEach(() => {
  http.restore();
});

/** Answer `/works/{doi}` with the captured record for that DOI. */
function serveWork(doi: string): void {
  http.route({
    match: new RegExp(
      `^https://api\\.crossref\\.test/works/${encodeURIComponent(doi).replaceAll('.', '\\.')}$`,
    ),
    respond: () => Response.json(captured(doi)),
  });
}

async function abstractOf(doi: string) {
  serveWork(doi);
  const result = await runToolContract(getWorkTool, { doi });
  expect(result.isError).toBeFalsy();
  return {
    structured: (result.structuredContent as { abstract?: string }).abstract ?? '',
    text: textOf(result),
  };
}

describe('crossref_get_work on a MathML abstract', () => {
  it('returns the deposited TeX annotation on both surfaces', async () => {
    const { structured, text } = await abstractOf('10.1090/s0025-5718-00-01296-5');

    expect(structured).toContain(
      'if \\sqrt {m}\\in \\mathbb {Q} _{5}\\setminus \\mathbb {Q}, then \\sqrt {m} has',
    );
    expect(structured).toContain('in \\mathbb {Q}_{p} for some larger values of p.');
    // content[] escapes only the underscores a Markdown reader could take for emphasis.
    expect(text).toContain(
      'if \\sqrt {m}\\in \\mathbb {Q} \\_{5}\\setminus \\mathbb {Q}, then \\sqrt {m} has',
    );
    expect(text).toContain('in \\mathbb {Q}\\_{p} for some larger values of p.');
  });

  it('keeps every subscript underscore when a CommonMark reader renders content[]', async () => {
    const { structured, text } = await abstractOf('10.1090/s0025-5718-00-01296-5');
    const html = commonmark(text);

    expect(html).not.toContain('<em>');
    expect(html).toContain('\\mathbb {Q} _{5}\\setminus \\mathbb {Q}, then');
    expect(html).toContain('\\mathbb {Q}_{p} for some');
    expect(structured.split('_').length).toBe(3);
  });

  it('returns each TeX annotation of a multi-formula abstract verbatim', async () => {
    const { structured, text } = await abstractOf('10.1090/s0002-9939-05-08007-x');

    for (const tex of ['A^{-1}(\\mathcal {S}^\\perp )', 'R(A^{1/2})', '(A,\\mathcal {S})']) {
      expect(structured).toContain(tex);
      expect(text).toContain(tex);
    }
    expect(structured).not.toMatch(/A−1|A1\/2/);
  });

  it('writes out presentation MathML that deposits no second encoding', async () => {
    const { structured, text } = await abstractOf('10.1186/s13661-014-0236-x');

    for (const expected of [
      'p^⋆:=(Np)/(N−p)',
      '|u|^{r−1}u',
      'D^{1,p}(R^N)',
      'L^{(p^⋆)/(p^⋆−r−1)}',
    ]) {
      expect(structured).toContain(expected);
    }
    // `Δ_pu` sits between two word characters, so CommonMark cannot read its underscore as a
    // delimiter and content[] leaves it bare; `_{` could open emphasis and is escaped.
    expect(text).toContain('p^⋆:=(Np)/(N−p)');
    expect(text).toContain('{−Δ_pu−Δ_qu=λg(x)|u|^{r−1}u');
    expect(commonmark(text)).not.toContain('<em>');
  });
});

describe('crossref_search_works on a MathML abstract', () => {
  it('returns the same abstract crossref_get_work does', async () => {
    const doi = '10.1090/s0002-9939-05-08007-x';
    const { abstract } = captured(doi).message;
    http.route({
      match: /^https:\/\/api\.crossref\.test\/works\?/,
      respond: () => workList([{ DOI: doi, abstract }]),
    });

    const result = await runToolContract(searchWorksTool, {
      filter: { doi },
      fields: ['abstract'],
      rows: 1,
    });
    const work = (result.structuredContent as { works: Array<{ abstract?: string }> }).works[0];

    expect(work?.abstract).toContain('A^{-1}(\\mathcal {S}^\\perp )');
    expect(work?.abstract).toContain('R(A^{1/2})');
    expect(textOf(result)).toContain('A^{-1}(\\mathcal {S}^\\perp )');
    expect(textOf(result)).toContain('R(A^{1/2})');
    const direct = await abstractOf(doi);
    expect(work?.abstract).toBe(direct.structured);
  });
});
