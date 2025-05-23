import "./style.css";
import type { Position } from "./interfaces";
import { AsEvent, connect } from "./utils/events";
import { removeElement } from "./utils/dom";
import {
  copyPosition,
  copyState,
  eltOffset,
  keyCodeMap,
  movementKeys,
  positionEqual,
  positionLess,
} from "./utils/helpers";
import { javascriptParser } from "./mode/javascript/index.ts";
import { Line } from "./utils/line.ts";
import { Timer } from "./utils/timer.ts";
import { cssParser } from "./mode/css/index.ts";

interface EditorOptions {
  value?: string;
  parser?: any;
  lineNumbers?: any;
}

export class AscendEditor {
  div: HTMLDivElement;
  input: HTMLTextAreaElement;
  code: HTMLDivElement;
  cursor: HTMLSpanElement;
  measure: HTMLSpanElement;
  lineNumbers?: HTMLDivElement;
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
  poll: Timer;
  highlight: Timer;
  blinker: number | null = null;
  linesShifted: boolean = false;
  updateInput: boolean = false;
  work: number[] = []; // Array of line numbers to be highlighted
  static parsers: { [name: string]: any } = {};
  static defaultParser: string | null = null;
  static addParser(name: string, parser: any) {
    if (!AscendEditor.defaultParser) AscendEditor.defaultParser = name;
    AscendEditor.parsers[name] = parser;
  }
  static fromTextArea = function (
    textarea: HTMLTextAreaElement,
    options: any
  ) {};
  toTextArea!: () => void;
  // TODO: Change the type of parser
  parser: any; // The parser for syntax highlighting
  highlightTimeout: number | null = null;

  constructor(place: any, options: EditorOptions) {
    const div = (this.div = document.createElement("div"));
    if (place.appendChild) {
      place.appendChild(div);
    } else {
      place(div);
    }
    div.className = "ascend-editor";

    const textarea = (this.input = div.appendChild(
      document.createElement("textarea")
    ));
    textarea.style.position = "absolute";
    textarea.style.width = "10000px";
    textarea.style.top = "-100000px";
    textarea.style.left = "-100000px";
    // textarea.style.height = "10em";
    textarea.style.fontSize = "18px";

    const code = (this.code = div.appendChild(document.createElement("div")));
    code.className = "ascend-editor-code";

    this.cursor = document.createElement("span");
    this.cursor.className = "ascend-editor-cursor";
    this.cursor.innerHTML = "&nbsp;";
    // this.cursor.style.visibility = "none";
    this.restartBlink();

    this.measure = code.appendChild(document.createElement("span"));
    this.measure.style.position = "absolute";
    this.measure.style.visibility = "hidden";
    this.measure.innerHTML = "-";

    if (options.lineNumbers) {
      this.lineNumbers = code.appendChild(document.createElement("div"));
      this.lineNumbers.className = "ascend-editor-line-numbers";
    }

    this.poll = new Timer();
    this.highlight = new Timer();

    this.parser =
      AscendEditor.parsers[options.parser || AscendEditor.defaultParser];
    if (!this.parser) throw new Error("No parser found");

    this.lines = [];
    const zero = { line: 0, ch: 0 };

    this.selection = { from: zero, to: zero };
    this.prevSelection = { from: zero, to: zero };

    this.$setValue(options.value || "");

    this.endOperation();

    const self = this;
    connect(code, "mousedown", this.operation(this.onMouseDown));

    connect(code, "dragenter", function (e) {
      e.stop();
    });

    connect(code, "dblclick", this.operation(this.onDblClick));

    connect(code, "dragover", function (e) {
      e.stop();
    });
    connect(code, "drop", this.operation(this.onDrop));
    connect(code, "paste", function (e) {
      self.input.focus();
      self.fastPoll();
    });

    connect(textarea, "keyup", this.operation(this.onKeyUp));

    connect(textarea, "keydown", this.operation(this.onKeyDown));

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

  $setValue(code: string) {
    this.replaceLines(0, this.lines.length, code.split(/\r?\n/g));
  }

  getValue() {
    let lines = [];
    for (let i = 0; i < this.lines.length; i++) {
      lines.push(this.lines[i].text);
    }
    return lines.join("\n");
  }

  /**
   * Handles the mousedown event on the editor
   * @param e - The mouse event object.
   */
  onMouseDown(e: AsEvent) {
    let corner = eltOffset(this.code);

    if (
      (e.e as MouseEvent).pageX - corner.left > this.code.clientWidth ||
      (e.e as MouseEvent).pageY - corner.top > this.code.clientHeight
    ) {
      return;
    }

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
      window,
      "mousemove",
      this.operation((e: AsEvent) => {
        // Get the current cursor position based om the mouse event
        let curr = this.clipPosition(this.mouseEventPos(e));

        // If the cursor position has changed, update the selection.
        if (!positionEqual(curr, last)) {
          last = curr;
          this.setSelection(this.clipPosition(start), curr);
        }
      }),
      true
    );

    const up = connect(
      window,
      "mouseup",
      this.operation((e: AsEvent) => {
        // Set the final selection based on the start and end positions
        this.setSelection(
          this.clipPosition(start),
          this.clipPosition(this.mouseEventPos(e))
        );

        end();
      }),
      true
    );

    const leave = connect(
      window,
      "mouseout",
      this.operation((e: AsEvent) => {
        if (e.target() === document.body) end();
      }),
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

      self.updateInput = true;

      move!();
      up!();
      leave!();
    }
  }

