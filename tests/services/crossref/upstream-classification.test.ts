/**
 * @fileoverview Transport and upstream failure handling for CrossrefService, asserted at
 * the wire: the JSON-RPC code, the retry cost, and whether recovery reaches `content[]`
 * as well as `structuredContent`.
 *
 * Nothing here stubs `withRetry` or `httpErrorFromResponse` — unlike
 * `crossref-service.test.ts`, which pass-throughs both. The misclassifications covered
 * below only appear when an unclassified throw meets the real transient predicate, so a
 * stubbed retry loop cannot reproduce or regress them. Upstream is a fetch fake and the
 * backoff sleeps run on fake timers, so an exhausted retry path costs no wall time.
 *
 * @module tests/services/crossref/upstream-classification.test
 */

import { readFileSync } from 'node:fs';
import type { UnderlyingDefaultSource } from 'node:stream/web';
import { JsonRpcErrorCode, McpError } from '@cyanheads/mcp-ts-core/errors';
import {
  createFetchMock,
  createMockContext,
  runToolContract,
} from '@cyanheads/mcp-ts-core/testing';
import { logger } from '@cyanheads/mcp-ts-core/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { blockText, renderedText } from '../../helpers/content.js';
import { hang, workList } from '../../helpers/crossref-responses.js';
import { expectLinearScaling } from '../../helpers/scaling.js';

/** The SDK's `CallToolResult`, reached through the runner so the SDK stays a transitive dep. */
type ToolResult = Awaited<ReturnType<typeof runToolContract>>;

vi.mock('@/config/server-config.js', () => ({
  getServerConfig: vi.fn().mockReturnValue({
    mailto: 'test@example.com',
    baseUrl: 'https://api.crossref.test',
    timeoutMs: 10_000,
  }),
}));

import { getServerConfig } from '@/config/server-config.js';
import {
  allToolDefinitions,
  getReferencesTool,
  getWorkTool,
  searchFundersTool,
  searchJournalsTool,
  searchWorksTool,
} from '@/mcp-server/tools/definitions/index.js';
import {
  getCrossrefService,
  initCrossrefService,
  pageTooLarge,
} from '@/services/crossref/crossref-service.js';
import {
  MALFORMED_RESPONSE,
  RATE_LIMITED,
  REQUEST_TIMEOUT,
  UPSTREAM_ERROR_CONTRACT,
  UPSTREAM_UNAVAILABLE,
} from '@/services/crossref/upstream-errors.js';

const DOI = '10.1038/nature12373';
const WORKS_ROUTE = /\/works/;

/** The configured `CROSSREF_BASE_URL` the mocked config above serves. */
const BASE_URL = 'https://api.crossref.test';

/** `withRetry`'s default budget: one attempt plus three retries. */
const TOTAL_ATTEMPTS = 4;

/** A 429's hint when it names no `Retry-After`. */
const NO_WAIT_HINT =
  'Crossref named no wait interval, so back off at least a minute before reissuing the same call, and lower the request rate.';
/** A 429's hint when it names `Retry-After: 2`. */
const RETRY_AFTER_2_HINT =
  'Crossref returned Retry-After: 2 — wait that long before reissuing the same call.';
/** The sentence that closes a 429's hint only when the server sends no `mailto`. */
const POLITE_POOL_SENTENCE =
  'Setting CROSSREF_MAILTO on the server moves requests into the polite pool, which has higher limits.';

const http = createFetchMock();

/** Restart the service as one configured without `CROSSREF_MAILTO`; it reads config once, at construction. */
function startWithoutMailto(): void {
  vi.mocked(getServerConfig).mockReturnValueOnce({
    mailto: undefined,
    baseUrl: BASE_URL,
    timeoutMs: 10_000,
  });
  initCrossrefService();
}

beforeEach(() => {
  vi.useFakeTimers();
  http.reset();
  http.install();
  initCrossrefService();
});

afterEach(() => {
  http.restore();
  vi.useRealTimers();
});

/** Drive a pending call past `withRetry`'s backoff sleeps without waiting on them. */
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}

/** The wire error envelope a client reads from `structuredContent`. */
function errorOf(result: ToolResult) {
  const structured = result.structuredContent as {
    error: { code: number; message: string; data?: Record<string, unknown> };
  };
  return structured.error;
}

/** The rendered text a `content[]`-only client reads — the surface `error.data` never reaches. */
function textOf(result: ToolResult): string {
  return result.content.map(blockText).join('\n');
}

/** Run `crossref_get_work` through the full definition pipeline against the fetch fake. */
function getWork(): Promise<ToolResult> {
  return settle(runToolContract(getWorkTool, { doi: DOI }));
}

