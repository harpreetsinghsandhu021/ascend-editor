import { AscendEditor } from "../../main";
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

    stream.eatSpace();

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

  return {
    startState: () => {
      return { tokenize: jsTokenBase, reAllowed: true };
    },
    token: (stream: StringStream, state: any) => {
      return state.tokenize(stream, state).style;
    },
  };
})();
