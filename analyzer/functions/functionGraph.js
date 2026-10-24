#!/usr/bin/env node
/**
 * Kairos analyzer — function-level dependency graph.
 *
 * Builds, for Java / TypeScript+JavaScript / Python:
 *   nodes: { id, file, name, className|null, kind, startLine, endLine, arity }
 *          id = "<repo-relative file>#<Class.>name"
 *          kind = 'function' | 'method' | 'constructor'
 *   edges: { from, to, kind: 'call', confidence: 'high'|'medium', line }
 *          `from` calls `to` (so `from` depends on `to`, same direction
 *          convention as the file-level graph).
 *
 * This is deliberately a lightweight static analysis (comment/string-masked
 * source + brace/indent matching), not a full AST. Call resolution is
 * conservative: a call becomes an edge only if its target can be resolved
 *   high   — through imports, same-file scope, `this`/`self`, or a declared
 *            type of the receiver
 *   medium — receiver type unknown, but exactly ONE method with that name
 *            exists in the files the caller's file already depends on
 * Anything else is dropped rather than guessed, so the graph answers
 * "potentially affected" without inventing relationships.
 *
 * Also exports impact helpers: computeFunctionImpact, shortestCallPath.
 */

'use strict';

const path = require('path');
const pythonPlugin = require('../languages/python');

// ---------------------------------------------------------------------
// Source masking — blanks comments and string contents (keeps offsets
// and newlines) so regexes/brace matching never trip on them.
// ---------------------------------------------------------------------

function maskSource(src, lang) {
  const out = src.split('');
  const n = src.length;
  const blank = (a, b) => {
    for (let k = a; k < b && k < n; k++) {
      if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' ';
    }
  };
  let i = 0;

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];

    if (lang === 'python') {
      if (c === '#') {
        let j = src.indexOf('\n', i);
        if (j < 0) j = n;
        blank(i, j);
        i = j;
        continue;
      }
      if (c === '"' || c === "'") {
        const triple = src.startsWith(c.repeat(3), i);
        const q = triple ? c.repeat(3) : c;
        let j = i + q.length;
        while (j < n) {
          if (src[j] === '\\') { j += 2; continue; }
          if (src.startsWith(q, j)) break;
          if (!triple && src[j] === '\n') break;
          j++;
        }
        blank(i + q.length, j);
        i = j + q.length;
        continue;
      }
      i++;
      continue;
    }

    // C-like (java, typescript)
    if (c === '/' && d === '/') {
      let j = src.indexOf('\n', i);
      if (j < 0) j = n;
      blank(i, j);
      i = j;
      continue;
    }
    if (c === '/' && d === '*') {
      const j = src.indexOf('*/', i + 2);
      const end = j < 0 ? n : j + 2;
      blank(i, end);
      i = end;
      continue;
    }
    if (c === '"' || c === "'") {
      const textBlock = lang === 'java' && c === '"' && src.startsWith('"""', i);
      const q = textBlock ? '"""' : c;
      let j = i + q.length;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src.startsWith(q, j)) break;
        if (!textBlock && src[j] === '\n') break;
        j++;
      }
      blank(i + q.length, j);
      i = j + q.length;
      continue;
    }
    if (c === '`' && lang === 'typescript') {
      let j = i + 1;
      while (j < n && src[j] !== '`') {
        if (src[j] === '\\') { blank(j, j + 2); j += 2; continue; }
        if (src[j] === '$' && src[j + 1] === '{') {
          // keep the interpolated expression visible (it can contain calls)
          let depth = 1;
          j += 2;
          while (j < n && depth > 0) {
            if (src[j] === '{') depth++;
            else if (src[j] === '}') depth--;
            j++;
          }
          continue;
        }
        blank(j, j + 1);
        j++;
      }
      i = j + 1;
      continue;
    }
    i++;
  }
  return out.join('');
}

function matchClose(s, openIdx, open, close) {
  let depth = 0;
  for (let i = openIdx; i < s.length; i++) {
    const ch = s[i];
    if (ch === open) depth++;
    else if (ch === close) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** depth[i] = brace nesting depth BEFORE char i. */
function computeDepth(s) {
  const depth = new Int32Array(s.length + 1);
  let d = 0;
  for (let i = 0; i < s.length; i++) {
    depth[i] = d;
    if (s[i] === '{') d++;
    else if (s[i] === '}') d = Math.max(0, d - 1);
  }
  depth[s.length] = d;
  return depth;
}

function makeLineOf(src) {
  const starts = [0];
  for (let i = 0; i < src.length; i++) if (src[i] === '\n') starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function countArgs(str) {
  const t = str.trim();
  if (!t) return 0;
  let depth = 0;
  let n = 1;
  for (const ch of t) {
    if ('([{<'.includes(ch)) depth++;
    else if (')]}>'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ',' && depth === 0) n++;
  }
  return n;
}

// ---------------------------------------------------------------------
// Function extraction
// ---------------------------------------------------------------------

const JAVA_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'synchronized', 'try', 'else', 'return',
  'new', 'throw', 'assert', 'super', 'this', 'do', 'case', 'instanceof',
]);
const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'function', 'return', 'super', 'typeof',
  'new', 'delete', 'void', 'await', 'async', 'import', 'require', 'throw', 'do',
  'else', 'case', 'with', 'yield', 'of', 'in',
]);
const PY_KEYWORDS = new Set([
  'if', 'elif', 'while', 'for', 'with', 'return', 'lambda', 'not', 'and', 'or', 'in',
  'is', 'assert', 'yield', 'await', 'except', 'print', 'def', 'class', 'raise', 'del',
]);

