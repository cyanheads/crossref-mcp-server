/**
 * @fileoverview What a grant and a peer review deposit in place of a work's title and abstract —
 * a grant's award number, award start, and projects, and a peer review's review details — as
 * output fields, projections, and Markdown lines for crossref_get_work.
 *
 * A project's plain investigator list runs to hundreds of people on some grants, so the
 * investigators of every project are read as one list in deposited order and projected through the
 * page window offset and limit select, the way the author list is. Lead and co-lead investigators,
 * a handful per project, come back whole.
 * @module mcp-server/tools/work-grants-reviews
 */

import { z } from '@cyanheads/mcp-ts-core';
import { mdText } from '@/mcp-server/tools/markdown-text.js';
import { DatePartsSchema } from '@/mcp-server/tools/work-dates.js';
import { FunderSchema, rorId, UNNAMED } from '@/mcp-server/tools/work-funders-licenses-links.js';
import { formatDateParts, parseDateParts } from '@/services/crossref/date-parts.js';
import {
  normalizeMarkupText,
  normalizeNonEmptyText,
  normalizeNonEmptyTexts,
} from '@/services/crossref/markup-text.js';
import type {
  CrossrefAffiliation,
  CrossrefAwardAmount,
  CrossrefInvestigator,
  CrossrefOrganizationId,
  CrossrefProject,
  CrossrefProjectFunding,
  RawCrossrefWork,
} from '@/services/crossref/types.js';

/** What a date these fields carry omits, pointing at the field that says it in full. */
const PARTIAL_DATE = 'Components Crossref records as unknown are omitted, as on published.';

const AffiliationSchema = z
  .object({
    name: z
      .string()
      .optional()
      .describe(
        'Affiliation name as deposited. Absent when the deposit identifies the organization by ROR alone, where ror carries it instead.',
      ),
    ror: z.string().optional().describe('ROR identifier of the organization, when deposited'),
    country: z.string().optional().describe('Country code as deposited, e.g. GB'),
  })
  .describe('Affiliation');

const InvestigatorSchema = z
  .object({
    given: z.string().optional().describe('Given (first) name'),
    family: z.string().optional().describe('Family (last) name'),
    name: z.string().optional().describe('Name when no given/family split is deposited'),
    orcid: z.string().optional().describe('ORCID identifier URI'),
    alternateNames: z
      .array(z.string())
      .optional()
      .describe('Other forms of the name as deposited, such as the full name a funder records'),
    affiliation: z.array(AffiliationSchema).optional().describe('Affiliations in deposited order'),
    roleStart: DatePartsSchema.optional().describe(
      `Date the person took the role. ${PARTIAL_DATE}`,
    ),
    roleEnd: DatePartsSchema.optional().describe(`Date the person left the role. ${PARTIAL_DATE}`),
  })
  .describe(
    'Person a grant project names. An entry depositing no name stays in its list, so the deposited count and order hold.',
  );

const AmountSchema = z
  .object({
    amount: z.number().describe('Amount as deposited. 0 is a deposited value, not an absence.'),
    currency: z
      .string()
      .optional()
      .describe('Currency code as deposited, e.g. EUR. Omitted when the deposit records none.'),
    percentage: z
      .number()
      .optional()
      .describe(
        'Share of the project the amount covers, in percent, as deposited. Omitted when the deposit records none.',
      ),
  })
  .describe('Award amount');

const FundingSchema = z
  .object({
    type: z
      .string()
      .describe(
        'Kind of funding as deposited: grant, award, fellowship, facilities, salary-award, training-grant, equipment, contract, and others',
      ),
    scheme: z.string().optional().describe('Funding scheme or programme as deposited'),
    amount: AmountSchema.optional().describe(
      'What this funding contributes. Omitted when not deposited.',
    ),
    funder: FunderSchema.pick({ name: true, doi: true, ror: true }).describe(
      "Funding organization, its DOI and ROR read from the deposit's identifiers by type. One deposited by ROR alone carries ror in place of name.",
    ),
  })
  .describe('Funding source of a project');

