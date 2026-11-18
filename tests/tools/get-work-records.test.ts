/**
 * @fileoverview crossref_get_work end to end over captured Crossref records: the real tool
 * definition and the real `CrossrefService` behind a fetch fake answering `/works/{doi}` with a
 * record captured from the live registry, and a preprint's published-version lookup with the
 * answer captured for it. Every assertion reads the assembled `CallToolResult`, so
 * `structuredContent` and `content[]` are checked after the enrichment trailer is appended.
 * @module tests/tools/get-work-records.test
 */

import { readFileSync } from 'node:fs';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { createFetchMock, runToolContract } from '@cyanheads/mcp-ts-core/testing';
import { HtmlRenderer, Parser } from 'commonmark';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderedText } from '../helpers/content.js';
import { hang, type ToolResult, textOf, workList } from '../helpers/crossref-responses.js';

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    mailto: 'test@example.com',
    baseUrl: 'https://api.crossref.test',
    timeoutMs: 10_000,
  }),
}));

import { getWorkTool, searchWorksTool } from '@/mcp-server/tools/definitions/index.js';
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
  '10.35802/220488',
  '10.61686/aialz48365',
  '10.69777/334076',
  '10.5194/amt-2017-159-rc2',
  '10.32388/kkcnxz',
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

/**
 * The output keys added after those: every container title beside the first, and the member
 * that holds the DOI. `containerTitles` reads a field `containerTitle` already read, so only
 * `member` can be left out of a deposit.
 */
const CONTAINER_AND_MEMBER_KEYS = ['containerTitles', 'memberId'] as const;

/**
 * The deposited fields added after those, which say where a work comes from beyond its
 * publisher: the conference event of a proceedings paper, the approval date of a dissertation or
 * standard, and the institutions, degree, subtype, and group title of a thesis, report, or
 * preprint.
 */
const ORIGIN_FIELDS = [
  'event',
  'approved',
  'institution',
  'degree',
  'subtype',
  'group-title',
] as const;

/** The output keys those fields project to. */
const ORIGIN_KEYS = [
  'event',
  'approved',
  'institutions',
  'degree',
  'subtype',
  'groupTitle',
] as const;

/**
 * The deposited fields added after those: the clinical trial registrations a work names, and the
 * Crossmark assertions its publisher attaches — article history, ethics statements, peer review.
 */
const TRIAL_AND_ASSERTION_FIELDS = ['clinical-trial-number', 'assertion'] as const;

/** The output keys those fields project to. */
const TRIAL_AND_ASSERTION_KEYS = ['clinicalTrialNumbers', 'assertions'] as const;

/**
 * The deposited fields added after those, which a grant and a peer review carry in place of a
 * work's title and abstract: a grant's award number, award start, and projects, and a peer
 * review's review details.
 */
const GRANT_AND_REVIEW_FIELDS = ['award', 'award-start', 'project', 'review'] as const;

/**
 * The output keys those fields project to. `offset` is one of them on a record depositing no
 * author list: there it echoes the investigator page, and before investigators it was absent.
 */
const GRANT_AND_REVIEW_KEYS = [
  'award',
  'awardStart',
  'projects',
  'investigatorCount',
  'review',
] as const;

/**
 * The output key added after those, read by a second request rather than from the record: the
 * works naming a posted-content preprint in `has-preprint`.
 */
const PUBLISHED_VERSION_KEYS = ['publishedVersions'] as const;

type Message = Record<string, unknown>;

/** The fixture file name a DOI is captured under. */
function fixtureName(doi: string): string {
  return doi.toLowerCase().replace(/[^a-z0-9.-]/g, '_');
}

