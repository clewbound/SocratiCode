# SocratiCode for VS Code (and Cursor, VSCodium, Gitpod, code-server, Antigravity, Theia, ...)

**Codebase context engine for AI assistants.** SocratiCode indexes your
repositories: code, dependency and call graphs, database schemas, API
specs, architecture docs. It hands that understanding to whichever AI
assistant you use, so the same understanding survives every tool switch.

This extension auto-registers the SocratiCode MCP server in VS Code's MCP
host so it works out of the box with **Copilot agent mode**, **Cline**,
**Continue**, **Roo Code**, and any other MCP-compatible chat or agent
extension. No `mcp.json` editing required.

## What it does

- **Hybrid search** (semantic + BM25, RRF-fused) across your codebase.
- **File-level dependency graphs** across 18+ languages with circular-
  dependency detection.
- **Symbol-level call graph and impact analysis**: answers "what breaks if
  I change function X?" before the AI changes it.
- **Cross-repo search** across multiple linked projects.
- **Interactive graph viewer** with blast-radius overlay, search, and PNG
  export. Opens directly inside the editor as a webview panel.
- **Context artefacts**: index database schemas, API specs and architecture
  docs alongside code. The AI sees the schema your developer team did, not
  what it guessed from filenames.

## Requirements

- VS Code 1.99 or newer (for native MCP support)
- Node.js 18+ on PATH (for `npx` to launch the engine)
- Docker Desktop running (the engine uses Docker for Qdrant + Ollama
  containers; alternatively you can point at an external Qdrant via
  the `socraticode.env` setting).

## Quick start

1. Install the extension.
2. The MCP server registers automatically. Ask Copilot agent mode (or any
   MCP-aware assistant) a question about your codebase.
3. Open the SocratiCode sidebar (Activity Bar → SocratiCode icon) and click
   **Index this workspace** to run the first index.
4. Open the interactive graph from the Command Palette: `SocratiCode: Open
   interactive graph`.

A walkthrough is shown on first install. Re-open it any time with
`SocratiCode: Open getting-started walkthrough`.

## Commands

All commands are also available under `SocratiCode:` in the Command Palette.

- **Index current workspace**: kick off a one-time index.
- **Open interactive graph**: render the dependency / call graph as an
  in-editor webview.
- **Refresh indexed projects**: reload the sidebar tree.
- **Open getting-started walkthrough**: replay the onboarding.
- **Show output / logs**: open the SocratiCode output channel.

## Settings

| Setting | Default | Description |
|---|---|---|
| `socraticode.command` | `"npx"` | Engine launcher. |
| `socraticode.args` | `["-y", "socraticode"]` | Args for the launcher. |
| `socraticode.env` | `{}` | Environment variables forwarded to the engine. Use this for external Qdrant (`QDRANT_MODE=external`, `QDRANT_URL`, `QDRANT_API_KEY`), embedding provider (`EMBEDDING_PROVIDER`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`), or any other engine setting documented in the engine README. |
| `socraticode.statusBar` | `true` | Show the status-bar item. |

## Privacy and data

- The engine indexes locally. Code never leaves your machine unless you
  explicitly point it at an external service via `socraticode.env`.
- No telemetry from the extension.

## Open source

The engine is open source under AGPL-3.0 and battle-tested across
thousands of indexed repositories. That openness is your guarantee of
transparency, security and engineering quality.

- Repository: https://github.com/giancarloerra/socraticode
- Issues / questions: https://github.com/giancarloerra/socraticode/issues

## Troubleshooting

- **"Cannot find Docker"**: install Docker Desktop from
  https://docker.com/products/docker-desktop, or set `socraticode.env`
  with `QDRANT_MODE=external` plus `QDRANT_URL` to point at an existing
  Qdrant.
- **MCP tools don't appear in Copilot agent mode**: restart the chat
  after install, or run `MCP: List Servers` from the command palette and
  confirm `SocratiCode` is listed and started.
- **First index is slow**: the engine downloads Ollama models the first
  time. Subsequent runs are fast.
- See `SocratiCode: Show output / logs` in the command palette for engine
  output.