const TitleSchema = z
  .object({
    title: z.string().describe('Project title with markup removed, as work titles are'),
    language: z.string().optional().describe('Language code as deposited, e.g. en'),
  })
  .describe('Project title in one language');

const DescriptionSchema = z
  .object({
    description: z.string().describe('Project description with markup removed, as work titles are'),
    language: z.string().optional().describe('Language code as deposited, e.g. en'),
  })
  .describe('Project description in one language');

const ProjectSchema = z
  .object({
    titles: z
      .array(TitleSchema)
      .optional()
      .describe(
        'Project titles in deposited order, one per language where the funder deposits several. A grant deposits no work title: this is where its title lives. Omitted when none is deposited.',
      ),
    descriptions: z
      .array(DescriptionSchema)
      .optional()
      .describe(
        'Project descriptions in deposited order, one per language or audience where the funder deposits several. Omitted when none is deposited.',
      ),
    leadInvestigators: z
      .array(InvestigatorSchema)
      .optional()
      .describe(
        'Lead (principal) investigators in deposited order, returned whole — never paged by offset and limit. Omitted when the project deposits none.',
      ),
    coLeadInvestigators: z
      .array(InvestigatorSchema)
      .optional()
      .describe(
        'Co-lead investigators in deposited order, returned whole — never paged by offset and limit. Omitted when the project deposits none.',
      ),
    investigators: z
      .array(InvestigatorSchema)
      .optional()
      .describe(
        "This project's part of the investigator page offset and limit select. The investigators of every project form one list in deposited order; investigatorCount is its full length. Empty when this project's investigators fall outside the page; omitted when the project deposits none.",
      ),
    amount: AmountSchema.optional().describe(
      'Total amount awarded to the project. Omitted when not deposited.',
    ),
    start: DatePartsSchema.optional().describe(
      `Project award start. ${PARTIAL_DATE} Omitted when not deposited.`,
    ),
    end: DatePartsSchema.optional().describe(
      `Project award end. ${PARTIAL_DATE} Omitted when not deposited.`,
    ),
    plannedStart: DatePartsSchema.optional().describe(
      `Planned project start. ${PARTIAL_DATE} Omitted when not deposited.`,
    ),
    plannedEnd: DatePartsSchema.optional().describe(
      `Planned project end. ${PARTIAL_DATE} Omitted when not deposited.`,
    ),
    funding: z
      .array(FundingSchema)
      .optional()
      .describe('Funding sources in deposited order. Omitted when none is deposited.'),
  })
  .describe('Project a grant funds');

const ReviewSchema = z
  .object({
    stage: z
      .string()
      .optional()
      .describe('When the review was written, as deposited: pre-publication or post-publication'),
    type: z
      .string()
      .optional()
      .describe(
        'Kind of review item as deposited: referee-report, editor-report, author-comment, and others',
      ),
    runningNumber: z
      .string()
      .optional()
      .describe('Label of the item among the reviews of one work, as deposited, e.g. RC2'),
    revisionRound: z
      .string()
      .optional()
      .describe('Revision round the item belongs to, as deposited, e.g. "2"'),
    recommendation: z
      .string()
      .optional()
      .describe(
        'Recommendation as deposited: accept, minor-revision, major-revision, reject, and others',
      ),
    competingInterestStatement: z
      .string()
      .optional()
      .describe("Reviewer's competing-interest statement, with markup removed"),
    language: z.string().optional().describe('Language code of the review as deposited'),
  })
  .describe('Peer-review details');

type DateParts = z.infer<typeof DatePartsSchema>;
type Affiliation = z.infer<typeof AffiliationSchema>;
type Investigator = z.infer<typeof InvestigatorSchema>;
type Amount = z.infer<typeof AmountSchema>;
type Funding = z.infer<typeof FundingSchema>;
type Project = z.infer<typeof ProjectSchema>;
type Review = z.infer<typeof ReviewSchema>;

