# DEV_SPEC: Engineering Mini Claude Code

本文档用于指导 coding agent 从零开发一个简历级 TypeScript CLI Coding Agent。目标不是复制参考项目，而是以 `E:\AI Agent\claude-code-from-scratch-main` 的 TS 版为功能参考、以 `E:\AI Agent\claude-code-from-scratch-main\Claude code src` 为高级架构参考，开发一个工程化程度明显高于 `claude-code-from-scratch` 的独立项目。

## 1. 项目定位

### 1.1 目标

开发一个可运行、可测试、可展示的 `Shannon code`：

- 目标项目根目录：`E:\AI Agent\Shannon code`。
- 本文所有未明确标注为参考项目的相对路径，都以 `E:\AI Agent\Shannon code` 为根目录。
- CLI/package 名称可暂定为 `shannon-code`，后续可在 `package.json` 中调整。
- 覆盖参考项目 `E:\AI Agent\claude-code-from-scratch-main` TS 版的核心能力。
- 架构上使用 typed tool/plugin system，而不是一个巨大 `tools.ts`。
- 增强上实现 Hooks、工具错误自修复、结构化 Shell 安全分析、自动化 Eval Harness、轻量 LSP diagnostics loop、Prompt Caching。
- 交付 README、架构文档、测试报告和 demo，适合作为简历项目展示。

### 1.2 非目标

第一版不要实现以下内容：

- 完整 Coordinator / Swarm 多 Agent 系统。
- 企业级插件市场。
- 完整 IDE 扩展。
- 完整 Bash AST/tree-sitter 安全分析。
- 完整 LSP 多语言平台。
- 复杂 TUI/React Ink UI。

这些可以作为后续扩展，但不能阻塞 MVP 和核心增强。

### 1.3 参考边界

允许参考：

- `E:\AI Agent\claude-code-from-scratch-main\src\agent.ts`: Agent Loop、streaming、context compact、预算控制。
- `E:\AI Agent\claude-code-from-scratch-main\src\tools.ts`: 13 个工具、mtime 防护、权限规则、延迟工具。
- `E:\AI Agent\claude-code-from-scratch-main\src\cli.ts`: REPL、one-shot、resume、命令设计。
- `E:\AI Agent\claude-code-from-scratch-main\src\memory.ts`: 记忆分类、语义召回、异步预取。
- `E:\AI Agent\claude-code-from-scratch-main\src\skills.ts`: skill 发现、inline/fork 模式。
- `E:\AI Agent\claude-code-from-scratch-main\src\subagent.ts`: fork-return sub-agent。
- `E:\AI Agent\claude-code-from-scratch-main\src\mcp.ts`: JSON-RPC over stdio MCP。
- `E:\AI Agent\claude-code-from-scratch-main\docs\14-testing.md`: 核心功能验收清单。
- `E:\AI Agent\claude-code-from-scratch-main\Claude code src\Tool.ts`: 工具接口设计参考。
- `E:\AI Agent\claude-code-from-scratch-main\Claude code src\services\tools`: 工具执行、编排、hook 参考。
- `E:\AI Agent\claude-code-from-scratch-main\Claude code src\hooks\toolPermission`: 权限处理参考。
- `E:\AI Agent\claude-code-from-scratch-main\Claude code src\services\lsp`: LSP diagnostics 参考。
- `E:\AI Agent\claude-code-from-scratch-main\Claude code src\commands\plan`: Plan mode 交互参考。

禁止：

- 直接复制大段源码。
- 在原参考项目 `E:\AI Agent\claude-code-from-scratch-main` 上魔改成最终项目。
- 为了追求功能数量牺牲可运行性。

## 2. 技术栈

### 2.1 基础栈

- Runtime: Node.js 20+，推荐 Node.js 22。
- Language: TypeScript。
- Module: ESM。
- CLI: 原生 `readline/promises` 或轻量 CLI parser。
- Model API: OpenAI-compatible provider 优先。
- Config: `.env` + project config file。
- Test: `vitest`。
- Schema: `zod` 或 JSON Schema。工具对外暴露 JSON Schema，内部可用 zod 校验。

