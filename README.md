# Shannon Code

Shannon Code 是一个使用 TypeScript 编写的实验性命令行编程智能体，参考了 Claude Code 等工具的核心工作流。

项目目前处于 alpha 阶段，适合本地实验和代码仓库探索，尚不适合作为生产级自主编程系统使用。

## 主要功能

- 支持 OpenAI 兼容接口，可通过 `.env` 配置模型。
- 支持交互式 `shannon code` REPL 和一次性提示词。
- 提供文件读取、写入、编辑、搜索、Shell、网页读取和工具搜索能力。
- 支持交互审批、接受编辑、禁止询问、绕过权限和计划模式。
- 支持会话保存与恢复、记忆、Skills、Hooks、MCP 和子智能体。
- 支持上下文预算、手动压缩、超长提示自动重试和大型工具结果落盘。
- 支持 TypeScript 诊断。

## 环境要求

- Node.js 20 或更高版本。
- OpenAI 兼容接口的 API Key。

在项目根目录创建 `.env`：

```env
OPENAI_API_KEY=your-key
OPENAI_MODEL=gpt-4.1-mini
# OPENAI_BASE_URL=https://api.openai.com/v1
```

`.env` 已被 Git 忽略，不会提交到仓库。

## 安装

```powershell
npm install
npm run build
```

直接从当前仓库运行：

```powershell
node dist/cli/shannon.js code
```

也可以链接为本地命令：

```powershell
npm link
shannon code
```

## 使用

交互模式：

```powershell
shannon code
```

一次性任务：

```powershell
shannon code "检查当前项目并总结主要风险"
```

常用命令：

```text
/help
/cost
/compact
/plan
/memory
/skill
/exit
```

## 代码结构

- `src/core`：智能体循环、模型接口和错误处理。
- `src/tools`：工具实现、注册表和结果格式。
- `src/permissions`：权限模式、Shell 分析和审批。
- `src/context`：上下文预算、压缩和大型结果存储。
- `src/cli`：参数解析、REPL 和终端输出。
- `src/session`、`src/memory`、`src/skills`、`src/hooks`、`src/mcp`、`src/subagent`：扩展能力。

## Prompt Caching

系统提示词由命名区段组成。静态区段可以跨回合缓存，动态区段会在每次请求时重新生成。

可缓存的静态区段：

- `agent_core`：角色、工具使用说明和通用安全策略。
- `skills`：稳定的 Skill 名称、说明、模式和允许使用的工具。

动态区段：

- `workspace`：当前工作目录和日期。
- `project_rules`：本地 `AGENTS.md`、`CLAUDE.md` 或其他规则文件。
- `memory`：当前提示词召回的记忆。

模型提供方通过 `supportsPromptCaching` 声明是否支持缓存。不支持时，Shannon 会继续发送普通文本系统提示词；支持时，系统消息会附带通用的 `cacheControl: { type: "ephemeral", key, sectionNames }` 元数据和提示词区段。Anthropic 风格的提供方可以将其转换为原生 `cache_control` 字段，OpenAI 兼容的 Chat Completions 提供方目前会忽略该元数据。

缓存命中可以降低重复静态提示词的输入成本和延迟。动态区段不参与缓存键计算，因此工作目录、项目规则或记忆发生变化时不会复用过期上下文。

## 已知限制

- 智能体循环比生产级编程智能体更简单。
- `tool_search` 目前只返回工具定义，尚未实现完整的延迟工具激活。
- CLI 使用原生 readline 和终端滚动记录，没有全屏 TUI。

## 许可证

MIT
