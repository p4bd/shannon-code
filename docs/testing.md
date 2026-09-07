# Shannon Code Product Testing Guide

日期：2026-06-01

本指南按 `DEV_SPEC.md` 和参考项目 `docs/14-testing.md` 改写，用来验收 Shannon Code 是否达到稳定可用的 mini Claude Code 水平。测试分三层：

- 自动化回归：`npm test`、CLI E2E、eval、perf，优先使用 mock provider。
- 脚本化真实 CLI：启动真实 `shannon code`，通过 stdin 自动输入任务和审批。
- 真实模型 E2E：使用项目根 `.env` 中的 `gpt-5.4-mini` 验证真实 agent 行为。

## 安全边界

- 只在 Shannon 项目根或临时 workspace 内写入。
- 可以自动审批临时 workspace 内的安全 `write_file`、`edit_file`、`mkdir`、`npm test`、`npm run build`、`dir/ls/type/cat`。
- 禁止项目删除、磁盘格式化、`git reset --hard`、`git clean -fd`、非临时目录递归删除、读取密钥文件、推送代码。
- 任何越出测试 workspace 或 Shannon 项目根的写操作都应拒绝并记录为安全风险。

## 准备

```powershell
cd "E:\AI Agent\Shannon code"
npm run build
node dist/cli/shannon.js code --help
```

全局配置来源：

```text
E:\AI Agent\Shannon code\.env
```

运行任意目录的 `shannon code` 时，该 `.env` 是 API 配置来源；当前目录只作为 workspace。

## 自动化基线

| 命令 | 目标 | 当前结果 |
| --- | --- | --- |
| `npm run build` | TypeScript 编译 | PASS |
| `npm test` | 单元 + 集成测试 | PASS，42 files / 162 tests |
| `npm run test:cli` | CLI/REPL E2E | PASS，20 tests |
| `npm run eval` | 确定性 eval | PASS，12/12 |
| `npm run perf` | 本地性能 smoke | PASS，3/3 |
| `npm run test:all` | build + test + eval + perf | PASS |
| `npm run smoke:api` | 真实 API chat/stream/tool calling | PASS |
| `npm run smoke:cli` | 真实 CLI read_file smoke | PASS |
| `npm run smoke:real-e2e` | 真实模型产品 E2E | PASS，7/7 |
| `npm run smoke:dogfood` | 真实 CLI dogfood | PASS，13/13 |
| `npm audit --audit-level=moderate` | 依赖漏洞检查 | PASS，0 vulnerabilities |

最新 perf smoke：

| Metric | 当前结果 |
| --- | ---: |
| `list_files` recursive 240 files | 113.3ms |
| `grep_search` 240 files | 141.4ms |
| agent 30 `read_file` loop | 54.4ms |

本轮 architecture-gap 记录见 `docs/architecture-gap.md`。

## 脚本化真实 CLI E2E

入口：

```powershell
npm run smoke:real-e2e
```

该脚本会创建临时 workspace，默认启动本仓库 `dist/cli/shannon.js code`，自动输入任务，自动审批或拒绝安全操作，并生成：

- `real-product-e2e-report.json`
- `real-product-e2e-report.md`

当前真实模型覆盖：

| 场景 | 状态 | 验证点 |
| --- | --- | --- |
| 中文路径空目录创建贪吃蛇 | PASS | `E:\...\贪吃蛇` 等价路径、`write_file` 审批、真实 `index.html` |
| 拒绝写入 | PASS | `n` 拒绝后文件不存在，模型收到 recoverable result |
| Session resume | PASS | `--resume` 能召回上一轮 `BANANA-42` |
| Shell 失败恢复 | PASS | `node missing-script.js` 失败后运行 `node --version` |
| ToolSearch | PASS | 真实模型调用 `tool_search` 并发现 `web_fetch` |
| WebFetch | PASS | 真实模型调用 `web_fetch` 读取本地 HTTP 页面 |
| Plan mode | PASS | `/plan` 生成计划，`/plan approve` 后审批 `write_file` 并执行 |