describe('upstream failure classification', () => {
  it('preserves the non-retryable 501 classification', async () => {
    http.route({ match: WORKS_ROUTE, respond: () => new Response('unsupported', { status: 501 }) });
    const result = await getWork();
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { retryable: false, reason: 'upstream_unavailable' },
    });
    expect(textOf(result)).toContain('501');
    expect(http.calls).toHaveLength(1);
  });

  it('classifies a malformed 200 body as SerializationError and spends one attempt', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        new Response('{"status":"ok","message":{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });

    const result = await getWork();
    const error = errorOf(result);

    // Was ValidationError (-32007) after four attempts: the raw SyntaxError was neither
    // an McpError (so the transient predicate retried it) nor classifiable by anything
    // but its constructor name (so it landed on the caller's input).
    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(error.data).toMatchObject({ reason: 'malformed_response', retryable: false });
    expect(http.calls).toHaveLength(1);
    expect(textOf(result)).toContain(MALFORMED_RESPONSE.recovery);
  });

  /**
   * A facet block in a shape the server does not read is no count it can report, so the search
   * fails — after one request, since the same request returns the same block — and the hint
   * names the call that still works: the same search without facets.
   */
  it('fails a search whose facet block it cannot read as malformed_response, naming the route', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Response.json({
          status: 'ok',
          message: {
            'total-results': 3,
            'items-per-page': 0,
            items: [],
            facets: { published: { 'value-count': 1, values: { '2023': 'three' } } },
          },
        }),
    });

    const result = await settle(
      runToolContract(searchWorksTool, { query: 'q', rows: 0, facets: { published: '*' } }),
    );
    const error = errorOf(result);

    expect(error.code).toBe(JsonRpcErrorCode.SerializationError);
    expect(error.data).toMatchObject({ reason: 'malformed_response', retryable: false });
    expect(http.calls).toHaveLength(1);
    const hint = 'Send it without facets to read the works and totalResults';
    expect(JSON.stringify(error.data)).toContain(hint);
    expect(renderedText(textOf(result))).toContain(hint);
    expect(textOf(result)).not.toContain(MALFORMED_RESPONSE.recovery);
  });

  it('classifies a network-level failure as ServiceUnavailable and names its cause', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Promise.reject(new TypeError('fetch failed', { cause: new Error('ECONNRESET') })),
    });

    const result = await getWork();
    const error = errorOf(result);

    // Was InternalError (-32603): TypeError is excluded from the framework's type
    // mappings and "fetch failed" matches no message pattern, so an upstream outage
    // surfaced as a bug in this server.
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(error.message).toContain('ECONNRESET');
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
  });

  it('classifies a timeout from the abort reason, not from the message text', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });

    const result = await getWork();
    const error = errorOf(result);

    // The code alone proved nothing before: a DOMException whose message happens to
    // contain "timed out" pattern-matches to Timeout with no reason and no hint. The
    // reason and the hint are only present when the abort was identified by identity.
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'request_timeout', timeoutMs: 10_000 });
    expect(textOf(result)).toContain(REQUEST_TIMEOUT.recovery);
    // A window expiry costs the full CROSSREF_TIMEOUT_MS per attempt, so retrying it would run
    // the call on to the request deadline before the caller could act on the hint above.
    expect(error.data).toMatchObject({ retryable: false });
    expect(http.calls).toHaveLength(1);
  });

  it('maps 408 and 504 onto the timeout reason and keeps their full retry budget', async () => {
    for (const status of [408, 504]) {
      http.reset();
      http.route({ match: WORKS_ROUTE, respond: () => new Response('gateway', { status }) });

      const error = errorOf(await getWork());

      expect(error.code, `HTTP ${status}`).toBe(JsonRpcErrorCode.Timeout);
      expect(error.data, `HTTP ${status}`).toMatchObject({ reason: 'request_timeout' });
      // Same reason as a deadline expiry, opposite retry economics: the response arrives as
      // fast as Crossref answers, so an attempt here is no more expensive than any other
      // transient status. Only the throw site whose cost this server's own clock sets opts out.
      expect(error.data, `HTTP ${status}`).not.toMatchObject({ retryable: false });
      expect(http.calls, `HTTP ${status}`).toHaveLength(TOTAL_ATTEMPTS);
    }
  });

  it('reclassifies an upstream 500 as ServiceUnavailable rather than InternalError', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('boom', { status: 500 }),
    });

    const result = await getWork();

    // InternalError is not in withRetry's transient set, so before this the 500 also
    // failed on the first attempt.
    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(errorOf(result).data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('classifies a body read that fails mid-stream as unavailable, not malformed', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new TypeError('terminated'));
            },
          }),
        ),
    });

    const error = errorOf(await getWork());

    // The read never reached the parser, so this is transport, not serialization:
    // unwrapped it would escape `attempt()` as a raw TypeError and classify as an
    // InternalError after four attempts.
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('classifies an empty 200 body as unavailable, and retries it', async () => {
    http.route({ match: WORKS_ROUTE, respond: () => new Response('', { status: 200 }) });

    const result = await getWork();
    const error = errorOf(result);

    // Not `malformed_response`: nothing was serialized to be corrupt, and that
    // reason's advice — ask for a smaller record — has nothing to act on.
    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('leaves a 404 to the tool handler and does not retry it', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('Resource not found.', { status: 404 }),
    });
    http.route({
      match: (request) => new URL(request.url).hostname === 'doi.org',
      respond: () => Response.json([{ DOI: DOI, status: 'Unknown' }]),
    });

    const result = await getWork();

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.NotFound);
    expect(errorOf(result).data).toMatchObject({ reason: 'doi_not_found' });
    const hosts = http.calls.map((call) => new URL(call.request.url).hostname);
    // One Crossref request, never retried, then the one registry lookup a not-found answer makes.
    expect(hosts).toEqual(['api.crossref.test', 'doi.org']);
  });

  /**
   * The registry lookup rides the same attempt primitive as every Crossref call, so its
   * answer, its single attempt, and its silence on success are asserted through the real
   * service and the real tool rather than a stubbed lookup. A DataCite answer also sends the
   * citation request, which this stub answers in plain JSON rather than CSL-JSON — so the third
   * request is made and the answer stays the agency alone.
   */
  it('names the agency the DOI registry reports, through the real service and tool', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('Resource not found.', { status: 404 }),
    });
    http.route({
      match: (request) => new URL(request.url).hostname === 'doi.org',
      respond: () => Response.json([{ DOI: DOI, RA: 'DataCite' }]),
    });

    const result = await getWork();

    const message = `No Crossref record for DOI: ${DOI} — it is registered with DataCite, not Crossref.`;
    expect(errorOf(result).message).toBe(message);
    expect(errorOf(result).data).toMatchObject({
      reason: 'doi_not_found',
      doi: DOI,
      registrationAgency: 'DataCite',
    });
    expect(errorOf(result).data).not.toHaveProperty('citation');
    expect(textOf(result)).toContain(`Error: ${message}\n`);
    expect(http.calls.map((call) => call.request.url)).toEqual([
      `${BASE_URL}/works/10.1038%2Fnature12373`,
      'https://doi.org/doiRA/10.1038%2Fnature12373',
      'https://doi.org/10.1038%2Fnature12373',
    ]);
  });

  /**
   * Every registry answer outside the agencies doi.org serves a citation for ends the not-found
   * path where it ended before: the Crossref 404 and the registry lookup, then the error, on both
   * surfaces, exactly as written here.
   */
  describe('registry answers that send no citation request', () => {
    const recovery = () => declaredRecovery(getWorkTool, 'doi_not_found');
    const otherAgency = (agency: string) => ({
      answer: [{ DOI, RA: agency }],
      message: `No Crossref record for DOI: ${DOI} — it is registered with ${agency}, not Crossref.`,
      data: { registrationAgency: agency },
      hint: () =>
        `No Crossref tool can return a DOI registered with ${agency}; query ${agency}'s metadata service for it.`,
    });

    it.each([
      ['CNKI', otherAgency('CNKI')],
      ['ISTIC', otherAgency('ISTIC')],
      ['Airiti', otherAgency('Airiti')],
      ['EIDR', otherAgency('EIDR')],
      [
        'Crossref',
        {
          answer: [{ DOI, RA: 'Crossref' }],
          message: `No Crossref record for DOI: ${DOI} — Crossref registered this DOI but serves no work record for it.`,
          data: { registrationAgency: 'Crossref' },
          hint: () =>
            `${recovery()} A Funder Registry DOI (10.13039/…) is looked up with crossref_search_funders funder_doi.`,
        },
      ],
      [
        'DOI does not exist',
        {
          answer: [{ DOI, status: 'DOI does not exist' }],
          message: `No Crossref record for DOI: ${DOI} — no registration agency has registered this DOI.`,
          data: {},
          hint: () =>
            'Check the DOI for a typo or truncation, or find the work with crossref_search_works.',
        },
      ],
      [
        'an unreadable answer',
        {
          answer: [{ DOI, status: 'Unknown' }],
          message: `No Crossref record for DOI: ${DOI}`,
          data: {},
          hint: recovery,
        },
      ],
    ])('%s', async (_label, { answer, message, data, hint }) => {
      http.route({
        match: WORKS_ROUTE,
        respond: () => new Response('Resource not found.', { status: 404 }),
      });
      http.route({
        match: (request) => new URL(request.url).hostname === 'doi.org',
        respond: () => Response.json(answer),
      });

      const result = await getWork();

      expect(errorOf(result)).toEqual({
        code: JsonRpcErrorCode.NotFound,
        message,
        data: { doi: DOI, ...data, recovery: { hint: hint() }, reason: 'doi_not_found' },
      });
      expect(textOf(result)).toBe(
        `Error: ${message}\n\nRecovery: ${hint()}\n\n(reason doi_not_found)`,
      );
      expect(http.calls.map((call) => call.request.url)).toEqual([
        `${BASE_URL}/works/10.1038%2Fnature12373`,
        'https://doi.org/doiRA/10.1038%2Fnature12373',
      ]);
    });
  });

  /**
   * The agencies doi.org serves CSL-JSON for, each with a record it served — the bodies under
   * `tests/fixtures/csl/` as captured, each with the Content-Type it came with — through the real
   * service and tool: the Crossref 404, the registry lookup, the citation request, then the
   * error with its citation on both surfaces.
   */
  describe('the citation of a DOI another agency registered', () => {
    const CSL = 'application/vnd.citationstyles.csl+json';
    const fixture = (doi: string) =>
      readFileSync(
        new URL(`../../fixtures/csl/${doi.toLowerCase().replace('/', '_')}.json`, import.meta.url),
        'utf8',
      );
    const onCitation = (request: Request) => {
      const url = new URL(request.url);
      return url.hostname === 'doi.org' && !url.pathname.startsWith('/doiRA/');
    };

    /** Crossref has no record, the registry names `agency`, and doi.org serves `doi`'s fixture. */
    function registeredElsewhere(doi: string, agency: string, contentType: string) {
      http.route({
        match: WORKS_ROUTE,
        respond: () => new Response('Resource not found.', { status: 404 }),
      });
      http.route({
        match: (request) => request.url.startsWith('https://doi.org/doiRA/'),
        respond: () => Response.json([{ DOI: doi, RA: agency }]),
      });
      http.route({
        match: onCitation,
        respond: () => new Response(fixture(doi), { headers: { 'content-type': contentType } }),
      });
    }

    const hintFor = (agency: string) =>
      `No Crossref tool can return a DOI registered with ${agency}; query ${agency}'s metadata service for it.`;

    it.each([
      [
        '10.5281/zenodo.3242074',
        'DataCite',
        `${CSL}; charset=utf-8`,
        {
          title: 'Simple requirements.txt based example for repo2docker',
          authors: [{ given: 'Project', family: 'Binder' }],
          authorCount: 1,
          issued: { year: 2019, month: 6, day: 9 },
          publisher: 'Zenodo',
          type: 'software',
        },
        `DataCite's citation: title "Simple requirements.txt based example for repo2docker"; authors "Project Binder"; issued 2019-06-09; publisher "Zenodo"; type software.`,
      ],
      [
        '10.11501/3075355',
        'JaLC',
        `${CSL};charset=UTF-8`,
        {
          title: 'Rheological properties and emulsification mechanism of offset inks',
          authors: [{ given: '林, 努' }],
          authorCount: 1,
          issued: { year: 1994, month: 3, day: 25 },
          publisher: '千葉大学',
        },
        `JaLC's citation: title "Rheological properties and emulsification mechanism of offset inks"; authors "林, 努"; issued 1994-03-25; publisher "千葉大学".`,
      ],
      [
        '10.1400/123456',
        'mEDRA',
        `${CSL};charset=UTF-8`,
        {
          title: 'Premios Goya 2008',
          authors: [
            { given: 'Rueda [texto]', family: 'Duque' },
            { given: 'Pipo [fotografia]', family: 'Fernández' },
          ],
          authorCount: 2,
          containerTitle: 'Punto y coma',
          issued: { year: 2008 },
          publisher: 'Habla con Eñe',
          type: 'article-journal',
        },
        `mEDRA's citation: title "Premios Goya 2008"; authors "Rueda [texto] Duque", "Pipo [fotografia] Fernández"; container "Punto y coma"; issued 2008; publisher "Habla con Eñe"; type article-journal.`,
      ],
      [
        '10.3743/kosim.2014.31.4.049',
        'KISTI',
        `${CSL};charset=UTF-8`,
        {
          title:
            'A Content Analysis of Journal Articles Using the Language Network Analysis Methods',
          containerTitle: 'Journal of the Korean Society for information Management',
          issued: { year: 2014, month: 12, day: 1 },
          publisher: '한국정보관리학회',
          type: 'article-journal',
        },
        `KISTI's citation: title "A Content Analysis of Journal Articles Using the Language Network Analysis Methods"; container "Journal of the Korean Society for information Management"; issued 2014-12-01; publisher "한국정보관리학회"; type article-journal.`,
      ],
      [
        '10.2760/180576',
        'OP',
        `${CSL};charset=UTF-8`,
        {
          title: 'Energy communities: an overview of energy and social innovation.',
          authors: [{ name: 'European Commission. Joint Research Centre.' }],
          authorCount: 1,
          issued: { year: 2020 },
          publisher: 'Publications Office',
          type: 'book',
        },
        `OP's citation: title "Energy communities: an overview of energy and social innovation."; authors "European Commission. Joint Research Centre."; issued 2020; publisher "Publications Office"; type book.`,
      ],
    ])('%s (%s)', async (doi, agency, contentType, citation, sentence) => {
      registeredElsewhere(doi, agency, contentType);

      const result = await settle(runToolContract(getWorkTool, { doi }));

      const message = `No Crossref record for DOI: ${doi} — it is registered with ${agency}, not Crossref. ${sentence}`;
      expect(errorOf(result)).toEqual({
        code: JsonRpcErrorCode.NotFound,
        message,
        data: {
          doi,
          registrationAgency: agency,
          citation,
          recovery: { hint: hintFor(agency) },
          reason: 'doi_not_found',
        },
      });
      expect(renderedText(textOf(result))).toContain(
        `Error: ${message}\nRecovery: ${hintFor(agency)}\n`,
      );
      const encoded = encodeURIComponent(doi);
      expect(http.calls.map((call) => call.request.url)).toEqual([
        `${BASE_URL}/works/${encoded}`,
        `https://doi.org/doiRA/${encoded}`,
        `https://doi.org/${encoded}`,
      ]);
      expect(http.calls[2]?.request.headers.get('Accept')).toBe(CSL);
    });

    it('names the first 25 of the 3,435 authors an arXiv collaboration record lists', async () => {
      const doi = '10.48550/arXiv.2507.06261';
      registeredElsewhere(doi, 'DataCite', `${CSL}; charset=utf-8`);

      const result = await settle(runToolContract(getWorkTool, { doi }));

      const { message, data } = errorOf(result);
      const citation = data?.citation as { authors: unknown[]; authorCount: number };
      expect(citation).toMatchObject({
        title:
          'Gemini 2.5: Pushing the Frontier with Advanced Reasoning, Multimodality, Long Context, and Next Generation Agentic Capabilities',
        authorCount: 3435,
        issued: { year: 2025 },
        publisher: 'arXiv',
        type: 'article',
      });
      expect(citation).not.toHaveProperty('containerTitle');
      expect(citation.authors).toHaveLength(25);
      expect(citation.authors[0]).toEqual({ given: 'Gheorghe', family: 'Comanici' });
      expect(citation.authors[24]).toEqual({ given: 'Eric', family: 'Chu' });
      expect(message).toContain(
        '; authors (first 25 of 3435) "Gheorghe Comanici", "Eric Bieber", "Mike Schaekermann", ',
      );
      expect(message).toContain(
        ', "Gaurav Mishra", "Eric Chu"; issued 2025; publisher "arXiv"; type article.',
      );
      // The 26th author is the first one left out.
      expect(message).not.toContain('Toby Boyd');
      expect(renderedText(textOf(result))).toContain(`Error: ${message}\n`);
    });

    it('carries the same citation on crossref_get_references', async () => {
      registeredElsewhere('10.11501/3075355', 'JaLC', `${CSL};charset=UTF-8`);

      const result = await settle(runToolContract(getReferencesTool, { doi: '10.11501/3075355' }));

      expect(errorOf(result).message).toBe(
        `No Crossref record for DOI: 10.11501/3075355 — it is registered with JaLC, not Crossref. JaLC's citation: title "Rheological properties and emulsification mechanism of offset inks"; authors "林, 努"; issued 1994-03-25; publisher "千葉大学".`,
      );
      expect(errorOf(result).data).toMatchObject({
        reason: 'doi_not_found',
        registrationAgency: 'JaLC',
        citation: { title: 'Rheological properties and emulsification mechanism of offset inks' },
      });
      expect(http.calls).toHaveLength(3);
    });

    it('answers with the agency alone when doi.org has no citation to serve', async () => {
      http.route({
        match: WORKS_ROUTE,
        respond: () => new Response('Resource not found.', { status: 404 }),
      });
      http.route({
        match: (request) => request.url.startsWith('https://doi.org/doiRA/'),
        respond: () => Response.json([{ DOI, RA: 'mEDRA' }]),
      });
      http.route({
        match: onCitation,
        respond: () =>
          new Response('<!DOCTYPE html><title>Error: DOI Not Found</title>', {
            status: 404,
            headers: { 'content-type': 'text/html;charset=utf-8' },
          }),
      });

      const result = await getWork();

      const message = `No Crossref record for DOI: ${DOI} — it is registered with mEDRA, not Crossref.`;
      expect(errorOf(result)).toEqual({
        code: JsonRpcErrorCode.NotFound,
        message,
        data: {
          doi: DOI,
          registrationAgency: 'mEDRA',
          recovery: { hint: hintFor('mEDRA') },
          reason: 'doi_not_found',
        },
      });
      expect(textOf(result)).toBe(
        `Error: ${message}\n\nRecovery: ${hintFor('mEDRA')}\n\n(reason doi_not_found)`,
      );
      expect(http.calls).toHaveLength(3);
    });
  });

  it('keeps the declared not-found text when the registry answers 503, without retrying it', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('Resource not found.', { status: 404 }),
    });
    http.route({
      match: (request) => new URL(request.url).hostname === 'doi.org',
      respond: () => new Response('down', { status: 503 }),
    });

    const result = await getWork();

    expect(errorOf(result).message).toBe(`No Crossref record for DOI: ${DOI}`);
    expect(errorOf(result).data).not.toHaveProperty('registrationAgency');
    expect(http.calls.map((call) => new URL(call.request.url).hostname)).toEqual([
      'api.crossref.test',
      'doi.org',
    ]);
  });

  it('sends no registry request when the work resolves', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Response.json({ status: 'ok', message: { DOI, type: 'journal-article', title: ['T'] } }),
    });

    const result = await getWork();

    expect(result.isError).toBeFalsy();
    expect(http.calls.map((call) => new URL(call.request.url).hostname)).toEqual([
      'api.crossref.test',
    ]);
  });

  /**
   * The journal and funder single-record lookups read a plain-text 404 off the service as
   * their own not-found reason. The `cursor-invalid` rejection also arrives as a 404, so the
   * body decides which one a 404 is — these pin that a plain-text one is still left alone.
   */
  it('leaves a plain-text 404 on the journal and funder lookups to their handlers', async () => {
    http.route({
      match: /\/(journals|funders)\//,
      respond: () => new Response('Resource not found.', { status: 404 }),
    });

    const journal = await settle(runToolContract(searchJournalsTool, { issn: '1234-5678' }));
    const funder = await settle(runToolContract(searchFundersTool, { funder_doi: '999999999' }));

    expect(errorOf(journal)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'issn_not_found' },
    });
    expect(errorOf(funder)).toMatchObject({
      code: JsonRpcErrorCode.NotFound,
      data: { reason: 'funder_not_found' },
    });
    expect(http.calls).toHaveLength(2);
  });

  it('keeps the upstream status on an exhausted 5xx', async () => {
    http.route({ match: WORKS_ROUTE, respond: () => new Response('down', { status: 503 }) });

    const error = errorOf(await getWork());

    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 503 });
    expect(error.message).toContain('503');
  });

  it('keeps Crossref validation detail on a 400 and does not retry it', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Response.json(
          {
            'message-type': 'validation-failure',
            message: [
              {
                type: 'filter-not-available',
                value: 'has_abstract',
                message:
                  "Filter 'has_abstract' specified but there is no such filter for this route. Valid filters for this route are: has-abstract, type",
              },
            ],
          },
          { status: 400 },
        ),
    });

    const result = await settle(
      runToolContract(searchWorksTool, { filter: { has_abstract: 'true' } }),
    );

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ValidationError);
    expect(errorOf(result).data).toMatchObject({ reason: 'unknown_filter' });
    expect(errorOf(result).message).toContain('has-abstract');
    expect(http.calls).toHaveLength(1);
  });
});

