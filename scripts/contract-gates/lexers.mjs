const EXTENSION_LANGUAGES = new Map([
  ['rs', 'rust'],
  ['ts', 'script'],
  ['tsx', 'script'],
  ['mts', 'script'],
  ['cts', 'script'],
  ['js', 'script'],
  ['jsx', 'script'],
  ['mjs', 'script'],
  ['cjs', 'script'],
  ['yml', 'yaml'],
  ['yaml', 'yaml'],
  ['toml', 'toml'],
]);

const NEWLINE = 10;
const RAW_STRING_OPEN = /(?:br|cr|r)(#*)"/y;
const WORD = /[\p{L}\p{N}_$]+/uy;
const REGEX_FLAGS = /[A-Za-z]*/y;
const REGEX_PRECEDING_WORDS = new Set([
  'return',
  'typeof',
  'instanceof',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'case',
  'do',
  'else',
  'yield',
  'await',
]);
const VALUE_CLOSERS = new Set([')', ']', '}']);
const URL_TAIL_END = /[\s<>"'`)\]}]/;
const BLOCK_SCALAR_HEADER = /[:-]\s+(?:[&!]\S*\s+)*[|>][+-]?\d?[+-]?\s*$/;
const YAML_KEY_PREFIX = /^\s*(?:-\s+)*/;
const VALUE = { kind: 'value', value: '' };

export const languageOf = path => {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? (EXTENSION_LANGUAGES.get(name.slice(dot + 1).toLowerCase()) ?? null) : null;
};

const createScanner = text => {
  let index = 0;
  let line = 1;
  let lineStart = 0;
  const advance = (count = 1) => {
    const end = Math.min(index + count, text.length);
    for (; index < end; index += 1) {
      if (text.charCodeAt(index) === NEWLINE) {
        line += 1;
        lineStart = index + 1;
      }
    }
  };
  const lineEnd = () => {
    const end = text.indexOf('\n', index);
    return end === -1 ? text.length : end;
  };
  return {
    text,
    advance,
    lineEnd,
    get index() {
      return index;
    },
    get line() {
      return line;
    },
    skipLine: () => advance(lineEnd() - index),
    done: () => index >= text.length,
    at: (offset = 0) => text[index + offset],
    before: () => text[index - 1],
    startsWith: literal => text.startsWith(literal, index),
    isLeading: () => text.slice(lineStart, index).trim() === '',
    match: pattern => {
      pattern.lastIndex = index;
      return pattern.exec(text);
    },
  };
};

const readLineComment = scanner => {
  const start = scanner.index;
  const startLine = scanner.line;
  const leading = scanner.isLeading();
  scanner.skipLine();
  const text = scanner.text.slice(start, scanner.index).trimEnd();
  return { startLine, endLine: startLine, leading, text };
};

const readBlockComment = (scanner, { nested }) => {
  const start = scanner.index;
  const startLine = scanner.line;
  const leading = scanner.isLeading();
  let depth = 1;
  scanner.advance(2);
  while (!scanner.done() && depth > 0) {
    if (nested && scanner.startsWith('/*')) {
      depth += 1;
      scanner.advance(2);
    } else if (scanner.startsWith('*/')) {
      depth -= 1;
      scanner.advance(2);
    } else {
      scanner.advance();
    }
  }
  const text = scanner.text.slice(start, scanner.index);
  return { startLine, endLine: scanner.line, leading, text };
};

const skipMultilineString = scanner => {
  scanner.advance();
  while (!scanner.done()) {
    const char = scanner.at();
    if (char === '\\') {
      scanner.advance(2);
    } else {
      scanner.advance();
      if (char === '"') return;
    }
  }
};

const findClosingQuote = (scanner, quote, { escapes }) => {
  const end = scanner.lineEnd();
  for (let cursor = scanner.index + 1; cursor < end; cursor += 1) {
    const char = scanner.text[cursor];
    if (escapes && char === '\\') cursor += 1;
    else if (char === quote) return cursor;
  }
  return -1;
};

const skipLineString = (scanner, quote, options) => {
  const close = findClosingQuote(scanner, quote, options);
  scanner.advance(close === -1 ? 1 : close + 1 - scanner.index);
};

const skipTripleQuoted = (scanner, quote, { escapes }) => {
  scanner.advance(3);
  while (!scanner.done()) {
    if (escapes && scanner.at() === '\\') {
      scanner.advance(2);
    } else if (scanner.startsWith(quote.repeat(3))) {
      scanner.advance(3);
      return;
    } else {
      scanner.advance();
    }
  }
};

const isIdentifierChar = char => Boolean(char) && /[A-Za-z0-9_]/.test(char);

const skipRawString = scanner => {
  const open = isIdentifierChar(scanner.before()) ? null : scanner.match(RAW_STRING_OPEN);
  if (!open) return false;
  const closing = `"${open[1]}`;
  scanner.advance(open[0].length);
  const close = scanner.text.indexOf(closing, scanner.index);
  const end = close === -1 ? scanner.text.length : close + closing.length;
  scanner.advance(end - scanner.index);
  return true;
};

const skipCharOrLifetime = scanner => {
  const next = scanner.at(1);
  if (next === '\\') {
    const close = scanner.text.indexOf("'", scanner.index + 3);
    const withinLine = close !== -1 && close < scanner.lineEnd();
    scanner.advance(withinLine ? close + 1 - scanner.index : 1);
    return;
  }
  const width = next ? String.fromCodePoint(scanner.text.codePointAt(scanner.index + 1)).length : 0;
  scanner.advance(width > 0 && scanner.at(1 + width) === "'" ? 2 + width : 1);
};

export const findRustComments = text => {
  const scanner = createScanner(text);
  const comments = [];
  while (!scanner.done()) {
    if (scanner.startsWith('//')) {
      comments.push(readLineComment(scanner));
    } else if (scanner.startsWith('/*')) {
      comments.push(readBlockComment(scanner, { nested: true }));
    } else if (scanner.at() === '"') {
      skipMultilineString(scanner);
    } else if (scanner.at() === "'") {
      skipCharOrLifetime(scanner);
    } else if (!skipRawString(scanner)) {
      scanner.advance();
    }
  }
  return comments;
};

const regexMayStart = (previous, before) => {
  if (before === '<') return false;
  if (previous.kind === 'word') return REGEX_PRECEDING_WORDS.has(previous.value);
  if (previous.kind === 'value') return false;
  if (previous.kind === 'punctuation') return !VALUE_CLOSERS.has(previous.value);
  return true;
};

const skipRegex = scanner => {
  let inClass = false;
  scanner.advance();
  while (!scanner.done() && scanner.at() !== '\n') {
    const char = scanner.at();
    if (char === '\\' && scanner.at(1) !== '\n') {
      scanner.advance(2);
      continue;
    }
    scanner.advance();
    if (char === '[') inClass = true;
    else if (char === ']') inClass = false;
    else if (char === '/' && !inClass) break;
  }
  scanner.advance(scanner.match(REGEX_FLAGS)[0].length);
};

const skipUrlTail = scanner => {
  while (!scanner.done() && !URL_TAIL_END.test(scanner.at())) scanner.advance();
};

const skipTemplate = (scanner, comments) => {
  scanner.advance();
  while (!scanner.done()) {
    if (scanner.at() === '\\') {
      scanner.advance(2);
    } else if (scanner.at() === '`') {
      scanner.advance();
      return;
    } else if (scanner.startsWith('${')) {
      scanner.advance(2);
      lexScriptCode(scanner, comments, { untilBrace: true });
    } else {
      scanner.advance();
    }
  }
};

const lexScriptCode = (scanner, comments, { untilBrace }) => {
  let depth = 0;
  let previous = { kind: 'start', value: '' };
  while (!scanner.done()) {
    const char = scanner.at();
    const word = scanner.match(WORD)?.[0];
    if (/\s/.test(char)) {
      scanner.advance();
    } else if (scanner.startsWith('//')) {
      if (scanner.before() === ':') {
        skipUrlTail(scanner);
        previous = VALUE;
      } else {
        comments.push(readLineComment(scanner));
      }
    } else if (scanner.startsWith('/*')) {
      comments.push(readBlockComment(scanner, { nested: false }));
    } else if (char === '/') {
      if (regexMayStart(previous, scanner.before())) {
        skipRegex(scanner);
        previous = VALUE;
      } else {
        scanner.advance();
        previous = { kind: 'punctuation', value: char };
      }
    } else if (char === '"' || char === "'") {
      skipLineString(scanner, char, { escapes: true });
      previous = VALUE;
    } else if (char === '`') {
      skipTemplate(scanner, comments);
      previous = VALUE;
    } else if (word) {
      scanner.advance(word.length);
      previous = { kind: 'word', value: word };
    } else {
      if (char === '{') depth += 1;
      if (char === '}') {
        if (untilBrace && depth === 0) {
          scanner.advance();
          return;
        }
        depth -= 1;
      }
      scanner.advance();
      previous = { kind: 'punctuation', value: char };
    }
  }
};

export const findScriptComments = text => {
  const scanner = createScanner(text);
  const comments = [];
  if (scanner.startsWith('#!')) scanner.skipLine();
  lexScriptCode(scanner, comments, { untilBrace: false });
  return comments;
};

export const findTomlComments = text => {
  const scanner = createScanner(text);
  const comments = [];
  while (!scanner.done()) {
    if (scanner.startsWith('"""')) {
      skipTripleQuoted(scanner, '"', { escapes: true });
    } else if (scanner.startsWith("'''")) {
      skipTripleQuoted(scanner, "'", { escapes: false });
    } else if (scanner.at() === '"') {
      skipLineString(scanner, '"', { escapes: true });
    } else if (scanner.at() === "'") {
      skipLineString(scanner, "'", { escapes: false });
    } else if (scanner.at() === '#') {
      comments.push(readLineComment(scanner));
    } else {
      scanner.advance();
    }
  }
  return comments;
};

const opensYamlScalar = (line, index) => index === 0 || /[\s[{,]/.test(line[index - 1]);

const findYamlTrailingComment = line => {
  let quote = null;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (quote) {
      if (char === '\\' && quote === '"') index += 1;
      else if (char === quote && quote === "'" && line[index + 1] === "'") index += 1;
      else if (char === quote) quote = null;
    } else if ((char === '"' || char === "'") && opensYamlScalar(line, index)) {
      quote = char;
    } else if (char === '#' && (index === 0 || /\s/.test(line[index - 1]))) {
      return index;
    }
  }
  return -1;
};

const yamlBlockParentColumn = code => {
  const header = BLOCK_SCALAR_HEADER.exec(code);
  const keyed = code.slice(0, header.index + 1).includes(':');
  return keyed ? YAML_KEY_PREFIX.exec(code)[0].length : code.length - code.trimStart().length;
};

export const findYamlComments = text => {
  const comments = [];
  let blockParentColumn = null;
  text.split('\n').forEach((raw, offset) => {
    const line = raw.replace(/\r$/, '');
    const content = line.trimStart();
    const column = line.length - content.length;
    const comment = (leading, from) => ({
      startLine: offset + 1,
      endLine: offset + 1,
      leading,
      text: line.slice(from).trimEnd(),
    });
    if (blockParentColumn !== null) {
      if (content === '') return;
      if (column > blockParentColumn) {
        if (content.startsWith('#')) comments.push(comment(true, column));
        return;
      }
      blockParentColumn = null;
    }
    if (content.startsWith('#')) {
      comments.push(comment(true, column));
      return;
    }
    const hash = findYamlTrailingComment(line);
    if (hash !== -1) comments.push(comment(false, hash));
    const code = hash === -1 ? line : line.slice(0, hash);
    if (BLOCK_SCALAR_HEADER.test(code)) blockParentColumn = yamlBlockParentColumn(code);
  });
  return comments;
};
