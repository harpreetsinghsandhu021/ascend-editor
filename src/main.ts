import "./style.css";
import type { Change, Position } from "./interfaces";
import { AsEvent, connect } from "./utils/events";
import {
  copyPosition,
  copyState,
  editEnd,
  eltOffset,
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
  inputDiv: HTMLElement;
  cursor: HTMLSpanElement;
  updates: { from: number; to: number; size: number; at: number }[] = [];
  space: ChildNode | null;
  changes: { from: number; to: number; diff?: number }[] = [];
  // visible: ChildNode | null;
  showingFrom: number = 0;
  showingTo: number = 0;
  measure: HTMLSpanElement;
  lineNumbers?: HTMLDivElement;
  lineDiv: HTMLElement;
  gutter: HTMLElement;
  mover: HTMLElement;
  selectionChanged: any;
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
  updateInput: boolean | null = false;
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
    tabIndex: null,
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
    div.className = "ascend-editor";

    div.innerHTML =
      '<div class="ascend-editor-code">' +
      '<div style="position: relative"><div style="position: absolute"><div class="ascend-editor-gutter"></div>' +
      '<div style="position: relative"><div style="position: absolute; visibility: hidden"><span>-</span></div>' +
      '<div style="overflow: hidden; position: absolute; width: 0">' +
      '<textarea style="position: absolute; width: 10000px;"></textarea></div>' +
      '<span class="ascend-editor-cursor">&nbsp;</span><div class="ascend-editor-lines"></div></div></div></div>';

    if (place.appendChild) {
      place.appendChild(div);
    } else {
      place(div);
    }

    const code = (this.code = div.lastChild as HTMLDivElement);
    const space = (this.space = code.firstChild);
    const mover = (this.mover = space?.firstChild as HTMLElement);
    const gutter = (this.gutter = mover?.firstChild as HTMLElement);
    const measure = (this.measure = mover?.lastChild
      ?.firstChild as HTMLElement);
    const inputDiv = (this.inputDiv = measure.nextSibling as HTMLElement);
    const cursor = (this.cursor = inputDiv?.nextSibling as HTMLElement);
    const lineDiv = (this.lineDiv = cursor?.nextSibling as HTMLElement);
    const textarea = (this.input = inputDiv.firstChild as HTMLTextAreaElement);

    if (options.tabIndex != null) {
      this.input.tabIndex = options.tabIndex;
    }

    if (!options.lineNumbers) {
      (gutter as HTMLElement).style.display = "none";
    }

    // if (options.lineNumbers) {
    //   this.lineNumbers = code.appendChild(document.createElement("div"));
    //   this.lineNumbers.className = "ascend-editor-line-numbers";
    // }

    this.poll = new Timer();
    this.highlight = new Timer();

    this.lines = [new Line("")];
    this.setParser(this.options.parser);

    this.history = new History();
    const zero = { line: 0, ch: 0 };

    this.selection = { from: zero, to: zero, inverted: false };
    this.prevSelection = { from: zero, to: zero };

    this.operation(() => {
      this.setValue(options.value || "");

      this.updateInput = false;
    })();

    setTimeout(() => {
      this.prepareInputArea();
    }, 20);

    const self = this;
    connect(code, "mousedown", this.operation(this.onMouseDown));

    connect(code, "dragenter", function (e) {
      e.stop();
    });

    connect(code, "scroll", () => this.updateDisplay());
    connect(window, "resize", () => this.updateDisplay());

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
    this.replaceLines(
      top,
      {
        line: this.lines.length - 1,
        ch: this.lines[this.lines.length - 1].text?.length!,
      },
      code,
      top,
      top
    );
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

    if (!this.focused) this.onFocus();

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
          this.updateInput = false;
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
      self.input.focus();

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
  }

  /**
   * UpdateLines
   * Updates a range of lines in the editor with new text content.
   * @param from - The starting line index to update (zero-based)
   * @param to - The ending line index to update
   * @param newText - Array of strings representing the new text content for each line
   */
  replaceLines(
    from: Position,
    to: Position,
    newText: string | string[],
    selFrom: Position,
    selTo: Position
  ) {
    if (typeof newText == "string") newText = newText.split(/\r?\n/g);

    // Handle undo history if enabled.
    if (this.history) {
      // Store the old content for undo operations.
      let old: string[] = [];
      for (let i = from.line; i < to.line + 1; i++) {
        old.push(this.lines[i].text!);
      }

      // Record the change in history
      this.history.addChange(from.line, newText.length, old);
      // Maintain history size limit by removing oldest changes
      while (this.history.done.length > this.options.undoDepth) {
        this.history.done.shift();
      }
    }

    // Update the lines with new content.
    this.updateLines(from, to, newText, selFrom, selTo);
  }

  // UpdatesLines1
  /**
   * Updates the lines array and associated DIVs based on the changes.
   *
   * This function is the core of the editor's update mechanism. It takes a range of lines (`from` to `to`) and replaces
   * them with new text (`newText`). It also handles updating the DOM to reflect these changes, and adjusts the cursor position if necessary.
   *
   * @param from - The starting position of the text to be replaced.
   * @param to - The ending position of the text to be replaced.
   * @param newText - An array of strings representing the new text to insert. Each string in the array corresponds to a line.
   * @param selFrom - The new starting position of the selection ater the update.
   * @param selTo - The new ending position of the selection after the update.
   */
  updateLines(
    from: Position,
    to: Position,
    newText: string[] | string,
    selFrom: Position,
    selTo: Position
  ) {
    // Calculate the number of lines being replaced.
    let nLines = to.line - from.line;
    let firstLine = this.lines[from.line];
    let lastLine = this.lines[to.line];

    // Case 1: The change is within a single line.
    if (from.line == to.line) {
      if (newText.length == 1) {
        // Simple replacement within a single line.
        firstLine.replace(from.ch, to.ch, newText[0]);
      } else {
        // Split current line and insert multiple lines
        let lastLine = firstLine.split(to.ch, newText[newText.length - 1]);
        // Prepare arguments for splice.
        let spliceArgs: Line[] = [];

        // Replace the start of the line.
        firstLine.replace(from.ch, firstLine.text?.length!, newText[0]);

        // Insert new lines between first and last
        for (let i = 1; i < newText.length - 1; i++) {
          spliceArgs.push(new Line(newText[i]));
        }
        // Add the split last line
        spliceArgs.push(lastLine);

        // Update the lines array
        this.lines.splice.apply(this.lines, [
          from.line + 1,
          nLines,
          ...spliceArgs,
        ]);
      }
    }
    // Case 2: Multiple lines replaced with single line (i.e The change spans multiple lines, but only one new line is inserted.)
    else if (newText.length == 1) {
      // Join first line's start with last last line's end
      firstLine.replace(
        from.ch,
        firstLine.text?.length!,
        newText[0] + lastLine.text?.slice(to.ch)
      );

      // Remove the lines in between
      this.lines.splice(from.line + 1, nLines);
    }
    // Case 3: Multiple lines replaced with mutliple lines
    else {
      let spliceArgs: Line[] = [];
      // Update the fist and last lines
      firstLine.replace(from.ch, firstLine.text?.length!, newText[0]);
      lastLine.replace(0, to.ch, newText[newText.length - 1]);

      // Insert new lines in between
      for (let i = 1; i < newText.length - 1; i++) {
        spliceArgs.push(new Line(newText[i]));
      }

      this.lines.splice.apply(this.lines, [
        from.line + 1,
        nLines - 1,
        ...spliceArgs,
      ]);
    }

    // Update work queue for syntax highlighting
    let newWork = [];
    let lenDiff = newText.length - nLines - 1;

    for (let i = 0; i < this.work.length; i++) {
      let task = this.work[i];
      if (task < from.line) {
        newWork.push(task);
      } else if (task > to.line) {
        newWork.push(task + lenDiff);
      }
    }

    // Add modified line to work queue
    if (newText.length) newWork.push(from.line);
    this.work = newWork;

    // Schedule syntax highlighting
    this.startWorker(100);

    // Record changes for undo/redo
    this.changes.push({ from: from.line, to: to.line + 1, diff: lenDiff });
    this.textChanged = true;

    // Helper to update line numbers after changes
    function updateLine(n: number) {
      return n <= Math.min(to.line, to.line + lenDiff) ? n : n + lenDiff;
    }

    // Update display state
    // this.showingFrom = updateLine(this.showingFrom);
    // this.showingTo = updateLine(this.showingTo);

    // Update selection state
    this.setSelection(
      selFrom,
      selTo,
      updateLine(this.selection.from.line),
      updateLine(this.selection.to.line)
    );

    (this.space as HTMLElement).style.height =
      this.lines.length * this.lineHeight() + "px";
  }

  /**
   * Toggles the visibility and state of line numbers in the editor. This function is
   * responsible for creating or removing the line number DOM element based on the desired
   * state and udpating the editor's options.
   *
   * @param on - A boolean value indicating the desired state of line numbers.
   */
  setLineNumbers(on: boolean) {
    this.options.lineNumbers = on;
    this.gutter.style.display = on ? "" : "none";
    if (on) this.updateGutter();
  }

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
      this.updateLines(
        {
          line: change.start,
          ch: 0,
        },
        { line: end - 1, ch: this.lines[end - 1].text?.length! },
        change.old,
        pos,
        pos
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
      this.updateInput = true;
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
      } else if (
        (ctrl && event.shiftKey && key === "z") ||
        (ctrl && key === "y")
      ) {
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
      const range = this.selRange(this.input);
      if (range) {
        this.reducedSelection = { anchor: range.start };
        this.setSelRange(this.input, range.start, range.start);
      }
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

  selRange(te: HTMLTextAreaElement) {
    return { start: te.selectionStart, end: te.selectionEnd };
  }

  setSelRange(te: HTMLTextAreaElement, start: number, end: number) {
    te.setSelectionRange(start, end);
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
    let sr = this.selRange(this.input);

    // Check if the text or selection range has changed.
    changed = ed.text != text;
    let rs = this.reducedSelection;

    // Determine if cursor/selection has moved or text has changed. This considers both text changes and selection changes.
    const moved =
      changed || sr.start != ed.start || sr.end != (rs ? ed.start : ed.end);

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
        if (
          found == -1 ||
          (text.charAt(found - 1) == "\r" ? found - 1 : found >= n)
        ) {
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
    let from = computeOffset(sr.start, ed.from);
    let to = computeOffset(sr.end, ed.from);

    // Handle reduced selection cases
    if (rs) {
      // Adjust selection boundaries based on anchor point and shift selection state
      from = sr.start == rs.anchor ? to : from;
      to = this.shiftSelecting ? sel.to : sr.start == rs.anchor ? from : to;

      // Ensure 'from' position is before than 'to' position
      if (!positionLess(from, to)) {
        // If positions are reveresed, clear reduced selection and swap them.
        this.reducedSelection = null;
        let temp = from;
        from = to;
        to = temp;
      }
    }

    // Skip uupdateInput is selection is in same line.
    if (
      from.line == to.line &&
      from.line == this.selection.from.line &&
      from.line == this.selection.to.line
    ) {
      this.updateInput = false;
    }

    // If the text has changed, update the editor's content.
    if (changed) {
      let start = 0;
      let end = text.length;
      let len = Math.min(end, this.editing.text.length);
      let char: string;
      let line = this.editing.from;
      let newLine = -1;

      // Find common prefix
      // Compare characters from start until we find a difference
      while (
        start < len &&
        (char = text.charAt(start)) == this.editing.text.charAt(start)
      ) {
        start++;

        // Track line numbers when encountering new lines
        if (char == "\n") {
          line++;
          newLine = start;
        }
      }

      // Calculate the character where change begins. If we found newlines, measure from last newline
      // Otherwise measure from start of text.
      let ch = newLine > -1 ? start - newLine : start;
      let endLine = this.editing.to - 1;

      // Find common suffix by working backwards
      // Compare characters from end until we find a difference
      let edEnd = this.editing.text.length;

      // Continue while we have'nt hit the start and characters match
      while (true) {
        const c = this.editing.text.charAt(edEnd);

        // Adjust line count upon new lines
        if (c === "\n") {
          endLine--;
        }

        if (text.charAt(end) !== c) {
          end++;
          edEnd++;
          break;
        }

        if (edEnd <= start || end <= start) {
          break;
        }

        edEnd--;
        end--;
      }

      // Calculate final ending position
      // Find last newline in the changed region
      newLine = this.editing.text.lastIndexOf("\n", edEnd - 1);
      let endCh = newLine == -1 ? edEnd : edEnd - newLine - 1;

      // Update the text content with the identified change boundaries
      this.replaceLines(
        { line: line, ch: ch },
        { line: endLine, ch: endCh },
        text.slice(start, end),
        from,
        to
      );

      this.shiftSelecting = null;

      // Handle input state
      // Force input state if:
      // - Multiple lines were changed
      // - Change started on different line than selection
      if (line != endLine || from.line != line) {
        this.updateInput = true;
      }
    } else {
      // Update the selection based on new start and end positions.
      this.setSelection(from, to);
    }

    ed.text = text;
    ed.start = sr.start;
    ed.end = sr.end;

    return changed ? "changed" : moved ? "moved" : false;
  }

  /**
   * Ensures the cursor is visible in the editor viewporr if necessary.
   *
   * This method adjusts both vertical and horizontal scroll positions to make the cursor visible,
   * maintaining a small padding around the cursor for better visibility.
   *
   * This method performs the following steps:
   * 1. Gets cursor coordinates relative to the editor space
   * 2. Adjusts vertical scroll if cursor is above or below viewport
   * 3. Adjusts horizontal scroll if cursor is left or right of viewport
   */
  scrollCursorIntoView() {
    // Get cursor coordinates relative to the editor space
    let cursor = this.localCursorCoords(this.selection.inverted!);
    // Adjust coordinates to account for the editor's position in the document
    cursor.x += (this.space as HTMLElement).offsetLeft;
    cursor.y += (this.space as HTMLElement).offsetTop;

    // Get current viewport height and scroll position
    let screen = this.code.clientHeight;
    let screenTop = this.code.scrollTop;

    // Vertical scrolling adjustment
    if (cursor.y < screenTop) {
      // If cursor is above viewport, scroll up
      // Add 10px padding above cursor for better visibility
      this.code.scrollTop = Math.max(0, cursor.y - 10);
    } else if ((cursor.y += this.lineHeight()) > screenTop + screen) {
      // If cursor is below viewport, scroll down
      // Add 10px padding below cursor for better visibility
      this.code.scrollTop = cursor.y + 10 - screen;
    }

    // Get current viewport width and horizontal scroll position
    let screenWidth = (this.space as HTMLElement).offsetWidth;
    let screenLeft = this.code.scrollLeft;

    // Horizontal scrolling adjustment
    if (cursor.x < screenLeft) {
      // If cursor is left of viewport, scroll left
      // Add 10px
      this.code.scrollLeft = Math.max(0, cursor.x - 10);
    } else if (cursor.x > screenWidth + screenLeft) {
      // If cursor is right of viewport, scroll right
      this.code.scrollLeft = cursor.x + 10 - screenWidth;
    }
  }

  /**
   * Updates the editor's display to reflect changes in the document content and viewport position.
   * This method is responsible for efficiently updating only the necessary parts of the display by tracking
   * changes and maintaining a list of intact (unchanged) regions.
   *
   * The method performs these key steps:
   * 1. Calculates visible line range based on scroll position
   * 2. Tracks intact (unchanged) regions of text
   * 3. Processes changes to determine which display regions need updating
   * 4. Either patches specific regions or refreshes entire display based on change magnitude.
   *
   * @param changes - Optional array of change objects describing modifications to the document.
   *                - from: Starting line number of the change
   *                - to: Ending line number of the change
   *                - diff: Line count difference after the change
   */
  updateDisplay(changes?: { from: number; to: number; diff?: number }[]) {
    if (!this.code.clientWidth) return;
    // Get line height and calculate visible line range
    let lh = this.lineHeight();

    // Calculate first visible line based on scroll position
    let top = this.code.scrollTop - (this.space as HTMLElement).offsetTop;
    let visibleFrom = Math.max(0, Math.floor(top / lh));

    // Calculate last visible line based on viewport height
    let visibleTo = Math.floor(
      Math.min(this.lines.length, (top + this.div.clientHeight) / lh)
    );

    // Initialize intact regions with current display range
    let intact = [{ from: this.showingFrom, to: this.showingTo, at: 0 }];

    // Process each change and update intact regions
    for (let i = 0, l = changes ? changes.length : 0; i < l; i++) {
      let change = changes![i];
      let intact2 = [];
      let diff = change.diff || 0;

      // Adjust intact regions based on each change
      for (let j = 0; j < intact.length; j++) {
        let range = intact[j];

        if (change.to <= range.from) {
          // Change is before the range - shift range
          intact2.push({
            from: range.from + diff,
            to: range.to + diff,
            at: range.at,
          });
        } else if (range.to <= change.from) {
          // Change is after this range, keep range as is
          intact2.push(range);
        } else {
          // Change overlaps this range - Split if necessary
          if (change.from > range.from) {
            // Preserve unchanged prefix
            intact2.push({
              from: range.from,
              to: change.from,
              at: range.at,
            });
          }

          if (change.to < range.to) {
            // Preserve unchange suffix
            intact2.push({
              from: change.to + diff,
              to: range.to + diff,
              at: range.at + (change.to - range.from),
            });
          }
        }
      }

      intact = intact2;
    }

    // Calculate display update range with padding
    let from = Math.min(this.showingFrom, Math.max(visibleFrom - 3, 0));
    let to = Math.floor(
      Math.min(this.lines.length, Math.max(this.showingTo, visibleTo + 3))
    );

    // Track display updates and position
    let updates = [];
    let pos = from;
    let at = from - this.showingFrom;
    let changedLines = 0;
    let added = 0;

    // Handle initial gap if exists
    if (at > 0) {
      updates.push({ from: pos, to: pos, size: at, at: 0 });
      added -= at;
    } else if (at < 0) {
      at = 0;
      pos -= at;
    }

    // Process intact regions to build the list of required display updates.
    // This loop indentifies gaps b/w intact regions that need to be updated
    // and tracks position information for proper rendering.
    for (let i = 0; i < intact.length; i++) {
      let range = intact[i];

      // Skip if this intact region ends before out current position. This prevents processing regions that are
      // completely before our update range.
      if (range.to <= pos) continue;

      // Exit loop if we've reached an intact region that starts after our target end.
      if (range.from >= to) break;

      // If there's a gap b/w current position and start of this intact region
      // we need to create an update record for this gap
      if (range.from > pos) {
        // Calculate size of the gap in the display
        let size = range.at - at;

        updates.push({
          from: pos,
          to: range.from,
          size: size,
          at: at,
        });
        changedLines += Math.floor(range.from - pos);
        added += Math.floor(range.from - pos) - size;
      }

      pos = range.to;

      // Update display position: This calculates where we should be in the display after this intact region
      at = range.at + (range.to - range.from);
    }

    // Handle final gap if exists
    if (pos < to) {
      let size = Math.floor(Math.max(0, this.showingTo + added - pos));

      changedLines += to - pos;
      updates.push({
        from: Math.floor(pos),
        to: to,
        size: size,
        at: Math.floor(at),
      });
    }

    if (!updates.length) return;

    // Choose between patch and refresh based on change magnitude
    if (changedLines > (visibleTo - visibleFrom) * 0.3) {
      // If many lines changed, refresh entire display
      this.refreshDisplay(visibleFrom, visibleTo);
    } else {
      // If few lines changed, patch specific regions
      this.patchDisplay(updates, from, to);
    }
  }

  /**
   * Completely refreshes the editor's display by rebuilding the visible content.
   *
   * This method is called when significant changes require a full display update, typically when the number
   * of changed lines exceeds a threshold.
   *
   * The method performs these key steps:
   * 1. Expands the update range with padding for smooth scrolling
   * 2. Builds HTML for visible lines with propern selection highlighting
   * 3. Updates the display's position and content
   * 4. Updates internal display tracking state
   *
   * @param from - The starting line number to refresh (0-based)
   * @param to - The ending line number to refresh
   */
  refreshDisplay(from: number, to: number) {
    // Add padding (10 lines) above and below the visible range for smooth scrolling
    from = Math.max(from - 10, 0);
    to = Math.min(to + 10, this.lines.length);

    let html = []; // Stores HTML fragments for each line
    let start = { line: from, ch: 0 }; // Starting position for selection handling

    // Determine if we're starting within a selection
    // True if selection starts before visible range and ends after visible range start
    let inSel =
      positionLess(this.selection.from, start) &&
      !positionLess(this.selection.to, start);

    // Iterate through each visible line
    for (let i = from; i < to; i++) {
      let ch1 = null; // Selection start character
      let ch2 = null; // Selection end character

      // Handle selection rendering for current line
      if (inSel) {
        // Line is fully selected from start
        ch1 = 0;
        if (this.selection.to.line == i) {
          // Selection ends on this line
          inSel = false;
          ch2 = this.selection.to.ch;
        }
      } else if (this.selection.from.line == i) {
        if (this.selection.to.line == i) {
          // Selectiom starts and ends on this line
          ch1 = this.selection.from.ch;
          ch2 = this.selection.to.ch;
        } else {
          // Selection starts on this line and continues
          inSel = true;
          ch1 = this.selection.from.ch;
        }
      }

      // Generate HTML for th eline with proper selection highlighting
      html.push(
        "<div>",
        this.lines[i].getHTML(ch1 as number, ch2 as number),
        "</div>"
      );
    }

    // Update the visible content with generated HTML
    this.lineDiv.innerHTML = html.join("");

    // Update internal display state tracking
    this.showingFrom = from;
    this.showingTo = to;

    // Position the visible content relative to editor viewport
    this.mover.style.top = from * this.lineHeight() + "px";
    // this.gutter.style.top = from * this.lineHeight() + "px";

    this.updateGutter();
  }

  /**
   * Efficiently updates specific regions of the editor's display without refreshing the entire view.
   * This method performs targeted updates to the display by patching only the modified regions, making
   * it more efficient than a full refresh when changes are small.
   *
   * This method handles:
   * 1. Adding or removing DOM nodes for line changes
   * 2. Updating line content with proper selection highlighting
   * 3. Adjusting the display position and state tracking
   *
   * @param updates - Array of update objects describing regions to patch
   * @param from - Starting line number of the overall update range
   * @param to - Ending line number of the overall update range
   */
  patchDisplay(
    updates: { from: number; to: number; size: number; at: number }[],
    from: number,
    to: number
  ) {
    // Track selection line boundaries for highlighting
    let sfrom = this.selection.from.line;
    let sto = this.selection.to.line;
    let off = 0; // tracker for node positioning

    // Process each update region
    for (let i = 0; i < updates.length; i++) {
      let rec = updates[i];

      // Calculate the diff in size b/w old and new content
      // prettier-ignore
      let extra = (rec.to - rec.from) - rec.size;

      if (extra) {
        // Get reference node for insertion/deletion
        let nodeAfter =
          this.lineDiv.childNodes[rec.at + off + rec.size] || null;

        // Remove nodes if region shrank
        for (let j = Math.max(0, -extra); j > 0; j--) {
          this.lineDiv.removeChild(
            nodeAfter ? nodeAfter.previousSibling! : this.lineDiv.lastChild!
          );
        }

        // Add nodes if region grew
        for (let j = Math.max(0, extra); j > 0; j--) {
          this.lineDiv.insertBefore(document.createElement("div"), nodeAfter!);
        }
      }

      // Get starting node for content updates
      let node = this.lineDiv.childNodes[rec.at + off];
      // Track if we're within selection
      let inSel = sfrom < rec.from && sto >= rec.from;

      // Update content of each line in the region
      for (let j = rec.from; j < rec.to; j++) {
        let ch1 = null;
        let ch2 = null;

        // Handle selection rendering
        if (inSel) {
          ch1 = 0;
          if (sto == j) {
            // Selection ends on this line

            inSel = false;
            ch2 = this.selection.to.ch;
          }
        } else if (sfrom == j) {
          // Selection starts on this line
          if (sto == j) {
            // Selection starts and end on this line
            ch1 = this.selection.from.ch;
            ch2 = this.selection.to.ch;
          } else {
            // Selection starts here and continues
            inSel = true;
            ch1 = this.selection.from.ch;
          }
        }

        // Update node content with highlighted HTML
        (node as HTMLElement).innerHTML = this.lines[j].getHTML(ch1!, ch2!);
        node = node.nextSibling!;
      }
      off += extra;
    }

    // Update display state tracking and visible content position
    this.showingFrom = from;
    this.showingTo = to;

    this.mover.style.top = from * this.lineHeight() + "px";
    if (off) {
      this.updateGutter();
    }
  }

  updateGutter() {
    if (this.gutter.style.display == "none") return;

    // this.gutter.style.height =
    //   Math.max(
    //     this.lineDiv.offsetHeight,
    //     this.code.clientHeight - 2 * (this.space as HTMLElement).offsetTop
    //   ) + "px";

    let html = [];

    if (this.options.lineNumbers) {
      for (let i = this.showingFrom; i < this.showingTo; i++) {
        html.push("<div>" + (i + 1) + "</div>");
      }

      this.gutter.innerHTML = html.join("");

      (this.lineDiv.parentNode as HTMLElement).style.marginLeft =
        this.gutter.offsetWidth + "px";
    }
  }

  restartBlink() {
    clearInterval(this.blinker as number);
    let on = true;
    this.cursor.style.display = "";
    this.blinker = setInterval(() => {
      this.cursor.style.display = (on = !on) ? "" : "none";
    }, 650);
  }

  /**
   * Calculates the cursor position in the editor based on mouse coordinates.
   * This method converts screen coordinates from a mouse event into document coordinates
   * (line and character) within the editor.
   * @param e - Custom mouse event
   * @returns
   */
  posFromMouse(e: AsEvent) {
    // Get editor line element's offset from document edge
    let off = eltOffset(this.lineDiv as HTMLElement);

    // Calculate coordinates relative to editor space
    let x = (e.e as MouseEvent).pageX - off.left;
    let y = (e.e as MouseEvent).pageY - off.top;

    // If click was on code element and above last line, return null
    if (e.target() == this.code && y < this.lines.length * this.lineHeight()) {
      return null;
    }

    // Convert vertical position to line number
    let line = this.showingFrom + Math.floor(y / this.lineHeight());
    let clipLine = Math.min(Math.max(0, line), this.lines.length - 1);

    // Convert position to editor coordinates and ensure it's within bounds
    return this.clipPosition({
      line: line,
      ch: this.charFromX(clipLine, x),
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
      x: this.charX(head.line, head.ch),
      y: head.line * this.lineHeight(),
    };
  }

  /**
   * Updates the cursor's visual position and visibility in the editor.
   * This method handles both the cursor positioning for a single cursor and cursor
   * visibility when there's a text selection
   */
  updateCursor() {
    let head = this.selection.inverted
      ? this.selection.from
      : this.selection.to;
    let x = this.charX(head.line, head.ch) + "px";
    let y = (head.line - this.showingFrom) * this.lineHeight() + "px";

    this.inputDiv.style.top = y;
    this.inputDiv.style.left = x;

    // If selection start and end are the same
    if (positionEqual(this.selection.from, this.selection.to)) {
      this.cursor.style.top = y;
      this.cursor.style.left = x;
    } else {
      // Hide cursor when there's a selection range
      this.cursor.style.display = "none";
    }
  }

  /**
   * Calculates the horizontal pixel position for a given character position in a line.
   * @param line - The line number in the editor.
   * @param pos - The character position within the line.
   */
  charX(line: number, pos: number) {
    let text = this.lines[line].text;

    // If no tabs in text before pos, multiply by char width.
    if (text?.lastIndexOf("\t", pos) == -1) {
      return pos * this.charWidth();
    }

    // Text contains tabs, need to measure precisely
    try {
      // Set the measurement span's content to text up to pos
      this.measure.firstChild!.firstChild!.nodeValue = text?.slice(
        0,
        pos
      ) as string;

      // Return actual width of text segment
      return (this.measure.firstChild as HTMLElement).offsetWidth;
    } finally {
      // Always restore measurement span to default state
      this.measure.firstChild!.firstChild!.nodeValue = "-";
    }
  }

  /**
   * Converts a horizontal pixel position to a character position within a line.
   * @param line - The line number in the editor.
   * @param x - The horizontal pixel position.
   */
  charFromX(line: number, x: number) {
    let text = this.lines[line].text;
    let cw = this.charWidth();

    // If no tabs, divide x by char width
    if (text?.indexOf("\t") == -1) {
      return Math.min(text.length, Math.round(x / cw));
    }

    let mspan = this.measure.firstChild;
    let mtext = mspan?.firstChild;

    try {
      let from = 0;
      let to = text?.length!;

      // Binary search to find character position
      while (true) {
        // If search range is 1 or less, we found our position
        if (to - from <= 1) return from;

        let middle = Math.ceil((from + to) / 2);
        mtext!.nodeValue = text?.slice(0, middle) as string;

        if ((mspan as HTMLElement).offsetWidth > x) {
          to = middle;
        } else {
          from = middle;
        }
      }
    } finally {
      mtext!.nodeValue = "-";
    }
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

    if (positionEqual(from, to)) {
      if (!positionEqual(sel.from, sel.to)) {
        this.changes.push({ from: oldFrom, to: oldTo! + 1 });
      }
    } else if (positionEqual(sel.from, sel.to)) {
      this.changes.push({ from: from.line, to: to.line + 1 });
    } else {
      if (!positionEqual(from, sel.from)) {
        if (from.line < oldFrom) {
          this.changes.push({
            from: from.line,
            to: Math.min(to.line, oldFrom) + 1,
          });
        } else {
          this.changes.push({
            from: oldFrom,
            to: Math.min(oldTo!, from.line) + 1,
          });
        }
      }
    }

    if (!positionEqual(to, sel.to)) {
      if (to.line < oldTo!) {
        this.changes.push({
          from: Math.max(oldFrom, from.line),
          to: oldTo! + 1,
        });
      } else {
        this.changes.push({
          from: Math.max(from.line, oldTo!),
          to: to.line + 1,
        });
      }
    }

    // Update the selection range
    sel.from = from;
    sel.to = to;
    this.selectionChanged = true;
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
  ) {
    let newLine = code.indexOf("\n"); // Find the first newline in the replacement text.
    let nls = 0; // Counts number of newLines in the replacement text.

    let i = code.indexOf("\n", newLine + 1);
    // Count all newlines in the replacement text
    while (i !== -1) {
      nls++;
      newLine = i;
      i = code.indexOf("\n", i + 1);
    }

    // Calculate the length of the last line. If no newLines Found, use entire code length
    // Otherwise, use remaining characters after last newline
    let endCh = newLine == -1 ? code.length : code.length - newLine - 1;

    // Calculate the difference in number of lines
    // Original lines: (to.line - from.line + 1)
    // NewLines: nls + 1
    let diff = to.line - from.line + 1 - nls;

    // Compute new selection range after replacement
    // Passes an object with the end position after replacement
    let newSel = computeSelection({
      line: to.line + diff, // Adjust line number based on line difference
      ch: endCh, // Use calculated end character position
    });

    // Perform the actual text replacement
    // Updates the editor content and selection
    this.replaceLines(from, to, code, newSel.from, newSel.to);
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
      this.replaceLines(
        { line: n, ch: 0 },
        { line: n, ch: 0 },
        space,
        from,
        to
      );
    } else {
      // If the difference is negative, it means the line has too much indentation.

      // Remove the extra spaces from the beginning of the line.
      this.replaceLines(
        { line: n, ch: 0 },
        { line: n, ch: -diff },
        "",
        from,
        to
      );
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
    let task: number;

    // Loop through the work queue
    while (this.work.length) {
      // Determine which line to process next
      if (!this.lines[this.showingFrom].stateAfter) {
        // If first visible line needs highlighting prioritize it
        task = this.showingFrom;
      } else {
        // Otherwise take next line from work queue
        task = this.work.pop() as number;
      }

      // Skip lines that have already been highlighted
      if (task >= this.lines.length || this.lines[task].stateAfter) continue;

      let i = task;

      // Find the most recent valid state to start from
      // Look back up to 50 lines to find a cached state
      let state: any;
      for (let i = task - 1; i >= Math.max(0, task - 50) && !state; i--) {
        state = this.lines[i].stateAfter;
      }

      // Create new state if none found
      if (state) {
        state = copyState(state);
      } else {
        // Start with the initial parser state
        state = this.parser.startState(this.options);
      }

      // Process lines until we run out of time or hit end of document.
      for (i = task; i < this.lines.length; i++) {
        const line = this.lines[i];

        if (line.stateAfter) break;

        // If the time limit has been reached, reschedule the remaining
        if (Number(new Date()) > end) {
          this.work.push(i);
          this.startWorker(this.options.workDelay);
          break;
        }

        // Highlight the current line and update its state
        line.highlight(this.parser, state);
        line.stateAfter = copyState(state);
      }

      this.changes.push({ from: task, to: i });
    }
  }

  /**
   * Helper function to handle text marking operations in the editor.
   * Used internally by both markText() and unmarkText() methods.
   *
   * Handles both single-line and multi-line text marking operations.
   * Clips positions to ensure they are within document boundaries.
   * Records changes for display updating.
   *
   * @param from - Starting position with line and character offset
   * @param to - Ending position with line and character offset
   * @param func - The marking function to apply (either addMark or removeMark)
   * @param className - CSS class name to be applied to the marked text
   */
  markHelper(from: Position, to: Position, func: Function, className: string) {
    // Ensure positions are valid by clipping them to document boundaries
    from = this.clipPosition(from);
    to = this.clipPosition(to);

    // If marking is within a single line
    if (from.line == to.line) {
      // Apply the marking function directly with start and end character positions
      func.call(this.lines[from.line], from.ch, to.ch, className);
    }
    // If marking spans multiple spans
    else {
      // Mark the first line from start position to end of line
      func.call(this.lines[from.line], from.ch, null, className);

      // Mark all complete lines in between from and to positions
      for (let i = from.line + 1; i < to.line; i++) {
        func.call(this.lines[i], 0, null, className);
      }

      // Mark the last line from start to end position
      func.call(this.lines[to.line], 0, to.ch, className);
    }

    // Record the change for updating display
    this.changes.push({ from: from.line, to: to.line + 1 });
  }

  // Start the background highlighting worker
  startWorker(time: number) {
    if (!this.work.length) return;
    this.highlight.set(time, this.operation(this.highlightWorker));
  }

  markText(from: Position, to: Position, className: string) {
    this.markHelper(from, to, Line.prototype.addMark, className);
  }

  unmarkText(from: Position, to: Position, className: string) {
    this.markHelper(from, to, Line.prototype.removeMark, className);
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
    this.updateInput = null;
    this.changes = [];
    this.textChanged = false;
    this.selectionChanged = false;
  }

  /**
   * Finalizes an operation and updates the UI if necessary. This function compares the previous selection with the
   * current selection to determine if the selection has changed. If it has, it updates the display and restarts the
   * cursor blink. It also prepares the input if the selection spans multiple lines or if lines have been shifted.
   */
  endOperation() {
    if (this.selectionChanged) {
      // If the selection has changed, update the display to reflect the new selection.
      this.scrollCursorIntoView();
    }

    if (this.changes.length) this.updateDisplay(this.changes);

    if (this.changes.length) {
      this.updateCursor();
      this.restartBlink();
    }

    // Check if the selection spans multiple lines or if lines have been shifted.
    if (
      this.updateInput === true ||
      (this.updateInput !== false && this.selectionChanged)
    ) {
      setTimeout(() => this.prepareInputArea(), 20);
    }

    if (this.selectionChanged && this.options.onCursorActivity) {
      this.options.onCursorActivity(AscendEditor);
    }
    if (this.textChanged && this.options.onChange) {
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
      let result;
      try {
        // Prepare for the operation.
        // Apply the original function "f" to the current context "self" with the provided arguments.
        result = f.apply(self, arguments);
      } finally {
        nestedOperation--;
        // End operation only when exiting the outermost call
        if (nestedOperation === 0) {
          // Finalize the operation.
          self.endOperation();
        }
      }

      return result;
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

      refresh: () => this.updateDisplay([{ from: 0, to: this.lines.length }]),

      markText: this.operation(this.markText),
      unmarkText: this.operation(this.unmarkText),

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
    let nLines = this.lineDiv.childNodes.length;
    if (nLines) {
      return this.lineDiv.offsetHeight / nLines;
    }

    return this.measure.offsetHeight || 1;
  }

  charWidth() {
    return (this.measure.firstChild as HTMLElement)!.offsetWidth || 1;
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
