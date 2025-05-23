import type { StringStream, TokenizeFn } from "../../parsers/stringStream";
import "./index.css";
interface KeywordMap {
  [key: string]: { type: string; style: string };
}

// Scratch variables to store intermediate results and avoid creating multiple objects.
// These variables are reused to pass multiple values b/w function calls.
let type: string;
let content: string;

/**
 * Returns a style value while storing additional information in the type and content vars.
 * @param tp
 * @param style
 * @param cont
 * @returns
 */
function ret(tp: string, style?: any, cont?: string) {
  type = tp;
  content = cont!;
  return style;
}

export const javascriptParser = (function () {
  // Moves the stream until the next unescaped 'end' character
  function nextUntilescaped(stream: StringStream, end: string) {
    let escaped = false;
    let next: string | null;

    while ((next = stream.next() as string) != null) {
      if (next === end && !escaped) {
        return false;
      }

      escaped = !escaped && next === "\\";
    }

    return escaped;
  }

  const keywords: KeywordMap = (function () {
    function kw(type: string) {
      return { type, style: "js-keyword" };
    }

    const A = kw("keyword a");
    const B = kw("keyword b");
    const C = kw("keyword c");

    const operator = kw("operator");
    const atom = { type: "atom", style: "js-atom" };

    return {
      if: A,
      while: A,
      with: A,
      else: B,
      do: B,
      try: B,
      finally: B,
      return: C,
      break: C,
      continue: C,
      new: C,
      delete: C,
      throw: C,
      var: kw("var"),
      let: kw("let"),
      function: kw("function"),
      catch: kw("catch"),
      for: kw("for"),
      switch: kw("switch"),
      case: kw("case"),
      default: kw("default"),
      in: operator,
      typeof: operator,
      instanceof: operator,
      true: atom,
      false: atom,
      null: atom,
      undefined: atom,
      NaN: atom,
      Infinity: atom,
    };
  })();

  const isOperatorChar = /[+\-*&%=<>!?|]/;

  // Chain the tokenize function
  function chain(stream: StringStream, state: any, f: TokenizeFn) {
    state.tokenize = f;
    return f(stream, state);
  }

  // Base tokenization function for javascript
  function jsTokenBase(stream: StringStream, state: any) {
    const ch = stream.next();

    if (ch === '"' || ch === "'") {
      return chain(stream, state, jsTokenString(ch));
    } else if (/[\[\]{}\(\),;\:\.]/.test(ch!)) {
      return ret(ch as string);
    } else if (ch === "0" && stream.eat(/x/i)) {
      while (stream.eat(/[\da-f]/i));
      return ret("number", "js-atom");
    } else if (/\d/.test(ch!)) {
      stream.match(/^\d*(?:\.\d*)?(?:e[+\-]?\d+)?/);
      return ret("number", "js-atom");
    } else if (ch === "/") {
      if (stream.eat("*")) {
        return chain(stream, state, jsTokenComment);
      } else if (stream.eat("/")) {
        while (stream.next() != null);
        return ret("comment", "js-comment");
      } else if (state.reAllowed) {
        nextUntilescaped(stream, "/");
        while (stream.eat(/[gimy]/));
        return ret("regexp", "js-string");
      } else {
        return ret("operator", null, ch + stream.eatWhile(isOperatorChar));
      }
    } else if (isOperatorChar.test(ch!)) {
      return ret("operator", null, ch! + stream.eatWhile(isOperatorChar));
    } else {
      const word = ch! + stream.eatWhile(/[\w\$_]/);

      const known = keywords.propertyIsEnumerable(word) && keywords[word];

      return known
        ? ret(known.type, known.style, word)
        : ret("variable", "js-variable", word);
    }
  }

  // Tokenization function for javascript strings
  function jsTokenString(quote: string) {
    return function (stream: StringStream, state: any) {
      if (!nextUntilescaped(stream, quote)) {
        state.tokenize = jsTokenBase;
      }
      return ret("string", "js-string");
    };
  }

  //   Tokenization function for javascript comments
  function jsTokenComment(stream: StringStream, state: any) {
    let mayBeEnd = false;
    let ch: string | null;

    while ((ch = stream.next()!)) {
      if (ch === "/" && mayBeEnd) {
        state.tokenize = jsTokenBase;
        break;
      }
      mayBeEnd = ch === "*";
    }

    return ret("comment", "js-comment");
  }

  // Atomic types are fundamental lexical elements such as keywords or literal values, which are not further brokern down.
  let atomicTypes = {
    atom: true,
    number: true,
    variable: true,
    string: true,
    regexp: true,
  };

  /**
   * Represents a lexical context (a stack frame) in the Javascript syntax.
   * It tracks the indentation, column position, type of construct, and previous lexical content.
   * Used to manage the context-sensitive nature of Javascr ipt syntax.
   */
  class JSLexical {
    indented: number; // Indentation level for the current lexical context.
    column: number; // The column number within the line
    type: string; // Type of lexical construct (e.g., "block", "form", "stat")
    prev: JSLexical | null; // a ref to previous lexical context in stack
    info: any; // Additional info
    align?: number; // The column to aling the current construct with

    constructor(
      indented: number,
      column: number,
      type: string,
      align: number | null,
      prev: JSLexical | null,
      info: any
    ) {
      this.indented = indented;
      this.column = column;
      this.type = type;
      this.prev = prev;
      this.info = info;
      if (align != null) this.align = align;
    }
  }

  /**
   * Calculates the indentation level for a given line based on the current lexical context.
   * It considers the type of the current construct and the preceding text to determine the correct indentation.
   */
  function indentJS(state: any, textAfter: string): number {
    const firsrChar = textAfter && textAfter.charAt(0);
    const lexical: JSLexical = state.lexical;
    const type = lexical.type;
    const closing = firsrChar == type;
    const iu = state.indentUnit;

    // Adjust indentation for variable definitions.
    if (type == "vardef") {
      return lexical.indented + 4;
    } else if (type == "form" && firsrChar == "{") {
      // Handles indentation within a form construct (e.g, if, while) that starts with a curly brace.
      return lexical.indented + iu;
    } else if (type == "stat" || type == "form") {
      // Increases indentation for statements or form constructs
      return lexical.indented + iu;
    } else if (lexical.info == "switch" && !closing) {
      // Adjusts indentation for switch statements
      return (
        lexical.indented + (/^(?:case|default)\b/.test(textAfter) ? iu : 2 * iu)
      );
    } else if (lexical.align !== undefined) {
      // Uses alignment if specified in the lexical context.
      return lexical.column - (closing ? 1 : 0);
    } else {
      // Default indentation
      return lexical.indented + (closing ? 0 : iu);
    }
  }

  /**
   * Initializes the parser's state at the beginning of a document or a section.
   * It sets up the tokenizer, lexical context, and other necessary properties.
   * @param basecolumn
   * @param indentUnit
   */
  function startState(basecolumn?: number, indentUnit?: number) {
    if (!indentUnit) indentUnit = 2; // Default indent unit

    return {
      tokenize: jsTokenBase, // The function used to tokenize the input.
      reAllowed: true, // Indicates whether regex expressions are allowed.
      cc: [], // Array of continuation functions.
      lexical: new JSLexical(
        (basecolumn || 0) - indentUnit,
        0,
        "block",
        null,
        null,
        null
      ),
      context: null, // Current context for scope tracking.
      indented: 0, // Current indentation level.
      indentUnit: indentUnit, // The unit of indentation (e.g., 2 spaces).
    };
  }

  // Checks if a variable is defined in the current or any parent scopes.
  function inScope(state: any, varname: string) {
    let cursor: any = state.context;

    while (cursor) {
      if (cursor.vars[varname]) {
        return true;
      }
      cursor = cursor.prev;
    }
  }

  // Combinator utilities for parser state management.
  // Context object for combinator utilities
  let cx: {
    state: any;
    column: any;
    marked: any;
    cc: any;
  } = { state: null, column: null, marked: null, cc: null };

  function pass(...args: any[]) {
    for (let i = args.length - 1; i >= 0; i--) {
      cx.cc.push(args[i]);
    }
  }

  // Passes the given arguments to the combinator chain and returns true.
  function cont(...args: any[]) {
    pass.apply(null, args);
    return true;
  }

  // Registers a variable definition in the parser state.
  function register(varname: string) {
    if (cx.state!.context) {
      cx.marked = "js-variabledef";
      cx.state.context.vars[varname] = true;
    }
  }

  /**
   * The main parsing function that processes tokens and determines syntax highlighting.
   * It orchestrates the parsing process by usign combinators to handle different language constructs.
   */
  function parseJS(
    state: any,
    style: any,
    type: string,
    content: string,
    column: any
  ): string {
    const cc: any | null[] = state.cc;

    cx.state = state;
    cx.column = column;
    cx.marked = null;
    cx.cc = cc;

    // Ensure that align is set to true if not already.
    if (!state.lexical.hasOwnProperty("align")) {
      state.lexical.align = true;
    }

    // Process tokens using combinators
    while (true) {
      // Gets the next combinator from the stack. If none, start with either expression or statement
      const combinator = cc.length
        ? cc.pop()
        : state.json
        ? expression
        : statement;

      // Executes the combinator.
      if (combinator(type, content)) {
        // After combinator execution, execute any lex functions on the stack.
        while (cc.length && (cc[cc.length - 1] as any).lex) {
          cc.pop()();
        }

        // Returns the style of the marked token, if any.
        if (cx.marked) return cx.marked;
        // Returns the style of a local variable.
        if (type == "variable" && inScope(state, content)) {
          return "js-localvariable";
        }
        // Returns the style of the token
        return style;
      }
    }
  }

  // Combinators

  // Creates a new scope by pusing a context onto the stack.
  function pushContext() {
    cx.state.context = {
      prev: cx.state.context,
      vars: { this: true, arguments: true },
    };
  }

  // Removes the current scope by popping the context stack.
  function popContext() {
    cx.state.context = cx.state.context.prev;
  }

  // Pushes a new lexical context onto the stack.
  function pushLex(type: string, info?: any) {
    const result = function () {
      const state = cx.state;
      state.lexical = new JSLexical(
        state.indented,
        cx.column,
        type,
        null,
        state.lexical,
        info
      );
    };

    result.lex = true;
    return result;
  }

  // Pops the current lexical context from the stack.
  function popLex() {
    const state = cx.state;
    if (state.lexical.type == ")") {
      state.indented = state.lexical.indented;
    }
    state.lexical = state.lexical.prev;
  }
  popLex.lex = true;

  // Creates a combinator that expects a specific token type
  function expect(wanted: string) {
    return function expecting(type: string) {
      if (type == wanted) {
        return cont();
      } else if (wanted == ";") {
        return;
      } else {
        return cont(expecting);
      }
    };
  }

  /**
   * This function parses a statement in Javascript. Based on the `type`, it determines the kind of statement and proceeds
   * accordingly, using contect continuations (`cx.cont`) to handle the parsing of the rest of the statement. It also handles
   * lexical content management (pushlex, poplex) to keep track of scope.
   * @param cx - Current parser context
   * @param type - type of token encountered
   * @returns
   */
  function statement(type: string): boolean | void {
    // Handling variable declarations (e.g, `var x = 10;`)
    if (type == "var") {
      return cont(pushLex("vardef"), vardef1, expect(";"), popLex);
    }
    // Handling keywords that start a block (e.g, `if`, `while`)
    // "keyword a" refers to keywords like `if` or `while` that are followed by an expression and then a statement.
    if (type == "keyword a") {
      return cont(pushLex("form"), expression, statement, popLex);
    }

    // "keyword b" refers to keywords like `do` that are followed by a statement.
    if (type == "keyword b") {
      return cont(pushLex("form"), statement, popLex);
    }

    // Handling blocks of code enclosed in curly braces (e.g, `{ ... }`)
    if (type == "{") {
      return cont(pushLex("}"), block, popLex);
    }

    // Handling empty statements
    if (type == ";") return cont();

    // Handling function definitions(e.g., function myFunc() { ... })
    if (type == "function") {
      return cont(functiondef);
    }

    // Handling `for` loops
    if (type == "for") {
      return cont(
        pushLex("form"),
        expect("("),
        pushLex(")"),
        forspec1,
        expect(")"),
        popLex,
        statement,
        popLex
      );
    }

    // Handling statements starting with a variable (e.g., `x=10;` or `myLabel:`)
    if (type == "variable") {
      return cont(pushLex("stat"), maybeLabel);
    }

    // Handling switch statements
    if (type == "switch") {
      return cont(
        pushLex("form"),
        expression,
        pushLex("}", "switch"),
        expect("{"),
        block,
        popLex,
        popLex
      );
    }

    // Handling  case clauses within a `switch` statement
    if (type == "case") {
      return cont(expression, expect(":"));
    }

    // Handling default in `try...catch, or switch` statements
    if (type == "default") {
      return cont(expect(":"));
    }

    // Handling `catch` clauses in `try...catch` statements
    if (type == "catch") {
      return cont(
        pushLex("form"),
        pushContext,
        expect("("),
        funarguments,
        expect(")"),
        statement,
        popLex,
        popContext
      );
    }

    // Handling other kind of statements: general expression statements.
    // It pushes a "stat" lexical context, parses an expression, expects a semicolon
    // and then pops the lexical context.cl
    return pass(pushLex("stat"), expression, expect(";"), popLex);
  }

  /**
   * Processes the current token within an expression context and determines the next parsing state.
   *
   * This function analyzes the `type` of the current token encountered by the parser within an expression
   * and dictates the subsequent parsing actions by calling the continuation with appropriate state functions.
   * @param cx - The context object.
   * @param type - The type of the expression.
   * @returns {Object} - The result of the expression evaluation.
   */
  function expression(type: string) {
    // If the current token type is an atomic type, it signifies the completion of a basic expression unit.
    // The parser then attempt to parse a potential operator following this atomic unit.
    if (atomicTypes.hasOwnProperty(type)) {
      return cont(maybeOperator);
    }

    if (type == "function") {
      return cont(functiondef);
    }

    if (type == "keyword c") {
      return cont(expression);
    }

    if (type == "(") {
      return cont(pushLex(")"), expression, expect(")"), popLex, maybeOperator);
    }

    if (type == "operator") {
      return cont(expression);
    }

    // Handles array literals
    if (type == "[") {
      return cont(
        pushLex("]"),
        commasep(expression, "]"),
        popLex,
        maybeOperator
      );
    }

    // Handles object literals
    if (type == "{") {
      return cont(pushLex("}"), commasep(objProp, "}"), popLex, maybeOperator);
    }

    return cont();
  }

  /**
   * Handles the parsing of operators that might appear within an expression.
   *
   * This function is called when the parser encounters a token that could potentially be an operator. It
   * determines the appropriate next parsing state based on the operator type and value, as well as other
   * surrounding tokens.
   * @param cx - The current parser context
   * @param type - The type of the current token
   * @param value - THe actual string value of the current token
   */
  function maybeOperator(type: string, value: string) {
    // Handles increment (++) and (--) operators. These are often postfix or prefix operators that can be followed
    // by another potential operator (e.g, i++ + j). Therefore, after encountering one of these, the parser should
    // continue to look for another operator.
    if (type == "operator" && /\+\+|--/.test(value)) {
      return cont(maybeOperator);
    }

    // For most arithematic operators, they are typically followd by an operand, which is parsed as an expression.
    if (type == "operator") {
      return cont(expression);
    }

    // A semicolon ";" usually marks the end of a statement or expression.
    if (type == ";") return;

    // Handles the case where an opening parenthesis "(" follows what might be an operator
    if (type == "(") {
      return cont(
        pushLex(")"),
        commasep(expression, ")"),
        popLex,
        maybeOperator
      );
    }

    // Handles property access using the dot "." operator (e.g., `object.property`)
    if (type == ".") {
      return cont(property, maybeOperator);
    }

    // Handles array element access using square brackets (e.g., array[index])
    if (type == "[") {
      return cont(pushLex("]"), expression, expect("]"), popLex, maybeOperator);
    }
  }

  // Handles labels in Javascript
  function maybeLabel(type: string) {
    if (type == ":") {
      return cont(popLex, statement);
    }
    return pass(maybeOperator, expect(";"), popLex);
  }

  // Marks a property in an object.
  function property(type: string) {
    if (type == "variable") {
      cx.marked = "js-property";
      return cont();
    }
  }

  // Parses a property in an object literal.
  function objProp(type: string) {
    if (type == "variable") {
      cx.marked = "js-property";
    }

    if (atomicTypes.hasOwnProperty(type)) {
      return cont(expect(":"), expression);
    }
  }

  // Parses a comma-seperated list of expressions.
  function commasep(what: any, end: string) {
    function proceed(type: string) {
      if (type == ",") {
        return cont(what, proceed);
      }
      if (type == end) {
        return cont();
      }

      return cont(expect(end));
    }

    return function commaSeperated(type: string) {
      if (type == end) return cont();
      else return pass(what, proceed);
    };
  }

  // Parses a block of statements
  function block(type: string): boolean | void {
    if (type == "}") return cont();
    return pass(statement, block);
  }

  // Parses the first part of a variable definition.
  function vardef1(type: string, value: string): boolean {
    if (type == "variable") {
      register(value);
      return cont(vardef2);
    }
    return cont();
  }

  // Parses the second part of a variable definition.
  function vardef2(type: string, value: string) {
    if (value == "=") return cont(expression, vardef2);
    if (type == ",") return cont(vardef1);
  }

  // Parses the first part of a "for" loop specifier
  function forspec1(type: string) {
    if (type == "var") return cont(vardef1, forspec2);
    if (type == ";") return pass(forspec2);
    if (type == "variable") return cont(formaybein);
    return pass(forspec2);
  }

  // Handles the "in" keyword in a "for...in" loop.
  function formaybein(type: string, value: string): boolean {
    if (value == "in") return cont(expression);
    return cont(maybeOperator, forspec2);
  }

  // Parses the second part of a "for" loop specifier.
  function forspec2(type: String, value: string): boolean {
    if (type == ";") return cont(forspec3);
    if (value == "in") return cont(expression);
    return cont(expression, expect(";"), forspec3);
  }

  // Parses the third part of a "for" loop specifier
  function forspec3(type: string) {
    if (type != ")") cont(expression);
  }

  // Parses a function definition.
  function functiondef(type: string, value: string) {
    if (type == "variable") {
      register(value);
      return cont(functiondef);
    }
    if (type == "(") {
      return cont(
        pushContext,
        commasep(funarguments, ")"),
        statement,
        popContext
      );
    }
  }

  // Parses a function argument.
  function funarguments(type: string, value: string) {
    if (type == "variable") {
      register(value);
      return cont();
    }
  }

  return {
    startState: startState, // The initial state of the parser.

    // The tokenization function. This function is responsible for breaking the input stream into individual tokens.
    // Params:
    //   - stream: StringStream object
    //   - state: state of the editor
    // Returns:
    //   A token object
    token: function (stream: StringStream, state: any) {
      // Check if we are at the beginning of a line. If so, calculate the indentation level.
      let indent: number | null = null;
      let atStart = stream.column() == 0;
      let spaces = stream.eatSpace();

      if (atStart) {
        if (!state.lexical.hasOwnProperty("align")) {
          state.lexical.align = false;
        }
        state.indented = spaces;
      }
      if (spaces) return null;
      let style = state.tokenize(stream, state);
      if (type == "comment") return style;
      state.reAllowed =
        type == "operator" ||
        type == "keyword c" ||
        type.match(/^[\[{}\(,;:]$/);

      return parseJS(state, style, type, content, stream.column());
    },

    // The indentation function. This function is responsible for calculating the indentation level for a given line of code.
    indent: indentJS,
  };
})();
