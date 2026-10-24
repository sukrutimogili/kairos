# analyzer/

Static analyzer for Kairos. See `../docs/CONTRACT.md` for the exact JSON shape it produces.

```
analyze.js                 language-agnostic core: dispatch, graph assembly, impact, CLI
languages/                 per-language plugins: java.js, typescript.js (JS/TS), python.js
functions/functionGraph.js function/method call graph + function-level impact + call paths
relationships/crossFile.js HTML / template / CSS / config nodes and non-import relationships
history/gitLog.js          git co-change history (includeHistory)
testUtil.js                tiny shared test harness (JUnit output per suite)
```

## Options (all default to off)

| option | CLI flag | adds |
|---|---|---|
| `includeHistory` | `--include-history` | `historical` entries in `impact.affected` |
| `includeFunctions` | `--functions` | `functionGraph`, `impact.functionImpact` |
| `includeCrossFile` | `--cross-file` | non-code nodes (`fileType`) + cross-file edges (with `detail`) |

Dynamic imports (`dynamic-import`, `reflection` edges) and Python support are always on.

## Adding a language plugin

Export `{ extensions, findSourceFiles(root), parseFile(absPath), extractRelationships(parsedByRelPath) }`,
register it in `LANGUAGE_PLUGINS` and `PLUGIN_LANGUAGE` in `analyze.js`. For function-level support add an
extractor in `functions/functionGraph.js` (`extractFunctions`).

## Tests

```bash
npm test            # every suite
npm run test:junit  # same, writing reports/analyzer-junit-<suite>.xml
```
