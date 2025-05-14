import "./style.css";
import type { Position } from "./interfaces";
import { AsEvent, connect } from "./utils/events";
import { addTextSpan, removeElement } from "./utils/dom";
import {
  eltOffset,
  keyCodeMap,
  movementKeys,
  positionEqual,
  positionLess,
} from "./utils/helpers";

interface EditorOptions {
  value?: string;
}

class AscendEditor {
  div: HTMLDivElement;
  input: HTMLTextAreaElement;
  code: HTMLDivElement;
  cursor: HTMLDivElement;
  measure: HTMLSpanElement;
  lines: Array<{ div: HTMLDivElement; text: string; tokens: null }>;
  selection: { from: Position; to: Position; inverted?: boolean };
  prevSelection: { from: Position; to: Position };
  focused: boolean;
  editing: {
    text: string;
    from: number;
    to: number;
    start: number;
    end: number;
  };
  shiftSelecting: Position | null;
  reducedSelection: { anchor: number } | null;
  pollTimer: number | null;
  blinker: number | null;

  constructor(place: HTMLElement, options: EditorOptions) {
    const div = (this.div = place.appendChild(document.createElement("div")));
    div.className = "ascend-editor";

    const textarea = (this.input = div.appendChild(
      document.createElement("textarea")
    ));
    textarea.style.position = "absolute";
    textarea.style.width = "10000px";
    textarea.style.top = "20em";
    textarea.style.height = "14em";
    textarea.style.fontSize = "18px";

    const code = (this.code = div.appendChild(document.createElement("div")));
    code.className = "ascend-editor-code";

    this.cursor = code.appendChild(document.createElement("div"));
    this.cursor.className = "ascend-editor-cursor";
    this.cursor.style.visibility = "none";
    this.restartBlink();

    this.measure = code.appendChild(document.createElement("span"));
    this.measure.style.position = "absolute";
    this.measure.style.visibility = "hidden";
    this.measure.innerHTML = "-";

    this.lines = [];
    this.setValue(options.value || "");
    const zero = { line: 0, ch: 0 };

    this.selection = { from: zero, to: zero };
    this.prevSelection = { from: zero, to: zero };
    this.setCursor(0, 0);

    const self = this;
    connect(div, "mousedown", function (e) {
      self.onMouseDown(e);
    });

    connect(div, "dragenter", function (e) {
      e.stop();
    });
    connect(div, "dragover", function (e) {
      e.stop();
    });
    connect(div, "drop", function (e) {
      self.onDrop(e);
    });
    connect(div, "paste", function (e) {
      self.input.focus();
      self.schedulePoll(20);
    });

    connect(textarea, "keyup", function (e) {
      self.onKeyUp(e);
    });

    connect(textarea, "keydown", function (e) {
      self.onKeyDown(e);
    });

    connect(textarea, "focus", function () {
      self.onFocus();
    });

    connect(textarea, "blur", function () {
      self.onBlur();
    });

    if (document.activeElement === textarea) {
      this.onFocus();
    } else {
      this.onBlur();
    }

    this.blinker = null;
    this.shiftSelecting = zero;
    this.focused = false;
    this.editing = {
      text: "",
      start: 0,
      end: 0,
      from: 0,
      to: 0,
    };
    this.reducedSelection = { anchor: 0 };
    this.pollTimer = null;
  }

  setValue(code: string) {
    this.updateLines(0, this.lines.length, code.split(/\r?\n/g));
  }