### 2.2 推荐依赖

初始依赖控制在必要范围：

- `openai`: OpenAI-compatible API。
- `zod`: 输入校验。
- `chalk`: CLI 输出。
- `glob`: 文件发现。
- `diff`: diff 输出，或自行实现简单 unified diff。
- `vitest`: 单元测试。

后续增强依赖：

- `yaml`: eval case、配置解析。
- `execa` 或 Node `child_process`: shell、hook、MCP server 管理。
- `vscode-jsonrpc` 或自实现最小 JSON-RPC: LSP/MCP。

## 3. 总体架构

### 3.1 目标目录结构

```txt
src/
  cli/
    index.ts
    args.ts
    repl.ts
    commands.ts

  core/
    agent.ts
    loop.ts
    messages.ts
    model-provider.ts
    openai-provider.ts
    response-normalizer.ts
    errors.ts

  tools/
    types.ts
    registry.ts
    schemas.ts
    result.ts
    read-file.tool.ts
    write-file.tool.ts
    edit-file.tool.ts
    list-files.tool.ts
    grep-search.tool.ts
    run-shell.tool.ts
    web-fetch.tool.ts
    tool-search.tool.ts

  permissions/
    modes.ts
    checker.ts
    rules.ts
    shell-analyzer.ts
    approval.ts

  hooks/
    types.ts
    config.ts
    matcher.ts
    runner.ts

  context/
    token-estimator.ts
    compact.ts
    large-result-store.ts
    budget.ts

  prompt/
    system-prompt.ts
    project-rules.ts
    includes.ts

  session/
    store.ts
    serializer.ts

  memory/
    store.ts
    recall.ts
    prompt-section.ts

  skills/
    loader.ts
    runner.ts
    types.ts

  subagent/
    config.ts
    runner.ts

  mcp/
    json-rpc.ts
    client.ts
    manager.ts
    tool-adapter.ts

  lsp/
    diagnostics.ts
    typescript-diagnostics.ts

  evals/
    case.ts
    runner.ts
    assertions.ts

  utils/
    fs.ts
    paths.ts
    logger.ts
    abort.ts

tests/
  unit/
  integration/

evals/
  cases/

docs/
  architecture.md
  testing.md
  decisions.md
```

### 3.2 核心数据流

```txt
User Prompt
  -> CLI/REPL
  -> Agent
  -> System Prompt + Memory + Project Rules + Session Messages
  -> ModelProvider
  -> Assistant Text / Tool Calls
  -> Permission Checker
  -> Hook Runner: PreToolUse
  -> Tool Registry
  -> Tool Execute
  -> Hook Runner: PostToolUse
  -> Structured Tool Result
  -> Context Manager
  -> ModelProvider next turn
  -> Final Answer
  -> Session Store
```

### 3.3 关键设计原则

- Agent Loop 只依赖 `ModelProvider` 和 `ToolRegistry`，不直接 import 具体工具。
- 工具独立模块化，每个工具自带 schema、权限元数据、执行逻辑。
- 所有工具失败都返回结构化错误，不让进程崩溃。
- 权限判断、hook、工具执行分层，避免混在工具内部。
- Plan mode 是权限模式，不是单独 agent。
- Sub-agent 是 fork-return，不共享主 agent messages。
- MCP 工具通过 adapter 变成普通 Tool。
- LSP diagnostics 第一版只做 TypeScript 轻量反馈，不追求完整协议平台。

## 4. 核心接口规范

### 4.1 Tool 接口

```ts
export type ToolSafety = "read" | "write" | "execute" | "network";

export interface Tool<Input = unknown> {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  safety: ToolSafety;
  readOnly: boolean;
  concurrencySafe: boolean;
  requiresApproval: boolean;
  enabledInPlanMode: boolean;
  execute(input: Input, ctx: ToolContext): Promise<ToolResult>;
}
```