  onDblClick(e: AsEvent) {
    this.selectWordAt(this.clipPosition(this.mouseEventPos(e)));
    e.stop();
  }

  selectWordAt(pos: Position) {
    let line = this.lines[pos.line].text;
    let start = pos.ch;
    let end = pos.ch;

    while (start > 0 && /\w/.test(line!.charAt(start - 1))) {
      start--;
    }
    while (end < line!.length - 1 && /\w/.test(line!.charAt(end))) {
      end++;
    }

    this.setSelection(
      { line: pos.line, ch: start },
      { line: pos.line, ch: end }
    );
    this.updateInput = true;
  }
  /**
   * Updates a range of lines in the editor with new text content.
   * @param from - The starting line index to update (zero-based)
   * @param to - The ending line index to update
   * @param newText - Array of strings representing the new text content for each line
   */
  replaceLines(from: number, to: number, newText: string[]) {
    let lines = this.lines;
    while (from < to && newText[0] == lines[from].text) {
      from++;
      newText.shift();
    }

    while (to > from + 1 && newText[newText.length - 1] == lines[to - 1].text) {
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
        removeElement(removed[i].div);
      }

      // If the number of lines is greater than existing lines
    } else if (lenDiff > 0) {
      // Prepare the arguments for splicing new lines into this.lines
      const spliceArgs: Line[] = [];
      const before = lines[from] ? lines[from].div : null;

      // Insert new DIVs before the DIV at the `from` index
      for (let i = 0; i < lenDiff; i++) {
        const div = this.code.insertBefore(
          document.createElement("div"),
          before
        );

        // Add empty lines to the splice arguments
        spliceArgs.push(new Line(div, this));
      }

      lines.splice.apply(lines, [from, 0, ...spliceArgs]);
    }

    // Update the text and tokens of each line in the given range
    for (let i = 0, l = newText.length; i < l; i++) {
      lines[from + i].setText(newText[i]);
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

    let selLine = this.selection.from.line;

    if (lenDiff || from != selLine || to != selLine + 1) {
      this.updateInput = true;
    }

    let lineNumbers = this.lineNumbers;
    let length = this.lines.length;

    if (lineNumbers) {
      let nums = lineNumbers.childNodes.length;
      while (nums > length) {
        lineNumbers.removeChild(lineNumbers.lastChild!);
        nums--;
      }

      while (nums < length) {
        let num = lineNumbers.appendChild(document.createElement("div"));
        num.innerHTML = `${++nums}`;
      }
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
    this.setSelection(pos, pos);

    this.$replaceSelection(text);
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

      this.fastPoll(20, id);
    }
  }
  onFocus() {
    this.focused = true;
    // this.displaySelection();
    this.slowPoll();
    if (this.div.className.search(/\bascend-editor-focused\b/) == -1) {
      this.div.className += " ascend-editor-focused";
    }
  }

  onBlur() {
    this.shiftSelecting = null;
    this.focused = false;
    // this.displaySelection();
    this.div.className = this.div.className.replace(
      " ascend-editor-focused",
      ""
    );
  }