  /**
   * Handles the mousedown event on the editor
   * @param e - The mouse event object.
   */
  onMouseDown(e: AsEvent) {
    let self = this;
    // Reset the shiftselecting property
    this.shiftSelecting = null;

    // Get the position of the mouse event.
    let start = this.mouseEventPos(e);
    let last = start;

    // Set the cursor position and turn off double scroll/paste selection
    this.setCursor(start.line, start.ch, false);

    // If the button pressed is not the left mouse button, return
    if (e.button() != 1) return;
    // Prevent the default event behavior
    e.stop();

    const move = connect(
      this.div,
      "mousemove",
      function (e) {
        console.log(e);

        // Get the current cursor position based om the mouse event
        let curr = self.clipPosition(self.mouseEventPos(e));

        // If the cursor position has changed, update the selection.
        if (!positionEqual(curr, last)) {
          last = curr;
          self.setSelection(self.clipPosition(start), curr, false);
        }
      },
      true
    );

    const up = connect(
      this.div,
      "mouseup",
      function (e) {
        // Set the final selection based on the start and end positions
        self.setSelection(
          self.clipPosition(start),
          self.clipPosition(self.mouseEventPos(e))
        );

        end();
      },
      true
    );

    const leave = connect(
      this.div,
      "mouseleave",
      function (e) {
        if (e.target() === self.div) end();
      },
      true
    );

    // Perform necessary cleanup after the selection is made
    function end() {
      // If the editor does`nt have focus, focus it and prepare the input
      if (!self.focused) {
        self.input.focus();
        self.onFocus();
        self.prepareInputArea();
      }

      move!();
      up!();
      leave!();
    }
  }

  /**
   * Updates a range of lines in the editor with new text content.
   * @param from - The starting line index to update (zero-based)
   * @param to - The ending line index to update
   * @param newText - Array of strings representing the new text content for each line
   */
  updateLines(from: number, to: number, newText: string[]) {
    // Calculate the difference in number of lines b/w old and new content
    const lenDiff = newText.length - (to - from);

    // Case 1: When new text has fewer lines than the range being replaced
    if (lenDiff < 0) {
      // Remove the extra lines from this.lines and their corresponding DIVs
      const removed = this.lines.splice(from, -lenDiff);
      for (let i = 0, l = removed.length; i < l; i++) {
        removeElement(removed[i].div);
      }

      // If the number of lines is greater than existing lines
    } else if (lenDiff > 0) {
      // Prepare the arguments for splicing new lines into this.lines
      const spliceArgs: { div: HTMLDivElement; text: string; tokens: null }[] =
        [];
      const before = this.lines[from] ? this.lines[from].div : null;

      // Insert new DIVs before the DIV at the `from` index
      for (let i = 0; i < lenDiff; i++) {
        const div = this.code.insertBefore(
          document.createElement("div"),
          before
        );
        // Add empty lines to the splice arguments
        spliceArgs.push({ div, text: "", tokens: null });
      }
      this.lines.splice.apply(this.lines, [from, 0, ...spliceArgs]);
    }

    // Update the text and tokens of each line in the given range
    for (let i = 0, l = newText.length; i < l; i++) {
      const line = this.lines[from + i];
      const text = (line.text = newText[i]);
      line.tokens = null;
      line.div.innerHTML = "";
      addTextSpan(line.div, line.text);
    }
  }

  onDrop(e: AsEvent) {
    let text: string;
    try {
      text = (e.e as DragEvent).dataTransfer?.getData("Text") || "";
    } catch (e) {
      text = "";
    }

    if (!text) return;

    const pos = this.clipPosition(this.mouseEventPos(e));
    this.setSelection(pos, pos, false);

    this.replaceSelection(text);
  }

  onKeyUp(e: AsEvent) {
    if (this.reducedSelection) {
      this.reducedSelection = null;
      this.readInput();
    }

    if ((e.e as KeyboardEvent).shiftKey) {
      this.shiftSelecting = null;
    }
  }

