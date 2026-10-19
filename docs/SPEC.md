# HTTP 接口契约（docs/SPEC.md）— 冻结版 v1

> 状态：**冻结**。变更须走显式修订（改本文件 + 升 `version` 字段 + 通知客户端实现方）。
> 实现：`lib/routes.js`（路由）→ `lib/ledger.js`（数据）→ `lib/pricing.js`（价格）。
> 可执行一致性检查：`node --test --test-isolation=none tests/routes.test.mjs`（逐参数语法真实请求 + 逐字段断言）。
> 测试与文档使用同一取值（同一 host `/api/dsh-workspace-fee`、同一路径写法）。
>
> **修订记录**
>
> | 版本 | 变更 | 依据 |
> |---|---|---|
> | v1.0 | 初版冻结 | 初始需求 |
> | **v1.1** | **计费桶修正**：`cost = cacheRead×hit + input×miss + **output**×out`（reasoning **不再**加一遍）；新增 `pricing.reasoningIncludedInOutput` 开关（默认 `true`）；`diagnostics` 新增 `reasoningTokensTotal` / `costIfReasoningAddedDelta` / `costIfReasoningAddedPercent` / `workspacesWithoutLogs`；`gaps[]` 新增 `workspace-empty` | 见 §4.1 的 E1/E2 证据；旧口径会虚增约 **18%** |
> | **v1.2** | 新增 `pricing.inputIncludesCacheRead` 开关（默认 `false`）；`diagnostics.bucketRefutation` 给出三种口径的可反证数字；`recordsSkipped`/`parseFilter`；按日 JSONL 账单；`workspaces[].firstTime` 用会话 `createdAt` 兜下界 | 依据：宿主源码（`pi-ai` `input = max(0, prompt − cacheRead − cacheWrite)`；`dsh-token-meter` 把日志 `inputTokens` 映射为 **`uncachedInputTokens`**）与语料分布（`input < cacheRead` 占多数）可证伪该口径；第三方账本（dsh-context）逐日对账支持本口径 |
> | **v1.3** | **会话日志文件名随格式版本变化**（`session.jsonl.zstd` → `session.v3.jsonl.zstd` → `session.v4.jsonl.zstd`）：改为**逐个会话目录取版本号最大的那个文件**，其余版本明确记为「被取代」；`diagnostics` 新增 `sessionFileVersions` / `supersededSessionFiles` / `supersededSamples`；`gaps[].kind` 新增 `session-dir-unreadable`，`session-log-missing` 的 `path` 从「日志文件路径」改为**会话目录路径** | 实测：DSH 升级后新会话写 `session.v4.jsonl.zstd`，硬编码 v3 导致升级后的会话整段读不到（症状：今日花费与近 7 天恒为 0）；改为按版本选文件后恢复统计。同一目录 v3+v4 并存时 v4 是**整篇重写**，v3 的记录被 v4 完整覆盖（条数与时间区间一致或为其子集），两个都读会双计 |
> | **v1.4** | **新增全量口径**：`GET /summary` 的 `days` 除整数 `1..365` 外接受字面量 **`all`**（大小写不敏感、忽略首尾空白；回显 `"days":"all"`）。全量口径 = 从**最早一条可定位日期的用量记录**所在北京日起到今天（含），因此 `window.from` 是**数据驱动**的、不再等于「今天 −(days−1)」；非法值文案改为「days 必须是 1..365 之间的整数或 all（全量口径）」；`diagnostics` 新增 `undatedUsageRecords`。**滚动口径的语义与数字一律不变**（同一份数据上 `days=30` 前后完全相同） | 需求方要求：面板此前只有 7 / 30 / 90 天三档，缺「全量」。口径边界「无时间戳的用量记录不进任何窗口（只进 `lifetimeCost`）」显式登记为 `undatedUsageRecords`，避免「全量比累计少一点」变成静默差异。可失败判据：`tests/verify-independent/all-time-caliber.mjs`（独立解码整份语料 + 注入一条 400 天前记录 → 断言 `days=all` 严格大于 `days=365`，且差额恰等于该记录金额，逐工作区费用与记录数逐项相等） |

约定：

- 所有响应 `content-type: application/json; charset=utf-8`，`cache-control: no-store`。
- 所有时间戳字段是 ISO-8601 UTC 字符串（`generatedAt`/`rebuiltAt`）。
- `epoch ms` 字段（`firstTime`/`lastTime`）是 UTC 毫秒。
- **日期口径一律北京时间（UTC+8）**，格式 `YYYY-MM-DD`。
- 未预期异常：`500 + {ok:false, error:string}`，**绝不静默返回空数组**。
- 方法不匹配：`405 + {ok:false, error}`，并带 `Allow` 头。
- 入参非法：`400 + {ok:false, error}`（`POST /config` 还会带 `details: string[]`）。

---

## 1. `GET /api/dsh-workspace-fee/summary`

**Query**

| 参数 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `days` | 整数 `1..365` **或字面量 `all`** | 否（默认 `30`） | `整数 N` = 统计窗口「最近 N 个北京日（含今天）」，`window.from = 今天 −(N−1)`；`all`（大小写不敏感，见 v1.4）= **全量口径**，窗口 = 从**最早一条可定位日期的用量记录**所在北京日起到今天（含），`window.from` 因此来自数据。其余取值（`0` / `-1` / `366` / `1.5` / `1e3` / `allx`）→ **400** |
| `sessionId` | 字符串 | 否 | 用于填 `current`：把该会话所属工作区原样回给浏览器（高亮「当前工作区」用）。查不到 → `current: null`（不是错误） |