  /**
   * Initializes a slow polling mechanism for the editor. This function sets up a recurring process to periodically
   * check for input and perform operations. It's designed to be less frequent than `fastpoll`.
   */
  slowPoll() {
    this.poll.set(2000, () => {
      this.startOperation();
      this.readInput();
      if (this.focused) {
        this.slowPoll();
      }

      this.endOperation();
    });
  }

  /**
   * Initializes a fast polling mechanism for the editor. This function is designed to rapidly check for input,
   * with the goal of providing a responsive editing experience. It often reacts to specific events, like key presses,
   * and is more frequent than `slowpoll`.
   * @param time
   * @param keyId
   */
  fastPoll(time?: number, key?: string) {
    let self = this;
    let misses = 0; // Counter to track missed input reads.

    function poll() {
      self.startOperation();

      let state = self.readInput();

      if (state === "moved" && key) {
        const keyId = keyCodeMap[key!];
        movementKeys[keyId] = true;
      }

      // If the input read was successfull (returned a truthy value)
      if (state) {
        // reschedule the poll to run again in 80 milliseconds.
        self.poll.set(80, poll);
        // Reset the `misses` counter since input was recieved.
        misses = 0;
      }
      // If the input read failed
      else if (misses++ < 4) {
        // and the number of missed reads is less than 4, reschedule the poll to run again in 80 milliseconds.
        // This allows a few retries before giving up.
        self.poll.set(80, poll);
      } else {
        self.slowPoll();
      }

      self.endOperation();
    }

    this.poll.set(20, poll);
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

    // If the text has changed, update the editor's content.
    if (changed) {
      this.shiftSelecting = null;

      this.replaceLines(ed.from, ed.to, text.split(/\r?\n/g));
    }

    ed.text = text;
    ed.start = selStart;
    ed.end = selEnd;
    // Update the selection based on new start and end positions.
    this.setSelection(from, to);

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
    const self = this;

    // Removes the cursor from the DOM if it's currently attached to a Node.
    if (this.cursor.parentNode) {
      this.cursor.parentNode.removeChild(this.cursor);
    }

    // Clears the selection from lines that were part of the previous selection.
    for (
      let i = pr.from.line,
        e = Math.min(this.lines.length, sel.from.line, pr.to.line + 1);
      i < e;
      i++
    ) {
      this.lines[i].setSelection(null, null);
    }

    // Clears the selection from lines that are not part of the previous selection by are part of the current selection.
    for (
      let i = Math.max(sel.to.line + 1, pr.from.line),
        e = Math.min(pr.to.line, this.lines.length);
      i <= e;
      i++
    ) {
      this.lines[i].setSelection(null, null);
    }

    // Sets the selection for a single-line selection.
    if (sel.from.line === sel.to.line) {
      this.lines[sel.from.line].setSelection(sel.from.ch, sel.to.ch);
    } else {
      // Sets the selection for a multi-line selection
      this.lines[sel.from.line].setSelection(sel.from.ch, null);
      for (let i = sel.from.line + 1; i < sel.to.line; i++) {
        this.lines[i].setSelection(0, null);
      }
      this.lines[sel.to.line].setSelection(0, sel.to.ch);
    }

    // Determines the head of the selection (start or end, depending on inversion) and
    // gets the corresponding line's div.
    let head = sel.inverted ? sel.from : sel.to;
    let headLine = this.lines[head.line].div;
    // Calculate the vertical position of the selection's first line
    let yPos = headLine.offsetTop;
    let line = this.lineHeight();
    let screen = this.code.clientHeight;
    let screenTop = this.code.scrollTop;

    // Scroll the code area vertically to ensure the selection is visible
    if (yPos < screenTop) {
      this.code.scrollTop = Math.max(0, yPos - 10);
    } else if (yPos + line > screenTop + screen) {
      this.code.scrollTop = yPos + line + 10 - screen;

      let xPos = head.ch * this.charWidth();
      let screenWidth = headLine.offsetWidth;
      let screenLeft = this.code.scrollLeft;

      if (xPos < screenLeft) {
        this.code.scrollLeft = Math.max(0, xPos - 10);
      } else if (xPos > screenWidth + screenLeft) {
        this.code.scrollLeft = xPos + 10 - screenWidth;
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
    pos.ch = Math.max(0, Math.min(this.lines[pos.line].text!.length, pos.ch));

    return pos;
  }

  /**
   * Sets the text selection range in the editor.
   *
   */
  setSelection(from: Position, to: Position) {
    // Get the current selection object and the shift selecting state.
    let sel = this.selection;
    let sh = this.shiftSelecting;

    // this.restartBlink();

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
  }

  $replaceSelection(code: string, collapse?: "start" | "end") {
    const lines = code.split(/\r?\n/g);
    let sel = this.selection;

    // Prepend the text before the selection start to the first new line
    lines[0] = this.lines[sel.from.line].text!.slice(0, sel.from.ch) + lines[0];

    // Store the character position at the end of the newly inserted last line before appending the rest of the orgiinal line.
    // This is where the cursor will be if not collapsed.
    let endCh = lines[lines.length - 1].length;

    // Append the text after the selection end from from the original line to the last new line
    lines[lines.length - 1] += this.lines[sel.to.line].text!.slice(sel.to.ch);

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

    this.setSelection(finalFromPos, finalToPos);
  }

  /**
   * Inserts a newline character at the current selection point. It replaces the current selectoion with a newline character.
   * After inserting the newline, it attempts to indent the newly created line.
   */
  insertNewLine() {
    this.$replaceSelection("\n", "end");
    this.indentLine(this.selection.from.line);
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
   * Indents a specific line based on the parser's indentation rules.
   * @param n - THe line number to indent (0-based index)
   */
  indentLine(n: number) {
    // Retrieve the parser state before the specified line.
    let state = this.getStateBefore(n);
    if (!state) return;

    let text = this.lines[n].text!;
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
      startCh += 1 + this.lines[i].text!.length;
    }

    for (let i = from; i < sel.to.line; i++) {
      endCh += 1 + this.lines[i].text!.length;
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
        line.highlight(this.parser, state);
        line.stateAfter = copyState(state);
      }
    }
  }

  // Start the background highlighting worker
  startWorker(time: number) {
    if (!this.work.length) return;
    const self = this;
    this.highlight.set(time, function () {
      self.highlightWorker();
    });
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

      line.highlight(this.parser, state);
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
      { line: endLine, ch: this.lines[endLine].text!.length }
    );
  }