  onKeyDown(e: AsEvent) {
    // Regain focus if the editor is'nt focused yet
    if (!this.focused) this.onFocus();

    const event = e.e as KeyboardEvent;

    const key = event.key;
    const ctrl = event.ctrlKey && !event.altKey;

    // Handle page up/down keys
    if (key === "PageUp" || key === "PageDown") {
      this.scrollPage(key === "PageDown");
      e.stop();

      // Handle ctrl-home/end keys
    } else if (ctrl && (key === "Home" || key === "End")) {
      this.scrollEnd(key === "Home");
      e.stop();

      // Handle ctrl-a (select all)
    } else if (ctrl && key === "a") {
      this.selectAll();
      e.stop();
      //
      // Handle shift key (for shift selecting)
    } else if (key === "Shift") {
      this.shiftSelecting = this.selection.inverted
        ? this.selection.to
        : this.selection.from;
    } else {
      // Handle other keys
      let id = (ctrl ? "c" : "") + key;

      if (this.shiftSelecting && this.selection.inverted && movementKeys[id]) {
        this.reducedSelection = { anchor: this.input.selectionStart };
        this.input.selectionEnd = this.input.selectionStart;
      }

      this.schedulePoll(20, id);
    }
  }
  onFocus() {
    this.focused = true;
    this.displaySelection();
    this.schedulePoll(2000);
  }

  onBlur() {
    this.shiftSelecting = null;
    this.focused = false;
    this.displaySelection();
  }

  /**
   * Schedules a poll to read the editor's input and handle key events.
   * @param time - The time in milliseconfs to wait before polling.
   * @param key - The key being polled for. If provided, the poll will handle movement.
   */
  schedulePoll(time: number, key?: string) {
    const self = this;
    let missed = false;

    // Polls for the specified key and handles movement keys.
    function pollForKey() {
      let state = self.readInput();

      // If the state indicates a movement, mark the corresponding movement key as true
      if (state === "moved") {
        const keyId = keyCodeMap[key!];
        movementKeys[keyId] = true;
      }

      // If a state change occured or this is the first missed poll, reschedule the poll
      if (state || (!missed && (missed = true))) {
        self.schedulePoll(200, key);
      } else {
        // Otherwise, schedule a regular poll after a longer delay.
        self.schedulePoll(2000);
      }
    }

    // Performs a regular poll to read the editor's input.
    function poll() {
      self.readInput();
      if (self.focused) self.schedulePoll(2000);
    }

    clearTimeout(this.pollTimer as number);

    // Schedule the appropriate poll based on whether key is provided
    if (time) {
      this.pollTimer = setTimeout(key ? pollForKey : poll, time);
    }
  }

  /**
   * Reads and updates the editor's input area based on user interactions.
   *
   * This function handles changes made to the text content and selection range in the input area. It updates the editor's internal
   * state, such as the selection, lines, and editing object, based on the changes made by the user.
   *
   * @returns {string|boolean} A string indicating the type of change ('changed' or false if no change occured).
   */
  readInput() {
    let ed = this.editing;
    let changed = false;
    let sel = this.selection;
    let textarea = this.input;

    let text = textarea.value;
    let selStart = textarea.selectionStart;
    let selEnd = textarea.selectionEnd;

    // Check if the text or selection range has changed.
    changed = ed.text != text;
    let rs = this.reducedSelection;

    const moved =
      changed || selStart != ed.start || selEnd != (rs ? ed.start : ed.end);

    if (!moved) return false;

    let lines = text.split("\n");

    // Computes the line and character position from an offset.
    function computeOffset(n: number, startLine: number) {
      for (var i = 0; ; i++) {
        let ll = lines[i].length;
        if (n <= ll) return { line: startLine, ch: n };
        startLine++;
        n -= ll + 1;
      }
    }

    // Compute the start and end positions of the selection.
    let from = computeOffset(selStart, ed.from);
    let to = computeOffset(selEnd, ed.from);

    // Handle reduced selection cases
    if (rs) {
      from = selStart == rs.anchor ? to : from;
      to = sel.to;

      if (!positionLess(from, to)) {
        this.reducedSelection = null;
        to = from;
        from = sel.to;
      }
    }

    // Check if the selection has moved to a differnet line.
    const movedLine =
      rs || from.line != sel.from.line || to.line != sel.to.line;

    // Update the editing object's start and end positions if the selection has'nt moved to a different line.
    if (!movedLine) {
      ed.start = selStart;
      ed.end = selEnd;
    }

    // If the text has changed, update the editor's lines.
    if (changed) {
      this.shiftSelecting = null;
      let editStart = ed.from;
      let editEnd = ed.to;

      // Remove lines from the beginning that have'nt changed.
      while (
        editStart < this.lines.length &&
        lines[0] === this.lines[editStart].text
      ) {
        editStart++;
        lines.shift();
      }

      // Remove lines from the end that have'nt changed.
      while (
        editEnd > editStart &&
        lines[lines.length - 1] === this.lines[editEnd - 1].text
      ) {
        editEnd--;
        lines.pop();
      }

      // Update the editor's lines with the remaining lines.
      this.updateLines(editStart, editEnd, lines);
    }

    // Update the selection based on new start and end positions.
    this.setSelection(from, to, movedLine as boolean);

    return changed ? "changed" : moved ? "moved" : false;
  }