describe('recovery on both result surfaces', () => {
  /**
   * Every side of the two branches a 429's hint takes: the wait Crossref named or none, and the
   * polite-pool sentence only when the server sends no mailto — a caller cannot set it, and with
   * a mailto set it would be false. A content-only client never sees `error.data`, so the wait
   * and the advice have to be in the text, exactly as `data.recovery.hint` carries them.
   */
  it.each([
    { mailto: 'sends a mailto', sendsMailto: true, retryAfter: undefined, hint: NO_WAIT_HINT },
    { mailto: 'sends a mailto', sendsMailto: true, retryAfter: '', hint: NO_WAIT_HINT },
    { mailto: 'sends a mailto', sendsMailto: true, retryAfter: '2', hint: RETRY_AFTER_2_HINT },
    {
      mailto: 'sends no mailto',
      sendsMailto: false,
      retryAfter: undefined,
      hint: `${NO_WAIT_HINT} ${POLITE_POOL_SENTENCE}`,
    },
    {
      mailto: 'sends no mailto',
      sendsMailto: false,
      retryAfter: '',
      hint: `${NO_WAIT_HINT} ${POLITE_POOL_SENTENCE}`,
    },
    {
      mailto: 'sends no mailto',
      sendsMailto: false,
      retryAfter: '2',
      hint: `${RETRY_AFTER_2_HINT} ${POLITE_POOL_SENTENCE}`,
    },
  ])(
    'carries the exact hint on an exhausted 429 with Retry-After $retryAfter when the server $mailto',
    async ({ sendsMailto, retryAfter, hint }) => {
      if (!sendsMailto) startWithoutMailto();
      http.route({
        match: WORKS_ROUTE,
        respond: () =>
          new Response('slow down', {
            status: 429,
            ...(retryAfter !== undefined && { headers: { 'retry-after': retryAfter } }),
          }),
      });

      const result = await getWork();
      const error = errorOf(result);

      expect(error.code).toBe(JsonRpcErrorCode.RateLimited);
      expect(error.data).toMatchObject({ reason: 'rate_limited', recovery: { hint } });
      expect(renderedText(textOf(result))).toContain(`\nRecovery: ${hint}\n`);
      if (retryAfter === undefined) {
        expect(error.data).not.toHaveProperty('retryAfter');
      } else {
        expect(error.data).toMatchObject({ retryAfter });
      }
      // An empty header names no wait, so the text sends no caller looking for one.
      if (!retryAfter) expect(textOf(result)).not.toContain('Retry-After');
      if (sendsMailto) expect(JSON.stringify(result)).not.toContain('CROSSREF_MAILTO');
      expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
    },
  );

  it('keeps the contract hint a config-independent literal of the backoff advice alone', () => {
    expect(RATE_LIMITED.recovery).toBe(NO_WAIT_HINT);
    // It reaches the wire only on a 429 with no Retry-After, where there is no interval in the
    // message and no retryAfter in the data — so the text must not send a caller looking for either.
    expect(RATE_LIMITED.recovery).not.toMatch(/retryAfter|interval named/i);
  });

  it('renders recovery for an exhausted 503 alongside the attempt count', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('down', { status: 503 }),
    });

    const result = await getWork();
    const error = errorOf(result);

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable' });
    expect(error.message).toContain(`failed after ${TOTAL_ATTEMPTS} attempts`);
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
  });

  it('renders recovery when Crossref serves an HTML error page as a 200', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        new Response('<!DOCTYPE html><html><body>Rate limited</body></html>', { status: 200 }),
    });

    const result = await getWork();

    expect(errorOf(result).code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(errorOf(result).message).toContain('HTML');
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });
});