/** The grant output fields, spread into a work's output schema. */
export const grantFields = {
  award: z
    .string()
    .optional()
    .describe(
      "Award number of a grant as deposited — the value a funded work's funders[].award cites. Omitted on a record depositing none.",
    ),
  awardStart: DatePartsSchema.optional().describe(
    `Award start a grant deposits at the record level. Some funders deposit the start only per project, under projects[].start. ${PARTIAL_DATE} Omitted when not deposited.`,
  ),
  projects: z
    .array(ProjectSchema)
    .optional()
    .describe(
      'Projects a grant funds, in deposited order; every sampled grant deposits one. A grant deposits no title or abstract — its project titles and descriptions stand in for them. Omitted on a record depositing none.',
    ),
  investigatorCount: z
    .number()
    .optional()
    .describe(
      'Total investigators across the projects of a grant, before offset and limit were applied. Lead and co-lead investigators, returned whole, are not counted. Omitted when no project deposits an investigator list.',
    ),
};

/** The peer-review output field, spread into a work's output schema. */
export const reviewFields = {
  review: ReviewSchema.optional().describe(
    'Review details a peer-review record deposits — stage, type, running number, revision round, recommendation, competing-interest statement, and language — each where deposited. The reviewed work is named in relations, under is-review-of. Omitted when the record deposits none.',
  ),
};

/** The window offset and limit select over a paged entry list. */
interface PageWindow {
  limit: number;
  offset: number;
}

/** A paged list's full length and the entries the page holds. */
export interface PageCount {
  shown: number;
  total: number;
}

/** The DOI among an organization's identifiers — a funder's Funder Registry entry. */
function doiId(ids: CrossrefOrganizationId[] | undefined): string | undefined {
  return ids?.find((entry) => entry['id-type']?.toUpperCase() === 'DOI')?.id;
}

/** A deposited amount. A `null` currency or percentage is none; an amount of `0` is kept. */
function projectAmount(a: CrossrefAwardAmount | undefined): Amount | undefined {
  if (a === undefined) return;
  return {
    amount: a.amount,
    ...(a.currency && { currency: a.currency }),
    ...(a.percentage != null && { percentage: a.percentage }),
  };
}

/** An investigator's affiliation: the name and ROR an author's carries, and its country. */
function normalizeAffiliation(af: CrossrefAffiliation & { country?: string }): Affiliation {
  const name = normalizeNonEmptyText(af.name);
  const ror = rorId(af.id);
  return {
    ...(name !== undefined && { name }),
    ...(ror !== undefined && { ror }),
    ...(af.country && { country: af.country }),
  };
}

/**
 * Project a lead, co-lead, or plain investigator. Every field is conditional — an entry can carry
 * nothing at all — and an empty projection still takes its place in the list.
 */
function normalizeInvestigator(i: CrossrefInvestigator): Investigator {
  const given = normalizeNonEmptyText(i.given);
  const family = normalizeNonEmptyText(i.family);
  const name = normalizeNonEmptyText(i.name);
  const alternateNames = normalizeNonEmptyTexts(i['alternate-name']);
  const roleStart = parseDateParts(i['role-start']);
  const roleEnd = parseDateParts(i['role-end']);
  return {
    ...(given !== undefined && { given }),
    ...(family !== undefined && { family }),
    ...(name !== undefined && { name }),
    ...(i.ORCID && { orcid: i.ORCID }),
    ...(alternateNames !== undefined && { alternateNames }),
    ...(i.affiliation?.length && { affiliation: i.affiliation.map(normalizeAffiliation) }),
    ...(roleStart !== undefined && { roleStart }),
    ...(roleEnd !== undefined && { roleEnd }),
  };
}

