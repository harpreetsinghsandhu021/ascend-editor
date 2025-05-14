export function removeElement(node: Node) {
  if (node.parentNode) node.parentNode.removeChild(node);
}

export function addTextSpan(node: Node, text: string): HTMLSpanElement {
  const span = node.appendChild(document.createElement("span"));
  span.appendChild(document.createTextNode(text));
  return span;
}