### 4.2 ToolContext

```ts
export interface ToolContext {
  cwd: string;
  sessionId: string;
  permissionMode: PermissionMode;
  abortSignal?: AbortSignal;
  readTracker: ReadTracker;
  artifactStore: LargeResultStore;
  logger: Logger;
}
```

### 4.3 ToolResult

工具必须返回结构化结果：

```ts
export type ToolResult =
  | {
      ok: true;
      content: string;
      metadata?: Record<string, unknown>;
    }
  | {
      ok: false;
      error: ToolError;
      content: string;
      recoverable: boolean;
    };

export interface ToolError {
  code:
    | "FileNotFound"
    | "PermissionDenied"
    | "ReadBeforeEditRequired"
    | "FileModifiedSinceRead"
    | "SearchStringNotFound"
    | "SearchStringNotUnique"
    | "CommandFailed"
    | "CommandTimedOut"
    | "DangerousCommand"
    | "SchemaValidationFailed"
    | "NetworkError"
    | "McpError"
    | "HookDenied"
    | "UnknownError";
  message: string;
  details?: Record<string, unknown>;
}
```

### 4.4 ModelProvider

```ts
export interface ModelProvider {
  name: string;
  supportsToolCalling: boolean;
  supportsStreaming: boolean;
  supportsPromptCaching: boolean;

  createMessage(input: ModelRequest): Promise<ModelResponse>;
  createMessageStream(input: ModelRequest): AsyncIterable<ModelStreamEvent>;
}
```

第一版必须支持 OpenAI-compatible tool calling。Anthropic provider 可以作为后续补充。

### 4.5 Hook 接口

```ts
export type HookEvent = "PreToolUse" | "PostToolUse" | "OnAgentFinish";

export interface HookInput {
  event: HookEvent;
  toolName?: string;
  toolInput?: unknown;
  toolResult?: ToolResult;
  cwd: string;
  sessionId: string;
}

export type HookOutput =
  | { action: "allow" }
  | { action: "deny"; reason: string }
  | { action: "modify"; toolInput: unknown }
  | { action: "append"; message: string };
```

Hook 通过 stdin 接收 JSON，通过 stdout 返回 JSON。hook 超时、崩溃、非法 JSON 都必须被隔离，不得导致 agent 崩溃。

## 5. 功能范围

### 5.1 Scratch 核心对齐

必须实现：

- Agent Loop。
- OpenAI-compatible model provider。
- Tool calling。
- Streaming text output。
- REPL + one-shot。
- Session save/resume。
- `read_file`。
- `write_file`。
- `edit_file`。
- `list_files`。
- `grep_search`。
- `run_shell`。
- `web_fetch`。
- `tool_search` / deferred tools。
- Permission modes。
- Dangerous shell detection。
- Read-before-edit。
- mtime edit guard。
- diff output。
- large result storage。
- context compact。
- project rules: `AGENTS.md` / `CLAUDE.md` / `.agent/rules/*.md`。
- memory: add/list/delete/recall。
- skills: inline/fork。
- plan mode。
- sub-agent。
- MCP stdio。
- budget: max turns。

### 5.2 必选增强

必须实现以下 6 个增强，使项目工程难度明显高于 scratch：

1. Typed Tool Plugin System。
2. Hook System。
3. Automated Eval Harness。
4. Structured Tool Errors + Self-Healing。
5. Lightweight TypeScript Diagnostics Loop。
6. Prompt Caching。

### 5.3 暂缓增强

以下功能写入 `docs/decisions.md` 作为后续路线，不在第一版主线实现：

- Coordinator。
- Swarm。
- 完整 Bash AST。
- 完整多语言 LSP。
- 插件市场。
- 远程会话。
- 浏览器控制。

## 6. 开发阶段

### Milestone 0: Repo Bootstrap

目标：项目能 build、能启动、能调模型。

任务：

