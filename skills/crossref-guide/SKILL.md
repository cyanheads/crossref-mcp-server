---
name: crossref-guide
description: Judgment for the crossref_* tools — confirming a citation match, choosing between the journal/funder works lists and a filtered crossref_search_works, Crossref filter syntax (OR on one key, date bounds, types), DOI prefix versus current publisher, and deposit-dependent coverage. Use when resolving references to DOIs, listing a journal's, funder's, or publisher's works, counting works, or screening for retractions.
license: Apache-2.0
metadata:
  author: cyanheads
  version: "1.0"
---

## Scope

Crossref holds the metadata publishers deposit for Crossref-registered DOIs: journal articles, books and chapters, proceedings, preprints, peer reviews, and some datasets. Abstracts, reference lists, funders, ORCIDs, affiliations, and licenses are each deposited or not at the publisher's choice, so what a record lacks may exist elsewhere. Keyless.

Reach elsewhere for:

- Aggregations (works per year, per institution, per topic), author disambiguation, institutions, and topics — OpenAlex. Crossref answers counts only one filtered call at a time.
- Citation counts as a measure of influence — OpenAlex. `isReferencedByCount` counts only the citing works Crossref matched from deposited reference lists, so it differs from other indexes.
- Biomedical abstracts — PubMed. A DOI registered with DataCite — a DataCite source.

## Identifiers

| Identifier | Where it comes from |
|:-----------|:--------------------|
| DOI | crossref_search_works, or a citation in hand |
| ISSN (print and electronic) | crossref_search_journals — the record lists every ISSN with its form |
| Funder Registry ID | crossref_search_funders; bare (`100000001`) and full DOI (`10.13039/100000001`) forms are interchangeable in the `funder` filter |
| DOI prefix | The part of a DOI before the slash |
| Member ID | crossref_get_prefix from a prefix. No tool searches members by name: start from one of the publisher's DOIs |
| ORCID | Work records (authors); usable as the `orcid` filter |

## Gates

- **A bibliographic hit is a candidate, not a match.** crossref_search_works ranks results for any citation string, including one for a work that does not exist, and same-titled records (reprints, later items) rank beside the original. Before adopting a DOI, confirm title, first author, year, and container against the citation. Scores rank one query's results and carry no threshold across queries.
- **Absent is not "none".** A missing abstract, reference list, funder, ORCID, or affiliation means the publisher did not deposit it. Before reporting that a venue lacks something, read the `coverage` fractions on its crossref_search_journals or crossref_get_member record — a venue that deposits no funding metadata is invisible to the `funder` filter however many of its papers name a funder.
- **A DOI's prefix names who first registered it, not who owns it now.** A journal that changes publisher keeps its DOIs, and they move to the new member, so crossref_get_prefix on the DOI's own prefix can name the former publisher, and the record's `publisher` field is the depositor's text. crossref_get_work returns no member ID. To confirm the current owner, run crossref_search_works with the filters `doi` and `member` together: one result confirms it.
- **Say which funder scope a count uses.** The funded-works list on crossref_search_funders includes the funder's registry descendants; the `funder` filter on crossref_search_works counts only works asserting that exact ID, and the funder record's `worksCount` tracks the filter, not the list. No tool lists a funder's descendants, so a filtered count that includes sub-agencies is out of reach.
- **The update-type filter finds notices.** `{"update-type":"retraction"}` matches the records carrying the update: retraction notices, whose `updateTo` names the retracted DOI, and works retracted in place, which point at themselves. To screen known DOIs, read `updatedBy` on those works instead — several at once through an OR `doi` filter (below).

## Workflows

### Listing a journal's or funder's works

The works lists on crossref_search_journals and crossref_search_funders take no filters. A journal's list reads the works of one ISSN whichever of the journal's ISSNs you pass, so works deposited under only the other ISSN are not on it.

| Need | Route |
|:-----|:------|
| Newest works, no filter, or a funder's total with sub-agencies | The tool's own works list (`include_works`) |
| A date range, a type, `has-abstract`, or every ISSN | crossref_search_works with `issn` or `funder` filters |

For a journal through crossref_search_works, pass every ISSN its record lists as one OR filter (below).

### Filter syntax

- **OR on one key.** The filter object holds one value per key, but Crossref ORs a repeated key and the server joins pairs with commas, so a value carrying `,key:value` adds a second pair: `{"issn":"0028-0836,issn:1476-4687"}`, `{"type":"journal-article,type:proceedings-article"}`, `{"doi":"10.1038/171737a0,doi:10.1007/s11277-021-09072-0"}`. Different keys AND together.
- **Dates.** `from-pub-date` and `until-pub-date` take `YYYY`, `YYYY-MM`, or `YYYY-MM-DD`; a bare year covers the whole year. `from-created-date` bounds when the DOI was registered rather than published. A recorded publication date can lie in the future, so a newest-published list can lead with dates that have not arrived.
- **Types.** Crossref's own type names: a preprint is `posted-content`. An unknown type comes back as `invalid_parameter` listing every valid one.
- **Publisher scope.** `member` (numeric ID) and `prefix` list a publisher's works; `prefix` matches the owning member's prefix, so it includes DOIs carrying a transferred title's older prefix.
- **Counting.** For "how many", call crossref_search_works with `rows: 1` and `fields: ["DOI"]` and read `totalResults`; one call per bucket (per year, per type).
