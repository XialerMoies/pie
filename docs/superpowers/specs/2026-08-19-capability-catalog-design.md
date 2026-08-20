# Task 0：生成式能力目录设计

> 状态：已完成
> 日期：2026-08-19
> 范围：第一阶段 Task 0

## 目标

建立一条低成本、可重复、由代码事实驱动的能力目录生成链路：

```text
代码事实 → 混合式生成器 → docs/generated/capability-catalog.json → CI --check
```

目录服务于后续 Task 1（技能 catalog）和 Task 2（spawn / env 盘点），不作为运行时配置源，不替代权限系统，也不承担完整静态分析平台的职责。

## 严格边界

Task 0 包含：

- 工具及参数 schema、工具能力和来源文件；
- Engine 事件和 Application 事件；
- API 路由的稳定字面量、方法、handler 和来源文件；
- spawn 点及其粗粒度类别、来源文件和行号；
- 权限模式；
- 技能 catalog 的静态 schema、目录根和运行时来源标记；
- 确定性 JSON 生成；
- `--check` 同步检查；
- Windows CI 门禁。

Task 0 不包含：

- TypeScript AST 平台；
- 技能安装、信任、启用、删除或正文加载；
- spawn 环境变量过滤或治理；
- 运行时插件系统；
- HTML、可视化页面或自动文档站；
- LOC、测试数量、构建耗时等频繁变化数字；
- 自动修改源码或自动修复目录漂移。

## 方案

采用混合式生成器：

1. 从现有运行时注册表读取结构化事实：
   - `toolRegistry.getAll()`；
   - `ENGINE_EVENT_TYPES`；
   - `AppEventType`；
   - 权限模式常量。
2. 对受约束源码执行轻量文本扫描：
   - spawn API 调用；
   - 路由 URL/method 字面量和路由注册来源。
3. 对所有结果进行 schema 校验、去重、排序和稳定序列化。

不引入 AST，不执行整个服务端启动流程，不触发 Electron 或 MCP 连接。

## 输出

生成文件：

```text
docs/generated/capability-catalog.json
```

生成脚本：

```text
scripts/generate-capability-catalog.mjs
```

命令：

```json
{
  "capabilities:generate": "node --import tsx scripts/generate-capability-catalog.mjs",
  "capabilities:check": "node --import tsx scripts/generate-capability-catalog.mjs --check"
}
```

`generatedAt` 使用固定字符串 `deterministic`，不写当前时间，避免无意义 diff。

## JSON schema

顶层结构：

```json
{
  "schemaVersion": 1,
  "generatedAt": "deterministic",
  "generator": "scripts/generate-capability-catalog.mjs",
  "tools": [],
  "spawnPoints": [],
  "events": {
    "engine": [],
    "application": []
  },
  "routes": [],
  "permissionModes": [],
  "skills": {},
  "sources": {}
}
```

### tools

每项包含：

- `name`；
- `description`；
- `parameters`；
- `capabilities.readOnly`；
- `capabilities.destructive`；
- `capabilities.riskLevel`；
- `capabilities.needsPermission`；
- `capabilities.workspaceBounded`；
- `source`。

工具事实来自 `toolRegistry.getAll()`，不重复手写工具名称或参数。

### events

`events.engine` 来自 `src/agent-engine/contracts.ts` 的 Engine 事件常量，`events.application` 来自 `src/server/app-events.ts` 的 Application 事件类型。只收录明确类型/常量中的事件，不扫描所有任意字符串。

### routes

每项包含：

- `method`；
- `path` 或 `pathPattern`；
- `handler`；
- `source`；
- `category`。

扫描稳定字面量，例如 `url === "/api/..."`、`pathname === "/api/..."` 和受约束的 route regex。动态路由只记录可确定的 pattern，不模拟完整 HTTP 匹配。

### spawnPoints

扫描以下调用：

- `spawn`；
- `spawnSync`；
- `exec`；
- `execSync`；
- `execFile`；
- `execFileSync`；
- `fork`；
- 明确的 `child_process.send`。

每项至少包含：

- `file`；
- `line`；
- `api`；
- `category`；
- `owner`。

类别只做 Task 2 的盘点标签：`user-command`、`mcp`、`subagent`、`tsserver`、`internal-server`、`electron`、`build-or-test`、`other`。Task 0 不修改任何环境变量继承逻辑。

### permissionModes

统一来源为：

```text
standard
plan
dontAsk
yes
```

权限模式常量由 `src/server/permission-mode.ts` 导出并由 `isPermissionMode()` 复用，生成器不再维护第二份隐式列表。

### skills

Task 1 已实现运行时技能系统。提交版 catalog 仍不扫描用户或工作区实际安装的技能，只输出确定性的静态契约：

```json
"skills": {
  "schemaVersion": 1,
  "runtimeSource": "src/agent/skills/skill-service.ts",
  "roots": [
    "<PI_USER_CONFIG>/skills",
    "<workspace-root>/agent/skills"
  ],
  "summaryFields": [
    "id",
    "name",
    "description",
    "source",
    "path",
    "trust",
    "enabled",
    "parse",
    "declaredTools"
  ]
}
```

`sources.skills` 指向 `src/agent/skills/skill-service.ts`。实际技能摘要由 Task 1 的运行时 `SkillService` 提供；Task 0 不扫描或加载 `SKILL.md` 正文，也不把本机安装状态写入生成文件。

## 确定性规则

- 所有数组按稳定 key 排序；
- 对象 key 使用固定顺序；
- 路径统一为仓库相对 POSIX 风格路径；
- 行号使用 1-based；
- 重复项按稳定 key 去重；
- 不写时间、进程号、机器路径和环境变量；
- 生成器输出使用固定缩进和结尾换行；
- `--check` 只比较生成内容，不修改文件。

## CI

Windows governance workflow 在 `npm ci` 和 typecheck 后运行：

```yaml
- run: npm run capabilities:check
```

本地更新流程：

```powershell
npm run capabilities:generate
npm run capabilities:check
```

CI 失败时表示代码事实与已提交 catalog 不同步；开发者显式运行 generate 并审阅 diff。

## 验收标准

1. 同一 commit 在同一依赖环境下重复生成得到字节级相同 JSON。
2. 工具、事件、路由、权限模式和 spawn 点均有可追溯来源。
3. `skills` 记录静态 schema、目录根和运行时来源，但不包含本机安装数据或技能正文。
4. `capabilities:check` 能检测手工修改或代码漂移。
5. 生成过程不启动 server、Electron、Provider 网络请求或 MCP 连接。
6. 现有 typecheck、unit、routes、frontend 和 release gate 不回归。

## 明确的反过度工程约束

- 不添加 AST 依赖；
- 不创建通用 scanner framework；
- 不把 catalog 设计成运行时数据库；
- 不把 Task 1/Task 2 的实现提前塞进 Task 0；
- 如果某类事实无法稳定扫描，记录来源和限制，不为追求“全覆盖”增加复杂解析器。