  /**
   * Displays the current text selection visually in the editor.
   *
   * This function is responsible for updating the visual representation of the text in the editor. It handles various cases, such as
   * single-position selection, multi-line selection and selection range changes. It also manages the cursor visibility and position, as
   * well as scrolling the editor to ensure the selection is visible.
   */
  displaySelection() {
    const sel = this.selection;
    const pr = this.prevSelection;

    // Store the current selection as the previous selection.
    this.prevSelection = { from: sel.from, to: sel.to };

    this.cursor.style.display = "none";

    // Check is the selection is an empty range ("from" and "to" positions are the same)
    if (positionEqual(sel.from, sel.to)) {
      // If the previous selection was not empty
      if (!positionEqual(pr.from, pr.to)) {
        // Remove the selected style from all lines in the previous selection
        for (var i = pr.from.line; i <= pr.to.line; i++) {
          this.removeSelectedStyle(i);
        }
      }

      if (this.focused) {
        this.cursor.style.display = "";

        // Calculate the position of the cursor based on the selected line
        let lineDiv = this.lines[sel.from.line].div;
        this.cursor.style.top = lineDiv.offsetTop + "px";
        this.cursor.style.left =
          lineDiv.offsetLeft + this.charWidth() * sel.from.ch + "px";
      }
    } else {
      // If the previous selection was not empty
      if (!positionEqual(pr.from, pr.to)) {
        // Loop through the lines that are part of the previous selection but not part of the current selection.
        //
        // Start from the line number of the previous selections's start positions, and end at the line number of
        // the current selection's start position or one line after the previous selection's end position, whichever is smaller.
        for (
          let i = pr.from.line, e = Math.min(sel.from.line, pr.to.line + 1);
          i < e;
          i++
        ) {
          this.removeSelectedStyle(i);
        }

        // Loop through the lines that are part of the previous selection but not part of the current selection.
        for (
          let i = Math.max(sel.to.line + 1, pr.from.line);
          i <= pr.to.line;
          i++
        ) {
          this.removeSelectedStyle(i);
        }

        // If the selection is on the same line
        if (sel.from.line === sel.to.line) {
          // Apply the selected style to the range on that line
          this.setSelectedStyle(sel.from.line, sel.from.ch, sel.to.ch);
        } else {
          // Apply the selected style to the beginning of the first line
          this.setSelectedStyle(sel.from.line, sel.from.ch, null);

          // Apply the selected style to all lines in between
          for (let i = sel.from.line + 1; i < sel.to.line; i++) {
            this.setSelectedStyle(i, 0, null);
          }

          // Apply the selected style to the end of the last line
          this.setSelectedStyle(sel.to.line, 0, sel.to.ch);
        }
      }

      // Update the previous selection range with the current selection
      pr.from = sel.from;
      pr.to = sel.to;

      // Calculate the vertical position of the selection's first line
      let yPos = this.lines[sel.from.line].div.offsetTop;
      let line = this.lineHeight();
      let screen = this.code.clientHeight;
      let screenTop = this.code.scrollTop;

      // Scroll the code area vertically to ensure the selection is visible
      if (yPos < screenTop) {
        this.code.scrollTop = Math.max(0, yPos - 0);
      } else if (yPos + line > screenTop + screen) {
        this.code.scrollTop = yPos + line + 10 - screen;
      }
    }
  }