- 初始化 TypeScript ESM 项目。
- 建立 `src/cli/index.ts`。
- 建立 `ModelProvider` 抽象。
- 实现 OpenAI-compatible provider。
- 支持 `.env`:
  - `OPENAI_API_KEY`
  - `OPENAI_BASE_URL`
  - `OPENAI_MODEL`
- 支持 one-shot:
  - `agent "hello"`

验收：

- `npm run build` 通过。
- `npm start -- "hello"` 返回模型文本。
- 没有 API key 时给出明确错误。

### Milestone 1: Typed Tool System + Minimal Agent Loop

目标：模型能调用工具完成真实任务。

任务：

- 实现 `Tool`、`ToolRegistry`、schema validation。
- 实现 `read_file`、`list_files`、`run_shell`。
- Agent Loop 支持 tool call -> tool result -> next turn。
- 工具错误以 `ToolResult` 返回模型。

验收：

- 让 agent 读取 `package.json` 并总结。
- 让 agent 搜索项目文件。
- 让 agent 运行 `npm --version`。
- 工具输入 schema 错误不会崩溃。

### Milestone 2: File Editing Safety

目标：具备 coding agent 基本编辑能力。

任务：

- 实现 `write_file`。
- 实现 `edit_file`。
- `edit_file` 必须满足：
  - 必须先 read。
  - 记录 read 时的 mtime。
  - 编辑前检查 mtime。
  - search string 必须唯一。
  - 支持引号归一化回退。
  - 输出 unified diff。
- 所有写操作自动创建父目录。

验收：

- 未 read 直接 edit 返回 `ReadBeforeEditRequired`。
- 文件 read 后被外部修改，edit 返回 `FileModifiedSinceRead`。
- search string 不唯一，edit 返回 `SearchStringNotUnique`。
- 编辑成功后输出 diff。

### Milestone 3: Permissions + Shell Safety

目标：不会无保护执行危险操作。

任务：

- 实现 permission modes:
  - `default`
  - `acceptEdits`
  - `bypassPermissions`
  - `plan`
  - `dontAsk`
- 实现 `.agent/settings.json` allow/deny 规则。
- 实现 `shell-analyzer.ts`。
- Shell analyzer 返回：
  - `safe`
  - `needs_approval`
  - `dangerous`
- 分别处理 Bash 和 PowerShell 常见危险模式。

最低危险规则：

- `rm -rf`
- `git reset --hard`
- `git clean -fd`
- `Remove-Item -Recurse`
- `del /s`
- `format`
- `shutdown`
- `curl ... | sh`
- `wget ... | sh`
- `Invoke-WebRequest ... | iex`
- `iwr ... | iex`

验收：

- 危险命令默认请求确认或拒绝。
- `--yolo` 跳过确认但记录风险。
- `plan` 模式拒绝写工具和危险 shell。

### Milestone 4: CLI, REPL, Session

目标：像真实 CLI 工具一样可用。

任务：

- REPL 模式。
- Commands:
  - `/help`
  - `/exit`
  - `/clear`
  - `/cost`
  - `/compact`
  - `/plan`
  - `/memory`
  - `/resume`
- Session JSONL 持久化。
- `--resume` 恢复最近或指定 session。
- `--max-turns` 限制 agent loop。

验收：

- one-shot 正常退出。
- REPL 连续多轮对话正常。
- 退出后 `--resume` 能恢复上下文。
- `--max-turns 1` 能阻止无限循环。

### Milestone 5: Streaming + Parallel Tool Execution

目标：改善交互体验和执行效率。

任务：

- streaming text output。
- tool call 完成后清晰渲染 tool input/result。
- consecutive read-only concurrency-safe tools 并行执行。
- 先不强制实现 streaming early tool start，作为 bonus。

并行工具：

- `read_file`
- `list_files`
- `grep_search`
- `web_fetch`

验收：

- 同时读取多个文件时并发执行。
- streaming 文本能实时显示。
- 工具输出格式清楚，不淹没最终回答。

### Milestone 6: Context Management

