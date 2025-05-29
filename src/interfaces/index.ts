export interface Offset {
  left: number;
  top: number;
}

export interface Position {
  line: number;
  ch: number;
}

export interface Line {
  div: HTMLDivElement;
  text: string;
  stateAfter: any;
  selDiv: any;
}

export interface Change {
  start: number;
  added: number;
  old: string;
}

export interface SearchPosition {
  from: Position;
  to: Position;
  match?: RegExpMatchArray;
}