  restartBlink() {
    clearInterval(this.blinker as number);

    this.cursor.style.visibility = "";
    const self = this;
    this.blinker = setInterval(() => {
      if (!self.div.parentNode) clearInterval(self.blinker as number);
      const st = self.cursor.style;
      st.visibility = st.visibility ? "" : "hidden";
    }, 650);
  }

  /**
   * Calculates the line and character position of a mouse event within the editor
   * @param e - The mouse event object.
   * @returns {{line: number, ch:number}}  - An object containing the line and character positions.
   */
  mouseEventPos(e: AsEvent) {
    // Get the offset of the first line's div element
    let offset = eltOffset(this.lines[0].div);

    // Calculate the x and y coordinates relative to the editor's scroll position
    let x = (e.e as MouseEvent).pageX - offset.left + this.code.scrollLeft;
    let y = (e.e as MouseEvent).pageY - offset.top + this.code.scrollTop;

    // Calculate the line and character positions based on the coordinate and editor metrics
    return {
      line: Math.floor(y / this.lineHeight()),
      ch: Math.floor(x / this.charWidth()),
    };
  }

  /**
   * Scrolls the editor view up or down by a page.
   * @param down : If true, scrolls down, scrolls up otherwise.
   */
  scrollPage(down: boolean) {
    // Calculate the number of lines that fit in the editor viewport.
    const linesPerPage = Math.floor(this.div.clientHeight / this.lineHeight());

    // Determine the line number to scroll to based on the current selection and the direction(up or down)
    const newLine =
      this.selection.from.line +
      Math.max(linesPerPage - 1, 1) * (down ? 1 : -1);

    this.setCursor(newLine);
  }

  /**
   * Sets the cursor position in the editor
   * @param line - The line number where the cursor should be set
   * @param ch - The cursor position within the line where the cursor should be set
   * @param rest
   */
  setCursor(line: number, ch?: number, rest?: boolean) {
    let pos = this.clipPosition({ line: line, ch: ch || 0 });

    this.setSelection(pos, pos);
  }

  /**
   * Clips a posiiton object to ensure it falls within the bounds of the editor content.
   *
   * This function takes a position object. It ensures that the line number is within the range of existing lines, and the character
   * position is within the range of characters in that line.
   * @param pos - The position object to be clipped
   */
  clipPosition(pos: Position) {
    // Ensure the line number is within the range of existing lines.
    // If it's negative, set it to 0 (the first line).
    // If it's greater than or equal to the number of lines, set it to the last line.
    pos.line = Math.max(0, Math.min(this.lines.length - 1, pos.line));

    // Ensure the character position is within the range of characters in the line.
    // If it's negative, set it to 0 (the start of the line)
    // It it's greater than or equal to the length of the line's text, set it to the end of the line.
    pos.ch = Math.max(0, Math.min(this.lines[pos.line].text.length, pos.ch));

    return pos;
  }

  /**
   * Sets the text selection range in the editor.
   *
   */
  setSelection(from: Position, to: Position, updateInput?: boolean) {
    // Get the current selection object and the shift selecting state.
    let sel = this.selection;
    let sh = this.shiftSelecting;

    this.restartBlink();

    // Ensure that "from" comes before "to" by swapping if necc.
    if (positionLess(to, from)) {
      let temp = to;
      to = from;
      from = temp;
    }

    // If shift selecting, adjust the selection range based on the shift start position.
    if (sh) {
      if (positionLess(sh, from)) from = sh;
      else if (positionLess(to, sh)) to = sh;
    }

    // Determine the selection inversion state based on the new and old selection ranges.
    let startEq = positionEqual(sel.to, to);
    let endEq = positionEqual(sel.from, from);

    if (positionEqual(from, to)) {
      sel.inverted = false;
    } else if (startEq && !endEq) {
      sel.inverted = true;
    } else if (endEq && !startEq) {
      sel.inverted = false;
    }

    // Update the selection range
    sel.from = from;
    sel.to = to;

    // Display the updated selection visually
    this.displaySelection();

    if (updateInput !== false) this.prepareInputArea();
  }

