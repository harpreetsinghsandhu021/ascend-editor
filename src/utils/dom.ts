export function removeElement(node: Node) {
  if (node.parentNode) node.parentNode.removeChild(node);
}

export function textSpan(text: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.appendChild(document.createTextNode(text));
  return span;
}

/**
 * Splits a text span at a specified character index, effectively dividing the visual representation
 * of text. This is crucial for dynamic text manipulation within the editor, like applying styles or managing
 * selections across a line.
 * @param node - The HTML element containing the text to be split.
 * @param at - The index within the text node where the split should occur.
 */
export function splitSpan(node: HTMLElement, at: number) {
  // Retrieve the text content of the node's first child, which is assumed to be the next node.
  let text = node.firstChild?.nodeValue!;
  // Update the text content of the original node to contain the portion of the text before the split point.
  node.firstChild!.nodeValue = text?.slice(0, at) as string;

  // Create a new textspan containing the portion of the text span after the split point.
  let sp = textSpan(text.slice(at));

  // Insert the new text span into the DOM, immediately after the original node.
  node.parentNode?.insertBefore(sp, node.nextSibling);
}
