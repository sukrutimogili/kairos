# Analyzer ↔ Extension Data Contract

**Schema version:** `1.0`

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
  "requestedFile": "src/main/java/com/example/service/UserService.java"
}
```

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

## Error response

```json
{
  "schemaVersion": "1.0",
  "error": { "code": "FILE_NOT_FOUND", "message": "requestedFile was not found in the analyzed repository" }
}
```

Phase 1 error codes: `FILE_NOT_FOUND`, `UNSUPPORTED_LANGUAGE`, `ANALYSIS_FAILED`.

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
