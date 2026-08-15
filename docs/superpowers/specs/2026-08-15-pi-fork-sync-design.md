# PI Fork v0.84.2 同步设计

## 目标

将 `XialerMoies/pi` 从当前旧基线同步到上游稳定标签 `v0.84.2`，保留确有必要的本地行为，并建立可重复构建、测试、发布和回滚的薄 fork 流程。

本批只处理 PI fork 同步。精准在线 Token usage 和自定义第三方厂商设置页在新 fork 接入 `my-code-agent` 后分别设计和实施，避免基于 0.80.4 重复开发。

## 已确认状态

- fork：`https://github.com/XialerMoies/pi.git`
- fork `main`：`de5c5854`
- 上游：`https://github.com/earendil-works/pi.git`
- 上游稳定标签：`v0.84.2`，提交 `914cf147`
- 上游当前 `main`：`086c32e7`
- 分叉基点：`d53b5676`
- fork 相对上游：领先 2 个提交，落后 856 个提交
- fork 独有提交：
  - `f0279e44`：`estimateTextAndImageContentChars` 数组防御检查
  - `de5c5854`：max thinking level 支持，涉及 PI AI provider/model 定义
- `my-code-agent` 当前依赖 `@xiamol/pi-coding-agent@0.80.4`
- 本机 `E:\pi-agent` 工作区有未提交改动和嵌套仓库，不能作为同步操作目录

## 同步策略

### 1. 使用稳定标签，不追随移动的 main

从上游 `v0.84.2` 创建 `codex/pi-sync-v0.84.2`。同步过程中不改 fork 现有 `main`，通过独立 worktree 完成审计、修改和验证。

不把 856 个提交直接 merge 到旧分支，也不对旧 fork 做长距离 rebase。新分支以稳定发布标签为干净基线，可以减少历史冲突并保持发布来源可追溯。

### 2. 按行为重放两个补丁

不直接 cherry-pick 旧提交。

- 数组防御检查：先检查 0.84.2 的输入类型、调用路径和既有测试。若异常输入仍可到达该函数，补一个最小防御和回归测试；若新版已从类型或转换层保证数组，则记录为已被上游替代。
- max thinking level：检查 0.84.2 的 thinking level 类型、provider 能力声明、模型生成流程和 DeepSeek 覆盖。只补上游仍缺失的行为，不批量手改生成模型文件；任何模型定义变化必须进入生成源或正式覆盖层。

每个保留补丁必须有独立提交、行为测试和一段维护说明。目标是把 fork 差异控制在少量可重放补丁，而不是长期维护另一套 PI。

### 3. 建立可复现发布链

仓库内必须明确记录：

- npm 包名和版本策略
- `@xiamol/pi-coding-agent` 对 PI 内部包的依赖来源
- build、test、pack、publish 命令
- npm token 只通过 secret 注入，不进入仓库
- 发布产物中的 `repository` 指向实际 fork，不能继续误指上游
- 发布前验证 tarball 内容、依赖版本和导出 API

建议 fork 版本使用 `0.84.2-xiamol.0` 形式。若 npm 对现有依赖范围或预发布版本解析不符合项目需要，再使用 `0.84.2-patch.0`，但不得覆盖上游正式版本语义。

### 4. 接入 my-code-agent

PI fork 自身通过后，再在 `my-code-agent` 单独升级依赖。升级批次包括：

- 编译 API 兼容修复
- `AgentSession`、`SessionManager`、`ModelRegistry`、`AuthStorage` 和 `DefaultResourceLoader` 接口核对
- 会话恢复、模型切换、thinking level、压缩、工具循环、SSE、中止和 subagent 行为测试
- usage 字段映射和上下文窗口读取核对
- 全量 `typecheck`、unit、routes、frontend 和桌面手工验收

禁止通过长期 `any` 或修改 `node_modules` 掩盖不兼容。确需兼容旧新 PI 的地方放入项目侧适配器，并写结构测试。

## 安全与失败处理

- 保留旧 fork `main` 和已发布的 0.80.4，升级失败可立即回退依赖锁文件。
- 不触碰 `E:\pi-agent` 当前未提交改动；同步在新 worktree 进行。
- 不自动发布。构建、测试和 tarball 审计通过后，由用户确认发布。
- 自定义 provider、Base URL 和 API Key UI 不进入本批，避免把安全边界与依赖升级混在一起。
- 若 0.84.2 的公开 API 无法承载现有功能，先形成兼容差异清单，再决定补 fork API 或项目侧适配，不立即启动自研 Agent。

## 验收标准

1. 同步分支明确基于上游 `v0.84.2`。
2. 两个旧补丁均有“保留、替代或删除”的证据结论。
3. 保留补丁有定向测试，且不修改生成产物作为唯一实现。
4. PI monorepo 构建和相关测试通过。
5. npm tarball 可在干净临时项目安装，包名、版本、repository、依赖和 exports 正确。
6. `my-code-agent` 使用新包后通过类型检查和全量自动测试。
7. 手工验证聊天、工具调用、模型切换、thinking、压缩、中止、会话恢复和 subagent。
8. 同步与发布步骤写成仓库内命令或文档，下一次升级不依赖人工记忆。

## 后续决策

完成同步后统计：自有补丁数量、升级冲突数量、项目侧兼容代码量、测试耗时和一次升级的人工时间。

- 差异很小：优先考虑直接使用上游包加项目侧适配器。
- 差异稳定且必要：维持薄 fork，按稳定 tag 定期同步。
- 核心语义长期无法扩展、补丁持续超过约 10 到 15 个，或每次稳定版升级持续超过 2 个工作日：再立项评估自研 Agent。

当前不选择完全脱离上游自行维护，也不选择立即自写 Agent。
