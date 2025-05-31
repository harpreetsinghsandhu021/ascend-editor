import { StringStream } from "../../parsers/stringStream";
import { copyStyles, htmlEscape } from "../../utils/helpers";

/**
 * Represents a single line of code within the editor. Manages the display, selection and highlighting of text
 * content for a specific line.
 *
 * @param {HTMLElement} div - The HTML element representing the line's content.
 * @param {HTMLElement} parent - The parent object.
 */
export class Line {
  // Stores Parent object.
  public parent: any;
  // Stores the text content of the line.
  public text: string | undefined;
  // Stores the state after a state point.
  public stateAfter: any;
  // Stores the selection start position.
  public selFrom: number | null = null;
  // Stores the selection end position.
  public selTo: number | null = null;
  // Stores the styles of the line.
  public styles: (string | null)[];
  // Tracks text marks/highlights
  public marked: { from: number; to: number; style: string }[] | null;

  constructor(text: string, styles?: (string | null)[]) {
    this.text = text;
    this.stateAfter = null;

    this.styles = styles || [text, null];
    this.marked = null;
  }

  /**
   * Replaces a portion of the line's text and styles with new text.
   *
   * This function modifies the line by replacing the text b/w the 'from' and 'to' indices with the provided 'text'.
   * It also updates the styles array to reflect the changes in the text. The function ensures that the styles are
   * correctly aligned with the new text content.
   *
   * @param from - The starting index of the text to be replaced.
   * @param to - The ending index of the text to be replaced.
   * @param text - The new text to insert in place of the old text.
   */
  replace(from: number, to: number, text: string) {
    let st: (string | null)[] = [];
    let marked = this.marked;

    copyStyles(0, from, this.styles, st);
    if (text) st.push(text, null);
    copyStyles(to, this.text?.length!, this.styles, st);

    this.styles = st;
    this.text = this.text?.slice(0, from) + text + this.text?.slice(to);
    this.stateAfter = null;

    // Handle marks adjustment if there are any
    if (marked) {
      // Calculate the length difference b/e old and new text
      let diff = text.length - (to - from);
      let end = this.text.length;

      // Helper function to adjust mark positions based on the change
      function fix(n: number) {
        return n <= Math.min(to, to + diff) ? n : n + diff;
      }

      // Iterate through all marks and adjust their positions
      for (let i = 0; i < marked.length; i++) {
        let mark = marked[i];
        let del = false;

        // Mark is beyond the end, should be deleted
        if (mark.from >= end) {
          del = true;
        } else {
          // Adjust mark start and end positions
          mark.from = fix(mark.from);
          if (mark.to != null) {
            mark.to = fix(mark.to);
          }
        }

        // Remove mark if it's flagged for deletion or became empty
        if (del || mark.from >= mark.to) {
          marked.splice(i, 1);
          i--
        }
      }
    }
  }

  /**
   * Splits the line into two lines at the given position
   * @param pos - The index at which to split the line
   * @param textBefore - The text to prepend the text before the split position.
   * @returns A new 'Line' object representing the portion of the line after the split.
   */
  split(pos: number, textBefore: string) {
    let st = [textBefore, null];
    copyStyles(pos, this.text?.length!, this.styles, st);
    return new Line(textBefore + this.text?.slice(pos), st);
  }

  /**
   * Adds Marks/Highlights to line segements
   * @param from
   * @param to
   * @param style
   */
  addMark(from: number, to: number, style: string) {
    if (this.marked == null) this.marked = [];
    this.marked.push({ from: from, to: to, style: style });
    this.marked.sort((a, b) => b.from - a.from);
  }

  /**
   * Removes Marks/Highlights from line segments
   * @param from
   * @param to
   * @param style
   */
  removeMark(from: number, to: number, style: string) {
    if (to == null) {
      to = this.text?.length!;
    }

    if (!this.marked) return;

    // Iterate through marks and handle various cases:
    // - Complete mark removal
    // - Partial mark removal requiring split
    // - Mark adjustment
    for (let i = 0; i < this.marked.length; i++) {
      let mark = this.marked[i];

      // Skip marks that don't match the style if style is specified
      if (style && mark.style != style) continue;

      // Calculate the effective end position of the mark
      let mto = mark.to == null ? this.text?.length : mark.to;
      let del = false;

      // Case 1: Mark is completely within removal range
      if (mark.from >= from && mto! <= to) {
        del = true;
      }
      // Case 2: Mark spans the removal range
      else if (mark.from < from && mto! > to) {
        // Split the mark into two parts
        this.marked.splice(i++, 0, {
          from: to, // Start new mark at removal end
          to: mark.to, // Keep original end
          style: mark.style, // Maintain same style
        });
        mark.to = from; // Truncate original work
      }
      // Case 3: Removal range starts within mark
      else if (mto! > from && mark.from < from) {
        mark.to = from; // Truncate mark at removal start
      }
      // Case 4: Removal range ends within mark
      else if (mark.from < to && mto! > to) {
        mark.from = to; // Start mark at removal end
      }

      // Remove mark if it's flagged for deletion or became empty
      if (del || mark.from == mark.to) {
        this.marked.splice(i--, 1); // Remove and adjust index
      }
    }
  }