## 脚本化 Dogfood

入口：

```powershell
npm run smoke:dogfood
```

该脚本比 `smoke:real-e2e` 更接近真实用户使用：它默认启动本仓库 `dist/cli/shannon.js code`，通过 stdin 输入任务，自动处理审批，并检查工具输出、文件结果、错误恢复和 session。运行后生成：

- `dogfood-report.json`
- `DOGFOOD_REPORT.md`

可选环境变量：

- `DOGFOOD_REPEAT=2`：重复跑多轮，最多 5 轮。
- `DOGFOOD_KEEP_WORKSPACE=1`：保留临时 workspace 供排查。
- `SHANNON_DOGFOOD_BIN=shannon`：覆盖默认本地 CLI，指定要测试的 Shannon 命令。

当前 dogfood 覆盖：

| 场景 | 状态 | 验证点 |
| --- | --- | --- |
| coding loop | PASS | 运行失败测试、修复文件、再次测试通过 |
| FileNotFound 恢复 | PASS | typo path 失败后 `list_files` + 正确 `read_file` |
| SearchStringNotFound 恢复 | PASS | intentional failed `edit_file` 后再次编辑成功 |
| 大输出 artifact | PASS | 70KB shell stdout 落盘 `.agent/artifacts` |
| MCP | PASS | 本地 MCP stdio server 的 `mcp__test__add` |
| Hooks | PASS | PreToolUse hook 拒绝 `run_shell` 后模型停止重试 |
| Plan mode | PASS | `/plan` 保存计划，`/plan approve` 后执行写入 |
| Permissions | PASS | `acceptEdits` 自动允许写入，`dontAsk` 可预测拒绝写入 |
| Skills | PASS | `/skill` inline skill 输出预期 marker |
| Web fetch | PASS | `web_fetch` 读取本地 HTTP 页面 |
| Windows 中文路径 | PASS | 中文路径 workspace 下写入 `index.html` |
| Session resume | PASS | `--resume` 召回上一轮内容 |

## 产品验收矩阵

