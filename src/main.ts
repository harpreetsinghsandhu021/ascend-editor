import "./style.css";
import "./mode/javascript/index.ts";
import "./mode/javascript/index.css";
import type { Line, Position } from "./interfaces";
import { AsEvent, connect } from "./utils/events";
import { addTextSpan, removeElement } from "./utils/dom";
import {
  copyPosition,
  copyState,
  eltOffset,
  htmlEscape,
  keyCodeMap,
  lineElt,
  movementKeys,
  positionEqual,
  positionLess,
} from "./utils/helpers";
import { StringStream, type TokenizeFn } from "./parsers/stringStream";
import { javascriptParser } from "./mode/javascript/index.ts";

interface EditorOptions {
  value?: string;
  parser?: any;
}

export class AscendEditor {
  div: HTMLDivElement;
  input: HTMLTextAreaElement;
  code: HTMLDivElement;
  cursor: HTMLDivElement;
  measure: HTMLSpanElement;
  lines: Array<Line>;
  selection: { from: Position; to: Position; inverted?: boolean };
  prevSelection: { from: Position; to: Position };
  focused: boolean = false;
  editing: {
    text: string;
    from: number;
    to: number;
    start: number;
    end: number;
  };
  shiftSelecting: Position | null;
  reducedSelection: { anchor: number } | null;
  pollTimer: number | null = null;
  blinker: number | null = null;
  work: number[] = []; // Array of line numbers to be highlighted
  static parsers: { [name: string]: any } = {};
  static defaultParser: string | null = null;
  static addParser(name: string, parser: any) {
    if (!AscendEditor.defaultParser) AscendEditor.defaultParser = name;
    AscendEditor.parsers[name] = parser;
  }
  // TODO: Change the type of parser
  parser: any; // The parser for syntax highlighting
  highlightTimeout: number | null = null;

  constructor(place: HTMLElement, options: EditorOptions) {
    const div = (this.div = place.appendChild(document.createElement("div")));
    div.className = "ascend-editor";

    const textarea = (this.input = div.appendChild(
      document.createElement("textarea")
    ));
    textarea.style.position = "absolute";
    textarea.style.width = "10000px";
    textarea.style.top = "20em";
    textarea.style.height = "10em";
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

    this.parser =
      AscendEditor.parsers[options.parser || AscendEditor.defaultParser];
    if (!this.parser) throw new Error("No parser found");

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

    this.shiftSelecting = zero;
    this.editing = {
      text: "",
      start: 0,
      end: 0,
      from: 0,
      to: 0,
    };
    this.reducedSelection = { anchor: 0 };
  }

