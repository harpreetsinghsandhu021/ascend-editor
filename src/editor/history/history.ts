import type { Change } from "../../interfaces";

/**
 * History class for managing undo/redo in the editor.
 * Tracks changes made to text content and maintains timeline of modifications.
 */
export class History {
  // Timestamp of last recorded change
  public time: number;
  // Stack of completed changes that can be undone
  public done: Change[];
  // Stack of undone changes that can be redone
  public undone: Change[];
  // Time threshold in ms to consider changes as part of the same operation
  private static readonly COALESCE_THRESHOLD = 400;

  constructor() {
    this.time = 0;
    this.done = [];
    this.undone = [];
  }

  /**
   * Adds a new change to the history.
   * @param start - Start position of the change in text.
   * @param added - Number of characters added by the change.
   * @param old - Array containing the old text that was replaced.
   */
  addChange(start: number, added: number, old: string[]) {
    // Clear redoable changes when a new change is made
    this.undone.length = 0;

    let time = +new Date();
    let last: { start: number; added: number; old: string[] } =
      this.done[this.done.length - 1];

    // Determine if this should be a new change entry or merged with previous
    // Creates new entry if:
    // 1. More than 400ms since last change
    // 2. No previous changes exist
    // 3. Changes are not adjacent in the text
    if (
      time - this.time > History.COALESCE_THRESHOLD ||
      !last ||
      last.start > start + added ||
      last.start + last.added < start - last.added + last.old.length
    ) {
      this.done.push({
        start: start,
        added: added,
        old: old,
      });
    }
    // Merge with previous change if they're close enough in time/position
    else {
      let oldOff = 0;

      // Handle case where new change is before previous change
      if (start < last.start) {
        // Prepend old content to previous change
        for (let i = last.start - start - 1; i >= 0; --i) {
          last.old.unshift(old[i]);
        }
        last.added += last.start - start;
        last.start = start;
      }
      // Handle case where new change is after previous change
      else {
        oldOff = start - last.start;
        added += oldOff;
      }

      // Append remaining old content
      for (let i = last.added; i < old.length; i++) {
        last.old.push(old[i]);
      }

      // Update added count if necessary
      if (last.added < added) last.added = added;
    }

    // Update timestamp of last change
    this.time = time;
  }
}