describe('upstream request URL', () => {
  /**
   * Every failure shape the service classifies, as the upstream behavior that produces it.
   * Each one built its error on a different path — `httpErrorFromResponse`, `upstreamError`,
   * the tool handler's own typed reason — so the surface has to be checked on all of them
   * rather than on whichever one a single case happens to exercise.
   */
  const FAILURES: ReadonlyArray<readonly [string, (request: Request) => Promise<Response>]> = [
    ['a network-level rejection', () => Promise.reject(new TypeError('fetch failed'))],
    ['an upstream 500', async () => new Response('boom', { status: 500 })],
    [
      'an exhausted 429',
      async () => new Response('slow down', { status: 429, headers: { 'retry-after': '2' } }),
    ],
    ['a 501 the retry budget skips', async () => new Response('unsupported', { status: 501 })],
    [
      'an HTML error page served as 200',
      async () => new Response('<!DOCTYPE html><html><body>nope</body></html>', { status: 200 }),
    ],
    ['an empty 200 body', async () => new Response('', { status: 200 })],
    ['a malformed 200 body', async () => new Response('{"message":{', { status: 200 })],
    ['a 404 the handler owns', async () => new Response('Resource not found.', { status: 404 })],
    [
      'a deadline expiry',
      (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    ],
  ];

  /**
   * `error.data` is forwarded to the client as `structuredContent.error.data`, and
   * `CROSSREF_BASE_URL` is operator-configurable — a deployment pointed at a private mirror
   * would otherwise hand that hostname, plus every query string this server builds, to every
   * caller on every failure. The whole result is scanned rather than `data.url` alone: the
   * URL reaching `content[]`, the message, or a nested field costs the same as reaching the
   * key it used to sit on.
   */
  it.each(FAILURES)('is absent from the client-facing envelope on %s', async (_label, respond) => {
    http.route({ match: WORKS_ROUTE, respond });

    const result = await getWork();

    expect(errorOf(result).data ?? {}).not.toHaveProperty('url');
    expect(JSON.stringify(result)).not.toContain(BASE_URL);
  });

  /**
   * The body goes the same way as the URL. Crossref's 5xx bodies carry Java exception
   * names and stack excerpts, and nothing in a relayed body is a next step for the caller —
   * the status and the message say what failed.
   */
  it.each(FAILURES)('carries no upstream body on %s', async (_label, respond) => {
    http.route({ match: WORKS_ROUTE, respond });

    const data = errorOf(await getWork()).data ?? {};

    expect(data).not.toHaveProperty('body');
    expect(data).not.toHaveProperty('responseBody');
  });

  /**
   * Where the line actually sits. A socket rejection's own message embeds the address it
   * dialled (`connect ECONNREFUSED host:port`), and `causeOf` puts that message on the wire
   * because it is the only thing that says what went wrong — the framework draws the same
   * line, keeping the host in an upstream error's message while dropping the URL from
   * `error.data`. What must never travel is the rest of the URL: the route, the DOI, the
   * query string this server built. An HTTP-status failure carries neither, since
   * `httpErrorFromResponse` is given `service: 'Crossref'` and names that instead of a host.
   */
  it('keeps the route and query out of a transport rejection that names its address', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Promise.reject(
          new TypeError('fetch failed', {
            cause: new Error('connect ECONNREFUSED 10.0.0.4:8080'),
          }),
        ),
    });

    const result = await getWork();
    const wire = JSON.stringify(result);

    expect(errorOf(result).data ?? {}).not.toHaveProperty('url');
    expect(wire).not.toContain('/works');
    expect(wire).not.toContain(encodeURIComponent(DOI));
    expect(wire).not.toContain(BASE_URL);
  });

  it('reaches the operator through the Pino-only sink instead', async () => {
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    http.route({ match: WORKS_ROUTE, respond: () => new Response('down', { status: 503 }) });

    await getWork();

    // `ctx.log` is dual-sink — a line written there ships to the client as
    // `notifications/message`, which is the surface this whole block exists to keep clear.
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('Crossref request failed'),
      expect.objectContaining({
        extra: expect.objectContaining({
          url: `${BASE_URL}/works/${encodeURIComponent(DOI)}`,
        }),
      }),
    );
    warning.mockRestore();
  });

  it('is not logged as a failure when the caller cancelled', async () => {
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    const controller = new AbortController();
    http.route({
      match: WORKS_ROUTE,
      respond: (request) =>
        new Promise<Response>((_, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        }),
    });

    const pending = runToolContract(
      getWorkTool,
      { doi: DOI },
      { context: { signal: controller.signal } },
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('caller cancelled'));
    await pending;

    // A cancellation is the caller hanging up, not an upstream fault an operator has to chase.
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});

describe('timeout timer lifecycle', () => {
  it('clears the per-attempt timer once a request succeeds', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Response.json({
          status: 'ok',
          'message-type': 'work',
          message: { DOI, title: ['Ok'], type: 'journal-article' },
        }),
    });

    // Awaited directly, not through `settle` — `runAllTimersAsync` would fire the
    // pending abort timer and make an uncleared one indistinguishable from a cleared
    // one. A success path needs no timer advanced.
    await runToolContract(getWorkTool, { doi: DOI });

    // A `setTimeout` left armed after a successful call holds the event loop open for
    // the remainder of CROSSREF_TIMEOUT_MS on every request.
    expect(vi.getTimerCount()).toBe(0);
  });
});

type Responder = (request: Request) => Response | Promise<Response>;

/** Answer the nth request with the nth responder, the last one answering every request after. */
function inTurn(...responders: Responder[]): Responder {
  let served = 0;
  return (request) => {
    const respond = responders[Math.min(served, responders.length - 1)];
    served += 1;
    if (!respond) throw new Error('inTurn needs at least one responder');
    return respond(request);
  };
}

/** A 429 naming `retryAfter` as its wait. */
const rateLimitedFor =
  (retryAfter: string): Responder =>
  () =>
    new Response('slow down', { status: 429, headers: { 'retry-after': retryAfter } });

/** Answer `status` after `ms` of fake time, unless the request is aborted first. */
const answerAfter =
  (ms: number, status: number): Responder =>
  (request) =>
    new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => resolve(new Response('', { status })), ms);
      request.signal.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(request.signal.reason);
        },
        { once: true },
      );
    });

/** A pending call whose settlement can be read while fake time advances. */
function track<T>(promise: Promise<T>) {
  const state = { settled: false };
  const outcome = promise.then(
    (value) => {
      state.settled = true;
      return { ok: true as const, value };
    },
    (error: unknown) => {
      state.settled = true;
      return { ok: false as const, error };
    },
  );
  return {
    get settled() {
      return state.settled;
    },
    /** The tool result, once settled — `runToolContract` turns every failure into one. */
    async result(): Promise<ToolResult> {
      const settled = await outcome;
      if (!settled.ok) throw settled.error;
      return settled.value as ToolResult;
    },
    /** The rejection, once settled — for a service call that is expected to fail. */
    async error(): Promise<unknown> {
      const settled = await outcome;
      if (settled.ok) throw new Error('expected the call to fail');
      return settled.error;
    },
  };
}

/**
 * One deadline bounds a Crossref request — every attempt, every backoff, every honored
 * `Retry-After` — at 25 s, CROSSREF_TIMEOUT_MS being the 10 s this file configures. A tool call
 * chains at most two such requests (a journal or funder record, then its works list), so it
 * answers inside the 60 s request timeout MCP SDK clients default to. Backoff jitter is pinned
 * to its midpoint, so each exponential wait is exactly 1 s, 2 s, 4 s and every instant a call
 * settles at below is exact.
 */
