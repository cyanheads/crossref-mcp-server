/**
 * @fileoverview crossref_get_work — resolves a DOI to its full Crossref metadata record.
 * The deposited author list is paged by offset/limit the way crossref_get_references pages
 * references: the slice happens once in the handler, so structuredContent and content[] carry
 * the identical page, and authorCount reports the full deposited total.
 * A funder and an affiliation are the two organizations a record names, and a publisher may
 * assert either through the ROR registry instead of by name — so both are projected with the
 * identifier standing in for the name they lack, on both surfaces, rather than as a blank entry.
 * Editors, update links, and related identifiers are returned whole: none approaches the author
 * tail, and each is relayed entry for entry as deposited. Update links also feed the notice,
 * which shares its one string with the author-paging guidance.
 * @module mcp-server/tools/definitions/get-work.tool
 */

import { tool, z } from '@cyanheads/mcp-ts-core';
import { JsonRpcErrorCode } from '@cyanheads/mcp-ts-core/errors';
import { mdText, mdTextAtLineStart } from '@/mcp-server/tools/markdown-text.js';
import { locatorFields, locatorLine, projectLocators } from '@/mcp-server/tools/work-locators.js';
import {
  formatDateParts,
  getCrossrefService,
  normalizeDoi,
  normalizeMarkupText,
  normalizeText,
  parseDateParts,
  resolveWorkDate,
} from '@/services/crossref/crossref-service.js';
import type {
  CrossrefAffiliation,
  CrossrefAuthor,
  CrossrefFunder,
  CrossrefOrganizationId,
  CrossrefRelation,
  CrossrefUpdate,
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

const FunderSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'Funder name as deposited. Absent when the publisher asserted the funder by identifier alone, where ror carries it instead.',
      ),
    doi: z
      .string()
      .optional()
      .describe('Funder DOI — the Crossref Funder Registry entry this assertion resolved to'),
    ror: z
      .string()
      .optional()
      .describe(
        'ROR identifier for the funding organization, when the deposit carries one. It is the whole identity of an assertion deposited without a name.',
      ),
    award: z.array(z.string()).optional().describe('Grant or award numbers'),
  })
  .describe('Funding assertion');

const LicenseSchema = z
  .object({
    url: z.string().describe('License URL'),
    contentVersion: z.string().optional().describe('Content version (vor, am, tdm, unspecified)'),
    delayInDays: z.number().optional().describe('Embargo delay in days from publication date'),
  })
  .describe('License entry');

const LinkSchema = z
  .object({
    url: z.string().describe('Full-text URL'),
    contentType: z.string().optional().describe('MIME type of linked content'),
    intendedApplication: z
      .string()
      .optional()
      .describe('Intended use (text-mining, similarity-checking, etc.)'),
  })
  .describe('Registered full-text link');

const DatePartsSchema = z.object({
  year: z.number().optional().describe('Year'),
  month: z.number().optional().describe('Month (1–12)'),
  day: z.number().optional().describe('Day of month'),
});

const UpdateSchema = z
  .object({
    doi: z
      .string()
      .describe(
        "DOI on the other side of the link: the notice, in updatedBy; the updated work, in updateTo. It is this work's own DOI when the update was made to this record in place.",
      ),
    type: z
      .string()
      .describe(
        'Crossref update type as deposited: correction, erratum, corrigendum, addendum, retraction, withdrawal, expression_of_concern, new_version, new_edition, or another code',
      ),
    source: z
      .string()
      .describe(
        'Who recorded the link: publisher, or retraction-watch for an entry Crossref carries from the Retraction Watch database',
      ),
    recordId: z
      .string()
      .optional()
      .describe('Retraction Watch record ID. Present only on retraction-watch entries.'),
    updated: DatePartsSchema.optional().describe('Date the update was issued'),
  })
  .describe('Update link');

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