  replaceSelection(code: string) {
    const lines = code.split(/\r?\n/g);

    let sel = this.selection;

    lines[0] = this.lines[sel.from.line].text.slice(0, sel.from.ch) + lines[0];

    let endCh = lines[0].length;

    lines[lines.length - 1] += this.lines[sel.to.line].text.slice(sel.to.ch);

    this.updateLines(sel.from.line, sel.to.line + 1, lines);

    this.setSelection(sel.from, {
      line: sel.from.line + lines.length - 1,
      ch: endCh,
    });
  }

  /**
   * Prepares the input area with the text content from the editor's lines. Updates the editing object and sets the selection
   * range in the input area.
   */
  prepareInputArea() {
    const sel = this.selection;
    let textarr = [];

    // Determine the range of lines to include in the input area
    let from = Math.max(0, sel.from.line - 1);
    let to = Math.min(this.lines.length, sel.to.line + 2);

    // Build the text content from the selected lines
    for (let i = from; i < to; i++) {
      textarr.push(this.lines[i].text);
    }
    const text = (this.input.value = textarr.join("\n"));

    // Calculate the start and end character positions in the input area
    let startCh = sel.from.ch;
    let endCh = sel.to.ch;

    for (let i = from; i < sel.from.line; i++) {
      startCh += 1 + this.lines[i].text.length;
    }

    for (let i = from; i < sel.to.line; i++) {
      endCh += 1 + this.lines[i].text.length;
    }

    // Update the editing object with the calculated values
    this.editing = {
      text: text,
      from: from,
      to: to,
      start: startCh,
      end: endCh,
    };

    // Set the selection range in the input area
    this.input.selectionEnd = this.reducedSelection ? startCh : endCh;
    this.input.selectionStart = startCh;
  }

  setSelectedStyle(lineNo: number, start: number, end: number) {
    const line = this.lines[lineNo];
    if (!line.text) return;

    if (end === null) end = line.text.length;

    line.div.innerHTML = "";

    // If the start position is not at the begining of the line
    if (start > 0) {
      // Add a text span for the part before the selection
      addTextSpan(line.div, line.text.slice(0, start));
    }

    // Add a text span for the selected part
    addTextSpan(line.div, line.text.slice(start, end)).className =
      "ascend-editor-selected";

    if (end < line.text.length) {
      addTextSpan(line.div, line.text.slice(end));
    }
  }

  selectAll() {
    this.shiftSelecting = null;
    let endLine = this.lines.length - 1;
    this.setSelection(
      { line: 0, ch: 0 },
      { line: endLine, ch: this.lines[endLine].text.length }
    );
  }

  removeSelectedStyle(lineNo: number) {
    if (lineNo >= this.lines.length) return;
    const line = this.lines[lineNo];
    line.div.innerHTML = "";
    addTextSpan(line.div, line.text);
  }

  lineHeight() {
    return this.lines[0].div.offsetHeight;
  }

  charWidth() {
    return this.measure.offsetWidth || 1;
  }

  scrollEnd(top: boolean) {
    this.setCursor(top ? 0 : this.lines.length - 1);
  }
}

const editor = new AscendEditor(document.getElementById("code")!, {
  value: `function hello() {
    console.log("Hello, world!")
    return 42;
    }

    // Try typing and editing this code
    // The editor supports basic text editing functionality`,
});
