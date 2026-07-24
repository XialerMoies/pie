<p align="center">
  <img src="https://img.shields.io/badge/tests-379%20%E2%9C%93-34D399?style=flat&labelColor=1a1a2e" alt="Tests">
  <img src="https://img.shields.io/badge/license-AGPLv3-6366F1?style=flat&labelColor=1a1a2e" alt="License">
  <img src="https://img.shields.io/badge/electron-30-F59E0B?style=flat&labelColor=1a1a2e" alt="Electron">
  <img src="https://img.shields.io/badge/typescript-5.9-3178C6?style=flat&labelColor=1a1a2e" alt="TypeScript">
</p>

# pie

> 桌面端 AI 代码助手。基于 PI 框架，会话先创建草稿、首次发送才落地持久化；支持多会话标签页、工具调用流式渲染、Monaco 编辑器、Git 集成、MCP 客户端、Problems 面板。

一个轻量级的桌面端 AI 编码助手，具备 VS Code 风格的文件浏览、多会话管理、流式 AI 回复渲染、TypeScript 语言服务、代码诊断与快速修复。Electron 原生窗口 + 本地 HTTP 服务端，不依赖远程 IDE 扩展。

---

## 界面预览

```
┌────────────────────────────────────────────────────────┐
│  pie                  文件         会话     ─  □  ✕    │
├──────┬──────────┬─────────────────────────────────────┤
│      │ explorer │  ╔═════════════════════════════════╗ │
│  📁   │ src/     │  ║ 用户: 检查一下这个文件          ║ │
│  💬   │ server/  │  ║                               ║ │
│  🔍   │ agent/   │  ║ AI: 让我先查看一下结构          ║ │
│  ⎔    │ ...      │  ║  📖 读取文件  server.ts       ║ │
│  🧩   │          │  ║   这个模块主要负责...           ║ │
│      │          │  ╚═════════════════════════════════╝ │
├──────┴──────────┴─────────────────────────────────────┤
│  ⚠ 3 ⨯ 2 ▲ 5   模型: deepseek  ·  模式: 自动  ·  努力: 中  │
│  ┌───────────────────────────────────────────────────┐ │
│  │ 输入消息...                                      ↑ │ │
│  └───────────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────────┘
```

---

## 功能

### 会话管理

- 多会话标签页（文件/会话/草稿三种类型统一管理），支持切换/关闭/重命名/拖拽重排
- 草稿模式：新建会话不立即落盘，首次发送才创建持久化 session
- 会话历史按项目分组，支持固定
- 关闭窗口前自动保存 UI 状态（标签、活跃视图、面板位置），跨重启恢复

### AI 交互

- 流式 SSE 回复，实时渲染 token
- 工具调用内联展示（搜索/读文件/Git/命令），支持展开详情、折叠思考过程
- 三种模式（自动/解释/计划）+ 五档思考深度
- Token 用量面板：实时用量、上下文窗口条、缓存命中率
- 运行时热切换模型/供应商

### 编辑器集成

- Monaco Editor（VS Code 核心编辑器），支持语法高亮、自动补全、悬停提示、跳转定义/引用
- TypeScript 语言服务：诊断轮询（2s）、语法/语义错误标注、快速修复（Code Actions + lightbulb）
- 多文件标签页，支持拖拽重排、右键菜单
- 图片/视频标签页内预览（png/jpg/gif/webp/svg，mp4/webm 支持 Range/206 拖拽）
- 格式化、多光标、Minimap、Breadcrumbs（Monaco 内置支持）

### 代码诊断与修复

- Problems 底部栏：`ProblemsStore` 数据驱动，摘要栏（错误/警告/信息计数）+ 可展开列表
- 问题条目点击跳转到对应文件和位置（40 帧重试保证 Monaco 就绪）
- Code Actions：Monaco lightbulb 触发 → `POST /api/ts/code-actions` 获取 quick fix → `apply-code-action` 写盘并刷新多文件
- 整理导入（organize-imports）

### MCP 客户端

- 协议支持：stdio / HTTP / SSE 三种传输
- 配置发现：`.mcp.json`（工作区级） + `mcp.json`（全局级），自动合并
- 信任存储：首次运行提示确认，拒绝则禁用
- 管理面板：启停/状态/日志查看
- 探索市场：9 个精选 MCP 服务一键安装
- 工具包装：MCP 工具作为 Agent tool 调用，流式输出支持

### 搜索

- 全项目代码搜索（文件名 + 全文两种模式）
- Quick Open 文件快速跳转（Ctrl+P）

### 工具与集成

- 6 个自定义 Agent 工具：代码搜索、文件阅读、目录浏览、Git 状态/日志、文件结构预览
- Git 面板：状态查看、提交、推送、拉取
- Web 搜索：`web-search` + `web-fetch`（URL 抓取转文本），Provider 原生 + Bing 自适应
- 附件系统：拖放文件/文件夹作为 LLM 上下文，64KB/文件 256KB 总量

---

## 快速开始

### 开发模式

```bash
# 安装依赖
npm install

# 启动桌面开发（编译 TS + pi-server + Electron）
npm run dev

# 或只启动 CLI 模式
npm run cli
```