  /**
   * Prepares for an operation by storing the current selection. This function captures the current selection's start
   * and end positions before and operation is performed. It also resets the linesShifted flag.
   */
  startOperation() {
    let ps = this.prevSelection;
    let sel = this.selection;

    ps.from = sel.from;
    ps.to = sel.to;

    this.updateInput = false;
  }

  /**
   * Finalizes an operation and updates the UI if necessary. This function compares the previous selection with the
   * current selection to determine if the selection has changed. If it has, it updates the display and restarts the
   * cursor blink. It also prepares the input if the selection spans multiple lines or if lines have been shifted.
   */
  endOperation() {
    let ps = this.prevSelection;
    let sel = this.selection;

    // Check if the selection has changed by comparing the start and end positions.
    if (!positionEqual(ps.from, sel.from) || !positionEqual(ps.to, sel.to)) {
      // If the selection has changed, update the display to reflect the new selection.
      this.displaySelection();
      this.restartBlink();
    }

    // Check if the selection spans multiple lines or if lines have been shifted.
    if (
      ps.from.line != sel.from.line ||
      ps.to.line != sel.to.line ||
      this.updateInput
    ) {
      this.prepareInputArea();
    }
  }

  /**
   * Wraps a function with start and end operation calls.
   * This function is a higher order function that takes another function as an argument.
   * It wraps the provided function with calls to startOperation and endOperation,
   * ensuring that the necessary setup and cleanup are perfomed before and after the function's execution.
   */
  operation(f: Function) {
    // Store a reference to 'this' for use within the returned function.
    let self = this;

    // If "f" is a string, assume it's a method name and get the actual function.
    if (typeof f == "string") {
      f = this[f];
    }

    // Return a new function that wraps the original function.
    return function () {
      // Prepare for the operation.
      self.startOperation();
      // Apply the original function "f" to the current context "self" with the provided arguments.
      let result = f.apply(self, arguments);
      // Finalize the operation.
      self.endOperation();

      return result; // Return the result of the original function.
    };
  }