describe('the request deadline', () => {
  let random: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
  });

  afterEach(() => {
    random.mockRestore();
  });

  it('keeps every attempt while the Retry-After waits fit inside it', async () => {
    http.route({ match: WORKS_ROUTE, respond: rateLimitedFor('5') });

    const call = track(runToolContract(getWorkTool, { doi: DOI }));
    await vi.advanceTimersByTimeAsync(15_000);

    expect(call.settled).toBe(true);
    const error = errorOf(await call.result());
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: '5' },
    });
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('surfaces the 429 at once when the next Retry-After wait would outlast it', async () => {
    http.route({ match: WORKS_ROUTE, respond: rateLimitedFor('10') });

    const call = track(runToolContract(getWorkTool, { doi: DOI }));
    // Attempts at 0 s, 10 s, and 20 s; a third 10 s wait would end at 30 s, past the deadline.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.settled).toBe(true);
    const result = await call.result();
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: '10' },
    });
    expect(textOf(result)).toContain('Retry-After: 10');
    expect(http.calls).toHaveLength(3);
  });

  it('cuts a slow attempt at the deadline and reports it as request_timeout', async () => {
    // Each 504 takes 9 s: attempts start at 0 s, 10 s, and 21 s, and the third is cut at 25 s.
    http.route({ match: WORKS_ROUTE, respond: answerAfter(9_000, 504) });

    const call = track(runToolContract(getWorkTool, { doi: DOI }));
    await vi.advanceTimersByTimeAsync(24_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.settled).toBe(true);
    const result = await call.result();
    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.Timeout);
    expect(error.data).toMatchObject({ reason: 'request_timeout', deadlineMs: 25_000 });
    expect(error.data).not.toHaveProperty('retryable');
    expect(error.message).toBe('Crossref did not answer within the 25000ms request deadline.');
    expect(textOf(result)).toContain(REQUEST_TIMEOUT.recovery);
    expect(http.calls).toHaveLength(3);
    // The cut attempt's window, the deadline clock, and the stalled answer are all cleared.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('still reports a 429 when the deadline cuts the attempt after it', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: inTurn(rateLimitedFor('10'), rateLimitedFor('10'), hang),
    });

    const call = track(runToolContract(getWorkTool, { doi: DOI }));
    await vi.advanceTimersByTimeAsync(24_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.settled).toBe(true);
    const result = await call.result();
    // The wait the upstream named is still the caller's next move, so the rate limit — not
    // the cut attempt — is what the caller hears, with its Retry-After on both surfaces.
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: '10' },
    });
    expect(textOf(result)).toContain('Retry-After: 10');
    expect(http.calls).toHaveLength(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    { mailto: 'sends a mailto', sendsMailto: true, closing: '' },
    { mailto: 'sends no mailto', sendsMailto: false, closing: ` ${POLITE_POOL_SENTENCE}` },
  ])(
    'reports that 429 with the hint a direct one carries when the server $mailto',
    async ({ sendsMailto, closing }) => {
      if (!sendsMailto) startWithoutMailto();
      http.route({
        match: WORKS_ROUTE,
        respond: inTurn(rateLimitedFor('10'), rateLimitedFor('10'), hang),
      });

      const call = track(runToolContract(getWorkTool, { doi: DOI }));
      await vi.advanceTimersByTimeAsync(25_000);

      const hint = `Crossref returned Retry-After: 10 — wait that long before reissuing the same call.${closing}`;
      const result = await call.result();
      expect(errorOf(result).data).toMatchObject({ reason: 'rate_limited', recovery: { hint } });
      expect(renderedText(textOf(result))).toContain(`\nRecovery: ${hint}\n`);
    },
  );

  it('forgets the 429 once a later attempt completes with another failure', async () => {
    // 429 at 0 s; a 503 answered at 19 s; after its 2 s backoff the third attempt is cut at 25 s.
    http.route({
      match: WORKS_ROUTE,
      respond: inTurn(rateLimitedFor('10'), answerAfter(9_000, 503), hang),
    });

    const call = track(runToolContract(getWorkTool, { doi: DOI }));
    await vi.advanceTimersByTimeAsync(25_000);

    expect(call.settled).toBe(true);
    const error = errorOf(await call.result());
    expect(error).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'request_timeout', deadlineMs: 25_000 },
    });
    expect(http.calls).toHaveLength(3);
  });

  it('reports the failure whose backoff the deadline left no room for', async () => {
    // 503s answered at 9 s, 19 s, and 21.5 s; the 4 s backoff after the third would end past 25 s.
    http.route({
      match: WORKS_ROUTE,
      respond: inTurn(answerAfter(9_000, 503), answerAfter(9_000, 503), answerAfter(500, 503)),
    });

    const call = track(runToolContract(getWorkTool, { doi: DOI }));
    await vi.advanceTimersByTimeAsync(21_500);

    expect(call.settled).toBe(true);
    const result = await call.result();
    expect(errorOf(result)).toMatchObject({
      code: JsonRpcErrorCode.ServiceUnavailable,
      data: { reason: 'upstream_unavailable' },
    });
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
    expect(http.calls).toHaveLength(3);
  });

  it('sends nothing when a backoff leaves no time to send in', async () => {
    // The clock starts 1 ms past a whole second, so an HTTP-date Retry-After 25 s on asks for
    // a 24 999 ms wait: it fits, and the attempt after it would start with 1 ms left.
    vi.setSystemTime(Date.UTC(2026, 0, 1, 0, 0, 0, 1));
    const retryAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 25)).toUTCString();
    http.route({ match: WORKS_ROUTE, respond: rateLimitedFor(retryAt) });

    const call = track(runToolContract(getWorkTool, { doi: DOI }));
    await vi.advanceTimersByTimeAsync(25_000);

    expect(call.settled).toBe(true);
    expect(errorOf(await call.result())).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: retryAt },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('settles a tool call that chains two requests inside two deadlines', async () => {
    // The journal record answers on its second attempt at 24 s; the works list then hears two
    // 429s, at 24 s and 48 s, and the second's 24 s wait no longer fits its own deadline.
    http.route({
      match: /\/journals\/0028-0836(?:\?|$)/,
      respond: inTurn(rateLimitedFor('24'), () =>
        Response.json({
          status: 'ok',
          'message-type': 'journal',
          message: { title: 'Nature', 'ISSN-L': '0028-0836', ISSN: ['0028-0836'] },
        }),
      ),
    });
    http.route({
      match: (request) => new URL(request.url).pathname === '/works',
      respond: rateLimitedFor('24'),
    });

    const call = track(
      runToolContract(searchJournalsTool, { issn: '0028-0836', include_works: true, rows: 2 }),
    );
    await vi.advanceTimersByTimeAsync(50_000);

    expect(call.settled).toBe(true);
    expect(errorOf(await call.result())).toMatchObject({
      code: JsonRpcErrorCode.RateLimited,
      data: { reason: 'rate_limited', retryAfter: '24' },
    });
    expect(http.calls).toHaveLength(4);
  });

  it('gives a CROSSREF_TIMEOUT_MS longer than the deadline its full first attempt', async () => {
    // The service reads its config once, in the constructor `initCrossrefService` runs.
    vi.mocked(getServerConfig).mockReturnValueOnce({
      mailto: 'test@example.com',
      baseUrl: BASE_URL,
      timeoutMs: 40_000,
    });
    initCrossrefService();
    http.route({ match: WORKS_ROUTE, respond: hang });

    const call = track(runToolContract(getWorkTool, { doi: DOI }));
    await vi.advanceTimersByTimeAsync(39_999);
    expect(call.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    expect(call.settled).toBe(true);
    expect(errorOf(await call.result())).toMatchObject({
      code: JsonRpcErrorCode.Timeout,
      data: { reason: 'request_timeout' },
    });
    expect(http.calls).toHaveLength(1);
  });

  it('names the request, not the class, in the label an exhausted error carries', async () => {
    http.route({ match: WORKS_ROUTE, respond: () => new Response('down', { status: 503 }) });

    const error = errorOf(await getWork());

    expect(error.data).toMatchObject({
      reason: 'upstream_unavailable',
      retryAttempts: TOTAL_ATTEMPTS,
      operation: 'Crossref request',
    });
  });

  it('keeps the upstream URL and body off an error the deadline ended', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: inTurn(rateLimitedFor('10'), rateLimitedFor('10'), hang),
    });

    const call = track(runToolContract(getWorkTool, { doi: DOI }));
    await vi.advanceTimersByTimeAsync(25_000);

    expect(call.settled).toBe(true);
    const result = await call.result();
    expect(errorOf(result).data).toMatchObject({ reason: 'rate_limited' });
    expect(errorOf(result).data ?? {}).not.toHaveProperty('url');
    expect(errorOf(result).data ?? {}).not.toHaveProperty('body');
    expect(errorOf(result).data ?? {}).not.toHaveProperty('responseBody');
    expect(JSON.stringify(result)).not.toContain(BASE_URL);
  });

  it('reports a cancellation during a backoff as RequestCancelled, unlogged and unretried', async () => {
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    const controller = new AbortController();
    http.route({ match: WORKS_ROUTE, respond: () => new Response('down', { status: 503 }) });

    const call = track(
      getCrossrefService().getWork(DOI, createMockContext({ signal: controller.signal })),
    );
    // Inside the 1 s backoff after the first 503.
    await vi.advanceTimersByTimeAsync(500);
    controller.abort(new Error('caller cancelled'));
    await vi.advanceTimersByTimeAsync(0);

    expect(call.settled).toBe(true);
    expect(await call.error()).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(http.calls).toHaveLength(1);
    expect(warning).not.toHaveBeenCalled();
    warning.mockRestore();
  });
});

/** The data keys a relayed upstream response would carry, none of which may reach the caller. */
const UPSTREAM_RESPONSE_KEYS = ['url', 'body', 'responseBody', 'status', 'statusCode'] as const;

/** Every key a Crossref filter can be checked against — a slice of the ~90 the route lists. */
const VALID_FILTERS =
  'until-approved-date, has-assertion, issn, has-abstract, directory, type, from-pub-date, has-full-text, has-references';

type RejectionEntry = { type: string; value: string; message: string };

function filterNotAvailable(key: string): RejectionEntry {
  return {
    type: 'filter-not-available',
    value: key,
    message: `Filter '${key}' specified but there is no such filter for this route. Valid filters for this route are: ${VALID_FILTERS}`,
  };
}

const TYPE_NOT_VALID = (value: string): RejectionEntry => ({
  type: 'type-not-valid',
  value,
  message: `Type specified as ${value} but must be one of: book-section, monograph, journal-article, book-chapter, dataset`,
});

const SORT_WITH_CURSOR: RejectionEntry = {
  type: 'sort-criteria-incompatible-with-cursor',
  value: 'sort',
  message:
    'Sorting by [issued, published, published-print, published-online] is not supported when using a cursor',
};

const CURSOR_INVALID: RejectionEntry = {
  type: 'cursor-invalid',
  value: 'garbage',
  message: 'Cursor specified but it is invalid',
};

/** Crossref's 400 body for a request it refuses to run, one entry per rejected input. */
function validationFailure(...entries: RejectionEntry[]): Response {
  return Response.json(
    { status: 'failed', 'message-type': 'validation-failure', message: entries },
    { status: 400 },
  );
}

/** Crossref's 404 body for a cursor token it does not recognize. */
function cursorInvalid(): Response {
  return Response.json(
    { status: 'failed', 'message-type': 'resource-failure', message: [CURSOR_INVALID] },
    { status: 404 },
  );
}

/** The declared recovery for a reason, failing the test when the tool does not declare it. */
function declaredRecovery(
  definition: { errors?: ReadonlyArray<{ reason: string; recovery: string }> },
  reason: string,
): string {
  const entry = definition.errors?.find((e) => e.reason === reason);
  if (!entry) throw new Error(`reason ${reason} is not declared`);
  return entry.recovery;
}

/**
 * The shape every rejection of caller input takes on the wire: a `ValidationError` naming its
 * declared reason, the declared recovery on `data.recovery.hint` and as a `Recovery:` line in
 * `content[]`, nothing of the upstream response on `data`, and a single attempt.
 */
function expectRejection(result: ToolResult, reason: string, recovery: string) {
  const error = errorOf(result);
  expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
  expect(error.data).toMatchObject({ reason, recovery: { hint: recovery } });
  const rendered = renderedText(textOf(result));
  expect(rendered).toContain(`Recovery: ${recovery}`);
  expect(rendered).toContain(`reason ${reason}`);
  for (const key of UPSTREAM_RESPONSE_KEYS) expect(error.data).not.toHaveProperty(key);
  return error;
}

