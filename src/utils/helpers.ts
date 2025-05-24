import type { Line, Offset, Position } from "../interfaces";

export const keyCodeMap: Record<string, number> = {
  End: 35,
  Home: 36,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};

export const movementKeys: { [key: string]: boolean } = {};
for (let i = 35; i <= 40; i++) {
  movementKeys[i] = movementKeys[`c${i}`] = true;
}

export function eltOffset(node: HTMLElement): Offset {
  let x = 0;
  let y = 0;

  while (node) {
    x += node.offsetLeft;
    y += node.offsetTop;
    node = node.offsetParent as HTMLElement;
  }

  return { left: x, top: y };
}

export function positionEqual(a: Position, b: Position): boolean {
  return a.line === b.line && a.ch === b.ch;
}

export function positionLess(a: Position, b: Position): boolean {
  return a.line < b.line || (a.line === b.line && a.ch < b.ch);
}

export function copyPosition(pos: Position): Position {
  return { ...pos };
}

export function htmlEscape(str: string): string {
  return str.replace(/[<&]/g, (str) => (str === "&" ? "&amp;" : "&lt;"));
}

/**
 * Creates a copy of a parser state object.
 * @param state  - The parser state object to copy
 */
export function copyState(state: any) {
  if (state.copy) return state.copy();

  const nState: { [key: string]: any } = {};
  for (const n in state) {
    let val = state[n];
    if (val instanceof Array) val = val.concat([]);
    nState[n] = val;
  }

  return nState;
}

export function lineElt(line: Line) {
  return line.selDiv || line.div;
}

/**
 * Determines the end position of a text difference b/w two strings by comparing them from right to left.
 * Used to optimize text change detection by finding where two strings start to differ from their ends.
 * @param from - The original string before changes.
 * @param to - The new string after changes.
 * @returns The position from the end where the strings start to differ (1-based index from the end)
 */
export function editEnd(from: string, to: string): number {
  // nothing to compare
  if (!to) return 0;

  // Return the full length of "to" as everything in "to" is considered new.
  if (!from) return to.length;

  let i = from.length;
  let j = to.length;
  // Start from the end of both strings and work backwards.
  for (i = from.length, j = to.length; i >= 0 && j >= 0; --i, --j) {
    if (from.charAt(i) !== to.charAt(j)) break;
  }

  // Return the position from the end where differences start (1-based)
  return j + 1;
}