function keywordsFor(lang) {
  return lang === 'java' ? JAVA_KEYWORDS : lang === 'python' ? PY_KEYWORDS : JS_KEYWORDS;
}

function makeFn(file, name, className, kind, startOff, bodyStart, bodyEnd, arity, isStatic, lineOf) {
  return {
    file, name, className, kind, arity, isStatic: !!isStatic,
    startLine: lineOf(startOff),
    endLine: lineOf(Math.max(startOff, bodyEnd)),
    _bodyStart: bodyStart,
    _bodyEnd: bodyEnd,
  };
}

function extractJava(file, masked, lineOf) {
  const depth = computeDepth(masked);
  const types = [];
  const TYPE_RE = /\b(?:class|interface|enum|record)\s+(\w+)\b[^{;]*\{/g;
  let m;
  while ((m = TYPE_RE.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open, '{', '}');
    if (close < 0) continue;
    types.push({ name: m[1], open, close, bodyDepth: depth[open] + 1 });
  }

  const fns = [];
  const CALLISH = /(\w+)\s*\(/g;
  while ((m = CALLISH.exec(masked)) !== null) {
    const name = m[1];
    const nameIdx = m.index;
    if (JAVA_KEYWORDS.has(name)) continue;

    // innermost type whose body directly contains this offset
    let owner = null;
    for (const t of types) {
      if (nameIdx > t.open && nameIdx < t.close && depth[nameIdx] === t.bodyDepth) {
        if (!owner || t.open > owner.open) owner = t;
      }
    }
    if (!owner) continue;

    const parenOpen = nameIdx + m[0].length - 1;
    const parenClose = matchClose(masked, parenOpen, '(', ')');
    if (parenClose < 0) continue;
    const after = masked.slice(parenClose + 1, parenClose + 200);
    const bodyM = /^\s*(?:throws\s+[\w.,\s<>]+?)?\s*\{/.exec(after);
    if (!bodyM) continue; // abstract / interface declaration or a plain call

    // Declaration, not call: look at the statement prefix since last boundary.
    let b = nameIdx - 1;
    while (b >= 0 && !';{}'.includes(masked[b])) b--;
    const prefix = masked.slice(b + 1, nameIdx);
    const isCtor = name === owner.name;
    if (!isCtor) {
      // need a return type: prefix ends with an identifier/generic/array token
      if (!/[\w>\]]\s*$/.test(prefix)) continue;
      if (/\b(?:new|return|else|throw|case)\s*$/.test(prefix)) continue;
      if (/@\w*\s*$/.test(prefix)) continue;
    } else if (/\bnew\s*$/.test(prefix)) {
      continue;
    }

    const bodyOpen = parenClose + 1 + bodyM[0].length - 1;
    const bodyClose = matchClose(masked, bodyOpen, '{', '}');
    if (bodyClose < 0) continue;
    fns.push(
      makeFn(
        file, name, owner.name, isCtor ? 'constructor' : 'method', nameIdx,
        bodyOpen + 1, bodyClose,
        countArgs(masked.slice(parenOpen + 1, parenClose)),
        /\bstatic\b/.test(prefix), lineOf
      )
    );
  }
  return { fns, classNames: types.map((t) => t.name) };
}

/** Parses the right-hand side of `x = <fn expr>` starting at idx. */
function parseJsFnExprAt(masked, idx) {
  const rest = masked.slice(idx, idx + 400);
  let m = /^\s*(?:async\s+)?function\b\s*\*?\s*[\w$]*\s*\(/.exec(rest);
  let parenOpen = -1;
  if (m) {
    parenOpen = idx + m[0].length - 1;
  } else {
    m = /^\s*(?:async\s+)?\(/.exec(rest);
    if (m) parenOpen = idx + m[0].length - 1;
  }

  let afterParams;
  let arity = 0;
  if (parenOpen >= 0) {
    const parenClose = matchClose(masked, parenOpen, '(', ')');
    if (parenClose < 0) return null;
    arity = countArgs(masked.slice(parenOpen + 1, parenClose));
    afterParams = parenClose + 1;
    const isFunctionKeyword = /^\s*(?:async\s+)?function\b/.test(rest);
    if (isFunctionKeyword) {
      const br = /^\s*(?::[^{;]*)?\{/.exec(masked.slice(afterParams, afterParams + 300));
      if (!br) return null;
      const open = afterParams + br[0].length - 1;
      const close = matchClose(masked, open, '{', '}');
      return close < 0 ? null : { bodyStart: open + 1, bodyEnd: close, arity };
    }
  } else {
    const single = /^\s*(?:async\s+)?([\w$]+)\s*(?==>)/.exec(rest);
    if (!single) return null;
    arity = 1;
    afterParams = idx + single[0].length;
  }

  const arrow = /^\s*(?::[^=;{}]*?)?=>\s*/.exec(masked.slice(afterParams, afterParams + 300));
  if (!arrow) return null;
  const bodyIdx = afterParams + arrow[0].length;
  if (masked[bodyIdx] === '{') {
    const close = matchClose(masked, bodyIdx, '{', '}');
    return close < 0 ? null : { bodyStart: bodyIdx + 1, bodyEnd: close, arity };
  }
  // expression body: up to ; or newline at nesting depth 0
  let d = 0;
  let j = bodyIdx;
  for (; j < masked.length; j++) {
    const ch = masked[j];
    if ('([{'.includes(ch)) d++;
    else if (')]}'.includes(ch)) {
      if (d === 0) break;
      d--;
    } else if ((ch === ';' || ch === '\n') && d === 0) break;
  }
  return { bodyStart: bodyIdx, bodyEnd: j, arity };
}

const CLASS_MEMBER_PREFIX_RE =
  /^\s*(?:@[\w.]+(?:\([^)]*\))?\s*)*(?:(?:static|public|private|protected|async|get|set|readonly|override|abstract|declare)\s+)*\*?\s*$/;

function extractTypeScript(file, masked, lineOf) {
  const depth = computeDepth(masked);
  const fns = [];
  const classes = [];
  let m;

  const CLASS_RE = /\bclass\s+([\w$]+)\b[^{]*\{/g;
  while ((m = CLASS_RE.exec(masked)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open, '{', '}');
    if (close < 0) continue;
    classes.push({ name: m[1], open, close, bodyDepth: depth[open] + 1 });
  }

  // function declarations
  const FN_RE = /\bfunction\s*\*?\s*([\w$]+)\s*(?:<[^()]*?>)?\s*\(/g;
  while ((m = FN_RE.exec(masked)) !== null) {
    const parenOpen = m.index + m[0].length - 1;
    const parenClose = matchClose(masked, parenOpen, '(', ')');
    if (parenClose < 0) continue;
    const br = /^\s*(?::[^{;]*)?\{/.exec(masked.slice(parenClose + 1, parenClose + 300));
    if (!br) continue;
    const open = parenClose + 1 + br[0].length - 1;
    const close = matchClose(masked, open, '{', '}');
    if (close < 0) continue;
    fns.push(
      makeFn(file, m[1], null, 'function', m.index, open + 1, close,
        countArgs(masked.slice(parenOpen + 1, parenClose)), false, lineOf)
    );
  }

  // const/let/var x = <fn expr>;  exports.x = <fn expr>;  Foo.prototype.x = <fn expr>
  const ASSIGN_RES = [
    { re: /\b(?:const|let|var)\s+([\w$]+)\s*(?::[^=;]+?)?=(?!=)/g, cls: () => null },
    { re: /\b(?:module\.)?exports\.([\w$]+)\s*=(?!=)/g, cls: () => null },
    { re: /\b([\w$]+)\.prototype\.([\w$]+)\s*=(?!=)/g, cls: (mm) => mm[1], nameIdx: 2 },
  ];
  for (const spec of ASSIGN_RES) {
    spec.re.lastIndex = 0;
    while ((m = spec.re.exec(masked)) !== null) {
      const parsed = parseJsFnExprAt(masked, m.index + m[0].length);
      if (!parsed) continue;
      const name = m[spec.nameIdx || 1];
      const cls = spec.cls(m);
      fns.push(
        makeFn(file, name, cls, cls ? 'method' : 'function', m.index,
          parsed.bodyStart, parsed.bodyEnd, parsed.arity, false, lineOf)
      );
    }
  }

  // class members: methods + arrow-function fields
  for (const cls of classes) {
    const body = masked.slice(cls.open + 1, cls.close);
    const base = cls.open + 1;

    const METHOD_RE = /([#\w$]+)\s*(?:<[^()]*?>)?\s*\(/g;
    while ((m = METHOD_RE.exec(body)) !== null) {
      const name = m[1];
      const abs = base + m.index;
      if (depth[abs] !== cls.bodyDepth) continue;
      if (JS_KEYWORDS.has(name)) continue;
      // innermost class check
      const inner = classes.some((c) => c !== cls && c.open > cls.open && c.close < cls.close && abs > c.open && abs < c.close && depth[abs] === c.bodyDepth);
      if (inner) continue;
      const parenOpen = base + m.index + m[0].length - 1;
      const parenClose = matchClose(masked, parenOpen, '(', ')');
      if (parenClose < 0) continue;
      const br = /^\s*(?::[^{;=]*)?\{/.exec(masked.slice(parenClose + 1, parenClose + 300));
      if (!br) continue;
      let b = abs - 1;
      while (b >= 0 && !';{}'.includes(masked[b])) b--;
      if (!CLASS_MEMBER_PREFIX_RE.test(masked.slice(b + 1, abs))) continue;
      const open = parenClose + 1 + br[0].length - 1;
      const close = matchClose(masked, open, '{', '}');
      if (close < 0) continue;
      const prefix = masked.slice(b + 1, abs);
      fns.push(
        makeFn(file, name, cls.name, name === 'constructor' ? 'constructor' : 'method',
          abs, open + 1, close, countArgs(masked.slice(parenOpen + 1, parenClose)),
          /\bstatic\b/.test(prefix), lineOf)
      );
    }

    const FIELD_RE = /([#\w$]+)\s*(?::[^=;{}()]+)?=(?![=>])/g;
    while ((m = FIELD_RE.exec(body)) !== null) {
      const abs = base + m.index;
      if (depth[abs] !== cls.bodyDepth) continue;
      let b = abs - 1;
      while (b >= 0 && !';{}'.includes(masked[b])) b--;
      if (!CLASS_MEMBER_PREFIX_RE.test(masked.slice(b + 1, abs))) continue;
      const parsed = parseJsFnExprAt(masked, base + m.index + m[0].length);
      if (!parsed) continue;
      fns.push(
        makeFn(file, m[1], cls.name, 'method', abs, parsed.bodyStart, parsed.bodyEnd,
          parsed.arity, /\bstatic\b/.test(masked.slice(b + 1, abs)), lineOf)
      );
    }
  }

  return { fns, classNames: classes.map((c) => c.name) };
}

function extractPython(file, masked, lineOf) {
  const lines = masked.split('\n');
  const offsets = [];
  let off = 0;
  for (const l of lines) {
    offsets.push(off);
    off += l.length + 1;
  }
  const indentOf = (l) => l.length - l.replace(/^[ \t]+/, '').length;
  const isBlank = (l) => l.trim() === '';

  // block end: last line index (exclusive) of the block opened at line `i`
  function blockEnd(i, indent) {
    let j = i + 1;
    let last = i;
    for (; j < lines.length; j++) {
      if (isBlank(lines[j])) continue;
      if (indentOf(lines[j]) <= indent) break;
      last = j;
    }
    return last;
  }

  const classes = [];
  const defs = [];
  for (let i = 0; i < lines.length; i++) {
    const cm = /^([ \t]*)class\s+(\w+)/.exec(lines[i]);
    if (cm) {
      classes.push({ name: cm[2], indent: cm[1].length, start: i, end: blockEnd(i, cm[1].length) });
      continue;
    }
    const dm = /^([ \t]*)(?:async\s+)?def\s+(\w+)\s*\(/.exec(lines[i]);
    if (dm) {
      defs.push({ name: dm[2], indent: dm[1].length, start: i, end: blockEnd(i, dm[1].length) });
    }
  }

  const fns = [];
  for (const d of defs) {
    const startOff = offsets[d.start];
    const sigParen = masked.indexOf('(', startOff);
    const sigClose = matchClose(masked, sigParen, '(', ')');
    if (sigClose < 0) continue;
    const params = masked.slice(sigParen + 1, sigClose);
    const bodyStart = sigClose + 1;
    const bodyEnd = offsets[d.end] + lines[d.end].length;

    // direct parent class: innermost block that contains the def, and no
    // enclosing def between them
    const parents = classes.filter((c) => c.start < d.start && c.end >= d.end && c.indent < d.indent);
    const parent = parents.sort((a, b) => b.indent - a.indent)[0] || null;
    const enclosingDef = defs.find((o) => o !== d && o.start < d.start && o.end >= d.end && o.indent < d.indent && (!parent || o.start > parent.start));
    const className = parent && !enclosingDef ? parent.name : null;

    const isStatic = d.start > 0 && /@(?:staticmethod|classmethod)/.test(lines[d.start - 1]);
    const selfless = params.replace(/^\s*(?:self|cls)\s*,?\s*/, '');
    fns.push(
      makeFn(file, d.name, className, d.name === '__init__' ? 'constructor' : className ? 'method' : 'function',
        startOff, bodyStart, bodyEnd, countArgs(selfless), isStatic, lineOf)
    );
  }
  return { fns, classNames: classes.map((c) => c.name) };
}

function extractFunctions(file, source, lang) {
  const masked = maskSource(source, lang);
  const lineOf = makeLineOf(source);
  const res =
    lang === 'java' ? extractJava(file, masked, lineOf)
      : lang === 'python' ? extractPython(file, masked, lineOf)
        : extractTypeScript(file, masked, lineOf);

  // stable ids; collisions (overloads, shadowed names) get an @line suffix
  const seen = new Map();
  res.fns.sort((a, b) => a.startLine - b.startLine || a.name.localeCompare(b.name));
  for (const fn of res.fns) {
    const base = `${file}#${fn.className ? `${fn.className}.` : ''}${fn.name}`;
    const n = (seen.get(base) || 0) + 1;
    seen.set(base, n);
    fn.id = n === 1 ? base : `${base}@L${fn.startLine}`;
  }
  return { masked, fns: res.fns, classNames: res.classNames };
}

// ---------------------------------------------------------------------
// Import bindings (local name -> where it comes from)
// ---------------------------------------------------------------------

const JS_RESOLVE_SUFFIXES = ['', '.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.tsx', '/index.js', '/index.jsx'];

function resolveJsSpecifier(fromRel, spec, known) {
  if (!spec.startsWith('.')) return null;
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), spec));
  for (const s of JS_RESOLVE_SUFFIXES) {
    if (known.has(base + s)) return base + s;
  }
  return null;
}

function splitNamed(list) {
  return list
    .split(',')
    .map((x) => x.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((x) => {
      const [exported, local] = x.split(/\s+as\s+|\s*:\s*/).map((s) => s.trim());
      return { exported, local: local || exported };
    });
}

function jsBindings(file, source, known) {
  const b = new Map();
  const add = (local, spec, exported, type) => {
    const target = resolveJsSpecifier(file, spec, known);
    if (target) b.set(local, { file: target, exported, type });
  };
  let m;

  const DEFAULT_NAMED = /\bimport\s+([\w$]+)\s*(?:,\s*\{([^}]*)\})?\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = DEFAULT_NAMED.exec(source)) !== null) {
    add(m[1], m[3], 'default', 'symbol');
    if (m[2]) for (const { exported, local } of splitNamed(m[2])) add(local, m[3], exported, 'symbol');
  }
  const NAMED = /\bimport\s*(?:type\s+)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]/g;
  while ((m = NAMED.exec(source)) !== null) {
    for (const { exported, local } of splitNamed(m[1])) add(local, m[2], exported, 'symbol');
  }
  const NS = /\bimport\s+\*\s+as\s+([\w$]+)\s+from\s*['"]([^'"]+)['"]/g;
  while ((m = NS.exec(source)) !== null) add(m[1], m[2], '*', 'namespace');

  // const x = require('./x') | const { a, b: c } = require('./x') | await import('./x')
  const REQ = /\b(?:const|let|var)\s+(\{[^}]*\}|[\w$]+)\s*=\s*(?:await\s+)?(?:require\(|import\()\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = REQ.exec(source)) !== null) {
    if (m[1].startsWith('{')) {
      for (const { exported, local } of splitNamed(m[1].slice(1, -1))) add(local, m[2], exported, 'symbol');
    } else {
      add(m[1], m[2], '*', 'namespace');
    }
  }
  const TS_REQ = /\bimport\s+([\w$]+)\s*=\s*require\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((m = TS_REQ.exec(source)) !== null) add(m[1], m[2], '*', 'namespace');
  return b;
}

function pythonBindings(file, source, known) {
  const b = new Map();
  let m;
  const IMP = /^[ \t]*import[ \t]+([\w.]+)(?:[ \t]+as[ \t]+(\w+))?/gm;
  while ((m = IMP.exec(source)) !== null) {
    const target = pythonPlugin.resolveModule(file, { module: m[1], level: 0 }, known);
    if (target) b.set(m[2] || m[1].split('.')[0], { file: target, exported: '*', type: 'namespace' });
  }
  const FROM = /^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+(\([^)]*\)|[^\n#]+)/gm;
  while ((m = FROM.exec(source)) !== null) {
    const raw = m[1];
    const level = raw.length - raw.replace(/^\.+/, '').length;
    const module = raw.replace(/^\.+/, '');
    for (const { exported, local } of m[2].replace(/[()]/g, '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => {
      const [e, l] = x.split(/\s+as\s+/);
      return { exported: e.trim(), local: (l || e).trim() };
    })) {
      if (exported === '*') continue;
      const sub = pythonPlugin.resolveModule(file, { module, level }, known, module ? `${module}.${exported}` : exported);
      if (sub) {
        b.set(local, { file: sub, exported: '*', type: 'namespace' });
        continue;
      }
      const target = pythonPlugin.resolveModule(file, { module, level }, known);
      if (target) b.set(local, { file: target, exported, type: 'symbol' });
    }
  }
  return b;
}

function javaStaticBindings(source, fileGraphResolve) {
  const b = new Map();
  const RE = /^\s*import\s+static\s+([\w.]+)\.(\w+)\s*;/gm;
  let m;
  while ((m = RE.exec(source)) !== null) {
    const target = fileGraphResolve(m[1]);
    if (target) b.set(m[2], { file: target, exported: m[2], type: 'symbol' });
  }
  return b;
}

// ---------------------------------------------------------------------
// Variable typing (receiver -> declared class)
// ---------------------------------------------------------------------

function collectVarTypes(masked, lang) {
  const types = new Map();
  const set = (name, type) => {
    if (!types.has(name) && !/^(?:string|number|boolean|any|void|int|long|double|float|char|byte|short)$/i.test(type)) {
      types.set(name, type);
    }
  };
  let m;
  if (lang === 'java') {
    const RE = /\b([A-Z]\w*)(?:<[^;(){}=]*?>)?(?:\[\])*\s+(\w+)\s*(?=[=;,)])/g;
    while ((m = RE.exec(masked)) !== null) {
      if (!JAVA_KEYWORDS.has(m[2])) set(m[2], m[1]);
    }
    const NEW = /\b(\w+)\s*=\s*new\s+([A-Z]\w*)/g;
    while ((m = NEW.exec(masked)) !== null) set(m[1], m[2]);
  } else if (lang === 'python') {
    const ANN = /\b(\w+)\s*:\s*(?:Optional\[)?([A-Z]\w*)/g;
    while ((m = ANN.exec(masked)) !== null) set(m[1], m[2]);
    const ASSIGN = /\b(?:self\.)?(\w+)\s*=\s*([A-Z]\w*)\s*\(/g;
    while ((m = ASSIGN.exec(masked)) !== null) set(m[1], m[2]);
    const ALIAS = /\bself\.(\w+)\s*=\s*(\w+)\s*$/gm;
    while ((m = ALIAS.exec(masked)) !== null) if (types.has(m[2])) set(m[1], types.get(m[2]));
  } else {
    const ANN = /([\w$]+)\s*[?!]?\s*:\s*([A-Z][\w$]*)/g;
    while ((m = ANN.exec(masked)) !== null) set(m[1], m[2]);
    const NEW = /\b([\w$]+)\s*=\s*new\s+([A-Z][\w$]*)/g;
    while ((m = NEW.exec(masked)) !== null) set(m[1], m[2]);
    const ALIAS = /\bthis\.([\w$]+)\s*=\s*([\w$]+)\s*;/g;
    while ((m = ALIAS.exec(masked)) !== null) if (types.has(m[2])) set(m[1], types.get(m[2]));
  }
  return types;
}

// ---------------------------------------------------------------------
// Graph assembly
// ---------------------------------------------------------------------

function exportAlias(source, exported) {
  const RE = /\bexport\s*\{([^}]*)\}/g;
  let m;
  while ((m = RE.exec(source)) !== null) {
    for (const { exported: local, local: alias } of splitNamed(m[1])) {
      if (alias === exported) return local;
    }
  }
  const MOD = /\bmodule\.exports\s*=\s*\{([^}]*)\}/g;
  while ((m = MOD.exec(source)) !== null) {
    for (const part of m[1].split(',')) {
      const [k, v] = part.split(':').map((s) => s.trim());
      if (k === exported && v && /^[\w$]+$/.test(v)) return v;
    }
  }
  return exported;
}

function defaultExportName(source) {
  let m = /\bexport\s+default\s+(?:async\s+)?(?:function\*?|class)?\s*([\w$]+)/.exec(source);
  if (m) return m[1];
  m = /\bmodule\.exports\s*=\s*([\w$]+)\s*;?/.exec(source);
  return m ? m[1] : null;
}

/**
 * @param {Map<string, {lang: string, parsed: object}>} parsedFiles  repo-relative path -> info
 *        (only files of languages supported here are used)
 * @param {{nodes: object[], edges: object[]}} fileGraph  the file-level graph
 * @returns {{nodes: object[], edges: object[]}}
 */
function buildFunctionGraph(parsedFiles, fileGraph) {
  const known = new Set(parsedFiles.keys());
  const outNeighbors = new Map();
  for (const e of fileGraph.edges) {
    if (!outNeighbors.has(e.from)) outNeighbors.set(e.from, new Set());
    outNeighbors.get(e.from).add(e.to);
  }

  // fqcn -> file for Java static imports
  const fqcnToFile = new Map();
  for (const [rel, info] of parsedFiles.entries()) {
    if (info.lang === 'java') {
      const p = info.parsed;
      fqcnToFile.set(p.package ? `${p.package}.${p.className}` : p.className, rel);
    }
  }

  // 1) extract
  const perFile = new Map();
  const allFns = [];
  for (const [rel, info] of parsedFiles.entries()) {
    const ex = extractFunctions(rel, info.parsed.rawSource, info.lang);
    const index = { top: new Map(), classes: new Map(), all: ex.fns, masked: ex.masked, lang: info.lang };
    for (const fn of ex.fns) {
      if (fn.className) {
        if (!index.classes.has(fn.className)) index.classes.set(fn.className, new Map());
        const cm = index.classes.get(fn.className);
        if (!cm.has(fn.name)) cm.set(fn.name, []);
        cm.get(fn.name).push(fn);
      } else {
        if (!index.top.has(fn.name)) index.top.set(fn.name, []);
        index.top.get(fn.name).push(fn);
      }
    }
    for (const cn of ex.classNames) if (!index.classes.has(cn)) index.classes.set(cn, new Map());
    perFile.set(rel, index);
    allFns.push(...ex.fns);
  }

  const pick = (fns, arity, lang) => {
    if (!fns || fns.length === 0) return [];
    if (lang !== 'java' || arity == null) return fns;
    const exact = fns.filter((f) => f.arity === arity);
    return exact.length ? exact : fns;
  };

  // 2) resolve calls
  const edgeMap = new Map();
  const addEdge = (from, to, confidence, line) => {
    if (from.id === to.id) return;
    const key = `${from.id}=>${to.id}`;
    const prev = edgeMap.get(key);
    if (!prev) {
      edgeMap.set(key, { from: from.id, to: to.id, kind: 'call', confidence, line });
    } else if (prev.confidence === 'medium' && confidence === 'high') {
      prev.confidence = 'high';
    }
  };

  for (const [rel, info] of parsedFiles.entries()) {
    const index = perFile.get(rel);
    const source = info.parsed.rawSource;
    const lineOf = makeLineOf(source);

    let bindings;
    if (info.lang === 'python') bindings = pythonBindings(rel, source, known);
    else if (info.lang === 'java') bindings = javaStaticBindings(source, (fq) => fqcnToFile.get(fq));
    else bindings = jsBindings(rel, source, known);

    const varTypes = collectVarTypes(index.masked, info.lang);
    const deps = outNeighbors.get(rel) || new Set();

    const resolveClasses = (clsName) => {
      const out = [];
      if (index.classes.has(clsName)) out.push({ file: rel, methods: index.classes.get(clsName) });
      const bnd = bindings.get(clsName);
      if (bnd && bnd.type === 'symbol') {
        const t = perFile.get(bnd.file);
        const exported = bnd.exported === 'default' ? defaultExportName(parsedFiles.get(bnd.file).parsed.rawSource) || clsName : exportAlias(parsedFiles.get(bnd.file).parsed.rawSource, bnd.exported);
        if (t && t.classes.has(exported)) out.push({ file: bnd.file, methods: t.classes.get(exported) });
      }
      for (const d of deps) {
        const t = perFile.get(d);
        if (t && t.classes.has(clsName) && !out.some((o) => o.file === d)) out.push({ file: d, methods: t.classes.get(clsName) });
      }
      return out;
    };

    const resolveBoundSymbol = (bnd, arity) => {
      const t = perFile.get(bnd.file);
      if (!t) return [];
      const src = parsedFiles.get(bnd.file).parsed.rawSource;
      let name = bnd.exported;
      if (name === 'default') name = defaultExportName(src) || name;
      else name = exportAlias(src, name);
      const hits = t.top.get(name);
      if (hits) return pick(hits, arity, t.lang);
      if (bnd.exported === 'default' && t.top.size === 1) return [...t.top.values()][0];
      return [];
    };

    const nameCandidatesInDeps = (method) => {
      const found = [];
      for (const d of deps) {
        const t = perFile.get(d);
        if (!t) continue;
        for (const fn of t.all) if (fn.name === method) found.push(fn);
      }
      return found;
    };

    const ctorName = (lang, cls) => (lang === 'python' ? '__init__' : lang === 'java' ? cls : 'constructor');

    for (const fn of index.all) {
      const body = index.masked.slice(fn._bodyStart, fn._bodyEnd);
      const baseOff = fn._bodyStart;
      const kw = keywordsFor(info.lang);
      let m;

      // new X(...)  -> X constructor
      const NEW = /\bnew\s+([A-Z][\w$]*)\s*(?:<[^()]*?>)?\s*\(/g;
      while ((m = NEW.exec(body)) !== null) {
        const line = lineOf(baseOff + m.index);
        for (const c of resolveClasses(m[1])) {
          const ctors = c.methods.get(ctorName(info.lang, m[1]));
          if (ctors) for (const t of ctors) addEdge(fn, t, 'high', line);
        }
      }

      // bare calls: foo(...)
      const BARE = /(?<![\w$.])([A-Za-z_$][\w$]*)\s*\(/g;
      while ((m = BARE.exec(body)) !== null) {
        const name = m[1];
        if (kw.has(name)) continue;
        const before = body.slice(Math.max(0, m.index - 12), m.index);
        if (/\b(?:function|def|class|new)\s+$/.test(before)) continue;
        const parenOpen = baseOff + m.index + m[0].length - 1;
        const parenClose = matchClose(index.masked, parenOpen, '(', ')');
        const arity = parenClose < 0 ? null : countArgs(index.masked.slice(parenOpen + 1, parenClose));
        const line = lineOf(baseOff + m.index);
        let targets = [];

        if (info.lang === 'java' || info.lang === 'python') {
          // own class first (implicit this)
          if (fn.className && index.classes.get(fn.className)) {
            targets = pick(index.classes.get(fn.className).get(name), arity, info.lang);
          }
        }
        if (targets.length === 0) targets = pick(index.top.get(name), arity, info.lang);
        if (targets.length === 0 && info.lang === 'java') {
          // nested/other classes in same file
          for (const methods of index.classes.values()) {
            const hit = pick(methods.get(name), arity, 'java');
            if (hit.length) { targets = hit; break; }
          }
        }
        if (targets.length === 0 && bindings.has(name)) {
          const bnd = bindings.get(name);
          if (bnd.type === 'symbol') targets = resolveBoundSymbol(bnd, arity);
          if (targets.length === 0 && bnd.type === 'symbol') {
            // imported class used as a callable (Python Foo(...))
            const classHit = resolveClasses(name);
            for (const c of classHit) {
              const ctors = c.methods.get(ctorName(info.lang, name));
              if (ctors) targets.push(...ctors);
            }
          }
        }
        if (targets.length === 0 && info.lang === 'python' && /^[A-Z]/.test(name)) {
          for (const c of resolveClasses(name)) {
            const ctors = c.methods.get('__init__');
            if (ctors) targets.push(...ctors);
          }
        }
        for (const t of targets) addEdge(fn, t, 'high', line);
      }

      // qualified calls: recv.method(...)
      const QUAL = /(?<![\w$.])(this\.[\w$]+|self\.[\w$]+|[A-Za-z_$][\w$]*)\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)\s*\(/g;
      while ((m = QUAL.exec(body)) !== null) {
        const recvRaw = m[1];
        const method = m[2];
        if (kw.has(method)) continue;
        const parenOpen = baseOff + m.index + m[0].length - 1;
        const parenClose = matchClose(index.masked, parenOpen, '(', ')');
        const arity = parenClose < 0 ? null : countArgs(index.masked.slice(parenOpen + 1, parenClose));
        const line = lineOf(baseOff + m.index);

        let targets = [];
        let confidence = 'high';

        if (recvRaw === 'this' || recvRaw === 'self' || recvRaw === 'cls') {
          if (fn.className && index.classes.get(fn.className)) {
            targets = pick(index.classes.get(fn.className).get(method), arity, info.lang);
          }
        } else if (recvRaw === 'super') {
          continue;
        } else {
          const recv = recvRaw.replace(/^(?:this|self)\./, '');
          const viaThis = recv !== recvRaw;

          // (a) namespace / bound symbol
          const bnd = !viaThis ? bindings.get(recv) : null;
          if (bnd && bnd.type === 'namespace') {
            const t = perFile.get(bnd.file);
            if (t) {
              targets = pick(t.top.get(method), arity, t.lang);
              if (targets.length === 0 && t.classes.size === 1) {
                targets = pick([...t.classes.values()][0].get(method), arity, t.lang);
              }
            }
          } else if (bnd && bnd.type === 'symbol') {
            // imported class / object: Foo.method()
            for (const c of resolveClasses(recv)) targets.push(...pick(c.methods.get(method), arity, info.lang));
          }

          // (b) capitalized receiver = class name (static call)
          if (targets.length === 0 && !viaThis && /^[A-Z]/.test(recv)) {
            for (const c of resolveClasses(recv)) targets.push(...pick(c.methods.get(method), arity, info.lang));
          }

          // (c) variable with declared/inferred type
          if (targets.length === 0 && varTypes.has(recv)) {
            for (const c of resolveClasses(varTypes.get(recv))) targets.push(...pick(c.methods.get(method), arity, info.lang));
          }

          // (d) medium-confidence fallback: unique method name in dependency files
          if (targets.length === 0 && !bnd && !/^[A-Z]/.test(recv) && !varTypes.has(recv)) {
            const cands = nameCandidatesInDeps(method).filter((f) => f.className);
            if (cands.length === 1) {
              targets = cands;
              confidence = 'medium';
            }
          }
        }
        for (const t of targets) addEdge(fn, t, confidence, line);
      }
    }
  }

  const nodes = allFns
    .map((f) => ({
      id: f.id, file: f.file, name: f.name, className: f.className, kind: f.kind,
      startLine: f.startLine, endLine: f.endLine, arity: f.arity,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  const edges = [...edgeMap.values()].sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return { nodes, edges };
}

// ---------------------------------------------------------------------
// Function-level impact
// ---------------------------------------------------------------------

function adjacency(fgraph) {
  const fwd = new Map();
  const back = new Map();
  for (const n of fgraph.nodes) {
    fwd.set(n.id, []);
    back.set(n.id, []);
  }
  for (const e of fgraph.edges) {
    if (!fwd.has(e.from)) fwd.set(e.from, []);
    if (!back.has(e.to)) back.set(e.to, []);
    if (!fwd.has(e.to)) fwd.set(e.to, []);
    if (!back.has(e.from)) back.set(e.from, []);
    fwd.get(e.from).push(e.to);
    back.get(e.to).push(e.from);
  }
  return { fwd, back };
}

/**
 * For one function id:
 *   callees  — functions it calls directly        (distance-1 forward)
 *   callers  — functions that call it directly    (distance-1 backward)
 *   affected — every transitively reachable function, tagged
 *              { id, relation: 'callee'|'caller', distance }
 * Mirrors computeImpact() at file level.
 */
function computeFunctionImpact(fgraph, functionId, adj = adjacency(fgraph)) {
  const callees = [...(adj.fwd.get(functionId) || [])].sort();
  const callers = [...(adj.back.get(functionId) || [])].sort();
  const best = new Map();

  function bfs(adjMap, relation) {
    const visited = new Set([functionId]);
    let frontier = [functionId];
    let distance = 0;
    while (frontier.length) {
      distance += 1;
      const next = [];
      for (const cur of frontier) {
        for (const nb of adjMap.get(cur) || []) {
          if (visited.has(nb)) continue;
          visited.add(nb);
          next.push(nb);
          const ex = best.get(nb);
          if (!ex || ex.distance > distance) best.set(nb, { id: nb, relation, distance });
        }
      }
      frontier = next;
    }
  }
  bfs(adj.fwd, 'callee');
  bfs(adj.back, 'caller');

  const affected = [...best.values()].sort((a, b) => a.distance - b.distance || a.id.localeCompare(b.id));
  return { id: functionId, callers, callees, affected };
}

/**
 * Shortest call path from `fromId` to `toId` (follows call direction).
 * Useful for bug localization: "how does the controller reach this
 * failing repository method?". Returns [] if unreachable.
 */
function shortestCallPath(fgraph, fromId, toId) {
  if (fromId === toId) return [fromId];
  const { fwd } = adjacency(fgraph);
  const prev = new Map([[fromId, null]]);
  let frontier = [fromId];
  while (frontier.length) {
    const next = [];
    for (const cur of frontier) {
      for (const nb of fwd.get(cur) || []) {
        if (prev.has(nb)) continue;
        prev.set(nb, cur);
        if (nb === toId) {
          const out = [];
          for (let at = toId; at !== null; at = prev.get(at)) out.unshift(at);
          return out;
        }
        next.push(nb);
      }
    }
    frontier = next;
  }
  return [];
}

/** Looks up a function id by exact id, or by (file, name) / bare name. */
function findFunctionIds(fgraph, query, file) {
  const exact = fgraph.nodes.find((n) => n.id === query);
  if (exact) return [exact.id];
  return fgraph.nodes
    .filter((n) => (n.name === query || `${n.className}.${n.name}` === query) && (!file || n.file === file))
    .map((n) => n.id);
}

module.exports = {
  maskSource,
  extractFunctions,
  buildFunctionGraph,
  computeFunctionImpact,
  shortestCallPath,
  findFunctionIds,
  adjacency,
};
