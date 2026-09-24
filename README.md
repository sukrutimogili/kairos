# Kairos - Phase 1

> Static codebase impact analysis & dependency blast-radius visualization for Java applications in VS Code.

Kairos inspects your Java project to calculate downstream dependencies, upstream callers, and blast radius before you modify or refactor code. It pairs a standalone static analyzer engine with a VS Code extension dashboard.

---

## Features

- **Blast Radius Calculation:** Instantly see which controllers, services, repositories, and models are impacted when modifying a specific Java file.
- **Bi-directional Tracing:**
  - **Depends on:** Files and components required by the selected file.
  - **Dependents:** Upstream callers that rely on the selected file.
- **Layered Topology Map:** Interactive SVG dependency graph visualizing relationships and traversal distance levels directly inside your editor.
- **Deterministic & Decoupled:** The static analysis engine runs independently as a CLI/CommonJS module, communicating via a strict JSON data contract.

---

## Architecture Overview

```text
kairos/
├── analyzer/                 # Core static analysis engine (Node.js / CommonJS)
│   ├── analyze.js            # AST traversal & dependency graph generation
│   └── analyze.test.js       # Test suite for parsing and edge detection
├── docs/
│   └── CONTRACT.md           # Schema contract defining analyzer <-> webview IPC
├── extension/                # VS Code Extension Host layer (TypeScript)
│   └── src/
│       ├── extension.ts      # Command registration & editor integration
│       ├── data/             # Workspace resolution & data orchestration
│       ├── panel/            # ImpactPanel webview lifecycle & SVG rendering
│       └── types.ts          # TypeScript type definitions matching CONTRACT.md
└── tests/
    └── fixtures/             # Realistic sandboxed target Java projects
```

---

## Prerequisites

- **Node.js:** v18.0.0 or higher
- **VS Code:** v1.80.0 or higher
- **Java Projects:** Standard Java/Spring Boot folder structures (`src/main/java/...`)

---

## Quick Start

### 1. Repository Setup

Clone the repository and install dependencies:

```bash
git clone https://github.com/sukrutimogili/kairos.git
cd kairos

# Install extension dependencies
cd extension
npm install
npm run compile
cd ..
```

### 2. Testing the Analyzer Directly (CLI)

You can run the static analyzer standalone on any fixture without launching VS Code:

```bash
node analyzer/analyze.js <repositoryRoot> <requestedFile>

# Example:
node analyzer/analyze.js tests/fixtures/sample-project tests/fixtures/sample-project/src/main/java/com/example/controller/UserController.java
```

### 3. Running the VS Code Extension

1. Open the `/extension` folder in VS Code:

   ```bash
   cd extension
   code .
   ```

2. Press **F5** (or select **Run > Start Debugging**).
3. In the new **[Extension Development Host]** window:
   1. Open a Java workspace folder (e.g., **File > Open Folder...** → `tests/fixtures/sample-project`).
   2. Open any `.java` file in the editor (e.g., `UserController.java`).
   3. Press `Ctrl+Shift+P` (or `Cmd+Shift+P` on macOS) and run:

      ```text
      Kairos: Show Impact
      ```

The interactive **Code Impact** webview will open beside your active editor.

---

## Data Contract (`CONTRACT.md`)

The analyzer emits a deterministic JSON payload consumed by the extension:

```json
{
  "schemaVersion": "1.0",
  "requestedFile": "src/main/java/com/example/controller/UserController.java",
  "graph": {
    "nodes": [
      {
        "id": "src/main/java/com/example/controller/UserController.java",
        "className": "UserController",
        "package": "com.example.controller"
      }
    ],
    "edges": [
      {
        "from": "src/main/java/com/example/controller/UserController.java",
        "to": "src/main/java/com/example/service/UserService.java",
        "kind": "import"
      }
    ]
  },
  "impact": {
    "dependsOn": ["src/main/java/com/example/service/UserService.java"],
    "dependents": [],
    "affected": [
      {
        "id": "src/main/java/com/example/service/UserService.java",
        "relation": "dependency",
        "distance": 1
      }
    ]
  },
  "meta": {
    "language": "java",
    "fileCount": 3
  }
}
```

---

## Testing & Verification

Run the test suites across the repository:

```bash
# Run analyzer test suite
node analyzer/analyze.test.js

# Type-check the extension
cd extension
npx tsc --noEmit

# Run extension integration tests
npm test
```

---

## Contributing

1. Create a feature branch: `git checkout -b feature/your-feature-name`
2. Commit your changes: `git commit -m "feat(scope): add impact calculation"`
3. Push to your branch: `git push origin feature/your-feature-name`
4. Open a Pull Request.