describe('Crossref rejections of caller input', () => {
  const searchWorks = (input: Record<string, unknown>) =>
    settle(runToolContract(searchWorksTool, input));

  it('names an unknown filter key and suggests the hyphenated key Crossref lists', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => validationFailure(filterNotAvailable('has_abstract')),
    });

    const result = await searchWorks({ filter: { has_abstract: 'true' }, rows: 1 });

    const error = expectRejection(
      result,
      'unknown_filter',
      declaredRecovery(searchWorksTool, 'unknown_filter'),
    );
    expect(error.data).toMatchObject({
      suggestion: 'has-abstract',
      rejected: [{ type: 'filter-not-available', value: 'has_abstract' }],
    });
    expect(error.message).toContain('"has_abstract"');
    expect(error.message).toContain('"has-abstract"');
    // Crossref's ~90-key list stays off the message — the suggestion is the part to act on.
    expect(error.message).not.toContain('until-approved-date');
    expect(http.calls).toHaveLength(1);
  });

  it('suggests nothing when the hyphenated key is not a Crossref filter either', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => validationFailure(filterNotAvailable('is_open_access')),
    });

    const result = await searchWorks({ filter: { is_open_access: 'true' }, rows: 1 });

    const error = expectRejection(
      result,
      'unknown_filter',
      declaredRecovery(searchWorksTool, 'unknown_filter'),
    );
    expect(error.data).not.toHaveProperty('suggestion');
    expect(textOf(result)).not.toContain('is-open-access');
    /**
     * The recovery is what points an open-access filter somewhere that exists — and that
     * answers: Crossref accepts `directory:DOAJ` but fails every request carrying it with a 500.
     */
    expect(textOf(result)).toContain('license.url');
    expect(textOf(result)).not.toContain('directory:DOAJ');
  });

  it('reports a date sort paired with a cursor as sort_cursor_conflict', async () => {
    http.route({ match: WORKS_ROUTE, respond: () => validationFailure(SORT_WITH_CURSOR) });

    const result = await searchWorks({ query: 'crispr', sort: 'published', cursor: '*', rows: 1 });

    const error = expectRejection(
      result,
      'sort_cursor_conflict',
      declaredRecovery(searchWorksTool, 'sort_cursor_conflict'),
    );
    expect(error.data).toMatchObject({
      rejected: [{ type: 'sort-criteria-incompatible-with-cursor', value: 'sort' }],
    });
    expect(error.message).toContain('not supported when using a cursor');
    expect(http.calls).toHaveLength(1);
  });

  it('reports an unrecognized cursor token as invalid_cursor, not a bare not-found', async () => {
    http.route({ match: WORKS_ROUTE, respond: cursorInvalid });

    const result = await searchWorks({ query: 'crispr', cursor: 'garbage', rows: 1 });

    const error = expectRejection(
      result,
      'invalid_cursor',
      declaredRecovery(searchWorksTool, 'invalid_cursor'),
    );
    expect(error.data).toMatchObject({ rejected: [{ type: 'cursor-invalid', value: 'garbage' }] });
    expect(JSON.stringify(result)).not.toContain('resource-failure');
    expect(http.calls).toHaveLength(1);
  });

  /**
   * The values a rejection tells the caller to send back — the hyphenated filter key Crossref
   * lists, the `*` that restarts a cursor walk — render in `content[]` as code spans, so a model
   * copying one from the text carries no Markdown escape into its next call. A CommonMark reader
   * still reads the text exactly as `structuredContent` carries it.
   */
  it('renders each suggested filter key as code, the text around it unchanged', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        validationFailure(filterNotAvailable('has_abstract'), filterNotAvailable('from_pub_date')),
    });

    const result = await searchWorks({
      filter: { has_abstract: 'true', from_pub_date: '2020' },
      rows: 1,
    });

    const { message } = errorOf(result);
    expect(message).toBe(
      'Crossref rejected the request: filter key "has_abstract" is not a Crossref filter — did you mean "has-abstract"?; filter key "from_pub_date" is not a Crossref filter — did you mean "from-pub-date"?',
    );
    expect(textOf(result)).toContain('did you mean "`has-abstract`"?');
    expect(textOf(result)).toContain('did you mean "`from-pub-date`"?');
    expect(renderedText(textOf(result))).toContain(`Error: ${message}\n`);
  });

  it('renders the cursor that restarts a walk as code, not as an escaped asterisk', async () => {
    http.route({ match: WORKS_ROUTE, respond: cursorInvalid });

    const result = await searchWorks({ query: 'crispr', cursor: 'garbage', rows: 1 });

    const hint = declaredRecovery(searchWorksTool, 'invalid_cursor');
    expect(errorOf(result).data).toMatchObject({ recovery: { hint } });
    expect(textOf(result)).toContain('Restart the walk by passing "`*`" as cursor');
    expect(textOf(result)).not.toContain('\\*');
    expect(renderedText(textOf(result))).toContain(`Recovery: ${hint}\n`);
  });

  it.each([
    [
      'crossref_search_journals',
      searchJournalsTool,
      { issn: '0028-0836', include_works: true, works_cursor: 'garbage', rows: 2 },
      (request: Request) => {
        const url = new URL(request.url);
        return (
          url.origin === BASE_URL &&
          url.pathname === '/works' &&
          url.searchParams.get('filter') === 'issn:0028-0836'
        );
      },
      /\/journals\/0028-0836(?:\?|$)/,
      { title: 'Nature', 'ISSN-L': '0028-0836', ISSN: ['0028-0836'] },
    ],
    [
      'crossref_search_funders',
      searchFundersTool,
      { funder_doi: '100000001', include_works: true, works_cursor: 'garbage', rows: 2 },
      /\/funders\/100000001\/works/,
      /\/funders\/100000001(?:\?|$)/,
      { id: '100000001', name: 'National Science Foundation' },
    ],
  ] as const)(
    'reports an unrecognized works_cursor on %s as invalid_cursor',
    async (_name, definition, input, worksRoute, recordRoute, record) => {
      http.route({ match: worksRoute, respond: cursorInvalid });
      http.route({
        match: recordRoute,
        respond: () => Response.json({ status: 'ok', 'message-type': 'record', message: record }),
      });

      const result = await settle(runToolContract(definition, input));

      expectRejection(result, 'invalid_cursor', declaredRecovery(definition, 'invalid_cursor'));
      // The record lookup and the one works request — the rejection is not retried.
      expect(http.calls).toHaveLength(2);
    },
  );

  it.each([
    [{ type: 'journal-articl' }, TYPE_NOT_VALID('journal-articl')],
    [
      { 'has-abstract': 'yes' },
      {
        type: 'boolean-not-valid',
        value: 'yes',
        message: 'Boolean specified as yes but must be one of: t, true, 1, f, false, 0',
      },
    ],
  ])('reports a malformed filter value %j as invalid_parameter', async (filter, entry) => {
    http.route({ match: WORKS_ROUTE, respond: () => validationFailure(entry) });

    const result = await searchWorks({ filter, rows: 1 });

    const error = expectRejection(
      result,
      'invalid_parameter',
      declaredRecovery(searchWorksTool, 'invalid_parameter'),
    );
    expect(error.data).toMatchObject({ rejected: [{ type: entry.type, value: entry.value }] });
    // Crossref's own statement of the accepted form is what the caller corrects against.
    expect(error.message).toContain('must be one of');
    expect(http.calls).toHaveLength(1);
  });

  /**
   * Crossref rejects a blank value on a type-checked key with an entry whose value is empty —
   * nothing to quote back. The tool drops a blank value before the request instead, so that
   * rejection is never reached and a blank value never needs naming.
   */
  it('never sends a blank filter value from the tool, so that rejection is not reached', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Response.json({
          status: 'ok',
          'message-type': 'work-list',
          message: { 'total-results': 5, 'items-per-page': 1, items: [] },
        }),
    });

    const result = await searchWorks({ filter: { type: '', 'has-abstract': 'true' }, rows: 1 });

    expect(result.isError).toBeFalsy();
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('filter')).toBe(
      'has-abstract:true',
    );
  });

  it('lists every rejected input and takes the reason from the first', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => validationFailure(filterNotAvailable('has_abstract'), TYPE_NOT_VALID('foo')),
    });

    const result = await searchWorks({ filter: { has_abstract: 'true', type: 'foo' }, rows: 1 });

    const error = expectRejection(
      result,
      'unknown_filter',
      declaredRecovery(searchWorksTool, 'unknown_filter'),
    );
    expect(error.data?.rejected).toEqual([
      { type: 'filter-not-available', value: 'has_abstract' },
      { type: 'type-not-valid', value: 'foo' },
    ]);
    expect(error.message).toContain('"has_abstract"');
    expect(error.message).toContain('"foo"');
  });

  it('reads a 400 whose body does not parse as invalid_parameter', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response('<html>Bad Request</html>', { status: 400 }),
    });

    const result = await searchWorks({ query: 'crispr', rows: 1 });

    const error = expectRejection(
      result,
      'invalid_parameter',
      declaredRecovery(searchWorksTool, 'invalid_parameter'),
    );
    expect(error.data?.rejected).toEqual([]);
    expect(JSON.stringify(result)).not.toContain('<html>');
    expect(http.calls).toHaveLength(1);
  });

  it('is declared on the tools that can reach it, with one recovery per reason', () => {
    const reasons = (definition: { errors?: ReadonlyArray<{ reason: string }> }) =>
      (definition.errors ?? []).map((entry) => entry.reason);

    expect(reasons(searchWorksTool)).toEqual(
      expect.arrayContaining([
        'unknown_filter',
        'sort_cursor_conflict',
        'invalid_cursor',
        'invalid_parameter',
        'page_too_large',
      ]),
    );
    // Only a works search selects author lists, and the narrowing the recovery names is its own.
    for (const definition of allToolDefinitions.filter((d) => d !== searchWorksTool)) {
      expect(reasons(definition), definition.name).not.toContain('page_too_large');
    }
    for (const definition of [searchJournalsTool, searchFundersTool]) {
      expect(reasons(definition)).toEqual(
        expect.arrayContaining(['invalid_cursor', 'invalid_parameter']),
      );
      for (const reason of ['invalid_cursor', 'invalid_parameter']) {
        expect(declaredRecovery(definition, reason)).toBe(
          declaredRecovery(searchWorksTool, reason),
        );
      }
    }
  });
});

