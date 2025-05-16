import type { Offset, Position } from "../interfaces";

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