**200 响应**

```jsonc
{
  "ok": true,
  "generatedAt": "<ISO-8601>",
  "days": 30,                                   // 整数（滚动 N 天）或字符串 "all"（全量口径，v1.4）
  "window": { "from": "2026-08-19", "to": "2026-09-17", "timezone": "Asia/Shanghai", "timezoneOffsetMinutes": 480 },
  // days=all 时 from = 最早一条有日期的用量记录所在北京日（无任何记录时退化为今天），
  // 例如：{ "from": "2025-09-06", "to": "2026-10-11", ... }
  "today": { "date": "2026-09-17", "cost": 1.23, "tokens": { /* Tokens */ } },

  "totals": { "tokens": { /* Tokens */ }, "cost": 1.23, "idleCost": 1.23, "peakSurcharge": 0 },

  "workspaces": [{
    "key": "--D-work-example-app--",     // 工作区目录名（稳定主键）
    "workspaceId": "--D-work-example-app--", // === key（client 侧字段名，超集兼容）
    "label": "example-app",                       // 末段目录名；取不到时回退为 key
    "cwd": "D:\\work\\example-app",     // 首选日志里的 cwd
    "cwdSource": "session-log",               // "session-log" | "directory-name"
    "sessions": 2,                           // 成功解析的会话日志文件数
    "usageRecords": 100,                      // 窗口内计入的用量记录条数
    "firstTime": 1789574366121,               // 该工作区**终身**最早记录时间（不受窗口裁剪）
    "lastTime": 1789575545009,
    "tokens": { /* Tokens */ },               // 窗口内
    "cost": 1.23,                        // 窗口内（元）
    "todayCost": 0.5,                    // 今日（北京日，元）
    "lifetimeCost": 1.23,                // 终身（元，附加字段）
    "lifetimeTokens": 1000000,
    "alert": { "limit": 5, "level": "ok" }    // limit: number|null；level: ok|warn|over
  }],

  "daily": [{
    "date": "2026-09-14",
    "workspaceKey": "--D-work-example-app--",
    "workspaceId": "--D-work-example-app--", // === workspaceKey
    "label": "example-app",
    "sessions": 3,                                 // 该日该工作区贡献的会话数
    "cost": 0.5,
    "tokens": { /* Tokens */ }
  }],

  "dailyTotals": [{ "date": "2026-09-14", "cost": 1.0, "tokens": { /* Tokens */ } }],
  "models": [{ "provider": "deepseek-official", "model": "deepseek-flash", "tierName": "flash", "known": true, "cost": 1.23, "tokens": { /* Tokens */ } }],

  "peakSplit": { "peak": { "tokens": 0, "cost": 0 }, "idle": { "tokens": 1000000, "cost": 1.23 } },

  "alerts": {
    "over": 0, "warn": 0, "ok": 2, "configured": 0,
    "worst": [{ "key": "...", "label": "...", "todayCost": 1, "limit": 1.25, "ratio": 0.8, "level": "warn" }]
  },

  "current": null,          // 传了 sessionId 且命中时是 workspaces[] 里的同一对象；否则 null
  "currentSessionId": "session-...",

  "currency": "CNY",        // 附加字段（client 读 summary.currency 时的兜底）
  "pricing": {              // 见 §4
    "effectiveFrom": "2026-09-10T12:00:00+08:00",
    "currency": "CNY", "peakMultiplier": 2, "timezone": "Asia/Shanghai",
    "reasoningIncludedInOutput": true,
    "peakWindows": ["1/2/3/4/5 09:00-12:00", "1/2/3/4/5 14:00-18:00"],
    "peakWindowsDetail": [{ "days": [1,2,3,4,5], "from": "09:00", "to": "12:00" }],
    "tiers": [{ "tier": "flash", "cacheRead": 0.02, "cacheMiss": 1, "output": 4, "peakCacheRead": 0.04, "peakCacheMiss": 2, "peakOutput": 8 }],
    "families": { /* 家族基础费率 */ },
    "models": { "deepseek-flash": "flash" },
    "fallbackTier": "flash",
    "activeVersionId": "builtin-2026-09-10",
    "versions": [ /* 见 §4.2 */ ]
  },

  "diagnostics": {
    "startedAt": "<ISO-8601>", "elapsedMs": 1200,
    "sessionsRoot": "...", "dataDir": "...", "home": "...",
    "workspaceCount": 2, "sessionFiles": 5, "sessionsAnalyzed": 0, "filesFromCache": 5,
    // 实际读到的会话日志版本分布 + 被新版本取代而忽略的旧文件（v1.3）
    "sessionFileVersions": { "v4": 2, "v3": 1 }, "supersededSessionFiles": 1,
    "supersededSamples": [{ "sessionId": "session-…", "used": "session.v4.jsonl.zstd", "ignored": ["session.v3.jsonl.zstd"] }],
    "frameTotal": 120, "framesDecoded": 120, "framesFailed": 0,
    "rawBytes": 300000, "decodedBytes": 1200000,
    "records": 400, "recordsSkipped": 300, "parseFilter": "needed", "usageRecords": 100,
    "exactDuplicateLines": 0, "typeSeqDuplicates": 0, "parseErrors": 0, "jsonlParseFailedFiles": 0,
    "dedupeDisagreements": 0,
    "usageTokens": 1000000, "streamUsageTokens": 1000000,
    "doubleCountInflationTokens": 1000000, "doubleCountInflationPercent": 100,
    "modelFromSourceCount": 100, "modelFromFallbackCount": 0, "unknownModelCount": 0,
    "usageTypeBreakdown": { "assistant/message": 100 },
    "beforeEffectiveFromCount": 0, "beforeEffectiveFromCost": 0,
    "unpricedUsageRecords": 0,
    // 无时间戳（且会话也没有 createdAt 兜底）的用量记录条数：**任何窗口都不计入**
    // （滚动与全量口径同构），只体现在 workspaces[].lifetimeCost 上。显式计数，不静默（v1.4）
    "undatedUsageRecords": 0,
    "workspacesWithoutLogs": 0,
    "reasoningTokensTotal": 30000,
    // ⚠️ 反事实（counterfactual）：按**错误口径**重算的值，仅用于自证，**不是账单口径**。
    // 权威账单 = `totals.cost` = `diagnostics.counterfactual.billedCost`。
    "counterfactual": {
      "billedCost": 1.23, "reasoningAddedCost": 1.5, "reasoningAddedDelta": 0.2, "reasoningAddedPercent": 16.0,
      "inputIncludesCacheReadCost": 1.4, "inputIncludesCacheReadPercent": 7.96,
      "inputIncludesCacheReadOnlyCost": 1.1, "inputIncludesCacheReadOnlyPercent": -9.18,
      "note": "这些数字是按错误口径重算的反事实值，用于自证；账单以 billedCost（= totals.cost）为准"
    },
    // 兼容别名（@deprecated）：等价于 counterfactual.reasoningAdded*
    "costIfReasoningAdded": 1.5, "costIfReasoningAddedDelta": 0.2, "costIfReasoningAddedPercent": 16.0,
    "configProblems": [], "configSource": { "pricing": "default", "alerts": "default", "settingsAvailable": false },
    "usageBill": { "dir": "C:\\Users\\...\\.dsh\\dsh-usage", "filesWritten": 2, "lines": 3, "error": null },
    "workspacesWithData": 2
  },

  "gaps": [{ "kind": "session-log-missing", "path": "D:\\...\\sessions\\--D-…--\\session-…", "detail": "会话目录 … 里没有会话日志（期望 session[.v<N>].jsonl.zstd）" }]
}
```

