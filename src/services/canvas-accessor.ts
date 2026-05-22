/**
 * @fileoverview Stores the optional DataCanvas reference injected during setup(),
 * so tool handlers can access it without a non-existent ctx.core property.
 * @module services/canvas-accessor
 */

import type { DataCanvas } from '@cyanheads/mcp-ts-core/canvas';

let _canvas: DataCanvas | undefined;

/** Called from setup() when CANVAS_PROVIDER_TYPE=duckdb is active. */
export function setCanvas(canvas: DataCanvas | undefined): void {
  _canvas = canvas;
}

/** Returns the DataCanvas instance, or undefined when canvas is disabled. */
export function getCanvas(): DataCanvas | undefined {
  return _canvas;
}
