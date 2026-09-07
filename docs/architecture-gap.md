# Architecture Gap Analysis

日期：2026-06-01

## 参考范围

- 简化版参考：`E:\AI Agent\claude-code-from-scratch-main\src`
- 完整版参考：`E:\AI Agent\claude-code-from-scratch-main\Claude code src`
- Shannon 当前实现：`src/core`、`src/tools`、`src/permissions`、`src/context`、`src/cli`

## Shannon 相对 scratch 的提升

- 工具系统已经从单文件工具表升级为 typed registry，每个工具有独立 schema、权限元数据、执行逻辑和结构化 `ToolResult`。
- 权限系统比 scratch 更清晰：`default`、`acceptEdits`、`bypassPermissions`、`plan`、`dontAsk` 独立实现，REPL 审批复用同一个 readline，避免 stdin 冲突。
- 已有 hooks、MCP stdio、skills、sub-agent、TypeScript diagnostics、prompt caching no-op、eval/perf/smoke 脚本，比 scratch 更像可维护产品。
- 已有 read-before-edit、mtime/hash guard、symlink/junction realpath 防护、结构化工具错误和重复失败 tool call 限制。

## Shannon 相对完整版 Claude Code 的关键差距

- Agent loop 仍是单层同步回合模型；完整版有 streaming tool executor、进度消息、取消传播、并发上限、工具结果按原始顺序缓冲输出。
- 上下文管理仍是轻量 compact；完整版有多层压缩策略，包括 stale tool result snip、microcompact、工具结果持久化和更细的 token budget。
- `tool_search` 当前只是搜索并返回 schema；完整版有真正 deferred tool activation 和 discovered-tool set，用于减少每轮 schema token。
- 权限系统没有完整版的 classifier、权限队列、permanent/session 规则写回、hook permission request、复杂 UI 决策来源追踪。
- LSP 目前只在 TS 写入后跑 `tsc --noEmit`；完整版有 LSP server manager、被动 diagnostics 注册和跨语言诊断通道。
- CLI UI 是普通文本 REPL；完整版有 richer TUI、任务状态、进度、可中断工具、transcript rendering。

## 本轮采用的优化边界

- 不引入完整版 streaming executor 或权限队列，避免一次性改动 agent loop 主架构。
- 优先修复会导致真实 API 报错、上下文膨胀、依赖目录扫描拖慢的低风险问题。
- 将 deferred tool activation、长期 soak、完整 LSP、权限持久化记录为后续路线。

## 本轮已处理的差距

- compact 现在会保留 assistant `toolCalls` 与随后的 `tool` result 组，避免压缩后生成 orphan tool result 历史。
- `run_shell`、`write_file`、`edit_file` 的大结果现在接入 artifact 机制，避免大日志或大 diff 直接塞回模型上下文。
- diff 输出改为带上下文 hunk，不再对一次小编辑返回整份旧文件和整份新文件。
- `list_files` / `grep_search` 默认避开 `node_modules` 和 `.git`，减少高噪声、高成本扫描。