**字段语义（逐条）**

| 字段 | 语义 |
|---|---|
| `Tokens` 对象 | `{inputTokens, outputTokens, cacheReadTokens, reasoningTokens, totalTokens}`，**与日志里的键名一致**；`totalTokens = inputTokens + outputTokens + cacheReadTokens`（日志自身口径，实测成立） |
| `days` | **口径回显**：整数 = 滚动 N 天；字符串 `"all"` = 全量口径（v1.4）。client 据此切换文案与「按日账单」的行数上限 |
| `window.from/to` | 北京日；`to` 恒为今天。`from`：整数 `days` 时 = 今天 −(days−1)（**算出来的**下界，可能当天并没有数据）；`days=all` 时 = **最早一条有日期的用量记录所在北京日**（**数据驱动**；一条记录都没有时退化为今天） |
| `totals.*` / `workspaces[].tokens,cost` | **窗口内**求和。`days=all` 时窗口 = 全部有日期的记录，于是 `workspaces[].cost == lifetimeCost`（**前提：该工作区没有无时间戳记录**；有的话差额恰好是那部分，条数见 `diagnostics.undatedUsageRecords`） |
| `workspaces[].firstTime/lastTime` | **终身**口径（不随 `days` 变）。`firstTime` 取「首个被处理记录的时间」与会话 `createdAt` 的**较小值**（预筛只解析计费/路由/会话头三类记录，需要 `createdAt` 兜下界）；`lastTime` = 末个被处理记录的时间，因此默认模式下反映**最后一次计费活动** |
| `todayCost` | 该工作区**今天**（北京日）的费用，与 `days` 无关（今天必在窗口内） |
| `alert.limit` | 该工作区生效的**日**预警线（元）；`null` = 不预警 |
| `alert.level` | `todayCost >= limit` → `over`；`todayCost >= limit × warnRatio` → `warn`；否则 `ok`。`limit` 为 `null`/`0` 时恒为 `ok`；`warnRatio` 默认 `0.8` |
| `daily[]` | 只包含窗口内**有数据**的 (北京日 × 工作区)；按 `date` 升序，同日按 `workspaceKey` 升序 |
| `models[]` | 按 `cost` 降序；`known=false` 表示该模型不在价格表里（回退档位计费） |
| `peakSplit` | 按**记录时刻**是否落在高峰时段拆分（与价格表的高峰段一致） |
| `gaps` | **处理不到的输入**，不是「零消耗」。见 §6 |
| `diagnostics.undatedUsageRecords` | 无时间戳、且会话 `createdAt` 也无法兜底的用量记录条数（v1.4）。这类记录**不进任何窗口**（滚动口径本来就如此，全量口径同样不例外），只计入 `workspaces[].lifetimeCost` —— 因此「全量总额」可能比「各工作区累计之和」少这一点点，差额必须能被这个计数解释，而不是静默消失 |

