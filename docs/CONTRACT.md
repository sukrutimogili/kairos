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
