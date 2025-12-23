class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class Uri {
  constructor(fsPath) {
    this.fsPath = fsPath;
  }
  static file(fsPath) {
    return new Uri(fsPath);
  }
  toString() {
    return this.fsPath;
  }
}

const EndOfLine = { LF: 1, CRLF: 2 };

class Diagnostic {
  constructor(range, message, severity = DiagnosticSeverity.Information) {
    this.range = range;
    this.message = message;
    this.severity = severity;
    this.source = "";
    this.code = undefined;
  }
}

const DiagnosticSeverity = {
  Error: 0,
  Warning: 1,
  Information: 2,
  Hint: 3,
};

const window = {
  createOutputChannel() {
    return {
      appendLine() {},
      dispose() {},
    };
  },
};

const workspace = {
  textDocuments: [],
  getConfiguration() {
    return {
      get(_key, fallback) {
        return fallback ?? undefined;
      },
    };
  },
};

const languages = {
  match() {
    return true;
  },
};

module.exports = {
  Position,
  Range,
  Uri,
  EndOfLine,
  Diagnostic,
  DiagnosticSeverity,
  window,
  workspace,
  languages,
};
