/**
 * Represents a CSS class management utility. This class provides methods to efficiently add and remove
 * a specific CSS class from HTML elements. It utilizes regular expressions for accurate class matching
 * and avoids unecessary modifications to the `className` property.
 *
 * @param {string} cls - The CSS class name to manage. The class name should not including or trailing whitespace.
 */
class CssClass {
  // Stores the CSS class name with a trailing space, used for efficient addition of the class. The trailing
  // space simplifies the concatenation logic.
  private extra: string;
  // Creates a regular expression to match the specified class name exactly within the className string.
  // The regex expression ensures that only whole class names are matched.
  private find: RegExp;

  constructor(cls: string) {
    this.extra = cls + " ";
    // The "\\b" matches a word boundary and the "\\s*" matches any trailing whitespace.
    this.find = new RegExp("\\b" + cls + "\\b\\s*", "g");
  }

  /**
   * Adds the managed CSS classs to an HTML node. It checks if the class is already present before adding it to prevent redundant changes.
   * @param node - The HTML element to which the class should be added.
   */
  add(node: HTMLElement): void {
    const cls = node.className;

    if (!this.find.test(cls)) {
      node.className = this.extra + cls;
    }
  }

  /**
   * Removes the managed CSS class from an HTML node. It replaces the matched class name using the pre-defined regex.
   * @param node - The HTML element from which the class should be removed.
   */
  remove(node: HTMLElement): void {
    node.className = node.className.replace(this.find, "");
  }
}

export const selCls = new CssClass("ascend-editor-selected");
