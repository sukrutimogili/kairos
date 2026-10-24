# Analyzer ↔ Extension Data Contract

**Schema version:** `1.0`

> **Phase 2 addendum (Sukruti, Step 1):** this document originally described
> Phase 1 (Java-only, `graph` carried but not rendered). The additions below
> are called out explicitly rather than folded silently into the examples
> above, so a diff of this file shows exactly what changed and why.

This is the single source of truth for the shape of data passed between
the analyzer (Leela) and the VS Code extension (Indu). Both sides build
against this document — if it needs to change, that change is agreed by
both of them and Sukruti updates it here first.

## Request

The extension asks the analyzer to analyze one file within a repository:

```json
{
  "schemaVersion": "1.0",
  "repositoryRoot": "path/to/repo",
  "requestedFile": "src/main/java/com/example/service/UserService.java",
  "includeHistory": false
}
```

- **`includeHistory`** (boolean, optional, **default `false`**) — Phase 2.
  When true, `impact.affected` additionally includes `relation: "historical"`
  entries from git co-change analysis (see below). Off by default: it costs
  a `git log` walk, and Phase 1 consumers that don't send it get Phase 1
  behavior unchanged.

## Response

```json
{
  "schemaVersion": "1.0",
  "requestedFile": "src/main/java/com/example/service/UserService.java",
  "graph": {
    "nodes": [
      { "id": "src/main/java/com/example/controller/UserController.java", "className": "UserController", "package": "com.example.controller" },
      { "id": "src/main/java/com/example/service/UserService.java", "className": "UserService", "package": "com.example.service" },
      { "id": "src/main/java/com/example/repository/UserRepository.java", "className": "UserRepository", "package": "com.example.repository" }
    ],
    "edges": [
      { "from": "src/main/java/com/example/controller/UserController.java", "to": "src/main/java/com/example/service/UserService.java", "kind": "import" },
      { "from": "src/main/java/com/example/service/UserService.java", "to": "src/main/java/com/example/repository/UserRepository.java", "kind": "import" }
    ]
  },
  "impact": {
    "dependsOn": ["src/main/java/com/example/repository/UserRepository.java"],
    "dependents": ["src/main/java/com/example/controller/UserController.java"],
    "affected": [
      { "id": "src/main/java/com/example/controller/UserController.java", "relation": "dependent", "distance": 1 },
      { "id": "src/main/java/com/example/repository/UserRepository.java", "relation": "dependency", "distance": 1 }
    ]
  },
  "meta": {
    "language": "java",
    "fileCount": 3
  }
}
```

**`relation`** is one of `"dependency"`, `"dependent"`, or (Phase 2,
`includeHistory: true` only) `"historical"` — a file that frequently
changed in the same commit as `requestedFile`, from git history, with no
direct import edge to it at all. A historical entry also carries `count`
(number of shared commits) and, like every `affected` entry, `distance` —
fixed at `1` for historical entries specifically **by convention, not by
graph traversal**: co-change isn't a graph edge, so there's no distance to
measure, and `1` was chosen (over adding a separate `count`-only shape) so
every consumer that reads `affected` — notably `ImpactPanel.ts`'s
`renderGraph()`, which places every node by `.distance` — keeps working
against one shape instead of branching on `relation` first. `count` is
extra, historical-only data, not a replacement for `distance`.

**`meta.language`** — Phase 1 only ever set this to `"java"`. Phase 2 adds
`"typescript"` (and `"unknown"` if a file was analyzed but no plugin could
be matched, which should not normally happen since `UNSUPPORTED_LANGUAGE`
is returned earlier in that case — see below).

## Error response

```json
{
  "schemaVersion": "1.0",
  "error": { "code": "FILE_NOT_FOUND", "message": "requestedFile was not found in the analyzed repository" }
}
```