describe('the issn filter value', () => {
  /** Crossref's answer to an issn value it cannot read: a 500 carrying a Java exception. */
  const JAVA_EXCEPTION = JSON.stringify({
    status: 'error',
    'message-type': 'exception',
    'message-version': '1.0.0',
    message: {
      name: 'class java.lang.NullPointerException',
      description:
        'java.lang.NullPointerException: Cannot invoke "java.lang.CharSequence.length()"',
      stack: ['clojure.core$re_matcher.invokeStatic(core.clj:4912)'],
    },
  });

  /**
   * A blank value is dropped by the tool before this check (the key is then omitted), so it is
   * refused here only when it reaches the service directly.
   */
  it.each(['', '  '])('refuses a blank %j at the service, naming the key', async (issn) => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response(JAVA_EXCEPTION, { status: 500 }),
    });

    const error = await getCrossrefService()
      .searchWorks({ filter: { issn }, rows: 1 }, createMockContext())
      .catch((err: unknown) => err);

    expect(error).toBeInstanceOf(McpError);
    expect((error as McpError).message).toContain('filter "issn" was sent blank');
    expect((error as McpError).data).toMatchObject({
      reason: 'invalid_parameter',
      rejected: [{ type: 'issn-not-valid', value: issn }],
    });
    expect(http.calls).toHaveLength(0);
  });

  /**
   * Each value Crossref answers with a 500 — no run of seven digits and a check character once
   * everything but digits and X is stripped. The last two write a second `issn:` pair inside the
   * value, which Crossref splits off and reads on its own; the bad one of the two is named.
   */
  it.each([
    ['123', '123'],
    ['abcd-efgh', 'abcd-efgh'],
    ['0028-083', '0028-083'],
    ['0028-O836', '0028-O836'],
    ['0028X0836', '0028X0836'],
    ['0028-0836,issn:123', '123'],
    ['123,issn:0028-0836', '123'],
  ])('rejects %j before any request, naming the ISSN shape', async (issn, named) => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response(JAVA_EXCEPTION, { status: 500 }),
    });

    const result = await settle(runToolContract(searchWorksTool, { filter: { issn }, rows: 1 }));

    const error = errorOf(result);
    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.data).toMatchObject({
      reason: 'invalid_parameter',
      rejected: [{ type: 'issn-not-valid', value: named }],
    });
    expect(error.message).toContain(`"${named}"`);
    expect(error.message).toContain('NNNN-NNNX');
    expect(textOf(result)).toMatch(/Recovery: .*NNNN-NNNX/);
    expect(http.calls).toHaveLength(0);
  });

  /**
   * Every spelling Crossref reads as an ISSN — measured against the live route, each of these
   * resolves to its journal's works — so none is refused here. The separator variants are what a
   * value copied from a web page or a PDF looks like; the last is Crossref's own filter syntax
   * for two ISSNs at once.
   */
  it.each([
    '0028-0836',
    '00280836',
    '2167-647X',
    '2167-647x',
    ' 0028-0836 ',
    '0028–0836',
    '0028 0836',
    'ISSN 0028-0836',
    '0028-08361',
    '0028-0836,issn:1476-4687',
  ])('sends %j through as given', async (issn) => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        Response.json({
          status: 'ok',
          'message-type': 'work-list',
          message: { 'total-results': 0, 'items-per-page': 1, items: [] },
        }),
    });

    const result = await settle(runToolContract(searchWorksTool, { filter: { issn }, rows: 1 }));

    expect(result.isError).toBeFalsy();
    expect(http.calls).toHaveLength(1);
    expect(new URL(http.calls[0]?.request.url ?? '').searchParams.get('filter')).toBe(
      `issn:${issn}`,
    );
  });

  it('keeps the raw body of a 500 off the error data', async () => {
    // A filter the pre-request check does not cover, reaching the same upstream failure.
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response(JAVA_EXCEPTION, { status: 500 }),
    });

    const result = await settle(runToolContract(searchWorksTool, { query: 'crispr', rows: 1 }));

    const error = errorOf(result);
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 500 });
    expect(error.data).not.toHaveProperty('body');
    expect(error.data).not.toHaveProperty('responseBody');
    expect(JSON.stringify(result)).not.toContain('NullPointerException');
  });
});

