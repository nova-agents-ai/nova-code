# 03 · Permission Store —— 三层规则与持久化

> 本篇拆解 [`src/services/permissions/permissionStore.ts`](../../../src/services/permissions/permissionStore.ts) 与 [`PermissionRule.ts`](../../../src/services/permissions/PermissionRule.ts)：三层规则的内存结构、JSON 持久化 schema、`upsertRule` 去重键、文件 IO 边界。
>
> Store 是 engine 的"知识库"，但 engine **不直接接触它的内部结构**——只通过 `getMergedRules()` 拿一份扁平 `PermissionRuleWithSource[]`。这种"窄接口暴露"是为了让 engine 保持纯函数。

## 1. 三层语义速查

| Source | 物理位置 | 生命周期 | 写入触发 |
|---|---|---|---|
| `session` | 进程内存 | 当前 REPL 进程退出消失 | `addRule("session", ...)`（来自 5 档菜单的 `allow-always-session`） |
| `project` | `<cwd>/.nova-code/permissions.json` | 项目级永久（同 git repo 的成员可共享） | `addRule("project", ...)` 立即写盘 |
| `global` | `~/.nova-code/permissions.json` | 用户级永久 | `addRule("global", ...)` 立即写盘 |

**没有显式"加载入内存"的层级概念**：load 一次 = project + global 两个 JSON 文件并行读 → 拍平成 `readonly PermissionRule[]`。session 永远从空开始。

## 2. JSON 持久化 schema

文件 schema（project / global 同形）：

```json
{
  "version": 1,
  "rules": [
    { "toolName": "Bash",      "ruleContent": "git:*",      "behavior": "allow" },
    { "toolName": "Bash",      "ruleContent": "git push:*", "behavior": "deny"  },
    { "toolName": "FileWrite", "ruleContent": "docs/**/*",  "behavior": "allow" },
    { "toolName": "FileEdit",  "ruleContent": "src/**/*.ts","behavior": "ask"   }
  ]
}
```

字段约束（[`PermissionRule.ts`](../../../src/services/permissions/PermissionRule.ts) `validatePermissionRule`）：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `version` | `1` 字面量 | ✓ | 当前唯一支持版本；不匹配 → 抛 ConfigError |
| `rules` | array | ✓ | 任意长度，元素逐条 normalize；任一条失败整文件抛 ConfigError |
| `rules[i].toolName` | string，trim 后非空 | ✓ | 不校验枚举（留口给 MCP 工具） |
| `rules[i].ruleContent` | string 或缺省 | ✗ | 缺省 = 匹配该工具所有调用 |
| `rules[i].behavior` | `allow` / `deny` / `ask` | ✓ | 不在白名单 → ConfigError |

加载时的失败语义（与 [`config/config.ts`](../../../src/config/config.ts) 对齐）：

```
文件不存在        → 视为空规则（非致命）              loadRulesFromFile -> []
文件存在但 JSON 烂  → throw ConfigError("not valid JSON: …")
JSON 合法但 schema 错 → throw ConfigError("rule #i invalid: …")
```

设计原则：**用户能看到完整错误消息（含 path + rule index + 具体字段）**。从 ChatCommand 入口看到的就是 `chat: <ConfigError.message>` + 退出码 1。

## 3. 路径常量

```typescript
const CONFIG_DIR_NAME      = ".nova-code";
const PERMISSIONS_FILE_NAME = "permissions.json";

getProjectPermissionsPath(cwd) = join(cwd,  ".nova-code", "permissions.json")
getGlobalPermissionsPath()     = join(home, ".nova-code", "permissions.json")
```

`home` 通过 `PermissionStoreSource.homeDir` 注入（默认 `os.homedir()`）。

**为什么独立目录 `.nova-code/` 而不是 claude-code 的 `.claude/settings.json`**？

| 维度 | claude-code | nova-code |
|---|---|---|
| 文件 | `.claude/settings.json`（多种配置混合） | `.nova-code/permissions.json`（单一职责） |
| 失败面 | 一处 schema 错可能影响整个配置加载 | 只影响权限规则，模型/调用配置仍可用 |
| 校验 | zod | 手写 validator |

参考 [`docs/design/M3-permissions.md`](../../design/M3-permissions.md) §五"配置位置"。