  /**
   * Highlights the text content of the line using a provided parser. This method tokenizes the text, applies syntax
   * highlighting based on the token types, and updates the highlighed code.
   *
   * @param parser - The parser object, which provides a 'token' method to tokenize the text.
   * @param state - The current parser state, used to mantain context during tokenization.
   */
  highlight(parser: any, state: any): void {
    const stream = new StringStream(this.text!);
    let st = this.styles;
    st.length = 0;

    while (!stream.done()) {
      // Determines the starting position of the curren token.
      const start = stream.pos;
      // Calls the parser's token method to get the style of the current token.
      const style = parser.token(stream, state, start == 0);
      // Extract the substring corresponding to the current token.
      let substr = this.text!.slice(start, stream.pos);

      // Check if the current style is the same as the previous one.
      if (st.length && st[st.length - 1] == style) {
        // If the styles are the same, append the substring to the previous span.
        st[st.length - 2] += substr;
      } else if (substr) {
        // If the styles are different, push the substring and style to the styles array.
        this.styles.push(substr, style);
      }
    }
  }

  /**
   * Updates the DOM to reflect the current text content, styles, and selection.
   */
  getHTML(sfrom: number | null, sto: number) {
    // If no marks and selection spans entire line, return simple highlighted span
    if (!this.marked && sfrom === 0 && sto === null) {
      return (
        '<span class="ascend-editor-selected">' +
        htmlEscape(this.text!) +
        " </span>"
      );
    }

    let html: string[] = []; // Array to store HTML output
    let st = this.styles; // Array of text chunks and their styles
    let allText = this.text; // Full text content of the line
    let marked = this.marked; // Array of marked ranges

    // Wraps text in a styled span element if style is provided
    function span(text: string, style?: string) {
      if (!text) return;
      if (style) {
        html.push(`<span class=${style}>${htmlEscape(text)}</span>`);
      } else {
        html.push(text);
      }
    }

    // Normalize selection range
    if (sfrom == sto) sfrom = null;

    // Case 1: Handle empty lines with a space to maintain height
    if (!allText) {
      span(" ");
    }
    // Case 2: No markers and no selection - just style chunks
    else if (!marked && sfrom == null) {
      for (let i = 0; i < st.length; i += 2) {
        span(st[i]!, st[i + 1]!);
      }
    }
    // Case 3: Has marks or selection - requires careful segment handling
    else {
      let pos = 0;      // Current position in text
      let i = 0;        // Current index in styles array
      let text = "";    // Current text chunk being processed
      let style = null; // Current style being applied

      /**
       * Copies and styles text up to target position
       * Handles splitting of text chunks at arbitrary positions
       * @param end - Target position to copy until
       */
      function copyUntil(end: number) {
        while (true) {
          let upto = pos + text.length;

          // Split chunk if necessary and apply style
          span(upto > end ? text.slice(0, end - pos) : text, style!)
          if (upto >= end) {
            text = text.slice(end - pos)
            pos = end
            break
          }
          pos = upto
          text = st[i++]!
          style = st[i++]
        }
      }


      /**
       * Accumulates and styles text chunks up to target position
       * Used for maintaining style boundaries
       * @param end - Target position to accumulate until
       * @param cStyle - Style to apply to accumulated text
       */
      function chunkUntil(end: number, cStyle: string) {
        let acc = []

        while (true) {
          let upto = pos + text.length

          if (upto >= end) {
            let size = end - pos
            acc.push(text.slice(0, size))
            span(acc.join(""), cStyle)
            text = text.slice(size)
            pos += size
            break
          }

          acc.push(text)
          pos = upto
          text = st[i++]!
          style = st[i++]
        }
      }

      let markPos = 0
      let mark: { from: number; to: number, style?: string } = { from: 0, to: 0 }

      /**
       * Locates next marker that affects current position
       * @returns Starting position of next relevant marker
       */
      function nextMark() {
        if (!marked) return null

        while (markPos < marked.length) {
          mark = marked[markPos]
          let end = mark.to == null ? allText?.length : mark.to

          if (end! > pos) {
            return Math.max(mark.from, pos)
          }

          markPos++
        }
      }

      // Main rendering loop - processes text segments with proper styling
      while (pos < allText.length) {
        // Get next marker position that affects current position in text
        let nextmark = nextMark()

        // Case 1: SELECTION RANGE HANDLING
        // If we're at selection start and either no markers exists or selection starts before next marker
        if (sfrom != null && sfrom >= pos && (nextmark == null || sfrom <= nextmark)) {
          // Copy text up to selection start with current styling
          copyUntil(sfrom)

          // If selection extends to end of line
          if (sto == null) {
            // Add remaining text with selection styling and exit loop
            span(allText.slice(pos) + " ", "ascend-editor-selected")
            break
          }

          // Otherwise style the selected range
          chunkUntil(sto, "ascend-editor-selected")
        }
        // Case 2: MARKED RANGE HANDLING
        // If we have a marker starting at current position
        else if (nextmark != null) {
          // Copy text up to marker start with current styling
          copyUntil(nextmark)

          // Calculate marker end position (end of line if not specified)
          let end = mark.to == null ? allText.length : mark.to

          // Apply marker styling up either:
          // 1. Marker end if no selection or selection has'nt started
          // Selection start if it occurs before marker end
          chunkUntil(sfrom == null || sfrom < pos ? end : Math.min(sfrom, end), mark.style!)
        }

        // Case 3: DEFAULT HANDLING
        // No markers or selection affecting current position
        else {

          // Copy remaining text with currenrt styling
          copyUntil(allText.length)
        }
      }


    }
    return html.join("")
  }
}
