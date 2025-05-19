/**
 * A class for streaming string input.
 */
export class StringStream {
  pos: number; // current position in the string
  string: string;

  constructor(string: string) {
    this.pos = 0;
    this.string = string;
  }

  /**
   * Checks if the end of the string has been reached.
   * @returns True if the end of the string has been reached, false otherwise
   */
  done() {
    return this.pos >= this.string.length;
  }

  /**
   * Gets the character at the current position without advancing.
   * @returns The character at the current position.
   */
  peek() {
    return this.string.charAt(this.pos);
  }

  /**
   * Gets the character at the current position and advances the position.
   * @returns The character at the current position, or undefined if the string has been reached.
   */
  next() {
    if (this.pos < this.string.length) return this.string.charAt(this.pos++);
  }

  /**
   * Consume the next character if it matches the provided criteria
   * @param match - The criterion to match the character against.
   * @returns {string|undefined} The consumed character if it matches the criterion, false otherwise
   */
  eat(match: any): string | undefined {
    const ch = this.string.charAt(this.pos);

    let ok: boolean = false;

    if (typeof match == "string") {
      ok = ch == match;
    } else {
      if (ch && match.test) {
        ok = match.test(ch);
      } else if (match instanceof Function) {
        ok = match(ch);
      }
    }

    if (ok) {
      this.pos++;
      return ch;
    }
    return undefined;
  }
  /**
   * Consume characters while they match the provided criteria.
   * @param match The criterion to match the character against.
   * @returns {string|undefined} The consumed characters if it matches the criterion, false otherwise
   */
  eatWhile(match: RegExp | ((char: string) => boolean)) {
    const start = this.pos;
    while (this.eat(match));
    if (this.pos > start) return this.string.slice(start, this.pos);
  }

  /**
   *  Moves the position backward
   * @param n - The number of positions to move backward.
   */
  backUp(n: number) {
    this.pos -= n;
  }

  /**
   * Skips over whitespace characters.
   */
  eatSpace() {
    let start = this.pos;
    while (/\s/.test(this.string.charAt(this.pos))) this.pos++;
    return this.pos - start;
  }

  column() {
    return this.pos;
  }

  /**
   * Checks if the next characters match the provided pattern.
   * @param pattern - The pattern to match against
   * @param consume=true - Whether to consume the matched characters
   * @param caseInsensitive=false - Whether to perform case-insensitive matching.
   * @returns {boolean|RegExpMatchArray|null} True if the pattern matches, the matched string if pattern is a regex or null if no match is found.
   */
  match(
    pattern: string | RegExp,
    consume: boolean = true,
    caseInsensitive: boolean = false
  ) {
    if (typeof pattern === "string") {
      function cased(str: string) {
        return caseInsensitive ? str.toLowerCase() : str;
      }

      const str = cased(pattern);
      const idx = cased(this.string).indexOf(str, this.pos);

      if (idx === this.pos) {
        if (consume !== false) this.pos += str.length;
        return true;
      }
    } else {
      const match = this.string.slice(this.pos).match(pattern);
      if (match && consume !== false) {
        this.pos += match[0].length;
      }
      return match;
    }
  }
}

// Type alias for tokenization functions
export type TokenizeFn = (
  stream: StringStream,
  state: any
) => { type: string; style: string; content?: string };
