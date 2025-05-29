import "./style.css";
import type { Change, Position } from "./interfaces";
import { AsEvent, connect } from "./utils/events";
import { removeElement } from "./utils/dom";
import {
  copyPosition,
  copyState,
  editEnd,
  eltOffset,
  htmlEscape,
  keyCodeMap,
  movementKeys,
  positionEqual,
  positionLess,
} from "./utils/helpers";
import { javascriptParser } from "./mode/javascript/index.ts";
import { Line } from "./editor/core/line.ts";
import { Timer } from "./utils/timer.ts";
import { cssParser } from "./mode/css/index.ts";
import { History } from "./editor/history/history.ts";
import { SearchCursor } from "./editor/search/searchCursor.ts";

// Counter to track nested operation depth.
// Helps manage concurrent or nested editor operations.
// Higher values indicate nested operation depth.
let nestedOperation: number = 0;

export class AscendEditor {
  div: HTMLDivElement;
  input: HTMLTextAreaElement;
  code: HTMLDivElement;
  cursor: HTMLSpanElement;
  updates: { from: number; to: number; size: number; at: number }[] = [];
  space: ChildNode | null;
  changes: { from: number; to: number; diff: number }[] = [];
  visible: ChildNode | null;
  showingFrom: number = 0;
  showingTo: number = 0;
  measure: HTMLSpanElement;
  lineNumbers?: HTMLDivElement;
  lines: Array<Line>;
  selection: { from: Position; to: Position; inverted?: boolean };
  prevSelection: { from: Position; to: Position };
  focused: boolean = false;
  textChanged: boolean = false;
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
    if (!AscendEditor.defaults.parser) AscendEditor.defaults.parser = name;
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
  history: History | null;

  public static defaults: { [key: string]: any } = {
    value: "",
    indentUnit: 2,
    parser: null,
    lineNumbers: false,
    firstLineNumber: 1,
    onChange: null,
    onCursorActivity: null,
    workTime: 200,
    workDelay: 300,
    undoDepth: 40,
    readOnly: false,
  };
  options: { [key: string]: any } = {};

