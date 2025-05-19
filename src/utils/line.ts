import { StringStream } from "../parsers/stringStream";
import { selCls } from "./cssClass";
import { splitSpan, textSpan } from "./dom";
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

  constructor(div: HTMLElement, parent: any) {
    this.div = div;
    this.parent = parent;
  }

  /**
   * Replaces the text content of the line with the provided text. This method also resets the state after and clears
   * the existing content of the line's div.
   *
   * @param text - The new content for the line.
   */
  replaceText(text: string): void {
    this.text = text;
    this.stateAfter = null;
    this.div.innerHTML = "";
    this.div.appendChild(textSpan(text));
  }

  /**
   * Clears the selection from the line, removing any highligting and resitting properties.
   */
  clearSelection(): void {
    if (this.selFrom == null) return;

    // Iterate through the child nodes of the line's div.
    for (let node = this.div.firstChild; node; node = node.nextSibling) {
      selCls.remove(node as HTMLElement);
    }

    // Resets the selection start and end positions to null.
    this.selFrom = null;
    this.selTo = null;

    // Merge any adjacent spans that may have been created during selection.
    this.joinSpans();
  }

  /**
   * Sets the selection range within the line. This method adds the appropriate CSS class to the selected text spans
   * and adjusts the DOM to visually represent the selection.
   *
   * @param from - The starting character position of the selection.
   * @param to - The ending character position of the selection. If null, the selection extends to the end of the line.
   */
  setSelection(from: number, to: number | null): void {
    let pos = 0;
    let inside = 0;
    let next;

    // Iterates through the child nodes of the line's div.
    for (
      let currentNode = this.div.firstChild;
      currentNode;
      currentNode = currentNode.nextSibling
    ) {
      // Gets the length of the text content of the current node.
      let len = currentNode.firstChild?.nodeValue?.length!;

      // If not currently inside the selection.
      if (inside === 0) {
        // Calculates the offset from the current position to the start of the selection.
        let off = from - pos;

        // If the offset is 0, the selection starts at the beginning of this span.
        if (off === 0) {
          // If from equals to, then insert cursor element
          if (from == to) {
            inside = 2;
            currentNode!.parentNode?.insertBefore(
              this.parent.cursor,
              currentNode
            );
          } else {
            // Otherwise, the selection starts at the span.
            inside = 1;
          }
        }
        // If the offset is within the current span, split the selection at the selection part
        else if (off < len) {
          splitSpan(currentNode as HTMLElement, off);
          len = off;
        }
      }

      // If we are inside the selection and 'to' is not null.
      if (inside === 1 && to != null) {
        // Calculates the offset from the current position to the end of the selection.
        let off = to - pos;

        // If the offset is 0, the selection ends at the beginning of this span.
        if (off === 0) {
          inside = 2;
        } else if (off < len) {
          // If the offset is within the current span, split the span at the selection end.
          splitSpan(currentNode as HTMLElement, off);
          len = off;
        }
      }

      // If we are still inside the selection, add the selection class.
      if (inside === 1) {
        selCls.add(currentNode as HTMLElement);
      } else {
        selCls.remove(currentNode as HTMLElement);
      }

      // Update the current position.
      pos += len;
    }

    // Appends the cursor to the end of the line if the selection is cursor at the end.
    if (from === to && from === pos) {
      this.div.appendChild(this.parent.cursor);
    }

    this.selFrom = from;
    this.selTo = to;

    // Joins spans to clean up any splits
    this.joinSpans();
  }

  /**
   * Joins adjacent spans with the same class, which can result from splitting spans during the selection process.
   * This method
   */
  joinSpans(): void {
    // Iterates through the child nodes of the line's div.
    let currentNode: ChildNode | null = this.div.firstChild;
    while (currentNode) {
      let next = currentNode.nextSibling as HTMLElement;

      if (next && next.className == (currentNode as HTMLElement).className) {
        // If there's a sibling and it has the same class name as the current node.
        currentNode.parentNode?.removeChild(next);

        // Concatenate the text content of the next sibling to the current node.
        currentNode.firstChild!.nodeValue += next.firstChild?.nodeValue!;
      }

      currentNode = currentNode.nextSibling;
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
    const html: string[] = [];

    while (!stream.done()) {
      // Determines the starting position of the curren token.
      const start = stream.pos;
      // Calls the parser's token method to get the style of the current token.
      const style = parser.token(stream, state, start == 0);

      // Extracts the text content of the current token.
      const str = this.text!.slice(start, stream.pos);
      // Append the token text wrapped in a span with the appropriate with appropriate style class
      html.push(`<span class="${style}">${htmlEscape(str)}</span>`);
    }

    // Set the inner HTML of the line's div to the joined HTML array, effectively applying the highlighting.
    this.div.innerHTML = html.join("");
    // Restores the selection to its original position after applying the highlighting

    this.setSelection(this.selFrom!, this.selTo);
  }
}
