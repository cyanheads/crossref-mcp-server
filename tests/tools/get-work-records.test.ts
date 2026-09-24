/**
 * @fileoverview crossref_get_work end to end over captured Crossref records: the real tool
 * definition and the real `CrossrefService` behind a fetch fake answering `/works/{doi}` with a
 * record captured from the live registry. Every assertion reads the assembled `CallToolResult`, so
 * `structuredContent` and `content[]` are checked after the enrichment trailer is appended.
 * @module tests/tools/get-work-records.test
 */

import { readFileSync } from 'node:fs';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { HtmlRenderer, Parser } from 'commonmark';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type ToolResult, textOf } from '../helpers/crossref-responses.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    mailto: 'test@example.com',
    baseUrl: 'https://api.crossref.test',
    timeoutMs: 10_000,
  }),
}));

import { getWorkTool } from '@/mcp-server/tools/definitions/index.js';
import { initCrossrefService } from '@/services/crossref/crossref-service.js';

/** Every captured record, by the DOI it is requested under. */
const CAPTURED = [
  '10.1038/s41586-020-2649-2',
  '10.7554/elife.03714',
  '10.1016/j.chemosphere.2021.130212',
  '10.47094/978-65-6036-545-2',
  '10.1016/S0140-6736(20)31180-6',
  '10.1016/s0140-6736(20)31324-6',
  '10.1016/j.apsusc.2007.01.131',
  '10.1103/physrevd.109.023023',
  '10.1109/icetce.2011.5774727',
  '10.1364/opticaopen.29459153.v1',
  '10.1364/OE.572415',
  '10.20944/preprints202302.0051.v34',
  '10.1101/2025.11.10.687519',
  '10.2139/ssrn.4944457',
] as const;

/** The deposited fields the citation, update, and relation outputs read. */
const CITATION_AND_LINK_FIELDS = [
  'volume',
  'issue',
  'page',
  'article-number',
  'ISBN',
  'editor',
  'updated-by',
  'update-to',
  'relation',
] as const;

/** The output keys those fields project to. */
const CITATION_AND_LINK_KEYS = [
  'volume',
  'issue',
  'page',
  'articleNumber',
  'isbn',
  'editors',
  'updatedBy',
  'updateTo',
  'relations',
] as const;

type Message = Record<string, unknown>;

