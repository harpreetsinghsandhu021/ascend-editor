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

export const matching: { [key: string]: string } = {
  "(": ")>",
  ")": "(<",
  "[": "]>",
  "]": "[<",
  "{": "}>",
  "}": "{<",
};

export function eltOffset(node: HTMLElement): Offset {
  let x = 0;
  let y = 0;

  let originalNode = node;
  while (originalNode) {
    x += originalNode.offsetLeft;
    y += originalNode.offsetTop;
    originalNode = originalNode.offsetParent as HTMLElement;
  }

  while (node && node != document.body) {
    x -= node.scrollLeft;
    y -= node.scrollTop;
    node = node.parentNode as HTMLElement;
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
  return str.replace(/[<&]/g, (str) => (str == "&" ? "&amp;" : "&lt;"));
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
  if (!to) return from ? from.length : 0;

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

/**
 * Copies styles from a source range to a destination range, applying styles from a source array.
 *
 * This functions iterates through styled text parts in the source array, copying the styles that fall
 * within the specified from and to positions to the dest array. It manages a state to determine whether
 * the current part is before, within or after the specified range.
 *
 * @param from - The starting position of the range to copy styles from (inclusive)
 * @param to - The ending position of the range to copy styles to (exclusive)
 * @param source - An array containing styled parts and their corresponding styles. The array is expected to be alternate b/w text and style.
 * @param dest - The destination array where the styled text parts and styles within the specified range will be copied.
 */
export function copyStyles(
  from: number,
  to: number,
  source: (string | null)[],
  dest: (string | null)[]
) {
  let pos = 0; // Current character position in the source text
  let state = 0; // State machine: 0 = before 'from', 1 = within 'from' to 'to'
  for (let i = 0; pos < to; i += 2) {
    const part = source[i] as string;
    const end = pos + part?.length;

    if (state === 0) {
      // Before the 'from' position
      if (end > from) {
        // The current fragment overlaps with the 'from' position
        dest.push(
          part.slice(from - pos, Math.min(part.length, to - pos)), // Copy the relevant portion of the text
          source[i + 1] // Copy the corresponding style
        );
      }

      if (end >= from) {
        // We've reached or passed the 'from' position
        state = 1; // Transition to the 'within range' state
      }
    } else if (state === 1) {
      // Within the 'from' to 'to' range
      if (end > to) {
        // The current fragment extends beyond the 'to' position
        dest.push(part.slice(0, to - pos), source[i + 1]);
      } else {
        // The current fragment is entirely within the 'from' and 'to' range
        dest.push(part, source[i + 1]);
      }
    }
    pos = end; // Update the current character position
  }
}
