import type { StringStream } from "../../parsers/stringStream";
import "./index.css";

export const cssParser = (function () {
  let type: string;
  function ret(style: any, tp: string) {
    type = tp;
    return style;
  }

  function tokenBase(stream: StringStream, state: any) {
    const ch = stream.next();

    if (ch == "@") {
      return ret("css-at", ch + stream.eatWhile(/\w/));
    } else if (ch == "/" && stream.eat("*")) {
      state.tokenize = tokenCComment;
    } else if (ch == "<" && stream.eat("!")) {
      state.tokenize = tokenSGMLComment;
    } else if (ch == "=") {
      ret(null, "compare");
    } else if ((ch == "~" || ch == "|") && stream.eat("=")) {
      return ret(null, "compare");
    } else if (ch == '"' || ch == "'") {
      state.tokenize = tokenString(ch);
    } else if (ch == "#") {
      while (stream.eat(/\w/)) return ret("css-hash", "hash");
    } else if (ch == "!") {
      stream.match(/^\s*\w*/);
      return ret("css-important", "important");
    } else if (/\d/.test(ch!)) {
      while (stream.eat(/[\w.%]/));
      return ret("css-unit", "unit");
    } else if (/[,.+>*\/]/.test(ch!)) {
      return ret(null, "select-op");
    } else if (/[;{}:\[\]]/.test(ch!)) {
      return ret(null, ch!);
    } else {
      while (stream.eat(/[\w\\\-_]/));
      return ret("css-identifier", "identifier");
    }
  }

  function tokenCComment(stream: StringStream, state: any) {
    let mayBeEnd = false;
    let ch: string | undefined;

    while ((ch = stream.next()) != null) {
      if (mayBeEnd && ch == "/") {
        state.tokenize = tokenBase;
        break;
      }
      mayBeEnd = ch == "*";
    }
    return ret("css-comment", "comment");
  }

  function tokenSGMLComment(stream: StringStream, state: any) {
    let dashes = 0;
    let ch: string | undefined;

    while ((ch = stream.next()) != null) {
      if (dashes >= 2 && ch == ">") {
        state.tokenize = tokenBase;
        break;
      }
      dashes = ch == "-" ? dashes + 1 : 0;
    }
    return ret("css-comment", "comment");
  }

  function tokenString(quote: string) {
    return function (stream: StringStream, state: any) {
      let escaped = false;
      let ch: string | undefined;

      while ((ch = stream.next()) != null) {
        if (ch == quote && !escaped) {
          break;
        }
        escaped = !escaped && ch == "\\";
      }
      if (!escaped) state.tokenize = tokenBase;
      return ret("css-string", "string");
    };
  }

  function startState(basecolumn?: number, indentUnit?: number) {
    return {
      tokenize: tokenBase,
      indentUnit: indentUnit || 2,
      baseIndent: basecolumn || 0,
      inBraces: false,
      inRule: false,
      inDecl: false,
    };
  }

  function indentCss(state: any, textAfter: string): number {
    if (!state.inBraces || /^\}/.test(textAfter)) {
      return state.baseIndent;
    } else if (state.inRule) {
      return state.baseIndent + state.indentUnit * 2;
    } else {
      return state.baseIndent + state.indentUnit;
    }
  }

  function tokenCss(stream: StringStream, state: any) {
    if (stream.eatSpace()) return null;
    let style = state.tokenize(stream, state);

    if (type == "hash") {
      style = state.inRule ? "css-colorcode" : "css-identifier";
    }
    if (style == "css-identifier") {
      if (state.inRule) {
        style = "css-value";
      } else if (!state.inBraces && !state.inDecl) {
        style = "css-selector";
      }
    }

    if (type == "{" && state.inDecl == "@media") {
      state.inDecl = false;
    } else if (type == "{") {
      state.inBraces = true;
    } else if (type == "}") {
      state.inBraces = false;
      state.inRule = false;
      state.inDecl = false;
    } else if (type == ";") {
      state.inRule = false;
      state.inDecl = false;
    } else if (state.inBraces && type != "comment") {
      state.inRule = true;
    } else if (!state.inBraces && style == "css-at") {
      state.inDecl = type;
    }

    return style;
  }

  return {
    startState: startState,
    token: tokenCss,
    indent: indentCss,
  };
})();
