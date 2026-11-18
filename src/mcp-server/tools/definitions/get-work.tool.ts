/**
 * @fileoverview crossref_get_work — resolves a DOI to its full Crossref metadata record.
 * The deposited author list is paged by offset/limit the way crossref_get_references pages
 * references: the slice happens once in the handler, so structuredContent and content[] carry
 * the identical page, and authorCount reports the full deposited total. A grant deposits no
 * authors; the investigators of its projects are paged by the same window, slice, continuation,
 * and notice, with investigatorCount the full total.
 * A funder, an affiliation, and an institution are the organizations a record names, and a
 * publisher may assert any of them through the ROR registry instead of by name — so each is
 * projected with the identifier standing in for the name it lacks, on both surfaces, rather than
 * as a blank entry.
 * Editors, update links, related identifiers, clinical trial numbers, and Crossmark assertions are
 * returned whole: none approaches the author tail, and each is relayed entry for entry as
 * deposited. Update links also feed the notice, which shares its one string with the
 * author-paging guidance.
 * A posted-content preprint costs a second request, for the works whose records name it in
 * has-preprint (publishedVersions). A failed lookup leaves the record whole and says so in the
 * notice; only a rate limit or the caller's cancellation fails the call.
 * @module mcp-server/tools/definitions/get-work.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { mdText, mdTextAtLineStart, mdTextInHeading } from '@/mcp-server/tools/markdown-text.js';
import {
  clampPageSize,
  ENTRY_LIMIT_CEILING,
  GET_WORK_LIMIT_CAP,
} from '@/mcp-server/tools/page-size.js';
import { notFoundDetail } from '@/mcp-server/tools/registration-agency.js';
import {
  assertionFields,
  assertionSections,
  projectAssertions,
} from '@/mcp-server/tools/work-assertions.js';
import {
  approvedFields,
  approvedLine,
  DatePartsSchema,
  eventFields,
  eventLine,
  projectApproved,
  projectEvent,
} from '@/mcp-server/tools/work-dates.js';
import {
  FunderSchema,
  funderSection,
  LicenseSchema,
  LinkSchema,
  licenseSection,
  linkSection,
  normalizeFunder,
  projectLicenses,
  projectLinks,
  rorId,
  UNNAMED,
} from '@/mcp-server/tools/work-funders-licenses-links.js';
import {
  grantFields,
  grantLines,
  type PageCount,
  projectGrant,
  projectReview,
  projectSections,
  reviewFields,
  reviewLines,
} from '@/mcp-server/tools/work-grants-reviews.js';
import { locatorFields, locatorLine, projectLocators } from '@/mcp-server/tools/work-locators.js';
import {
  projectUpdates,
  type Update,
  updateFields,
  updateSections,
} from '@/mcp-server/tools/work-updates.js';
import {
  getCrossrefService,
  normalizeDoi,
  PUBLISHED_VERSION_ROWS,
  type PublishedVersionsLookup,
  type PublishedVersion as RawPublishedVersion,
} from '@/services/crossref/crossref-service.js';
import { formatDateParts, resolveWorkDate } from '@/services/crossref/date-parts.js';
import {
  normalizeAbstract,
  normalizeMarkupText,
  normalizeNonEmptyText,
  normalizeNonEmptyTexts,
  normalizeText,
} from '@/services/crossref/markup-text.js';
import type {
  CrossrefAffiliation,
  CrossrefAuthor,
  CrossrefInstitution,
  CrossrefRelation,
} from '@/services/crossref/types.js';
import { UPSTREAM_ERROR_CONTRACT } from '@/services/crossref/upstream-errors.js';

const AuthorSchema = z
  .object({
    given: z.string().optional().describe('Given (first) name'),
    family: z.string().optional().describe('Family (last) name'),
    name: z.string().optional().describe('Name when no given/family split is available'),
    orcid: z.string().optional().describe('ORCID identifier URI'),
    affiliation: z
      .array(
        z
          .object({
            name: z
              .string()
              .optional()
              .describe(
                'Affiliation name as deposited. Absent when the publisher asserted the organization by identifier alone, where ror carries it instead.',
              ),
            ror: z
              .string()
              .optional()
              .describe(
                'ROR identifier for the affiliated organization, when the deposit carries one. It is the whole identity of an affiliation deposited without a name.',
              ),
          })
          .describe('Affiliation'),
      )
      .optional()
      .describe('Institutional affiliations'),
    sequence: z.string().optional().describe('Author order role (first, additional)'),
  })
  .describe('Author or contributor');

const InstitutionSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'Institution name as deposited. Absent when the deposit identifies the institution by identifier alone, where ror carries it when that identifier is a ROR.',
      ),
    ror: z
      .string()
      .optional()
      .describe(
        'ROR identifier for the institution, when the deposit carries one. It is the whole identity of an institution deposited without a name.',
      ),
    place: z.array(z.string()).optional().describe('Places as deposited, such as a city'),
    department: z
      .array(z.string())
      .optional()
      .describe('Departments, faculties, or schools as deposited'),
    acronym: z.array(z.string()).optional().describe('Acronyms as deposited'),
  })
  .describe('Institution');

const RelationSchema = z
  .object({
    type: z
      .string()
      .describe(
        'Relation type as deposited, read from this work toward ids: is-preprint-of, has-preprint, is-version-of, has-version, has-review, is-supplemented-by, references, has-part, and others',
      ),
    idType: z
      .string()
      .describe('Identifier scheme of ids: doi, uri, pmid, arxiv, accession, issn, isbn, or other'),
    assertedBy: z
      .string()
      .describe(
        "Whose deposit asserts the relation: subject (this work's depositor) or object (the related record's depositor, whose assertion Crossref shows here inverted)",
      ),
    ids: z
      .array(z.string())
      .describe(
        'Related identifiers in deposited order. A DOI resolves through crossref_get_work only when Crossref registered it; one registered with another agency, such as DataCite, returns doi_not_found there.',
      ),
  })
  .describe('Related identifiers sharing one relation type, identifier type, and asserting party');

const PublishedVersionSchema = z
  .object({
    doi: z
      .string()
      .describe(
        'DOI of the work, as Crossref records it — pass to crossref_get_work for its record',
      ),
    type: z
      .string()
      .optional()
      .describe(
        'Work type as deposited, e.g. journal-article. Omitted when the record deposits none.',
      ),
    title: z
      .string()
      .optional()
      .describe(
        "Work title, with markup removed as this record's own title is. Omitted when the record deposits none.",
      ),
  })
  .describe('A work whose own record names this preprint in has-preprint');

export const getWorkTool = tool('crossref_get_work', {
  title: 'Get Work by DOI',
  description:
    'Resolves a DOI to its full Crossref metadata record: title, authors, editors, affiliations, abstract (when deposited), journal or container with the volume, issue, pages, and article number that locate the work in it, ISSNs and ISBNs, publication date, type, license, full-text links, and funder acknowledgements. Where the record deposits them it also carries the conference event of a proceedings paper (event), the approval date that dissertations and most standards deposit in place of a publication date (approved, never read into published), the institutions a record names (the awarding institution of a thesis, the server of a preprint, the laboratories behind a report) and the degree of a thesis, and the subtype and group title of posted content such as a preprint. The author list is paged: authorCount is the full deposited total, offset and limit select the page (25 authors by default), and when authors remain the response carries a nextOffset to pass back as offset — large-collaboration papers deposit thousands. A grant, which deposits no title or abstract, carries its award number (award), award start, and projects: titles, descriptions, lead and co-lead investigators, investigators, amounts, dates, and funding, each funder with its Funder Registry DOI or ROR. Its investigators are paged by offset and limit the way authors are, across its projects in deposited order, with investigatorCount the full total; lead and co-lead investigators come back whole. A peer review carries review — its stage, type, running number, revision round, recommendation, competing-interest statement, and language, where deposited. Post-publication updates are relayed as Crossref records them: updatedBy names each correction, retraction, expression of concern, or new version issued against this work, with its notice DOI and whether the publisher or Retraction Watch recorded it, and updateTo names the works this record is itself a notice for. An absent updatedBy does not mean the work was never updated — coverage depends on those deposits. relations lists related identifiers, such as a preprint and its published version, grouped by relation type; only the Crossref-registered DOIs among them resolve through crossref_get_work. The record of a preprint can leave out its published version, so on a posted-content record of subtype preprint a second request reads publishedVersions: the works whose own records name it in has-preprint, each with its DOI, type, and title. Every other record takes one request. clinicalTrialNumbers lists the trial registrations the work names, each with its registry where deposited, and assertions the Crossmark entries its publisher attaches — received, revised, and accepted dates, ethics and competing-interest statements, peer-review details — both returned whole in deposited order; an absent clinicalTrialNumbers does not mean the work reports no trial. memberId is the Crossref member that holds the DOI now — pass it to crossref_get_member for the publisher record and its deposit coverage; the prefix of the DOI names the member that registered the prefix, which for a transferred title is a former publisher. Outgoing references are reported as a count in referencesCount; the reference entries themselves come from crossref_get_references. The isReferencedByCount field reports the total incoming citation count from Crossref; the citing works themselves are not available through Crossref — use OpenAlex for citation graphs.',
  annotations: { readOnlyHint: true, idempotentHint: true },

  input: z.object({
    doi: z
      .string()
      .regex(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:)?10\.\d{4,9}\/\S+$/i, {
        message:
          'DOI must be "10." followed by 4–9 digits and a slash, e.g. "10.1038/nature12373", optionally wrapped in its resolver ("https://doi.org/…", "doi:…").',
      })
      .describe(
        'DOI in the format "10.NNNN/suffix", e.g. "10.1038/nature12373". A resolver-wrapped form — "https://doi.org/10.1038/nature12373", "https://dx.doi.org/…", "doi:10.1038/nature12373" — is accepted and unwrapped.',
      ),
    offset: z
      .number()
      .int()
      .min(0)
      .default(0)
      .describe(
        'Zero-based index of the first author to return — on a grant, which deposits no authors, the first investigator, counted across its projects in deposited order. Pass the nextOffset value from the previous response to continue through a long list. Only the author and investigator lists are paged; every other field of the record, lead and co-lead investigators included, is returned in full on every page.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(ENTRY_LIMIT_CEILING)
      .default(25)
      .describe(
        `Maximum number of authors — on a grant, investigators — to return in one page (1–${GET_WORK_LIMIT_CAP} per call, default 25). A larger value, up to ${ENTRY_LIMIT_CEILING}, returns ${GET_WORK_LIMIT_CAP} and says so in notice; nextOffset continues after the entries returned. Ordinary records fit in a single page; large-collaboration papers in particle physics and genomics deposit thousands of authors, and some grants hundreds of investigators.`,
      ),
  }),

  output: z.object({
    doi: z.string().describe('Canonical DOI'),
    title: z.string().optional().describe('Work title'),
    subtitle: z.string().optional().describe('Subtitle when present'),
    type: z
      .string()
      .optional()
      .describe('Work type (e.g. journal-article, book-chapter, posted-content)'),
    subtype: z
      .string()
      .optional()
      .describe(
        'Kind of posted content as deposited, e.g. preprint or other. Omitted when the record deposits none.',
      ),
    authors: z
      .array(AuthorSchema)
      .optional()
      .describe(
        'Page of the author and contributor list, bounded by limit. Omitted when the record deposits no author field at all.',
      ),
    authorCount: z
      .number()
      .optional()
      .describe(
        'Total number of authors in the deposited list, before offset and limit were applied. Omitted alongside authors when the record deposits no author field.',
      ),
    offset: z
      .number()
      .optional()
      .describe(
        'Zero-based index of the first returned author — on a grant, the first returned investigator — within the deposited list. Omitted when the record deposits neither an author field nor an investigator list.',
      ),
    editors: z
      .array(AuthorSchema)
      .optional()
      .describe(
        'Editors of the work, or of the book or proceedings containing it, in the entry shape authors use. Returned whole — never paged by offset and limit, and never counted in authorCount. Omitted when the record deposits none.',
      ),
    ...grantFields,
    ...reviewFields,
    ...updateFields,
    relations: z
      .array(RelationSchema)
      .optional()
      .describe(
        "Related identifiers — preprints and published versions, other versions, reviews, supplements, parts — grouped by relation type, identifier type, and asserting party, groups in Crossref's order and ids in deposited order. Returned whole. Omitted when the record deposits none. A preprint's own record can leave out its published version while the article's record still names the preprint: on a posted-content preprint, publishedVersions lists the works whose records name it, which crossref_search_works also finds with the filter relation.type has-preprint and relation.object this record's DOI.",
      ),
    publishedVersions: z
      .array(PublishedVersionSchema)
      .optional()
      .describe(
        `On a posted-content record of subtype preprint, the works whose own records name it in has-preprint — its published version, usually one article — read by a second request. At most ${PUBLISHED_VERSION_ROWS}: when more name it, notice gives the total and the crossref_search_works filter that lists every one. An empty list means no Crossref record names this preprint. Omitted on every other record, and when the lookup failed, which notice then says — an absent list never means no published version. A work here can also appear in relations, which reads this record's own deposit; the two lists are separate deposits and neither is deduplicated against the other.`,
      ),
    abstract: z
      .string()
      .optional()
      .describe(
        'Abstract when deposited by the publisher. Many records lack abstracts, and one whose deposit holds no text is omitted the same way. Publishers deposit it as JATS XML, so this is the text of that deposit with markup removed and character references decoded; each section heading of a structured abstract is followed by a colon ("Objectives: …") unless it already ends in a period, colon, question mark, or exclamation mark, a heading whose section holds no text (a figure-only "Graphical Abstract") is dropped, the "Abstract" heading a deposit opens with is dropped, and the items of one list are joined by "; " unless an item already ends in a period, comma, semicolon, colon, question mark, or exclamation mark; numeric JATS superscripts retain caret notation (10^{16}, GeV^2), a link keeps its tag only where its href holds an address the text it wraps does not already carry, and each formula appears once — MathML as the TeX annotation it carries, otherwise written out linearly (x_i, A^{−1}, √(m), (a+b)/c), and TeX deposited beside MathML in whichever notation comes first.',
      ),
    isReferencedByCount: z
      .number()
      .optional()
      .describe('Incoming citation count from Crossref — the count of works citing this DOI'),
    referencesCount: z
      .number()
      .optional()
      .describe('Number of outgoing references (works cited by this paper)'),
    containerTitle: z
      .string()
      .optional()
      .describe(
        'Journal, book, or proceedings name containing this work — the first entry of containerTitles',
      ),
    containerTitles: z
      .array(z.string())
      .optional()
      .describe(
        'Every container title the record deposits, in deposited order. A book chapter or proceedings paper often deposits two: the series, then the book or volume. Omitted when the record deposits none.',
      ),
    groupTitle: z
      .string()
      .optional()
      .describe(
        'Group title as deposited on posted content — the collection or subject a server files the work under, such as "Developmental Biology" on bioRxiv, or the server itself, such as "SSRN". Omitted when the record deposits none.',
      ),
    ...locatorFields,
    ...eventFields,
    issn: z.array(z.string()).optional().describe('ISSN(s) of the containing journal'),
    isbn: z
      .array(z.string())
      .optional()
      .describe(
        'ISBN(s) as deposited — for a book chapter, those of the containing book. Omitted when the record deposits none.',
      ),
    publisher: z.string().optional().describe('Publisher name'),
    memberId: z
      .number()
      .optional()
      .describe(
        "Crossref member ID of the publisher that holds this DOI now — pass to crossref_get_member for its record. The DOI's prefix names the member that registered the prefix, which for a transferred title is a former publisher. Omitted when the record deposits no member.",
      ),
    institutions: z
      .array(InstitutionSchema)
      .optional()
      .describe(
        'Institutions the record names, in deposited order — the awarding institution of a thesis, the server a preprint was posted to, the laboratories behind a report — read wherever deposited, whatever the work type. Distinct from publisher, which for many theses names a library or repository and for many preprints the platform company. Omitted when the record deposits none.',
      ),
    degree: z
      .array(z.string())
      .optional()
      .describe(
        'Degree a thesis was submitted for, as deposited, e.g. "Doutorado em Educação". Omitted when the record deposits none.',
      ),
    published: DatePartsSchema.optional().describe(
      'Publication date — the first of published, published-print, published-online, and issued that names one. A component Crossref records as unknown is omitted, and so is every component below it. A grant deposits only issued, which Crossref sets to the award start, so on a grant this is the award start.',
    ),
    ...approvedFields,
    funders: z.array(FunderSchema).optional().describe('Funding acknowledgements'),
    ...assertionFields,
    licenses: z.array(LicenseSchema).optional().describe('License terms'),
    links: z.array(LinkSchema).optional().describe('Registered full-text links'),
    url: z.string().optional().describe('DOI resolution URL'),
    subject: z.array(z.string()).optional().describe('Subject classification terms'),
    language: z.string().optional().describe('Language code (ISO 639)'),
  }),

  enrichment: {
    nextOffset: z
      .number()
      .optional()
      .describe(
        'Offset to pass in the next call to retrieve the following page of authors — on a grant, of investigators. Absent when this page reaches the end of the list.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe(
        'True when authors — on a grant, investigators — remain beyond this page. Absent when the page is the last.',
      ),
    shown: z
      .number()
      .optional()
      .describe('Number of authors — on a grant, investigators — returned in this page.'),
    cap: z
      .number()
      .optional()
      .describe('The limit that was applied to this page of authors or investigators.'),
    notice: z
      .string()
      .optional()
      .describe(
        `When updatedBy is present, the update types Crossref records for this work with the source of each, and where the notice is read. Then, on a posted-content preprint, that the published-version lookup failed and publishedVersions is omitted, or that more than ${PUBLISHED_VERSION_ROWS} works name the preprint, with the total — either way naming the crossref_search_works filter that runs the lookup. Then, when limit was above its per-call cap, the value requested and the cap applied. Then which authors — on a grant, which investigators — this page covers and the offset that reaches the next ones, or an explanation when the requested offset is past the end of the list. All share this one string when more than one applies. Absent when the page holds the whole list, no update is recorded, any published-version lookup returned every work naming the preprint, and limit was within its cap.`,
      ),
  },

  errors: [
    ...UPSTREAM_ERROR_CONTRACT,
    {
      reason: 'doi_not_found',
      code: JsonRpcErrorCode.NotFound,
      when: 'Valid DOI format but no Crossref record exists.',
      recovery:
        'Verify the DOI is correct or use crossref_search_works to find similar works by title or author.',
    },
  ],

  async handler(input, ctx) {
    /**
     * The schema admits the resolver-wrapped forms; the request path, the log, and the
     * not-found message all read the bare DOI, so the unwrap happens once, here.
     */
    const doi = normalizeDoi(input.doi);
    // Clamped once, here, so the author slice, nextOffset, and the `cap` enrichment read the page size used.
    const limitClamp = clampPageSize('limit', input.limit, GET_WORK_LIMIT_CAP);
    const limit = limitClamp.value;
    ctx.log.info('Resolving DOI', { doi });
    const svc = getCrossrefService();
    const raw = await svc.getWork(doi, ctx);
    if (!raw) {
      const detail = notFoundDetail({
        subject: 'doi',
        message: `No Crossref record for DOI: ${doi}`,
        recovery: ctx.recoveryFor('doi_not_found').recovery.hint,
        lookup: await svc.getDoiRegistration(doi, ctx),
      });
      throw ctx.fail('doi_not_found', detail.message, { doi, ...detail.data });
    }
    /**
     * A preprint's published version can be missing from its own record while the article's
     * record names it, so a preprint costs one more request. Gated on the subtype as well as the
     * type: every work Crossref holds a `has-preprint` link to is a posted-content preprint, and
     * other posted content (supplementary material, blogs) gains nothing from the lookup. The
     * record's own DOI is sent, not the caller's spelling of it — see `getPublishedVersions`.
     */
    const publishedLookup =
      raw.type === 'posted-content' && raw.subtype === 'preprint'
        ? await svc.getPublishedVersions(raw.DOI, ctx)
        : undefined;

    const title = raw.title?.[0] !== undefined ? normalizeMarkupText(raw.title[0]) : undefined;
    const subtitle =
      raw.subtitle?.[0] !== undefined
        ? normalizeMarkupText(raw.subtitle[0])
        : raw['short-title']?.[0] !== undefined
          ? normalizeMarkupText(raw['short-title'][0])
          : undefined;
    const containerTitles = raw['container-title']?.map(normalizeMarkupText);
    const containerTitle = containerTitles?.[0];
    /**
     * Crossref deposits `member` as a digit string (`"311"`). Anything else is no ID a caller
     * could pass to crossref_get_member, so it is left out rather than read as a number.
     */
    const memberId =
      raw.member !== undefined && /^\d+$/.test(raw.member) ? Number(raw.member) : undefined;

    const published = resolveWorkDate(raw);
    const abstract = raw.abstract === undefined ? undefined : normalizeAbstract(raw.abstract);

    /**
     * The author list is bounded the same way crossref_get_references bounds references:
     * sliced once here, before mapping, so structuredContent and format() are handed the
     * identical page and neither surface can drift from the other. Consortium papers deposit
     * author lists in the thousands — enough to exhaust a client's context on a single
     * record — and authorCount is what keeps a bounded page visibly bounded.
     */
    const authorTotal = raw.author?.length ?? 0;
    const authorPage = raw.author?.slice(input.offset, input.offset + limit).map(normalizeAuthor);
    const grant = projectGrant(raw, { offset: input.offset, limit });
    /**
     * Every list offset and limit page: the author list, and on a grant the investigators of all
     * its projects as one list, sliced by `projectGrant` the way the authors are sliced here. No
     * record deposits both — a grant deposits no authors — but both would be cut by the one
     * window, so one nextOffset continues each.
     */
    const pages: Array<PageCount & { noun: 'author' | 'investigator' }> = [];
    if (raw.author)
      pages.push({ noun: 'author', total: authorTotal, shown: authorPage?.length ?? 0 });
    if (grant.investigatorPage) pages.push({ noun: 'investigator', ...grant.investigatorPage });
    const shown = Math.max(0, ...pages.map((page) => page.shown));
    const nextOffset = input.offset + shown;
    const cutPages = pages.filter((page) => input.offset + page.shown < page.total);

    const updates = projectUpdates(raw);
    const relations = raw.relation ? groupRelations(raw.relation) : [];
    const groupTitle = normalizeNonEmptyText(raw['group-title']);
    const degree = normalizeNonEmptyTexts(raw.degree);

    /**
     * `notice` is last-wins, and `truncated()` writes it too, so every text the notice carries
     * is collected here and handed over once — through `truncated()` when a page is cut, since
     * that call is what sets the paging fields beside it. The update text leads: a
     * retraction is the fact about the record, the page range only a fact about this response.
     * Keyed on updatedBy alone — updateTo says what this record is a notice for, and a
     * publisher's erroneous updateTo would otherwise announce the retracted work as a retraction.
     * The published-version text follows it, since it too is about what the record says.
     */
    const notices: string[] = [];
    if (updates.updatedBy) notices.push(updateNotice(updates.updatedBy, raw.DOI));
    const lookupNotice = publishedLookup && publishedVersionsNotice(publishedLookup, raw.DOI);
    if (lookupNotice) notices.push(lookupNotice);
    if (limitClamp.notice) notices.push(limitClamp.notice);
    // A list run past its end is news only when no list has entries on this page.
    if (shown === 0) {
      for (const page of pages.filter((p) => p.total > 0 && input.offset >= p.total)) {
        notices.push(
          `Offset ${input.offset} is past the end of this ${page.noun} list (${page.total} ${page.noun}s). Request an offset below ${page.total}.`,
        );
      }
    }
    for (const page of cutPages) {
      notices.push(
        `Showing ${page.noun}s ${input.offset + 1}–${input.offset + page.shown} of ${page.total}.`,
      );
    }
    if (cutPages.length > 0) {
      notices.push(`Call again with offset=${nextOffset} for the next page.`);
      ctx.enrich({ nextOffset });
      ctx.enrich.truncated({ shown, cap: limit, guidance: notices.join(' ') });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      doi: raw.DOI,
      ...(title !== undefined && { title }),
      ...(subtitle !== undefined && { subtitle }),
      ...(raw.type != null && { type: raw.type }),
      ...(raw.subtype !== undefined && { subtype: raw.subtype }),
      ...updates,
      ...(relations.length > 0 && { relations }),
      ...(publishedLookup?.kind === 'found' && {
        publishedVersions: publishedLookup.works.map(normalizePublishedVersion),
      }),
      ...(authorPage !== undefined && {
        authors: authorPage,
        authorCount: authorTotal,
        offset: input.offset,
      }),
      ...(raw.editor?.length && { editors: raw.editor.map(normalizeAuthor) }),
      ...grant.fields,
      // The investigator page echoes its offset as the author page does, with the same value.
      ...(grant.investigatorPage && { offset: input.offset }),
      ...projectReview(raw),
      ...(abstract !== undefined && { abstract }),
      ...(raw['is-referenced-by-count'] !== undefined && {
        isReferencedByCount: raw['is-referenced-by-count'],
      }),
      ...(raw['references-count'] !== undefined && {
        referencesCount: raw['references-count'],
      }),
      ...(containerTitle !== undefined && { containerTitle, containerTitles }),
      ...(groupTitle !== undefined && { groupTitle }),
      ...projectLocators(raw),
      ...projectEvent(raw),
      ...(raw.ISSN && raw.ISSN.length > 0 && { issn: raw.ISSN }),
      ...(raw.ISBN?.length && { isbn: raw.ISBN }),
      ...(raw.publisher !== undefined && { publisher: normalizeText(raw.publisher) }),
      ...(memberId !== undefined && { memberId }),
      ...(raw.institution?.length && { institutions: raw.institution.map(normalizeInstitution) }),
      ...(degree !== undefined && { degree }),
      ...(published !== undefined && { published }),
      ...projectApproved(raw),
      ...(raw.funder && { funders: raw.funder.map(normalizeFunder) }),
      ...projectAssertions(raw),
      ...projectLicenses(raw),
      ...projectLinks(raw),
      ...(raw.URL && { url: raw.URL }),
      ...(raw.subject && raw.subject.length > 0 && { subject: raw.subject.map(normalizeText) }),
      ...(raw.language && { language: raw.language }),
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`## ${result.title ? mdTextInHeading(result.title) : result.doi}`);
    if (result.subtitle) lines.push(`*${mdText(result.subtitle)}*`);
    lines.push('');

    const type = result.type ? ` | **Type:** ${result.type}` : '';
    const subtype = result.subtype !== undefined ? ` | **Subtype:** ${mdText(result.subtype)}` : '';
    lines.push(`**DOI:** ${result.doi}${type}${subtype}`);
    lines.push(...grantLines(result), ...reviewLines(result));
    if (result.publisher) lines.push(`**Publisher:** ${mdText(result.publisher)}`);
    if (result.memberId !== undefined) lines.push(`**Member ID:** ${result.memberId}`);
    if (result.institutions) lines.push(...result.institutions.map(institutionLine));
    if (result.degree) lines.push(`**Degree:** ${result.degree.map(mdText).join(', ')}`);
    if (result.containerTitles?.length)
      lines.push(`**Journal/Container:** ${result.containerTitles.map(mdText).join(' | ')}`);
    if (result.groupTitle !== undefined) lines.push(`**Group:** ${mdText(result.groupTitle)}`);
    const locators = locatorLine(result);
    if (locators) lines.push(locators);
    const event = eventLine(result);
    if (event) lines.push(event);
    if (result.issn?.length) lines.push(`**ISSN:** ${result.issn.join(', ')}`);
    if (result.isbn?.length) lines.push(`**ISBN:** ${result.isbn.join(', ')}`);
    if (result.published?.year) lines.push(`**Published:** ${formatDateParts(result.published)}`);
    const approved = approvedLine(result);
    if (approved) lines.push(approved);
    if (result.language) lines.push(`**Language:** ${result.language}`);

    if (result.isReferencedByCount !== undefined)
      lines.push(`**Cited by:** ${result.isReferencedByCount}`);
    if (result.referencesCount !== undefined)
      lines.push(`**References:** ${result.referencesCount}`);

    /**
     * Update links, relations, published versions, and editors render ahead of the author page,
     * which can run to thousands of lines: a retraction has to be visible before it, not after. A
     * grant's projects follow them, each ending on its own investigator page. Each section is a
     * list of its own, opened and closed by a blank line so a CommonMark reader never folds the
     * next label into the last bullet.
     */
    const sections = [
      ...updateSections(result),
      result.relations && ['**Relations:**', ...result.relations.map(relationLine)],
      result.publishedVersions && publishedVersionsSection(result.publishedVersions),
      result.editors && ['**Editors:**', ...result.editors.map(contributorLine)],
      ...projectSections(result),
    ].filter((section) => section !== undefined);
    if (sections.length > 0) {
      for (const section of sections) lines.push('', ...section);
      lines.push('');
    }

    if (result.authorCount !== undefined && result.offset !== undefined) {
      lines.push(
        `**Authors:** showing ${result.authors?.length ?? 0} of ${result.authorCount}, starting at index ${result.offset}`,
      );
    }
    if (result.authors?.length) lines.push(...result.authors.map(contributorLine));

    /**
     * Opened by a blank line like every section after it: written straight under the last
     * author bullet, a CommonMark reader continues that bullet onto it.
     */
    if (result.subject?.length) {
      lines.push('', `**Subjects:** ${result.subject.map(mdText).join(', ')}`);
    }

    lines.push('');
    lines.push('**Abstract:**');
    /**
     * The one line on this server's whole Markdown surface that puts a deposited value at
     * column zero, where a leading `#`, `>`, `-`, or `19.` opens a block and the marker is
     * consumed rather than shown.
     */
    lines.push(result.abstract ? mdTextAtLineStart(result.abstract) : '*Not deposited*');

    /** The assertions sit between the funders and the licenses, as they always have. */
    const funders = funderSection(result);
    if (funders) lines.push('', ...funders);
    for (const section of assertionSections(result)) lines.push('', ...section);
    for (const section of [licenseSection(result), linkSection(result)]) {
      if (section) lines.push('', ...section);
    }

    if (result.url) lines.push(`\n**URL:** ${result.url}`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// --- Helpers ---

/**
 * How an affiliation reads inside an author's line. A ROR stands in for a name the deposit does
 * not carry and trails one it does — the same rule the funder line follows, spelled with
 * parentheses because these are joined into a comma-separated run rather than given a line each.
 * The identifier reaches `content[]` either way: a name that hid it would leave a reader of that
 * surface unable to resolve an organization `structuredContent` identifies.
 */
function affiliationLabel(af: { name?: string | undefined; ror?: string | undefined }): string {
  if (af.name === undefined) return af.ror ?? UNNAMED;
  return af.ror ? `${mdText(af.name)} (${af.ror})` : mdText(af.name);
}

/** Project an affiliation. Same shape of absence as a funder, and the same identifier behind it. */
function normalizeAffiliation(af: CrossrefAffiliation) {
  const ror = rorId(af.id);
  return {
    ...(af.name !== undefined && { name: normalizeText(af.name) }),
    ...(ror !== undefined && { ror }),
  };
}

/**
 * Project an institution: an affiliation's name and ROR, plus the place, department, and acronym
 * lists Crossref deposits beside them, each omitted when absent or deposited empty. An entry
 * carrying none of these stays in the list, as an affiliation does, so the deposited count and
 * order survive.
 */
function normalizeInstitution(inst: CrossrefInstitution) {
  const place = normalizeNonEmptyTexts(inst.place);
  const department = normalizeNonEmptyTexts(inst.department);
  const acronym = normalizeNonEmptyTexts(inst.acronym);
  return {
    ...normalizeAffiliation(inst),
    ...(place !== undefined && { place }),
    ...(department !== undefined && { department }),
    ...(acronym !== undefined && { acronym }),
  };
}

type Institution = z.infer<typeof InstitutionSchema>;

/**
 * An institution's line: its name, or the ROR or absence that stands in for one, the way an
 * affiliation reads — then each list it deposits, labelled, since a bare place and a bare
 * department are not told apart by a reader.
 */
function institutionLine(inst: Institution): string {
  const details = [
    inst.place && `place: ${inst.place.map(mdText).join(', ')}`,
    inst.department && `department: ${inst.department.map(mdText).join(', ')}`,
    inst.acronym && `acronym: ${inst.acronym.map(mdText).join(', ')}`,
  ].filter((detail) => detail !== undefined);
  const tail = details.length > 0 ? ` — ${details.join('; ')}` : '';
  return `**Institution:** ${affiliationLabel(inst)}${tail}`;
}

/**
 * Project an author or an editor. Crossref deposits both in one entry shape, plus a `role` on
 * each that restates which array it sits in, so the role is dropped and the field name says it.
 */
function normalizeAuthor(a: CrossrefAuthor) {
  return {
    ...(a.given && { given: normalizeText(a.given) }),
    ...(a.family && { family: normalizeText(a.family) }),
    ...(a.name && { name: normalizeText(a.name) }),
    ...(a.ORCID && { orcid: a.ORCID }),
    ...(a.affiliation?.length && {
      affiliation: a.affiliation.map(normalizeAffiliation),
    }),
    ...(a.sequence && { sequence: a.sequence }),
  };
}

type Contributor = z.infer<typeof AuthorSchema>;
type Relation = z.infer<typeof RelationSchema>;

/** An author's or an editor's line in a Markdown list. */
function contributorLine(a: Contributor): string {
  const nameParts = [a.given, a.family, a.name].filter(Boolean);
  const displayName = nameParts.length ? mdText(nameParts.join(' ')) : '(unknown)';
  const orcidPart = a.orcid ? ` [ORCID: ${a.orcid}]` : '';
  const seqPart = a.sequence ? ` (${a.sequence})` : '';
  const affPart = a.affiliation?.length
    ? ` — ${a.affiliation.map(affiliationLabel).join(', ')}`
    : '';
  return `- ${displayName}${orcidPart}${seqPart}${affPart}`;
}

/**
 * Group a record's relations by type, identifier type, and asserting party, keeping Crossref's
 * key order and each key's deposited id order. Grouping is what keeps a long version chain
 * affordable to return whole: a 199-entry chain adds 14.4 KB to the tool result grouped, against
 * about 36 KB as one object per entry, the difference being the three values every entry would
 * otherwise repeat on both surfaces. It never merges across asserting parties — the same id
 * asserted by both sides stays in both groups, since each is a separate deposit.
 */
function groupRelations(relation: Record<string, CrossrefRelation[]>): Relation[] {
  const groups: Relation[] = [];
  for (const [type, entries] of Object.entries(relation)) {
    const byScheme = new Map<string, Relation>();
    for (const entry of entries) {
      const key = `${entry['id-type']} ${entry['asserted-by']}`;
      let group = byScheme.get(key);
      if (!group) {
        group = { type, idType: entry['id-type'], assertedBy: entry['asserted-by'], ids: [] };
        byScheme.set(key, group);
        groups.push(group);
      }
      group.ids.push(entry.id);
    }
  }
  return groups;
}

/** A relation group's line: what the relation is and whose, then every id it holds. */
function relationLine(r: Relation): string {
  return `- ${mdText(r.type)} (${mdText(r.idType)}, asserted by ${mdText(r.assertedBy)}): ${r.ids.join(', ')}`;
}

type PublishedVersion = z.infer<typeof PublishedVersionSchema>;

/** Project a work the published-version lookup found; its title reads as a work title does. */
function normalizePublishedVersion(work: RawPublishedVersion): PublishedVersion {
  return {
    doi: work.DOI,
    ...(work.type !== undefined && { type: work.type }),
    ...(work.title?.[0] !== undefined && { title: normalizeMarkupText(work.title[0]) }),
  };
}

/**
 * The published versions as a labelled list — the DOI a reader copies first, then its type and
 * title. An empty list is an answer and gets a line saying so, which an absent one never does.
 */
function publishedVersionsSection(versions: PublishedVersion[]): string[] {
  if (versions.length === 0) {
    return [
      '**Published versions:** none found — no Crossref record names this work in has-preprint',
    ];
  }
  return [
    '**Published versions:**',
    ...versions.map((v) => {
      const type = v.type !== undefined ? ` (${mdText(v.type)})` : '';
      const title = v.title !== undefined ? ` — ${mdText(v.title)}` : '';
      return `- ${v.doi}${type}${title}`;
    }),
  ];
}

/**
 * The notice text the published-version lookup adds: that it failed, or that more works name the
 * preprint than it returned — each with the crossref_search_works filter that runs the same
 * lookup, which pages past the cap. Nothing for an answer that holds every work naming it.
 */
function publishedVersionsNotice(lookup: PublishedVersionsLookup, doi: string): string | undefined {
  const filter = JSON.stringify({ 'relation.type': 'has-preprint', 'relation.object': doi });
  if (lookup.kind === 'failed') {
    return `The lookup for this preprint's published versions failed, so publishedVersions is omitted — which does not mean it has none. crossref_search_works with filter ${filter} runs the same lookup.`;
  }
  if (lookup.total <= lookup.works.length) return;
  return `${lookup.total} works name this preprint in has-preprint; publishedVersions holds the first ${lookup.works.length}. crossref_search_works with filter ${filter} lists every one.`;
}

/**
 * The notice text for a record Crossref lists updates against: each update type with the
 * sources that recorded it, in first-seen order, and where the notice is read.
 *
 * It names what the deposits say and nothing more. It does not call the work retracted,
 * corrected, or current — the entries can disagree with each other (the same notice typed a
 * retraction by Retraction Watch and an erratum by the publisher), and a caller reads them
 * all in `updatedBy`. An entry naming the record's own DOI is an update made in place, whose
 * notice is this record: pointing a caller at `crossref_get_work` for it would send them back
 * to the call they just made, so the pointer is dropped when every entry is one of those and
 * qualified when only some are.
 */
function updateNotice(updates: Update[], doi: string): string {
  const sourcesByType = new Map<string, string[]>();
  for (const u of updates) {
    const sources = sourcesByType.get(u.type) ?? [];
    if (!sources.includes(u.source)) sources.push(u.source);
    sourcesByType.set(u.type, sources);
  }
  const listed = [...sourcesByType]
    .map(([type, sources]) => `${type} (${sources.join(', ')})`)
    .join('; ');
  const inPlace = updates.filter((u) => u.doi.toLowerCase() === doi.toLowerCase()).length;
  const where =
    inPlace === updates.length
      ? "Every entry names this work's own DOI: the update was made to this record in place, so there is no separate notice to fetch."
      : inPlace > 0
        ? "updatedBy names each notice DOI; call crossref_get_work with one other than this work's own to read it — an entry naming this work's DOI records an update made to this record in place."
        : 'updatedBy names each notice DOI; call crossref_get_work with one to read it.';
  return `Crossref records updates to this work: ${listed}. ${where}`;
}
