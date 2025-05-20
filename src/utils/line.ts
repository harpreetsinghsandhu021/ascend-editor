import { StringStream } from "../parsers/stringStream";
import { textSpan } from "./dom";
import { htmlEscape } from "./helpers";

/**
 * Represents a single line of code within the editor. Manages the display, selection and highlighting of text
 * content for a specific line.
 *
 * @param {HTMLElement} div - The HTML element representing the line's content.
 * @param {HTMLElement} parent - The parent object.
 */
export class Line {
  // Stores the HTML div element representing the line.
  public div: HTMLElement;
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

  constructor(div: HTMLElement, parent: any) {
    this.div = div;
    this.parent = parent;
    this.styles = [];
  }

  /**
   * Sets the text content of the line. This method also resets the state after and clears
   * the existing content of the line's div.
   *
   * @param text - The new content for the line.
   */
  setText(text: string): void {
    this.text = text;
    this.styles.splice(0, this.styles.length, text, null);
    this.stateAfter = null;
    this.div.innerHTML = "";
    this.div.appendChild(textSpan(text));
  }

  /**
   * Sets the selection range within the line.
   *
   * @param from - The starting character position of the selection.
   * @param to - The ending character position of the selection. If null, the selection extends to the end of the line.
   */
  setSelection(from: number | null, to: number | null): void {
    if (this.selFrom !== from || this.selTo !== to) {
      this.selFrom = from;
      this.selTo = to;
      this.updateDOM();
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
    this.styles.length = 0;

    while (!stream.done()) {
      // Determines the starting position of the curren token.
      const start = stream.pos;
      // Calls the parser's token method to get the style of the current token.
      const style = parser.token(stream, state, start == 0);

      this.styles.push(this.text?.slice(start, stream.pos) as string);
      this.styles.push(style);
    }
    this.updateDOM();
  }

  /**
   * Updates the DOM to reflect the current text content, styles, and selection.
   */
  updateDOM() {
    const html: string[] = [];
    const st = this.styles;
    let pos = 0;
    let node = 0;
    const sfrom = this.selFrom;
    const sto = this.selTo;
    let sel = sfrom === null ? 2 : 0;
    let currAt: number | undefined;

    /**
     * Adds a piece of text to the HTML, applying the correct style and handling selection.
     * @param text
     * @param style
     */
    function addPiece(text: string, style: string | null): void {
      const len = text.length; // Length of the text segment
      let cut: number | undefined; // Position to cut the text segment if selection cuts through it.

      // If currently inside selection
      if (sel === 0) {
        // Calculates the offset from the current position to the start of the selection.
        const off = sfrom! - pos;

        // If the offset is 0, the selection starts at the beginning of this span.
        if (off === 0) {
          // If from equals to, then set cursor position.
          if (sfrom === sto) {
            sel = 2;
            currAt = node;
          } else {
            // Otherwise the selection starts at the span.
            sel = 1;
          }
        }
        // If the offset is within the current span, split the selection at the selection part.
        else if (off < len) {
          cut = off;
        }
      }

      // If we are inside the selection and have a selection end
      if (sel === 1 && sto != null) {
        // Calculate the position from the current position to the end of the selection.
        const off = sto - pos;

        // If the offset is 0, selection ends at the beginning of this span.
        if (off === 0) {
          sel = 2;
        } else if (off < len) {
          // If the offset is within the current span, then split the span at the selection end.
          cut = off;
        }
      }

      let cls = style; // Build the class string.
      if (sel === 1) {
        cls += " ascend-editor-selected"; // Add selection class.
      }

      // Open the span tag, add the class, text and close the span.
      html.push(
        "<span" +
          (cls ? ' class="' + cls + '">' : ">") +
          htmlEscape(cut === null ? text : text.slice(0, cut)) +
          "</span>"
      );

      node++;

      // Advance the position if no cut.
      if (cut == null) {
        pos += len;
      } else {
        // Advance the position by the cut amount.
        pos += cut;
        // Recursively add the rest of the text.
        addPiece(text.slice(cut), style);
      }
    }

    for (let i = 0; i < st.length; i += 2) {
      addPiece(st[i] as string, st[i + 1]);
    }

    // Handle the case of empty selection at the end.
    if (sel === 0 && sfrom === sto) {
      currAt = node;
    }
    // Handle the case of an open-ended selection.
    else if (sel === 1 && sto == null) {
      html.push('<span class="ascend-editor-selected"> </span>');
    }

    // Set the inner HTML of the div with the generated HTML.
    this.div.innerHTML = html.join("");

    // Insert the cursor if needed.
    if (currAt != null) {
      this.div.insertBefore(this.parent.cursor, this.div.childNodes[currAt]);
    }
  }
}