| # | 功能 | 自动化 | 真实 CLI/模型 | 状态 | 备注 |
| --- | --- | --- | --- | --- | --- |
| 1 | `shannon code` 任意目录启动 | PASS | PASS | PASS | dist wrapper 测试根 `.env` 优先级；真实 CLI 已验证 |
| 2 | 根 `.env` 全局生效 | PASS | PASS | PASS | workspace 只作为工作目录 |
| 3 | 用户输入/Agent 输出区分 | PASS | PASS | PASS | `You >`、`Agent >`、`[tool]` |
| 4 | 默认权限审批 `y/n/a` | PASS | PASS | PASS | REPL 默认写入会询问；拒绝可恢复 |
| 5 | one-shot 无交互审批 | PASS | PASS | PASS | 清晰返回 approval unavailable，不写文件 |
| 6 | `read_file` | PASS | PASS | PASS | CLI smoke 真实模型覆盖 |
| 7 | `write_file` | PASS | PASS | PASS | REPL 审批和真实创建文件覆盖 |
| 8 | `edit_file` | PASS | PASS | PASS | read-before-edit、自修复、引号 fallback、SearchStringNotFound dogfood 覆盖 |
| 9 | `list_files` | PASS | PASS | PASS | plan 真实 E2E 调用；perf 覆盖 240 文件；递归默认跳过 `node_modules` / `.git` |
| 10 | `grep_search` | PASS | 待人工抽样 | PASS | unit/eval/perf 覆盖；默认排除 `node_modules` / `.git` |
| 11 | `run_shell` | PASS | PASS | PASS | 失败恢复、中文输出解码、危险命令拦截；大输出落盘 |
| 12 | `web_fetch` | PASS | PASS | PASS | unit、CLI mock、真实模型本地 HTTP 覆盖 |
| 13 | `tool_search` | PASS | PASS | PARTIAL | 基础工具搜索可用；尚未实现真正 deferred schema 激活 |
| 14 | Session 保存和 `--resume` | PASS | PASS | PASS | one-shot 和真实模型覆盖 |
| 15 | `/help`、`/exit`、`/clear`、`/cost`、`/compact` | PASS | 待人工抽样 | PASS | CLI E2E 覆盖 |
| 16 | `/memory` add/list/delete/recall | PASS | 待人工抽样 | PASS | unit + REPL 命令覆盖 |
| 17 | `/plan` | PASS | PASS | PASS | 真实模型执行通过 |
| 18 | `/skill` inline/fork | PASS | PASS | PASS | CLI E2E 覆盖；inline skill 已 dogfood |
| 19 | Sub-agent explore/plan/general | PASS | 待人工抽样 | PASS | mock + CLI startup path 覆盖 |
| 20 | MCP stdio | PASS | PASS | PASS | 启动、工具发现、工具失败恢复、server 失败恢复；MCP add 已 dogfood |
| 21 | Hooks | PASS | PASS | PASS | PreToolUse/PostToolUse 覆盖；PreToolUse deny 已 dogfood；OnAgentFinish 需后续增强 |
| 22 | 大文件结果持久化 | PASS | PASS | PASS | `read_file`、`run_shell`、`write_file`、`edit_file` artifact 覆盖；大 shell 输出已 dogfood |
| 23 | prompt too long 自动 compact | PASS | 待人工抽样 | PASS | integration 覆盖；compact 保留 tool call/result 组 |
| 24 | 工具错误自修复 | PASS | PASS | PASS | FileNotFound、ReadBeforeEditRequired、SearchStringNotFound、CommandFailed |
| 25 | 长任务稳定性 | PASS | 待长时间 soak | PASS | 30 轮 agent perf，16 轮 integration |
| 26 | 性能 | PASS | 不适用 | PASS | 当前本机 smoke 全部低于阈值 |

## 手动抽样场景

### A. 任意目录启动

```powershell
cd C:\Users\yangjingqian
shannon code
```

预期：

- 不报 `Missing OPENAI_API_KEY`。
- 显示 `Workspace: C:\Users\yangjingqian`。
- `/exit` 可保存 session 后退出。

### B. 中文路径创建小游戏

```powershell
mkdir "E:\AI Agent\贪吃蛇-e2e"
cd "E:\AI Agent\贪吃蛇-e2e"
shannon code
```

输入：

```text
帮我在当前目录做一个单文件贪吃蛇小游戏
```

预期：

- 出现 `Permission request: write_file`。
- 输入 `a` 后创建 `index.html`。
- 用户输入、Agent 输出、工具调用可区分。
- `run_shell` 的中文输出不乱码。

### C. one-shot 审批不可用

```powershell
shannon code "创建 one-shot-denied.txt，内容为 denied"
```

预期：

- 不等待 stdin。
- 工具结果明确提示 `interactive approval is not available in this run`。
- 不应声称已写入。

### D. Plan mode

```text
/plan 给这个空目录创建一个小网页游戏
/plan status
/plan approve
```

预期：

- plan 阶段只能只读检查或写 `.agent/plans/*.md`。
- approve 后再执行普通写入并触发默认审批。
- plan 文件可追溯。

## 已知缺口

- `tool_search` 当前是基础工具搜索，尚未实现 Claude Code 式 deferred tool schema 激活。
- Hooks 已覆盖 PreToolUse/PostToolUse；OnAgentFinish 还需要补更强的产品级 E2E。
- 真实模型 E2E 和 dogfood 已覆盖关键路径，但仍建议后续做 30 分钟以上 soak test 和跨平台 CI。
- Shannon 仍缺完整版 Claude Code 的 streaming tool executor、工具取消传播、权限队列、classifier、完整 LSP server manager。当前定位是 scratch 的增强简化版，不建议一次性照搬这些重机制。
