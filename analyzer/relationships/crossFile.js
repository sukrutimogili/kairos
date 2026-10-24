#!/usr/bin/env node
/**
 * Kairos analyzer — cross-file and non-code relationship mapping.
 *
 * Adds HTML / template / stylesheet / config files to the graph as nodes
 * (with `fileType`) and connects them to code through relationships that
 * are NOT imports. Direction convention is unchanged: edge.from depends on
 * edge.to.
 *
 * Edge kinds produced (all carry an optional `detail` string saying WHY):
 *
 *   html-script       html/template  -> js/ts/py   <script src="...">
 *   html-style        html/template  -> css        <link rel=stylesheet href="...">
 *   html-link         html           -> html       <a href> / <iframe src> to a local page
 *   style-import      css            -> css        @import
 *   dom-reference     js/ts          -> html       getElementById('x'), querySelector('#x' / '.c'), $('#x')
 *   template-render   code           -> template   render_template('x.html'), res.render('x'), ModelAndView("x"),
 *                                                   string literal naming a template file
 *   template-include  template       -> template   {% include %}, {% extends %}, <%- include() %>, {{> partial}},
 *                                                   th:replace, @include
 *   template-call     html/template  -> js/py      onclick="fn()", @click="fn", (click)="fn()", ng-click, url_for('endpoint')
 *   config-reference  code           -> config     process.env.X, os.getenv('X'), @Value("${a.b}"),
 *                                                   System.getenv("X"), config.get('a.b')
 *   file-reference    code           -> config/css string literal naming a file ("config.json", "classpath:app.properties")
 *   config-binding    config         -> code       package.json main/bin/scripts, fully-qualified Java class names,
 *                                                   package names, entry-point file paths and `node x.js` /
 *                                                   `python app.py` commands inside config files
 *
 * Everything is heuristic and over-approximating on purpose ("potentially
 * affected"); every edge records its evidence in `detail`.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { extractFunctions } = require('../functions/functionGraph');

const SKIP_DIRS = new Set([
  'node_modules', 'out', 'dist', 'target', '.git', '.vscode-test', 'build',
  '__pycache__', 'venv', '.venv', 'coverage', '.next', '.nuxt', 'site-packages', 'reports',
]);
const SKIP_FILES = new Set([
  'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'composer.lock',
]);
const MAX_BYTES = 512 * 1024;

const TYPE_BY_EXT = {
  '.html': 'html', '.htm': 'html',
  '.ejs': 'template', '.hbs': 'template', '.handlebars': 'template', '.jinja': 'template',
  '.jinja2': 'template', '.j2': 'template', '.njk': 'template', '.pug': 'template',
  '.css': 'style', '.scss': 'style', '.less': 'style',
  '.json': 'config', '.yml': 'config', '.yaml': 'config', '.properties': 'config',
  '.toml': 'config', '.ini': 'config', '.xml': 'config', '.env': 'config', '.cfg': 'config',
};
const TYPE_BY_NAME = { Procfile: 'config', Dockerfile: 'config' };

const TEMPLATE_MARKERS = /\{\{|\{%|<%|th:|@include|@extends/;

function fileTypeOf(absPath) {
  const base = path.basename(absPath);
  if (TYPE_BY_NAME[base]) return TYPE_BY_NAME[base];
  if (base === '.env' || base.startsWith('.env.')) return 'config';
  return TYPE_BY_EXT[path.extname(base).toLowerCase()] || null;
}

/** True if this path is a non-code file kind Kairos can place in the graph. */
function isCrossFileType(absPath) {
  return fileTypeOf(absPath) !== null;
}

