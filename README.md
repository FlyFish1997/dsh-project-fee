# dsh-workspace-fee

按**工作区**维度监控 DeepSeek Harness（DSH）token 消耗与人民币费用的 Web 插件。

- 顶部状态栏药丸 + 图形化查询面板（浏览器侧）
- 模型工具 `workspace_fee` 与斜杠命令 `/fee`（会话内直接查询，不产生模型消息）
- 每工作区**日预警线 / 总预警线**（ok / warn / over 三档）
- 按**北京日**汇总的账单（工作区 × 日期），并落盘为按日 JSONL
- 统计口径四档：近 **7 / 30 / 90 天**，以及**全量**（`days=all`）
- 宿主侧引擎零第三方运行时依赖（只用 `node:` 内置模块）
- 只读本地会话日志，**不联网**、不上传任何数据

> 费用数字是**按会话日志自算的估算值**（按 DeepSeek 官方刊例价），**不是账单实付额**，
> 也不抓取官方价格。币种默认 CNY，可配置。

---

## 1. 环境要求

| 项 | 要求 |
|---|---|
| DeepSeek Harness | `>=0.1.2-rc.1`（`engines.dsh`）；开发与实测基于 **0.2.0-rc.2**（桌面版 + `dsh web`） |
| 宿主形态 | **DSH Web 宿主**：桌面应用（Electron）或命令行 `dsh web`。两者使用同一套 Web 前端 |
| Node.js | `^22.19.0 || >=24.0.0`（需要 `node:zlib` 的 zstd 支持） |
| 运行时依赖 | 无（插件本体只用 `node:` 内置模块；浏览器侧只依赖宿主注入的 React） |

**边界**：本插件是 DSH 的 cordis 插件 + DSH Web 客户端 bundle，**只能在 DSH 官方宿主里运行**。
非 DSH 平台、以及没有 `webServer` 服务的 profile（如 `headless` / `sdk`）不会加载它。

---

## 2. 安装到 profile

插件以 `link:` 形式装进 DSH profile，使 profile 的依赖列表与 `dsh.profile.bundles` 都能解析到
`dsh-workspace-fee`。安装后**必须重启宿主**并刷新页面。

### 2.1 Windows：一键安装（推荐）

```powershell
# 1) 先干跑，确认它打算做什么（不写任何东西）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-profile.ps1 -WhatIf

# 2) 真正安装（默认 web + desktop 两个 profile）
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\install-profile.ps1

# 找不到桌面版安装目录时显式指定（含 "DeepSeek Harness.exe" 的目录）
powershell ... -File scripts\install-profile.ps1 -DesktopAppDir "D:\path\to\deepseek-harness-desktop"

# 只装某一个 profile / 卸载
powershell ... -File scripts\install-profile.ps1 -Profile web
powershell ... -File scripts\install-profile.ps1 -Uninstall
```

说明：

- **装哪个 profile 取决于你用哪种宿主**：桌面应用使用 `desktop` profile（由应用独占，只有桌面运行时
  自带的 CLI 能管理）；`dsh web` 使用 `web` profile。
- `dsh` 通常不在 `PATH` 上。脚本会优先使用桌面安装自带的
  `resources\runtime\cli\bin\dsh.cmd`；也可以显式传 `-DshExe <路径>`。
- PowerShell 执行策略拒绝运行 `.ps1` 时，使用上面的 `-ExecutionPolicy Bypass`。
- 脚本是纯 ASCII，这是刻意的：Windows PowerShell 5.1 会把无 BOM 的 UTF-8 `.ps1` 按 ANSI/GBK 解码。
- 安装步骤会写入插件目录之外（`$DSH_HOME/profiles/<profile>`）。目标目录无写权限时会失败（如 `EPERM`），
  这不是脚本缺陷；脚本会打印可直接复制的命令。
- pnpm 会清掉 profile 里未被 `package.json` 声明的包，属预期行为。

