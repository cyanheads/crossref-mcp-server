/**
 * @fileoverview The registrations and statements a work record deposits about itself — the
 * clinical trial numbers it names and the Crossmark assertions its publisher attaches — as one
 * pair of output fields, one projection, and one Markdown list per field. Both are returned whole,
 * entry for entry as deposited, so the array is the sequence.
 * @module mcp-server/tools/work-assertions
 */

import { z } from '@cyanheads/mcp-ts-core';
import { mdText } from '@/mcp-server/tools/markdown-text.js';
import { normalizeMarkupText, normalizeNonEmptyText } from '@/services/crossref/markup-text.js';
import type {
  CrossrefAssertion,
  CrossrefClinicalTrialNumber,
  RawCrossrefWork,
} from '@/services/crossref/types.js';

const ClinicalTrialNumberSchema = z
  .object({
    number: z
      .string()
      .describe(
        'Trial registration number as deposited; Crossref lowercases it, e.g. "nct04861831"',
      ),
    registry: z
      .string()
      .optional()
      .describe(
        'DOI of the registry holding the registration, e.g. "10.18810/clinical-trials-gov" for ClinicalTrials.gov',
      ),
    type: z
      .string()
      .optional()
      .describe(
        'Trial stage the work reports on, as deposited: preResults, results, or postResults. Absent on most entries.',
      ),
  })
  .describe('Clinical trial registration');

const AssertionSchema = z
  .object({
    name: z
      .string()
      .describe(
        'Assertion code as deposited, e.g. received, accepted, Ethics, peer_review_method, aims_and_scope_url',
      ),
    value: z
      .string()
      .optional()
      .describe(
        'Assertion text with markup removed and whitespace collapsed: a date, a statement, a name, an address. Free text, never parsed — a date reads as deposited ("20 January 2025", "2018-04-24"). Absent on an entry that only heads its group.',
      ),
    label: z.string().optional().describe('Display label of name, as deposited'),
    group: z
      .string()
      .optional()
      .describe(
        'Code of the group the entry belongs to, e.g. ArticleHistory, EthicsHeading, publication_history, peer_review',
      ),
    groupLabel: z
      .string()
      .optional()
      .describe(
        'Display label of the group. In EthicsHeading it names the statement — Competing interests, Ethical approval, Consent for publication — where every entry shares the name Ethics.',
      ),
    url: z
      .string()
      .optional()
      .describe(
        'Address deposited with the entry, such as an ORCID or a supplementary-data DOI. Omitted when it repeats value.',
      ),
    explanationUrl: z
      .string()
      .optional()
      .describe('Address explaining the assertion, such as the license an entry states'),
  })
  .describe('Crossmark assertion');

type ClinicalTrialNumber = z.infer<typeof ClinicalTrialNumberSchema>;
type Assertion = z.infer<typeof AssertionSchema>;

/** The trial-number and assertion output fields, spread into a work's output schema. */
export const assertionFields = {
  clinicalTrialNumbers: z
    .array(ClinicalTrialNumberSchema)
    .optional()
    .describe(
      "Clinical trial registrations the work names, returned whole in deposited order — a number deposited twice appears twice. Omitted when the record deposits none, which does not mean the work reports no trial: coverage depends on the publisher's deposit.",
    ),
  assertions: z
    .array(AssertionSchema)
    .optional()
    .describe(
      'Crossmark assertions the publisher attaches — article history (received, revised, accepted, published online), ethics and competing-interest statements, peer-review details, and boilerplate such as copyright — returned whole in deposited order, which is their sequence. Omitted when the record deposits none.',
    ),
};

/** Project a trial registration: the number, the registry DOI, and the stage, all byte-exact. */
function normalizeTrialNumber(t: CrossrefClinicalTrialNumber): ClinicalTrialNumber {
  return {
    number: t['clinical-trial-number'],
    ...(t.registry !== undefined && { registry: t.registry }),
    ...(t.type !== undefined && { type: t.type }),
  };
}