开发模式下三个进程独立运行：
- Vite Dev Server (`:5173`) — HTML/CSS 热更新
- pi-server (`:3099`) — HTTP API + SSE + tsserver
- Electron — 加载 Vite URL，preload 桥接窗口控制

### 构建桌面版

```bash
# 构建前端 + Electron 主进程
npm run build

# 打包为 Windows 便携 exe
npm run dist:portable
# 产物：release/pie-${version}.exe
```

构建后 `data/` 目录在 exe 旁边自动创建，所有配置和会话数据存在里面。

### 测试

```bash
npm test            # 全量 379 项测试（约 12s）
npm run test:build  # 构建验证 + smoke test
npm run typecheck   # TypeScript 类型检查
```

| 套件 | 数量 | 覆盖 |
|------|------|------|
| unit | 185 | prompts / tree / explorer-service / tool 输入验证 / ui-state-store / usage-index / mcp-config / mcp-trust / mcp-client / mcp-client-service / tab-store / search-replace |
| routes | 115 | 全部 API handler / session / block 协议 / SSE / trace / code-actions / organize-imports / search-replace |
| frontend | 79 | 消息渲染 / chat-ui / session-ui / workspace-ui / app-tabs / file-restore / problems-store / bottom-bar |
| CSS | 20+20 | 变量定义完整性扫描（dark + light 各 20 项） |

---

## 配置

API Key 放在 `data/pi/auth.json`：

```json
{
  "deepseek": "sk-xxxxxxxxxxxxxxxx"
}
```

也支持通过环境变量 `DEEPSEEK_API_KEY` 设置。

模型列表在 `data/pi/models.json`，可在设置界面切换。

MCP 服务器配置：
- 工作区级：项目目录下的 `.mcp.json`
- 全局级：`data/pi/mcp.json`

---

## 技术栈

| 层 | 技术 |
|------|------|
| 桌面壳 | Electron 30 + TypeScript |
| 前端 | Vanilla TypeScript + esbuild + Vite (Monaco bundle) |
| 编辑器 | Monaco Editor 0.55 |
| 后端 | Node.js HTTP + SSE + tsserver |
| AI 框架 | `@xiamol/pi-coding-agent` v0.80.4（自 fork） |
| MCP | `@modelcontextprotocol/sdk` |
| 测试 | Node Test Runner + happy-dom |
| 构建 | electron-builder (Windows portable) |

---

## 架构

```
[Electron Main Process]
       │
       ├── preload.ts → electronAPI (window/file/terminal)
       │
       └── spawn → [pi-server (子进程)]
              │
              ├── HTTP API + SSE ← [BrowserWindow]
              │
              ├── tsserver (TypeScript 语言服务)
              │
              └── PI SDK (ReAct Loop) ← LLM API
                      │
                      └── MCP Client → stdio/HTTP/SSE servers
```

前端数据流：

```
UiStateStore (persisted JSON)
     │
TabStore ──→ File/ Session/ Chat 标签统一管理
     │
ProblemsStore ──→ Monaco diagnostics → 底部栏
     │
 pane/*      5 个注册面板（explorer / chat / search / git / mcp）
     │
 dashboard/  布局、会话管理、设置、快捷键
```

三层职责：

- **Desktop** — Electron 主进程，窗口生命周期、崩溃恢复、preload 桥
- **Agent** — `AgentRuntime` + `ToolRegistry` + 6 个自定义工具 + MCP 工具适配，封装 PI SDK
- **PI SDK** — 自 fork 版（v0.80.4），修了 compaction 等底层 bug，新增 max 思考档位

---

## 项目结构

```
src/
├── server/              # HTTP 服务端 + 领域路由
│   ├── routes/          # 9 个 handler：chat/dashboard/sessions/explorer/git/search/settings/typescript/ui-state
│   ├── ts-server.ts     # tsserver 子进程管理
│   └── server.ts        # 入口：HTTP server + SSE + 事件适配
├── agent/               # PI 自定义层
│   ├── runtime.ts       # AgentRuntime（session 生命周期）
│   ├── prompts.ts       # System prompt 分片管理
│   ├── types.ts         # AgentTool + ToolRegistry
│   └── tools/           # 6 个自定义工具 + MCP 工具包装
├── mcp/                 # MCP 客户端
│   ├── client.ts        # 连接管理（stdio/http/sse）
│   ├── config.ts        # 配置发现与合并
│   ├── trust-store.ts   # 信任存储
│   └── service.ts       # 启停生命周期
├── electron/            # Electron 主进程 + preload
├── frontend/            # 纯客户端 SPA
│   ├── dashboard/       # 布局/会话/设置/菜单/快捷键
│   ├── chat/            # 消息渲染/Mode/Token/附件
│   ├── editor/          # Monaco 集成 + tsserver 代理
│   ├── services/        # TabStore / ProblemsStore / UiStateStore
│   ├── pane/            # 5 面板（explorer / chat / search / git / mcp）
│   └── ui/              # Tree 组件 + ContextMenu
test/                    # 27 个测试文件，367 项
scripts/                 # 编译/构建/清理脚本
```

---

## 许可

AGPL v3