---

## 2. `GET /api/dsh-workspace-fee/config`

**200 响应**（顶层同时提供 client 面板形态与宿主契约形态，两者内容等价）

```jsonc
{
  "ok": true,
  "generatedAt": "<ISO-8601>",

  // ── client 面板形态（lib/client.js 直接读这些顶层键）──
  "currency": "CNY",
  "alerts": { "--D-work-example-app--": { "limit": 5 } },   // 值恒为 {limit: number|null}
  "alertDefaults": { "defaultLimit": null, "warnRatio": 0.8 },
  "pricing": { "activeVersionId": "builtin-2026-09-10", "currency": "CNY", "effectiveFrom": "...",
               "peakMultiplier": 2, "fallbackTier": "flash", "models": {...}, "families": {...},
               "tiers": [...], "versions": [ /* §4.2 */ ] },

  // ── 宿主契约形态 ──
  "config": {
    "pricing": { "currency": "CNY", "effectiveFrom": "...", "peakMultiplier": 2, "fallbackFamily": "flash",
                 "peakWindows": [{ "days": [1,2,3,4,5], "from": "09:00", "to": "12:00" }],
                 "families": { "flash": { "cacheRead": 0.02, "cacheMiss": 1, "output": 4 } },
                 "models": { "deepseek-flash": "flash" }, "versions": [ /* 内部形态（含 fromMinutes/toMinutes） */ ] },
    "alerts": { "defaultLimit": null, "warnRatio": 0.8, "workspaces": { "--D-...--": 5 } }
  },
  "source": { "pricing": "settings", "alerts": "file", "settingsAvailable": true },  // 生效层：default|composed|file|settings
  "problems": [],              // 配置校验告警（非法字段会被忽略并记在这里）
  "diagnostics": { "unpricedUsageRecords": 0 },  // 约定 5：未计价条数（与 /summary 同源）
  "paths": { "home": "...", "sessionsRoot": "...", "dataDir": "...", "usageDir": "..." }
}
```

**顶层就是契约对象本身**（约定 5 冻结形状，**不套两层**）：`alerts` / `currency` / `pricing` /
`source` / `problems` / `diagnostics` 直接放顶层；同时再套一份完整对象到 `config` 里作为规范形态，两处值一致。
`source` 在本实现里是**对象** `{pricing, alerts, settingsAvailable}`（比占位符 `"..."` 更细，客户端不读它）。

**`source` 语义**：某层只有**真正带了键**才算生效层；空层不计（因此挂上 settings 服务不会把来源标成 `settings`）。

---

## 2b. 按日 JSONL 账单（文件产物，非 HTTP）

每次 `GET /summary` 与 `POST /refresh` 都会把按日账单**覆盖写**到
`usageDir`（默认 `<DSH_HOME>/dsh-usage`，可用 `DSH_WORKSPACE_FEE_USAGE` 重定向）：

| 文件 | 内容 |
|---|---|
| `<usageDir>/<工作区目录名>.jsonl` | 每行一条，按 `date` 升序：`{type:'workspace-day', date, workspaceKey, workspaceId, label, cwd, cost, currency, tokens, sessions, generatedAt}` |
| `<usageDir>/summary.jsonl` | 每行一条，全工作区按日合计：`{type:'day', date, cost, currency, tokens, generatedAt}` |

- 只含**窗口内有数据**的 (北京日 × 工作区)，内容幂等；写失败只告警，绝不影响账目（失败原因见
  `diagnostics.usageBill.error`）；写入结果见 `diagnostics.usageBill = {dir, filesWritten, lines, error}`。

---

## 3. `POST /api/dsh-workspace-fee/config`

**请求头**：`content-type: application/json`（缺省也接受；其他 essence → 400）。空体视为 `{}`。

**请求体（三种合法形态，可组合）**

**(A) 预警线 —— 面板形态**

```json
{ "alerts": { "--D-work-example-app--": { "limit": 5 } } }
```

**(B) 预警线 / 价格表 —— 宿主契约形态**

```json
{
  "alerts": { "defaultLimit": 5, "warnRatio": 0.8, "workspaces": { "--D-...--": 12, "--D-x--": null } },
  "pricing": { "families": { "flash": { "cacheMiss": 1.5 } }, "models": { "deepseek-v4-pro": "pro" },
               "peakMultiplier": 2, "peakWindows": [{ "days": [1,2,3,4,5], "from": "09:00", "to": "12:00" }] }
}
```

**(C) 追加价格版本**

```json
{ "pricing": { "append": {
    "effectiveFrom": 1791158400000,
    "note": "由费用面板追加",
    "models": { "flash": { "segments": [
      { "id": "peak", "label": "高峰", "days": [1,2,3,4,5], "from": "09:00", "to": "12:00", "hit": 0.04, "miss": 2, "out": 8 },
      { "id": "idle", "label": "空闲", "days": [1,2,3,4,5,6,7], "from": "00:00", "to": "24:00", "hit": 0.02, "miss": 1, "out": 4 }
    ] } } } } }
```