/**
 * Project a Crossmark assertion. `name`, the group's name, and both addresses are codes and
 * URLs, relayed byte-exact; `value` goes through the JATS pass, since publishers deposit inline
 * markup in it (`<i>`, Springer's `<Emphasis>`), and the two labels through the baseline pass.
 * A text field that normalizes to nothing is omitted like one never deposited. `url` is dropped
 * where it repeats `value` — journals that link their aims and scope deposit the one address
 * twice — and `order` always is: it restarts in every group and repeats within one, so the
 * array is the sequence.
 */
function normalizeAssertion(a: CrossrefAssertion): Assertion {
  const value = (a.value !== undefined && normalizeMarkupText(a.value)) || undefined;
  const label = normalizeNonEmptyText(a.label);
  const groupLabel = normalizeNonEmptyText(a.group?.label);
  return {
    name: a.name,
    ...(value !== undefined && { value }),
    ...(label !== undefined && { label }),
    ...(a.group?.name !== undefined && { group: a.group.name }),
    ...(groupLabel !== undefined && { groupLabel }),
    ...(a.URL !== undefined && a.URL !== value && { url: a.URL }),
    ...(a.explanation?.URL !== undefined && { explanationUrl: a.explanation.URL }),
  };
}

/** Each list the record deposits, every entry in deposited order. An empty list is omitted. */
export function projectAssertions(
  raw: Pick<RawCrossrefWork, 'clinical-trial-number' | 'assertion'>,
): { clinicalTrialNumbers?: ClinicalTrialNumber[]; assertions?: Assertion[] } {
  return {
    ...(raw['clinical-trial-number']?.length && {
      clinicalTrialNumbers: raw['clinical-trial-number'].map(normalizeTrialNumber),
    }),
    ...(raw.assertion?.length && { assertions: raw.assertion.map(normalizeAssertion) }),
  };
}

/** A trial registration's line: the number a reader looks up, then where, then at what stage. */
function trialLine(t: ClinicalTrialNumber): string {
  const registry = t.registry !== undefined ? ` — ${t.registry}` : '';
  const stage = t.type !== undefined ? ` (${mdText(t.type)})` : '';
  return `- ${t.number}${registry}${stage}`;
}

/** A deposited label beside the code it labels, or whichever of the two was deposited. */
function labelledCode(label: string | undefined, code: string | undefined): string | undefined {
  if (label !== undefined && code !== undefined) return `${mdText(label)} (${mdText(code)})`;
  const either = label ?? code;
  return either !== undefined ? mdText(either) : undefined;
}

/**
 * An assertion's line: its group, then the entry, each label beside the code it labels — the
 * group label is what tells one ethics statement from the next — then the value and the
 * addresses deposited with it, each named.
 */
function assertionLine(a: Assertion): string {
  const group = labelledCode(a.groupLabel, a.group);
  const value = a.value !== undefined ? `: ${mdText(a.value)}` : '';
  const url = a.url !== undefined ? ` — URL: ${a.url}` : '';
  const explanation = a.explanationUrl !== undefined ? ` — explanation: ${a.explanationUrl}` : '';
  return `- ${group !== undefined ? `${group} — ` : ''}${labelledCode(a.label, a.name)}${value}${url}${explanation}`;
}

/** The labelled Markdown list for each field the work carries, trial numbers first. */
export function assertionSections(w: {
  clinicalTrialNumbers?: ClinicalTrialNumber[] | undefined;
  assertions?: Assertion[] | undefined;
}): string[][] {
  return [
    w.clinicalTrialNumbers?.length
      ? ['**Clinical trial numbers:**', ...w.clinicalTrialNumbers.map(trialLine)]
      : undefined,
    w.assertions?.length ? ['**Assertions:**', ...w.assertions.map(assertionLine)] : undefined,
  ].filter((section) => section !== undefined);
}