  setValue(code: string) {
    this.replaceLines(0, this.lines.length, code.split(/\r?\n/g));
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
      "mouseout",
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
  replaceLines(from: number, to: number, newText: string[]) {
    let lines = this.lines;
    while (from < lines.length && newText[0] == lines[from].text) {
      from++;
      newText.shift();
    }

    while (to > from && newText[newText.length - 1] == lines[to - 1].text) {
      to--;
      newText.pop();
    }

    // Calculate the difference in number of lines b/w old and new content
    const lenDiff = newText.length - (to - from);

    // Case 1: When new text has fewer lines than the range being replaced
    if (lenDiff < 0) {
      // Remove the extra lines from this.lines and their corresponding DIVs
      const removed = lines.splice(from, -lenDiff);
      for (let i = 0, l = removed.length; i < l; i++) {
        removeElement(lineElt(removed[i]));
      }

      // If the number of lines is greater than existing lines
    } else if (lenDiff > 0) {
      // Prepare the arguments for splicing new lines into this.lines
      const spliceArgs: {
        div: HTMLDivElement;
        text: string;
        stateAfter: null;
        selDiv: null;
      }[] = [];
      const before = lines[from] ? lines[from].div : null;

      // Insert new DIVs before the DIV at the `from` index
      for (let i = 0; i < lenDiff; i++) {
        const div = this.code.insertBefore(
          document.createElement("div"),
          before
        );
        // Add empty lines to the splice arguments
        spliceArgs.push({ div, text: "", stateAfter: null, selDiv: null });
      }
      lines.splice.apply(lines, [from, 0, ...spliceArgs]);
    }

    // Update the text and tokens of each line in the given range
    for (let i = 0, l = newText.length; i < l; i++) {
      const line = lines[from + i];
      const text = (line.text = newText[i]);
      if (line.selDiv) this.code.replaceChild(line.div, line.selDiv);
      line.stateAfter = null;
      line.selDiv = null;
      line.div.innerHTML = "";
      addTextSpan(line.div, line.text);
    }

    let newWork = [];
    for (let i = 0; i < this.work.length; i++) {
      let task = this.work[i];
      if (task < from) {
        newWork.push(task);
      } else if (task >= to) {
        newWork.push(task + lenDiff);
      }
    }

    if (newText.length) newWork.push(from);
    this.work = newWork;
    this.startWorker(100);
    return { from: from, to: to, diff: lenDiff };
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
      this.prepareInputArea();
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
    } else if (!ctrl && key === "Enter") {
      this.insertNewLine();
      e.stop();
    } else if (!ctrl && key === "Tab") {
      this.handleTab();
      e.stop();
    } else if (key === "Shift") {
      this.shiftSelecting = this.selection.inverted
        ? this.selection.to
        : this.selection.from;
    } else {
      // Handle other keys
      let id = (ctrl ? "c" : "") + key;

      if (this.selection.inverted && movementKeys[id]) {
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
      if (state) {
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

    // Determine if cursor/selection has moved or text has changed. This considers both text changes and selection changes.
    const moved =
      changed || selStart != ed.start || selEnd != (rs ? ed.start : ed.end);

    // If nothing has changed, exit early.
    if (!moved) return false;

    // Split text into lines for position calculations.
    let lines = text.split("\n");

    // Computes the line and character position from an offset.
    function computeOffset(n: number, startLine: number) {
      let pos = 0; // Current position in the flat text

      // Continuosly search for newlines until we find the position
      while (true) {
        // Find the next newline character
        let found = text.indexOf("\n", pos);
        // If no more newlines or the newline is beyond our target position
        if (found == -1 || found >= n) {
          // Return the current line and character offset
          return { line: startLine, ch: n - pos };
        }
        // Move to next line
        startLine++;
        // Update position to character after the newline
        pos = found + 1;
      }
    }

    // Convert flat selection indices to 2D positions (line/column)
    let from = computeOffset(selStart, ed.from);
    let to = computeOffset(selEnd, ed.from);

    // Handle reduced selection cases
    if (rs) {
      // Adjust selection boundaries based on anchor point and shift selection state
      from = selStart == rs.anchor ? to : from;
      to = this.shiftSelecting ? sel.to : selStart == rs.anchor ? from : to;

      // Ensure 'from' position is before than 'to' position
      if (!positionLess(from, to)) {
        // If positions are reveresed, clear reduced selection and swap them.
        this.reducedSelection = null;
        let temp = from;
        from = to;
        to = temp;
      }
    }

    // Check if the selection crosses line boundaries.
    let lineCrossed =
      rs ||
      from.line != sel.from.line ||
      to.line != sel.to.line ||
      from.line != to.line;

    // If the text has changed, update the editor's content.
    if (changed) {
      this.shiftSelecting = null;

      // Replace the lines in the editor with new content
      let rpl = this.replaceLines(ed.from, ed.to, text.split(/\r?\n/g));

      // Check if the replacement affects line structure.
      if (
        rpl.from != sel.from.line ||
        rpl.to != sel.from.line + 1 ||
        rpl.diff
      ) {
        lineCrossed = true;
      }

      // If the selection does'nt cross lines, update editing state directly
      if (!lineCrossed) {
        ed.start = selStart;
        ed.end = selEnd;
        ed.text = text;
      }
    }

    // Update the selection based on new start and end positions.
    this.setSelection(from, to, lineCrossed as boolean);

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
        let lineDiv = lineElt(this.lines[sel.from.line]);
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
      }

      // If the selection is on the same line
      if (sel.from.line == sel.to.line) {
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
    let yPos = lineElt(this.lines[sel.from.line]).offsetTop;
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
    let offset = eltOffset(lineElt(this.lines[0]));

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

  replaceSelection(
    code: string,
    updateInput?: boolean,
    collapse?: "start" | "end"
  ) {
    const lines = code.split(/\r?\n/g);
    let sel = this.selection;

    // Prepend the text before the selection start to the first new line
    lines[0] = this.lines[sel.from.line].text.slice(0, sel.from.ch) + lines[0];

    // Store the character position at the end of the newly inserted last line before appending the rest of the orgiinal line.
    // This is where the cursor will be if not collapsed.
    let endCh = lines[lines.length - 1].length;

    // Append the text after the selection end from from the original line to the last new line
    lines[lines.length - 1] += this.lines[sel.to.line].text.slice(sel.to.ch);

    // Determine the final 'from' and 'to' positions for the selection after replacement
    let finalFromPos: Position = sel.from;

    let finalToPos: Position = {
      line: sel.from.line + lines.length - 1,
      ch: endCh,
    };

    // Replace the selected line with the new lines
    this.replaceLines(sel.from.line, sel.to.line + 1, lines);

    if (collapse === "end") {
      // If collapse is "end", move the cursor (both from and to) to the end of the inserted text
      finalFromPos = finalToPos;
    } else if (collapse === "start") {
      // If collapse is "start", move the cursor (both from and to) to the start of the inserted text
      finalToPos = finalFromPos;
    }

    this.setSelection(finalFromPos, finalToPos, updateInput);
  }

  /**
   * Inserts a newline character at the current selection point. It replaces the current selectoion with a newline character.
   * After inserting the newline, it attempts to indent the newly created line.
   */
  insertNewLine() {
    this.replaceSelection("\n", false, "end");
    if (!this.indentLine(this.selection.from.line)) {
      this.prepareInputArea();
    }
  }

  /**
   * Handles the Tab key press.
   * Iterates through each line within the current selectionr range and calls indentLine on each line to properly indent it.
   */
  handleTab() {
    let sel = this.selection;
    for (let i = sel.from.line; i <= sel.to.line; i++) {
      this.indentLine(i);
    }
  }

  /**
   * Idents a specific line based on the parser's indentation rules.
   * @param n - THe line number to indent (0-based index)
   */
  indentLine(n: number) {
    // Retrieve the parser state before the specified line.
    let state = this.getStateBefore(n);
    if (!state) return;

    let text = this.lines[n].text;
    // Determines the current amount of whitespace at the beginning of the line.
    let currSpace = text.match(/^\s*/)![0].length;
    // Calculate the correct indentation level based on the current state and the line's text
    let indentation = this.parser.indent(state, text.slice(currSpace));
    // Calculates the difference b/w the calculated indentation and the current whitespace.
    let diff = indentation - currSpace;
    if (!diff) return;

    // If the difference is positive, it means the line needs more indentation
    if (diff > 0) {
      // Construct a string of spaces with the length of the difference
      let space = "";
      for (let i = 0; i < diff; i++) space = space + " ";
      // Insert the spaces at the beginning of the lines
      this.replaceLines(n, n + 1, [space + text]);
    } else {
      // If the difference is negative, it means the line has too much indentation.

      // Remove the extra spaces from the beginning of the line.
      this.replaceLines(n, n + 1, [text.slice(-diff)]);
    }

    // Create copies of the from and to positions of the selection
    let from = copyPosition(this.selection.from);
    let to = copyPosition(this.selection.to);

    // If the from.line is the current line, it updates the from.ch to be at least the new indentation.
    if (from.line == n) from.ch = Math.max(indentation, from.ch + diff);
    // If the to.line is the current line, it updates the to.ch to be at least the new indentation.
    if (to.line == n) to.ch = Math.max(indentation, to.ch + diff);

    // Sets the selection with the new from and to positions.
    this.setSelection(from, to);

    return true;
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

  /**
   * Highlights a single line of code
   * @param line - Line object
   * @param state - The current state of the parser, used to determine the syntax highlighting styles
   */
  highLightLine(line: { text: string; div: HTMLElement }, state: any) {
    const stream = new StringStream(line.text);

    const html: string[] = []; // array to store HTML segements

    // Loop through the line text
    while (!stream.done()) {
      // Get the starting position of the current token
      const start = stream.pos;
      // Get the syntax highlighting style for the current token
      const style = this.parser.token(stream, state, start === 0);

      // Extract the token text from the line
      const str = line.text.slice(start, stream.pos);
      // Append the token text wrapped in a span with the appropriate with appropriate style class
      html.push(`<span class="${style}">${htmlEscape(str)}</span>`);
    }

    // Update the line's HTML element with the highlighted content
    line.div.innerHTML = html.join("");
  }

  /**
   * Continuously highlights lines in the background
   * @param start
   */
  highlightWorker(start?: number) {
    const end = Number(new Date()) + 200; // time limit for highlighting

    // Loop through the work queue
    while (this.work.length) {
      let task = this.work.pop()!;

      // Skip lines that have already been highlighted
      if (this.lines[task].stateAfter) continue;

      let state: any;

      if (task) {
        // Get the state from the previous line
        state = this.lines[task - 1].stateAfter;
        if (!state) continue;
        state = copyState(state);
      } else {
        // Start with the initial parser state
        state = this.parser.startState();
      }

      for (let i = task; i < this.lines.length; i++) {
        const line = this.lines[i];

        if (line.stateAfter) break;

        // If the time limit has been reached, reschedule the remaining
        if (Number(new Date()) > end) {
          this.work.push(i);
          this.startWorker(300);
          return;
        }

        // Highlight the current line and update its state
        this.highLightLine(line, state);
        line.stateAfter = copyState(state);
      }
    }
  }

  // Start the background highlighting worker
  startWorker(time: number) {
    if (!this.work.length) return;
    const self = this;
    clearTimeout(this.highlightTimeout!);
    this.highlightTimeout = setTimeout(() => self.highlightWorker(), time);
  }

  /**
   * Sets the selected style for a give line of code. This function highlights a portion of a text wirhin the editor
   * to indicate selection.
   * @param lineNo - The line number to apply the selection to (0-indexed)
   * @param start - The starting character position of the selection within the line (0-indexed)
   * @param end - The ending character position of the selection within the line (0-indexed)
   */
  setSelectedStyle(lineNo: number, start: number, end: number | null) {
    const line = this.lines[lineNo];
    let div = line.selDiv;
    let repl = line.div; // holds the element that will be replaced

    // If a selection div already exists, check if the new selection matches the existing one.
    if (div) {
      // If the new selection's start and end positions are identical to the existing selection, there's no need
      // to update, return early.
      if (div.start == start && div.end == end) return;
      // If it does not match, the existing selection becomes the repl
      repl = div;
    }

    // Create a new div element to represent the selection. This div will contain the styled text.
    div = line.selDiv = document.createElement("div");

    // If the start position is greatet than 0, it means there's a selection to apply
    if (start > 0) {
      // Add a text span with the text before the selection
      addTextSpan(div, line.text.slice(0, start));

      // Extract the selected text from the line
      let selText = line.text.slice(
        start,
        end == null ? line.text.length : end
      );

      // If "end" is null, the selection extends to the end of the line adding a space to the selected text.
      if (end == null) selText += " ";
      // Add a text span for the selected text, and apply the selected class for styling.
      addTextSpan(div, selText).className = "ascend-editor-selected";

      // If "end" is not null and it's within the line's text, add a text span for the text after the selection.
      if (end != null && end < line.text.length) {
        addTextSpan(div, line.text.slice(end));
      }

      div.start = start;
      div.end = end;

      // Replace the original or previous selection div with the new selection div in the code container.
      this.code.replaceChild(div, repl);
    }
  }

  /**
   * Retrieves the editor's state immediately before a specified line number, efficiently searching backward to find the nearest
   * saved state or the initial state. This function is crucial for incremental parsing and syntax highlighting, allowing the
   * editor to quickly determine the context for a given line without reparsing the entire document.
   * @param n - The line number to retrieve the preceding state
   * @returns {any | null} - The editor's state before line "n", or nukk if the state cannot be determined by a reasonable search limit.
   * Returns a copy of the state to avoid unintended modifications.
   */
  getStateBefore(n: number) {
    let state;
    let search: number;
    let lim: number;

    // Perform a backward search to locate the nearest saved or the start state. The search starts from the line immediately before
    // "n" and proceeds backward. "lim" defines a limit to prevent excessive searching (40 lines back).
    for (search = n - 1, lim = n - 40; ; search--) {
      // If the search goes beyond the beginning of the document, use the parser's start state.
      if (search < 0) {
        state = this.parser.startState();
        break; // Exit the loop once the start state is reached
      }

      // If the search reaches the search limit, the state is not found
      if (lim > search) return null;

      // Check if a state has been saved for the current line in the backward search. If found, copy the state to avoid
      // mutation and break the loop.
      if ((state = this.lines[search].stateAfter)) {
        state = copyState(state);
        break;
      }
    }

    // Starting from the line immediately after the found state, re-highlight lines and update their stateAfter properties.
    for (search++; search < n; search++) {
      let line = this.lines[search];

      this.highLightLine(line, state);
      line.stateAfter = copyState(state);
    }

    if (!this.lines[n].stateAfter) this.work.push(n);
    return state;
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
    if (!line.selDiv) return;
    this.code.replaceChild(line.div, line.selDiv);
    line.selDiv = null;
    // line.div.innerHTML = "";
    // addTextSpan(line.div, line.text);
  }

  lineHeight() {
    let firstLine = this.lines[0];
    return lineElt(firstLine).offsetHeight;
  }

  charWidth() {
    return this.measure.offsetWidth || 1;
  }

  scrollEnd(top: boolean) {
    this.setCursor(top ? 0 : this.lines.length - 1);
  }
}

AscendEditor.addParser("javascript", javascriptParser);

const editor = new AscendEditor(document.getElementById("code")!, {
  value: `function foo(a, b) {\n  var x = '100' + a;\n  return b ? x : 22.4;\n}\n`,
});