- `models` 为空/缺省 → **继承上一版本的价格**（只挪生效时刻）。`repriceExisting` 字段被接受但无额外语义（本插件不做物化计费，见 §4.3）。
- `effectiveFrom` 接受 epoch ms 或可解析时间字符串；**裸 `YYYY-MM-DD HH:mm` 按北京时间解释**。

**(D) 重置**

```json
{ "reset": true }
```

清空**用户层**覆盖（`config.json` 里的 `pricing`/`alerts` 与 settings 用户段），回到内置默认。`pricing`/`alerts` 与 `reset` 同时给出时以 `reset` 为准。

**200 响应**：与 `GET /config` 相同（含全部面板形态与契约形态字段），另加

```jsonc
{ "settingsWritten": true, "configPath": "C:\\Users\\...\\.dsh\\workspace-fee\\config.json" }
```

**400 响应**：字段级校验失败，逐条列出

```json
{ "ok": false, "error": "pricing.families.flash.cacheMiss 必须是非负有限数字", "details": ["..."] }
```

非法请求体（坏 JSON / 非对象 / 超 256 KiB / 非 `application/json`）同样 400，`details` 可能缺省。

**写入语义**：有 `ctx.settings` 时同时写 settings 命名空间 `dsh-workspace-fee`（用户段）与 `<dataDir>/config.json`；无 settings 时只写 `config.json`。**两份都写**是为了「没有设置服务时也能改」。

---

## 4. 价格口径（契约的一部分）

### 4.1 计费桶（**v1.1 修订**）

```
cost = cacheReadTokens/1e6 * hit + inputTokens/1e6 * miss + outputBillable/1e6 * out
outputBillable = outputTokens                                  （默认）
               = outputTokens + reasoningTokens                 （pricing.reasoningIncludedInOutput = false，仅用于口径对照）
```

**为什么不再把 reasoning 加一遍、也不再把 cacheRead 从 input 里减一遍（E1 + E2）**

| 证据 | 内容 |
|---|---|
| E2 源码 | `@deepseek-ai/dsh-llm-deepseek/lib/index.js:1145-1165`：`inputTokens = prompt_tokens - cacheRead`（注释明写 **DISJOINT counts**，即 `inputTokens` 就是缓存未命中桶）；`outputTokens = completion_tokens`；`reasoningTokens = completion_tokens_details.reasoning_tokens`；`totalTokens = prompt_tokens + completion_tokens` |
| E2 源码 | `@earendil-works/pi-ai/dist/api/openai-completions.js:1194` 注释：“OpenAI completion_tokens already includes reasoning_tokens.” |
| E2 源码 | `@deepseek-ai/dsh-token-meter/lib/types/turn-usage.js:29` 把 `reasoningTokens > outputTokens` 判为**非法输入** → reasoning 是 output 的子集 |
| E1 实测（判别性） | 真实语料里 `inputTokens < cacheReadTokens` 占绝大多数，且 Σinput 远小于 ΣcacheRead。若 `inputTokens` 是「含 cacheRead 的完整 prompt」，`input >= cacheRead` 必须恒成立 —— 实测绝大多数相反。 |
| E1 实测（判别性） | 按「把 input 当含 cacheRead」的夹 0 规则，**未命中桶被清零的记录占绝大多数**；且**不夹 0** 时总额为 **负数** —— 该口径无可行域。 |
| ⚠️ 非判别性 | `totalTokens == inputTokens + outputTokens + cacheReadTokens` 在两种假设下**都成立**（因为宿主 total = prompt + completion，而 DISJOINT 下 prompt = input + cacheRead），**不能**用它推断 input 是否含 cacheRead。 |
| E1 实测（三算法对比） | 同一份数据（flash 空闲价）：A 本插件 / B（reasoning 再加一遍）/ C（「input 当含 cacheRead」夹 0 版）三种口径的差额约 **+18.65% / +6.95%**。`scripts/probe.mjs` 每次现算这三个数并打印。 |

**结论**：官方「输出 4.0 元/百万 tokens」计的是 completion tokens（其中已含 reasoning）；`inputTokens` 已是未命中桶。
正确口径 = `cacheRead×hit + input×miss + output×out`。

> **读响应时请注意**：`diagnostics.counterfactual.*`（以及兼容别名 `costIfReasoningAdded*`）是**按错误口径重算的反事实值**，
> 用来把「若按旧口径会是多少」摆到台面上做自证。**账单口径只有 `totals.cost`（= `counterfactual.billedCost`）。**
> 曾经有 reviewer 把 `reasoningAddedCost` 当成「本实现的费用」，得出「多收 +21%」的误判 —— 请一律以 `totals.cost` 为准。

**两个对照开关**（默认关闭对照行为，仅用于把分歧数字摆到台面上）

| 字段 | 默认 | 含义 |
|---|---|---|
| `pricing.reasoningIncludedInOutput` | `true` | `false` = 把 `(output+reasoning)` 按 out 单价相加（旧口径 B） |
| `pricing.inputIncludesCacheRead` | `false` | `true` = 把 `inputTokens` 当含 `cacheRead`，未命中桶取 `max(0, input-cacheRead)`（对照口径 C） |

### 4.1.1 币种与费率表（内置版本的生成器；`tiers` 为便捷视图）