/** A captured `/works/{doi}` response body. */
function captured(doi: string): { message: Message } {
  const name = doi.toLowerCase().replace(/[^a-z0-9.-]/g, '_');
  const file = new URL(`../fixtures/works/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8')) as { message: Message };
}

/** The same record with every citation, update, and relation field removed. */
function stripped(doi: string): { message: Message } {
  const body = captured(doi);
  const message = { ...body.message };
  for (const field of CITATION_AND_LINK_FIELDS) delete message[field];
  return { ...body, message };
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

/**
 * Answer every `/works/{doi}` request with `body(doi)` for the DOI in the path, in place of
 * whatever was served before — routes match in registration order.
 */
function serve(body: (doi: string) => { message: Message }): void {
  http.reset();
  http.route({
    match: /^https:\/\/api\.crossref\.test\/works\/[^?]+$/,
    respond: (request) => {
      const path = new URL(request.url).pathname.slice('/works/'.length);
      return Response.json(body(decodeURIComponent(path)));
    },
  });
}

async function getWork(doi: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
  const result = await runToolContract(getWorkTool, { doi, ...args });
  expect(result.isError, doi).toBeFalsy();
  return result;
}

function structured(result: ToolResult): Record<string, unknown> {
  return { ...(result.structuredContent as Record<string, unknown>) };
}

/** What a CommonMark reader shows for a Markdown document, as HTML. */
function commonmark(markdown: string): string {
  return new HtmlRenderer().render(new Parser().parse(markdown));
}

/**
 * What every captured record returned before the citation, update, and relation fields existed.
 * The first file holds each record's structured output minus the keys those fields add, and the
 * notice on the records whose notice now also names their updates. The second holds both whole
 * surfaces for each record with those fields removed from the deposit — a record depositing none
 * of them has to come back byte-identical, rendered text included.
 */
describe('crossref_get_work output that predates the citation and update fields', () => {
  it('keeps the value and shape of every existing field on every captured record', async () => {
    serve(captured);
    const out: Record<string, unknown> = {};
    for (const doi of CAPTURED) {
      const sc = structured(await getWork(doi));
      for (const key of CITATION_AND_LINK_KEYS) delete sc[key];
      if (captured(doi).message['updated-by'] !== undefined) delete sc.notice;
      out[doi] = sc;
    }
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
      '../fixtures/works/__snapshots__/get-work-existing-fields.snap',
    );
  });

  it('renders a record depositing none of them exactly as before, on both surfaces', async () => {
    serve(stripped);
    const out: Record<string, unknown> = {};
    for (const doi of CAPTURED) {
      const result = await getWork(doi);
      out[doi] = { structuredContent: result.structuredContent, text: textOf(result) };
    }
    await expect(`${JSON.stringify(out, null, 2)}\n`).toMatchFileSnapshot(
      '../fixtures/works/__snapshots__/get-work-stripped-records.snap',
    );
  });
});

describe('crossref_get_work citation fields', () => {
  beforeEach(() => serve(captured));

  it('returns the locators and ISSNs of a paged journal article on both surfaces', async () => {
    const result = await getWork('10.1038/s41586-020-2649-2');
    const sc = structured(result);

    expect(sc).toMatchObject({
      volume: '585',
      issue: '7825',
      page: '357-362',
      issn: ['0028-0836', '1476-4687'],
    });
    expect(sc).not.toHaveProperty('articleNumber');
    const lines = textOf(result).split('\n');
    expect(lines).toContain('**Volume:** 585 | **Issue:** 7825 | **Pages:** 357-362');
    expect(lines).toContain('**ISSN:** 0028-0836, 1476-4687');
  });

  it('returns an article number where the journal numbers articles instead of paging them', async () => {
    const result = await getWork('10.7554/elife.03714');

    expect(structured(result)).toMatchObject({ volume: '3', articleNumber: 'e03714' });
    expect(structured(result)).not.toHaveProperty('page');
    expect(textOf(result).split('\n')).toContain('**Volume:** 3 | **Article number:** e03714');
  });

  it('relays a page and an article number independently when both carry one value', async () => {
    const result = await getWork('10.1016/j.chemosphere.2021.130212');

    expect(structured(result)).toMatchObject({ page: '130212', articleNumber: '130212' });
    expect(textOf(result).split('\n')).toContain(
      '**Volume:** 276 | **Pages:** 130212 | **Article number:** 130212',
    );
  });

  /**
   * The longest editor list found across 6,198 sampled records, on an edited book with one
   * author. Editors are returned whole whatever limit pages the authors, and never reach the
   * author count.
   */
  it('returns the ISBN and all twelve editors of an edited book, apart from its authors', async () => {
    const deposited = captured('10.47094/978-65-6036-545-2').message.editor as Array<{
      given: string;
      family: string;
    }>;
    const result = await getWork('10.47094/978-65-6036-545-2', { limit: 1 });
    const sc = structured(result) as {
      authors: unknown[];
      editors: Array<Record<string, unknown>>;
    };
    const text = textOf(result);

    expect(sc).toMatchObject({ isbn: ['9786560365452'], authorCount: 1, offset: 0 });
    expect(sc.authors).toHaveLength(1);
    expect(sc.editors).toHaveLength(12);
    expect(sc.editors[0]).toEqual({
      given: deposited[0]?.given,
      family: deposited[0]?.family,
      sequence: 'additional',
    });
    // Crossref's role restates the array an entry sits in, so it is not relayed.
    expect(JSON.stringify(sc.editors)).not.toContain('role');
    expect(text).toContain('**ISBN:** 9786560365452');
    expect(text).toContain('**Editors:**');
    for (const editor of deposited) {
      expect(text).toContain(`- ${editor.given} ${editor.family} (additional)`);
    }
    expect(sc).not.toHaveProperty('notice');
  });

  it('omits every citation, update, and relation key on records depositing none', async () => {
    for (const doi of ['10.1101/2025.11.10.687519', '10.2139/ssrn.4944457']) {
      // Both deposit `relation` as an empty map, which is a record relating to nothing.
      expect(captured(doi).message.relation).toEqual({});
      const result = await getWork(doi);
      const sc = structured(result);

      for (const key of CITATION_AND_LINK_KEYS) expect(sc, `${doi} ${key}`).not.toHaveProperty(key);
      expect(sc).not.toHaveProperty('notice');
      expect(textOf(result)).not.toMatch(
        /\*\*(Volume|Issue|Pages|Article number|ISBN|Editors|Updated by|Update notice for|Relations):\*\*/,
      );
    }
  });
});

/** The Lancet paper withdrawn in June 2020: 7 updated-by entries from two sources, 4 update-to. */
const LANCET = '10.1016/S0140-6736(20)31180-6';
const LANCET_UPDATES =
  'Crossref records updates to this work: expression_of_concern (retraction-watch); correction (retraction-watch); retraction (retraction-watch, publisher); erratum (publisher). updatedBy names each notice DOI; call crossref_get_work with one to read it.';

describe('crossref_get_work update links', () => {
  beforeEach(() => serve(captured));

  it('relays every update entry in deposited order, never merging across sources', async () => {
    const result = await getWork(LANCET);
    const sc = structured(result) as {
      updatedBy: Array<Record<string, unknown>>;
      updateTo: Array<Record<string, unknown>>;
    };

    expect(sc.updatedBy.map((u) => [u.doi, u.type, u.source])).toEqual([
      ['10.1016/s0140-6736(20)31290-3', 'expression_of_concern', 'retraction-watch'],
      ['10.1016/s0140-6736(20)31249-6', 'correction', 'retraction-watch'],
      ['10.1016/s0140-6736(20)31324-6', 'retraction', 'retraction-watch'],
      ['10.1016/s0140-6736(20)31174-0', 'retraction', 'publisher'],
      ['10.1016/s0140-6736(20)31324-6', 'erratum', 'publisher'],
      ['10.1016/s0140-6736(20)31528-2', 'erratum', 'publisher'],
      ['10.1016/s0140-6736(20)31249-6', 'erratum', 'publisher'],
    ]);
    expect(sc.updatedBy[2]).toEqual({
      doi: '10.1016/s0140-6736(20)31324-6',
      type: 'retraction',
      source: 'retraction-watch',
      recordId: '23529',
      updated: { year: 2020, month: 6, day: 5 },
    });
    // Only a Retraction Watch entry carries a record ID; the redundant label is dropped.
    expect(sc.updatedBy[3]).not.toHaveProperty('recordId');
    expect(JSON.stringify(sc.updatedBy)).not.toContain('label');
    expect(sc.updateTo).toHaveLength(4);
    expect(sc.updateTo.map((u) => u.doi)).toEqual([
      '10.1016/s0140-6736(20)31174-0',
      '10.1016/s0140-6736(20)31290-3',
      '10.1016/s0140-6736(20)31324-6',
      '10.1016/s0140-6736(20)31528-2',
    ]);

    const text = textOf(result);
    expect(text).toContain(
      '- 10.1016/s0140-6736(20)31324-6 — retraction (retraction-watch, record 23529), 2020-06-05',
    );
    expect(text).toContain('- 10.1016/s0140-6736(20)31324-6 — erratum (publisher), 2020-06-13');
    expect(text).toContain('**Update notice for:**');
    expect(text).toContain('- 10.1016/s0140-6736(20)31528-2 — retraction (publisher), 2020-05-22');
  });

  it('names each update type with its sources in the notice, on both surfaces', async () => {
    const result = await getWork(LANCET);

    expect(structured(result).notice).toBe(LANCET_UPDATES);
    expect(textOf(result)).toContain(LANCET_UPDATES);
    // The notice relays the deposits; it states no status of its own.
    expect(LANCET_UPDATES).not.toMatch(/\b(is|was) (retracted|corrected|valid|current)\b/i);
  });

  it('shares one notice between the update text and the author-paging guidance', async () => {
    const result = await getWork(LANCET, { limit: 2 });
    const sc = structured(result);

    expect(sc).toMatchObject({ nextOffset: 2, truncated: true, shown: 2, cap: 2 });
    expect(sc.notice).toBe(
      `${LANCET_UPDATES} Showing authors 1–2 of 4. Call again with offset=2 for the next page.`,
    );
    expect(textOf(result)).toContain(sc.notice as string);
  });

  it('keeps the update text beside an offset past the end of the author list', async () => {
    const result = await getWork(LANCET, { offset: 9 });

    expect(structured(result).notice).toBe(
      `${LANCET_UPDATES} Offset 9 is past the end of this author list (4 authors). Request an offset below 4.`,
    );
  });

  /**
   * An update made in place names the record itself, so the notice is this record. Pointing
   * the caller at crossref_get_work for it would send them back to the call they just made.
   */
  it('does not send the caller back to the same DOI for an update made in place', async () => {
    for (const doi of ['10.1109/icetce.2011.5774727', '10.1103/physrevd.109.023023']) {
      const result = await getWork(doi);
      const notice = structured(result).notice as string;

      expect(notice, doi).toContain("Every entry names this work's own DOI");
      expect(notice, doi).not.toContain('call crossref_get_work');
    }
    const rw = structured(await getWork('10.1109/icetce.2011.5774727'));
    expect(rw.notice).toMatch(
      /^Crossref records updates to this work: retraction \(retraction-watch\)\./,
    );
    expect(rw.updatedBy).toEqual([
      {
        doi: '10.1109/icetce.2011.5774727',
        type: 'retraction',
        source: 'retraction-watch',
        recordId: '25991',
        updated: { year: 2011, month: 5, day: 27 },
      },
    ]);
  });

  it('qualifies the pointer when only some entries name the record itself', async () => {
    const doi = '10.1103/physrevd.109.023023';
    serve(() => {
      const body = captured(doi);
      const [own] = body.message['updated-by'] as Array<Record<string, unknown>>;
      return {
        ...body,
        message: {
          ...body.message,
          'updated-by': [own, { ...own, DOI: '10.1103/physrevd.110.069901', type: 'erratum' }],
        },
      };
    });

    const notice = structured(await getWork(doi)).notice as string;

    expect(notice).toBe(
      "Crossref records updates to this work: correction (publisher); erratum (publisher). updatedBy names each notice DOI; call crossref_get_work with one other than this work's own to read it — an entry naming this work's DOI records an update made to this record in place.",
    );
  });

  it('relays a notice DOI Retraction Watch and the publisher type differently', async () => {
    const result = await getWork('10.1016/j.apsusc.2007.01.131');

    expect(structured(result).updatedBy).toEqual([
      {
        doi: '10.1016/j.apsusc.2017.07.145',
        type: 'retraction',
        source: 'retraction-watch',
        recordId: '11459',
        updated: { year: 2017, month: 7, day: 24 },
      },
      {
        doi: '10.1016/j.apsusc.2017.07.145',
        type: 'erratum',
        source: 'publisher',
        updated: { year: 2017, month: 10, day: 31 },
      },
    ]);
    expect(structured(result).notice).toMatch(
      /^Crossref records updates to this work: retraction \(retraction-watch\); erratum \(publisher\)\. updatedBy names each notice DOI; call crossref_get_work with one to read it\.$/,
    );
  });

  /**
   * A notice's own record lists what it updates in updateTo. That is not an update to it, so it
   * raises no notice on its own — the publisher's erroneous update-to on the retracted paper
   * above would otherwise read as that paper being a retraction.
   */
  it('raises no update notice for updateTo alone', async () => {
    serve((doi) => {
      const body = captured(doi);
      const { 'updated-by': _dropped, ...message } = body.message;
      return { ...body, message };
    });

    const result = await getWork('10.1016/s0140-6736(20)31324-6');
    const sc = structured(result);

    expect(sc.updateTo).toHaveLength(3);
    expect(sc).not.toHaveProperty('updatedBy');
    expect(sc).not.toHaveProperty('notice');
  });
});

describe('crossref_get_work relations', () => {
  beforeEach(() => serve(captured));

  it('returns a preprint link to its published version', async () => {
    const result = await getWork('10.1364/opticaopen.29459153.v1');

    expect(structured(result).relations).toEqual([
      { type: 'is-preprint-of', idType: 'doi', assertedBy: 'subject', ids: ['10.1364/OE.572415'] },
    ]);
    expect(textOf(result)).toContain(
      '- is-preprint-of (doi, asserted by subject): 10.1364/OE.572415',
    );
  });

  it('keeps an identifier asserted by both parties under each of them', async () => {
    const result = await getWork('10.1364/OE.572415');

    expect(structured(result).relations).toEqual([
      {
        type: 'has-preprint',
        idType: 'doi',
        assertedBy: 'subject',
        ids: ['10.1364/opticaopen.29459153'],
      },
      {
        type: 'has-preprint',
        idType: 'doi',
        assertedBy: 'object',
        ids: ['10.1364/opticaopen.29459153', '10.1364/opticaopen.29459153.v1'],
      },
    ]);
  });

  it('groups each relation type by identifier scheme, in Crossref order', async () => {
    const result = await getWork('10.7554/elife.03714');
    const relations = structured(result).relations as Array<Record<string, unknown>>;

    expect(
      relations.map((r) => [r.type, r.idType, r.assertedBy, (r.ids as unknown[]).length]),
    ).toEqual([
      ['references', 'uri', 'subject', 3],
      ['is-supplemented-by', 'uri', 'subject', 6],
      ['has-review', 'doi', 'object', 2],
    ]);
    // A URI identifier is relayed byte-exact on both surfaces — it is what a reader copies.
    expect(textOf(result)).toContain(
      'http://www.pdb.org/pdb/explore/explore.do?structureId=4Q1Q, http://www.pdb.org/pdb/explore/explore.do?structureId=2H1H',
    );
  });

  /** The longest relation list found in a 4,495-record draw: a 101-version preprint chain. */
  it('returns all 199 identifiers of a long version chain', async () => {
    const doi = '10.20944/preprints202302.0051.v34';
    const deposited = captured(doi).message.relation as Record<string, Array<{ id: string }>>;
    const result = await getWork(doi);
    const relations = structured(result).relations as Array<{
      type: string;
      assertedBy: string;
      ids: string[];
    }>;
    const text = textOf(result);

    expect(relations.map((r) => [r.type, r.assertedBy, r.ids.length])).toEqual([
      ['is-version-of', 'subject', 99],
      ['has-version', 'object', 100],
    ]);
    expect(relations[0]?.ids).toEqual(deposited['is-version-of']?.map((e) => e.id));
    expect(relations[1]?.ids).toEqual(deposited['has-version']?.map((e) => e.id));
    for (const id of relations.flatMap((r) => r.ids)) expect(text).toContain(id);
  });

  /**
   * Every new section is a list of its own. A label written straight after a bullet is read by a
   * CommonMark renderer as more of that bullet, which would bury the author heading inside the
   * last relation.
   */
  it('keeps each section and the author heading out of the list above it', async () => {
    const html = commonmark(textOf(await getWork(LANCET)));

    for (const label of ['Updated by:', 'Update notice for:', 'Relations:', 'Authors:']) {
      expect(html).toContain(`<p><strong>${label}</strong>`);
    }
  });
});