目标：长任务不轻易爆上下文。

任务：

- token 粗估。
- large result storage:
  - 超过 30KB 写入 `.agent/artifacts/`。
  - 上下文只保留摘要、预览、artifact path。
- `/compact` 手动压缩。
- 自动 compact:
  - 达到预算阈值后总结旧对话。
  - 保留最近 N 轮完整消息。
- Prompt Too Long 错误时自动 compact 后重试一次。

验收：

- 读取大文件不会把完整内容塞回模型。
- `/compact` 后任务可继续。
- 触发 prompt too long 时不会直接崩溃。

### Milestone 7: Project Rules + Memory

目标：agent 能理解项目规则和长期偏好。

任务：

- 加载 `AGENTS.md`。
- 兼容 `CLAUDE.md`。
- 加载 `.agent/rules/*.md`。
- 支持 `@path` include。
- 实现 memory:
  - `/memory add`
  - `/memory list`
  - `/memory delete`
  - project-level memory directory
  - LLM-based relevant memory selection

验收：

- `AGENTS.md` 中的风格要求能进入 system prompt。
- include 文件能被递归加载。
- 新 session 能召回相关 memory。

### Milestone 8: Skills

目标：支持可复用任务能力。

任务：

- 发现 `.agent/skills/*/SKILL.md`。
- 解析 frontmatter:
  - `name`
  - `description`
  - `allowed_tools`
  - `mode`
- 支持 inline mode。
- 支持 fork mode。
- 支持 slash command 调用 skill。
- 模型 system prompt 中暴露可用 skill 摘要。

验收：

- `/skill commit` 可执行。
- skill 能限制工具集合。
- fork skill 不污染主上下文。

### Milestone 9: Plan Mode

目标：实现“先规划、再确认执行”。

任务：

- `/plan` 进入 plan mode。
- plan mode 下只允许 read-only tools。
- 允许写 plan file，但不能写普通代码文件。
- 输出 plan 文件到 `.agent/plans/`。
- 审批流程第一版支持：
  - approve and execute
  - revise plan
  - cancel
- 第二版再支持保留/清空上下文执行。

验收：

- plan mode 下无法改代码。
- 用户 approve 后才能执行写操作。
- plan 文件可追溯。

### Milestone 10: Sub-Agent

目标：实现 fork-return 多 agent。

任务：

- 内置 agent types:
  - `explore`: read-only search。
  - `plan`: read-only planning。
  - `general`: full tools except recursive unrestricted agent。
- 支持 `.agent/agents/*.md` 自定义 agent。
- 主 agent 通过 `agent` tool 调用 sub-agent。
- sub-agent 独立上下文，返回总结。
- 限制递归深度。

验收：

- 主 agent 能派 `explore` 查代码。
- `explore` 不能写文件。
- 自定义 agent 可被发现并调用。

### Milestone 11: MCP stdio

目标：支持外部工具扩展。

任务：

- 读取 `.agent/mcp.json`。
- spawn stdio MCP server。
- JSON-RPC:
  - `initialize`
  - `tools/list`
  - `tools/call`
- MCP tool adapter 转成内部 Tool。
- 命名格式：
  - `mcp__serverName__toolName`
- server 崩溃隔离。

验收：

- test MCP server 暴露 `add`、`echo`。
- agent 能调用 MCP tool。
- MCP tool 错误返回 `McpError` 而不是崩溃。

### Milestone 12: Hook System

目标：超过 scratch 的平台化能力。

任务：

- 配置文件 `.agent/hooks.json`。
- 支持事件：
  - `PreToolUse`
  - `PostToolUse`
  - `OnAgentFinish`
- matcher 支持：
  - exact tool name
  - `*`
  - prefix pattern，如 `mcp__github__*`
- hook command stdin/stdout JSON 协议。
- hook timeout，默认 5s。
- hook crash isolation。
- PreToolUse 可 deny / modify。
- PostToolUse 可 append message。

验收：