function findNonCodeFiles(repoRoot) {
  const out = [];
  (function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.')) continue;
        walk(full);
      } else if (entry.isFile()) {
        if (SKIP_FILES.has(entry.name)) continue;
        const ft = fileTypeOf(full);
        if (!ft) continue;
        let stat;
        try { stat = fs.statSync(full); } catch { continue; }
        if (stat.size > MAX_BYTES) continue;
        const rel = path.relative(repoRoot, full).split(path.sep).join('/');
        const source = fs.readFileSync(full, 'utf8');
        let fileType = ft;
        if (ft === 'html' && TEMPLATE_MARKERS.test(source)) fileType = 'template';
        out.push({ rel, fileType, source, ext: path.extname(entry.name).toLowerCase() });
      }
    }
  })(repoRoot);
  return out.sort((a, b) => a.rel.localeCompare(b.rel));
}

// ---------------------------------------------------------------------
// Resolution helpers
// ---------------------------------------------------------------------

function commonPrefixLen(a, b) {
  const as = a.split('/');
  const bs = b.split('/');
  let i = 0;
  while (i < as.length - 1 && i < bs.length - 1 && as[i] === bs[i]) i++;
  return i;
}

function bestOf(fromRel, matches) {
  return [...matches].sort(
    (x, y) => commonPrefixLen(fromRel, y) - commonPrefixLen(fromRel, x) || x.length - y.length || x.localeCompare(y)
  )[0];
}