  constructor(place: any, options: any) {
    if (!options) options = {};
    let defaults = AscendEditor.defaults;

    for (let opt in defaults) {
      if (defaults.hasOwnProperty(opt) && !options.hasOwnProperty(opt)) {
        options[opt] = defaults[opt];
      }
    }

    this.options = options;

    const div = (this.div = document.createElement("div"));
    if (place.appendChild) {
      place.appendChild(div);
    } else {
      place(div);
    }
    div.className = "ascend-editor";

    div.innerHTML =
      '<textarea style="position: absolute; width: 10000px; left: -100000px; top: -100000px"></textarea>\
<div class="ascend-editor-code"><span style="position: absolute; visibility: hidden">-</span>\
<div style="position: relative"><div style="position: absolute; left: 0;"></div></div></div>';
    const textarea = (this.input = div.querySelector(
      "textarea"
    ) as HTMLTextAreaElement);
    const code = (this.code = div.lastChild as HTMLDivElement);
    this.measure = this.code.querySelector("span") as HTMLSpanElement;
    this.space = this.code.lastChild;
    this.visible = this.space!.firstChild;

    // if (options.lineNumbers) {
    //   this.lineNumbers = code.appendChild(document.createElement("div"));
    //   this.lineNumbers.className = "ascend-editor-line-numbers";
    // }

    this.poll = new Timer();
    this.highlight = new Timer();

    this.lines = [];
    this.setParser(this.options.parser);

    this.history = new History();
    const zero = { line: 0, ch: 0 };

    this.selection = { from: zero, to: zero, inverted: false };
    this.prevSelection = { from: zero, to: zero };

    this.operation(() => {
      this.setValue(options.value || "");
      this.updateInput = false;
    })();

    this.prepareInputArea();

    const self = this;
    connect(code, "mousedown", this.operation(this.onMouseDown));

    connect(code, "dragenter", function (e) {
      e.stop();
    });

    connect(code, "scroll", () => this.updateDisplay(false));
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

  setValue(code: string) {
    this.history = null;
    let top = { line: 0, ch: 0 };
    this.replaceLines(0, this.lines.length, code.split(/\r?\n/g), top, top);
    this.history = new History();
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
    let self = this;
    // Reset the shiftselecting property
    this.shiftSelecting = null;

    // Get the position of the mouse event.
    let start = this.posFromMouse(e);
    let last = start;

    if (!start) return;

    // Set the cursor position and turn off double scroll/paste selection
    this.setCursor(start.line, start.ch);

    // If the button pressed is not the left mouse button, return
    if (e.button() != 1) return;
    // Prevent the default event behavior
    e.stop();

    const move = connect(
      window,
      "mousemove",
      this.operation((e: AsEvent) => {
        // Get the current cursor position based om the mouse event
        let curr = this.posFromMouse(e)!;

        // If the cursor position has changed, update the selection.
        if (!positionEqual(curr, last!)) {
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
        let curr = this.posFromMouse(e);
        // Set the final selection based on the start and end positions
        if (curr) {
          this.setSelection(start, curr);
        }

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
    let pos = this.posFromMouse(e);
    if (!pos) return;
    // this.selectWordAt(this.posFromMouse(e));
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
   * UpdateLines
   * Updates a range of lines in the editor with new text content.
   * @param from - The starting line index to update (zero-based)
   * @param to - The ending line index to update
   * @param newText - Array of strings representing the new text content for each line
   */
  replaceLines(
    from: number,
    to: number,
    newText: string[],
    selFrom: Position,
    selTo: Position
  ) {
    let lines = this.lines;

    // Optimization 1: Skip unchanged lines at the beginning. If the first
    // line of new text matches the existing line, increment the start position
    // and remove that line from newText.
    while (from < to && newText[0] == lines[from].text) {
      from++;
      newText.shift();
    }

    // Optimization 2: Skip unchanged lines at the end. If the last line
    // of new text matches the existing line, decrement the end position and
    // remove that line from newText.
    while (to > from + 1 && newText[newText.length - 1] == lines[to - 1].text) {
      to--;
      newText.pop();
    }

    // If no changes are needed (all lines match), exit early.
    if (from == to && !newText.length) return;

    // Handle undo history if enabled.
    if (this.history) {
      // Store the old content for undo operations.
      let old: string[] = [];
      for (let i = from; i < to; i++) {
        old.push(lines[i].text!);
      }

      // Record the change in history
      this.history.addChange(from, newText.length, old);
      // Maintain history size limit by removing oldest changes
      while (this.history.done.length > this.options.undoDepth) {
        this.history.done.shift();
      }
    }

    // Update the lines with new content.
    this.updateLines(from, to, newText, selFrom, selTo);
  }

  // UpdatesLines1
  updateLines(
    from: number,
    to: number,
    newText: string[],
    selFrom: Position,
    selTo: Position
  ) {
    let lines = this.lines;
    // Calculate the difference in number of lines b/w old and new content
    const lenDiff = newText.length - (to - from);

    // Case 1: When new text has fewer lines than the range being replaced
    if (lenDiff < 0) {
      // Remove the extra lines from this.lines and their corresponding DIVs
      lines.splice(from, -lenDiff);

      // If the number of lines is greater than existing lines
    } else if (lenDiff > 0) {
      // Prepare the arguments for splicing new lines into this.lines
      const spliceArgs: Line[] = [];

      // Insert new DIVs before the DIV at the `from` index
      for (let i = 0; i < lenDiff; i++) {
        // Add empty lines to the splice arguments
        spliceArgs.push(new Line(newText[i]));
      }

      lines.splice.apply(lines, [from, 0, ...spliceArgs]);
    }

    // Update the text and tokens of each line in the given range
    for (let i = Math.max(0, lenDiff), l = newText.length; i < l; i++) {
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

    this.changes.push({ from: from, to: to, diff: lenDiff });

    function updateLine(n: number) {
      return n <= Math.min(to, to + lenDiff) ? n : n + lenDiff;
    }

    this.showingFrom = updateLine(this.showingFrom);
    this.showingTo = updateLine(this.showingTo);

    this.setSelection(
      selFrom,
      selTo,
      updateLine(this.selection.from.line),
      updateLine(this.selection.to.line)
    );
  }

  /**
   * Toggles the visibility and state of line numbers in the editor. This function is
   * responsible for creating or removing the line number DOM element based on the desired
   * state and udpating the editor's options.
   *
   * @param on - A boolean value indicating the desired state of line numbers.
   */
  setLineNumbers(on: boolean) {}

  /**
   * Helper function for implementing undo/redo in the editor. Handles the process of
   * reverting or reapplying text changes by managing the change stacks.
   * @param from - The source stack to pop changes from (either done or undone stack)
   * @param to - The destination stack to push reversed changes to
   */
  unredoHelper(from: Change[], to: Change[]) {
    // Pop the most recent change from the source stack.
    const change = from.pop();

    if (change) {
      // Array to store the text that will be replaced.
      const replaced: string[] = [];
      // Calculate the end position of the change.
      const end = change.start + change.added;

      // Store the current text that will be replaced.
      for (let i = change.start; i < end; i++) {
        replaced.push(this.lines[i].text!);
      }

      let pos = {
        line: change.start + change.old.length - 1,
        ch: editEnd(
          replaced[replaced.length - 1],
          change.old[change.old.length - 1]
        ),
      };
      // Apply the old text from the change record.
      this.updateLines(change.start, end, change.old, pos, pos);

      // Create and push a reverse change to the destination stack
      to.push({
        start: change.start,
        added: change.old.length,
        old: replaced,
      });

      // Set the cursor position after applying the change
      // Places cursor at the end of the last line affected by the chnage
      this.setCursor(
        // line number
        change.start + change.old.length - 1,
        // character position
        editEnd(
          replaced[replaced.length - 1], // current last line
          change.old[change.old.length - 1] // old last line
        )
      );
    }
  }

  undo() {
    this.unredoHelper(this.history?.done!, this.history?.undone!);
  }

  redo() {
    this.unredoHelper(this.history?.undone!, this.history?.done!);
  }

  onDrop(e: AsEvent) {
    let text: string;
    try {
      text = (e.e as DragEvent).dataTransfer?.getData("Text") || "";
    } catch (e) {
      text = "";
    }

    if (!text || this.options.readOnly) return;

    const pos = this.clipPosition(this.posFromMouse(e)!);
    this.setSelection(pos, pos);

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
    let done = false;

    // Handle page up/down keys
    if (key === "PageUp" || key === "PageDown") {
      this.scrollPage(key === "PageDown");
      done = true;

      // Handle ctrl-home/end keys
    } else if (ctrl && (key === "Home" || key === "End")) {
      this.scrollEnd(key === "Home");
      done = true;

      // Handle ctrl-a (select all)
    } else if (ctrl && key === "a") {
      this.selectAll();
      done = true;
      //
      // Handle shift key (for shift selecting)
    } else if (event.shiftKey) {
      this.shiftSelecting = this.selection.inverted
        ? this.selection.to
        : this.selection.from;
    } else if (!this.options.readOnly) {
      if (!ctrl && key === "Enter") {
        this.insertNewLine();
        done = true;
      } else if (!ctrl && key === "Tab") {
        this.handleTab();
        done = true;
      } else if (ctrl && key === "z") {
        this.undo();
        done = true;
      } else if ((ctrl && event.shiftKey && key === "z") || key === "y") {
        this.redo();
        done = true;
      }
    }

    if (done) {
      e.stop();
      return;
    }

    // Handle other keys
    let id = (ctrl ? "c" : "") + key;

    if (this.selection.inverted && movementKeys[id]) {
      this.reducedSelection = { anchor: this.input.selectionStart };
      this.input.selectionEnd = this.input.selectionStart;
    }

    this.fastPoll(20, id);
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

    if (
      this.reducedSelection &&
      !moved &&
      sel.from.line == 0 &&
      sel.from.ch == 0
    ) {
      this.reducedSelection = null;
    }

    // If nothing has changed, exit early.
    if (!moved) return false;

    if (changed) {
      this.shiftSelecting = null;
      this.reducedSelection = null;
      if (this.options.readOnly) {
        this.updateInput = true;
        return "changed";
      }
    }

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

      this.replaceLines(ed.from, ed.to, text.split(/\r?\n/g), from, to);
    } else {
      // Update the selection based on new start and end positions.
      this.setSelection(from, to);
    }

    ed.text = text;
    ed.start = selStart;
    ed.end = selEnd;

    return changed ? "changed" : moved ? "moved" : false;
  }

  scrollCursorIntoView() {
    let cursor = this.localCursorCoords(this.selection.inverted!);
    cursor.x += (this.space as HTMLElement).offsetLeft;
    cursor.y += (this.space as HTMLElement).offsetTop;

    let screen = this.code.clientHeight;
    let screenTop = this.code.scrollTop;

    if (cursor.y < screenTop) {
      this.code.scrollTop = Math.max(0, cursor.y - 10);
    } else if ((cursor.y += this.lineHeight()) > screenTop + screen) {
      this.code.scrollTop = cursor.y + 10 - screen;
    }

    let screenWidth = (this.space as HTMLElement).offsetWidth;
    let screenLeft = this.code.scrollLeft;
    if (cursor.x < screenLeft) {
      this.code.scrollLeft = Math.max(0, cursor.x - 10);
    } else if (cursor.x > screenWidth + screenLeft) {
      this.code.scrollLeft = cursor.x + 10 - screenWidth;
    }
  }

  updateDisplay(scroll?: boolean) {
    (this.space as HTMLElement).style.height =
      this.lines.length * this.lineHeight() + "px";
    if (scroll !== false) {
      this.scrollCursorIntoView();
    }

    let lh = this.lineHeight();
    let top = this.code.scrollTop - (this.space as HTMLElement).offsetTop;
    let visibleFrom = Math.max(0, Math.floor(top / lh));
    let visibleTo = Math.min(
      this.lines.length,
      Math.ceil(top + this.div.clientHeight) / lh
    );

    let intact = [{ from: this.showingFrom, to: this.showingTo, at: 0 }];
    for (let i = 0; i < this.changes.length; i++) {
      let change = this.changes[i];
      let intact2 = [];
      for (let j = 0; j < intact.length; j++) {
        let range = intact[j];

        if (change.to <= range.from) {
          intact2.push({
            from: range.from + change.diff,
            to: range.to + change.diff,
            at: range.at,
          });
        } else if (range.to <= change.from) {
          intact2.push(range);
        } else {
          if (change.from > range.from) {
            intact2.push({
              from: range.from,
              to: change.from,
              at: range.at,
            });
          } else {
            intact2.push({
              from: change.to + change.diff,
              to: range.to + change.diff,
              at: range.at + (change.to - range.from),
            });
          }
        }
      }
      intact = intact2;
    }

    let from = Math.min(this.showingFrom, Math.max(visibleFrom - 2, 0));
    let to = Math.floor(
      Math.max(this.showingTo, Math.min(visibleTo + 2, this.lines.length))
    );

    let updates = [];
    let pos = from;
    let at = from - this.showingFrom;
    let changedLines = 0;

    if (at > 0) {
      updates.push({ from: pos, to: pos, size: at, at: 0 });
    }

    for (let i = 0; i < intact.length; i++) {
      let range = intact[i];
      if (range.to <= pos) continue;
      if (range.from >= to) break;
      if (range.from > pos) {
        let size = range.at - at;
        updates.push({
          from: pos,
          to: range.from,
          size: size,
          at: at,
        });
        changedLines += Math.floor(size);
      }

      pos = range.to;
      at = range.to + (range.to - range.from);
    }

    if (pos < to) {
      let size = Math.max(0, this.showingTo - this.showingFrom);
      changedLines += Math.floor(size);
      updates.push({ from: pos, to: to, size: size, at: at });
    }

    if (!updates.length) return;
    if (changedLines > (visibleTo - visibleFrom) * 0.3) {
      this.refreshDisplay(visibleFrom, visibleTo);
    } else {
      this.patchDisplay(updates, from, to);
    }
  }

  refreshDisplay(from: number, to: number) {
    from = Math.max(from - 10, 0);
    to = Math.min(to + 10, this.lines.length);

    let html = [];
    let start = { line: from, ch: 0 };
    let inSel =
      positionLess(this.selection.from, start) &&
      !positionLess(this.selection.to, start);

    for (let i = from; i < to; i++) {
      let ch1 = null;
      let ch2 = null;

      if (inSel) {
        ch1 = 0;
        if (this.selection.to.line == i) {
          inSel = false;
          ch2 = this.selection.to.ch || null;
        }
      } else if (this.selection.from.line == i) {
        if (this.selection.to.line == i) {
          ch1 = this.selection.from.ch;
          ch2 = this.selection.to.ch;
        } else {
          inSel = true;
          ch1 = this.selection.from.ch;
        }
      }
      html.push("<div>", this.lines[i].getHTML(ch1!, ch2!), "</div>");
    }

    (this.visible as HTMLElement).innerHTML = html.join("");
    this.showingFrom = from;
    this.showingTo = to;
    (this.visible as HTMLElement).style.top = from * this.lineHeight() + "px";
  }

  patchDisplay(
    updates: { from: number; to: number; size: number; at: number }[],
    from: number,
    to: number
  ) {
    let sfrom = this.selection.from.line;
    let sto = this.selection.to.line;
    let off = 0;

    for (let i = 0; i < updates.length; i++) {
      let rec = updates[i];

      let extra = rec.to - rec.from - rec.size;

      if (extra) {
        let nodeAfter = this.visible?.childNodes[rec.at + off + rec.size];

        for (let j = Math.max(0, -extra); j > 0; j--) {
          this.visible?.removeChild(
            nodeAfter ? nodeAfter.previousSibling! : this.visible.lastChild!
          );
        }

        for (let j = Math.max(0, extra); j > 0; j--) {
          this.visible?.insertBefore(document.createElement("div"), nodeAfter!);
        }

        let node = this.visible?.childNodes[rec.at + off];
        let inSel = sfrom < rec.from && sto >= rec.from;

        for (let j = rec.from; j < rec.to; j++) {
          let ch1 = null;
          let ch2 = null;
          if (inSel) {
            ch1 = 0;
            if (sto == j) {
              inSel = false;
              ch2 = this.selection.to.ch || null;
            }
          } else if (sfrom == j) {
            if (sto == j) {
              ch1 = this.selection.from.ch;
              ch2 = this.selection.to.ch;
            } else {
              inSel = true;
              ch1 = this.selection.from.ch;
            }
          }

          (node as HTMLElement).innerHTML = this.lines[j].getHTML(ch1!, ch2!);
          node = node?.nextSibling!;
        }
        off += extra;
      }

      this.showingFrom = from;
      this.showingTo = to;
      (this.visible as HTMLElement).style.top = from * this.lineHeight() + "px";
    }
  }

  findCursor() {
    if (positionEqual(this.selection.from, this.selection.to)) {
      return this.code.getElementsByClassName("ascend-editor-cursor")[0];
    }
  }

  restartBlink() {
    clearInterval(this.blinker as number);
    let on = true;
    this.blinker = setInterval(() => {
      let cursor = this.findCursor();
      if (cursor) {
        (cursor as HTMLElement).style.display = (on = !on) ? "" : "none";
      }
    }, 650);
  }

  posFromMouse(e: AsEvent) {
    let off = eltOffset(this.space as HTMLElement);
    let x = (e.e as MouseEvent).pageX - off.left;
    let y = (e.e as MouseEvent).pageY - off.top;

    if (e.target() == this.code && y < this.lines.length * this.lineHeight()) {
      return null;
    }

    return this.clipPosition({
      line: Math.floor(y / this.lineHeight()),
      ch: Math.round(x / this.charWidth()),
    });
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
  setCursor(line: number, ch?: number) {
    let pos = this.clipPosition({ line: line, ch: ch || 0 });

    this.setSelection(pos, pos);
  }

  localCursorCoords(start: boolean) {
    let head = start ? this.selection.from : this.selection.to;
    return {
      x: head.ch * this.charWidth(),
      y: head.line * this.lineHeight(),
    };
  }

  /**
   * Calculates the screen coordinates of the cursor or selection boundaries
   * @param start - If true, get coords for selection start, else for selection end
   * @returns Coordinates object with x, y and bottom y position
   */
  cursorCoords(start: boolean) {
    let local = this.localCursorCoords(start);
    let off = eltOffset(this.space as HTMLElement);
    return {
      x: off.left + local.x,
      y: off.top + local.y,
      yBot: off.top + local.y + this.lineHeight(),
    };
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

    let ch = pos.ch;
    // Ensure the character position is within the range of characters in the line.
    // If it's negative, set it to 0 (the start of the line)
    // It it's greater than or equal to the length of the line's text, set it to the end of the line.
    ch = Math.max(0, Math.min(this.lines[pos.line].text!.length, pos.ch));

    return ch == pos.ch ? pos : { line: pos.line, ch: ch };
  }

  /**
   * Sets the text selection range in the editor.
   *
   */
  setSelection(from: Position, to: Position, oldFrom?: number, oldTo?: number) {
    if (
      positionEqual(this.selection.from, from) &&
      positionEqual(this.selection.to, to)
    )
      return;

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

    if (oldFrom == null) {
      oldFrom = sel.from.line;
      oldTo = sel.to.line;
    }

    if (!positionEqual(from, sel.from)) {
      if (from.line < oldFrom) {
        this.changes.push({
          from: from.line,
          to: Math.min(to.line, oldFrom) + 1,
          diff: 0,
        });
      } else {
        this.changes.push({
          from: oldFrom,
          to: Math.min(oldTo!, from.line) + 1,
          diff: 0,
        });
      }
    }

    if (!positionEqual(to, sel.to)) {
      if (to.line < oldTo!) {
        this.changes.push({
          from: Math.max(oldFrom, from.line),
          to: oldTo! + 1,
          diff: 0,
        });
      } else {
        this.changes.push({
          from: Math.max(from.line, oldTo!),
          to: to.line + 1,
          diff: 0,
        });
      }
    }

    // Update the selection range
    sel.from = from;
    sel.to = to;
  }

  /**
   * Replaces a range of text in the editor and adjusts selection positions accordingly.
   * @param code - The new text to insert
   * @param from - Starting position of the range to replace
   * @param to - Ending position of the range
   */
  replaceRange(code: string, from: Position, to?: Position) {
    // Ensure positions are within valid bounds
    from = this.clipPosition(from);
    to = to ? this.clipPosition(to) : from;
    let end1: Position = { line: 0, ch: 0 };

    /**
     * Adjusts a position based on the text replacement.
     * Handles three cases:
     * 1. Position before replacement range - unchanged
     * 2. Position within replacement range - moves to end of replacement
     * 3. Position after replacement - adjusted for change in text length
     * @param pos
     */
    function adjustPos(pos: Position): Position {
      if (positionLess(pos, from)) return pos;

      if (positionLess(pos, to!)) return end1;

      // Position is on the same line as replacement end
      if (pos.line == to?.line) {
        return {
          line: end1.line,
          ch: pos.ch + end1.ch - to.ch,
        };
      }
      // Position is after replacement - adjusts line number
      return {
        line: pos.line + end1.line - to!.line,
        ch: pos.ch,
      };
    }

    this.replaceRange1(
      code,
      from,
      to,
      (end: Position): { from: Position; to: Position } => {
        end1 = end;
        return {
          from: adjustPos(this.selection.from),
          to: adjustPos(this.selection.to),
        };
      }
    );

    return end1;
  }

  /**
   * Core text replacement function that handles the actual modification of text content.
   * Splits mutlti-line replacements and handles partial line replacement correctly.
   * @param code - The new text to insert
   * @param from - Starting position of replacement
   * @param to - Position object indicating the end of the inserted text
   */
  replaceRange1(
    code: string,
    from: Position,
    to: Position,
    computeSelection: (end: Position) => { from: Position; to: Position }
  ): Position {
    // Split replacement text into lines
    let splittedText = code.split(/\r?\n/g);

    // Preserve text before replacement in the first line
    splittedText[0] =
      this.lines[from.line].text?.slice(0, from.ch) + splittedText[0];

    // Store the length of the last inserted line
    const endCh = splittedText[splittedText.length - 1].length;

    // Preserce text after replacement in last line
    splittedText[splittedText.length - 1] += this.lines[to.line].text?.slice(
      to.ch
    );

    // Calculate the change in number of lines
    const diff = splittedText.length - (to.line - from.line + 1);

    const newSelection = computeSelection({ line: to.line + diff, ch: endCh });

    // Update the affected lines
    this.updateLines(
      from.line,
      to.line + 1,
      splittedText,
      newSelection.from,
      newSelection.to
    );

    return { line: to.line + diff, ch: endCh };
  }

  /**
   * Replaces the current selection with new text and optionally collapses the selection.
   * @param code - The text to insert at the current selection
   * @param collapse - Optional direction to collapse the selection
   */
  replaceSelection(code: string, collapse?: "start" | "end") {
    // Replace the selected text
    this.replaceRange1(
      code,
      this.selection.from,
      this.selection.to,
      (end: Position) => {
        // Handle selection collapse based on the collapse parameter
        if (collapse == "end") {
          return { from: end, to: end };
        } else if (collapse == "start") {
          return { from: this.selection.from, to: this.selection.from };
        } else {
          return { from: this.selection.from, to: end };
        }
      }
    );
  }

  /**
   * Inserts a newline character at the current selection point. It replaces the current selectoion with a newline character.
   * After inserting the newline, it attempts to indent the newly created line.
   */
  insertNewLine() {
    this.replaceSelection("\n", "end");
    this.indentLine(this.selection.from.line);
  }

  /**
   * Retrieves the selected text from the editor.
   * @param lineSep - Optional seperator for concatenating multiple lines (defaults to "\n")
   * @returns The selected text as a string
   */
  getSelection(lineSep?: string): string {
    const { from, to } = this.selection;

    // If a selection is within a single line
    if (from.line == to.line) {
      return this.lines[from.line].text!.slice(from.ch, to.ch);
    }

    // For multi-line selections:
    const selectedText = [
      // First line (from selections start to end of line)
      this.lines[from.line].text?.slice(from.ch),
    ];

    // Middle lines
    for (let i = from.line + 1; i < to.line; i++) {
      selectedText.push(this.lines[i].text);
    }

    // Last line
    selectedText.push(this.lines[to.line].text?.slice(0, to.ch));

    return selectedText.join(lineSep || "\n");
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
   * Sets the parser for syntax highlighting and resets line states
   * @param parserName - Name of the parser to use
   * @throws Error if the parser is not found
   */
  setParser(parserName: string): void {
    this.parser = AscendEditor.parsers[parserName];

    if (!this.parser) {
      throw new Error(`Parser '${parserName}' not found`);
    }

    // Reset state for all lines
    for (let i = 0; i < this.lines.length; i++) {
      this.lines[i].stateAfter = null;
    }

    // Reset work queue to start highlighting from beginning.
    this.work = [0];
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

    // Create copies of the from and to positions of the selection
    let from = copyPosition(this.selection.from);
    let to = copyPosition(this.selection.to);

    // If the from.line is the current line, it updates the from.ch to be at least the new indentation.
    if (from.line == n) from.ch = Math.max(indentation, from.ch + diff);
    // If the to.line is the current line, it updates the to.ch to be at least the new indentation.
    if (to.line == n) to.ch = Math.max(indentation, to.ch + diff);

    // If the difference is positive, it means the line needs more indentation
    if (diff > 0) {
      // Construct a string of spaces with the length of the difference
      let space = "";
      for (let i = 0; i < diff; i++) space = space + " ";
      // Insert the spaces at the beginning of the lines
      this.replaceLines(n, n + 1, [space + text], from, to);
    } else {
      // If the difference is negative, it means the line has too much indentation.

      // Remove the extra spaces from the beginning of the line.
      this.replaceLines(n, n + 1, [text.slice(-diff)], from, to);
    }
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
  highlightWorker() {
    const end = Number(new Date()) + this.options.workTime; // time limit for highlighting

    // Loop through the work queue
    while (this.work.length) {
      let task = this.work.pop()!;

      // Skip lines that have already been highlighted
      if (task >= this.lines.length || this.lines[task].stateAfter) continue;

      let state: any;

      if (task) {
        // Get the state from the previous line
        state = this.lines[task - 1].stateAfter;
        if (!state) continue;
        state = copyState(state);
      } else {
        // Start with the initial parser state
        state = this.parser.startState(this.options);
      }

      for (let i = task; i < this.lines.length; i++) {
        const line = this.lines[i];

        if (line.stateAfter) break;

        // If the time limit has been reached, reschedule the remaining
        if (Number(new Date()) > end) {
          this.work.push(i);
          this.startWorker(this.options.workDelay);
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
        state = this.parser.startState(this.options);
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
    // let ps = this.prevSelection;
    // let sel = this.selection;

    // this.prevSelection.from = sel.from;
    // this.prevSelection.to = sel.to;

    this.updateInput = false;
    this.changes = [];
  }

  /**
   * Finalizes an operation and updates the UI if necessary. This function compares the previous selection with the
   * current selection to determine if the selection has changed. If it has, it updates the display and restarts the
   * cursor blink. It also prepares the input if the selection spans multiple lines or if lines have been shifted.
   */
  endOperation() {
    if (this.changes.length) {
      // If the selection has changed, update the display to reflect the new selection.
      this.updateDisplay();
      this.restartBlink();
    }

    // Check if the selection spans multiple lines or if lines have been shifted.
    if (this.updateInput || this.changes.length) {
      this.prepareInputArea();
    }

    if (this.changes.length && this.options.onCursorActivity) {
      this.options.onCursorActivity(AscendEditor);
    }
    if (this.changes.length && this.options.onChange) {
      this.options.onChange(AscendEditor);
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

    // Return a new function that wraps the original function.
    return function () {
      // Start operation only for the outermost call
      if (nestedOperation === 0) {
        self.startOperation();
      }
      nestedOperation++;

      try {
        // Prepare for the operation.
        // Apply the original function "f" to the current context "self" with the provided arguments.
        let result = f.apply(self, arguments);
        return result;
      } finally {
        nestedOperation--;
        // End operation only when exiting the outermost call
        if (nestedOperation === 0) {
          // Finalize the operation.
          self.endOperation();
        }
      }
    };
  }

  /**
   * Creates and returns a public API interdace for the editor instance
   * @returns Object containing wrapped public methods
   */
  private createPublicInterface() {
    const self = this;

    return {
      // Basic text operations
      getValue: () => this.getValue(),
      setValue: () => this.operation((text: string) => this.setValue(text)),
      getSelection: (lineSep?: string) => this.getSelection(lineSep),
      replaceSelection: this.operation(
        (code: string, collapse?: "start" | "end") =>
          this.replaceSelection(code, collapse)
      ),

      // Cursor and selection operations
      getCursor: (start: boolean = false) => {
        const pos = start ? this.selection.from : this.selection.to;
        return { line: pos.line, ch: pos.ch };
      },
      setCursor: this.operation((line: number, ch: number) =>
        this.setCursor(line, ch)
      ),
      setSelection: this.operation((from: Position, to: Position) =>
        this.setSelection(from, to)
      ),

      // Search operations
      getSearchCursor: (
        query: string | RegExp,
        pos: Position | "cursor",
        caseFold: boolean
      ) => {
        return new SearchCursor(query, pos, self, caseFold);
      },

      // Line operations
      lineCount: () => this.lines.length,
      getLine: (line: number) => this.lines[line]?.text,
      setLine: this.operation((line: number, text: string) => {
        if (line >= 0 && line < this.lines.length) {
          this.replaceRange(
            text,
            { line, ch: 0 },
            { line, ch: this.lines[line].text?.length! }
          );
        }
      }),
      removeLine: this.operation((line: number) => {
        if (line >= 0 && line < this.lines.length) {
          this.replaceRange("", { line, ch: 0 }, { line: line + 1, ch: 0 });
        }
      }),

      // Line number operations
      setLineNumbers: this.setLineNumbers,

      // History operations
      undo: this.operation(() => this.undo()),
      redo: this.operation(() => this.redo()),

      // Parser operations
      setParser: (name: string) => this.setParser(name),

      // Focus operations
      focus: () => {
        this.input.focus();
        this.onFocus();
      },

      setReadOnly: (on: boolean) => {
        this.options.readOnly = on;
      },

      // Utility operations
      cursorCoords: (start: boolean) => this.cursorCoords(start),

      // Operation wrapper
      operation: (f: Function) => this.operation(f)(),

      // Direct access to editor instance (if needed)
      getEditor: () => self,
    };
  }

  /**
   * Creates a new editor instance
   * @param place  - DOM element or function to place editor
   * @param options - Editor configuration options
   * @returns Public interface for the editor
   */
  static createEditor(place: HTMLElement | Function, options: any = {}) {
    const editorInstance = new AscendEditor(place, options);
    return editorInstance.createPublicInterface();
  }

  lineHeight() {
    return this.measure.offsetHeight || 1;
  }

  charWidth() {
    return this.measure.offsetWidth || 1;
  }

  scrollEnd(top: boolean) {
    this.setCursor(top ? 0 : this.lines.length - 1);
  }
}

const currentPath = window.location.pathname;

if (currentPath.includes("css")) {
  AscendEditor.addParser("css", cssParser);
} else {
  AscendEditor.addParser("javascript", javascriptParser);
}

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
      // updateField();
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