```jsonc
// pricing.rates：按币种 × 档位的内置费率（每百万 tokens，**空闲**价）；pricing.currency 选中其中一张
"rates": {
  "CNY": { "flash": { "cacheRead": 0.02,  "cacheMiss": 1.0,  "output": 4.0  },
           "pro":   { "cacheRead": 0.15,  "cacheMiss": 4.5,  "output": 13.5 } },
  "USD": { "flash": { "cacheRead": 0.003, "cacheMiss": 0.15, "output": 0.6  },
           "pro":   { "cacheRead": 0.022, "cacheMiss": 0.66, "output": 1.98 } }
}
```

- `pricing.currency`（默认 `CNY`）选中一张表；**内置版本**由该表 + `peakMultiplier` + `peakWindows`
  物化成 §4.2 的显式三段（高峰价 = 空闲价 × `peakMultiplier`，两币种都是 **2**，与契约给的高峰数值逐项吻合）。
- 覆盖顺序：内置 `rates` → `pricing.rates.<CUR>` → `pricing.families`（**仅覆盖当前币种**的简写）。
- 选了 `rates` 里不存在的币种 → 记入 `problems` 并**退回默认货币**（不静默按错价计费）。
- `summary.pricing.families` / `tiers` 是**当前货币**的便捷视图（`tiers` 标注 `@deprecated`）；
  权威值请读 `versions[].models[family].segments[].{hit,miss,out}`。

### 4.2 生效优先级（高 → 低）

`settings 命名空间用户段` → `<dataDir>/config.json` → 插件行 `config.pricing` → 内置默认表。

### 4.2 价格版本模型（**权威模型**，约定 1）

> **权威模型 = 「版本 + 时段分段」。** 任务描述里的 `tiers{cacheRead,cacheMiss,output} + peakMultiplier`
> **作废**（保留仅为便捷视图与内置版本的生成器，见 §4.1.1）；接口契约以 `versions[].models[family].segments`
> 为准。理由：分段模型是前者的超集（默认版本用「两段高峰 + 全天兜底」精确表达「两档 × 倍率 2」），
> 且「峰谷时段随调价会变」，固定倍率无法容纳。

```jsonc
// pricing.versions[]（GET /config → pricing.versions）
{
  "id": "builtin-2026-09-10",           // 内置版本固定 id；用户版本为 "v<n>-<effectiveFrom>"
  "effectiveFrom": 1789531200000,        // epoch ms，**归一到分钟**（见 4.2.1）
  "note": "内置官方价（2026-09-10T12:00:00+08:00 起生效）",
  "builtin": true,
  "models": {
    "flash": { "segments": [
      { "id": "flash-peak-1", "label": "高峰 09:00-12:00", "days": [1,2,3,4,5], "from": "09:00", "to": "12:00", "hit": 0.04, "miss": 2, "out": 8 },
      { "id": "flash-peak-2", "label": "高峰 14:00-18:00", "days": [1,2,3,4,5], "from": "14:00", "to": "18:00", "hit": 0.04, "miss": 2, "out": 8 },
      { "id": "flash-offpeak-all", "label": "空闲兜底（全部七天 00:00-24:00，含周末全天）", "days": [1,2,3,4,5,6,7], "from": "00:00", "to": "24:00", "hit": 0.02, "miss": 1, "out": 4 }
    ] }
  }
}
```

**内置默认版本 = 恰好三段，24/7 全覆盖（约定 3）**：两段工作日高峰 + 一条「全部七天 00:00-24:00」兜底。
左闭右开 + 声明顺序 ⇒ 周末与 18:00–次日 09:00 全部落兜底，**结构上不可能出现未定价记录**。
`coverageHoles()` 可随时验证这一点（自带断言：默认版本 7×1440 分钟无洞）。

#### 4.2.1 匹配语义（约定 2，逐条冻结）

| 规则 | 定义 |
|---|---|
| `days` | `1 = 周一 … 7 = 周日`。**空数组或缺省 = 全部七天**；只有「给了天数但含非法项」才报错 |
| 区间 | **左闭右开** `[from, to)` |
| 时刻 | `from` / `to` 为北京时间（UTC+8）`"HH:mm"`；`to = "24:00"` 表示当日 24:00 |
| 跨夜 | `to <= from` 视为**跨夜**（如 `22:00`→`02:00` 覆盖次日凌晨；`from === to` 退化为全天） |
| **时间戳精度** | 版本 `effectiveFrom` 与记录 `time` 比较前**一律向下取整到分钟**（`toMinute`），避免同一分钟内的归属歧义 |
| 多段命中 | 在 `segments` 里按**声明顺序取第一条**命中的段；**不报错、不报歧义**，顺序即优先级 |
| 版本选择 | 取**最新一个 `toMinute(effectiveFrom) <= toMinute(记录时刻)`** 的版本；记录早于所有版本时用内置版本作下界（条数/金额记入 `diagnostics.beforeEffectiveFrom*`） |
| **禁止跨版本回退** | 选中的版本里**没有任何段命中** ⇒ 该记录**未计价**：金额按 0，计入 `diagnostics.unpricedUsageRecords`，并在 `gaps[]` 里出现一条 `usage-unpriced`。**不得**用更早版本的价格顶上 |
| 档位 | `<family>` 由 `pricing.models[<model>]` 决定；未知模型回退 `pricing.fallbackFamily`（默认 `flash`）并记 `known:false` |
| 公式 | `cost = (cacheReadTokens*hit + inputTokens*miss + outputTokens*out) / 1e6`（§4.1；`cacheWriteTokens` 在日志里恒为 0，不出现在公式里） |