/** A funding source, its funder's DOI and ROR read from `id` by type and its name normalized. */
function normalizeFunding(f: CrossrefProjectFunding): Funding {
  const scheme = normalizeNonEmptyText(f.scheme);
  const amount = projectAmount(f['award-amount']);
  const name = normalizeNonEmptyText(f.funder.name);
  const doi = doiId(f.funder.id);
  const ror = rorId(f.funder.id);
  return {
    type: f.type,
    ...(scheme !== undefined && { scheme }),
    ...(amount !== undefined && { amount }),
    funder: {
      ...(name !== undefined && { name }),
      ...(doi !== undefined && { doi }),
      ...(ror !== undefined && { ror }),
    },
  };
}

/** A list holding at least one entry, or `undefined` — a list deposited empty reads as none. */
function nonEmpty<T>(list: T[] | undefined): T[] | undefined {
  return list?.length ? list : undefined;
}

/**
 * Project one project, holding `investigators` — its part of the page — where it deposits a list.
 * Titles and descriptions go through the pass work titles do, and one left with no text is
 * dropped like one never deposited.
 */
function normalizeProject(p: CrossrefProject, investigators: Investigator[] | undefined): Project {
  const titles = nonEmpty(
    p['project-title']?.flatMap((t) => {
      const title = normalizeMarkupText(t.title);
      return title ? [{ title, ...(t.language && { language: t.language }) }] : [];
    }),
  );
  const descriptions = nonEmpty(
    p['project-description']?.flatMap((d) => {
      const description = normalizeMarkupText(d.description);
      return description ? [{ description, ...(d.language && { language: d.language }) }] : [];
    }),
  );
  const leadInvestigators = nonEmpty(p['lead-investigator'])?.map(normalizeInvestigator);
  const coLeadInvestigators = nonEmpty(p['co-lead-investigator'])?.map(normalizeInvestigator);
  const amount = projectAmount(p['award-amount']);
  const start = parseDateParts(p['award-start']);
  const end = parseDateParts(p['award-end']);
  const plannedStart = parseDateParts(p['award-planned-start']);
  const plannedEnd = parseDateParts(p['award-planned-end']);
  return {
    ...(titles !== undefined && { titles }),
    ...(descriptions !== undefined && { descriptions }),
    ...(leadInvestigators !== undefined && { leadInvestigators }),
    ...(coLeadInvestigators !== undefined && { coLeadInvestigators }),
    ...(investigators !== undefined && { investigators }),
    ...(amount !== undefined && { amount }),
    ...(start !== undefined && { start }),
    ...(end !== undefined && { end }),
    ...(plannedStart !== undefined && { plannedStart }),
    ...(plannedEnd !== undefined && { plannedEnd }),
    ...(p.funding?.length && { funding: p.funding.map(normalizeFunding) }),
  };
}

/**
 * A grant's award, award start, and projects, with the investigators of every project read as one
 * list in deposited order and sliced to `window`: each project holds the part of the page that
 * falls inside its own list, so walking the pages visits every investigator once, project by
 * project. `investigatorPage` is that list's full length and the entries this page holds, present
 * when any project deposits an investigator list — the caller's paging notice and continuation
 * read it, as they read the author page.
 */
export function projectGrant(
  raw: Pick<RawCrossrefWork, 'award' | 'award-start' | 'project'>,
  window: PageWindow,
): {
  fields: {
    award?: string;
    awardStart?: DateParts;
    projects?: Project[];
    investigatorCount?: number;
  };
  investigatorPage?: PageCount;
} {
  let total = 0;
  let shown = 0;
  const projects = nonEmpty(raw.project)?.map((p) => {
    const list = nonEmpty(p.investigator);
    if (list === undefined) return normalizeProject(p, undefined);
    const from = window.offset - total;
    const part = list
      .slice(Math.max(0, from), Math.max(0, from + window.limit))
      .map(normalizeInvestigator);
    total += list.length;
    shown += part.length;
    return normalizeProject(p, part);
  });
  const awardStart = parseDateParts(raw['award-start']);
  const counted = total > 0;
  return {
    fields: {
      ...(raw.award && { award: raw.award }),
      ...(awardStart !== undefined && { awardStart }),
      ...(projects !== undefined && { projects }),
      ...(counted && { investigatorCount: total }),
    },
    ...(counted && { investigatorPage: { total, shown } }),
  };
}