/** Resolve a path-like reference found in `fromRel` to a known repo file. */
function resolveRef(fromRel, ref, universeSet, universeList) {
  let r = String(ref).split(/[?#]/)[0].trim();
  if (!r) return null;
  if (/^(?:[a-z][a-z0-9+.-]*:)?\/\//i.test(r) || /^(?:data|mailto|javascript|tel|http|https):/i.test(r)) return null;
  r = r.replace(/^(?:classpath\*?|file):/, '');
  const absolute = r.startsWith('/');
  const clean = path.posix.normalize(r.replace(/^\/+/, '')).replace(/^(?:\.\.\/)+/, '').replace(/^\.\//, '');
  if (!clean || clean === '.') return null;

  const cands = [];
  if (!absolute) cands.push(path.posix.normalize(path.posix.join(path.posix.dirname(fromRel), r)));
  cands.push(clean);
  for (const c of cands) if (universeSet.has(c)) return c;

  const suffix = `/${clean}`;
  const matches = universeList.filter((k) => k.endsWith(suffix));
  if (matches.length === 0) return null;
  return matches.length === 1 ? matches[0] : bestOf(fromRel, matches);
}

const PREFERRED_TEMPLATE_DIRS = /(?:^|\/)(?:views|templates|pages|partials|layouts|fragments)(?:\/|$)/;

/** Resolve a template NAME ('index', 'fragments/header', 'users/list.html'). */
function resolveTemplateName(fromRel, name, templateFiles) {
  const n = String(name).trim().replace(/^\/+/, '').replace(/^~?\{|\}$/g, '');
  if (!n) return null;
  const strip = (p) => p.replace(/\.[^./]+$/, '');
  const hasExt = /\.[a-z0-9]+$/i.test(n);
  const matches = templateFiles.filter((t) => {
    if (hasExt) return t === n || t.endsWith(`/${n}`);
    const noExt = strip(t);
    return noExt === n || noExt.endsWith(`/${n}`);
  });
  if (matches.length === 0) return null;
  if (matches.length === 1) return matches[0];
  const preferred = matches.filter((m) => PREFERRED_TEMPLATE_DIRS.test(m));
  return bestOf(fromRel, preferred.length ? preferred : matches);
}

// ---------------------------------------------------------------------
// Definition indexes (HTML ids/classes, config keys)
// ---------------------------------------------------------------------

function indexHtmlDefinitions(htmlLike) {
  const ids = new Map();
  const classes = new Map();
  const add = (map, key, file) => {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(file);
  };
  for (const f of htmlLike) {
    let m;
    const ID = /\bid\s*=\s*["']([^"'{}]+)["']/gi;
    while ((m = ID.exec(f.source)) !== null) add(ids, m[1].trim(), f.rel);
    const CLS = /\bclass\s*=\s*["']([^"'{}]+)["']/gi;
    while ((m = CLS.exec(f.source)) !== null) {
      for (const c of m[1].split(/\s+/)) if (c) add(classes, c, f.rel);
    }
  }
  return { ids, classes };
}

const normKey = (k) => String(k).toLowerCase().replace(/[._\-\s]/g, '');

function flattenJson(value, prefix, out, depth = 0) {
  if (depth > 6 || value === null || typeof value !== 'object') return;
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    out.push(key);
    if (v && typeof v === 'object' && !Array.isArray(v)) flattenJson(v, key, out, depth + 1);
  }
}

function flattenYaml(source) {
  const keys = [];
  const stack = []; // [{indent, key}]
  for (const raw of source.split('\n')) {
    if (!raw.trim() || raw.trim().startsWith('#') || raw.trim().startsWith('- ') || raw.trim() === '---') continue;
    const m = /^(\s*)([\w.\-/"']+)\s*:(?:\s|$)/.exec(raw);
    if (!m) continue;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    const key = m[2].replace(/["']/g, '');
    stack.push({ indent, key });
    keys.push(stack.map((s) => s.key).join('.'));
  }
  return keys;
}

function configKeysOf(file) {
  const base = path.basename(file.rel);
  if (base === 'package.json' || base === 'composer.json' || base === 'tsconfig.json') return [];
  try {
    if (file.ext === '.json') {
      const out = [];
      flattenJson(JSON.parse(file.source), '', out);
      return out;
    }
  } catch { return []; }
  if (file.ext === '.yml' || file.ext === '.yaml') return flattenYaml(file.source);
  if (file.ext === '.properties' || file.ext === '.env' || base === '.env' || base.startsWith('.env.') ||
      file.ext === '.ini' || file.ext === '.cfg' || file.ext === '.toml') {
    const keys = [];
    let section = '';
    for (const line of file.source.split('\n')) {
      const sec = /^\s*\[([^\]]+)\]/.exec(line);
      if (sec) { section = sec[1].trim(); continue; }
      const m = /^\s*(?:export\s+)?([A-Za-z_][\w.\-]*)\s*[=:]/.exec(line);
      if (m && !line.trim().startsWith('#') && !line.trim().startsWith(';')) {
        keys.push(m[1]);
        if (section) keys.push(`${section}.${m[1]}`);
      }
    }
    return keys;
  }
  return [];
}

// ---------------------------------------------------------------------
// Reference patterns inside CODE files
// ---------------------------------------------------------------------

const DOM_ID_RES = [
  /\bgetElementById\(\s*['"`]([^'"`]+)['"`]/g,
];
const DOM_CLASS_RES = [
  /\bgetElementsByClassName\(\s*['"`]([^'"`]+)['"`]/g,
];
const DOM_SELECTOR_RES = [
  /\bquerySelector(?:All)?\(\s*['"`]([^'"`]+)['"`]/g,
  /(?<![\w$])\$\(\s*['"`]([#.][^'"`]+)['"`]/g,
  /\bjQuery\(\s*['"`]([#.][^'"`]+)['"`]/g,
  /\.closest\(\s*['"`]([^'"`]+)['"`]/g,
];

const CONFIG_KEY_RES = {
  typescript: [
    /\bprocess\.env\.([A-Za-z_]\w*)/g,
    /\bprocess\.env\[\s*['"]([^'"]+)['"]\s*\]/g,
    /\bimport\.meta\.env\.([A-Za-z_]\w*)/g,
    /\b(?:config|cfg|settings|conf|nconf|env)\.(?:get|getString|getInt|getBoolean|getNumber|require)\(\s*['"]([^'"]+)['"]/g,
  ],
  python: [
    /\bos\.environ\[\s*['"]([^'"]+)['"]\s*\]/g,
    /\bos\.environ\.get\(\s*['"]([^'"]+)['"]/g,
    /\bos\.getenv\(\s*['"]([^'"]+)['"]/g,
    /\b(?:config|cfg|settings|conf)(?:\.get)?\[\s*['"]([^'"]+)['"]\s*\]/g,
    /\b(?:config|cfg|settings|conf)\.get\(\s*['"]([^'"]+)['"]/g,
  ],
  java: [
    /@Value\(\s*"\$\{\s*([^}:"]+)/g,
    /\bSystem\.getenv\(\s*"([^"]+)"/g,
    /\b(?:getProperty|getRequiredProperty|getString|getInt|getBoolean)\(\s*"([^"]+)"/g,
  ],
};
const CONFIG_PREFIX_RE = /@ConfigurationProperties\(\s*(?:(?:prefix|value)\s*=\s*)?"([^"]+)"/g;

const FILE_LITERAL_RE =
  /(['"`])([^'"`\n]{1,200}?\.(?:json|ya?ml|properties|toml|ini|cfg|xml|env|html?|ejs|hbs|handlebars|jinja2?|j2|njk|css|scss|less))\1/gi;

const RENDER_RES = [
  /\brender_template\(\s*['"]([^'"]+)['"]/g, // Flask
  /\brender_template_string\b/g, // (no name, ignored)
  /\brender\(\s*(?:request|req)\s*,\s*['"]([^'"]+)['"]/g, // Django
  /\b(?:res|response)\.render\(\s*['"]([^'"]+)['"]/g, // Express
  /\bnew\s+ModelAndView\(\s*"([^"]+)"/g, // Spring MVC
  /\bview\(\s*['"]([^'"]+)['"]/g, // Laravel-style
];

// ---------------------------------------------------------------------
// Reference patterns inside HTML / templates
// ---------------------------------------------------------------------

// Attribute values may contain the other quote type ({{ url_for('static', ...) }}),
// so match "..." and '...' as separate alternatives.
const SCRIPT_SRC_RE = /<script\b[^>]*?\bsrc\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
const LINK_TAG_RE = /<link\b[^>]*>/gi;
const HREF_ATTR_RE = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)')/i;
const REL_STYLESHEET_RE = /\brel\s*=\s*["']stylesheet["']/i;
const HTML_LINK_RE = /<(?:a|iframe|form)\b[^>]*?\b(?:href|src|action)\s*=\s*["']([^"'#?]+\.html?)(?:[?#][^"']*)?["']/gi;
const FLASK_STATIC_RE = /filename\s*=\s*['"]([^'"]+)['"]/;
const CSS_IMPORT_RE = /@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?/gi;

const INCLUDE_RES = [
  /\{%-?\s*(?:include|extends|import|from)\s+['"]([^'"]+)['"]/g, // Jinja / Django / Nunjucks
  /<%[-=#_]?\s*include\(?\s*['"]([^'"]+)['"]/g, // EJS
  /\{\{>\s*([\w/.\-]+)/g, // Handlebars partials
  /\bth:(?:replace|insert|include)\s*=\s*["']~?\{?\s*([^\s:}"']+)/g, // Thymeleaf
  /\blayout:decorate\s*=\s*["']~?\{?\s*([^\s:}"']+)/g,
  /@(?:include|extends)\(\s*['"]([^'"]+)['"]/g, // Blade
];

const HANDLER_RE =
  /(?:\bon(?:click|change|submit|input|load|keyup|keydown|keypress|focus|blur|dblclick|mouseover|mouseout)|\(click\)|\(change\)|\(submit\)|@click|@change|@submit|v-on:(?:click|change|submit)|ng-(?:click|change|submit)|th:onclick)\s*=\s*["']\s*([A-Za-z_$][\w$.]*)/gi;
const URL_FOR_RE = /\burl_for\(\s*['"]([\w.]+)['"]/g;

// ---------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------

/**
 * @param {string} repoRoot
 * @param {Map<string, {lang: string, parsed: object}>} parsedFiles code files already parsed by the core
 * @param {object[]} existingNodes graph.nodes from the code-only pass
 * @returns {{nodes: object[], edges: object[], templateCalls: object[]}}
 */
function buildCrossFileGraph(repoRoot, parsedFiles) {
  const nonCode = findNonCodeFiles(repoRoot);
  const nodes = nonCode.map((f) => ({
    id: f.rel,
    className: path.posix.basename(f.rel),
    package: '',
    fileType: f.fileType,
  }));

  const codeIds = [...parsedFiles.keys()];
  const allIds = [...codeIds, ...nonCode.map((f) => f.rel)];
  const universeSet = new Set(allIds);
  const nonCodeSet = new Set(nonCode.map((f) => f.rel));
  const nonCodeList = [...nonCodeSet];
  const templateFiles = nonCode.filter((f) => f.fileType === 'html' || f.fileType === 'template').map((f) => f.rel);
  const htmlLike = nonCode.filter((f) => f.fileType === 'html' || f.fileType === 'template');
  const configFiles = nonCode.filter((f) => f.fileType === 'config');

  const edgeMap = new Map();
  const addEdge = (from, to, kind, detail) => {
    if (from === to) return;
    const key = `${from}=>${to}`;
    const prev = edgeMap.get(key);
    if (!prev) {
      edgeMap.set(key, { from, to, kind, detail: detail ? [detail] : [] });
    } else if (detail && !prev.detail.includes(detail) && prev.detail.length < 5) {
      prev.detail.push(detail);
    }
  };

  // --- indexes --------------------------------------------------------
  const { ids: htmlIds, classes: htmlClasses } = indexHtmlDefinitions(htmlLike);

  const configKeyIndex = new Map(); // normalized key -> Set(configFile)
  const configKeysByFile = new Map();
  for (const cf of configFiles) {
    const keys = configKeysOf(cf);
    configKeysByFile.set(cf.rel, keys);
    for (const k of keys) {
      const nk = normKey(k);
      if (!configKeyIndex.has(nk)) configKeyIndex.set(nk, new Set());
      configKeyIndex.get(nk).add(cf.rel);
    }
  }

  // JS/TS function names per file (for template-call resolution)
  const functionsByFile = new Map();
  const functionNames = (rel) => {
    if (!functionsByFile.has(rel)) {
      const info = parsedFiles.get(rel);
      const names = new Map();
      if (info) {
        const ex = extractFunctions(rel, info.parsed.rawSource, info.lang);
        for (const fn of ex.fns) {
          if (!names.has(fn.name)) names.set(fn.name, []);
          names.get(fn.name).push(fn);
        }
      }
      functionsByFile.set(rel, names);
    }
    return functionsByFile.get(rel);
  };

  // --- (1) html/template -> code, css, html, templates ---------------
  const scriptsLoadedBy = new Map(); // html -> Set(code files)
  const templateCalls = [];

  for (const f of htmlLike) {
    let m;
    SCRIPT_SRC_RE.lastIndex = 0;
    while ((m = SCRIPT_SRC_RE.exec(f.source)) !== null) {
      const rawSrc = m[1] !== undefined ? m[1] : m[2];
      let ref = rawSrc;
      const flask = FLASK_STATIC_RE.exec(ref);
      if (flask) ref = flask[1];
      if (/\{\{|\{%|<%/.test(ref) && !flask) continue;
      const target = resolveRef(f.rel, ref, universeSet, allIds);
      if (target && parsedFiles.has(target)) {
        addEdge(f.rel, target, 'html-script', `<script src="${rawSrc.slice(0, 60)}">`);
        if (!scriptsLoadedBy.has(f.rel)) scriptsLoadedBy.set(f.rel, new Set());
        scriptsLoadedBy.get(f.rel).add(target);
      }
    }

    LINK_TAG_RE.lastIndex = 0;
    while ((m = LINK_TAG_RE.exec(f.source)) !== null) {
      const href = HREF_ATTR_RE.exec(m[0]);
      if (!href) continue;
      const rawHref = href[1] !== undefined ? href[1] : href[2];
      let ref = rawHref;
      const flask = FLASK_STATIC_RE.exec(ref);
      if (flask) ref = flask[1];
      if (!REL_STYLESHEET_RE.test(m[0]) && !/\.(?:css|scss|less)(?:[?#]|$)/i.test(ref)) continue;
      if (/\{\{|\{%|<%/.test(ref) && !flask) continue;
      const target = resolveRef(f.rel, ref, universeSet, nonCodeList);
      if (target && target.match(/\.(?:css|scss|less)$/i)) addEdge(f.rel, target, 'html-style', `<link href="${rawHref.slice(0, 60)}">`);
    }

    HTML_LINK_RE.lastIndex = 0;
    while ((m = HTML_LINK_RE.exec(f.source)) !== null) {
      const target = resolveRef(f.rel, m[1], universeSet, nonCodeList);
      if (target && htmlLike.some((h) => h.rel === target)) addEdge(f.rel, target, 'html-link', m[1].slice(0, 60));
    }

    for (const re of INCLUDE_RES) {
      re.lastIndex = 0;
      while ((m = re.exec(f.source)) !== null) {
        const target = resolveTemplateName(f.rel, m[1], templateFiles);
        if (target) addEdge(f.rel, target, 'template-include', m[1].slice(0, 60));
      }
    }

    HANDLER_RE.lastIndex = 0;
    while ((m = HANDLER_RE.exec(f.source)) !== null) {
      const full = m[1];
      const name = full.split('.').pop();
      const line = f.source.slice(0, m.index).split('\n').length;
      const loaded = scriptsLoadedBy.get(f.rel) || new Set();
      let candidates = [...loaded].filter((c) => functionNames(c).has(name));
      if (candidates.length === 0) {
        candidates = codeIds.filter((c) => /\.(?:js|jsx|ts|tsx)$/.test(c) && functionNames(c).has(name));
      }
      for (const c of candidates) addEdge(f.rel, c, 'template-call', `${name}()`);
      if (candidates.length) templateCalls.push({ file: f.rel, name, line, targets: candidates });
    }

    URL_FOR_RE.lastIndex = 0;
    while ((m = URL_FOR_RE.exec(f.source)) !== null) {
      if (m[1] === 'static') continue;
      const name = m[1].split('.').pop();
      const line = f.source.slice(0, m.index).split('\n').length;
      const candidates = codeIds.filter((c) => c.endsWith('.py') && functionNames(c).has(name));
      for (const c of candidates) addEdge(f.rel, c, 'template-call', `url_for('${m[1]}')`);
      if (candidates.length) templateCalls.push({ file: f.rel, name, line, targets: candidates });
    }
  }

  // --- (2) css @import -----------------------------------------------
  for (const f of nonCode.filter((x) => x.fileType === 'style')) {
    let m;
    CSS_IMPORT_RE.lastIndex = 0;
    while ((m = CSS_IMPORT_RE.exec(f.source)) !== null) {
      const target = resolveRef(f.rel, m[1], universeSet, nonCodeList);
      if (target && /\.(?:css|scss|less)$/i.test(target)) addEdge(f.rel, target, 'style-import', `@import ${m[1].slice(0, 50)}`);
    }
  }

  // --- (3) code -> html / template / config / css --------------------
  for (const [rel, info] of parsedFiles.entries()) {
    const src = info.parsed.rawSource;
    const lang = info.lang;
    let m;

    // dom-reference (JS/TS only)
    if (lang === 'typescript') {
      const loadedBy = htmlLike.filter((h) => (scriptsLoadedBy.get(h.rel) || new Set()).has(rel)).map((h) => h.rel);
      const link = (map, key, label) => {
        const files = map.get(key);
        if (!files) return;
        let targets = [...files];
        const narrowed = targets.filter((t) => loadedBy.includes(t));
        if (narrowed.length) targets = narrowed;
        for (const t of targets) addEdge(rel, t, 'dom-reference', label);
      };
      for (const re of DOM_ID_RES) {
        re.lastIndex = 0;
        while ((m = re.exec(src)) !== null) link(htmlIds, m[1], `#${m[1]}`);
      }
      for (const re of DOM_CLASS_RES) {
        re.lastIndex = 0;
        while ((m = re.exec(src)) !== null) for (const c of m[1].split(/\s+/)) link(htmlClasses, c, `.${c}`);
      }
      for (const re of DOM_SELECTOR_RES) {
        re.lastIndex = 0;
        while ((m = re.exec(src)) !== null) {
          const sel = m[1];
          for (const idm of sel.matchAll(/#([\w-]+)/g)) link(htmlIds, idm[1], `#${idm[1]}`);
          for (const cm of sel.matchAll(/\.([\w-]+)/g)) link(htmlClasses, cm[1], `.${cm[1]}`);
        }
      }
    }

    // config-reference
    for (const re of CONFIG_KEY_RES[lang] || []) {
      re.lastIndex = 0;
      while ((m = re.exec(src)) !== null) {
        const files = configKeyIndex.get(normKey(m[1]));
        if (files) for (const cf of files) addEdge(rel, cf, 'config-reference', m[1].slice(0, 60));
      }
    }
    if (lang === 'java') {
      CONFIG_PREFIX_RE.lastIndex = 0;
      while ((m = CONFIG_PREFIX_RE.exec(src)) !== null) {
        const prefix = normKey(m[1]);
        for (const [rawFile, keys] of configKeysByFile.entries()) {
          if (keys.some((k) => normKey(k).startsWith(prefix))) addEdge(rel, rawFile, 'config-reference', `prefix ${m[1]}`);
        }
      }
    }

    // template-render by name
    for (const re of RENDER_RES) {
      re.lastIndex = 0;
      while ((m = re.exec(src)) !== null) {
        if (!m[1]) continue;
        const target = resolveTemplateName(rel, m[1], templateFiles);
        if (target) addEdge(rel, target, 'template-render', m[1].slice(0, 60));
      }
    }

    // file-reference by string literal
    FILE_LITERAL_RE.lastIndex = 0;
    while ((m = FILE_LITERAL_RE.exec(src)) !== null) {
      const lit = m[2];
      if (/\$\{|\{\{/.test(lit)) continue;
      const target = resolveRef(rel, lit, nonCodeSet, nonCodeList);
      if (!target) continue;
      const tType = nonCode.find((x) => x.rel === target).fileType;
      const kind = tType === 'html' || tType === 'template' ? 'template-render' : 'file-reference';
      addEdge(rel, target, kind, lit.slice(0, 60));
    }
  }

  // --- (4) config -> code --------------------------------------------
  const fqcnIndex = new Map();
  const packageIndex = new Map();
  for (const [rel, info] of parsedFiles.entries()) {
    if (info.lang !== 'java') continue;
    const p = info.parsed;
    fqcnIndex.set(p.package ? `${p.package}.${p.className}` : p.className, rel);
    if (p.package) {
      if (!packageIndex.has(p.package)) packageIndex.set(p.package, []);
      packageIndex.get(p.package).push(rel);
    }
  }
  const CODE_PATH_RE = /^[\w./@-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py)$/;
  const COMMAND_RE =
    /\b(?:node|ts-node|tsx|nodemon|python3?|electron|deno run|bun(?: run)?)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w./@-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py))\b/g;
  const CODE_ONLY_UNIVERSE = new Set(codeIds);

  for (const cf of configFiles) {
    const base = path.posix.basename(cf.rel);

    if (base === 'package.json') {
      try {
        const pkg = JSON.parse(cf.source);
        const fields = [];
        if (typeof pkg.main === 'string') fields.push(['main', pkg.main]);
        if (typeof pkg.module === 'string') fields.push(['module', pkg.module]);
        if (typeof pkg.bin === 'string') fields.push(['bin', pkg.bin]);
        else if (pkg.bin && typeof pkg.bin === 'object') for (const [k, v] of Object.entries(pkg.bin)) fields.push([`bin.${k}`, v]);
        for (const [label, ref] of fields) {
          const t = resolveRef(cf.rel, ref, CODE_ONLY_UNIVERSE, codeIds);
          if (t) addEdge(cf.rel, t, 'config-binding', label);
        }
        for (const [name, cmd] of Object.entries(pkg.scripts || {})) {
          COMMAND_RE.lastIndex = 0;
          let m;
          while ((m = COMMAND_RE.exec(String(cmd))) !== null) {
            const t = resolveRef(cf.rel, m[1], CODE_ONLY_UNIVERSE, codeIds);
            if (t) addEdge(cf.rel, t, 'config-binding', `scripts.${name}`);
          }
        }
      } catch { /* malformed package.json: ignore */ }
      continue;
    }

    let m;
    // fully-qualified Java class names
    const FQCN = /\b((?:[a-z][a-z0-9_]*\.)+[A-Z]\w*)\b/g;
    while ((m = FQCN.exec(cf.source)) !== null) {
      const t = fqcnIndex.get(m[1]);
      if (t) addEdge(cf.rel, t, 'config-binding', m[1]);
    }
    // Java package names (e.g. logging.level.<package>, component scan)
    const PKG = /\b([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*){2,})\b/g;
    while ((m = PKG.exec(cf.source)) !== null) {
      const files = packageIndex.get(m[1]);
      if (files && files.length <= 25) for (const t of files) addEdge(cf.rel, t, 'config-binding', `package ${m[1]}`);
    }
    // commands: node server.js / python app.py
    COMMAND_RE.lastIndex = 0;
    while ((m = COMMAND_RE.exec(cf.source)) !== null) {
      const t = resolveRef(cf.rel, m[1], CODE_ONLY_UNIVERSE, codeIds);
      if (t) addEdge(cf.rel, t, 'config-binding', m[0].slice(0, 60));
    }
    // explicit entry-point values:  entry: ./src/index.js
    const VAL = /[:=]\s*["']?([\w./@-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py))["']?\s*$/gm;
    while ((m = VAL.exec(cf.source)) !== null) {
      if (!CODE_PATH_RE.test(m[1])) continue;
      const t = resolveRef(cf.rel, m[1], CODE_ONLY_UNIVERSE, codeIds);
      if (t) addEdge(cf.rel, t, 'config-binding', m[1].slice(0, 60));
    }
  }

  const edges = [...edgeMap.values()]
    .map((e) => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
      ...(e.detail.length ? { detail: e.detail.join(', ').slice(0, 120) } : {}),
    }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  return { nodes, edges, templateCalls };
}

/**
 * Adds pseudo-nodes for templates ("<file>#<template>") and
 * `template-call` edges into an existing function graph, so the function
 * graph shows "this template invokes handler()" alongside call edges.
 * Mutates and returns fgraph.
 */
function attachTemplateCalls(fgraph, templateCalls) {
  const nodeIds = new Set(fgraph.nodes.map((n) => n.id));
  const edgeKeys = new Set(fgraph.edges.map((e) => `${e.from}=>${e.to}`));
  for (const tc of templateCalls) {
    const tid = `${tc.file}#<template>`;
    if (!nodeIds.has(tid)) {
      nodeIds.add(tid);
      fgraph.nodes.push({
        id: tid, file: tc.file, name: '<template>', className: null, kind: 'template',
        startLine: 1, endLine: 1, arity: 0,
      });
    }
    for (const target of tc.targets) {
      for (const n of fgraph.nodes) {
        if (n.file === target && n.name === tc.name && n.kind !== 'template') {
          const key = `${tid}=>${n.id}`;
          if (edgeKeys.has(key)) continue;
          edgeKeys.add(key);
          fgraph.edges.push({ from: tid, to: n.id, kind: 'template-call', confidence: 'high', line: tc.line });
        }
      }
    }
  }
  fgraph.nodes.sort((a, b) => a.id.localeCompare(b.id));
  fgraph.edges.sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return fgraph;
}

module.exports = {
  isCrossFileType,
  findNonCodeFiles,
  buildCrossFileGraph,
  attachTemplateCalls,
  resolveRef,
  resolveTemplateName,
};
