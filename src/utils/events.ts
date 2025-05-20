export function connect(
  node: Node | Window,
  type: string,
  handler: (event: AsEvent) => void,
  disconnect?: boolean
) {
  function wrapHandler(event: Event | MouseEvent) {
    handler(new AsEvent(event));
  }

  if (typeof node.addEventListener === "function") {
    node.addEventListener(type, wrapHandler, false);

    if (disconnect) {
      return function () {
        node.removeEventListener(type, wrapHandler, false);
      };
    }
  }
}

export class AsEvent {
  e: Event | MouseEvent;

  constructor(e: Event | MouseEvent) {
    this.e = e;
  }

  stop() {
    if (this.e.stopPropagation) {
      this.e.stopPropagation();
    }

    this.e.preventDefault();
  }

  target() {
    return this.e.target;
  }

  button() {
    if ((this.e as any).which) {
      return (this.e as any).which;
    }

    if ((this.e as MouseEvent).button & 1) {
      return 1;
    } else if ((this.e as MouseEvent).button & 2) {
      return 3;
    } else if ((this.e as MouseEvent).button & 4) {
      return 2;
    }

    return (this.e as MouseEvent).button;
  }
}