### 2.2 手动安装（任意有 DSH CLI 的平台）

```bash
# web profile（dsh 在 PATH 上时）
dsh plugin --profile web add link:/absolute/path/to/this/repo

# desktop profile：必须用桌面运行时自带的 CLI 入口（应用独占该 profile）
# Windows 示例（PowerShell）：
# & "D:\...\DeepSeek Harness.exe" --expose-internals `
#   "D:\...\deepseek-harness-desktop\resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" `
#   plugin --profile desktop add link:<仓库绝对路径>
```

`dsh plugin` 是对 pnpm 的薄转发：在 profile 目录里跑 `pnpm add`，随后把 `dsh.profile.bundles`
与已安装状态对齐（声明了 `dsh.bundle.patch` 的依赖会加入 bundle 层栈）。本插件的补丁只
insert 一行，不改任何既有行的 config。

> macOS / Linux 上同样使用 `dsh plugin ... add link:<绝对路径>`（这是 pnpm 转发，本身跨平台）。
> **但本项目目前只在 Windows 上实测过**，macOS / Linux 未验证；桌面版 profile 的 CLI 入口路径
> 也因安装方式而异。详见 §8。

### 2.3 重启并刷新

浏览器侧是在宿主启动时加载的，不重启不会出现：

- **桌面版**：退出并重新打开 DeepSeek Harness，然后刷新页面。
- **`dsh web`**：停掉服务再启动，然后打开对应地址并刷新。

重启后会话头右侧应出现状态栏药丸：**工作区名 + 今日花费 + 预警色点**；点开后是近 N 天总花费、
按工作区横条，以及四个默认折叠区「按日账单 / Token 明细 / 预警线 / 价格设置」。

宿主侧是否可用，可离线核对（GUI 需要登录，直接请求 HTTP 往往返回 401，见 §7.3）：

```bash
node scripts/report.mjs --json     # 不经 HTTP，直接看引擎账目
```

---

## 3. 配置

优先级（高 → 低）：`settings 命名空间 dsh-workspace-fee 的用户段` → `<dataDir>/config.json`
→ 插件行 `config` → 内置默认。

### 3.1 插件行 config（`cordis.patch.yml`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `home` | string | DSH home（优先于 `$DSH_HOME`） |
| `sessionsRoot` | string | 会话日志根（优先于 `$DSH_WORKSPACE_FEE_SESSIONS`） |
| `dataDir` | string | 账本数据目录（优先于 `$DSH_WORKSPACE_FEE_DATA`） |
| `pricing` | object | 价格表覆盖（`families`/`models`/`peakWindows`/`versions`/…） |
| `alerts` | object | 预警线覆盖（`{defaultLimit, warnRatio, workspaces}`） |
| `persistCache` | boolean | 是否把解析缓存写盘（默认 `true`） |
| `flushSeconds` | number | 缓存落盘间隔秒数（默认 `60`，`0` = 不定时） |

### 3.2 环境变量

| 变量 | 作用 |
|---|---|
| `DSH_HOME` | DSH home；`sessionsRoot` 默认 `$DSH_HOME/sessions`，`dataDir` 默认 `$DSH_HOME/workspace-fee`，`usageDir` 默认 `$DSH_HOME/dsh-usage` |
| `DSH_WORKSPACE_FEE_SESSIONS` | 覆盖会话日志根（测试/演示时把数据指到别处） |
| `DSH_WORKSPACE_FEE_DATA` | 覆盖账本数据目录（解析缓存 + `config.json`） |
| `DSH_WORKSPACE_FEE_USAGE` | 覆盖按日 JSONL 账单目录 |
| `DSH_WORKSPACE_FEE_PROFILE` | 显式指定 profile 目录，供 `@deepseek-ai/dsh-tools` 运行时解析 |
| `DSH_CORE_DIR` | 独立验证脚本查找 DSH 证据源码的根目录（默认不猜测） |

### 3.3 按日 JSONL 账单

每次 `GET /summary` 与 `POST /refresh` 都会把账单覆盖写到 `usageDir`：

- `<usageDir>/<工作区目录名>.jsonl`：每行 `{type:'workspace-day', date, cost, tokens, sessions, …}`
- `<usageDir>/summary.jsonl`：每行 `{type:'day', date, cost, tokens, …}`（全工作区按日合计）

格式逐字段见 [`docs/SPEC.md`](docs/SPEC.md) §2b。写失败只告警（`diagnostics.usageBill.error`），
不影响账目。

### 3.4 运行时改动（面板 / HTTP）

`GET/POST /api/dsh-workspace-fee/config`：改预警线、改价格表、追加价格版本、重置。
请求体与响应形状见 [`docs/SPEC.md`](docs/SPEC.md) §2/§3。

---

## 4. 口径（会直接影响费用数字）

- **统计窗口**：`GET /summary?days=N` 是滚动窗口（最近 N 个北京日，含今天），
  `window.from = 今天 −(N−1)`。`days=all` 是**全量口径**：从最早一条可定位日期的用量记录
  所在北京日起到今天；`days` 字段回显字符串 `"all"`。非法值（`0`/`-1`/`366`/`1.5`/`1e3`/`allx`）
  一律 **400** —— 「全量」是显式字面量，不是「非数字即全量」。
  - 边界：**无时间戳的用量记录不进任何窗口**，只计入 `workspaces[].lifetimeCost`；
    条数由 `diagnostics.undatedUsageRecords` 给出，不会静默少算。
- **数据源**：DSH 会话日志 `<DSH_HOME>/sessions/<编码工作目录>/<会话id>/session[.v<N>].jsonl.zstd`。
  DSH 会随格式升级改文件名（`session.jsonl.zstd` → `session.v3.jsonl.zstd` → `session.v4.jsonl.zstd` …）。
  插件**逐个会话目录取版本号最大的那个文件**，其余版本记入 `diagnostics.supersededSamples`。
  **不能把同目录的多个版本都读**：新版本是整篇重写，两个都读会把重叠记录算两遍。
  实际读到的版本分布见 `diagnostics.sessionFileVersions`。
- **计费**（契约 v1.1）：
  `cost = cacheReadTokens/1e6*hit + inputTokens/1e6*miss + outputTokens/1e6*out`。
  - `inputTokens` 是**互斥桶**（宿主源码：`inputTokens = prompt_tokens - cacheRead`），**不得**再减一次 `cacheRead`。
  - `reasoningTokens` **已包含在 `outputTokens` 内**，**不再相加**。
  - 两个对照开关：`pricing.inputIncludesCacheRead`（默认 `false`）、
    `pricing.reasoningIncludedInOutput`（默认 `true`）。
  - `scripts/probe.mjs` 会打印 A/B/C 三种算法的总额与差额百分比，让口径可被反证。
- **币种**：`pricing.currency = CNY | USD`（默认 `CNY`）。两套内置费率（每百万 tokens，空闲价）：
  `CNY` flash 0.02/1.0/4.0、pro 0.15/4.5/13.5；`USD` flash 0.003/0.15/0.6、pro 0.022/0.66/1.98。
  高峰 = 空闲 × 2。可用 `pricing.rates.<CUR>` 覆盖或新增币种。
- **时段**：一律**北京时间 UTC+8**。高峰 = 工作日（周一至周五）09:00–12:00 与 14:00–18:00
  （**左闭右开**）；其余（含**周末全天**）为空闲。高峰价 = 空闲价 × 2（`peakMultiplier`）。
  按日也按北京日分桶，与宿主机器时区无关。
- **默认单价**（元 / 百万 tokens，空闲时段）：`flash` 档（`deepseek-flash`、`deepseek-v4-flash`、
  `deepseek-v4-flash-vision-exp`、`deepseek-chat`、`deepseek-reasoner`、未知模型回退）
  = 缓存命中 0.02 / 缓存未命中 1.0 / 输出 4.0；`pro` 档（`deepseek-v4-pro`）= 0.15 / 4.5 / 13.5。
  **价格来源日期 2026-09-10 12:00；请以官方页面为准。** 价格表可完全覆盖，不硬编码。
- **记账边界**：计**任何**带 `data.usage` 的记录；`(type,seq)` 去重 + 逐字去重；
  **只取 `data.usage`，绝不累加 `data.stream[].chunk.usage`**（两处基本同值，同时累加会让账单翻倍）。
- **处理不到的输入显式登记**：见 `/summary` 的 `gaps[]` 与 `docs/SPEC.md` §6。

---

## 5. 脚本与自测

```bash
# 人类可读自证报告（帧统计、去重一致性、双计虚增、价格、按日账单、缺口）
node scripts/probe.mjs --days=365 --out=reports/probe-report.md