  lineHeight() {
    let firstLine = this.lines[0];
    return this.lines[0].div.offsetHeight;
  }

  charWidth() {
    return this.measure.offsetWidth || 1;
  }

  scrollEnd(top: boolean) {
    this.setCursor(top ? 0 : this.lines.length - 1);
  }
}

/**
 * Wrap API functions as operations
 *
 * This code transforms AscendEditor's internal API methods (those prefixed with $) into operation wrapped public methods.
 * The wrapping ensures that complex operations are properly batched for performance and consistent state management.
 *
 * Operation wrapping is critical because it
 * 1. Batches DOM updates for better performance.
 * 2. Ensures the editor state remains consistent.
 * 3. Prevents unnecessary redraws during multi-step operations.
 * 4. Handles event dispatching at appropriate times.
 */
const proto = AscendEditor.prototype;

/**
 * Transforms an internal API method into a public operation-wrapped method
 *
 * This function takes an internal method name (prefixed with '$') and creates a public version (without the '$' prefix)
 * that automatically wraps the method call within the startOperation() and endOperation() method.
 * @param name - The name of the internal API method (with '$' prefix)
 */
function apiOp(name: string): void {
  const f = (proto as any)[name];

  // Create a new public method with the same name but without the `$` prefix.
  (proto as any)[name.slice(1)] = function (
    this: AscendEditor,
    ...args: any[]
  ): any {
    // Begin an operation batch to optimize updates.
    this.startOperation();

    // Call the original method with all arguments and the correct 'this' context.
    return f.apply(this, args);

    // Complete the operation batch, triggering any necessary updates.
    this.endOperation();
  };
}

/**
 * Auto-wrap all internal API methods.
 *
 * Iterates through all properties of the AscendEditor prototype, identifying internal methods (those starting with '$')
 * and wrapping them with operation handling.
 *
 * This approach allows the codebase to maintain clear seperation b/w internal implementation detaild and the public API
 * while ensuring all public methods properly handle operation batching.
 */
for (const n in proto) {
  if (n.charAt(0) === "$") {
    apiOp(n);
  }
}
const currentPath = window.location.pathname;

if (currentPath.includes("css")) {
  AscendEditor.addParser("css", cssParser);
} else {
  AscendEditor.addParser("javascript", javascriptParser);
}

console.log("currentpath", currentPath);

/**
 * Transforms a standard HTML Textarea element into a AscendEditor instance. It handles the synchronization of content
 * between the editor and the textarea, including saving the editor's content back to the textarea and managing form
 * submissions to ensure the editor's content is saved before the form is submitted. It also provides a "toTextarea" function
 * to revert the editor back to the original textarea.
 *
 * @param textarea
 * @param options
 */
AscendEditor.fromTextArea = function (textarea, options) {
  if (options && options.value == null) {
    options.value = textarea.value;
  }

  function save() {
    textarea.value = instance.getValue();
  }

  let rmSubmit: any;
  let realSubmit: () => void;
  // If textarea is part of a form, set up form submission handling.
  if (textarea.form) {
    // Attach the "save" function to the form's "submit" event.
    rmSubmit = connect(textarea.form, "submit", save);
    // Store the original form's submit function.
    realSubmit = textarea.form.submit;

    // Create a wrapped submit function to ensure the editor's content is saved
    // beofore the form is submitted.
    function wrappedSubmit() {
      // Update the textarea with the editor's current content.
      updateField();
      // Restore the original submit function.
      textarea.form!.submit = realSubmit;
      textarea.form?.submit();

      // Restore the wrapped function for subsequent submissions.
      textarea.form!.submit = wrappedSubmit;
    }

    textarea.form.submit = wrappedSubmit;
  }

  textarea.style.display = "none";

  const instance = new AscendEditor(function (node: HTMLElement) {
    textarea.parentNode?.insertBefore(node, textarea.nextSibling);
  }, options);

  // Add a function to revert to the original textarea.
  instance.toTextArea = function () {
    save();

    textarea.parentNode?.removeChild(instance.div);

    textarea.style.display = "";

    if (textarea.form) {
      textarea.form.submit = realSubmit;
      rmSubmit();
    }
  };

  return instance;
};

const editor = AscendEditor.fromTextArea(
  document.getElementById("code") as HTMLTextAreaElement,
  { lineNumbers: true }
);
