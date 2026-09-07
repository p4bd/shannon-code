# Shannon Code

Shannon Code is an experimental TypeScript CLI coding agent inspired by the core workflows of tools like Claude Code. It is built as a portfolio-grade engineering project: modular tools, permissions, sessions, compacting, hooks, skills, MCP integration, evals, and real CLI dogfood tests.

Status: alpha. The project is useful for local experiments and codebase exploration, but it is not a production-ready autonomous coding system.

## Highlights

- OpenAI-compatible model provider with `.env` configuration.
- Interactive `shannon code` REPL and one-shot prompts.
- Lightweight terminal layout: owl welcome banner, active model and workspace,
  separated conversation turns, and numbered tool calls with multiline previews.
- Typed tool registry for file reads, writes, edits, grep, shell, web fetch, tool search, and sub-agent workflows.
- Permission modes for interactive approval, accept-edits, don't-ask, bypass, and plan mode.
- Session save/resume, memory, skills, hooks, MCP stdio tools, and TypeScript diagnostics.
- Context budget helpers, manual `/compact`, prompt-too-long retry, and large tool-result artifacts.
- Unit, integration, eval, perf, real CLI smoke, dogfood, and long soak runners.

## Requirements

- Node.js 20 or newer.
- An OpenAI-compatible API key for real model runs.

Create a local `.env` file in the project root:

```env
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-4.1-mini
# OPENAI_BASE_URL=https://api.openai.com/v1
```

`.env` is intentionally ignored by git.

## Install

```powershell
npm install
npm run build
```

For local CLI usage from this checkout:

```powershell
node dist/cli/shannon.js code
```

You can also link the package locally:

```powershell
npm link
shannon code
```

## Usage

Interactive mode:

```powershell
shannon code
```

One-shot mode:

```powershell
shannon code "Inspect this project and summarize the main risks."
```

Useful REPL commands:

```text
/help
/cost
/compact
/plan
/memory
/skill
/exit
```

## Testing

Fast local baseline:

```powershell
npm run build
npm test
```

Broader deterministic checks:

```powershell
npm run test:cli
npm run eval
npm run perf
```

Real model smoke tests require `.env`:

```powershell
npm run smoke:api
npm run smoke:cli
npm run smoke:real-e2e
npm run smoke:dogfood
```

Long dogfood soak:

```powershell
$env:DOGFOOD_SOAK_ROUNDS='6'
$env:DOGFOOD_SOAK_KEEP_WORKSPACE='1'
npm run smoke:dogfood-soak
```

Current evidence from the latest local run:

- `npm test`: 42 files, 172 tests passed.
- Long dogfood soak: 5/6 rounds passed; stability passed in all 6 rounds; quality passed in all 6 rounds.

## Architecture

The source is organized by responsibility:

- `src/core`: agent loop, model provider interfaces, provider errors.
- `src/tools`: typed tools, tool registry, tool result format.
- `src/permissions`: permission modes, shell analysis, approval checks.
- `src/context`: token estimates, compaction, large-result artifacts.
- `src/cli`: argument parsing, REPL, command rendering.
- `src/session`, `src/memory`, `src/skills`, `src/hooks`, `src/mcp`, `src/subagent`: extension surfaces.
- `src/evals`, `src/perf`, `src/smoke`: validation and dogfood harnesses.

See `docs/architecture-gap.md` for known gaps relative to larger coding-agent systems.

## Known Limits

- This is an alpha project. Model behavior can vary across runs.
- The main agent loop is intentionally simpler than production coding agents with richer streaming executors and cancellation.
- `tool_search` returns schemas but does not yet implement full deferred tool activation.
- The CLI uses native readline and terminal scrollback. Tool results show up to
  six preview lines; saved results are available in `.agent/sessions` (large
  results may reference artifacts). No fullscreen UI or interactive folding.
- Some smoke runners are intentionally broad and should be refactored if the test harness grows further.

## License

MIT