# 机器可读报告
node scripts/report.mjs --json  --out=reports/report.json
node scripts/report.mjs --raw                 # 只输出 GET /summary 的响应体
node scripts/report.mjs --raw --days=all      # 全量口径
node scripts/report.mjs --segments            # 按段核对单价
node scripts/report.mjs --md

# 宿主侧测试
node --test --test-isolation=none tests/pricing.test.mjs tests/session-log.test.mjs \
  tests/ledger.test.mjs tests/routes.test.mjs tests/plugin.test.mjs
node --test --test-isolation=none "tests/*.test.mjs"
node tests/client-bundle.test.mjs              # 浏览器侧

# 独立验证装置（19 项；见下方说明）
node tests/verify-independent/run-all.mjs
```

`npm test`、`npm run test:all`、`npm run test:client`、`npm run test:verify` 是等价入口。

**测试不需要真实会话日志**：fixtures 全部由
[`tests/verify-independent/harness/make-synthetic-corpus.mjs`](tests/verify-independent/harness/make-synthetic-corpus.mjs)
用固定种子生成，不含任何真实数据。

**独立验证的当前状态（如实说明）**：`run-all.mjs` 共 19 项，其中 **17 项通过、2 项失败（exit 1）**：

1. `refute-buckets` 的 2 条断言依赖 DSH 上游源码作为可核验证据；找不到源码时**如实地失败**
   —— 用 `DSH_CORE_DIR` 指向包含 `@deepseek-ai/dsh-token-meter` 与 `@earendil-works/pi-ai`
   的 `node_modules` 后重跑。
2. `caliber-immutability` 是**已登记缺陷 F-12**（`pricing.reasoningIncludedInOutput` 是全局开关，
   翻转会回溯改写历史口径的解读），脚本故意 `exit 1` 以保持可见。本版**未修**。

> **受限环境注意**：若运行环境禁止子进程 `piped stdio` 或不允许写仓库子目录，
> `node --test tests/`（默认每文件一个子进程 + 管道）会 `spawn EPERM`。
> 此时用 `--test-isolation=none` 并给验证脚本设置 `DSH_TEST_TMP=<一个可写的新目录>`。
> 独立验证会把真实会话日志复制到 `DSH_TEST_TMP`；**该目录含真实会话内容，不要提交**。

### 5.1 性能与内存（量级）

| 项 | 读数 |
|---|---|
| 解析预筛 | 只 `JSON.parse` 含 `"usage"/"model"/"cwd"` 的行，跳过大部分无关行 |
| GC 后存活堆 | 约 **5 MiB**（逐文件 + 单遍归集，不留记录数组） |
| 增量扫描 | 命中 `(size, mtime)` 缓存时约 **几十毫秒** |
| 冷扫 | 随机器并发负载变化很大（同一份数据可差一个数量级） |

### 5.2 离线核对路径

直接请求 `127.0.0.1:<port>/api/dsh-workspace-fee/*` 会因 GUI 登录返回 **401**（预期行为，
不作白名单）。核对契约请用两条不经过 HTTP 的路子：

```bash
node scripts/report.mjs --json          # 完整账目（数据直接来自引擎）
node scripts/report.mjs --raw           # 就是 GET /summary 的响应体
```

或直接 import 路由处理器（不启宿主）：

```js
import { createHandlers } from './lib/routes.js';
import { createLedger } from './lib/ledger.js';
const ledger = createLedger({ home: process.env.DSH_HOME });
const { summary, config, refresh } = createHandlers(ledger, () => {});
// summary(fakeReq, fakeRes) —— handler 是纯函数，可 mock req/res 逐字段核对
```

---

## 6. 目录结构

| 路径 | 作用 |
|---|---|
| `package.json` | 包元数据；`dsh.bundle.patch` 指向 `cordis.patch.yml` |
| `cordis.patch.yml` | 宿主行补丁：把 `dsh-workspace-fee` 这一行插进 profile 的插件树 |
| `lib/session-log.js` | 多帧 zstd 解码、JSONL 解析、两种去重、用量与模型归属提取、**会话日志版本识别** |
| `lib/pricing.js` | 价格口径：按生效时刻分段的**价格版本** + 峰谷倍率 + 计费公式 |
| `lib/ledger.js` | 账本：扫目录、按工作区×北京日聚合、缓存、缺口、告警、配置分层 |
| `lib/report.js` | 人类可读（Markdown）与 JSON 渲染 |
| `lib/routes.js` | HTTP 端点（契约见 `docs/SPEC.md`） |
| `lib/index.js` | cordis 插件入口（`name` / `inject` / `apply`） |
| `lib/host-tools.js` | 模型工具 `workspace_fee` + 斜杠命令 `/fee` 的注册与降级 |
| `lib/fee-query.js` | 会话侧查询的纯逻辑（无 I/O） |
| `lib/client.js` | 浏览器侧：状态栏药丸 + 查询面板 |
| `lib/time.js` | 北京时间口径 |
| `scripts/probe.mjs` | 人类可读**自证**报告 |
| `scripts/report.mjs` | 机器可读报告 |
| `scripts/check-endpoints.mjs` | 网络面可达性探测（**不作契约验证**） |
| `scripts/install-profile.ps1` | Windows 一键安装到 profile（幂等，纯 ASCII） |
| `scripts/check-syntax.mjs` | 源码语法 + 乱码扫描 |
| `tests/` | 宿主侧与浏览器侧测试；`tests/fixtures/` 为自造夹具 |
| `tests/verify-independent/` | 独立验证装置（19 项检查 + 变异覆盖矩阵） |
| `docs/SPEC.md` | HTTP 接口契约（冻结版） |

---

## 7. 已知限制（自陈效力边界）

1. `pricing.effectiveFrom` 只作元数据：**早于该时刻的记录仍按当前表计价**，条数与金额记在
   `diagnostics.beforeEffectiveFrom*`。
2. 自定义价格版本的 segment 若覆盖不全，未命中记录回退内置表，并计入
   `diagnostics.unpricedUsageRecords`（可见，不静默）。
3. 目录名 → `cwd` 的解码对含 `-` 的目录名有损，仅在日志缺 `type:"session"` 时使用
   （此时 `cwdSource = "directory-name"`）。目录名编解码的**回退路径**按常见的
   `--<盘符>-…--` 形状实现；POSIX 路径的极端形态可能定位不到工作区，主路径按 `sessionId` 不受影响。
4. 宿主装配在 **DSH 0.2.0-rc.2** 上实测（桌面版 `desktop` profile + 独立隔离 profile）：
   `apply` 跑完、四条路由 200、模型工具 `workspace_fee` 在真实会话里可用。
   `ctx.settings` 在命令行 profile 里不可用，此时 `/health` 报 `settingsAvailable:false`
   并自动降级到 `config.json` —— 这是预期降级。
5. 默认数据目录（`$DSH_HOME/workspace-fee`）在宿主进程内可写；受限沙箱下写失败只告警，不影响账目。
6. 费用数字是**按日志自算**的估算值，不是官方账单。
7. **会话日志格式版本可能继续变**（v4 → v5…）。选版本按**文件名里的数字**，通常无需改代码；
   若 DSH 改成不带版本号段的其它文件名，插件会记 `session-log-missing`（不静默当作零消耗），
   此时更新 `lib/session-log.js` 的 `SESSION_LOG_FILE_RE`。
8. `pricing.currency` 切到 `USD` 时，`/summary` 与面板正确；**模型工具文案与按日 JSONL 账单里的
   币种字段仍是 `CNY`**（未随配置切换）。金额本身按所选费率表计算。
9. 时区与高峰时段固定为**北京时间 / 中国区口径**；非中国区用户看到的「今日」「按日」分桶会不同。
   可通过 `pricing.peakWindows` 覆盖高峰段，但 UTC+8 的日界不可配置。
10. 独立验证不是全绿：见 §5 的 17/19 说明。

---

## 8. 平台与兼容性

**结论分两层，不能笼统说「适用于任意平台」：**

| 场景 | 结论 | 依据 |
|---|---|---|
| 任意 **OS** 上的 **DSH Web 宿主**（桌面 Electron / `dsh web`） | **部分适用** | 宿主引擎只用 `node:` 内置模块与 `path.join`，无 Windows API / 子进程调用；但安装脚本与文档是 Windows 形状，时区/币种默认中国口径 |
| 任意 **DSH profile** | **部分适用** | `webServer` 是硬依赖；无 `webServer` 的 profile（`headless`/`sdk` 等）不会加载 |
| **非 DSH 平台**（独立 Node 应用、其他编辑器、纯浏览器页面） | **不适用** | 依赖 cordis 宿主、DSH 会话日志布局、`window.__ModuleLoader__` 与 slots 客户端协议 |

补充事实：

- **宿主引擎**：`lib/*.js` 零第三方依赖，文件系统/进程层面 OS 无关。会话目录名编解码的
  **回退**逻辑带 Windows 盘符假设（见 §7.3）。
- **浏览器侧**：只依赖 DSH Web 的模块表、`slots` 服务与 React；API 用相对前缀
  `/api/dsh-workspace-fee`，**不硬编码端口**。桌面版与 `dsh web` 用同一份客户端代码。
- **安装**：`scripts/install-profile.ps1` 是 **Windows / PowerShell 专用**（`USERPROFILE`、
  `LOCALAPPDATA`、`DeepSeek Harness.exe`、`app.asar` 路径）。macOS / Linux 可用等价的
  `dsh plugin --profile <p> add link:<绝对路径>`，但**本项目未在 POSIX 实机验证**。
- **DSH 版本**：`engines.dsh: >=0.1.2-rc.1`（无上界）。0.2.0-rc.2 有实测记录；更新版本的
  槽位名、客户端加载协议、会话日志格式仍属 DSH 内部实现，可能变化。
- **DSH 官方支持哪些 OS**：以 DSH 官方发布为准。本项目的实测环境是 **Windows x64**。

---

## 9. 数据与隐私

- 插件**只读**本地 DSH 会话日志（`$DSH_HOME/sessions`），**不发起网络请求**、不上传任何数据。
- 运行期只写：`dataDir`（解析缓存 + `config.json`）、`usageDir`（按日 JSONL 账单）、
  `dataDir/surfaces.json`（装配诊断）。这些目录都可用环境变量重定向。
- 费用数字按官方刊例价估算，**不是账单实付额**。
- 仓库内的测试夹具全部为合成数据，不含真实会话内容；测试运行可能把真实会话日志复制到
  `tests/verify-independent/.tmp-home/`（已在 `.gitignore` 中忽略），**该目录不要提交**。

---

## License

MIT，见 [`LICENSE`](LICENSE)。
