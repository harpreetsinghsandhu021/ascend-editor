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
