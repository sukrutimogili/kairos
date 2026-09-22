# Kairos

A VS Code extension that helps developers understand an unfamiliar
codebase and identify the potential ripple effects of changing a file.

Kairos analyzes a Java codebase, builds a dependency graph, and shows —
directly inside VS Code — what a selected file depends on, what depends
on it, and what is potentially affected by changing it.

## Phase 1 scope

- Java codebases only.
- Static import/reference relationships (no Git history, no runtime data yet).
- A working VS Code extension with a real "Analyze Codebase" command.
- A basic CI workflow via GitHub Actions.

## Project structure

```text
kairos/
├── extension/   VS Code extension
├── analyzer/    Java code analyzer
├── tests/       Shared fixtures + integration/e2e tests
├── docs/        CONTRACT.md — the analyzer/extension data contract
└── .github/     CI workflows
```

Kairos does not claim a change is "safe." It surfaces potentially
affected areas so a developer knows what to review before changing code.
