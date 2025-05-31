import { StringStream } from "../../parsers/stringStream";
import { textSpan } from "../../utils/dom";
import { copyStyles, htmlEscape } from "../../utils/helpers";
import type { Position } from "../../interfaces";

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

  constructor(text: string, styles?: (string | null)[]) {
    this.text = text;
    this.stateAfter = null;

    this.styles = styles || [text, null];
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

    copyStyles(0, from, this.styles, st);
    if (text) st.push(text, null);
    copyStyles(to, this.text?.length!, this.styles, st);

    this.styles = st;
    this.text = this.text?.slice(0, from) + text + this.text?.slice(to);
    this.stateAfter = null;
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
  getHTML(sfrom: number, sto: number) {
    const html: string[] = [];
    const st = this.styles;
    let pos = 0;
    let sel = sfrom === null ? 2 : 0;

    /**
     * Adds a piece of text to the HTML, applying the correct style and handling selection.
     * @param text
     * @param style
     */
    function addPiece(text: string, style: string | null, last?: number): void {
      let cls = style;

      const len = text?.length; // Length of the text segment
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
            // html.push('<span class="ascend-editor-cursor">\u200b</span>');
          } else {
            // Otherwise the selection starts at the span.
            sel = 1;
          }
        }
        // If the offset is within the current span, split the selection at the selection part.
        else if (off <= len && off < len) {
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

      // Build the class string.
      if (sel === 1) {
        cls += " ascend-editor-selected"; // Add selection class.
      }

      // Open the span tag, add the class, text and close the span.
      html.push(
        "<span",
        cls ? ' class="' + cls + '">' : ">",
        htmlEscape(!cut ? text : text.slice(0, cut)),
        "</span>"
      );

      pos += cut || len;

      if (cut) {
        // Recursively add the rest of the text.
        addPiece(text.slice(cut), style, last);
      }
    }

    for (let i = 0; i < st.length; i += 2) {
      addPiece(st[i] as string, st[i + 1]);
    }

    const empty = html.length == 0;

    // Handle the case of an open-ended selection.
    if (sel === 1 && sto == null) {
      html.push('<span class="ascend-editor-selected"> </span>');
    } else if (empty) {
      addPiece(" ", "");
    }

    // Set the inner HTML of the div with the generated HTML.
    return html.join("");
  }
}
