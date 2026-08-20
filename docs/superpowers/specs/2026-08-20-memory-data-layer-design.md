# Task 3：全局记忆数据层修正设计

> 状态：设计待审阅
> 日期：2026-08-20
> 范围：第一阶段 Task 3

## 目标

在保留现有 `read_memory` / `write_memory` 工具的基础上，修正记忆存储路径，明确用户级、工作区级和会话级边界，并提供最小的长期记忆管理能力。

```text
宿主注入的 roots → 作用域解析 → memory 工具/索引 → prompt 摘要
```

本任务只解决数据层和现有工具契约，不建设自动记忆提取、向量检索或独立管理平台。

## 严格边界

Task 3 包含：

- 用户级和工作区级 memory root 解析；
- `scope: user | workspace` 工具参数，默认 `user`；
- `MEMORY.md` 索引和结构化元数据索引；
- `list_memory`、`delete_memory`、`set_memory_enabled` 最小管理操作；
- 旧 `data/pi/memory` 的懒迁移和冲突保护；
- prompt 只注入启用记忆的索引摘要；
- 路径授权、workspace 切换和自定义 data root 测试。

Task 3 不包含：

- 自动保存对话摘要或后台记忆提取；
- 向量数据库、全文检索、embedding 或独立 MemoryService；
- 远程同步、跨设备合并或版本市场；
- 自动推断旧记忆所属 workspace；
- 把全部记忆正文自动注入 system prompt；
- 修改技能目录结构。

## 存储布局

记忆与技能使用同一套所属目录体系：

```text
<PI_USER_CONFIG>/memory/<memory-id>.md
<PI_USER_CONFIG>/memory/memory-index.json
<PI_USER_CONFIG>/memory/MEMORY.md

<workspace-root>/agent/memory/<memory-id>.md
<workspace-root>/agent/memory/memory-index.json
<workspace-root>/agent/memory/MEMORY.md
```

- `memory-index.json` 是机器可读的元数据索引。
- `MEMORY.md` 是面向 Agent 的稳定摘要索引，由元数据和正文首行生成。
- 会话级记忆只存在当前 runtime 内存，不作为长期文件落盘。
- 工具不再写入 `<APP_ROOT>/data/pi/memory` 或任何硬编码 `data/pi/memory` 路径。

## 宿主注入与路径解析

记忆工具不重新计算应用根目录。runtime 通过 `ToolContext`/`extraCtx` 注入：

- `userMemoryRoot`：通常为 `<PI_USER_CONFIG>/memory`；
- `workspace`：当前绝对 workspace 路径，允许为空；
- `workspaceMemoryRoot`：由宿主按 `<workspace>/agent/memory` 解析，或由纯函数根据 workspace 解析。

解析函数只接受绝对 root，并对 workspace 做规范化。工具只根据 `scope` 选择 root，不接受任意路径参数。

当 `scope=workspace` 且没有当前 workspace 时，工具返回明确错误，不回退到用户级目录。

## 作用域与合并规则

工具接口统一使用：

```text
scope: "user" | "workspace"
```

默认值为 `user`，确保现有调用继续表示跨项目的用户偏好。

prompt 视图合并两个作用域的索引：

1. 读取用户级启用条目；
2. 读取当前 workspace 的启用条目；
3. 同名 workspace 条目覆盖 prompt 视图中的 user 条目；
4. 覆盖只影响当前 workspace 的读取和展示，不删除用户级文件。

workspace 切换或 runtime 刷新时重新读取索引，避免多窗口共享旧 workspace 视图。

## 工具契约

保留并扩展现有工具：

```text
read_memory({ name, scope? })
write_memory({ name, content, scope?, source? })
```

增加最小管理工具：

```text
list_memory({ scope? })
delete_memory({ name, scope? })
set_memory_enabled({ name, scope?, enabled })
```

- `read_memory` 返回选定作用域的一条完整正文；
- `write_memory` 只在用户明确要求或确认后调用，不自动保存对话摘要；
- `list_memory` 返回 `name`、摘要、`scope`、启用状态和更新时间，不返回全部正文；
- `delete_memory` 删除正文并更新两个索引；
- `set_memory_enabled` 只改变索引状态，不改正文；
- 所有成功的写入、删除和禁用操作刷新当前 runtime 的 system prompt。

记忆名称继续使用现有安全校验：仅允许字母、数字、点、下划线和短横线，最长 64 字符。