export const getWorkTool = tool('crossref_get_work', {
  title: 'Get Work by DOI',
  description:
    'Resolves a DOI to its full Crossref metadata record: title, authors, editors, affiliations, abstract (when deposited), journal or container with the volume, issue, pages, and article number that locate the work in it, ISSNs and ISBNs, publication date, type, license, full-text links, and funder acknowledgements. The author list is paged: authorCount is the full deposited total, offset and limit select the page (25 authors by default), and when authors remain the response carries a nextOffset to pass back as offset — large-collaboration papers deposit thousands. Post-publication updates are relayed as Crossref records them: updatedBy names each correction, retraction, expression of concern, or new version issued against this work, with its notice DOI and whether the publisher or Retraction Watch recorded it, and updateTo names the works this record is itself a notice for. An absent updatedBy does not mean the work was never updated — coverage depends on those deposits. relations lists related identifiers, such as a preprint and its published version, grouped by relation type; only the Crossref-registered DOIs among them resolve through crossref_get_work. Outgoing references are reported as a count in referencesCount; the reference entries themselves come from crossref_get_references. The isReferencedByCount field reports the total incoming citation count from Crossref; the citing works themselves are not available through Crossref — use OpenAlex for citation graphs.',
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
        'Zero-based index of the first author to return. Pass the nextOffset value from the previous response to continue through a long author list. Only the author list is paged; every other field of the record is returned in full on every page.',
      ),
    limit: z
      .number()
      .int()
      .min(1)
      .max(500)
      .default(25)
      .describe(
        'Maximum number of authors to return in one page (1–500, default 25). Ordinary records fit in a single page; large-collaboration papers in particle physics and genomics deposit thousands.',
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
        'Zero-based index of the first returned author within the deposited list. Omitted alongside authors when the record deposits no author field.',
      ),
    editors: z
      .array(AuthorSchema)
      .optional()
      .describe(
        'Editors of the work, or of the book or proceedings containing it, in the entry shape authors use. Returned whole — never paged by offset and limit, and never counted in authorCount. Omitted when the record deposits none.',
      ),
    updatedBy: z
      .array(UpdateSchema)
      .optional()
      .describe(
        'Update notices Crossref records against this work — corrections, errata, retractions, expressions of concern, withdrawals, new versions — in deposited order. Entries are never merged: the same notice DOI can appear once per source, typed differently by each. Omitted when none is recorded, which does not mean the work was never updated: coverage depends on publisher and Retraction Watch deposits.',
      ),
    updateTo: z
      .array(UpdateSchema)
      .optional()
      .describe(
        'Works this record is an update notice for, in the entry shape updatedBy uses and in deposited order. Omitted when the record is not registered as a notice.',
      ),
    relations: z
      .array(RelationSchema)
      .optional()
      .describe(
        "Related identifiers — preprints and published versions, other versions, reviews, supplements, parts — grouped by relation type, identifier type, and asserting party, groups in Crossref's order and ids in deposited order. Returned whole. Omitted when the record deposits none.",
      ),
    abstract: z
      .string()
      .optional()
      .describe(
        'Abstract when deposited by the publisher. Many records lack abstracts. Publishers deposit it as JATS XML, so this is the text of that deposit with markup removed and character references decoded; a link keeps its tag only where its href holds an address the text it wraps does not already carry, and each formula appears once — MathML as the TeX annotation it carries, otherwise written out linearly (x_i, A^{−1}, √(m), (a+b)/c), and TeX deposited beside MathML in whichever notation comes first.',
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
      .describe('Journal, book, or proceedings name containing this work'),
    ...locatorFields,
    issn: z.array(z.string()).optional().describe('ISSN(s) of the containing journal'),
    isbn: z
      .array(z.string())
      .optional()
      .describe(
        'ISBN(s) as deposited — for a book chapter, those of the containing book. Omitted when the record deposits none.',
      ),
    publisher: z.string().optional().describe('Publisher name'),
    published: DatePartsSchema.optional().describe(
      'Publication date — the first of published, published-print, published-online, and issued that names one. A component Crossref records as unknown is omitted, and so is every component below it.',
    ),
    funders: z.array(FunderSchema).optional().describe('Funding acknowledgements'),
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
        'Offset to pass in the next call to retrieve the following page of authors. Absent when this page reaches the end of the author list.',
      ),
    truncated: z
      .boolean()
      .optional()
      .describe('True when authors remain beyond this page. Absent when the page is the last.'),
    shown: z.number().optional().describe('Number of authors returned in this page.'),
    cap: z.number().optional().describe('The limit that was applied to this page of authors.'),
    notice: z
      .string()
      .optional()
      .describe(
        'When updatedBy is present, the update types Crossref records for this work with the source of each, and where the notice is read. Then which authors this page covers and the offset that reaches the next ones, or an explanation when the requested offset is past the end of the author list. Both share this one string when both apply. Absent when the page holds the whole author list and no update is recorded.',
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
    ctx.log.info('Resolving DOI', { doi });
    const svc = getCrossrefService();
    const raw = await svc.getWork(doi, ctx);
    if (!raw) {
      throw ctx.fail('doi_not_found', `No Crossref record for DOI: ${doi}`, {
        doi,
        ...ctx.recoveryFor('doi_not_found'),
      });
    }

    const title = raw.title?.[0] !== undefined ? normalizeMarkupText(raw.title[0]) : undefined;
    const subtitle =
      raw.subtitle?.[0] !== undefined
        ? normalizeMarkupText(raw.subtitle[0])
        : raw['short-title']?.[0] !== undefined
          ? normalizeMarkupText(raw['short-title'][0])
          : undefined;
    const containerTitle =
      raw['container-title']?.[0] !== undefined
        ? normalizeMarkupText(raw['container-title'][0])
        : undefined;

    const published = resolveWorkDate(raw);

    /**
     * The author list is bounded the same way crossref_get_references bounds references:
     * sliced once here, before mapping, so structuredContent and format() are handed the
     * identical page and neither surface can drift from the other. Consortium papers deposit
     * author lists in the thousands — enough to exhaust a client's context on a single
     * record — and authorCount is what keeps a bounded page visibly bounded.
     */
    const authorTotal = raw.author?.length ?? 0;
    const authorPage = raw.author
      ?.slice(input.offset, input.offset + input.limit)
      .map(normalizeAuthor);
    const authorNextOffset = input.offset + (authorPage?.length ?? 0);

    const updatedBy = raw['updated-by']?.length
      ? raw['updated-by'].map(normalizeUpdate)
      : undefined;
    const updateTo = raw['update-to']?.length ? raw['update-to'].map(normalizeUpdate) : undefined;
    const relations = raw.relation ? groupRelations(raw.relation) : [];

    /**
     * `notice` is last-wins, and `truncated()` writes it too, so every text the notice carries
     * is collected here and handed over once — through `truncated()` when the author page is
     * cut, since that call is what sets the paging fields beside it. The update text leads: a
     * retraction is the fact about the record, the page range only a fact about this response.
     * Keyed on updatedBy alone — updateTo says what this record is a notice for, and a
     * publisher's erroneous updateTo would otherwise announce the retracted work as a retraction.
     */
    const notices: string[] = [];
    if (updatedBy) notices.push(updateNotice(updatedBy, raw.DOI));
    const pageCut = authorNextOffset < authorTotal;
    if (authorTotal > 0 && input.offset >= authorTotal) {
      notices.push(
        `Offset ${input.offset} is past the end of this author list (${authorTotal} authors). Request an offset below ${authorTotal}.`,
      );
    } else if (pageCut) {
      notices.push(
        `Showing authors ${input.offset + 1}–${authorNextOffset} of ${authorTotal}. Call again with offset=${authorNextOffset} for the next page.`,
      );
    }
    if (pageCut) {
      ctx.enrich({ nextOffset: authorNextOffset });
      ctx.enrich.truncated({
        shown: authorPage?.length ?? 0,
        cap: input.limit,
        guidance: notices.join(' '),
      });
    } else if (notices.length > 0) {
      ctx.enrich.notice(notices.join(' '));
    }

    return {
      doi: raw.DOI,
      ...(title !== undefined && { title }),
      ...(subtitle !== undefined && { subtitle }),
      ...(raw.type != null && { type: raw.type }),
      ...(updatedBy && { updatedBy }),
      ...(updateTo && { updateTo }),
      ...(relations.length > 0 && { relations }),
      ...(authorPage !== undefined && {
        authors: authorPage,
        authorCount: authorTotal,
        offset: input.offset,
      }),
      ...(raw.editor?.length && { editors: raw.editor.map(normalizeAuthor) }),
      ...(raw.abstract !== undefined && { abstract: normalizeMarkupText(raw.abstract) }),
      ...(raw['is-referenced-by-count'] !== undefined && {
        isReferencedByCount: raw['is-referenced-by-count'],
      }),
      ...(raw['references-count'] !== undefined && {
        referencesCount: raw['references-count'],
      }),
      ...(containerTitle !== undefined && { containerTitle }),
      ...projectLocators(raw),
      ...(raw.ISSN && raw.ISSN.length > 0 && { issn: raw.ISSN }),
      ...(raw.ISBN?.length && { isbn: raw.ISBN }),
      ...(raw.publisher !== undefined && { publisher: normalizeText(raw.publisher) }),
      ...(published !== undefined && { published }),
      ...(raw.funder && { funders: raw.funder.map(normalizeFunder) }),
      ...(raw.license && {
        licenses: raw.license.map((l) => ({
          url: l.URL,
          ...(l['content-version'] && { contentVersion: l['content-version'] }),
          ...(l['delay-in-days'] !== undefined && { delayInDays: l['delay-in-days'] }),
        })),
      }),
      ...(raw.link && {
        links: raw.link.map((l) => ({
          url: l.URL,
          ...(l['content-type'] && { contentType: l['content-type'] }),
          ...(l['intended-application'] && {
            intendedApplication: l['intended-application'],
          }),
        })),
      }),
      ...(raw.URL && { url: raw.URL }),
      ...(raw.subject && raw.subject.length > 0 && { subject: raw.subject.map(normalizeText) }),
      ...(raw.language && { language: raw.language }),
    };
  },

  format: (result) => {
    const lines: string[] = [];

    lines.push(`## ${result.title ? mdText(result.title) : result.doi}`);
    if (result.subtitle) lines.push(`*${mdText(result.subtitle)}*`);
    lines.push('');

    lines.push(`**DOI:** ${result.doi}${result.type ? ` | **Type:** ${result.type}` : ''}`);
    if (result.publisher) lines.push(`**Publisher:** ${mdText(result.publisher)}`);
    if (result.containerTitle)
      lines.push(`**Journal/Container:** ${mdText(result.containerTitle)}`);
    const locators = locatorLine(result);
    if (locators) lines.push(locators);
    if (result.issn?.length) lines.push(`**ISSN:** ${result.issn.join(', ')}`);
    if (result.isbn?.length) lines.push(`**ISBN:** ${result.isbn.join(', ')}`);
    if (result.published?.year) lines.push(`**Published:** ${formatDateParts(result.published)}`);
    if (result.language) lines.push(`**Language:** ${result.language}`);

    if (result.isReferencedByCount !== undefined)
      lines.push(`**Cited by:** ${result.isReferencedByCount}`);
    if (result.referencesCount !== undefined)
      lines.push(`**References:** ${result.referencesCount}`);

    /**
     * Update links, relations, and editors render ahead of the author page, which can run to
     * 500 lines: a retraction has to be visible before it, not after. Each section is a list
     * of its own, opened and closed by a blank line so a CommonMark reader never folds the
     * next label into the last bullet.
     */
    const sections = [
      result.updatedBy && ['**Updated by:**', ...result.updatedBy.map(updateLine)],
      result.updateTo && ['**Update notice for:**', ...result.updateTo.map(updateLine)],
      result.relations && ['**Relations:**', ...result.relations.map(relationLine)],
      result.editors && ['**Editors:**', ...result.editors.map(contributorLine)],
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

    if (result.funders?.length) {
      lines.push('');
      lines.push('**Funders:**');
      for (const f of result.funders) {
        const awards = f.award?.length ? ` (${f.award.join(', ')})` : '';
        /**
         * An assertion deposited without a name leads with the identifier that stands in for
         * one, and whatever identifiers remain trail it exactly as they trail a name. Every
         * identifier the record carries reaches this surface either way — a name that hid one
         * would leave a `content[]` reader unable to resolve what `structuredContent` names.
         */
        const ids = [f.doi, f.ror].filter((id) => id !== undefined);
        const label = f.name ? mdText(f.name) : (ids.shift() ?? UNNAMED);
        lines.push(`- ${label}${ids.length > 0 ? ` — ${ids.join(' ')}` : ''}${awards}`);
      }
    }

    if (result.licenses?.length) {
      lines.push('');
      lines.push('**Licenses:**');
      for (const l of result.licenses) {
        const delay = l.delayInDays !== undefined ? ` (${l.delayInDays}d embargo)` : '';
        lines.push(`- ${l.url}${l.contentVersion ? ` [${l.contentVersion}]` : ''}${delay}`);
      }
    }

    if (result.links?.length) {
      lines.push('');
      lines.push('**Full-text links:**');
      for (const l of result.links) {
        const ct = l.contentType ? ` (${l.contentType})` : '';
        const app = l.intendedApplication ? ` [${l.intendedApplication}]` : '';
        lines.push(`- ${l.url}${ct}${app}`);
      }
    }

    if (result.url) lines.push(`\n**URL:** ${result.url}`);

    return [{ type: 'text', text: lines.join('\n') }];
  },
});

