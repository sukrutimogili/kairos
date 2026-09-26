# Kairos

> Codebase impact analysis for VS Code — see what breaks before you change it.

Kairos analyzes a repository's dependency graph and Git history to answer one question: **if I change this file, what else is affected?** It renders the answer as an interactive graph directly in the editor.

---

## Features

- **Multi-language support** — Java and TypeScript/JavaScript out of the box, with a plugin architecture for adding more
- **Dependency-based impact** — see everything that depends on a file, and everything it depends on, by distance
- **Git-history-aware impact (optional)** — surface files that frequently change *together* with the one you're editing, even without a direct import (`includeHistory` setting)
- **Interactive graph panel** — click any node to jump to that file; historical vs. dependency edges are visually distinct
- **Graceful on unsupported files** — a clear message instead of a crash

---

## Project layout

```
kairos/
├── analyzer/              # Static analysis engine (Node.js)
│   └── languages/         # Per-language parser plugins (java, typescript)
├── docs/CONTRACT.md        # analyzer ↔ extension JSON contract
├── extension/              # VS Code extension + webview panel
├── Jenkinsfile              # CI pipeline (see docs/JENKINS_SETUP.md)
└── tests/fixtures/         # Sample projects used by the test suites
```

---

## Quick start

```bash
git clone https://github.com/sukrutimogili/kairos.git
cd kairos

cd extension
npm install
npm run compile
```

Then open the `extension/` folder in VS Code and press **F5** to launch it in a new Extension Development Host window. Open a project, run **Code Impact: Analyze Codebase**, then **Code Impact: Show Impact** on any file.

To try history-aware impact, enable `kairos.includeHistory` in Settings.

---

## Running the analyzer directly

```bash
node analyzer/analyze.js <repoRoot> <targetFile>
```

## Running the tests

```bash
# Analyzer
cd analyzer && npm run test:junit

# Extension
cd extension && npm run test:junit
```

Both write JUnit XML reports (`analyzer/reports/`, `extension/reports/`), which Jenkins picks up automatically — see `docs/JENKINS_SETUP.md` for CI setup.

---

## Contributing

```bash
git checkout -b feature/your-feature-name
git commit -m "feat: your change"
git push origin feature/your-feature-name
```

Then open a pull request.
