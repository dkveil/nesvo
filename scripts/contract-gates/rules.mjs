import {
  findRustComments,
  findScriptComments,
  findTomlComments,
  findYamlComments,
  languageOf,
} from './lexers.mjs';

const COMMENT_FINDERS = {
  rust: findRustComments,
  script: findScriptComments,
  toml: findTomlComments,
  yaml: findYamlComments,
};

const EXCLUDED_PATH =
  /(?:^|\/)(?:node_modules|target|dist|\.expo|artifacts)\/|(?:^|\/)generated\.ts$/;
const CLI_OR_SCHEMA_DERIVE =
  /\bderive\s*\([^)]*\b(?:Parser|Args|Subcommand|ValueEnum|JsonSchema)\b/;
const TYPE_DECLARATION = /^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|union)\s+\w+/;
const SAFETY_COMMENT = /^\/\/ SAFETY: \S/;
const UNSAFE_KEYWORD = /\bunsafe\b/;
const UNSAFE_REACH_LINES = 3;
const EXCERPT_LENGTH = 100;

const ATTRIBUTION_RULES = [
  { reason: 'co-author trailer', pattern: /^\s*co-authored-by\s*:/i },
  { reason: 'generated-with footer', pattern: /^[^\p{L}\p{N}]*generated\s+(?:with|by)\b/iu },
  { reason: 'session trailer', pattern: /^\s*[a-z][a-z0-9]*-session\s*:/i },
  { reason: 'session link', pattern: /https?:\/\/\S*\/code\/session_/i },
];

const excerptOf = text => text.split('\n')[0].slice(0, EXCERPT_LENGTH);

export const isCheckedPath = path => languageOf(path) !== null && !EXCLUDED_PATH.test(path);

export const findAttribution = message =>
  message.split('\n').flatMap((line, index) => {
    const rule = ATTRIBUTION_RULES.find(({ pattern }) => pattern.test(line));
    return rule ? [{ line: index + 1, reason: rule.reason, excerpt: excerptOf(line.trim()) }] : [];
  });

const isOuterDocText = text => text.startsWith('///') && !text.startsWith('////');

const bracketBalance = text => {
  let balance = 0;
  for (const char of text) {
    if (char === '[') balance += 1;
    else if (char === ']') balance -= 1;
  }
  return balance;
};

const describeRustItems = lines => {
  const attributesByItem = new Map();
  const itemByDoc = new Map();
  let attributes = [];
  let docs = [];
  for (let index = 0; index < lines.length; index += 1) {
    const code = lines[index].trim();
    if (code === '') {
      attributes = [];
      docs = [];
    } else if (isOuterDocText(code)) {
      docs.push(index);
    } else if (code.startsWith('#[') || code.startsWith('#![')) {
      let attribute = code;
      let balance = bracketBalance(code);
      while (balance > 0 && index + 1 < lines.length) {
        index += 1;
        attribute += ` ${lines[index].trim()}`;
        balance += bracketBalance(lines[index]);
      }
      attributes.push(attribute);
    } else if (!code.startsWith('//')) {
      attributesByItem.set(index, attributes.join(' '));
      docs.forEach(doc => itemByDoc.set(doc, index));
      attributes = [];
      docs = [];
    }
  }
  return { attributesByItem, itemByDoc };
};

const indentationOf = line => line.length - line.trimStart().length;

const findEnclosingType = (lines, itemIndex) => {
  let column = indentationOf(lines[itemIndex]);
  for (let index = itemIndex - 1; index >= 0 && column > 0; index -= 1) {
    const line = lines[index];
    const lineColumn = indentationOf(line);
    if (line.trim() === '' || lineColumn >= column) continue;
    if (TYPE_DECLARATION.test(line)) return index;
    column = lineColumn;
  }
  return -1;
};

const isCliOrSchemaDoc = (comment, { lines, items }) => {
  if (!comment.leading || !isOuterDocText(comment.text)) return false;
  const itemIndex = items.itemByDoc.get(comment.startLine - 1);
  if (itemIndex == null) return false;
  const typeIndex = TYPE_DECLARATION.test(lines[itemIndex])
    ? itemIndex
    : findEnclosingType(lines, itemIndex);
  return typeIndex !== -1 && CLI_OR_SCHEMA_DERIVE.test(items.attributesByItem.get(typeIndex) ?? '');
};

const opensUnsafeSoon = (lines, fromIndex) => {
  const end = Math.min(fromIndex + UNSAFE_REACH_LINES, lines.length);
  for (let index = fromIndex; index < end; index += 1) {
    const code = lines[index].trim();
    if (code === '' || code.startsWith('//')) return false;
    if (UNSAFE_KEYWORD.test(code)) return true;
  }
  return false;
};

const isSafetyComment = (comment, lines) =>
  comment.leading && SAFETY_COMMENT.test(comment.text) && opensUnsafeSoon(lines, comment.endLine);

const isAllowlisted = (comment, allowlist) => comment.leading && allowlist.has(comment.text);

const describeCodeComment = ({ leading }) => (leading ? 'code comment' : 'trailing code comment');

const judgeRustComment = (comment, context) => {
  if (comment.text.startsWith('/*')) return 'block comment';
  if (comment.text.startsWith('//!')) return 'inner doc comment';
  if (isOuterDocText(comment.text)) {
    return isCliOrSchemaDoc(comment, context)
      ? null
      : 'doc comment outside clap and schemars items';
  }
  if (isAllowlisted(comment, context.allowlist) || isSafetyComment(comment, context.lines)) {
    return null;
  }
  return describeCodeComment(comment);
};

const judgeScriptComment = (comment, { allowlist }) => {
  if (isAllowlisted(comment, allowlist)) return null;
  return comment.text.startsWith('/*') ? 'block comment' : describeCodeComment(comment);
};

const judgeHashComment = () => 'hash comment';

const JUDGES = {
  rust: judgeRustComment,
  script: judgeScriptComment,
  toml: judgeHashComment,
  yaml: judgeHashComment,
};

const touchesAddedLine = ({ startLine, endLine }, addedLines) => {
  for (let line = startLine; line <= endLine; line += 1) {
    if (addedLines.has(line)) return true;
  }
  return false;
};

export const judgeComments = ({ path, content, addedLines, allowlist }) => {
  if (!isCheckedPath(path)) return [];
  const language = languageOf(path);
  const lines = content.split('\n');
  const context = {
    lines,
    allowlist,
    items: language === 'rust' ? describeRustItems(lines) : null,
  };
  return COMMENT_FINDERS[language](content)
    .filter(comment => touchesAddedLine(comment, addedLines))
    .flatMap(comment => {
      const reason = JUDGES[language](comment, context);
      return reason
        ? [{ path, line: comment.startLine, reason, excerpt: excerptOf(comment.text) }]
        : [];
    });
};