#### 4.2.3 核对单价的**单条命令**（验证者的前提）

```powershell
node scripts/report.mjs --segments
```

输出：当前生效版本 id、每个版本每个档位的 **段绝对值表**（`days / from / to / hit / miss / out`）、
该档位的 24/7 覆盖率、`unpricedUsageRecords`。同一份数据也可从 `GET /config → pricing.versions`
（含绝对值段）与 `GET /summary → pricing.versions` 读到。

**运行时权威 = 段绝对值。** `families` / `peakMultiplier` / `peakWindows` **只在 `normalizePricing`
阶段用于构造内置默认版本的段**；段一旦生成即为固定绝对值，**运行时不再乘任何倍率**。
`ratingFactor`/`priceFactor`（返回对象里的 `priceFactor`）与 `pricingTableRows()`（`/config → pricing.tiers`）
都只是**展示用**，不参与计费。用户通过 `POST /config` 追加的版本**必须直接给绝对值段**，不会被倍率二次加工
（有测试：把 `peakMultiplier` 改成 9，显式版本的费用一字不变）。

- **只允许追加**：`POST /config` 的 `pricing.append`。
- **追加必须自带完整 `models`**（缺 / 空 → **400**）。禁止「只写 delta 然后继承上一版本」——继承会让价格不可解释。
- 新版本分段**未覆盖 24/7** → **接受，但在响应的 `warnings[]` 与 `problems[]` 里给明确警告**：
  `"版本 v3 的档位 flash 存在未覆盖时段（N/10080 分钟），这些时段的新用量将不计价并计入 gaps"`。
  请求带 `"strict": true` 时改为 **400 拒绝**。
- **修改或删除历史版本 → 409** + `{ok:false,error}`（例如提交 `pricing.versions` 整表）。
- 追加成功后，**解析后的整表**会同时写入 `<dataDir>/config.json` 与 settings 用户段
  （不依赖任何继承，因此「价格从哪来」始终显式）。

### 4.4 时间与重算语义

费用**不物化**：每次扫描按记录时刻现算。因此「追加一个版本」天然只影响其 `effectiveFrom` 之后的记录，历史记录继续用旧版本 —— 与面板上「只对之后的新用量生效」一致。`repriceExisting: true` 在当前实现下与 `false` 等价（该时刻之后的记录本来就会用新版本重算）。

---

## 5. 兼容性说明（标准名 / 过渡别名，约定 4）

**标准名（权威）**：`workspaces[].workspaceId`、`daily[].workspaceId`、`daily[].label`、
`daily[].sessions`、顶层 `current`。

**过渡别名（`@deprecated`，值必须恒等于标准名）**：`workspaces[].key`、`daily[].workspaceKey`。
它们只为「已经跑通的 client」保留，**不是长期契约**；新代码请一律用 `workspaceId`。

| client 读取 | 标准名字段 | 关系 |
|---|---|---|
| `summary.workspaces[].workspaceId` | `workspaces[].workspaceId` | 标准 |
| `summary.workspaces[].key` | — | **@deprecated 别名**，恒等于 `workspaceId` |
| `summary.daily[].workspaceId` | `daily[].workspaceId` | 标准 |
| `summary.daily[].workspaceKey` | — | **@deprecated 别名**，恒等于 `workspaceId` |
| `summary.daily[].label` / `.sessions` | 同 | 标准 |
| `summary.current` | 同 | 由 `?sessionId=` 反查；查不到为 `null` |
| `config.alerts[<workspaceId>].limit` | 同 | 面板形态，值恒为 `{limit}` |
| `config.currency` | 同 | 等于 `pricing.currency` |
| `config.pricing.versions` / `.activeVersionId` | 同 | 标准 |

**注意**：`GET /summary` 与 `GET /config` 的响应是**超集**——只增字段、不改既有字段语义。契约变更流程：改本文件 → 在 `tests/routes.test.mjs` 补一条可失败的断言 → 通知客户端实现方。

---

## 6. `gaps[].kind` 取值表（缺口的机器可读词表）

| kind | 含义 |
|---|---|
| `sessions-root-missing` | 会话根目录不存在（账目为空，不是「零消耗」） |
| `sessions-root-unreadable` | 会话根目录读不了 |
| `workspace-unreadable` | 某工作区目录读不了 |
| `session-dir-unreadable` | 某会话目录读不了（列不出里面的日志文件） |
| `workspace-empty` | 工作区目录存在，但里面没有任何会话子目录/日志（不是「零消耗」） |
| `usage-unpriced` | 有用量记录落在所选版本的**未覆盖时段** → 未计价（约定 2：禁止跨版本回退）。`detail` 给出条数与版本 id |
| `session-log-missing` | 会话目录里**没有任何**会话日志文件（期望 `session[.v<N>].jsonl.zstd`）。`path` 是**会话目录** |
| `stat-failed` | 文件状态读取失败（读不到 ≠ 不存在） |
| `read-failed` | 文件读取失败（含被占用/权限） |
| `no-zstd-frames` | 文件里找不到任何 zstd 帧魔数 |
| `leading-bytes` | 首个帧之前有非帧字节（已忽略，可能丢数据） |
| `frame-decode-failed` | 某一帧解压失败（该帧数据丢失，其余帧仍计入） |
| `frame-boundary-without-newline` | 帧边界缺换行，已补换行以免记录粘连 |
| `jsonl-parse-failed` | 有行无法解析为 JSON |
| `session-header-missing` | 日志里没有 `type:"session"` 记录，`cwd` 只能由目录名推断 |