/** A captured `/works/{doi}` response body. */
function captured(doi: string): { message: Message } {
  const file = new URL(`../fixtures/works/${fixtureName(doi)}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8')) as { message: Message };
}

/**
 * A captured answer to the published-version lookup for a preprint: the `/works` list of the
 * works naming it in `has-preprint`, as Crossref answered on 2026-11-17.
 */
function publishedVersionsOf(doi: string): { message: Message } {
  const file = new URL(`../fixtures/works/has-preprint/${fixtureName(doi)}.json`, import.meta.url);
  return JSON.parse(readFileSync(file, 'utf8')) as { message: Message };
}

/** Whether a request is the published-version lookup, rather than a record read. */
function isLookup(request: Request): boolean {
  const url = new URL(request.url);
  return (
    url.origin === 'https://api.crossref.test' &&
    url.pathname === '/works' &&
    url.searchParams.get('filter')?.startsWith('relation.type:has-preprint,') === true
  );
}

/** The DOI a published-version lookup asks about. */
function lookedUp(request: Request): string {
  const filter = new URL(request.url).searchParams.get('filter') ?? '';
  return filter.slice('relation.type:has-preprint,relation.object:'.length);
}

/**
 * The same record with every citation, update, relation, origin, trial, assertion, grant, and
 * review field, and its member, removed.
 */
function stripped(doi: string): { message: Message } {
  const body = captured(doi);
  const message = { ...body.message };
  for (const field of [
    ...CITATION_AND_LINK_FIELDS,
    ...ORIGIN_FIELDS,
    ...TRIAL_AND_ASSERTION_FIELDS,
    ...GRANT_AND_REVIEW_FIELDS,
  ])
    delete message[field];
  delete message.member;
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
 * Answer every `/works/{doi}` request with `body(doi)` for the DOI in the path, and every
 * published-version lookup with `lookup(request)` — by default the captured answer for the DOI it
 * asks about — in place of whatever was served before. Routes match in registration order.
 */
function serve(
  body: (doi: string) => { message: Message },
  lookup: (request: Request) => Response | Promise<Response> = (request) =>
    Response.json(publishedVersionsOf(lookedUp(request))),
): void {
  http.reset();
  http.route(
    {
      match: /^https:\/\/api\.crossref\.test\/works\/[^?]+$/,
      respond: (request) => {
        const path = new URL(request.url).pathname.slice('/works/'.length);
        return Response.json(body(decodeURIComponent(path)));
      },
    },
    { match: isLookup, respond: lookup },
  );
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
 * The first file holds each record's structured output minus the keys those fields, the
 * container and member fields, the origin fields, the trial and assertion fields, and the grant
 * and review fields add, and the published versions a preprint's second request adds, and the
 * notice on the records whose notice now also names their updates.
 * The grants and peer reviews in it were captured after the others, so their entries hold what
 * the server returned for them before grant and review fields existed. The second holds both
 * whole surfaces for each record with those fields and its member removed from the deposit — a
 * record depositing none of them has to come back byte-identical, rendered text included, beside
 * the `containerTitles` its one container title now also fills.
 */
describe('crossref_get_work output that predates the citation and update fields', () => {
  it('keeps the value and shape of every existing field on every captured record', async () => {
    serve(captured);
    const out: Record<string, unknown> = {};
    for (const doi of CAPTURED) {
      const sc = structured(await getWork(doi));
      for (const key of [
        ...CITATION_AND_LINK_KEYS,
        ...CONTAINER_AND_MEMBER_KEYS,
        ...ORIGIN_KEYS,
        ...TRIAL_AND_ASSERTION_KEYS,
        ...GRANT_AND_REVIEW_KEYS,
        ...PUBLISHED_VERSION_KEYS,
      ])
        delete sc[key];
      if (captured(doi).message.author === undefined) delete sc.offset;
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

/** A book chapter depositing its series and then its book as two container titles. */
const CHAPTER = '10.1007/978-3-030-58452-8_1';

describe('crossref_get_work container titles', () => {
  beforeEach(() => serve(captured));

  it('returns every container title of a book chapter in deposited order, on both surfaces', async () => {
    const result = await getWork(CHAPTER);

    expect(structured(result)).toMatchObject({
      containerTitle: 'Lecture Notes in Computer Science',
      containerTitles: ['Lecture Notes in Computer Science', 'Computer Vision – ECCV 2020'],
    });
    expect(renderedText(textOf(result)).split('\n')).toContain(
      'Journal/Container: Lecture Notes in Computer Science | Computer Vision – ECCV 2020',
    );
  });

  it('returns a one-entry list beside a single container title, with the line unchanged', async () => {
    const result = await getWork('10.1038/s41586-020-2649-2');

    expect(structured(result)).toMatchObject({
      containerTitle: 'Nature',
      containerTitles: ['Nature'],
    });
    expect(textOf(result).split('\n')).toContain('**Journal/Container:** Nature');
  });

  it('returns neither field for a record depositing no container title', async () => {
    const doi = '10.1101/2025.11.10.687519';
    expect(captured(doi).message['container-title']).toEqual([]);
    const result = await getWork(doi);

    expect(structured(result)).not.toHaveProperty('containerTitle');
    expect(structured(result)).not.toHaveProperty('containerTitles');
    expect(textOf(result)).not.toContain('**Journal/Container:**');
  });
});

/** A proceedings paper depositing the conference it was presented at. */
const PROCEEDINGS = '10.1109/icetce.2011.5774727';

/**
 * The event is one shared projection and line, tabled in `work-dates.test.ts`; these cases prove
 * crossref_get_work wires it in, on a captured record that deposits one and one that does not.
 */
describe('crossref_get_work event', () => {
  beforeEach(() => serve(captured));

  it('returns the conference of a proceedings paper on both surfaces', async () => {
    const result = await getWork(PROCEEDINGS);

    expect(structured(result).event).toEqual({
      name: '2011 International Conference on Electric Technology and Civil Engineering (ICETCE)',
      location: 'Lushan',
      start: { year: 2011, month: 4, day: 22 },
      end: { year: 2011, month: 4, day: 24 },
    });
    expect(textOf(result).split('\n')).toContain(
      '**Event:** 2011 International Conference on Electric Technology and Civil Engineering (ICETCE), Lushan, 2011-04-22 – 2011-04-24',
    );
  });

  it('omits event, and its line, for a record depositing none', async () => {
    expect(captured('10.7554/elife.03714').message.event).toBeUndefined();
    const result = await getWork('10.7554/elife.03714');

    expect(structured(result)).not.toHaveProperty('event');
    expect(textOf(result)).not.toContain('**Event:**');
  });
});

/**
 * A dissertation deposits its date only as `approved`, beside an `issued` of `[[null]]` and no
 * published date of any kind.
 */
const THESIS = '10.11606/t.48.2015.tde-14122015-153241';

/**
 * The approval date is one shared projection and line, tabled in `work-dates.test.ts`; these
 * cases prove crossref_get_work wires it in and keeps it out of `published`.
 */
describe('crossref_get_work approval date', () => {
  beforeEach(() => serve(captured));

  it('returns the approval date of a dissertation on both surfaces, and no publication date', async () => {
    const deposited = captured(THESIS).message;
    expect(deposited.issued).toEqual({ 'date-parts': [[null]] });
    for (const key of ['published', 'published-print', 'published-online']) {
      expect(deposited, key).not.toHaveProperty(key);
    }
    const result = await getWork(THESIS);
    const lines = textOf(result).split('\n');

    expect(structured(result).approved).toEqual({ year: 2015, month: 9, day: 22 });
    expect(lines).toContain('**Approved:** 2015-09-22');
    expect(structured(result)).not.toHaveProperty('published');
    expect(lines.some((line) => line.startsWith('**Published:**'))).toBe(false);
  });

  it('omits approved, and its line, for a record depositing none', async () => {
    const result = await getWork('10.2172/207649');

    expect(structured(result)).not.toHaveProperty('approved');
    expect(structured(result).published).toEqual({ year: 1996, month: 2, day: 1 });
    expect(textOf(result)).not.toContain('**Approved:**');
  });
});

/**
 * A structured abstract's lists and empty sections, read through both tools the abstract
 * normalizer serves. medRxiv deposits its highlights as list items with no closing punctuation,
 * then a "Visual Abstract:" section holding only a figure; BMC closes on a "Graphical Abstract"
 * section holding nothing.
 */
describe('crossref_get_work and crossref_search_works on a structured abstract', () => {
  const HIGHLIGHTED = '10.1101/2025.10.16.25338155';
  const HIGHLIGHTS =
    'Highlights: This systematic review investigated whether greenspace protects against respiratory health harms from air pollution; We identified 12 eligible cohort studies, all rated "good" quality; Results mixed but generally suggested greenspace is protective; More consistent findings for mediated pathways, suggesting greenspace reduces pollution in local environment';

  beforeEach(() => serve(captured));

  it('joins list items and drops a figure-only section, on both tools and both surfaces', async () => {
    http.route({
      match: /^https:\/\/api\.crossref\.test\/works\?/,
      respond: () => workList([captured(HIGHLIGHTED).message]),
    });
    const single = await getWork(HIGHLIGHTED);
    const search = await runToolContract(searchWorksTool, {
      filter: { doi: HIGHLIGHTED },
      fields: ['DOI', 'abstract'],
    });
    expect(search.isError).toBeFalsy();

    const abstract = String(structured(single).abstract);
    expect(abstract.slice(-HIGHLIGHTS.length - 1)).toBe(` ${HIGHLIGHTS}`);
    const works = (search.structuredContent as { works: Array<{ abstract?: string }> }).works;
    expect(works[0]?.abstract).toBe(abstract);
    for (const result of [single, search]) {
      const text = renderedText(textOf(result));
      expect(text).toContain(`${HIGHLIGHTS}\n`);
      expect(text).not.toContain('Visual Abstract');
    }
  });

  it('drops a closing section that holds no text, on both surfaces', async () => {
    const result = await getWork('10.1186/s13071-025-06765-4');
    const closing =
      'Therefore, we recommend using Aquatain in mosquito control programs as a complementary malaria vector control tool.';

    const abstract = String(structured(result).abstract);
    expect(abstract.endsWith(closing)).toBe(true);
    expect(abstract).not.toContain('Graphical Abstract');
    const lines = renderedText(textOf(result)).split('\n');
    expect(lines[lines.indexOf('Abstract:') + 1]).toBe(abstract);
  });
});

/**
 * The lines of the labelled list `label` opens in a result's `content[]`: every line after it up
 * to the blank line that closes the list.
 */
function listUnder(result: ToolResult, label: string): string[] {
  const lines = textOf(result).split('\n');
  const start = lines.indexOf(label);
  if (start < 0) return [];
  const end = lines.indexOf('', start);
  return lines.slice(start + 1, end < 0 ? undefined : end);
}

const TRIAL = '10.1038/s41598-025-13404-6';
const TRIAL_HEADING = '**Clinical trial numbers:**';
const ASSERTION_HEADING = '**Assertions:**';

/**
 * Clinical trial numbers and Crossmark assertions, returned whole in deposited order. Springer
 * Nature tells its ethics statements apart only by group label — every one is `name: "Ethics"` in
 * group `EthicsHeading` — and deposits a value-less "Declarations" entry heading them.
 */
describe('crossref_get_work clinical trial numbers and assertions', () => {
  beforeEach(() => serve(captured));

  it('returns the trial number and all seven assertions in deposited order on both surfaces', async () => {
    const result = await getWork(TRIAL);

    expect(structured(result).clinicalTrialNumbers).toEqual([
      { number: 'nct04861831', registry: '10.18810/clinical-trials-gov' },
    ]);
    const history = { group: 'ArticleHistory', groupLabel: 'Article History' };
    const ethics = { name: 'Ethics', group: 'EthicsHeading' };
    expect(structured(result).assertions).toEqual([
      { name: 'received', value: '20 January 2025', label: 'Received', ...history },
      { name: 'accepted', value: '23 July 2025', label: 'Accepted', ...history },
      { name: 'first_online', value: '7 August 2025', label: 'First Online', ...history },
      { ...ethics, groupLabel: 'Declarations' },
      {
        ...ethics,
        groupLabel: 'Competing interests',
        value:
          'Author Jay Goldfarb is the Founder and Director of Legacy of Wisdom, one of the organisations that provided funding for this study. Jay Goldfarb was involved only in the design of the intervention and in the organisation of the training sessions. He had no involvement in data cleaning, data management, analysis, or interpretation of the results. All other authors declare no competing interests.',
      },
      {
        ...ethics,
        groupLabel: 'Ethical approval',
        value:
          'The trial was conducted according to the principles outlined in the Declaration of Helsinki and was approved by the local Ethics Committee (Ethikkommission Nordwest- und Zentralschweiz EKNZ, BASEC ID 2018-00067) and has been registered on (NCT04861831). All participants provided written informed consent prior to their inclusion in the study.',
      },
      {
        ...ethics,
        groupLabel: 'Informed consent',
        value:
          'Informed consent was obtained from all individual participants included in the study prior to its commencement.',
      },
    ]);

    expect(listUnder(result, TRIAL_HEADING)).toEqual([
      '- nct04861831 — 10.18810/clinical-trials-gov',
    ]);
    const assertions = listUnder(result, ASSERTION_HEADING);
    expect(assertions).toHaveLength(7);
    expect(assertions.slice(0, 4)).toEqual([
      '- Article History (ArticleHistory) — Received (received): 20 January 2025',
      '- Article History (ArticleHistory) — Accepted (accepted): 23 July 2025',
      '- Article History (ArticleHistory) — First Online (first_online): 7 August 2025',
      '- Declarations (EthicsHeading) — Ethics',
    ]);
    expect(assertions[4]).toMatch(/^- Competing interests \(EthicsHeading\) — Ethics: Author Jay/);
    expect(assertions[5]).toMatch(/^- Ethical approval \(EthicsHeading\) — Ethics: The trial was/);
    expect(assertions[6]).toMatch(/^- Informed consent \(EthicsHeading\) — Ethics: Informed/);
  });

  it('renders both lists after the funders, each opened by a blank line', async () => {
    const lines = textOf(await getWork(TRIAL)).split('\n');
    const funders = lines.indexOf('**Funders:**');
    const trials = lines.indexOf(TRIAL_HEADING);
    const assertions = lines.indexOf(ASSERTION_HEADING);

    expect(funders).toBeGreaterThan(-1);
    expect(trials).toBeGreaterThan(funders);
    expect(assertions).toBeGreaterThan(trials);
    expect(lines[trials - 1]).toBe('');
    expect(lines[assertions - 1]).toBe('');
    expect(lines.indexOf('**Licenses:**')).toBeGreaterThan(assertions);
  });

  it('reads a value deposited with inline markup as plain text on both surfaces', async () => {
    const result = await getWork('10.1186/s40425-019-0765-z');
    const approval = (structured(result).assertions as Array<{ value?: string }>)[3]?.value ?? '';

    expect(approval).toContain(
      'guidance issued in ‘Responsibility in the case of Animals in Bioscience research: expectations of the major research council and charitable funding bodies.’',
    );
    expect(approval).not.toMatch(/[<>\n]/);
    expect(renderedText(textOf(result))).toContain(
      `Ethics approval and consent to participate (EthicsHeading) — Ethics: ${approval}\n`,
    );
  });

  it('relays a URL that differs from its value, and collapses a value with whitespace runs', async () => {
    const result = await getWork('10.1039/c8tx00041g');

    expect(structured(result).assertions).toEqual([
      {
        name: 'similarity_check',
        value: 'This document is Similarity Check deposited',
        group: 'similarity_check',
        groupLabel: 'SIMILARITY CHECK',
        explanationUrl: 'https://www.crossref.org/services/similarity-check/',
      },
      {
        name: 'related_data',
        value: 'Supplementary Information',
        url: 'https://doi.org/10.1039/C8TX00041G',
        group: 'related_data',
        groupLabel: 'RELATED DATA',
      },
      {
        name: 'identifier',
        value: 'Ali H. Alhasan (ORCID)',
        url: 'http://orcid.org/0000-0001-9181-3792',
        group: 'author_identifiers',
        groupLabel: 'IDENTIFIERS',
      },
      {
        name: 'peer_review_method',
        value: 'Single-blind',
        group: 'peer_review_method',
        groupLabel: 'PEER REVIEW METHOD',
      },
      {
        name: 'history',
        value:
          'Received 29 January 2018; Accepted 22 May 2018; Accepted Manuscript published 23 May 2018; Advance Article published 14 June 2018; Version of Record published 28 August 2018',
        group: 'publication_history',
        groupLabel: 'PUBLICATION HISTORY',
      },
    ]);
    expect(listUnder(result, ASSERTION_HEADING).slice(0, 3)).toEqual([
      '- SIMILARITY CHECK (similarity_check) — similarity_check: This document is Similarity Check deposited — explanation: https://www.crossref.org/services/similarity-check/',
      '- RELATED DATA (related_data) — related_data: Supplementary Information — URL: https://doi.org/10.1039/C8TX00041G',
      '- IDENTIFIERS (author_identifiers) — identifier: Ali H. Alhasan (ORCID) — URL: http://orcid.org/0000-0001-9181-3792',
    ]);
  });

  it('relays an explanation URL, and a group deposited without a label', async () => {
    const result = await getWork('10.22261/jea.5gsnt8');
    const assertions = structured(result).assertions as Array<Record<string, string>>;

    expect(assertions).toHaveLength(8);
    expect(assertions[0]).toEqual({
      name: 'content_type',
      value: 'Original paper',
      label: 'Content type',
      group: 'content_type',
    });
    expect(assertions[7]).toMatchObject({
      name: 'license',
      label: 'License',
      group: 'copyright_and_licensing',
      groupLabel: 'Copyright and licensing',
      explanationUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
    });
    const lines = listUnder(result, ASSERTION_HEADING);
    expect(lines[0]).toBe('- content_type — Content type (content_type): Original paper');
    expect(lines[7]).toMatch(
      /^- Copyright and licensing \(copyright_and_licensing\) — License \(license\): This is an open access article .* — explanation: https:\/\/creativecommons\.org\/licenses\/by-nc\/4\.0\/$/,
    );
  });

  it('returns all 34 trial numbers in deposited order, the repeated one included', async () => {
    const deposited = captured('10.1136/gutjnl-2023-331742').message[
      'clinical-trial-number'
    ] as Array<{
      'clinical-trial-number': string;
    }>;
    const result = await getWork('10.1136/gutjnl-2023-331742');
    const trials = structured(result).clinicalTrialNumbers as Array<{ number: string }>;

    expect(trials).toHaveLength(34);
    expect(trials.map((t) => t.number)).toEqual(deposited.map((t) => t['clinical-trial-number']));
    expect(trials.filter((t) => t.number === 'nct04136184')).toHaveLength(2);
    expect(trials[4]?.number).toBe('nct04136184');
    expect(trials[6]?.number).toBe('nct04136184');
    const lines = listUnder(result, TRIAL_HEADING);
    expect(lines).toHaveLength(34);
    expect(lines.filter((line) => line.startsWith('- nct04136184 — '))).toHaveLength(2);
    expect(structured(result)).not.toHaveProperty('assertions');
    expect(textOf(result)).not.toContain(ASSERTION_HEADING);
  });

  /** Both lists are returned whole: the author page bounds the author list and nothing else. */
  it('returns every entry whatever author page is requested, past the end of the list included', async () => {
    const whole = await getWork('10.1136/gutjnl-2023-331742');
    const small = await getWork('10.1136/gutjnl-2023-331742', { limit: 1 });
    const past = await getWork('10.1136/gutjnl-2023-331742', { offset: 100_000 });

    expect(structured(whole).clinicalTrialNumbers).toHaveLength(34);
    for (const result of [small, past]) {
      expect(structured(result).clinicalTrialNumbers).toEqual(
        structured(whole).clinicalTrialNumbers,
      );
      expect(listUnder(result, TRIAL_HEADING)).toEqual(listUnder(whole, TRIAL_HEADING));
    }
  });

  it('omits both keys, and both lists, on a record depositing neither', async () => {
    const deposited = captured('10.7554/elife.03714').message;
    expect(deposited).not.toHaveProperty('assertion');
    expect(deposited).not.toHaveProperty('clinical-trial-number');
    const result = await getWork('10.7554/elife.03714');

    expect(structured(result)).not.toHaveProperty('clinicalTrialNumbers');
    expect(structured(result)).not.toHaveProperty('assertions');
    expect(textOf(result)).not.toContain(TRIAL_HEADING);
    expect(textOf(result)).not.toContain(ASSERTION_HEADING);
  });

  it('omits each list deposited empty, like one never deposited', async () => {
    serve(stripped);
    const absent = await getWork(TRIAL);
    serve((doi) => {
      const body = stripped(doi);
      return { ...body, message: { ...body.message, assertion: [], 'clinical-trial-number': [] } };
    });
    const empty = await getWork(TRIAL);

    expect(empty.structuredContent).not.toHaveProperty('clinicalTrialNumbers');
    expect(empty.structuredContent).not.toHaveProperty('assertions');
    expect(empty.structuredContent).toEqual(absent.structuredContent);
    expect(textOf(empty)).toBe(textOf(absent));
  });
});

/** Every line of a result's `content[]` that opens with `label`. */
function linesStarting(result: ToolResult, label: string): string[] {
  return textOf(result)
    .split('\n')
    .filter((line) => line.startsWith(label));
}

/**
 * The institution, degree, subtype, and group title a record deposits. Read wherever deposited —
 * a thesis names its awarding institution, a preprint its server, a report its laboratories — and
 * kept apart from publisher, which for many theses names a library and for many preprints the
 * platform company.
 */
describe('crossref_get_work institutions, degree, subtype, and group title', () => {
  beforeEach(() => serve(captured));

  it('returns the awarding institution and degree of a thesis on both surfaces', async () => {
    const result = await getWork(THESIS);
    const sc = structured(result);

    expect(sc.institutions).toEqual([
      {
        name: 'Universidade de São Paulo',
        place: ['São Paulo'],
        department: ['Faculdade de Educação'],
      },
    ]);
    expect(sc.degree).toEqual(['Doutorado em Educação']);
    expect(sc.publisher).toBe(
      'Universidade de São Paulo. Agência de Bibliotecas e Coleções Digitais',
    );
    expect(sc).not.toHaveProperty('subtype');
    expect(sc).not.toHaveProperty('groupTitle');
    expect(linesStarting(result, '**Institution:**')).toEqual([
      '**Institution:** Universidade de São Paulo — place: São Paulo; department: Faculdade de Educação',
    ]);
    expect(linesStarting(result, '**Degree:**')).toEqual(['**Degree:** Doutorado em Educação']);
  });

  it('leads an institution deposited by ROR alone with its ROR', async () => {
    const result = await getWork('10.14264/d171147');

    expect(structured(result).institutions).toEqual([
      { ror: 'https://ror.org/00rqy9422', department: ['School of Biological Sciences'] },
    ]);
    expect(structured(result).degree).toEqual(['PhD Thesis']);
    expect(linesStarting(result, '**Institution:**')).toEqual([
      '**Institution:** https://ror.org/00rqy9422 — department: School of Biological Sciences',
    ]);
  });

  /** A Wikidata ID is no identifier this projection reads, so the entry carries neither field. */
  it('renders an institution with neither a name nor a ROR the way an affiliation is', async () => {
    const result = await getWork('10.61147/oee-00043966');

    expect(structured(result).institutions).toEqual([{}]);
    expect(linesStarting(result, '**Institution:**')).toEqual([
      '**Institution:** (no name deposited)',
    ]);
  });

  it('returns every institution of a report, in deposited order', async () => {
    const result = await getWork('10.2172/207649');

    expect(structured(result).institutions).toEqual([
      {
        name: 'Pacific Northwest National Laboratory (PNNL), Richland, WA (United States)',
        acronym: ['PNNL'],
      },
      { name: 'Pacific Northwest Lab., Richland, WA (United States)' },
      { name: 'USDOE, Washington, DC (United States)' },
    ]);
    expect(structured(result)).not.toHaveProperty('degree');
    expect(linesStarting(result, '**Institution:**')).toEqual([
      '**Institution:** Pacific Northwest National Laboratory (PNNL), Richland, WA (United States) — acronym: PNNL',
      '**Institution:** Pacific Northwest Lab., Richland, WA (United States)',
      '**Institution:** USDOE, Washington, DC (United States)',
    ]);
  });

  it('returns the server, subtype, and group title of a preprint on both surfaces', async () => {
    const result = await getWork('10.1101/2025.11.10.687519');

    expect(structured(result)).toMatchObject({
      institutions: [{ name: 'bioRxiv' }],
      subtype: 'preprint',
      groupTitle: 'Neuroscience',
      publisher: 'openRxiv',
    });
    expect(textOf(result).split('\n')).toEqual(
      expect.arrayContaining([
        '**DOI:** 10.1101/2025.11.10.687519 | **Type:** posted-content | **Subtype:** preprint',
        '**Institution:** bioRxiv',
        '**Group:** Neuroscience',
      ]),
    );
  });

  it('returns a subtype and group title without an institution or degree it lacks', async () => {
    const result = await getWork('10.2139/ssrn.4944457');
    const sc = structured(result);

    expect(sc).toMatchObject({ subtype: 'preprint', groupTitle: 'SSRN' });
    expect(sc).not.toHaveProperty('institutions');
    expect(sc).not.toHaveProperty('degree');
    expect(textOf(result)).not.toMatch(/\*\*(Institution|Degree):\*\*/);
  });

  it('omits all four, and their lines, on a record depositing none', async () => {
    const result = await getWork('10.7554/elife.03714');
    const sc = structured(result);

    for (const key of ['institutions', 'degree', 'subtype', 'groupTitle']) {
      expect(sc, key).not.toHaveProperty(key);
    }
    expect(textOf(result)).not.toMatch(/\*\*(Institution|Degree|Subtype|Group):\*\*/);
  });

  /**
   * Deposited institution names carry runs of whitespace and group titles character references,
   * so each string is normalized the way a publisher name is. A list deposited empty is no list.
   */
  it('normalizes every string and omits a list deposited empty', async () => {
    serve((doi) => {
      const body = captured(doi);
      return {
        ...body,
        message: {
          ...body.message,
          institution: [
            {
              name: 'ARMY WAR COLL  CARLISLE BARRACKS PA',
              id: [
                { id: '0000 0001 2163 0069', 'id-type': 'ISNI', 'asserted-by': 'publisher' },
                { id: 'https://ror.org/03ydkyb10', 'id-type': 'ROR', 'asserted-by': 'publisher' },
              ],
              place: [],
              department: ['School of  Strategic\nLandpower'],
              acronym: ['A&amp;M'],
            },
          ],
          degree: [],
          subtype: 'working_paper',
          'group-title': 'MEDICINE &amp; PHARMACOLOGY',
        },
      };
    });
    const result = await getWork('10.2139/ssrn.4944457');
    const sc = structured(result);

    expect(sc.institutions).toEqual([
      {
        name: 'ARMY WAR COLL CARLISLE BARRACKS PA',
        ror: 'https://ror.org/03ydkyb10',
        department: ['School of Strategic Landpower'],
        acronym: ['A&M'],
      },
    ]);
    expect(sc).not.toHaveProperty('degree');
    expect(sc).toMatchObject({ subtype: 'working_paper', groupTitle: 'MEDICINE & PHARMACOLOGY' });
    expect(linesStarting(result, '**Institution:**')).toEqual([
      '**Institution:** ARMY WAR COLL CARLISLE BARRACKS PA (https://ror.org/03ydkyb10) — department: School of Strategic Landpower; acronym: A&M',
    ]);
    expect(linesStarting(result, '**Group:**')).toEqual(['**Group:** MEDICINE & PHARMACOLOGY']);
    expect(textOf(result)).toContain('| **Subtype:** working_paper');
  });

  /**
   * A string that normalizes to nothing is no value: projected, it would render a label with
   * nothing after it, or an empty item in a list.
   */
  it('drops a string that normalizes to nothing, and a list left with none', async () => {
    serve((doi) => {
      const body = captured(doi);
      return {
        ...body,
        message: {
          ...body.message,
          institution: [
            { name: 'bioRxiv', place: [' '], department: ['', 'Neuroscience'], acronym: ['&#32;'] },
          ],
          degree: ['', 'Ph&amp;D'],
          'group-title': ' \n ',
        },
      };
    });
    const result = await getWork('10.1101/2025.11.10.687519');
    const sc = structured(result);

    expect(sc.institutions).toEqual([{ name: 'bioRxiv', department: ['Neuroscience'] }]);
    expect(sc.degree).toEqual(['Ph&D']);
    expect(sc).not.toHaveProperty('groupTitle');
    expect(linesStarting(result, '**Institution:**')).toEqual([
      '**Institution:** bioRxiv — department: Neuroscience',
    ]);
    expect(linesStarting(result, '**Degree:**')).toEqual(['**Degree:** Ph&D']);
    expect(linesStarting(result, '**Group:**')).toEqual([]);
  });

  /**
   * The place and degree lists are free text too, normalized the same way; every degree a thesis
   * deposits reaches the line, and a department or acronym list deposited empty is no list.
   */
  it('normalizes place and degree, renders every degree, and omits each list deposited empty', async () => {
    serve((doi) => {
      const body = captured(doi);
      return {
        ...body,
        message: {
          ...body.message,
          institution: [
            {
              name: 'Universidade de São Paulo',
              place: ['São  Paulo\n'],
              department: [],
              acronym: [],
            },
          ],
          degree: ['Doutorado em&#160;Educação', 'Mestrado  em Educação'],
        },
      };
    });
    const result = await getWork(THESIS);
    const sc = structured(result);

    expect(sc.institutions).toEqual([{ name: 'Universidade de São Paulo', place: ['São Paulo'] }]);
    expect(sc.degree).toEqual(['Doutorado em Educação', 'Mestrado em Educação']);
    expect(linesStarting(result, '**Institution:**')).toEqual([
      '**Institution:** Universidade de São Paulo — place: São Paulo',
    ]);
    expect(linesStarting(result, '**Degree:**')).toEqual([
      '**Degree:** Doutorado em Educação, Mestrado em Educação',
    ]);
  });

  /**
   * subtype is a term of Crossref's own vocabulary, relayed byte-exact the way type is rather than
   * normalized as free text; the line escapes it, and a reader of either surface gets the same
   * characters.
   */
  it('relays subtype byte-exact, as it relays type', async () => {
    serve((doi) => {
      const body = captured(doi);
      return { ...body, message: { ...body.message, subtype: 'working&#95;paper' } };
    });
    const result = await getWork('10.2139/ssrn.4944457');

    expect(structured(result).subtype).toBe('working&#95;paper');
    expect(renderedText(textOf(result))).toContain('| Subtype: working&#95;paper\n');
  });

  it('omits institutions for a list deposited empty', async () => {
    serve((doi) => {
      const body = captured(doi);
      return { ...body, message: { ...body.message, institution: [] } };
    });
    const result = await getWork('10.1101/2025.11.10.687519');

    expect(structured(result)).not.toHaveProperty('institutions');
    expect(textOf(result)).not.toContain('**Institution:**');
  });
});

/**
 * A Hindawi DOI transferred to Wiley: its prefix record names Hindawi (member 98), and the work
 * record names the member that holds it now.
 */
const TRANSFERRED = '10.1155/2024/9760680';

describe('crossref_get_work member', () => {
  beforeEach(() => serve(captured));

  it('returns the member the work record names, on both surfaces', async () => {
    expect(captured(TRANSFERRED).message.member).toBe('311');
    const result = await getWork(TRANSFERRED);

    expect(structured(result)).toMatchObject({ publisher: 'Wiley', memberId: 311 });
    expect(renderedText(textOf(result)).split('\n')).toContain('Member ID: 311');
  });

  it('returns each captured record its own member', async () => {
    for (const [doi, memberId] of [
      ['10.1038/s41586-020-2649-2', 297],
      ['10.1016/S0140-6736(20)31180-6', 78],
      [CHAPTER, 297],
    ] as const) {
      const result = await getWork(doi);

      expect(structured(result).memberId, doi).toBe(memberId);
      expect(textOf(result).split('\n'), doi).toContain(`**Member ID:** ${memberId}`);
    }
  });

  it('omits memberId, and its line, for a record depositing no member', async () => {
    serve((doi) => {
      const { member: _dropped, ...message } = captured(doi).message;
      return { ...captured(doi), message };
    });
    const result = await getWork(TRANSFERRED);

    expect(structured(result)).not.toHaveProperty('memberId');
    expect(textOf(result)).not.toContain('Member ID');
  });
});

/** A Wellcome fellowship: one project, a lead and four investigators, an amount, no top-level start. */
const WELLCOME_GRANT = '10.35802/220488';
/** An FCT associate laboratory: 540 investigators, the first deposited with no name at all. */
const FCT_GRANT = '10.54499/la/p/0104/2020';
/** An FRQ programme grant, whose funder the deposit names by ROR alone. */
const FRQ_GRANT = '10.69777/334076';
/** An NWO grant depositing no description, no investigators, and no amount. */
const NWO_GRANT = '10.61686/aialz48365';

type GrantProject = {
  titles?: Array<{ title: string; language?: string }>;
  descriptions?: Array<{ description: string; language?: string }>;
  leadInvestigators?: Array<Record<string, unknown>>;
  coLeadInvestigators?: Array<Record<string, unknown>>;
  investigators?: Array<Record<string, unknown>>;
  amount?: Record<string, unknown>;
  funding?: Array<Record<string, unknown>>;
};

function projectsOf(result: ToolResult): GrantProject[] {
  return structured(result).projects as GrantProject[];
}

/** The first deposited project of a captured grant. */
function depositedProject(doi: string): Record<string, unknown> {
  return (captured(doi).message.project as Array<Record<string, unknown>>)[0] ?? {};
}

/** The deposited text of a captured grant's first project description, by index. */
function depositedDescription(doi: string, index: number): string {
  const descriptions = depositedProject(doi)['project-description'] as Array<{
    description: string;
  }>;
  return descriptions[index]?.description ?? '';
}

/**
 * Grants deposit no title or abstract: the award number, the projects, and the people sit under
 * `award` and `project`. Every field is relayed as deposited, the plain investigator list paged
 * by offset and limit the way an author list is.
 */
describe('crossref_get_work grants', () => {
  beforeEach(() => serve(captured));

  it('returns the award and the whole project of a grant on both surfaces', async () => {
    const result = await getWork(WELLCOME_GRANT);
    const sc = structured(result);
    const cardiff = { name: 'Cardiff University', ror: 'https://ror.org/03kk7td41', country: 'GB' };

    expect(sc).toMatchObject({
      award: '220488',
      investigatorCount: 4,
      offset: 0,
      // A grant deposits no publication date: `issued`, which Crossref sets to the award start.
      published: { year: 2020, month: 10, day: 1 },
    });
    // The award start is deposited on the project alone here, never at the record level.
    expect(sc).not.toHaveProperty('awardStart');
    expect(sc).not.toHaveProperty('title');
    expect(sc).not.toHaveProperty('notice');
    expect(projectsOf(result)).toEqual([
      {
        titles: [
          {
            title:
              'Using genetics, neurophysiology and longitudinal data to disentangle the complex relationship between sleep and mood disorders.',
          },
        ],
        descriptions: [
          { description: depositedDescription(WELLCOME_GRANT, 0), language: 'en' },
          { description: depositedDescription(WELLCOME_GRANT, 1), language: 'en' },
        ],
        leadInvestigators: [
          {
            given: 'Katie',
            family: 'Swaden Lewis',
            orcid: 'https://orcid.org/0000-0002-2220-6873',
            affiliation: [cardiff],
          },
        ],
        investigators: [
          {
            given: 'Michael',
            family: "O'Donovan",
            orcid: 'https://orcid.org/0000-0001-7073-2379',
            affiliation: [cardiff],
          },
          {
            given: 'Katharine',
            family: 'Saunders',
            orcid: 'https://orcid.org/0000-0003-3448-9927',
            affiliation: [
              { name: 'University of Oxford', ror: 'https://ror.org/052gg0110', country: 'GB' },
            ],
          },
          {
            given: 'Jonathan',
            family: 'Heron',
            orcid: 'https://orcid.org/0000-0001-6199-5644',
            affiliation: [
              { name: 'University of Bristol', ror: 'https://ror.org/0524sp257', country: 'GB' },
            ],
          },
          {
            given: 'Shaun',
            family: 'Purcell',
            orcid: 'https://orcid.org/0000-0002-7402-5812',
            affiliation: [
              {
                name: "Brigham & Women's Hospital",
                ror: 'https://ror.org/04b6nzv94',
                country: 'US',
              },
            ],
          },
        ],
        amount: { amount: 300000, currency: 'GBP' },
        start: { year: 2020, month: 10, day: 1 },
        end: { year: 2024, month: 9, day: 30 },
        funding: [
          {
            type: 'fellowship',
            scheme: 'Population and Public Health',
            amount: { amount: 300000, currency: 'GBP', percentage: 100 },
            funder: { name: 'Wellcome Trust', doi: '10.13039/100010269' },
          },
        ],
      },
    ]);

    const lines = textOf(result).split('\n');
    expect(lines).toContain('**Award:** 220488');
    expect(lines).not.toContain('**Award start:** 2020-10-01');
    expect(listUnder(result, '**Project:**')).toEqual([
      '- Title: Using genetics, neurophysiology and longitudinal data to disentangle the complex relationship between sleep and mood disorders.',
      `- Description (en): ${depositedDescription(WELLCOME_GRANT, 0)}`,
      `- Description (en): ${depositedDescription(WELLCOME_GRANT, 1)}`,
      '- Amount: 300000 GBP',
      '- Dates: start 2020-10-01, end 2024-09-30',
      '- Funding: fellowship, scheme Population and Public Health — Wellcome Trust — 10.13039/100010269 — amount 300000 GBP (100%)',
    ]);
    expect(listUnder(result, '**Lead investigators:**')).toEqual([
      '- Katie Swaden Lewis [ORCID: https://orcid.org/0000-0002-2220-6873] — Cardiff University (https://ror.org/03kk7td41, GB)',
    ]);
    expect(listUnder(result, '**Investigators:** showing 4 of 4, starting at index 0')).toEqual([
      "- Michael O'Donovan [ORCID: https://orcid.org/0000-0001-7073-2379] — Cardiff University (https://ror.org/03kk7td41, GB)",
      '- Katharine Saunders [ORCID: https://orcid.org/0000-0003-3448-9927] — University of Oxford (https://ror.org/052gg0110, GB)',
      '- Jonathan Heron [ORCID: https://orcid.org/0000-0001-6199-5644] — University of Bristol (https://ror.org/0524sp257, GB)',
      "- Shaun Purcell [ORCID: https://orcid.org/0000-0002-7402-5812] — Brigham & Women's Hospital (https://ror.org/04b6nzv94, US)",
    ]);
  });

  it('renders the project ahead of the abstract, every section opened by a blank line', async () => {
    const lines = textOf(await getWork(WELLCOME_GRANT)).split('\n');
    const labels = [
      '**Project:**',
      '**Lead investigators:**',
      '**Investigators:** showing 4 of 4, starting at index 0',
      '**Abstract:**',
    ].map((label) => lines.indexOf(label));

    expect(labels).toEqual([...labels].sort((a, b) => a - b));
    expect(labels[0]).toBeGreaterThan(lines.indexOf('**Award:** 220488'));
    for (const index of labels) expect(lines[index - 1]).toBe('');
  });

  it('pages 540 investigators 25 at a time, keeping the lead and a nameless entry', async () => {
    const result = await getWork(FCT_GRANT);
    const sc = structured(result);
    const [project] = projectsOf(result);

    expect(sc).toMatchObject({
      award: 'LA/P/0104/2020',
      awardStart: { year: 2021, month: 1, day: 1 },
      investigatorCount: 540,
      offset: 0,
      nextOffset: 25,
      truncated: true,
      shown: 25,
      cap: 25,
      notice: 'Showing investigators 1–25 of 540. Call again with offset=25 for the next page.',
    });
    expect(project?.investigators).toHaveLength(25);
    // The entry deposited as `{"affiliation": []}` alone keeps its place, holding nothing.
    expect(project?.investigators?.[0]).toEqual({});
    expect(project?.investigators?.[1]).toEqual({
      given: 'Adriano',
      family: 'Jorge Cardoso Moreira',
      orcid: 'http://orcid.org/0000-0002-8967-118X',
      alternateNames: ['Adriano Jorge Cardoso Moreira'],
    });
    expect(project?.leadInvestigators).toEqual([
      {
        given: 'Paulo',
        family: 'Novais',
        orcid: 'http://orcid.org/0000-0002-3549-0754',
        alternateNames: ['Paulo Novais'],
      },
    ]);
    expect(project?.titles).toEqual([
      { title: 'Intelligent Systems Associate Laboratory', language: 'en' },
      { title: 'Laboratório Associado de Sistemas Inteligentes', language: 'pt' },
    ]);
    // A `null` percentage is no percentage.
    expect(project?.funding).toEqual([
      {
        type: 'grant',
        scheme: 'FCT',
        amount: { amount: 678710, currency: 'EUR' },
        funder: { name: 'Fundação para a Ciência e a Tecnologia', doi: '10.13039/501100001871' },
      },
    ]);
    // The investigators past the page are absent from the payload, not merely from the render.
    expect(JSON.stringify(sc)).not.toContain('Zita');

    const investigators = listUnder(
      result,
      '**Investigators:** showing 25 of 540, starting at index 0',
    );
    expect(investigators).toHaveLength(25);
    expect(investigators.slice(0, 2)).toEqual([
      '- (unknown)',
      '- Adriano Jorge Cardoso Moreira (also Adriano Jorge Cardoso Moreira) [ORCID: http://orcid.org/0000-0002-8967-118X]',
    ]);
    expect(listUnder(result, '**Lead investigators:**')).toEqual([
      '- Paulo Novais (also Paulo Novais) [ORCID: http://orcid.org/0000-0002-3549-0754]',
    ]);
    const lines = textOf(result).split('\n');
    expect(lines).toContain('**Award:** LA/P/0104/2020');
    expect(lines).toContain('**Award start:** 2021-01-01');
    expect(textOf(result)).toContain(
      'Showing investigators 1–25 of 540. Call again with offset=25 for the next page.',
    );
  });

  it('returns the last page of investigators without a continuation, the lead still whole', async () => {
    const result = await getWork(FCT_GRANT, { offset: 525 });
    const [project] = projectsOf(result);

    expect(project?.investigators).toHaveLength(15);
    expect(project?.investigators?.at(-1)).toMatchObject({ given: 'Zita', family: 'Vale' });
    expect(project?.leadInvestigators).toHaveLength(1);
    expect(structured(result)).toMatchObject({ investigatorCount: 540, offset: 525 });
    for (const key of ['nextOffset', 'truncated', 'notice'])
      expect(structured(result)).not.toHaveProperty(key);
    expect(textOf(result)).toContain('**Investigators:** showing 15 of 540, starting at index 525');
  });

  it('explains an offset past the end of the investigator list, returning the rest of the grant', async () => {
    const result = await getWork(FCT_GRANT, { offset: 540 });
    const [project] = projectsOf(result);

    expect(project?.investigators).toEqual([]);
    expect(project?.leadInvestigators).toHaveLength(1);
    expect(project?.titles).toHaveLength(2);
    expect(structured(result)).toMatchObject({
      investigatorCount: 540,
      offset: 540,
      notice:
        'Offset 540 is past the end of this investigator list (540 investigators). Request an offset below 540.',
    });
    expect(structured(result)).not.toHaveProperty('nextOffset');
    expect(textOf(result)).toContain('**Investigators:** showing 0 of 540, starting at index 540');
  });

  it('returns all 540 investigators in deposited order when limit covers them', async () => {
    const result = await getWork(FCT_GRANT, { limit: 540 });
    const deposited = (depositedProject(FCT_GRANT).investigator as Array<{ family?: string }>).map(
      (i) => i.family,
    );

    expect(projectsOf(result)[0]?.investigators?.map((i) => i.family)).toEqual(deposited);
    for (const key of ['nextOffset', 'truncated', 'notice'])
      expect(structured(result)).not.toHaveProperty(key);
    expect(
      listUnder(result, '**Investigators:** showing 540 of 540, starting at index 0'),
    ).toHaveLength(540);
  });

  it('carries a funder deposited by ROR alone, and the co-lead and role dates, on both surfaces', async () => {
    const result = await getWork(FRQ_GRANT);
    const [project] = projectsOf(result);

    expect(project?.funding).toEqual([
      {
        type: 'grant',
        scheme: 'INNO (INO) - Programme pilote',
        amount: { amount: 177078400, currency: 'CAD', percentage: 100 },
        funder: { ror: 'https://ror.org/00w3qhf76' },
      },
    ]);
    expect(project?.coLeadInvestigators).toEqual([
      {
        given: 'Carlos',
        family: 'Vazquez',
        orcid: 'https://orcid.org/0000-0003-2161-8507',
        affiliation: [
          { name: 'École de technologie supérieure [ÉTS]', ror: 'https://ror.org/0020snb74' },
        ],
        roleStart: { year: 2022, month: 1, day: 15 },
      },
    ]);
    expect(structured(result)).toMatchObject({
      award: '334076',
      awardStart: { year: 2022, month: 1, day: 15 },
      investigatorCount: 1,
    });

    expect(listUnder(result, '**Project:**')).toContain(
      '- Funding: grant, scheme INNO (INO) - Programme pilote — https://ror.org/00w3qhf76 — amount 177078400 CAD (100%)',
    );
    expect(listUnder(result, '**Co-lead investigators:**')).toEqual([
      '- Carlos Vazquez [ORCID: https://orcid.org/0000-0003-2161-8507] — École de technologie supérieure [ÉTS] (https://ror.org/0020snb74) — role from 2022-01-15',
    ]);
    expect(listUnder(result, '**Lead investigators:**')).toEqual([
      '- Djahanchah Ghadiri — HEC Montréal (https://ror.org/05ww3wq27) — role from 2022-01-15',
    ]);
  });

  it('omits each project field a grant does not deposit, and every investigator key', async () => {
    const result = await getWork(NWO_GRANT);
    const sc = structured(result);

    expect(projectsOf(result)).toEqual([
      {
        // `&amp;` decoded, as a work title's is.
        titles: [{ title: 'Case-study Research & Data Reuse (CaRe & DaRe)', language: 'en' }],
        start: { year: 2022, month: 4, day: 20 },
        end: { year: 2023, month: 4, day: 19 },
        funding: [
          {
            type: 'grant',
            funder: { name: 'Dutch Research Council', doi: '10.13039/501100003246' },
          },
        ],
      },
    ]);
    for (const key of ['investigatorCount', 'offset', 'notice', 'nextOffset'])
      expect(sc).not.toHaveProperty(key);
    expect(listUnder(result, '**Project:**')).toEqual([
      '- Title (en): Case-study Research & Data Reuse (CaRe & DaRe)',
      '- Dates: start 2022-04-20, end 2023-04-19',
      '- Funding: grant — Dutch Research Council — 10.13039/501100003246',
    ]);
    expect(textOf(result)).not.toMatch(
      /\*\*(Lead investigators|Co-lead investigators|Investigators):\*\*/,
    );
  });

  it('keeps every funding entry in deposited order, and an investigator role that ends', async () => {
    const result = await getWork('10.46936/incite/60012472');
    const [project] = projectsOf(result);

    expect(project?.funding).toEqual([
      {
        type: 'facilities',
        funder: { name: 'US Department of Energy', doi: '10.13039/100000015' },
      },
      { type: 'facilities', funder: { name: 'ORNL-OLCF', doi: '10.13039/100000015' } },
    ]);
    expect(project?.investigators).toEqual([
      {
        given: 'Richard',
        family: 'Sandberg',
        affiliation: [{ name: 'University of Melbourne', country: 'US' }],
        roleStart: { year: 2024, month: 1, day: 1 },
        roleEnd: { year: 2027, month: 1, day: 1 },
      },
    ]);
    expect(listUnder(result, '**Investigators:** showing 1 of 1, starting at index 0')).toEqual([
      '- Richard Sandberg — University of Melbourne (US) — role 2024-01-01 – 2027-01-01',
    ]);
  });

  it('keeps an amount of 0 and omits a currency deposited as null', async () => {
    const result = await getWork('10.52044/hfsp.lt0002402017-l.pc.gr.163608');
    const [project] = projectsOf(result);

    expect(project?.amount).toEqual({ amount: 0 });
    expect(listUnder(result, '**Project:**')).toContain('- Amount: 0');
  });
});

const REVIEW_LINE = /^\*\*Review( competing interests)?:\*\*/;

/** Peer reviews deposit their review details under `review`; Qeios records deposit none. */
describe('crossref_get_work peer reviews', () => {
  beforeEach(() => serve(captured));

  it('returns the review details of a referee report on both surfaces', async () => {
    const result = await getWork('10.5194/amt-2017-159-rc2');

    expect(structured(result).review).toEqual({
      stage: 'pre-publication',
      type: 'referee-report',
      runningNumber: 'RC2',
      recommendation: 'minor-revision',
      language: 'en',
    });
    expect(textOf(result).split('\n')).toContain(
      '**Review:** type: referee-report; stage: pre-publication; running number: RC2; recommendation: minor-revision; language: en',
    );
  });

  it('returns the revision round a report deposits', async () => {
    const result = await getWork('10.1039/d4ra08825e/v2/review1');

    expect(structured(result).review).toEqual({
      stage: 'pre-publication',
      type: 'referee-report',
      runningNumber: 'PR4V2',
      revisionRound: '2',
    });
    expect(textOf(result).split('\n')).toContain(
      '**Review:** type: referee-report; stage: pre-publication; running number: PR4V2; revision round: 2',
    );
  });

  it('returns the competing-interest statement of a post-publication report', async () => {
    const result = await getWork('10.5256/f1000research.147174.r355552');

    expect(structured(result).review).toEqual({
      stage: 'post-publication',
      type: 'referee-report',
      competingInterestStatement: 'No competing interests were declared',
    });
    const lines = textOf(result).split('\n');
    expect(lines).toContain('**Review:** type: referee-report; stage: post-publication');
    expect(lines).toContain('**Review competing interests:** No competing interests were declared');
  });

  it('omits review, and its lines, for a peer review depositing none', async () => {
    const result = await getWork('10.32388/kkcnxz');

    expect(structured(result)).not.toHaveProperty('review');
    const reviewLines = textOf(result)
      .split('\n')
      .filter((line) => REVIEW_LINE.test(line));
    expect(reviewLines).toEqual([]);
  });
});

/**
 * A 2020 bioRxiv preprint whose record no longer links the Nature article that names it. It
 * deposits 100 authors, so the cases that read its whole notice ask for all of them in one page.
 */
const BIORXIV_2020 = '10.1101/2020.03.22.002386';
const WHOLE_AUTHOR_LIST = { limit: 100 };

/** The captured posted-content preprints. */
const PREPRINTS = [
  '10.1364/opticaopen.29459153.v1',
  '10.20944/preprints202302.0051.v34',
  '10.1101/2025.11.10.687519',
  '10.2139/ssrn.4944457',
] as const;

/**
 * The lookup through the real service: which records make it, what it sends, what each captured
 * answer returns, and how each side of the failure split reaches the call. The failure classes
 * one by one are tabled at the service seam in `crossref-service.test.ts`.
 */
describe('crossref_get_work published versions', () => {
  beforeEach(() => serve(captured));

  const FAILED = `The lookup for this preprint's published versions failed, so publishedVersions is omitted — which does not mean it has none. crossref_search_works with filter {"relation.type":"has-preprint","relation.object":"${BIORXIV_2020}"} runs the same lookup.`;

  it('finds the Nature article a 2020 bioRxiv preprint no longer links, in a second request', async () => {
    const result = await getWork(BIORXIV_2020, WHOLE_AUTHOR_LIST);
    const sc = structured(result);

    expect(captured(BIORXIV_2020).message.relation).toEqual({});
    expect(sc).not.toHaveProperty('relations');
    expect(sc.publishedVersions).toEqual([
      {
        doi: '10.1038/s41586-020-2286-9',
        type: 'journal-article',
        title: 'A SARS-CoV-2 protein interaction map reveals targets for drug repurposing',
      },
    ]);
    expect(sc).not.toHaveProperty('notice');
    const lines = textOf(result).split('\n');
    const label = lines.indexOf('**Published versions:**');
    expect(lines[label + 1]).toBe(
      '- 10.1038/s41586-020-2286-9 (journal-article) — A SARS-CoV-2 protein interaction map reveals targets for drug repurposing',
    );
    expect(label).toBeLessThan(lines.findIndex((line) => line.startsWith('**Authors:**')));

    expect(http.calls.map((call) => new URL(call.request.url).pathname)).toEqual([
      `/works/${encodeURIComponent(BIORXIV_2020)}`,
      '/works',
    ]);
    expect(lookedUp(http.calls[1]?.request as Request)).toBe(BIORXIV_2020);
  });

  it('returns each captured preprint its published versions, the one relations also names kept', async () => {
    const found: Record<string, unknown> = {};
    for (const doi of PREPRINTS) found[doi] = structured(await getWork(doi)).publishedVersions;

    expect(found).toEqual({
      '10.1364/opticaopen.29459153.v1': [
        {
          doi: '10.1364/oe.572415',
          type: 'journal-article',
          title:
            'Optical frequency comb bandwidth enhancement of a monolithically integrated gain switched device',
        },
      ],
      '10.20944/preprints202302.0051.v34': [],
      '10.1101/2025.11.10.687519': [],
      '10.2139/ssrn.4944457': [],
    });
    // The preprint's own deposit names the same article, in the depositor's spelling.
    expect(structured(await getWork(PREPRINTS[0])).relations).toEqual([
      { type: 'is-preprint-of', idType: 'doi', assertedBy: 'subject', ids: ['10.1364/OE.572415'] },
    ]);
    expect(textOf(await getWork('10.2139/ssrn.4944457')).split('\n')).toContain(
      '**Published versions:** none found — no Crossref record names this work in has-preprint',
    );
  });

  it('reads every other captured record, and posted content of another subtype, in one request', async () => {
    for (const doi of CAPTURED.filter((d) => !(PREPRINTS as readonly string[]).includes(d))) {
      const before = http.calls.length;
      const sc = structured(await getWork(doi));
      expect(http.calls.length - before, doi).toBe(1);
      expect(sc, doi).not.toHaveProperty('publishedVersions');
    }

    serve((doi) => {
      const body = captured(doi);
      return { ...body, message: { ...body.message, subtype: 'other' } };
    });
    const sc = structured(await getWork('10.1101/2025.11.10.687519'));
    expect(http.calls).toHaveLength(1);
    expect(sc).toMatchObject({ type: 'posted-content', subtype: 'other' });
    expect(sc).not.toHaveProperty('publishedVersions');
  });

  it('reads each captured preprint in two requests', async () => {
    for (const doi of [...PREPRINTS, BIORXIV_2020]) {
      const before = http.calls.length;
      await getWork(doi);
      expect(http.calls.length - before, doi).toBe(2);
    }
  });

  /**
   * One case per outcome the record survives: a 404 never reports the record missing, and no
   * failure puts the lookup's URL on either surface.
   */
  it.each<[string, () => Response]>([
    ['a 404', () => new Response('Resource not found.', { status: 404 })],
    ['a 503', () => new Response('down', { status: 503 })],
    ['an HTML page', () => new Response('<!DOCTYPE html><html></html>')],
    ['a body that is not a works list', () => Response.json({ message: { items: [] } })],
  ])('returns the record and says the lookup failed on %s', async (_label, respond) => {
    serve(captured, respond);

    const result = await getWork(BIORXIV_2020, WHOLE_AUTHOR_LIST);
    const sc = structured(result);

    expect(sc).toMatchObject({ doi: BIORXIV_2020, subtype: 'preprint' });
    expect(sc).not.toHaveProperty('publishedVersions');
    expect(sc.notice).toBe(FAILED);
    expect(renderedText(textOf(result))).toContain(FAILED);
    expect(JSON.stringify(result)).not.toContain('api.crossref.test');
    expect(http.calls).toHaveLength(2);
  });

  it('fails the call on a 429 from the lookup, carrying its wait to both surfaces', async () => {
    serve(
      captured,
      () => new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }),
    );

    const result = await runToolContract(getWorkTool, { doi: BIORXIV_2020 });

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { data: { reason: 'rate_limited', retryAfter: '3' } },
    });
    expect(textOf(result)).toContain('Retry-After: 3');
    expect(http.calls).toHaveLength(2);
  });

  it('fails the call as cancelled when the caller cancels during the lookup', async () => {
    const controller = new AbortController();
    serve(captured, (request) => {
      controller.abort(new Error('caller cancelled'));
      return Promise.reject(request.signal.reason);
    });

    const result = await runToolContract(
      getWorkTool,
      { doi: BIORXIV_2020 },
      { context: { signal: controller.signal } },
    );

    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(http.calls).toHaveLength(2);
  });

  it('sends no lookup for a caller who cancels as the record arrives', async () => {
    const controller = new AbortController();
    serve((doi) => {
      controller.abort(new Error('caller cancelled'));
      return captured(doi);
    });

    const result = await runToolContract(
      getWorkTool,
      { doi: BIORXIV_2020 },
      { context: { signal: controller.signal } },
    );

    expect(result.structuredContent).toMatchObject({
      error: { code: JsonRpcErrorCode.RequestCancelled },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('returns the record with the failure notice when the lookup stalls, inside its window', async () => {
    vi.useFakeTimers();
    try {
      serve(captured, hang);
      let settled = false;
      const pending = runToolContract(getWorkTool, {
        doi: BIORXIV_2020,
        ...WHOLE_AUTHOR_LIST,
      }).finally(() => {
        settled = true;
      });

      await vi.advanceTimersByTimeAsync(9999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);

      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(structured(result)).toMatchObject({ doi: BIORXIV_2020, notice: FAILED });
      expect(structured(result)).not.toHaveProperty('publishedVersions');
      expect(http.calls).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  /**
   * The longest chain the tool makes: a record read held to the edge of its 25 s request deadline
   * by two honored Retry-After waits and a slow third attempt, then a lookup that never answers.
   * The lookup opens a 10 s CROSSREF_TIMEOUT_MS window of its own, so the call settles inside
   * 25 s + 10 s with the record and the failure notice.
   */
  it('settles a record read near its deadline and a stalled lookup inside that deadline plus one window', async () => {
    vi.useFakeTimers();
    try {
      let reads = 0;
      http.reset();
      http.route(
        {
          match: /^https:\/\/api\.crossref\.test\/works\/[^?]+$/,
          respond: (request) => {
            reads += 1;
            if (reads < 3) {
              return new Response('slow down', { status: 429, headers: { 'retry-after': '12' } });
            }
            return new Promise<Response>((resolve, reject) => {
              const timer = setTimeout(() => resolve(Response.json(captured(BIORXIV_2020))), 999);
              request.signal.addEventListener(
                'abort',
                () => {
                  clearTimeout(timer);
                  reject(request.signal.reason);
                },
                { once: true },
              );
            });
          },
        },
        { match: isLookup, respond: hang },
      );
      let settled = false;
      const pending = runToolContract(getWorkTool, {
        doi: BIORXIV_2020,
        ...WHOLE_AUTHOR_LIST,
      }).finally(() => {
        settled = true;
      });

      // Attempts at 0 s, 12 s, and 24 s; the third answers at 24 999 ms, 1 ms inside the deadline.
      await vi.advanceTimersByTimeAsync(24_998);
      expect(http.calls).toHaveLength(3);
      // The lookup waits a whole window, not the 1 ms the record read left: it settles at 34 999 ms.
      await vi.advanceTimersByTimeAsync(10_000);
      expect(http.calls).toHaveLength(4);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      expect(settled).toBe(true);

      const result = await pending;
      expect(result.isError).toBeFalsy();
      expect(structured(result)).toMatchObject({ doi: BIORXIV_2020, notice: FAILED });
      expect(structured(result)).not.toHaveProperty('publishedVersions');
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * A grant's project description runs through the markup pass a work title does, so HTML a funder
 * escaped into it comes out as markup rather than as text. WWTF deposits this one as one escaped
 * paragraph, `&lt;p&gt;…&lt;/p&gt;`, with an `&amp;` inside it.
 */
describe('crossref_get_work on a grant describing its project in escaped HTML', () => {
  beforeEach(() => serve(captured));

  const GRANT = '10.47379/ls21017';
  const DESCRIPTION =
    'The ‘sugar’ coating of any organism consisting of a wide range of glycoconjugates is the first point for interactions between bacteria, viruses or parasites and host cells. Bacterial surface polysaccharides contain many unusual modifications, including non-sugar moieties such as phosphorylcholine (PC) – which is also found on the glycan chains of glycoproteins and glycolipids of helminth parasites as well as glycans produced by insect cell lines used as cell factories for recombinant proteins, including vaccines. Despite many reports that PC is immunomodulatory, the biosynthesis and interactions of PC-modified glycans are poorly understood. Here we propose to generate chemical tools to fill this gap in knowledge. First, potential PC-transferring enzymes will be expressed and new substrates synthesized to assay them; second, we will exploit these enzymes to create new array-based probes for testing interactions with proteins of the immune system including pentraxins and antibodies. The proposed mix of enzymology, chemical & enzymatic synthesis and glycan array technology will enable us to gain new insights into the ‘how’ and ‘why’ of PC-modifications of pathogens, whether these are bacteria or parasites, in terms of characterizing PC from the enzymological and interactomic points of view. Furthermore, we can begin to explore the role of PC in modulating the immune system, including responses to vaccines.';

  it('returns the project description with its escaped markup removed, on both surfaces', async () => {
    const deposited = captured(GRANT).message.project as Array<{
      'project-description': Array<{ description: string }>;
    }>;
    expect(deposited[0]?.['project-description'][0]?.description).toMatch(
      /^&lt;p&gt;The ‘sugar’.*&amp; enzymatic.*vaccines\.&lt;\/p&gt;$/,
    );

    const result = await getWork(GRANT);
    const projects = structured(result).projects as Array<{ descriptions?: unknown }>;
    const text = textOf(result);

    expect(projects[0]?.descriptions).toEqual([{ description: DESCRIPTION, language: 'en' }]);
    expect(text.split('\n')).toContain(`- Description (en): ${DESCRIPTION}`);
    expect(renderedText(text)).toContain(`Description (en): ${DESCRIPTION}`);
    for (const surface of [JSON.stringify(result.structuredContent), text]) {
      expect(surface).not.toMatch(/<\/?p>|&lt;|&amp;/);
    }
  });
});