Error codes: `FILE_NOT_FOUND`, `UNSUPPORTED_LANGUAGE`, `ANALYSIS_FAILED`.
`UNSUPPORTED_LANGUAGE` was reserved in Phase 1 for exactly this case and is
now live in Phase 2: `requestedFile`'s extension matches no analyzer plugin
(currently Java, TypeScript/JavaScript). This is distinct from
`FILE_NOT_FOUND` (extension recognized, but the file isn't in the analyzed
repo) — the panel should show a different, more specific message for each
(e.g. "Kairos doesn't support this file type yet" vs. "file not found in
this workspace").

## Design rules (why this shape, and why it stays non-redundant)

- **A node's identity is its repo-relative file path** (`id`). It doubles
  as something the extension can open directly — no separate ID scheme
  to invent or keep in sync.
- **`className`/`package` live once, on the node.** Nothing else repeats
  them; anything that needs "what is this file" looks it up by `id` in
  `graph.nodes` instead of carrying its own copy.
- **`dependsOn` / `dependents` are a convenience projection, not extra
  source data.** They are exactly the distance-1 neighbors of
  `requestedFile` in `graph.edges`. They exist so the panel doesn't have
  to walk the graph for the common case — analyzer tests must assert
  they always match a fresh traversal of `graph`, so the two never drift.
- **`affected` is the one place impact distance lives** — objects with
  `relation` + `distance`, not separate `directAffected` /
  `indirectAffected` arrays. Distance-1 entries overlap in *meaning*
  with `dependsOn`/`dependents` but are represented once, not copied.
- **Wording constraint:** UI text built on this data says "potentially
  affected," "likely impact," "areas to review" — never "safe" or
  "guaranteed."
- **`graph.nodes`/`graph.edges` is no longer just carried data.** Phase 1
  computed it but the panel didn't draw it; Phase 2's panel renders it as
  the dependency graph, so a change to `graph`'s shape is now a rendering
  change for Indu's side, not just a data change for Leela's.
- **Every `impact.affected` entry has a numeric `distance`, with no
  exceptions** — this was implicit in Phase 1 (all entries were graph
  distances) and is now explicit because `historical` entries have no
  natural one; see the `distance: 1` convention above. Any future new
  `relation` value must pick a `distance` convention here, in this
  document, before analyzer code ships it.

---

## Phase 3 addendum: dynamic imports, function-level graph, cross-file mapping

Everything below is **opt-in and additive**. A request that sets none of the new
flags gets byte-for-byte the Phase 2 response shape (this is asserted in
`analyzer/languages/dynamic.test.js`, "Backward compatibility").

### New request fields

```json
{
  "includeFunctions": false,
  "includeCrossFile": false
}
```

- **`includeFunctions`** (boolean, default `false`) — adds `functionGraph` and
  `impact.functionImpact` to the response (see below).
- **`includeCrossFile`** (boolean, default `false`) — adds HTML / template /
  stylesheet / config files to `graph.nodes` and connects them to code through
  the new edge kinds. With this flag, `requestedFile` may also be one of those
  non-code files (without it, they are still `UNSUPPORTED_LANGUAGE`).

### 1. Dynamic dependencies and new languages (always on)

Not behind a flag: they only add edges the old analyzer could not see.

- **Python** is now a supported language (`meta.language: "python"`): `import a.b`,
  `from a import b`, relative imports, and `__init__.py` packages.
- New `graph.edges[].kind` values:
  - `dynamic-import` — `import('./x')`, `React.lazy(() => import('./x'))`,
    `require.resolve('./x')`, and Python `importlib.import_module('a.b')` /
    `__import__('a.b')`. A **computed** specifier with a static directory prefix
    (``import(`./locales/${lang}.js`)``, `require('./plugins/' + name)`,
    `import_module(f'app.plugins.{name}')`) fans out to **every file under that
    prefix** — an intentional over-approximation ("potentially affected").
  - `reflection` — Java `Class.forName("pkg.Class")` / `loadClass("pkg.Class")`
    with a literal class name.
- A static import of the same file pair always wins over a dynamic one (one edge
  per `from => to` pair, as before).

### 2. Function-level graph (`includeFunctions: true`)

Response gains:

```json
{
  "functionGraph": {
    "nodes": [
      { "id": "src/svc/UserService.java#UserService.getUser", "file": "src/svc/UserService.java",
        "name": "getUser", "className": "UserService", "kind": "method",
        "startLine": 12, "endLine": 19, "arity": 1 }
    ],
    "edges": [
      { "from": "src/svc/UserService.java#UserService.getUser",
        "to": "src/repo/UserRepository.java#UserRepository.find",
        "kind": "call", "confidence": "high", "line": 14 }
    ]
  },
  "impact": {
    "functionImpact": [
      { "id": "src/svc/UserService.java#UserService.getUser",
        "callers": ["..."], "callees": ["..."],
        "affected": [ { "id": "...", "relation": "caller", "distance": 1 } ] }
    ]
  }
}
```

- **Function id** = `<repo-relative file>#<Class.>name` (same "id is something you can
  open" rule as file nodes; the part before `#` is the file node id). Overloads or
  shadowed names get an `@L<line>` suffix.
- **`kind`** (node) is `function`, `method`, `constructor`, or `template` (a
  pseudo-node `<file>#<template>` standing for "this template/HTML file", used
  only with `includeCrossFile`).
- **Edge direction** matches the file graph: `from` calls `to`, so `from` depends on `to`.
- **`confidence`** is `high` (resolved through imports, same-file scope, `this`/`self`,
  or a declared/inferred receiver type) or `medium` (receiver type unknown, but exactly one
  method of that name exists in files the caller's file already depends on). Calls that
  cannot be resolved are **dropped, never guessed**.
- **`impact.functionImpact`** has one entry per function defined in `requestedFile`.
  `callers` / `callees` are exactly the distance-1 neighbours in `functionGraph.edges`
  (same "projection, never drifts" rule as `dependsOn`/`dependents`; asserted in
  `functionGraph.test.js`). `affected[].relation` is `caller` | `callee`; `distance` is a
  real graph distance (BFS), so the every-entry-has-a-numeric-distance rule still holds.
- Per-function lookups and call paths (bug localization) are available through the
  analyzer API `analyzeFunction(repo, nameOrId, { file, pathTo })` and the CLI
  `node analyze.js <repo> --function <name> [--path-to <name>]`.

### 3. Cross-file and non-code relationships (`includeCrossFile: true`)

- Non-code nodes appear in `graph.nodes` with an extra optional field
  `fileType`: `html` | `template` | `style` | `config`. `className` is the file name and
  `package` is `""`. Source-code nodes do not get a `fileType`.
- `graph.edges[]` may carry an optional `detail` string: the evidence for the edge
  (e.g. `#submitBtn`, `process.env.API_URL`, `scripts.start`).
- New edge kinds (`from` depends on `to`):

| kind | from -> to | evidence |
|---|---|---|
| `html-script` | html/template -> js/ts/py | `<script src>` (incl. Flask `url_for('static', filename=...)`) |
| `html-style` | html/template -> css | `<link rel=stylesheet>` |
| `html-link` | html -> html | `<a href>`, `<iframe src>`, `<form action>` to a local page |
| `style-import` | css -> css | `@import` |
| `dom-reference` | js/ts -> html/template | `getElementById`, `querySelector(All)`, `getElementsByClassName`, `$('#id')` — narrowed to HTML that loads the script when possible |
| `template-render` | code -> template | `render_template('x.html')`, `res.render('x')`, `new ModelAndView("x")`, or a string literal naming a template file |
| `template-include` | template -> template | `{% include/extends %}`, EJS `include()`, Handlebars `{{> p}}`, Thymeleaf `th:replace`, Blade `@include` |
| `template-call` | html/template -> code | `onclick="fn()"`, `@click`, `(click)`, `ng-click`, Flask `url_for('endpoint')` |
| `config-reference` | code -> config | `process.env.X`, `os.getenv('X')`, `@Value("${a.b}")`, `System.getenv`, `config.get('a.b')`, `@ConfigurationProperties`. Keys are compared case-insensitively ignoring `.`, `_`, `-` (Spring-style relaxed binding) |
| `file-reference` | code -> config/css | string literal naming a config/style file (`"settings.json"`, `"classpath:app.properties"`) |
| `config-binding` | config -> code | `package.json` `main`/`bin`/`scripts`, fully-qualified Java class or package names in config, `node x.js` / `python app.py` commands, entry-point paths |

- Function graph integration: `template-call` relationships also appear in
  `functionGraph` as edges from the pseudo-node `<file>#<template>` to the target function.
- **Wording constraint still applies** — these are static, heuristic links. UI text must
  say "potentially affected", never "safe".