describe('a page too large for Crossref to assemble', () => {
  /** Crossref's 500 for a works page past its buffer, as captured from the live route. */
  const CONTENT_TOO_LONG = readFileSync(
    new URL('../../fixtures/errors/content-too-long-500.json', import.meta.url),
    'utf8',
  );

  /** The captured body with one field of its `message` replaced, every other field as sent. */
  function capturedWith(field: string, value: unknown): string {
    const body = JSON.parse(CONTENT_TOO_LONG);
    body.message[field] = value;
    return JSON.stringify(body);
  }

  /** The captured body padded to exactly `bytes` bytes, the padding in its description. */
  function capturedPaddedTo(bytes: number): string {
    const body = JSON.parse(CONTENT_TOO_LONG);
    body.message.description += 'x'.repeat(bytes - JSON.stringify(body).length);
    return JSON.stringify(body);
  }

  const RECOVERY =
    'Halve rows, and halve again if that page is refused too, or pass fields without author — an omitted fields selects author, and author lists are what fill a page this large. Trimming rows by a few can be refused again, and reissuing the same call always is.';
  const WITH_SIZES =
    "Crossref could not serve this page (HTTP 500): it reported the page's content at 107929917 bytes, over its 104857600-byte buffer limit.";
  const WITHOUT_SIZES =
    "Crossref could not serve this page (HTTP 500): it reported the page's content as over its buffer limit.";

  /** Answer every works request with a 500 carrying `body`. */
  function serve500(body: string): void {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        new Response(body, { status: 500, headers: { 'content-type': 'application/json' } }),
    });
  }

  const encoded = (text: string): Uint8Array => new TextEncoder().encode(text);

  /** Each reason the service cancelled a streamed 500 body with, one per cancelled send. */
  const cancels: unknown[] = [];
  beforeEach(() => {
    cancels.length = 0;
  });

  /** A 500 whose body is the stream `source` describes, its cancels recorded in `cancels`. */
  function streamed500(source: UnderlyingDefaultSource<Uint8Array>): Response {
    return new Response(
      new ReadableStream<Uint8Array>({
        ...source,
        cancel(reason) {
          cancels.push(reason);
          return source.cancel?.(reason);
        },
      }),
      { status: 500 },
    );
  }

  /** A 500 whose body sends its first bytes and then nothing, until the request is aborted. */
  const stalled500: Responder = (request) =>
    streamed500({
      start(stream) {
        stream.enqueue(encoded('{"status":"error",'));
        request.signal.addEventListener('abort', () => stream.error(request.signal.reason), {
          once: true,
        });
      },
    });

  function serveStalled500(): void {
    http.route({ match: WORKS_ROUTE, respond: stalled500 });
  }

  /** A 500 sending the captured body with its last bytes `ms` after the headers, unless cancelled first. */
  const lastBytesAfter =
    (ms: number): Responder =>
    () => {
      const bytes = encoded(CONTENT_TOO_LONG);
      let timer: ReturnType<typeof setTimeout> | undefined;
      return streamed500({
        start(stream) {
          stream.enqueue(bytes.subarray(0, -16));
          timer = setTimeout(() => {
            stream.enqueue(bytes.subarray(-16));
            stream.close();
          }, ms);
        },
        cancel() {
          clearTimeout(timer);
        },
      });
    };

  /** A 500 sending `sent` on its first pull and failing on its second, with no abort. */
  const failingAfter =
    (sent: string): Responder =>
    () => {
      let pulls = 0;
      return streamed500({
        pull(stream) {
          pulls += 1;
          if (pulls === 1) stream.enqueue(encoded(sent));
          else stream.error(new TypeError('terminated'));
        },
      });
    };

  /** The call the refused page came from: a heavy filter, at the opt-in tier's 200-row cap. */
  const searchHeavyPage = () =>
    settle(
      runToolContract(searchWorksTool, {
        filter: { funder: '501100013699', prefix: '10.1103', 'from-pub-date': '2022' },
        rows: 200,
      }),
    );

  it('fails as page_too_large after one attempt, naming both of the sizes Crossref gives', async () => {
    serve500(CONTENT_TOO_LONG);

    const result = await searchHeavyPage();
    const error = errorOf(result);
    const rendered = renderedText(textOf(result));

    expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
    expect(error.message).toBe(WITH_SIZES);
    expect(error.data).toEqual({
      retryable: false,
      reason: 'page_too_large',
      recovery: { hint: RECOVERY },
    });
    expect(rendered).toContain(`Error: ${WITH_SIZES}`);
    expect(rendered).toContain(`Recovery: ${RECOVERY}`);
    expect(rendered).toContain('(reason page_too_large · not retryable)');
    expect(http.calls).toHaveLength(1);
  });

  it('keeps the body, its stack, and the request URL off both surfaces and the log line', async () => {
    const warning = vi.spyOn(logger, 'warning').mockImplementation(() => {});
    serve500(CONTENT_TOO_LONG);

    const result = await searchHeavyPage();
    const error = errorOf(result);
    const wire = JSON.stringify(result);
    const logged = JSON.stringify(
      warning.mock.calls.map(([message, context]) => [message, context]),
    );

    for (const key of ['body', 'responseBody', 'url', 'stack', 'status', 'statusCode']) {
      expect(error.data).not.toHaveProperty(key);
    }
    for (const fromBody of [
      'ContentTooLongException',
      'entity content is too long',
      'HeapBufferedAsyncResponseConsumer',
      'elasticsearch',
    ]) {
      expect(wire).not.toContain(fromBody);
      expect(logged).not.toContain(fromBody);
    }
    expect(wire).not.toContain(BASE_URL);
    expect(wire).not.toContain('501100013699');
    warning.mockRestore();
  });

  it.each([
    ['no sizes', 'entity content is too long'],
    ['one size alone', 'entity content is too long [107929917]'],
    [
      'a size longer than any page',
      `entity content is too long [${'9'.repeat(16)}] for the configured buffer limit [104857600]`,
    ],
    [
      'sizes that are not digits',
      'entity content is too long [1e9] for the configured buffer limit [0x64]',
    ],
    ['no message at all', undefined],
    ['a message that is not text', 107929917],
    [
      'a message that is a list',
      ['entity content is too long [107929917] for the configured buffer limit [104857600]'],
    ],
  ])(
    'fails as page_too_large worded without sizes when the message carries %s',
    async (_label, message) => {
      serve500(capturedWith('message', message));

      const error = errorOf(await searchHeavyPage());

      expect(error.code).toBe(JsonRpcErrorCode.ValidationError);
      expect(error.message).toBe(WITHOUT_SIZES);
      expect(error.data).toMatchObject({
        retryable: false,
        reason: 'page_too_large',
        recovery: { hint: RECOVERY },
      });
      expect(http.calls).toHaveLength(1);
    },
  );

  it('names a size of 15 digits, the longest it reads, in the message', async () => {
    serve500(
      capturedWith(
        'message',
        `entity content is too long [${'9'.repeat(15)}] for the configured buffer limit [104857600]`,
      ),
    );

    expect(errorOf(await searchHeavyPage()).message).toBe(
      "Crossref could not serve this page (HTTP 500): it reported the page's content at 999999999999999 bytes, over its 104857600-byte buffer limit.",
    );
  });

  it('classifies a body at the 64 KiB read bound and none past it', async () => {
    serve500(capturedPaddedTo(65_536));
    expect(errorOf(await searchHeavyPage()).data).toMatchObject({ reason: 'page_too_large' });
    expect(http.calls).toHaveLength(1);

    http.reset();
    serve500(capturedPaddedTo(65_537));
    expect(errorOf(await searchHeavyPage()).data).toMatchObject({
      reason: 'upstream_unavailable',
      status: 500,
    });
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  /** `body`'s bytes as a stream of two chunks, each half the body, whatever the runtime's chunking. */
  function inTwoChunks(body: string): UnderlyingDefaultSource<Uint8Array> {
    const bytes = encoded(body);
    const half = Math.ceil(bytes.length / 2);
    return {
      start(stream) {
        stream.enqueue(bytes.subarray(0, half));
        stream.enqueue(bytes.subarray(half));
        stream.close();
      },
    };
  }

  it('holds the 64 KiB read bound on the bytes of every chunk together', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => streamed500(inTwoChunks(capturedPaddedTo(65_536))),
    });
    expect(errorOf(await searchHeavyPage()).data).toMatchObject({ reason: 'page_too_large' });
    expect(http.calls).toHaveLength(1);

    http.reset();
    http.route({
      match: WORKS_ROUTE,
      respond: () => streamed500(inTwoChunks(capturedPaddedTo(65_537))),
    });
    expect(errorOf(await searchHeavyPage()).data).toMatchObject({
      reason: 'upstream_unavailable',
      status: 500,
    });
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('cancels a body past the 64 KiB read bound on every send', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () =>
        streamed500({
          pull(stream) {
            stream.enqueue(encoded('x'.repeat(40_000)));
          },
        }),
    });

    expect(errorOf(await searchHeavyPage()).data).toMatchObject({
      reason: 'upstream_unavailable',
      status: 500,
    });
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
    expect(cancels).toHaveLength(TOTAL_ATTEMPTS);
  });

  it.each([
    [
      'a body naming another exception',
      capturedWith('name', 'class java.lang.NullPointerException'),
    ],
    ['a body naming no exception', capturedWith('name', undefined)],
    ['a body that is not JSON', 'boom'],
    ['an empty body', ''],
    ['JSON that is not an exception envelope', '[1,2,3]'],
  ])('keeps upstream_unavailable and its four attempts on %s', async (_label, body) => {
    serve500(body);

    const result = await searchHeavyPage();
    const error = errorOf(result);

    expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
    expect(error.message).toBe(
      `Crossref returned HTTP 500. (failed after ${TOTAL_ATTEMPTS} attempts)`,
    );
    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 500 });
    expect(textOf(result)).toContain(UPSTREAM_UNAVAILABLE.recovery);
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('keeps upstream_unavailable on a 503 whose body names the same exception', async () => {
    http.route({
      match: WORKS_ROUTE,
      respond: () => new Response(CONTENT_TOO_LONG, { status: 503 }),
    });

    const error = errorOf(await searchHeavyPage());

    expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 503 });
    expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
  });

  it('leaves the upstream_unavailable contract text as it was', () => {
    expect(UPSTREAM_UNAVAILABLE.when).toBe(
      'Crossref was unreachable, returned a 5xx status, or served an HTML error page instead of JSON.',
    );
    expect(UPSTREAM_UNAVAILABLE.recovery).toBe(
      'The request was accepted as well-formed and Crossref failed to serve it — retry the same call in a minute rather than rewriting the query, and check https://status.crossref.org if it keeps failing.',
    );
  });

  /**
   * A 500's body is read for 2 s at most, so a body that does not arrive costs a send that long and
   * no more. Backoff jitter is pinned to its midpoint, so the waits are exactly 1 s, 2 s, and 4 s.
   */
  describe('a 500 whose body does not arrive', () => {
    let random: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      random = vi.spyOn(Math, 'random').mockReturnValue(0.5);
    });

    afterEach(() => {
      random.mockRestore();
    });

    it('is retried as any other 500 once its 2 s read bound passes, each body cancelled', async () => {
      serveStalled500();

      // Reads cut at 2 s, 5 s, 9 s, and 15 s: sends at 0 s, 3 s, 7 s, and 13 s.
      const call = track(runToolContract(searchWorksTool, { query: 'collaboration', rows: 1 }));
      await vi.advanceTimersByTimeAsync(14_999);
      expect(call.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(call.settled).toBe(true);
      expect(errorOf(await call.result())).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        message: `Crossref returned HTTP 500. (failed after ${TOTAL_ATTEMPTS} attempts)`,
        data: { reason: 'upstream_unavailable', status: 500 },
      });
      expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
      expect(cancels).toHaveLength(TOTAL_ATTEMPTS);
      expect(vi.getTimerCount()).toBe(0);
    });

    it.each([
      ['one stalled 500', [stalled500], 3_000],
      ['two stalled 500s', [stalled500, stalled500], 7_000],
    ])('serves the page Crossref sends after %s', async (_label, stalls, servedAtMs) => {
      http.route({
        match: WORKS_ROUTE,
        respond: inTurn(...stalls, () =>
          workList([{ DOI, type: 'journal-article', title: ['T'] }]),
        ),
      });

      const call = track(runToolContract(searchWorksTool, { query: 'collaboration', rows: 1 }));
      await vi.advanceTimersByTimeAsync(servedAtMs - 1);
      expect(call.settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);

      expect(call.settled).toBe(true);
      const result = await call.result();
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ works: [{ doi: DOI }] });
      expect(http.calls).toHaveLength(stalls.length + 1);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('classifies the captured body whole inside the read bound, and not one finishing past it', async () => {
      http.route({ match: WORKS_ROUTE, respond: lastBytesAfter(1_999) });
      const call = track(runToolContract(searchWorksTool, { query: 'collaboration', rows: 1 }));
      await vi.advanceTimersByTimeAsync(1_999);

      expect(call.settled).toBe(true);
      expect(errorOf(await call.result()).data).toMatchObject({ reason: 'page_too_large' });
      expect(http.calls).toHaveLength(1);
      expect(cancels).toHaveLength(0);
      // The bound's timer is cleared with the read it bounds, not left pending.
      expect(vi.getTimerCount()).toBe(0);

      http.reset();
      http.route({ match: WORKS_ROUTE, respond: lastBytesAfter(2_001) });
      expect(errorOf(await searchHeavyPage()).data).toMatchObject({
        reason: 'upstream_unavailable',
        status: 500,
      });
      expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
      expect(cancels).toHaveLength(TOTAL_ATTEMPTS);
      expect(vi.getTimerCount()).toBe(0);
    });

    it('keeps upstream_unavailable when a CROSSREF_TIMEOUT_MS shorter than the bound cuts the read', async () => {
      vi.mocked(getServerConfig).mockReturnValueOnce({
        mailto: 'test@example.com',
        baseUrl: BASE_URL,
        timeoutMs: 1_000,
      });
      initCrossrefService();
      serveStalled500();

      const error = errorOf(await searchHeavyPage());

      expect(error).toMatchObject({
        code: JsonRpcErrorCode.ServiceUnavailable,
        data: { reason: 'upstream_unavailable', status: 500 },
      });
      expect(error.data).not.toHaveProperty('timeoutMs');
      expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
    });
  });

  it.each([
    ['part of the body', '{"status":"error",'],
    ['the whole body', CONTENT_TOO_LONG],
  ])(
    'keeps upstream_unavailable and its four attempts when the body stream fails after %s',
    async (_label, sent) => {
      http.route({ match: WORKS_ROUTE, respond: failingAfter(sent) });

      const error = errorOf(await searchHeavyPage());

      expect(error.code).toBe(JsonRpcErrorCode.ServiceUnavailable);
      expect(error.message).toBe(
        `Crossref returned HTTP 500. (failed after ${TOTAL_ATTEMPTS} attempts)`,
      );
      expect(error.data).toMatchObject({ reason: 'upstream_unavailable', status: 500 });
      expect(http.calls).toHaveLength(TOTAL_ATTEMPTS);
    },
  );

  it('reports a cancellation during the body read as RequestCancelled, unretried', async () => {
    const controller = new AbortController();
    serveStalled500();

    const call = track(
      getCrossrefService().searchWorks(
        { query: 'collaboration', rows: 1 },
        createMockContext({ signal: controller.signal }),
      ),
    );
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('caller cancelled'));
    await vi.advanceTimersByTimeAsync(0);

    expect(call.settled).toBe(true);
    expect(await call.error()).toMatchObject({ code: JsonRpcErrorCode.RequestCancelled });
    expect(http.calls).toHaveLength(1);
  });

  /**
   * `pageTooLarge` reads an upstream body of up to 64 KiB; each shape runs it far past that so
   * any super-linear step in the parse or the size match shows in the ratio.
   */
  function contentTooLongBody(size: number, unit: string, head = '', tail = ''): string {
    const wrap = (message: string) =>
      JSON.stringify({
        message: { name: 'class org.apache.http.ContentTooLongException', message },
      });
    const unitLength = JSON.stringify(unit).length - 2;
    const room = size - wrap(`${head}${tail}`).length;
    return wrap(`${head}${unit.repeat(Math.floor(room / unitLength))}${tail}`);
  }

  it.each([
    ['a repeated opener with no closer', (size: number) => contentTooLongBody(size, '[')],
    ['an opener and digit with no closer', (size: number) => contentTooLongBody(size, '[1')],
    ['one opener before a long digit run', (size: number) => contentTooLongBody(size, '1', '[')],
    ['closed numbers never paired', (size: number) => contentTooLongBody(size, '[1]]')],
    ['a closed number then no second', (size: number) => contentTooLongBody(size, 'x', '[1]')],
    [
      'one long line ending in a break',
      (size: number) => contentTooLongBody(size, '§1 x', '[1]', '\ny'),
    ],
    ['line breaks throughout', (size: number) => contentTooLongBody(size, '  \r\n', '[1]')],
  ])(
    'classifies in linear time on %s',
    (_name, make) => {
      expectLinearScaling(make, pageTooLarge);
    },
    0,
  );
});

describe('upstream error contract', () => {
  it('is declared on every tool, since every tool reaches Crossref through the service', () => {
    for (const definition of allToolDefinitions) {
      const declared = (definition.errors ?? []).map((entry) => entry.reason);
      for (const entry of UPSTREAM_ERROR_CONTRACT) {
        expect(declared).toContain(entry.reason);
      }
    }
  });
});
