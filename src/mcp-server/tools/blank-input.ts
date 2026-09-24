/**
 * @fileoverview Blank optional inputs read as omitted. Form-based clients send `""` for a field
 * nobody filled in, so a blank or whitespace-only string carries no search intent: sent as-is,
 * Crossref ignores a blank `query`, matches nothing on a blank field query, and rejects or
 * arbitrarily applies a blank filter value. Every search handler normalizes its optional strings
 * through here once, at the top, so each guard below it reads the value the request will carry.
 * @module mcp-server/tools/blank-input
 */

/**
 * The value, or `undefined` when it is absent, empty, or whitespace only. A non-blank value is
 * returned exactly as supplied — nothing is trimmed off it.
 */
export function nonBlank<T extends string>(value: T | undefined): Exclude<T, ''> | undefined {
  return value?.trim() ? (value as Exclude<T, ''>) : undefined;
}

/** Whether a string input was supplied but carried nothing — the case `nonBlank` drops. */
export function isBlank(value: string | undefined): boolean {
  return value !== undefined && value.trim() === '';
}
