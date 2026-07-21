<p align="center">
  <img src="https://img.shields.io/badge/tests-163%20%E2%9C%93-34D399?style=flat&labelColor=1a1a2e" alt="Tests">
  <img src="https://img.shields.io/badge/license-AGPLv3-6366F1?style=flat&labelColor=1a1a2e" alt="License">
  <img src="https://img.shields.io/badge/electron-30-F59E0B?style=flat&labelColor=1a1a2e" alt="Electron">
  <img src="https://img.shields.io/badge/typescript-5.9-3178C6?style=flat&labelColor=1a1a2e" alt="TypeScript">
</p>

# pie

> 桌面端 AI 代码助手。基于 PI 框架，会话先创建草稿、首次发送才落地持久化；支持多会话标签页、工具调用流式渲染、Monaco 编辑器、Git 集成。

一个轻量级的桌面端 AI 编码助手，具备 VS Code 风格的文件浏览、多会话管理、流式 AI 回复渲染。Electron 原生窗口 + 本地 HTTP 服务端，不依赖远程 IDE 扩展。

---

## 界面预览

```
┌───────────────────────────────────────────────────┐
│  PI               文件         ─  □  ✕            │
├──────┬──────────┬────────────────────────────────┤
│      │  explorer │  ╔══════════════════════════╗  │
│  📁   │  src/     │  ║ 用户: 检查一下这个文件    ║  │
│  💬   │  server/  │  ║                          ║  │
│  🔍   │  agent/   │  ║ AI: 让我先查看一下结构    ║  │
│  ⎔    │  ...      │  ║  📖 读取文件  server.ts  ║  │
│      │           │  ║  这个模块主要负责...      ║  │
│      │           │  ╚══════════════════════════╝  │
├──────┴──────────┴────────────────────────────────┤
│  模型: deepseek-v4  ·  模式: 自动  ·  努力: 中    │
│  ┌──────────────────────────────────────────────┐ │
│  │ 输入消息...                                 ↑ │ │
│  └──────────────────────────────────────────────┘ │
└───────────────────────────────────────────────────┘
```

---

## 功能

**会话管理**
- 多会话标签页，支持切换/关闭/重命名
- 草稿模式：新建会话不立即落盘，首次发送才创建持久化 session
- 会话历史按项目分组，支持固定和归档
- 关闭窗口前自动保存 UI 状态（活跃会话、面板位置），重启后恢复

**AI 交互**
- 流式 SSE 回复，实时渲染 token
- 工具调用内联展示（搜索/读文件/查看Git），支持展开详情
- 思考过程折叠展示，简洁阅读
- 三种模式（自动/解释/计划）+ 五档思考深度

**编辑器集成**
- Monaco Editor（VS Code 核心编辑器），支持语法高亮和语言服务
- 文件标签页（VS Code 风格多标签切换）
- 文件树浏览，支持拖放、右键菜单、行内重命名

**工具与集成**
- 6 个自定义 Agent 工具：代码搜索、文件阅读、目录浏览、Git 状态/日志、文件结构预览
- Git 面板：状态查看、提交、推送、拉取
- 全项目代码搜索（文件名 + 全文两种模式）
- 附件系统：拖放文件/文件夹作为 LLM 上下文

---

## 快速开始

### 开发模式

```bash
# 安装依赖
npm install

# 启动桌面开发（Vite HMR + pi-server + Electron）
npm run dev

# 或只启动 CLI 模式
npm run cli
```

开发模式下三个进程独立运行：
- Vite Dev Server (`:5173`) — HTML/CSS 热更新
- pi-server (`:3099`) — HTTP API + SSE
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
npm test            # 全量 163 项测试
npm run test:build  # 构建验证 + smoke test
npm run typecheck   # TypeScript 类型检查
```

| 套件 | 数量 | 覆盖 |
|------|------|------|
| unit | 54 | prompts / tree / explorer-service / tool 输入验证 |
| routes | 65 | 全部 API handler / session / block 协议 / SSE / trace |
| frontend | 44 | msgs 渲染 / chat-ui / session-ui / workspace-ui / CSS |

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

---

## 技术栈

| 层 | 技术 |
|------|------|
| 桌面壳 | Electron 30 + TypeScript |
| 前端 | Vanilla TypeScript + esbuild + Vite (Monaco bundle) |
| 编辑器 | Monaco Editor 0.55 |
| 后端 | Node.js HTTP + SSE |
| AI 框架 | `@xiamol/pi-coding-agent` v0.80.3（自 fork） |
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
              └── PI SDK (ReAct Loop) ← LLM API
```

三层职责：

- **Desktop** — Electron 主进程，窗口生命周期、崩溃恢复、preload 桥
- **Agent** — `AgentRuntime` + `ToolRegistry` + 6 个自定义工具，封装 PI SDK
- **PI SDK** — 自 fork 版，只修了 compaction 等底层 bug，应用逻辑不往里放

详细架构见 `src/server/routes/` 和 `src/agent/`。

---

## 项目结构

```
src/
├── server/          # HTTP 服务端 + 领域路由
│   ├── routes/      # 9 个 handler：chat/dashboard/sessions/explorer/git/search/settings/typescript/ui-state
│   └── server.ts    # 入口：HTTP server + SSE + 事件适配
├── agent/           # PI 自定义层
│   ├── runtime.ts   # AgentRuntime（session 生命周期）
│   ├── prompts.ts   # System prompt 分片管理
│   ├── types.ts     # AgentTool + ToolRegistry
│   └── tools/       # 6 个自定义工具
├── electron/        # Electron 主进程 + preload
├── frontend/        # 纯客户端 SPA
│   ├── dashboard/   # 布局/会话/设置/菜单
│   ├── chat/        # 消息渲染/Mode/Token/附件
│   ├── pane/        # 4 面板（explorer/chat/search/git）
│   ├── editor/      # Monaco 集成
│   └── ui/          # Tree 组件
test/                # 17 个测试文件，163 项
```

---

## 许可

AGPL v3
