import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import { unified } from 'unified';

const NOTE_TYPES = new Map([
  ['info', 'Info'],
  ['warn', 'Warning'],
  ['alert', 'Alert'],
]);

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;
const CONTAINER_MARKER = /^ {0,3}:::/;
const CONTAINER_CLOSE = /^ {0,3}:::[ \t]*$/;
const CONTAINER_OPEN = /^ {0,3}:::(\S+)(?:[ \t]+(.*?))?[ \t]*$/;
const boundaryParser = unified().use(remarkParse).use(remarkGfm);

/**
 * Parse Qiita's block-note syntax at block boundaries and expose it as a
 * semantic HAST container through mdast data.  This deliberately happens in
 * the Markdown pipeline instead of in rendered HTML, so Markdown inside a
 * note continues to use the same parser as the rest of an article.
 */
export function remarkQiitaNotes() {
  const parse = typeof this?.parse === 'function' ? this.parse.bind(this) : null;

  return function transformQiitaNotes(tree, file) {
    const source = String(file);
    const rawHtmlRanges = getRawHtmlRanges(tree);
    const notes = findNotes(source, getBoundaryTokenRanges(tree), rawHtmlRanges);

    if (notes.length === 0) {
      return;
    }

    assertNoRawHtmlInNotes(notes, rawHtmlRanges);

    if (!parse) {
      throw new Error('Unable to parse Qiita note content with the configured Markdown parser.');
    }

    const parsedTree = parse(maskNoteBoundaryLines(source, notes));
    const { outsideChildren, noteBodies } = partitionNoteChildren(
      parsedTree.children,
      notes,
    );
    assertNoRawHtmlInNotes(notes, getRawHtmlRanges(parsedTree));
    const noteNodes = notes.map((note, index) =>
      createNoteNode(note.type, noteBodies[index]),
    );

    tree.children = mergeNoteNodes(outsideChildren, notes, noteNodes);
  };
}

/**
 * Validate every blog Markdown file before Astro's content loader can turn a
 * render error into a logged warning.  The remark transform remains the
 * source of AST conversion; this build hook only makes invalid containers
 * fail the static build instead of silently dropping their entry.
 */
export function qiitaMarkdownValidationIntegration() {
  return {
    name: 'qiita-markdown-validation',
    hooks: {
      'astro:config:setup': ({ command, config }) => {
        if (command !== 'build') {
          return;
        }

        const contentRoot = fileURLToPath(new URL('./src/content/blog/', config.root));
        validateMarkdownDirectory(contentRoot);
      },
    },
  };
}

/**
 * Convert Qiita's `language:filename` code-fence token into a normal language
 * token and a safe, text-only figure label.  The wrapper is an mdast node so
 * Astro/Shiki still receives the original code node and language.
 */
export function remarkCodeFenceFilenames() {
  return function transformCodeFenceFilenames(tree, file) {
    visitChildren(tree, (node, parent, index) => {
      if (node.type !== 'code' || typeof node.lang !== 'string') {
        return false;
      }

      const separator = node.lang.indexOf(':');
      if (separator === -1) {
        return false;
      }

      const language = node.lang.slice(0, separator);
      const filename = node.lang.slice(separator + 1);

      if (!language || !filename || /[\r\n]/u.test(filename)) {
        throw diagnostic('Malformed language:filename code fence.', node);
      }

      node.lang = language;

      const label = {
        type: 'qiitaCodeFilename',
        children: [{ type: 'text', value: filename }],
        data: {
          hName: 'figcaption',
          hProperties: { className: ['qiita-code-filename'] },
        },
      };

      const wrapper = {
        type: 'qiitaCodeBlock',
        children: [label, node],
        data: {
          hName: 'figure',
          hProperties: { className: ['qiita-code-block'] },
        },
      };

      parent.children[index] = wrapper;
      return true;
    });
  };
}

