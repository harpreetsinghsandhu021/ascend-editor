import type { StringStream, TokenizeFn } from "../../parsers/stringStream";

interface KeywordMap {
  [key: string]: { type: string; style: string };
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
    function readOperator() {
      while (stream.eat(isOperatorChar));
      return { type: "operator", style: "js-operator" };
    }

    // stream.eatSpace();

    const ch = stream.next();

    if (ch === '"' || ch === "'") {
      return chain(stream, state, jsTokenString(ch));
    } else if (/[\[\]{}\(\),;\:\.]/.test(ch!)) {
      return { type: ch, style: "js-punctuation" };
    } else if (ch === "0" && stream.eat(/x/i)) {
      while (stream.eat(/[\da-f]/i));
      return { type: "number", style: "js-atom" };
    } else if (/\d/.test(ch!)) {
      stream.match(/^\d*(?:\.\d*)?(?:e[+\-]?\d+)?/);
      return { type: "number", style: "js-atom" };
    } else if (ch === "/") {
      if (stream.eat("*")) {
        return chain(stream, state, jsTokenComment);
      } else if (stream.eat("/")) {
        while (stream.next() != null);
        return { type: "comment", style: "js-comment" };
      } else if (state.reAllowed) {
        nextUntilescaped(stream, "/");
        while (stream.eat(/[gimy]/));
        return { type: "regexp", style: "js-string" };
      } else {
        return readOperator();
      }
    } else if (isOperatorChar.test(ch!)) {
      return readOperator();
    } else {
      const word = ch! + stream.eatWhile(/[\w\$_]/);

      const known = keywords.propertyIsEnumerable(word) && keywords[word];

      return known
        ? { type: known.type, style: known.style, content: word }
        : { type: "variable", style: "js-variable", content: word };
    }
  }

  // Tokenization function for javascript strings
  function jsTokenString(quote: string) {
    return function (stream: StringStream, state: any) {
      if (!nextUntilescaped(stream, quote)) {
        state.tokenize = jsTokenBase;
      }
      return { type: "string", style: "js-string" };
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

    return { type: "comment", style: "js-comment" };
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

  /**
   * The main parsing function that processes tokens and determines syntax highlighting.
   * It orchestrates the parsing process by usign combinators to handle different language constructs.
   */
  function parseJS(
    token: any,
    column: number,
    indent: number | null,
    state: any
  ): string {
    const cc: any[] = state.cc;
    const type = token.type;

    // A utility function to add combinators to the continuation stack.
    function pass(...args: any[]) {
      for (let i = args.length - 1; i >= 0; i--) {
        cc.push(args[i]);
      }
    }

    // An object that holds the current parsing context, with utility functions
    const cx: {
      state: any;
      column: number;
      pass: (...args: any[]) => void;
      cont: (...args: any[]) => boolean;
      register: (varname: string) => void;
      marked: string;
    } = {
      state: state,
      column: column,
      pass: pass,
      // A helper to continue parsing with the given combinators
      cont: function (...args: any[]) {
        pass.apply(null, args);
        return true;
      },
      // Registers a variable within the current scope.
      register: function (varname: string) {
        if (state.context) {
          cx.marked = "js-variabledef";
          state.context.vars[varname] = true;
        }
      },
      marked: "",
    };

    // Checks if a variable is defined in the current or any parent scopes.
    function inScope(varname: string) {
      let cursor: any = state.context;

      while (cursor) {
        if (cursor.vars[varname]) {
          return true;
        }
        cursor = cursor.prev;
      }
    }

    // If an indentation level is provided, set the current indentation.
    if (indent != null) {
      if (!state.lexical.hasOwnProperty("align")) {
        state.lexical.align = false;
      }
      state.indented = indent;
    }

    // Skips whitespace and comments
    if (type == "whitespace" || type == "comment") {
      return token.style;
    }

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
      if (combinator(cx, type)) {
        // After combinator execution, execute any lex functions on the stack.
        while (cc.length && (cc[cc.length - 1] as any).lex) {
          cc.pop()(cx);
        }

        // Returns the style of the marked token, if any.
        if (cx.marked) return cx.marked;
        // Returns the style of a local variable.
        if (type == "variable" && inScope(token.content))
          return "js-localvariable";
        // Returns the style of the token
        return token.style;
      }
    }
  }

  // Combinators

  // Creates a new scope by pusing a context onto the stack.
  function pushContext(cx: any) {
    cx.state.context = {
      prev: cx.state.context,
      vars: { this: true, arguments: true },
    };
  }

  // Removes the current scope by popping the context stack.
  function popContext(cx: any) {
    cx.state.context = cx.state.context.prev;
  }

  // Pushes a new lexical context onto the stack.
  function pushLex(type: string, info?: any) {
    const result = function (cx: any) {
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
  function popLex(cx: any) {
    const state = cx.state;
    if (state.lexical.type == ")") {
      state.indented = state.lexical.indented;
    }
    state.lexical = state.lexical.prev;
  }
  popLex.lex = true;

  // Creates a combinator that expects a specific token type
  function expect(wanted: string) {
    return function expecting(cx: any, type: string) {
      if (type == wanted) {
        return cx.cont();
      } else if (wanted == ";") {
        return;
      } else {
        return cx.cont(expect);
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
  function statement(cx: any, type: string): boolean {
    // Handling variable declarations (e.g, `var x = 10;`)
    if (type == "var") {
      return cx.cont(pushLex("vardef"), vardef1, expect(";"), popLex);
    }
    // Handling keywords that start a block (e.g, `if`, `while`)
    // "keyword a" refers to keywords like `if` or `while` that are followed by an expression and then a statement.
    if (type == "keyword a") {
      return cx.cont(pushLex("form"), expression, statement, popLex);
    }

    // "keyword b" refers to keywords like `do` that are followed by a statement.
    if (type == "keyword b") {
      return cx.cont(pushLex("form"), statement, popLex);
    }

    // Handling blocks of code enclosed in curly braces (e.g, `{ ... }`)
    if (type == "{") {
      return cx.cont(pushLex("}"), block, popLex);
    }

    // Handling empty statements
    if (type == ";") return cx.cont();

    // Handling function definitions(e.g., function myFunc() { ... })
    if (type == "function") return cx.cont(functiondef);

    // Handling `for` loops
    if (type == "for") {
      return cx.cont(
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
      return cx.cont(pushLex("stat"), maybeLabel);
    }

    // Handling switch statements
    if (type == "switch") {
      return cx.cont(
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
      return cx.cont(expression, expect(":"));
    }

    // Handling default in `try...catch, or switch` statements
    if (type == "default") {
      return cx.cont(expect(":"));
    }

    // Handling `catch` clauses in `try...catch` statements
    if (type == "catch") {
      return cx.cont(
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
    return cx.pass(pushLex("stat"), expression, expect(";"), popLex);
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
  function expression(cx: any, type: string) {
    // If the current token type is an atomic type, it signifies the completion of a basic expression unit.
    // The parser then attempt to parse a potential operator following this atomic unit.
    if (atomicTypes.hasOwnProperty(type)) {
      return cx.cont(maybeOperator);
    }

    if (type == "function") {
      return cx.cont(functiondef);
    }

    if (type == "keyword c") {
      return cx.cont(expression);
    }

    if (type == "(") {
      return cx.cont(
        pushLex(")"),
        expression,
        expect(")"),
        popLex,
        maybeOperator
      );
    }

    if (type == "operator") {
      return cx.cont(expression);
    }

    // Handles array literals
    if (type == "[") {
      return cx.cont(
        pushLex("]"),
        commasep(expression, "]"),
        popLex,
        maybeOperator
      );
    }

    // Handles object literals
    if (type == "{") {
      return cx.cont(
        pushLex("}"),
        commasep(objProp, "}"),
        popLex,
        maybeOperator
      );
    }

    return cx.cont();
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
  function maybeOperator(cx: any, type: string, value: string) {
    // Handles increment (++) and (--) operators. These are often postfix or prefix operators that can be followed
    // by another potential operator (e.g, i++ + j). Therefore, after encountering one of these, the parser should
    // continue to look for another operator.
    if (type == "operator" && /\+\+|--/.test(value)) {
      return cx.cont(maybeOperator);
    }

    // For most arithematic operators, they are typically followd by an operand, which is parsed as an expression.
    if (type == "operator") {
      return cx.cont(expression);
    }

    // A semicolon ";" usually marks the end of a statement or expression.
    if (type == ";") return;

    // Handles the case where an opening parenthesis "(" follows what might be an operator
    if (type == "(") {
      return cx.cont(
        pushLex(")"),
        commasep(expression, ")"),
        popLex,
        maybeOperator
      );
    }

    // Handles property access using the dot "." operator (e.g., `object.property`)
    if (type == ".") {
      return cx.cont(property, maybeOperator);
    }

    // Handles array element access using square brackets (e.g., array[index])
    if (type == "[") {
      return cx.cont(
        pushLex("]"),
        expression,
        expect("]"),
        popLex,
        maybeOperator
      );
    }
  }

  // Handles labels in Javascript
  function maybeLabel(cx: any, type: string) {
    if (type == ":") {
      return cx.cont(popLex, statement);
    }
    return cx.pass(maybeOperator, expect(";"), popLex);
  }

  // Marks a property in an object.
  function property(cx: any, type: string) {
    if (type == "variable") {
      cx.marked = "js-property";
      return cx.cont();
    }
  }

  // Parses a property in an object literal.
  function objProp(cx: any, type: string) {
    if (type == "variable") {
      cx.marked = "js-property";
    }

    if (atomicTypes.hasOwnProperty(type)) {
      return cx.cont(expect(":"), expression);
    }
  }

  // Parses a comma-seperated list of expressions.
  function commasep(what: any, end: string) {
    function proceed(cx: any, type: string) {
      if (type == ",") {
        return cx.cont(what, proceed);
      }
      if (type == end) {
        return cx.cont();
      }

      return cx.cont(expect(end));
    }

    return function commaSeperated(cx: any, type: string) {
      if (type == end) return cx.cont();
      else return cx.pass(what, proceed);
    };
  }

  // Parses a block of statements
  function block(cx: any, type: string): boolean {
    if (type == "}") return cx.cont();
    return cx.pass(statement, block);
  }

  // Parses the first part of a variable definition.
  function vardef1(cx: any, type: string, value: string): boolean {
    if (type == "variable") {
      cx.register(value);
      return cx.cont(vardef2);
    }
    return cx.cont();
  }

  // Parses the second part of a variable definition.
  function vardef2(cx: any, type: string, value: string) {
    if (value == "=") return cx.cont(expression, vardef2);
    if (type == ",") return cx.cont(vardef1);
  }

  // Parses the first part of a "for" loop specifier
  function forspec1(cx: any, type: string) {
    if (type == "var") return cx.cont(vardef1, forspec2);
    if (type == ";") return cx.pass(forspec2);
    if (type == "variable") return cx.cont(formaybein);
    return cx.pass(forspec2);
  }

  // Handles the "in" keyword in a "for...in" loop.
  function formaybein(cx: any, type: string, value: string): boolean {
    if (value == "in") return cx.cont(expression);
    return cx.cont(maybeOperator, forspec2);
  }

  // Parses the second part of a "for" loop specifier.
  function forspec2(cx: any, type: String, value: string): boolean {
    if (type == ";") return cx.cont(forspec3);
    if (value == "in") return cx.cont(expression);
    return cx.cont(expression, expect(";"), forspec3);
  }

  // Parses the third part of a "for" loop specifier
  function forspec3(cx: any, type: string) {
    if (type != ")") cx.cont(expression);
  }

  // Parses a function definition.
  function functiondef(cx: any, type: string, value: string) {
    if (type == "variable") {
      cx.register(value);
      return cx.cont(functiondef);
    }
    if (type == "(") {
      return cx.cont(pushContext, commasep(funarguments, ")"));
    }
  }

  // Parses a function argument.
  function funarguments(cx: any, type: string, value: string) {
    if (type == "variable") {
      cx.register(value);
      return cx.cont();
    }
  }

  return {
    startState: startState,
    token: function (stream: StringStream, state: any) {
      let indent: number | null = null;
      if (stream.column() == 0) {
        indent = stream.eatSpace();
      }

      let token = state.tokenize(stream, state);
      stream.eatSpace();
      return parseJS(token, stream.column(), indent, state);
    },
    indent: indentJS,
  };
})();