/** The review details a peer review deposits, each code byte-exact; nothing when none remain. */
export function projectReview(raw: Pick<RawCrossrefWork, 'review'>): { review?: Review } {
  const r = raw.review;
  if (r === undefined) return {};
  const statement =
    (r['competing-interest-statement'] !== undefined &&
      normalizeMarkupText(r['competing-interest-statement'])) ||
    undefined;
  const review = {
    ...(r.stage && { stage: r.stage }),
    ...(r.type && { type: r.type }),
    ...(r['running-number'] && { runningNumber: r['running-number'] }),
    ...(r['revision-round'] && { revisionRound: r['revision-round'] }),
    ...(r.recommendation && { recommendation: r.recommendation }),
    ...(statement !== undefined && { competingInterestStatement: statement }),
    ...(r.language && { language: r.language }),
  };
  return Object.keys(review).length > 0 ? { review } : {};
}

/** The award number and record-level award start, each a header line where deposited. */
export function grantLines(w: {
  award?: string | undefined;
  awardStart?: DateParts | undefined;
}): string[] {
  return [
    w.award !== undefined ? `**Award:** ${mdText(w.award)}` : undefined,
    w.awardStart && `**Award start:** ${formatDateParts(w.awardStart)}`,
  ].filter((line) => line !== undefined);
}

/** The review details on one line, labelled, and the free-text statement on its own. */
export function reviewLines(w: { review?: Review | undefined }): string[] {
  const r = w.review;
  if (r === undefined) return [];
  const details = [
    r.type && `type: ${mdText(r.type)}`,
    r.stage && `stage: ${mdText(r.stage)}`,
    r.runningNumber && `running number: ${mdText(r.runningNumber)}`,
    r.revisionRound && `revision round: ${mdText(r.revisionRound)}`,
    r.recommendation && `recommendation: ${mdText(r.recommendation)}`,
    r.language && `language: ${mdText(r.language)}`,
  ].filter((detail) => detail !== undefined);
  return [
    ...(details.length > 0 ? [`**Review:** ${details.join('; ')}`] : []),
    ...(r.competingInterestStatement !== undefined
      ? [`**Review competing interests:** ${mdText(r.competingInterestStatement)}`]
      : []),
  ];
}

function amountText(a: Amount): string {
  const currency = a.currency !== undefined ? ` ${mdText(a.currency)}` : '';
  const percentage = a.percentage !== undefined ? ` (${a.percentage}%)` : '';
  return `${a.amount}${currency}${percentage}`;
}

/**
 * A funding source's line: its type and scheme, the funder — by name, or by the identifier that
 * stands in for one, the rest trailing as on a work's funder line — and the amount.
 */
function fundingLine(f: Funding): string {
  const ids = [f.funder.doi, f.funder.ror].filter((id) => id !== undefined);
  const label = f.funder.name !== undefined ? mdText(f.funder.name) : (ids.shift() ?? UNNAMED);
  const funder = `${label}${ids.length > 0 ? ` — ${ids.join(' ')}` : ''}`;
  const scheme = f.scheme !== undefined ? `, scheme ${mdText(f.scheme)}` : '';
  const amount = f.amount !== undefined ? ` — amount ${amountText(f.amount)}` : '';
  return `- Funding: ${mdText(f.type)}${scheme} — ${funder}${amount}`;
}

function languageTag(language: string | undefined): string {
  return language !== undefined ? ` (${mdText(language)})` : '';
}