function findNotes(source, boundaryTokenRanges = [], rawHtmlRanges = []) {
  const lines = getLines(source);
  const notes = [];
  let fence = null;
  let openNote = null;

  for (const line of lines) {
    const markerStart = getContainerMarkerStart(line);

    // A marker inside an existing raw-HTML block belongs to that trusted
    // author HTML, not to the Qiita container syntax.  In particular, do not
    // rewrite the surrounding html node and accidentally discard its range.
    if (isInsideRawHtml(line, rawHtmlRanges, markerStart)) {
      if (openNote && line.start >= openNote.bodyStart) {
        throw new Error(
          `Raw HTML is not allowed inside Qiita notes (line ${line.number}).`,
        );
      }

      continue;
    }

    // The source line may be part of a multiline inline token even though it
    // looks exactly like a container marker.  Never let source-line scanning
    // reinterpret link labels, image labels, code spans, emphasis, or any
    // other non-text mdast token as a Qiita note boundary.
    if (isInsideBoundaryToken(line, boundaryTokenRanges, markerStart)) {
      continue;
    }

    if (fence) {
      if (isFenceClose(line.content, fence)) {
        fence = null;
      }
      continue;
    }

    const fenceOpen = FENCE_OPEN.exec(line.content);
    if (fenceOpen) {
      fence = { character: fenceOpen[1][0], length: fenceOpen[1].length };
      continue;
    }

    if (openNote) {
      if (CONTAINER_CLOSE.test(line.content)) {
        notes.push({
          type: openNote.type,
          openStart: openNote.openStart,
          bodyStart: openNote.bodyStart,
          bodyEnd: line.start,
          closeEnd: line.end,
        });
        openNote = null;
        continue;
      }

      if (CONTAINER_MARKER.test(line.content)) {
        throw diagnosticAtLine(
          'Nested or unsupported Qiita container inside a note.',
          line,
        );
      }

      continue;
    }

    if (CONTAINER_CLOSE.test(line.content)) {
      throw diagnosticAtLine('Stray Qiita note closing marker.', line);
    }

    if (!CONTAINER_MARKER.test(line.content)) {
      continue;
    }

    const marker = CONTAINER_OPEN.exec(line.content);
    if (!marker) {
      throw diagnosticAtLine('Malformed or unsupported Qiita container marker.', line);
    }

    const [, name, rawArguments] = marker;
    if (name !== 'note') {
      throw diagnosticAtLine(`Unsupported Qiita container "${name}".`, line);
    }

    const argumentsText = rawArguments?.trim() ?? '';
    const argumentsList = argumentsText ? argumentsText.split(/[ \t]+/u) : [];
    if (argumentsList.length > 1) {
      throw diagnosticAtLine('Malformed Qiita note type.', line);
    }

    const type = argumentsList[0] || 'info';
    if (!NOTE_TYPES.has(type)) {
      throw diagnosticAtLine(`Unsupported Qiita note type "${type}".`, line);
    }

    openNote = {
      type,
      openStart: line.start,
      bodyStart: line.end,
    };
  }

  if (openNote) {
    throw new Error('Unclosed Qiita note: expected a closing ::: marker.');
  }

  return notes;
}

function getRawHtmlRanges(tree) {
  const ranges = [];

  collectRawHtmlRanges(tree, ranges);
  return ranges;
}

function getBoundaryTokenRanges(tree) {
  const ranges = [];

  collectBoundaryTokenRanges(tree, ranges);
  return ranges;
}

function collectRawHtmlRanges(node, ranges) {
  if (node.type === 'html' && node.position) {
    ranges.push({
      start: node.position.start.offset,
      end: node.position.end.offset,
      line: node.position.start.line,
    });
  }

  for (const child of node.children ?? []) {
    collectRawHtmlRanges(child, ranges);
  }
}

function collectBoundaryTokenRanges(node, ranges) {
  if (
    node.type !== 'root' &&
    node.type !== 'paragraph' &&
    node.type !== 'text' &&
    node.position &&
    Number.isInteger(node.position.start.offset) &&
    Number.isInteger(node.position.end.offset)
  ) {
    ranges.push({
      start: node.position.start.offset,
      end: node.position.end.offset,
    });
  }

  for (const child of node.children ?? []) {
    collectBoundaryTokenRanges(child, ranges);
  }
}

function getContainerMarkerStart(line) {
  const marker = CONTAINER_MARKER.exec(line.content);
  if (!marker) {
    return null;
  }

  return line.start + marker[0].indexOf(':::');
}

function isInsideRawHtml(line, rawHtmlRanges, markerStart) {
  if (Number.isInteger(markerStart)) {
    return isOffsetInsideRanges(markerStart, rawHtmlRanges);
  }

  return rawHtmlRanges.some((range) => line.start < range.end && line.end > range.start);
}

function isInsideBoundaryToken(line, boundaryTokenRanges, markerStart) {
  if (Number.isInteger(markerStart)) {
    return isOffsetInsideRanges(markerStart, boundaryTokenRanges);
  }

  return boundaryTokenRanges.some(
    (range) => line.start < range.end && line.end > range.start,
  );
}

function isOffsetInsideRanges(offset, ranges) {
  return ranges.some((range) => range.start <= offset && offset < range.end);
}

function assertNoRawHtmlInNotes(notes, rawHtmlRanges) {
  for (const note of notes) {
    const rawHtml = rawHtmlRanges.find(
      (range) => range.start < note.bodyEnd && range.end > note.bodyStart,
    );

    if (rawHtml) {
      throw new Error(
        `Raw HTML is not allowed inside Qiita notes (line ${rawHtml.line ?? '?'}).`,
      );
    }
  }
}