// --- Helpers ---

/**
 * What an organization is called on the Markdown surface when the deposit named none. Shared by
 * the two renders so a funder and an affiliation say the same thing about the same absence.
 */
const UNNAMED = '(no name deposited)';

/**
 * The ROR identifier on an organization Crossref carries by identifier rather than by name.
 *
 * A funder or an affiliation deposited without a name is not an empty entry — it is an
 * organization the publisher asserted through the registry instead of spelling out, and its `id`
 * array is where that assertion lives. Crossref puts several identifier schemes in that one
 * array, so the type decides which is read: ROR is the one every nameless funder and affiliation
 * in a sampled draw carried, and the only one ever seen alone. An ISNI appears beside a ROR and
 * never in place of one, so reading ROR loses nothing an entry depends on for its identity.
 */
function rorId(ids: CrossrefOrganizationId[] | undefined): string | undefined {
  return ids?.find((entry) => entry['id-type']?.toUpperCase() === 'ROR')?.id;
}

/**
 * Project a funding assertion. Every field is conditional because Crossref guarantees none of
 * them: an assertion made by identifier carries a ROR, an award number, and nothing else.
 */
function normalizeFunder(f: CrossrefFunder) {
  const ror = rorId(f.id);
  return {
    ...(f.name !== undefined && { name: normalizeText(f.name) }),
    ...(f.DOI && { doi: f.DOI }),
    ...(ror !== undefined && { ror }),
    ...(f.award && f.award.length > 0 && { award: f.award }),
  };
}

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
type Update = z.infer<typeof UpdateSchema>;
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
 * Project one update link. `label` is dropped: it restates `type` in title case on every entry
 * Crossref deposits. The Retraction Watch record ID rides along where Crossref carries one.
 */
function normalizeUpdate(u: CrossrefUpdate): Update {
  const updated = parseDateParts(u.updated);
  return {
    doi: u.DOI,
    type: u.type,
    source: u.source,
    ...(u['record-id'] !== undefined && { recordId: u['record-id'] }),
    ...(updated !== undefined && { updated }),
  };
}

/** An update link's line: the DOI a reader copies first, then what kind of update and whose. */
function updateLine(u: Update): string {
  const record = u.recordId !== undefined ? `, record ${u.recordId}` : '';
  const date = u.updated ? `, ${formatDateParts(u.updated)}` : '';
  return `- ${u.doi} — ${mdText(u.type)} (${mdText(u.source)}${record})${date}`;
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