---

## 7. `POST /api/dsh-workspace-fee/refresh`

无请求体（空体或 `{}` 均可）。

**200 响应**

```json
{ "ok": true, "rebuiltAt": "<ISO-8601>", "elapsedMs": 1200,
  "filesFromCache": 0, "sessionFiles": 5, "usageRecords": 100, "problems": [] }
```

`filesFromCache: 0` 即「缓存确实被清空并全量重解」的可失败判据。

---

## 8. `GET /api/dsh-workspace-fee/health`（附加，非冻结契约的一部分）

```json
{ "ok": true, "plugin": "dsh-workspace-fee", "generatedAt": "...", "settingsAvailable": false,
  "paths": { "home": "...", "sessionsRoot": "...", "dataDir": "..." } }
```

---

## 9. 出错响应汇总
| 场景 | 状态码 | 响应体 |
|---|---|---|
| `days` 非整数 / 越界 / 非法字面量（`0` `-1` `366` `1.5` `1e3` `allx` …） | 400 | `{ok:false, error}`（合法值只有 `1..365` 与 `all`） |
| `POST /config` 坏 JSON / 非对象 / 非 `application/json` / 超 256 KiB | 400 | `{ok:false, error}`（`details` 可选） |
| `POST /config` 字段级非法 | 400 | `{ok:false, error, details:[...]}` |
| 方法不匹配 | 405 | `{ok:false, error}` + `Allow` 头 |
| 未预期异常（任何端点） | 500 | `{ok:false, error}` |

**绝不**在任何错误路径上返回 `200` 或空数组冒充成功。

---

## 10. 性能与内存纪律（可被验证者复核）

### 10.1 逐文件 + 单遍归集

- `analyzeSessionFile` **逐文件**处理：解码文本与记录对象只活在**单文件调用**内。
- 解析出的每一行**立刻**喂进增量归集器 `createUsageFolder()`，**不保留记录数组**；
  函数返回时只带出小对象（会话头 + 每条用量的 7 个字段）。
- 因此驻留内存与文件数几乎无关。实测：**GC 后存活堆约 5 MiB**；峰值 RSS 是 V8 尚未回收的
  临时垃圾，不是累积驻留。复现：`node --expose-gc scripts/probe.mjs`。

### 10.2 解析预筛（`parseFilter`）

- 默认 `needed`：只对含 `"usage"` / `"model"` / `"cwd"` 子串的行做 `JSON.parse`
  （`assistant/message` 必含 `data.usage` → 必含 `"usage"`；`request/context|header` 必含 `"model"`；
  `type:"session"` 头必含 `"cwd"`）。**这是超集选择器，不可能漏掉带 usage 的记录。**
- `all`：全量解析，审计用。两种模式必须给出**完全相同**的用量。
- 自证（每次 probe 都跑）：对最大的会话文件同时跑两种模式，打印 usage 条数与 tokens 对比，
  必须一致且全量解析无失败（条数与 tokens 完全相同）。
- 逐字去重始终跑在**全部行**上（纯字符串操作），预筛只影响解析哪些行；
  `diagnostics.recordsSkipped` 给出被跳过的行数，因此 `records + recordsSkipped` 必等于唯一行数。

### 10.3 耗时与缓存

- `diagnostics.elapsedMs` = 本次扫描耗时（冷缓存即 rebuild 全量）。
- 增量路径按 `(size, mtimeMs)` 跳过未变文件：命中缓存时约 **几十毫秒**；冷扫耗时随机器负载
  显著变化（同一份数据可相差一个数量级）。
- 强制全量：`POST /refresh`（返回 `filesFromCache: 0` 作为可失败判据）。

### 10.4 路由处理器可独立调用

`lib/routes.js` 导出 `createHandlers(ledger, logger) → {summary, config, refresh, health, routes}`，
每个 handler 都是 `(req, res) => Promise<void>` 的纯函数、不依赖 cordis `ctx`；
`lib/index.js` 只做 `ctx.webServer.register` 接线。验证者可直接 mock req/res 核对字段。

### 10.5 已知的外部约束（不是缺陷）

- 直接 HTTP 请求 `127.0.0.1:3080/api/dsh-workspace-fee/*` 会因 GUI 登录返回 **401**（预期行为，不作白名单）。
  真实客户端在已登录页面同源 fetch，路径是通的；离线核对请用 `node scripts/report.mjs --json`
  （不经过 HTTP，数据直接来自引擎）。
- `scripts/probe.mjs` 可选读取 `$DSH_HOME/dsh-usage/usage-ledger.json` 做**量级交叉参考**，
  该文件**不是**本插件的数据源；对不上时只并排列出两侧数字，不断言谁对谁错。