- PreToolUse hook 能拒绝 `run_shell`。
- PostToolUse hook 能在 `edit_file` 后运行 `npm test`。
- hook 崩溃不导致 agent 崩溃。

### Milestone 13: Tool Error Self-Healing

目标：工具失败后 agent 能自己调整策略。

任务：

- 所有工具错误结构化。
- recoverable 错误作为 tool result 反馈模型。
- Agent Loop 不因 recoverable tool error 退出。
- 每个 tool call 限制 retry chain，避免无限循环。
- 对常见错误附带修复建议：
  - FileNotFound: 建议 list/search。
  - SearchStringNotFound: 建议 read_file 重新确认。
  - CommandFailed: 返回 exit code/stdout/stderr。
  - SchemaValidationFailed: 返回 schema 摘要。

验收：

- 请求读取不存在文件时，agent 能搜索相近路径。
- edit search string 失败后，agent 能重新 read 并修正。
- shell 命令失败后，agent 能基于 stderr 调整。

### Milestone 14: Lightweight LSP Diagnostics Loop

目标：编辑后获得类型错误反馈。

第一版实现方式：

- 不接完整 LSP。
- 对 TypeScript 项目，在写/edit 后可自动运行：
  - `npx tsc --noEmit`
- 提取 diagnostics。
- 将 diagnostics 作为 tool result 附加给模型。
- 可通过配置关闭。

第二版可选：

- 接 `typescript-language-server`。
- 初始化 LSP。
- open/change document。
- 请求 diagnostics。

验收：

- agent 修改 TS 文件引入类型错误后，能看到 diagnostics。
- agent 能继续修复类型错误。
- 非 TS 项目不会误触发。

### Milestone 15: Prompt Caching

目标：降低多轮成本。

任务：

- 在 prompt builder 中区分 static sections 和 dynamic sections。
- static sections:
  - agent role
  - tool usage rules
  - general safety policy
  - stable skill descriptions
- dynamic sections:
  - cwd
  - git status
  - current date
  - project rules
  - memory recall
- Provider 层提供 prompt caching capability。
- Anthropic provider 使用 `cache_control`。
- OpenAI-compatible provider 不支持时 no-op。

验收：

- 不支持 caching 的 provider 行为不变。
- 支持 caching 的 provider 能标记 static prompt。
- 文档说明缓存命中对成本的影响。

### Milestone 16: Automated Eval Harness

目标：超过 scratch 的手动测试，形成工程可信度。

任务：

- `evals/cases/*.yaml`。
- Eval runner:
  - 创建临时 workspace。
  - 准备 fixture。
  - 运行 agent one-shot。
  - 执行断言。
  - 输出 JSON 和 Markdown report。
- 支持断言：
  - file_exists
  - file_contains
  - file_not_contains
  - command_succeeds
  - stdout_contains
  - session_contains
  - tool_called
  - tool_not_called
- 支持 mock model provider，用于 deterministic tool tests。
- 支持 real model eval，用于端到端手动确认。

验收：

- 至少 12 个 eval case。
- CI 或本地 `npm run eval` 可运行。
- 生成 `eval-report.md`。

## 7. 工具详细规范

### 7.1 read_file

输入：

```json
{ "path": "string", "offset": "number?", "limit": "number?" }
```

要求：

- 只能读取 cwd 内文件，除非配置允许额外 workspace。
- 记录 path、mtime、hash 到 read tracker。
- 大文件支持 offset/limit。
- 超过 large result 阈值时落盘。

### 7.2 write_file

输入：

```json
{ "path": "string", "content": "string" }
```

要求：

- 自动创建父目录。
- 默认需要 approval。
- 输出 diff 或创建摘要。
- 写后可触发 diagnostics。

### 7.3 edit_file

输入：

```json
{
  "path": "string",
  "oldString": "string",
  "newString": "string",
  "replaceAll": "boolean?"
}
```

要求：

- 默认不允许 replace all，除非明确传 `replaceAll: true`。
- 支持 curly quote -> straight quote fallback。
- oldString 为空时拒绝。
- 编辑后记录 diff。

