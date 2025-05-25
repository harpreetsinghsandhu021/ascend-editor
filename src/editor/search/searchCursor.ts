import type { Position, SearchPosition } from "../../interfaces";
import type { AscendEditor } from "../../main";
import type { Line } from "../core/line";

/**
 * Search cursor implementation for text search functionality in the editor.
 * Supports both string and regex searches with case-sensitive/insensitive options.
 */
export class SearchCursor {
  public atOccurence: boolean;
  public pos: SearchPosition;
  private editor: AscendEditor;
  private lines: Line[] = [];
  public matches: (
    reverse: boolean,
    pos: Position
  ) => SearchPosition | undefined = () => undefined;

  constructor(
    query: string | RegExp,
    pos: Position | "cursor",
    editor: AscendEditor,
    caseFold?: boolean
  ) {
    this.atOccurence = false;
    this.editor = editor;

    // Default to case-insensitive if query is lowercase string.
    if (caseFold === undefined) {
      caseFold = typeof query === "string" && query === query.toLowerCase();
    }

    let startPos: Position;
    if (pos === "cursor") {
      startPos = this.editor.selection.from;
    } else if (pos && typeof pos == "object") {
      startPos = this.editor.clipPosition(pos);
    } else {
      startPos = { line: 0, ch: 0 };
    }

    this.pos = { from: startPos, to: startPos };

    this.initializeSearchStrategy(query, caseFold);
  }

  /**
   * Sets up the appropriate search strategy based on query type
   */
  private initializeSearchStrategy(query: string | RegExp, caseFold: boolean) {
    if (typeof query !== "string") {
      this.initializeRegexSearch(query);
    } else {
      this.initializeStringSearch(query, caseFold);
    }
  }

  /**
   * Initializes regex-based search funtionality
   */
  private initializeRegexSearch(query: RegExp): void {
    this.matches = (
      reverse: boolean,
      pos: Position
    ): SearchPosition | undefined => {
      if (reverse) {
        return this.reverseRegexSearch(query, pos);
      }
      return this.forwardRegexSearch(query, pos);
    };
  }

  /**
   * Performs a reverse regex search from the given position within a single line of text.
   *
   * This method attempts to find the last occurence of the provided regular expression pattern in the
   * text of the line specified by `pos.line`, but only considering the portion of the line before `pos.ch`.
   */
  private reverseRegexSearch(
    query: RegExp,
    pos: Position
  ): SearchPosition | undefined {
    let line = this.lines[pos.line].text?.slice(0, pos.ch);

    // Attempt to find an initial match for the regex in the extracted line segment.
    let match = line?.match(query);
    // Keeps track of the starting character index of the last found match.
    let start = 0;

    while (match) {
      // Get the index of the current match within the current line segment.
      const index = line?.indexOf(match[0])!;

      // Add the index of the current match to `start`. This accumulates the offset from the beginning of
      // the original line.
      start += index;

      // Slice the `line` to start after the current match. This prepares the line for the next iteration to
      // find the subsequent matches.
      line = line?.slice(index + 1);

      // Attempt to find a new match in the remaining part of the line.
      const newMatch = line?.match(query);

      if (newMatch) {
        match = newMatch;
      } else {
        break;
      }
    }

    // If match is truthy at this point, then it holds the last match found.
    return match
      ? {
          from: { line: pos.line, ch: start },
          to: { line: pos.line, ch: start + match[0].length },
          match,
        }
      : undefined;
  }

  /**
   * Performs a forward regex search within a single line of text, starting from a given character position.
   *
   * This method attempts to find the first occurence of the provided regulat expression pattern in the text of
   * the line specified by `pos.line`.
   */
  private forwardRegexSearch(
    query: RegExp,
    pos: Position
  ): SearchPosition | undefined {
    const line = this.lines[pos.line].text?.slice(pos.ch)!;
    const match = line?.match(query);
    const start = match && pos.ch + line.indexOf(match[0]);

    return match
      ? {
          from: { line: pos.line, ch: start as number },
          to: { line: pos.line, ch: (start as number) + match[0].length },
          match,
        }
      : undefined;
  }