/** A project's own facts, one bullet each: titles, descriptions, amount, dates, funding. */
function projectFacts(p: Project): string[] {
  const dates = [
    p.start && `start ${formatDateParts(p.start)}`,
    p.end && `end ${formatDateParts(p.end)}`,
    p.plannedStart && `planned start ${formatDateParts(p.plannedStart)}`,
    p.plannedEnd && `planned end ${formatDateParts(p.plannedEnd)}`,
  ].filter((date) => date !== undefined);
  return [
    ...(p.titles ?? []).map((t) => `- Title${languageTag(t.language)}: ${mdText(t.title)}`),
    ...(p.descriptions ?? []).map(
      (d) => `- Description${languageTag(d.language)}: ${mdText(d.description)}`,
    ),
    ...(p.amount !== undefined ? [`- Amount: ${amountText(p.amount)}`] : []),
    ...(dates.length > 0 ? [`- Dates: ${dates.join(', ')}`] : []),
    ...(p.funding ?? []).map(fundingLine),
  ];
}

/**
 * An affiliation inside an investigator's line: its name, or the ROR or absence standing in for
 * one, then the ROR beside a name and the country, in parentheses.
 */
function affiliationText(af: Affiliation): string {
  const lead = af.name !== undefined ? mdText(af.name) : (af.ror ?? UNNAMED);
  const details = [
    af.name !== undefined ? af.ror : undefined,
    af.country && mdText(af.country),
  ].filter((detail) => detail !== undefined);
  return details.length > 0 ? `${lead} (${details.join(', ')})` : lead;
}

function roleText(start: DateParts | undefined, end: DateParts | undefined): string {
  if (start === undefined) return end ? ` — role until ${formatDateParts(end)}` : '';
  return end
    ? ` — role ${formatDateParts(start)} – ${formatDateParts(end)}`
    : ` — role from ${formatDateParts(start)}`;
}

/** An investigator's line in a Markdown list. A nameless entry reads as an author's does. */
function investigatorLine(i: Investigator): string {
  const name = [i.given, i.family, i.name].filter(Boolean).join(' ');
  const alternates = i.alternateNames ? ` (also ${i.alternateNames.map(mdText).join('; ')})` : '';
  const orcid = i.orcid ? ` [ORCID: ${i.orcid}]` : '';
  const affiliations = i.affiliation ? ` — ${i.affiliation.map(affiliationText).join('; ')}` : '';
  return `- ${name ? mdText(name) : '(unknown)'}${alternates}${orcid}${affiliations}${roleText(i.roleStart, i.roleEnd)}`;
}

/**
 * Each project's sections, in deposited order: its facts, then its lead, co-lead, and plain
 * investigators, each a labelled list of its own. Several projects are numbered. The investigator
 * label reads as the author label does — how many this part holds, of how many across the grant,
 * starting where — with each project's part starting where the one before it ended.
 */
export function projectSections(w: {
  projects?: Project[] | undefined;
  investigatorCount?: number | undefined;
  offset?: number | undefined;
}): string[][] {
  const projects = w.projects ?? [];
  let index = w.offset ?? 0;
  return projects.flatMap((p, n) => {
    const label =
      projects.length > 1 ? `**Project ${n + 1} of ${projects.length}:**` : '**Project:**';
    const sections = [[label, ...projectFacts(p)]];
    if (p.leadInvestigators)
      sections.push(['**Lead investigators:**', ...p.leadInvestigators.map(investigatorLine)]);
    if (p.coLeadInvestigators)
      sections.push(['**Co-lead investigators:**', ...p.coLeadInvestigators.map(investigatorLine)]);
    if (p.investigators) {
      sections.push([
        `**Investigators:** showing ${p.investigators.length} of ${w.investigatorCount}, starting at index ${index}`,
        ...p.investigators.map(investigatorLine),
      ]);
      index += p.investigators.length;
    }
    return sections;
  });
}