### 7.4 grep_search

输入：

```json
{ "pattern": "string", "path": "string?", "include": "string?" }
```

要求：

- 优先调用 `rg`。
- `rg` 不存在时使用 JS fallback。
- 输出限制行数。

### 7.5 run_shell

输入：

```json
{ "command": "string", "timeoutMs": "number?" }
```

要求：

- 默认 timeout。
- 捕获 stdout/stderr/exit code。
- 进入 permission checker 和 shell analyzer。
- 支持 PowerShell/Bash 差异。

### 7.6 web_fetch

输入：

```json
{ "url": "string", "maxLength": "number?" }
```

要求：

- 超时。
- 限制响应大小。
- HTML 转文本。
- 网络错误结构化。

### 7.7 tool_search

要求：

- deferred tools 初始只暴露名称和摘要。
- tool_search 返回完整 schema。
- 激活后的 tool 才进入下一轮 tool definitions。

## 8. 权限与安全

### 8.1 Permission Modes

```ts
export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk";
```

语义：

- `default`: 写文件和 shell 需要确认。
- `acceptEdits`: 文件写入自动允许，shell 仍需确认。
- `bypassPermissions`: 所有操作自动允许，但危险命令必须记录风险。
- `plan`: 只读模式。
- `dontAsk`: 不能交互确认，遇到需要确认的操作直接拒绝。

### 8.2 Settings Rules

`.agent/settings.json` 示例：

```json
{
  "permissions": {
    "allow": [
      "read_file:*",
      "grep_search:*",
      "run_shell:npm test",
      "run_shell:npm run build"
    ],
    "deny": [
      "run_shell:git reset --hard",
      "run_shell:rm -rf *"
    ]
  }
}
```

deny 优先级高于 allow。

## 9. Prompt 规范

System Prompt 必须包括：

- agent 身份。
- 工作原则。
- 工具使用规则。
- 编辑安全规则。
- shell 安全规则。
- plan mode 规则。
- 项目规则。
- memory 摘要。
- skill 摘要。

Prompt 不应包含：

- 大文件全文。
- 完整 session 历史的无限增长。
- 不相关 memory。

Prompt builder 必须输出分区结构，支持未来 prompt caching：

```ts
interface PromptSection {
  name: string;
  content: string;
  cacheable: boolean;
}
```

## 10. Context 策略

### 10.1 Large Result Storage

阈值默认 30KB。

返回给模型：

```txt
Tool result was too large and has been stored at:
.agent/artifacts/2026-xx-xx/read_file_xxx.txt

Preview:
...
```

### 10.2 Compact

Compact 后 messages 应变成：

```txt
system
summary of previous conversation
recent user/assistant/tool messages
```

必须保留：

- 当前任务目标。
- 已修改文件。
- 已读文件 mtime。
- 未完成 plan。
- 关键工具结果 artifact path。

## 11. Eval Harness 规范

Case 示例：

```yaml
name: edit file safely
workspace:
  files:
    src/example.ts: |
      export const value = "foo";
prompt: Change foo to bar in src/example.ts
assert:
  file_contains:
    path: src/example.ts
    text: bar
  file_not_contains:
    path: src/example.ts
    text: foo
  tool_called:
    name: edit_file
```

必须提供至少 12 个 eval：

1. read file。
2. write file。
3. edit file。
4. read-before-edit guard。
5. grep search。
6. shell safety dangerous command。
7. session resume。
8. context large result。
9. plan mode blocks write。
10. skill invocation。
11. sub-agent explore。
12. MCP add tool。

增强 eval：

13. hook denies command。
14. tool error self-healing。
15. TypeScript diagnostics repair。
16. prompt caching no-op provider compatibility。

## 12. 测试标准

### 12.1 Unit Tests

必须覆盖：

- ToolRegistry。
- schema validation。
- edit_file safety。
- shell analyzer。
- permission checker。
- hook matcher。
- hook output parser。
- session store。
- large result store。
- MCP JSON-RPC framing。
- eval assertions。

