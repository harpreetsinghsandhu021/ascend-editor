export class Timer {
  private id: number | null;

  constructor() {
    this.id = null;
  }

  set(ms: number, f: () => void) {
    clearTimeout(this.id as number);
    setTimeout(f, ms);
  }
}
