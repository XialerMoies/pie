# My Code Agent 学习路线

> 更新时间：2026-07-06
> 当前里程碑：架构重组完成（Phase 2）

## Phase 1: 跑通项目（已完成 ✅）

- [x] 安装 PI (v0.80.3) 并基于它搭建项目
- [x] 集成 Electron 桌面壳 + pi-server 子进程
- [x] 纯前端 SPA（vanilla TS，无框架）
- [x] 文件树、标签页、Pane 系统
- [x] 构建管线（Vite + esbuild + Electron 打包）

## Phase 2: 架构规范化（已完成 ✅）

- [x] **server.ts 路由拆分** — 800+ 行平铺 if-else 拆到 5 个领域路由文件
- [x] **Agent 层封装** — `src/agent/` 统一入口，system prompt 分片管理
- [x] **Pane 模块化** — 所有面板走 `registerPane`，无内联 fallback
- [x] **Electron 崩溃恢复** — 健康检查 + 自动重启 + preload 桥补全
- [x] **命名空间收敛** — `window.xxx` 归到 `App.*` 命名空间

## Phase 3: 框架定制（当前目标）

- [ ] System Prompt 分片缓存（`defineSection` → `resolveSystemPrompt`）
- [ ] 注册第一个自定义 Tool
- [ ] 读通 PI 内置工具实现（read/write/bash）
- [ ] 子 Agent 编排（Research → Synthesize → Implement → Verify）

## Phase 4: Dogfooding

- [ ] 用自己写的 Agent 来开发 Agent 本身
- [ ] 写 dev journal 记录每次迭代学到了什么

## Phase 5: 面试准备

- [ ] 能演示：用 Agent 完成一个完整的 CRUD 接口编写
- [ ] 能讲清：ReAct 循环、Tool 注册、错误恢复、System Prompt 分片
- [ ] 能回答："相比于 Claude Code 你的 Agent 有什么不同"
- [ ] 能画出架构图：Electron 进程模型 → Server 路由 → Agent 层 → PI SDK

## 关键问题清单（面试会问的）

- [ ] ReAct 循环怎么实现的？
- [ ] 怎么保证 Tool 调用的安全性？（路径沙箱、命令白名单）
- [ ] 上下文窗口满了怎么办？（压缩策略）
- [ ] 多个 Tool 同时调用的并发控制？
- [ ] 怎么测试你的 Agent？
- [ ] Electron 为什么要用子进程跑 server 而不是直接集成？
- [ ] 为什么选择 vanilla TS 而不是 React/Vue？