## 4. 数据流：load → use → addRule

```
PermissionStore.load(cwd, source?)
   ├─ Promise.all([loadProjectRules(cwd), loadGlobalRules(source)])
   │     loadProjectRules → fs.readFile(.../permissions.json) → JSON.parse → validate
   │     loadGlobalRules  → 同上
   └─ new PermissionStore({ cwd, projectRules, globalRules, sessionRules: [] })

──────────────────── 运行时 ────────────────────

QueryEngine 每次 evaluatePermission 前：
   const rules = store.getMergedRules()
       → [...session, ...project, ...global]   (顺序固定)
       每条都是 { rule, source }，engine 拿来按 source 三层过

──────────────────── 用户选 allow-always-* ────────────────────

QueryEngine 拿到 UserChoice:
   if outcome.persistTo === "session":
      await store.addRule("session", rule)
         → sessionRules = upsertRule(sessionRules, rule)   纯内存
   if outcome.persistTo === "project":
      await store.addRule("project", rule)
         → projectRules = upsertRule(projectRules, rule)
         → saveProjectRules(cwd, projectRules)   写文件（mkdir -p + writeFile）
   if outcome.persistTo === "global":
      同上但写 ~/.nova-code/permissions.json
```

**`getMergedRules()` 每次返回新数组**：避免外部拿到引用后被 store 内部的变更"偷偷改掉"。代价是每次构造一次 spread，但 evaluatePermission 是低频路径（每次工具调用一次），可忽略。

**`addRule` 是 async**：即便 `source === "session"` 也走 Promise（保持接口对称）。这让 QueryEngine 的代码路径不需要按 source 分支处理 await。

## 5. `upsertRule` —— 去重键

```typescript
export function upsertRule(rules: readonly PermissionRule[], rule: PermissionRule): readonly PermissionRule[] {
  const key = permissionRuleKey(rule);   // toolName + "\t" + (ruleContent ?? "")
  // 遍历：相同 key 替换为新 rule，否则原样保留
  // 全列表无命中：append 到末尾
}

export function permissionRuleKey(rule: PermissionRule): string {
  return `${rule.toolName}\t${rule.ruleContent ?? ""}`;
}
```

**键不含 behavior**：同一个 `toolName + ruleContent` 不应同时存在 `allow` 与 `deny` 两条规则。后写覆盖前写——语义是"用户最新决策胜出"。如果留两条，engine 的 Step 4 在遍历到第一条时就 return 了，第二条永远死代码，对用户来说就是"我明明改了 deny 怎么还放行"的诡异体验。

**Tab 作为分隔符**：可读字符 `:` 在 ruleContent 里太常见（`git:*`），会和 toolName 串混；Tab 不出现在合法 toolName / ruleContent 里。

## 6. `removeRule` 与 `removeRuleByKey`

```typescript
removeRuleByKey(rules, key)   // 纯函数：filter 不匹配
PermissionStore.removeRule(source, key) → Promise<boolean>
   //  返回是否实际删除了（用于 UI 反馈"未找到"）
```

虽然 M3 当前只暴露 `/permissions list` 和 `/permissions mode` 两个子命令，没有 `/permissions remove`，但 store 已提供 API，预留 M3.5 / M4 添加交互式删除。

## 7. `PermissionStore` 类的状态边界

```typescript
class PermissionStore {
  private sessionRules: readonly PermissionRule[];   // mutable 引用，不可变值
  private projectRules: readonly PermissionRule[];
  private globalRules: readonly PermissionRule[];

  readonly cwd: string;
  readonly source: PermissionStoreSource;
}
```

**字段是 mutable 引用、值是 readonly 数组**：每次变更都重建一个新数组（`upsertRule` 返回新数组），保证旧引用拿到的快照不被污染。

**没有 `version` 字段在内存里**：load 时拍掉，save 时由 `saveRulesToFile` 自动包成 `{ version: 1, rules }`。store 不需要考虑版本演进——版本切换是 load/save 函数的职责。

**没有锁/事务**：每次 `addRule(project|global)` 都是"先改内存、再 fs.writeFile"。两条 addRule 并发是不允许的（QueryEngine 在 Phase A 串行调用 provider，到了 store 也是串行）。