## 元数据与可追溯

每个作用域维护一个 `memory-index.json`，条目包含：

- `id`：稳定的记忆标识；
- `name`：不含 `.md` 的文件名；
- `scope`：`user` 或 `workspace`；
- `source`：`user`、`agent-confirmed` 或 `legacy`；
- `createdAt`、`updatedAt`：ISO 时间；
- `enabled`：是否参与 prompt 索引；
- `traceId`：写入或迁移时生成的追踪标识；
- `summary`：由正文首个非空标题或首行生成的摘要。

正文保持普通 Markdown，不要求用户改变内容格式。索引损坏或缺失时，扫描合法 `.md` 文件重建条目，默认 `source=legacy`、`enabled=true`，同时返回诊断信息而不吞掉错误。

索引写入使用临时文件加原子替换，避免进程中断留下半个 JSON。正文和索引不追求跨文件事务；恢复逻辑以正文文件为事实来源。

## 旧路径兼容与迁移

旧路径为：

```text
<APP_ROOT>/data/pi/memory/
```

迁移采用懒迁移，在首次 `list_memory`、`read_memory` 或 `write_memory` 时执行：

- 只处理合法 `.md` 文件，不迁移目录和未知扩展名；
- 所有旧文件迁移到用户级 memory root，不猜测 workspace 归属；
- 目标不存在时迁移；目标已存在时不覆盖，保留旧文件并在结果中报告冲突；
- 迁移条目写入 `source=legacy`，生成新的 `traceId` 并重建索引；
- 迁移成功后保留旧文件作为兼容备份，并写入一次性迁移标记，避免重复处理；
- 新版本不再向旧目录写入。

迁移优先使用同卷原子移动；无法移动时使用复制后校验再保留源文件。迁移失败不阻塞新路径读写，但必须可诊断。

## 权限与安全边界

- 用户级操作只能落在注入的 `userMemoryRoot`；
- 工作区级操作只能落在当前 workspace 的 `agent/memory`；
- `scope`、root 和 workspace 由宿主上下文决定，模型不能提供绝对路径；
- 所有正文、索引和删除操作复用现有 `authorizeToolPath` 链路；
- 工作区外路径、路径穿越、非法名称和错误 scope 均 fail-closed；
- 禁用不等于删除，删除必须是单独且明确的操作。

## Prompt 行为

系统 prompt 只注入启用记忆的 `MEMORY.md` 摘要，不自动注入全部正文。索引条目包含作用域和更新时间，帮助 Agent 决定是否调用 `read_memory`。

工作区记忆覆盖同名用户记忆只在当前 prompt 视图生效。写入、删除或禁用后调用现有 `refreshSystemPrompt()`，当前会话立即看到新的索引。

## 测试范围

增加或扩展测试覆盖：

1. 默认 `user`、显式 `workspace`、无 workspace 时拒绝；
2. 用户/工作区同名覆盖和 workspace 切换后的索引变化；
3. 自定义 `PI_USER_CONFIG`、多窗口和临时 data root；
4. 路径穿越、越权 scope、删除和禁用权限；
5. 旧目录懒迁移、冲突不覆盖、重复迁移幂等和迁移失败诊断；
6. 损坏或缺失索引重建，元数据和 `traceId` 保留；
7. prompt 只注入索引，不注入正文；
8. 现有 `read_memory` / `write_memory` 调用兼容。

## 验收标准

1. 任意新写入都不会创建或修改 `data/pi/memory`；
2. 用户级、工作区级和会话级边界在工具、prompt 和测试中一致；
3. 用户可以查看、编辑、删除和禁用长期记忆；
4. 每条长期记忆具有来源、作用域、时间和可追溯标识；
5. 旧记忆可安全迁移，冲突不覆盖且迁移可重复执行；
6. 多窗口、workspace 切换和自定义 data root 不产生跨目录污染；
7. 全量 typecheck、unit、routes、frontend 测试不回归。

## 反过度工程约束

- 不引入独立 `MemoryService`、数据库或后台任务；
- 不引入 YAML/AST 解析器，元数据只使用现有 JSON 能力；
- 不自动提取或保存对话摘要；
- 不自动推断旧记忆的 workspace 所属；
- 不建设管理页面，先通过工具和现有设置/诊断能力管理；
- 如果跨文件原子事务无法可靠实现，以正文文件为事实来源并提供可诊断恢复，不增加事务框架。