### 12.2 Integration Tests

必须覆盖：

- Agent Loop with mock model。
- Tool error recovery with mock model。
- Plan mode permission blocking。
- MCP test server。
- Hook runner with fixture scripts。

### 12.3 Manual E2E

参考 `E:\AI Agent\claude-code-from-scratch-main\docs\14-testing.md`，必须保留一份 `docs/testing.md`，记录：

- 测试命令。
- 期望结果。
- 实际结果。
- 是否通过。
- 失败原因。

## 13. README 交付要求

README 必须包括：

- 项目定位。
- 功能列表。
- 与参考项目 `E:\AI Agent\claude-code-from-scratch-main` 的差异。
- 架构图。
- 快速开始。
- 配置 API。
- CLI 命令。
- 权限说明。
- Hook 示例。
- Skill 示例。
- MCP 示例。
- Eval 使用方式。
- Demo 截图或视频链接。

简历项目描述建议：

```txt
Built a TypeScript CLI coding agent from scratch with a typed tool plugin system,
tool-calling loop, safe file editing, permission modes, hooks, session resume,
context compaction, skills, sub-agents, MCP stdio integration, automated evals,
and a lightweight TypeScript diagnostics repair loop.
```

## 14. 开发约束

开发 agent 必须遵守：

- 每个 milestone 完成后运行 build 和相关测试。
- 不允许一次性实现所有模块。
- 不允许把所有工具写进一个大文件。
- 不允许让工具异常直接崩溃进程。
- 不允许跳过权限层直接执行 shell/write。
- 不允许在 plan mode 下修改普通项目文件。
- 不允许 silent failure；错误必须有 code、message、recoverable。
- 不允许把大工具结果完整塞回模型上下文。
- 不允许实现未列入 milestone 的大型功能，除非当前 milestone 已通过。

## 15. 推荐开发顺序

严格按以下顺序开发：

1. Bootstrap。
2. Typed Tool System。
3. Minimal Agent Loop。
4. File Tools。
5. Permission + Shell Safety。
6. CLI + Session。
7. Streaming + Parallel Tools。
8. Context Management。
9. Project Rules + Memory。
10. Skills。
11. Plan Mode。
12. Sub-Agent。
13. MCP。
14. Hooks。
15. Tool Error Self-Healing。
16. LSP Diagnostics Loop。
17. Prompt Caching。
18. Eval Harness。
19. README + docs + demo。

如果开发中遇到范围冲突，优先保证：

1. 可运行。
2. 安全。
3. 可测试。
4. 架构清晰。
5. 功能完整。

## 16. Definition of Done

项目完成必须满足：

- `npm run build` 通过。
- `npm test` 通过。
- `npm run eval` 生成报告。
- 至少 12 个 eval case 通过。
- 手动测试覆盖参考项目 `E:\AI Agent\claude-code-from-scratch-main\docs\14-testing.md` 的主要功能。
- README 完整。
- `docs/architecture.md` 完整。
- `docs/testing.md` 完整。
- 有 demo 视频或 GIF。
- 能在一个真实小型 TypeScript 项目中完成：
  - 读代码。
  - 搜索定位。
  - 修改文件。
  - 运行测试/类型检查。
  - 根据错误自修复。
  - 保存并恢复会话。

## 17. 最终判断标准

这个项目不是以“代码行数超过 scratch”为目标，而是以以下标准超过 scratch：

- 工具系统更工程化：typed plugin system。
- 扩展机制更完整：hooks。
- 可靠性更强：structured errors + self-healing。
- 安全性更强：shell analyzer + permission modes。
- 可信度更高：automated eval harness。
- coding 反馈更快：TypeScript diagnostics loop。
- 成本意识更好：prompt caching。

只要这些能力稳定可运行，项目工程价值就明显高于参考项目 `E:\AI Agent\claude-code-from-scratch-main`。