## 8. 文件 IO 的具体实现

```typescript
async function saveRulesToFile(path, rules): Promise<void> {
  const body: PersistedRulesFile = { version: 1, rules };
  await mkdir(dirname(path), { recursive: true });        // .nova-code/ 不存在则建
  await writeFile(path, JSON.stringify(body, null, 2) + "\n", "utf8");
}
```

**写入策略**：
1. **整文件覆盖**而不是 append —— 规则列表本来就是有序整体，没有"追加单条"的语义合理性。
2. **`mkdir -p` 先建目录** —— 用户首次用 `/permissions` 升级规则时，`.nova-code/` 通常还不存在。
3. **末尾 `\n`** —— 与 git diff / Posix text-file 期望对齐。
4. **`JSON.stringify(... , 2)`** —— 让规则文件可手编辑，diff 友好。

**没有用 fsync / 原子重命名**：M3 简化，依赖 OS 写入语义。规则文件丢失最坏后果是用户某条 allow 规则需要再次确认，不会损坏其它系统状态。

## 9. 类与纯函数的边界

```
─────────────  纯函数（无状态、可单测）  ─────────────
loadRulesFromFile(path)       fs.readFile → parse → validate
saveRulesToFile(path, rules)  序列化 → mkdir+writeFile
loadProjectRules / saveProjectRules
loadGlobalRules  / saveGlobalRules
upsertRule(rules, rule)
removeRuleByKey(rules, key)
validateRulesFile(value, path)
permissionRuleKey(rule)

─────────────  类（持有状态，IO 副作用）  ─────────────
PermissionStore
  - 三个 readonly 数组字段（值不变、引用可换）
  - addRule / removeRule 是唯一改字段的入口
  - getMergedRules / listBySource 是只读访问
```

QueryEngine 只依赖 `PermissionStore`（类型接口）；测试可用 `new PermissionStore({ cwd, projectRules: [...], globalRules: [...] })` 直接构造，不需要 mock 任何文件系统。

## 10. 依赖注入：`PermissionStoreSource`

```typescript
interface PermissionStoreSource {
  readonly homeDir?: string;
}
```

仅一个字段。用途是测试不碰真实 `~/.nova-code/`：

```typescript
const tmpHome = await mkdtemp(...)
const store = await PermissionStore.load(tmpCwd, { homeDir: tmpHome })
```

不抽 `readFile`/`writeFile` 函数注入：bun:test 提供了进程级临时文件能力，且测试里直接 fs.writeFile 准备前置数据更直观。

## 11. 单测覆盖矩阵

[`permissionStore.test.ts`](../../../src/services/permissions/permissionStore.test.ts)（16.9KB）：

- **load**：文件不存在 / 空文件 / 合法 JSON / 无效 JSON / 错 version / rule 缺字段 / rule 非法 behavior
- **save**：写新文件（自动建目录） / 覆盖旧文件
- **upsertRule**：相同 key 替换 / 不同 key 追加 / 同 key 不同 behavior
- **getMergedRules**：session > project > global 顺序、空层不漏
- **addRule**：三 source 各一例，project/global 验证文件内容
- **removeRule**：返回值正确性、并行调用语义

`permissionStore.test.ts` 与 `permissionEngine.test.ts` 完全解耦：store 不知道 engine 怎么用规则，engine 也不知道规则从哪来。

## 12. 与 claude-code 的差异速查

| 维度 | claude-code | nova-code M3 |
|---|---|---|
| 配置文件 | `.claude/settings.json` 多配置混合 | `.nova-code/permissions.json` 单一 |
| 校验库 | zod | 手写 validator |
| 去重键 | allow-rules / deny-rules 分集，behavior 进 key | 单一 `toolName\truleContent` 键，behavior 不进 key |
| 写入策略 | 类似（整文件覆盖） | 整文件覆盖 + `mkdir -p` |
| version 管理 | 多版本 + migrator | v1 only，留口未实装 |

差异背后的设计动机详见 [`docs/design/M3-permissions.md`](../../design/M3-permissions.md) §四"持久化"与 §五"配置位置"。

---

下一篇：[04 · permission-provider.md](./permission-provider.md)