function validateMarkdownDirectory(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      validateMarkdownDirectory(path);
      continue;
    }

    if (!entry.isFile() || !path.endsWith('.md')) {
      continue;
    }

    try {
      const markdown = stripFrontmatter(readFileSync(path, 'utf8'));
      const tree = boundaryParser.parse(markdown);
      const rawHtmlRanges = getRawHtmlRanges(tree);
      const notes = findNotes(markdown, getBoundaryTokenRanges(tree), rawHtmlRanges);
      assertNoRawHtmlInNotes(notes, rawHtmlRanges);
    } catch (error) {
      throw new Error(`Invalid Qiita Markdown in ${path}: ${error.message}`, {
        cause: error,
      });
    }
  }
}

function stripFrontmatter(source) {
  const lines = getLines(source);
  let openingIndex = 0;

  while (openingIndex < lines.length) {
    const content = lines[openingIndex].content.replace(/^\uFEFF/u, '');
    if (!/^[ \t]*$/u.test(content)) {
      break;
    }
    openingIndex += 1;
  }

  const firstLine = lines[openingIndex]?.content.replace(/^\uFEFF/u, '');
  const closingDelimiter =
    /^---[ \t]*$/u.test(firstLine ?? '')
      ? /^(?:---|\.\.\.|\+\+\+)[ \t]*$/u
      : /^\+\+\+[ \t]*$/u.test(firstLine ?? '')
        ? /^(?:\+\+\+|---)[ \t]*$/u
        : null;

  if (!closingDelimiter) {
    return source;
  }

  for (const line of lines.slice(openingIndex + 1)) {
    if (closingDelimiter.test(line.content.replace(/^\uFEFF/u, ''))) {
      return source.slice(line.end);
    }
  }

  return source;
}

function createNoteNode(type, body) {
  const label = NOTE_TYPES.get(type);

  return {
    type: 'qiitaNote',
    children: [
      {
        type: 'paragraph',
        children: [{ type: 'text', value: label }],
        data: {
          hProperties: { className: ['qiita-note-label'] },
        },
      },
      ...body,
    ],
    data: {
      hName: 'aside',
      hProperties: {
        className: ['qiita-note', `qiita-note-${type}`],
        role: 'note',
        'aria-label': label,
        'data-note-type': type,
      },
    },
  };
}

function getLines(source) {
  const lines = [];
  let start = 0;

  while (start < source.length) {
    let newline = start;

    while (
      newline < source.length &&
      source[newline] !== '\r' &&
      source[newline] !== '\n'
    ) {
      newline += 1;
    }

    const end =
      newline === source.length
        ? source.length
        : newline +
          (source[newline] === '\r' && source[newline + 1] === '\n' ? 2 : 1);
    const content = source.slice(start, newline);
    lines.push({ number: lines.length + 1, start, end, content });
    start = end;
  }

  return lines;
}

function isFenceClose(content, fence) {
  const close = new RegExp(
    `^ {0,3}${fence.character}{${fence.length},}[ \\t]*$`,
    'u',
  );
  return close.test(content);
}

function maskNoteBoundaryLines(source, notes) {
  let result = '';
  let cursor = 0;

  for (const note of notes) {
    result += source.slice(cursor, note.openStart);
    result += maskLine(source.slice(note.openStart, note.bodyStart));
    result += source.slice(note.bodyStart, note.bodyEnd);
    result += maskLine(source.slice(note.bodyEnd, note.closeEnd));
    cursor = note.closeEnd;
  }

  return result + source.slice(cursor);
}

function maskLine(source) {
  return source.replace(/[^\r\n]/g, ' ');
}

function partitionNoteChildren(children, notes) {
  const outsideChildren = [];
  const noteBodies = notes.map(() => []);

  for (const child of children) {
    const start = child.position?.start?.offset;
    const end = child.position?.end?.offset;
    const noteIndex = notes.findIndex(
      (note) =>
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= note.bodyStart &&
        end <= note.bodyEnd,
    );

    if (noteIndex === -1) {
      outsideChildren.push(child);
    } else {
      noteBodies[noteIndex].push(child);
    }
  }

  return { outsideChildren, noteBodies };
}

function mergeNoteNodes(outsideChildren, notes, noteNodes) {
  const children = [];
  let noteIndex = 0;

  for (const child of outsideChildren) {
    const childStart = child.position?.start?.offset ?? Number.POSITIVE_INFINITY;

    while (noteIndex < notes.length && notes[noteIndex].openStart <= childStart) {
      children.push(noteNodes[noteIndex]);
      noteIndex += 1;
    }

    children.push(child);
  }

  while (noteIndex < notes.length) {
    children.push(noteNodes[noteIndex]);
    noteIndex += 1;
  }

  return children;
}

function visitChildren(node, visitor) {
  if (!node.children) {
    return;
  }

  for (let index = 0; index < node.children.length; index += 1) {
    const child = node.children[index];
    if (visitor(child, node, index)) {
      continue;
    }
    visitChildren(child, visitor);
  }
}

function diagnostic(message, node) {
  const location = node.position?.start?.line ? ` (line ${node.position.start.line})` : '';
  return new Error(`${message}${location}`);
}

function diagnosticAtLine(message, line) {
  return new Error(`${message} (line ${line.number ?? '?'})`);
}