  /**
   * Initializes string-based search funtionality with optional case folding. Handles both single-line
   * and multi-line string searches.
   */
  private initializeStringSearch(query: string, caseFold: boolean): void {
    if (caseFold) {
      query = query.toLowerCase();
    }

    const fold = caseFold
      ? (str: string) => str.toLowerCase()
      : (str: string) => str;

    const target = query.split("\n");

    // Single-line search implementation
    if (target.length == 1) {
      this.matches = (
        reverse: boolean,
        pos: Position
      ): SearchPosition | undefined => {
        const line = fold(this.lines[pos.line].text!);
        const len = query.length;
        let match: number;

        if (reverse) {
          // Reverse search: look for last occurence before pos.ch
          if (
            pos.ch >= len &&
            (match = line.lastIndexOf(query, pos.ch - len)) !== -1
          ) {
            return {
              from: { line: pos.line, ch: match },
              to: { line: pos.line, ch: match + len },
            };
          }
        } else {
          // Forward search: look for first occurence after pos.ch
          if ((match = line.indexOf(query, pos.ch)) !== -1) {
            return {
              from: { line: pos.line, ch: match },
              to: { line: pos.line, ch: match + len },
            };
          }
        }
      };
    }
    // Multi-line search implementation
    else {
      this.matches = (
        reverse: boolean,
        pos: Position
      ): SearchPosition | undefined => {
        let ln = pos.line;
        let idx = reverse ? target.length - 1 : 0;
        let match = target[idx];
        let line = fold(this.lines[pos.line].text!);

        // Find the offset in the first/last line.
        // For reverse search, we're looking for the end of the `match` in the current line.
        // For forward search, we're looking for the start of the `match` in the current line.
        const offsetA = reverse
          ? line.indexOf(match) + match.length // Find the end of the first segment `match` in the current line.
          : line.lastIndexOf(match); // Find the start of the last segment `match` in the current line.

        // Check if the match position is valid
        if (
          reverse
            ? offsetA >= pos.ch || offsetA !== match.length // Check if the end of the matched segment is before `pos.ch` (for reverse) or if it's not a full line match.
            : offsetA <= pos.ch || offsetA !== line.length - match.length // Check if the start of the matched segment is after `pos.ch` (for forward) or if it's not a full line match.
          // line
        ) {
          return;
        }

        // Iterate through lines to find complete multi-line match
        while (true) {
          // Check for document boundaries to prevent out-of-bounds access.
          // If we've reached the beginning (for reverse) or end (for forward) of the document
          // without completing the match, then no match exists.
          if (reverse ? !ln : ln === this.lines.length - 1) return;

          // Move to the next/previous line
          ln += reverse ? -1 : 1;
          line = fold(this.lines[ln].text!);
          match = target[reverse ? idx-- : idx++]; // Get the corresponding part of the query.

          // For "middle" lines of a multi-line query (not the first or last),
          // the entire line must exactly match the corresponding part of the query.
          if (idx > 0 && idx < target.length - 1) {
            if (line !== match) return; // If a middle line does'nt match, the entire query does'nt match.
            continue;
          }

          // For the last (for forward) or first (for reverse) line of the multi-line query,
          // we need to find the specific offset where that part of the query matches.
          const offsetB = reverse
            ? line.lastIndexOf(match) // Find the last occurence of the query segment in the line.
            : line.indexOf(match) + match.length; // Find the first occurence and get its end position.

          // Verify that the found offset for the last/first line segment is correct.
          if (
            reverse
              ? offsetB !== line.length - match.length // Check if the match ends at the end of the line (or starts at the beginning effectively)
              : offsetB !== match.length // Check if the match starts at the beginning of the line.
          ) {
            return;
          }

          // If we've reached this point, a complete multi-line match has been found.
          // Construct the `from` and `to` positions for the entire match.
          const start = { line: pos.line, ch: offsetA };
          const end = { line: ln, ch: offsetB };

          return {
            from: reverse ? end : start,
            to: reverse ? start : end,
          };
        }
      };
    }
  }

  /**
   * Finds the next occurence of the search query.
   */
  public findNext(): boolean {
    return this.find(false);
  }

  /**
   * Finds the previous occurence of the search query.
   */
  public findPrevious(): boolean {
    return this.find(true);
  }

  /**
   * Core search function that handles both forward and reverse searches
   * @param reverse - Whether to search backwards
   */
  private find(reverse: boolean): boolean {
    const pos = this.editor.clipPosition(reverse ? this.pos.from : this.pos.to);

    const savePosAndFail = (line: number): boolean => {
      const pos = { line, ch: 0 };
      this.pos = { from: pos, to: pos };
      this.atOccurence = false;
      return false;
    };

    // Main search loop: continues until a match is found or boundaries is hit.
    while (true) {
      // Attempt to find a match on the current line or across lines starting from `pos`.
      const match = this.matches(reverse, pos);

      // If a match is found
      if (match) {
        // Update the cursor's position to the found match's coordinates
        this.pos = match;
        // Mark that the occurence is now at a valid occurence.
        this.atOccurence = true;
        return true;
      }

      // If no match is found on the current line/segement, prepare to move to the next/previous line.
      if (reverse) {
        // If searhing backward and already at the first line, the search has reached the beginning of the document.
        if (!pos.line) {
          return savePosAndFail(0); // Fail and reset to the beginning of the document.
        }

        pos.line--;
        // When moving to the previous line in a reverse search, start character position should be at the end
        // of that previous line to ensure full line scanning
        pos.ch = this.lines[pos.line].text?.length!;
      } else {
        if (pos.line === this.lines.length - 1) {
          return savePosAndFail(this.lines.length);
        }

        pos.line++;
        // when moving to the next line in a forward search, start character position should be at the beginning
        // of that next line.
        pos.ch = 0;
      }
    }
  }

  /**
   * Selects the current search match in the editor.
   */
  public select() {
    return this.editor.operation(() => {
      if (this.atOccurence) {
        this.editor.setSelection(
          this.editor.clipPosition(this.pos.from),
          this.editor.clipPosition(this.pos.to)
        );
      }
    });
  }

  /**
   * Replaces the current search match with the provided string
   * @param text - The string content to replace the current match with.
   */
  public replace(text: string) {
    return this.editor.operation(() => {
      if (this.atOccurence) {
        let fragments = this.pos.match;
        if (fragments) {
          text = text.replace(/\\(\d)/, (_, i) => fragments[i]);
        }

        // Perform the actual text replacement in the document.
        this.pos.to = this.editor.replaceRange(
          text,
          this.editor.clipPosition(this.pos.from),
          this.editor.clipPosition(this.pos.to)
        )!;

        // The occurence no longer exists ot has been changed.
        this.atOccurence = false;
      }
    });
  }

  /**
   * @returns The current position of the search cursor.
   */
  public position(): Position | undefined {
    if (this.atOccurence) {
      return {
        line: this.pos.from.line,
        ch: this.pos.from.ch,
      };
    }
  }
}
