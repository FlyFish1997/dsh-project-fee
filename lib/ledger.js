/**
 * 账本（ledger）
 * ---------------------------------------------------------------------------
 * 把 `<sessionsRoot>/<编码工作目录>/<会话id>/session[.v<N>].jsonl.zstd` 全量扫成
 * 「工作区 × 北京日」的账目，并给出求和、按日、告警级别、缺口清单与诊断数字。
 *
 * 会话日志**逐个会话目录按版本号取最新的那一个文件**（DSH 升级会换文件名，
 * v3 → v4；同一目录下的 v4 是整篇重写，两个都读会双计），见
 * `lib/session-log.js` 的 `pickSessionLogFile()`。
 *
 * 记账边界（与 docs/SPEC.md 一致）：
 *   - 只计 `assistant/message` 上带 `data.usage` 的记录；
 *   - 同一条记录按 `(type,seq)` 去重，跨帧重复写入按逐字去重，两者结果必须一致；
 *   - 处理不到的日志文件（不存在、解码失败）显式进 `gaps`，不假装干净。
 *
 * 目录解析优先级（零第三方依赖，自行实现 dsh-home-paths 的公开口径）：
 *   home        = options.home        ?? $DSH_HOME            ?? ~/.dsh
 *   sessionsRoot= options.sessionsRoot ?? $DSH_WORKSPACE_FEE_SESSIONS ?? <home>/sessions
 *   dataDir     = options.dataDir      ?? $DSH_WORKSPACE_FEE_DATA      ?? <home>/workspace-fee
 *   usageDir    = options.usageDir     ?? $DSH_WORKSPACE_FEE_USAGE     ?? <home>/dsh-usage
 * 测试/演示通过 `DSH_HOME`（或另两个变量）把数据目录指到工作区内即可运行。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { analyzeSessionFile, decodeWorkspaceKey, pickSessionLogFile } from './session-log.js';
import { DEFAULT_PRICING, activeVersionId, appendVersion, normalizePricing, priceUsage, pricingTableRows, ratesTable, toPlainPricing, versionsForClient } from './pricing.js';
import { addDays, beijingDateKey, beijingDateTime } from './time.js';

/** 设置命名空间名（`POST /config` 在有 settings 服务时写入它）。 */
export const SETTINGS_NAMESPACE = 'dsh-workspace-fee';

/** HTTP 路由前缀。 */
export const ROUTE_PREFIX = '/api/dsh-workspace-fee';

/**
 * `days` 的**全量口径**字面量（见 docs/SPEC.md §1）：
 * `days=all` 表示「从最早一条可定位日期的用量记录起，到今天（含）」，而不是最近 N 天。
 * 单独导出，路由层（`lib/routes.js`）与账本层共用同一个字面量，避免两边写岔。
 */
export const ALL_TIME_DAYS = 'all';

/** 全量口径在扫描期的哨兵下界：放行全部记录，扫完后用真实最早日期替换（见 summary()）。 */
const ALL_TIME_FLOOR = '0000-01-01';

/** 缓存文件格式版本；不匹配即整表失效。 */
export const CACHE_VERSION = 1;

/** 默认告警配置。`defaultLimit` 是**日线**默认，`defaultTotalLimit` 是**总线**默认（均为 null = 不预警）。 */
export const DEFAULT_ALERTS = Object.freeze({
  defaultLimit: null,
  defaultTotalLimit: null,
  warnRatio: 0.8,
  workspaces: {},
});

const DAY_MS = 24 * 60 * 60 * 1000;

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function blank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

/** 复刻 dsh-home-paths 的优先级：显式配置 > $DSH_HOME（空白视为未设） > ~/.dsh。 */
export function resolveDshHome(configured, env = process.env) {
  if (!blank(configured)) return resolve(String(configured));
  const fromEnv = env?.DSH_HOME;
  if (!blank(fromEnv)) return resolve(String(fromEnv));
  return join(homedir(), '.dsh');
}

/**
 * 校验并规范化告警覆盖值。同时接受两种写入形态：
 *   A) 宿主契约形态：`{defaultLimit, warnRatio, workspaces:{<key>: number|null}}`
 *   B) 浏览器面板形态：`{<workspaceKey>: {limit: number|null}}`（或 `{<key>: 数字}`）
 *   C) **双预警线形态**：`{workspaces:{<key>:{day, total}}}` —— 每个工作区一条**日线** + 一条**总线**。
 *
 * 三者都会归一到 `{defaultLimit, defaultTotalLimit, warnRatio, workspaces:{<key>:{day,total}}}`。
 *
 * **向后兼容**：旧配置里一个工作区只写一个数字（或 `{limit}`），一律理解为**日线**，总线为 null。
 * 老配置不会失效，也不会被误读成总线。
 * @param {object|undefined} override
 * @returns {{alerts: object, problems: string[]}}
 */
export function normalizeAlerts(override) {
  const problems = [];
  const out = {
    defaultLimit: DEFAULT_ALERTS.defaultLimit,
    defaultTotalLimit: DEFAULT_ALERTS.defaultTotalLimit ?? null,
    warnRatio: DEFAULT_ALERTS.warnRatio,
    workspaces: {},
  };
  if (override === undefined || override === null) return { alerts: out, problems };
  if (!isPlainObject(override)) {
    problems.push('alerts 必须是对象');
    return { alerts: out, problems };
  }
  const readLimit = (value, label) => {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
    problems.push(`${label} 必须是非负有限数字或 null`);
    return undefined; // 无效值：调用方保留原值
  };
  if (override.defaultLimit !== undefined) {
    const v = readLimit(override.defaultLimit, 'alerts.defaultLimit');
    if (v !== undefined) out.defaultLimit = v;
  }
  if (override.defaultTotalLimit !== undefined) {
    const v = readLimit(override.defaultTotalLimit, 'alerts.defaultTotalLimit');
    if (v !== undefined) out.defaultTotalLimit = v;
  }
  if (override.warnRatio !== undefined) {
    if (typeof override.warnRatio === 'number' && Number.isFinite(override.warnRatio) && override.warnRatio > 0 && override.warnRatio <= 1) {
      out.warnRatio = override.warnRatio;
    } else problems.push('alerts.warnRatio 必须落在 (0,1]');
  }
  /** 一个工作区的配置归一到 `{day,total}`；数字/`{limit}` 一律理解为日线。 */
  const assignWorkspace = (key, value, label) => {
    const prev = out.workspaces[key] ?? { day: null, total: null };
    if (value === null || value === undefined) {
      out.workspaces[key] = { day: null, total: null };
      return;
    }
    if (typeof value === 'number' || typeof value === 'string') {
      const v = readLimit(value, label);
      if (v !== undefined) out.workspaces[key] = { day: v, total: prev.total };
      return;
    }
    if (isPlainObject(value)) {
      const next = { day: prev.day, total: prev.total };
      if (value.day !== undefined || value.limit !== undefined) {
        const v = readLimit(value.day !== undefined ? value.day : value.limit, `${label}.day`);
        if (v !== undefined) next.day = v;
      }
      if (value.total !== undefined) {
        const v = readLimit(value.total, `${label}.total`);
        if (v !== undefined) next.total = v;
      }
      out.workspaces[key] = next;
      return;
    }
    problems.push(`${label} 必须是数字、null，或 {day,total} 对象`);
  };
  if (override.workspaces !== undefined) {
    if (!isPlainObject(override.workspaces)) problems.push('alerts.workspaces 必须是对象');
    else for (const [key, value] of Object.entries(override.workspaces)) assignWorkspace(key, value, `alerts.workspaces.${key}`);
  }
  for (const [key, value] of Object.entries(override)) {
    if (key === 'defaultLimit' || key === 'defaultTotalLimit' || key === 'warnRatio' || key === 'workspaces') continue;
    assignWorkspace(key, value, `alerts.${key}`);
  }
  return { alerts: out, problems };
}

/** 把告警配置渲染成浏览器面板读取的形态：`{<workspaceKey>: {day, total}}`。 */
export function alertsForClient(alerts) {
  const out = {};
  for (const [key, value] of Object.entries(alerts?.workspaces ?? {})) {
    out[key] = { day: value?.day ?? null, total: value?.total ?? null, limit: value?.day ?? null };
  }
  return out;
}

/**
 * 查询某个工作区生效的**日**预警线。
 * 归一到对象后 `workspaces[key].day`；无自身配置则用 `defaultLimit`。
 */
export function limitOf(alerts, workspaceKey) {
  const own = alerts?.workspaces?.[workspaceKey];
  if (own !== undefined && own !== null) return own.day ?? null;
  return alerts?.defaultLimit ?? null;
}

/** 查询某个工作区生效的**总**预警线。 */
export function totalLimitOf(alerts, workspaceKey) {
  const own = alerts?.workspaces?.[workspaceKey];
  if (own !== undefined && own !== null && own.total !== undefined) return own.total ?? null;
  return alerts?.defaultTotalLimit ?? null;
}

/** 单条线的级别判定。`cost` 与该线的 `limit` 比较，`>= limit` 即 over。 */
function lineLevel(cost, limit, warnRatio) {
  if (limit === null || limit === undefined || !(limit > 0)) return { level: 'ok', limit: limit ?? null, ratio: null };
  const ratio = cost / limit;
  if (cost >= limit) return { level: 'over', limit, ratio };
  const wr = typeof warnRatio === 'number' && warnRatio > 0 && warnRatio <= 1 ? warnRatio : DEFAULT_ALERTS.warnRatio;
  if (cost >= limit * wr) return { level: 'warn', limit, ratio };
  return { level: 'ok', limit, ratio };
}

/**
 * 由「今日花费 + 累计花费 + 两条线」给出级别。
 *
 *   alert = { day:{limit,level,ratio}, total:{limit,level,ratio}, level, limit }
 *
 * `level` 为两条线中**更严重**的一个（over > warn > ok）—— 面板与状态栏只读这一个即可。
 * `limit` 保留为**日线**的值，供旧消费方继续工作（向后兼容）。
 *
 * @param {{todayCost:number, lifetimeCost:number, dayLimit:number|null, totalLimit:number|null, warnRatio:number}} input
 */
export function alertLevel(input) {
  const { todayCost = 0, lifetimeCost = 0, dayLimit = null, totalLimit = null, warnRatio } = input ?? {};
  const day = lineLevel(todayCost, dayLimit, warnRatio);
  const total = lineLevel(lifetimeCost, totalLimit, warnRatio);
  const rank = { ok: 0, warn: 1, over: 2 };
  const level = (rank[day.level] ?? 0) >= (rank[total.level] ?? 0) ? day.level : total.level;
  return { day, total, level, limit: day.limit };
}

const ZERO_TOKENS = () => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0 });

function addTokens(target, usage) {
  target.inputTokens += usage?.inputTokens ?? 0;
  target.outputTokens += usage?.outputTokens ?? 0;
  target.cacheReadTokens += usage?.cacheReadTokens ?? 0;
  target.reasoningTokens += usage?.reasoningTokens ?? 0;
  target.totalTokens += usage?.totalTokens ?? 0;
}

/** 枚举工作区目录与其下的会话文件。 */
export function enumerateSessions(sessionsRoot) {
  const workspaces = [];
  const gaps = [];
  // 自证数字：实际读了哪些版本、忽略了几个被新版本取代的旧文件（不静默）。
  const fileStats = { versions: {}, supersededFiles: 0, supersededSamples: [] };
  if (!existsSync(sessionsRoot)) {
    gaps.push({ kind: 'sessions-root-missing', path: sessionsRoot, detail: '会话根目录不存在，账目为空' });
    return { workspaces, gaps, fileStats };
  }
  let entries;
  try {
    entries = readdirSync(sessionsRoot, { withFileTypes: true });
  } catch (error) {
    gaps.push({ kind: 'sessions-root-unreadable', path: sessionsRoot, detail: String(error?.message ?? error) });
    return { workspaces, gaps, fileStats };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const workspaceKey = entry.name;
    const workspaceDir = join(sessionsRoot, entry.name);
    const files = [];
    let sessionDirs;
    try {
      sessionDirs = readdirSync(workspaceDir, { withFileTypes: true });
    } catch (error) {
      gaps.push({ kind: 'workspace-unreadable', path: workspaceDir, detail: String(error?.message ?? error) });
      continue;
    }
    for (const child of sessionDirs) {
      if (!child.isDirectory()) continue;
      const sessionDir = join(workspaceDir, child.name);
      let picked;
      try {
        picked = pickSessionLogFile(sessionDir);
      } catch (error) {
        gaps.push({ kind: 'session-dir-unreadable', path: sessionDir, detail: String(error?.message ?? error) });
        continue;
      }
      if (picked === null) {
        gaps.push({
          kind: 'session-log-missing',
          path: sessionDir,
          detail: `会话目录 ${child.name} 里没有会话日志（期望 session[.v<N>].jsonl.zstd）`,
        });
        continue;
      }
      fileStats.versions[`v${picked.version}`] = (fileStats.versions[`v${picked.version}`] ?? 0) + 1;
      if (picked.superseded.length > 0) {
        fileStats.supersededFiles += picked.superseded.length;
        if (fileStats.supersededSamples.length < 10) {
          fileStats.supersededSamples.push({ sessionId: child.name, used: picked.fileName, ignored: picked.superseded });
        }
      }
      files.push({ filePath: picked.filePath, sessionId: child.name, sessionFileVersion: picked.version, superseded: picked.superseded });
    }
    if (files.length === 0 && sessionDirs.length === 0) {
      // 目录存在但完全没有可处理内容：显式登记，不静默当作「零消耗」。
      gaps.push({ kind: 'workspace-empty', path: workspaceDir, detail: '工作区目录存在，但没有任何会话子目录/日志' });
    }
    workspaces.push({ workspaceKey, workspaceDir, files });
  }
  return { workspaces, gaps, fileStats };
}

/**
 * 建立账本。
 * @param {object} [options]
 * @param {string} [options.home]
 * @param {string} [options.sessionsRoot]
 * @param {string} [options.dataDir]
 * @param {object} [options.pricing] 组合配置里的价格覆盖（最低优先级）
 * @param {object} [options.alerts]
 * @param {boolean} [options.persistCache] 是否把缓存写盘（默认 true）
 * @param {(level:string, message:string, detail?:unknown)=>void} [options.logger]
 * @returns {object} 账本实例
 */
export function createLedger(options = {}) {
  const home = resolveDshHome(options.home);
  const sessionsRoot = options.sessionsRoot ?? (blank(process.env.DSH_WORKSPACE_FEE_SESSIONS) ? join(home, 'sessions') : resolve(process.env.DSH_WORKSPACE_FEE_SESSIONS));
  const dataDir = options.dataDir ?? (blank(process.env.DSH_WORKSPACE_FEE_DATA) ? join(home, 'workspace-fee') : resolve(process.env.DSH_WORKSPACE_FEE_DATA));
  const usageDir = options.usageDir ?? (blank(process.env.DSH_WORKSPACE_FEE_USAGE) ? join(home, 'dsh-usage') : resolve(process.env.DSH_WORKSPACE_FEE_USAGE));
  const persistCache = options.persistCache !== false;
  const parseFilter = options.parseFilter === 'all' ? 'all' : 'needed';
  const log = typeof options.logger === 'function' ? options.logger : () => {};
  // 可注入时钟：让测试能断言「今日」「窗口」「生效版本」而不受运行时刻影响。
  const now = typeof options.now === 'function' ? options.now : () => Date.now();

  const configPath = join(dataDir, 'config.json');
  const cachePath = join(dataDir, 'cache.json');

  /** 组合配置（来自插件行 config），最低优先级。 */
  const composed = {
    pricing: options.pricing,
    alerts: options.alerts,
  };
  /** settings 服务可用时的动态来源；返回 undefined 表示不可用。 */
  let settingsSource = null;
  /** 磁盘上的用户覆盖（由 POST /config 写出）。 */
  let fileConfig = readFileConfig();

  const cache = new Map();
  loadCacheFromDisk();

  function readFileConfig() {
    try {
      if (!existsSync(configPath)) return {};
      const parsed = JSON.parse(readFileSync(configPath, 'utf8'));
      return isPlainObject(parsed) ? parsed : {};
    } catch (error) {
      log('warn', `读取 ${configPath} 失败，忽略配置文件`, error);
      return {};
    }
  }

  function loadCacheFromDisk() {
    if (!persistCache) return;
    try {
      if (!existsSync(cachePath)) return;
      const parsed = JSON.parse(readFileSync(cachePath, 'utf8'));
      if (parsed?.version !== CACHE_VERSION || !isPlainObject(parsed.files)) return;
      for (const [filePath, row] of Object.entries(parsed.files)) {
        if (isPlainObject(row) && typeof row.size === 'number' && typeof row.mtimeMs === 'number' && isPlainObject(row.analysis)) {
          cache.set(filePath, row);
        }
      }
    } catch (error) {
      log('warn', `读取账本缓存 ${cachePath} 失败，将全量重扫`, error);
      cache.clear();
    }
  }

  function saveCacheToDisk() {
    if (!persistCache) return;
    try {
      mkdirSync(dataDir, { recursive: true });
      const files = {};
      for (const [filePath, row] of cache) files[filePath] = row;
      writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), files }), 'utf8');
    } catch (error) {
      // 缓存写不进去只影响性能，绝不影响账目正确性。
      log('warn', `写账本缓存 ${cachePath} 失败（不影响账目）`, error);
    }
  }

  /**
   * 解析当前生效的定价与告警配置。
   * 优先级：settings 命名空间 > config.json > 组合配置 > 内置默认。
   * @returns {{pricing:object, alerts:object, source:{pricing:string, alerts:string, settingsAvailable:boolean}, problems:string[]}}
   */
  function getConfig() {
    const problems = [];
    let settingsValue;
    let settingsAvailable = false;
    if (settingsSource) {
      try {
        const value = typeof settingsSource.get === 'function' ? settingsSource.get() : undefined;
        if (isPlainObject(value)) {
          settingsAvailable = true;
          settingsValue = value;
        }
      } catch (error) {
        log('warn', '读取 dsh-workspace-fee 设置失败', error);
      }
    }

    let pricing = normalizePricing(undefined).pricing;
    let pricingSource = 'default';
    let pricingAccum = {};
    for (const [name, layer] of [
      ['composed', composed.pricing],
      ['file', fileConfig.pricing],
      ['settings', settingsValue?.pricing],
    ]) {
      // 空层不算「生效层」，否则 settings 服务一挂上就会把来源标成 settings。
      if (!isPlainObject(layer) || Object.keys(layer).length === 0) continue;
      pricingAccum = mergePricingLayers([pricingAccum, layer]);
      const normalized = normalizePricing(pricingAccum);
      for (const problem of normalized.problems) problems.push(`pricing[${name}]: ${problem}`);
      pricing = normalized.pricing;
      pricingSource = name;
    }

    let alerts = normalizeAlerts(undefined).alerts;
    let alertsSource = 'default';
    let alertsAccum = {};
    for (const [name, layer] of [
      ['composed', composed.alerts],
      ['file', fileConfig.alerts],
      ['settings', settingsValue?.alerts],
    ]) {
      if (!isPlainObject(layer) || Object.keys(layer).length === 0) continue;
      alertsAccum = mergeAlertsLayers([alertsAccum, layer]);
      const normalized = normalizeAlerts(alertsAccum);
      for (const problem of normalized.problems) problems.push(`alerts[${name}]: ${problem}`);
      alerts = normalized.alerts;
      alertsSource = name;
    }

    return {
      pricing,
      alerts,
      source: { pricing: pricingSource, alerts: alertsSource, settingsAvailable },
      problems,
    };
  }

  /** 浅合并多层价格覆盖（后层优先；tiers/models 逐键合并）。 */
  function mergePricingLayers(layers) {
    const out = {};
    for (const layer of layers) {
      if (!isPlainObject(layer)) continue;
      for (const [key, value] of Object.entries(layer)) {
        if (key === 'tiers' || key === 'models') {
          out[key] = { ...(out[key] ?? {}), ...(isPlainObject(value) ? value : {}) };
        } else out[key] = value;
      }
    }
    return out;
  }

  /**
   * 多层告警配置合并（后层优先）。
   *
   * 每个工作区归一到 `{day, total}`：
   *   - 数字 或 `{limit}` → 只写**日线**（老配置语义，向后兼容）
   *   - `{day, total}` → 两条线各自写入；只写其中一条时**保留**另一条的已有值
   *
   * 注意：这里不能把对象塌缩成 `value.limit` —— 那会丢掉 `total`，
   * 而 `normalizeAlerts` 随后看到的是 `null`，表现为「配了总线却不生效」。
   */
  function mergeAlertsLayers(layers) {
    const out = {};
    const workspaces = {};
    const TOP = new Set(['defaultLimit', 'defaultTotalLimit', 'warnRatio']);
    for (const layer of layers) {
      if (!isPlainObject(layer)) continue;
      for (const [key, value] of Object.entries(layer)) {
        if (key === 'workspaces') {
          if (!isPlainObject(value)) continue;
          for (const [wsKey, wsValue] of Object.entries(value)) {
            workspaces[wsKey] = mergeOneAlert(workspaces[wsKey], wsValue);
          }
          continue;
        }
        if (TOP.has(key)) {
          out[key] = value;
          continue;
        }
        // 面板的扁平形态：`{<workspaceKey>: ...}`
        workspaces[key] = mergeOneAlert(workspaces[key], value);
      }
    }
    if (Object.keys(workspaces).length > 0) out.workspaces = workspaces;
    return out;
  }

  /** 单个工作区的一层覆盖：数字/`{limit}` 视为日线；`{day,total}` 各自覆盖。 */
  function mergeOneAlert(prev, value) {
    const base = isPlainObject(prev) ? { day: prev.day ?? null, total: prev.total ?? null } : { day: prev ?? null, total: null };
    if (value === null || value === undefined) return { day: null, total: null };
    if (typeof value === 'number' || typeof value === 'string') return { day: value, total: base.total };
    if (isPlainObject(value)) {
      const next = { ...base };
      if (value.day !== undefined) next.day = value.day;
      else if (value.limit !== undefined) next.day = value.limit;
      if (value.total !== undefined) next.total = value.total;
      return next;
    }
    return base;
  }

  function analysisFor(filePath) {
    let stat;
    try {
      stat = statSync(filePath);
    } catch (error) {
      return { analysis: null, problem: { kind: 'stat-failed', path: filePath, detail: String(error?.message ?? error) } };
    }
    const cached = cache.get(filePath);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && isPlainObject(cached.analysis)) {
      return { analysis: cached.analysis, problem: null, cached: true };
    }
    // 逐文件处理：解码文本与记录对象只在本调用内存在，函数返回时只带出小对象。
    const analysis = analyzeSessionFile(filePath, { workspaceKey: null, parseFilter });
    // 记录扫描时的文件状态，避免写盘后再取 stat 造成缓存永不命中。
    cache.set(filePath, { size: stat.size, mtimeMs: stat.mtimeMs, analysis });
    return { analysis, problem: null, cached: false };
  }

  /**
   * 全量扫描（无窗口过滤），返回每个工作区的会话分析与诊断数字。
   * @returns {{workspaces:object[], gaps:object[], diagnostics:object}}
   */
  function scan() {
    const started = Date.now();
    const { workspaces, gaps, fileStats } = enumerateSessions(sessionsRoot);
    const diagnostics = {
      startedAt: new Date(started).toISOString(),
      elapsedMs: 0,
      sessionsRoot,
      dataDir,
      home,
      workspaceCount: workspaces.length,
      workspacesWithoutLogs: workspaces.filter((ws) => ws.files.length === 0).length,
      sessionFiles: 0,
      // 实际读到的会话日志版本分布（v3/v4/…）与被新版本取代而忽略的旧文件数：
      // 让「插件读的是哪个版本」可被外部反证，而不是只看金额猜。
      sessionFileVersions: fileStats.versions,
      supersededSessionFiles: fileStats.supersededFiles,
      supersededSamples: fileStats.supersededSamples,
      sessionsAnalyzed: 0,
      filesFromCache: 0,
      frameTotal: 0,
      framesDecoded: 0,
      framesFailed: 0,
      rawBytes: 0,
      decodedBytes: 0,
      records: 0,
      recordsSkipped: 0,
      parseFilter,
      usageRecords: 0,
      unpricedUsageRecords: 0,
      exactDuplicateLines: 0,
      typeSeqDuplicates: 0,
      parseErrors: 0,
      jsonlParseFailedFiles: 0,
      dedupeDisagreements: 0,
      usageTokens: 0,
      streamUsageTokens: 0,
      doubleCountInflationTokens: 0,
      modelFromSourceCount: 0,
      modelFromFallbackCount: 0,
      unknownModelCount: 0,
      usageTypeBreakdown: {},
      streamUsageFromOtherFields: 0,
    };
    const scanned = [];
    const unpricedGaps = new Map();
    const { pricing } = getConfig();
    for (const ws of workspaces) {
      const sessions = [];
      for (const file of ws.files) {
        diagnostics.sessionFiles += 1;
        const { analysis, problem, cached } = analysisFor(file.filePath);
        if (problem) {
          gaps.push(problem);
          continue;
        }
        if (cached) diagnostics.filesFromCache += 1;
        else diagnostics.sessionsAnalyzed += 1;
        if (analysis.session === null) {
          gaps.push({ kind: 'session-header-missing', path: file.filePath, detail: '日志里没有 type:"session" 记录，cwd 只能由目录名回退推断' });
        }
        // 未计价记录（版本分段未覆盖）：显式计数 + 登记缺口（约定 2 禁止跨版本回退）
        let unpricedHere = 0;
        const unpricedVersions = new Set();
        for (const row of analysis.usages) {
          const at = row.time ?? analysis.session?.createdAt ?? null;
          if (at === null) continue;
          const priced = priceUsage(row.usage, row.model, at, pricing);
          if (priced.unpriced) {
            unpricedHere += 1;
            unpricedVersions.add(priced.versionId);
          }
        }
        if (unpricedHere > 0) {
          diagnostics.unpricedUsageRecords += unpricedHere;
          unpricedGaps.set(file.filePath, { count: unpricedHere, versions: [...unpricedVersions] });
        }
        diagnostics.frameTotal += analysis.frameTotal;
        diagnostics.framesDecoded += analysis.framesDecoded;
        diagnostics.framesFailed += analysis.framesFailed;
        diagnostics.rawBytes += analysis.rawBytes ?? 0;
        diagnostics.decodedBytes += analysis.decodedBytes;
        diagnostics.records += analysis.recordCount;
        diagnostics.recordsSkipped += analysis.recordsSkipped ?? 0;
        diagnostics.usageRecords += analysis.usageRecordCount;
        diagnostics.exactDuplicateLines += analysis.exactDuplicateLines;
        diagnostics.typeSeqDuplicates += analysis.typeSeqDuplicates;
        diagnostics.parseErrors += analysis.parseErrors;
        if (analysis.parseErrors > 0) diagnostics.jsonlParseFailedFiles += 1;
        if (analysis.dedupeAgreement !== true) diagnostics.dedupeDisagreements += 1;
        diagnostics.usageTokens += analysis.usageTokens;
        diagnostics.streamUsageTokens += analysis.streamUsageTokens;
        diagnostics.modelFromSourceCount += analysis.modelFromSourceCount;
        diagnostics.modelFromFallbackCount += analysis.modelFromFallbackCount;
        diagnostics.unknownModelCount += analysis.unknownModelCount;
        for (const [type, count] of Object.entries(analysis.usageTypeBreakdown ?? {})) {
          diagnostics.usageTypeBreakdown[type] = (diagnostics.usageTypeBreakdown[type] ?? 0) + count;
        }
        for (const problemEntry of analysis.problems ?? []) {
          gaps.push({ kind: problemEntry.kind, path: file.filePath, detail: problemEntry.detail });
        }
        sessions.push({ ...file, analysis });
      }
      scanned.push({ ...ws, sessions });
    }
    diagnostics.doubleCountInflationTokens = diagnostics.streamUsageTokens;
    for (const [filePath, entry] of unpricedGaps) {
      gaps.push({
        kind: 'usage-unpriced',
        path: filePath,
        detail: `${entry.count} 条用量落在版本 ${entry.versions.join(', ')} 的未覆盖时段 → 未计价（金额按 0 计，禁止跨版本回退；可自建版本补全时段）`,
      });
    }
    diagnostics.elapsedMs = Date.now() - started;
    return { workspaces: scanned, gaps, diagnostics };
  }

  /**
   * 汇总视图。
   *
   * `days` 支持两种口径（契约见 docs/SPEC.md §1）：
   *   - 整数 `1..365`：滚动窗口 = 最近 N 个北京日（含今天），`window.from = 今天 −(days−1)`；
   *   - 字面量 `'all'`（常量 `ALL_TIME_DAYS`）：**全量口径** = 从**最早一条可定位日期的
   *     用量记录**所在北京日起，到今天（含）。一条记录都没有时退化为「今天 ~ 今天」的空窗口。
   *
   * 全量口径与滚动口径共用**同一套**过滤/聚合逻辑，只有窗口下界不同 —— 因此
   * `totals`/`daily`/`dailyTotals`/`models`/`peakSplit`/`workspaces[].cost` 的语义完全同构。
   * 显式边界（SPEC §1 已写明）：**无时间戳的用量记录不进任何窗口**（滚动口径本来就如此），
   * 它只体现在 `lifetimeCost` 上；这类记录的条数在 `diagnostics.undatedUsageRecords` 里，
   * 不允许「静默少算」。
   *
   * @param {{days?:number|'all', sessionId?:string}} [query]
   * @returns {object} 冻结的 HTTP 响应体（见 docs/SPEC.md）
   */
  function summary(query = {}) {
    const days = query.days === undefined ? 30 : query.days;
    const allTime = days === ALL_TIME_DAYS;
    if (!allTime && (!Number.isInteger(days) || days < 1 || days > 365)) {
      const error = new Error('days 必须是 1..365 之间的整数或 all（全量口径）');
      error.code = 'INVALID_DAYS';
      throw error;
    }
    const { pricing, alerts, source, problems } = getConfig();
    const { workspaces, gaps, diagnostics } = scan();
    const nowMs = now();
    const today = beijingDateKey(nowMs);
    // 全量口径先用哨兵下界放行全部记录，扫完后再由 earliestDateKey 得出真实窗口起点。
    const from = allTime ? ALL_TIME_FLOOR : addDays(today, -(days - 1));

    const totals = { tokens: ZERO_TOKENS(), cost: 0, idleCost: 0, peakSurcharge: 0 };
    const dailyMap = new Map();
    const modelsMap = new Map();
    let beforeEffectiveFromCount = 0;
    let beforeEffectiveFromCost = 0;
    const effectiveFromMs = Number.isNaN(Date.parse(pricing.effectiveFrom)) ? null : Date.parse(pricing.effectiveFrom);
    const peakBuckets = { peakTokens: 0, idleTokens: 0, peakCost: 0, idleCost: 0, idleEquivalentCost: 0, peakSurcharge: 0 };
    let unpricedUsageRecords = diagnostics.unpricedUsageRecords ?? 0;
    /** 无时间戳、且会话也没有 `createdAt` 兜底的用量记录条数（不进任何窗口，只进 lifetimeCost）。 */
    let undatedUsageRecords = 0;
    /** 全量口径的窗口起点：全部用量记录里最早的北京日（仅统计不晚于今天的记录）。 */
    let earliestDateKey = null;
    let reasoningTokensTotal = 0;
    let costIfReasoningAdded = 0;
    // 口径反证用的分项累计（见 docs/SPEC.md §4.1）
    let reasoningPart = 0;
    let missPartDisjoint = 0;
    let missPartInclusive = 0;
    let sumInputTokens = 0;
    let sumCacheReadTokens = 0;
    let sumMinInputCache = 0;
    let inputGeCacheRecords = 0;
    let inputLtCacheRecords = 0;
    let missBucketZeroedRecords = 0;
    const sessionIndex = new Map();

    const workspaceRows = [];
    for (const ws of workspaces) {
      const cwdFromLog = ws.sessions.find((s) => s.analysis.session?.cwd)?.analysis.session?.cwd ?? null;
      const cwd = cwdFromLog ?? decodeWorkspaceKey(ws.workspaceKey);
      const label = cwd && cwd.trim() !== '' ? cwd.split(/[\\/]/).filter(Boolean).pop() ?? ws.workspaceKey : ws.workspaceKey;

      const tokens = ZERO_TOKENS();
      let cost = 0;
      let todayCost = 0;
      let firstTime = null;
      let lastTime = null;
      let inWindowUsages = 0;
      let lifetimeCost = 0;
      let lifetimeTokens = 0;

      for (const session of ws.sessions) {
        const a = session.analysis;
        sessionIndex.set(session.sessionId, ws.workspaceKey);
        if (typeof a.session?.id === 'string') sessionIndex.set(a.session.id, ws.workspaceKey);
        if (a.firstTime !== null && (firstTime === null || a.firstTime < firstTime)) firstTime = a.firstTime;
        if (a.lastTime !== null && (lastTime === null || a.lastTime > lastTime)) lastTime = a.lastTime;
        for (const row of a.usages) {
          const time = row.time ?? a.session?.createdAt ?? null;
          const priced = priceUsage(row.usage, row.model, time ?? 0, pricing);
          const u = row.usage ?? {};
          reasoningTokensTotal += u.reasoningTokens ?? 0;
          reasoningPart += ((u.reasoningTokens ?? 0) / 1e6) * priced.rates.out;
          missPartDisjoint += ((u.inputTokens ?? 0) / 1e6) * priced.rates.miss;
          missPartInclusive += (Math.max(0, (u.inputTokens ?? 0) - (u.cacheReadTokens ?? 0)) / 1e6) * priced.rates.miss;
          sumInputTokens += u.inputTokens ?? 0;
          sumCacheReadTokens += u.cacheReadTokens ?? 0;
          sumMinInputCache += Math.min(u.inputTokens ?? 0, u.cacheReadTokens ?? 0);
          if ((u.inputTokens ?? 0) >= (u.cacheReadTokens ?? 0)) inputGeCacheRecords += 1;
          else inputLtCacheRecords += 1;
          if (Math.max(0, (u.inputTokens ?? 0) - (u.cacheReadTokens ?? 0)) === 0) missBucketZeroedRecords += 1;
          lifetimeCost += priced.cost;
          lifetimeTokens += row.usage?.totalTokens ?? 0;

          if (time !== null && effectiveFromMs !== null && time < effectiveFromMs) {
            beforeEffectiveFromCount += 1;
            beforeEffectiveFromCost += priced.cost;
          }
          if (time === null) {
            undatedUsageRecords += 1;
            continue;
          }
          const dateKey = beijingDateKey(time);
          // 未来时间戳记录不进窗口（与滚动口径一致；它们已在 gaps 里显式登记），
          // 因此也不作为全量口径的窗口起点。
          if (dateKey > today) continue;
          if (allTime && (earliestDateKey === null || dateKey < earliestDateKey)) earliestDateKey = dateKey;
          if (dateKey < from) continue;

          inWindowUsages += 1;
          addTokens(tokens, row.usage);
          cost += priced.cost;
          peakBuckets.idleEquivalentCost += priced.idleCost;
          peakBuckets.peakSurcharge += priced.peakSurcharge;
          if (priced.peak) {
            peakBuckets.peakTokens += row.usage?.totalTokens ?? 0;
            peakBuckets.peakCost += priced.cost;
          } else {
            peakBuckets.idleTokens += row.usage?.totalTokens ?? 0;
            peakBuckets.idleCost += priced.cost;
          }
          if (dateKey === today) todayCost += priced.cost;

          const bucketKey = `${dateKey}|${ws.workspaceKey}`;
          let bucket = dailyMap.get(bucketKey);
          if (!bucket) {
            bucket = { date: dateKey, workspaceKey: ws.workspaceKey, cost: 0, tokens: ZERO_TOKENS(), sessions: new Set() };
            dailyMap.set(bucketKey, bucket);
          }
          bucket.cost += priced.cost;
          bucket.sessions.add(session.sessionId);
          addTokens(bucket.tokens, row.usage);

          const modelKey = `${row.provider ?? ''}|${row.model ?? '(unknown)'}`;
          let modelRow = modelsMap.get(modelKey);
          if (!modelRow) {
            modelRow = { provider: row.provider ?? null, model: row.model ?? null, tierName: priced.tierName, known: priced.known, cost: 0, tokens: ZERO_TOKENS() };
            modelsMap.set(modelKey, modelRow);
          }
          modelRow.cost += priced.cost;
          addTokens(modelRow.tokens, row.usage);
        }
      }

      // 双预警线：日线比今日花费，总线比该工作区**累计花费**；`level` 取两者更严重的一个。
      const alert = alertLevel({
        todayCost,
        lifetimeCost,
        dayLimit: limitOf(alerts, ws.workspaceKey),
        totalLimit: totalLimitOf(alerts, ws.workspaceKey),
        warnRatio: alerts.warnRatio,
      });
      const { level } = alert;
      addTokens(totals.tokens, tokens);
      totals.cost += cost;

      workspaceRows.push({
        key: ws.workspaceKey,
        workspaceId: ws.workspaceKey,
        label,
        cwd,
        cwdSource: cwdFromLog ? 'session-log' : 'directory-name',
        sessions: ws.sessions.length,
        usageRecords: inWindowUsages,
        firstTime,
        lastTime,
        tokens,
        cost,
        todayCost,
        lifetimeCost,
        lifetimeTokens,
        alert,
      });
    }

    workspaceRows.sort((a, b) => b.cost - a.cost || a.key.localeCompare(b.key));
    totals.idleCost = peakBuckets.idleEquivalentCost;
    totals.peakSurcharge = peakBuckets.peakSurcharge;
    // 口径反证：三种算法在同一份数据上的总费用（见 docs/SPEC.md §4.1 与 probe 报告）
    costIfReasoningAdded = totals.cost + reasoningPart;
    const costIfInputIncludesCacheRead = totals.cost + reasoningPart - missPartDisjoint + missPartInclusive;
    const costIfInputIncludesCacheReadOnly = totals.cost - missPartDisjoint + missPartInclusive;
    const pct = (value) => (totals.cost > 0 ? Number((((value - totals.cost) / totals.cost) * 100).toFixed(2)) : 0);
    const labelByKey = new Map(workspaceRows.map((row) => [row.key, row.label]));
    const daily = [...dailyMap.values()]
      .map((row) => ({
        date: row.date,
        workspaceKey: row.workspaceKey,
        workspaceId: row.workspaceKey,
        label: labelByKey.get(row.workspaceKey) ?? row.workspaceKey,
        sessions: row.sessions.size,
        cost: row.cost,
        tokens: row.tokens,
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.workspaceKey.localeCompare(b.workspaceKey)));
    const dailyTotalsMap = new Map();
    for (const row of daily) {
      let agg = dailyTotalsMap.get(row.date);
      if (!agg) {
        agg = { date: row.date, cost: 0, tokens: ZERO_TOKENS() };
        dailyTotalsMap.set(row.date, agg);
      }
      agg.cost += row.cost;
      addTokens(agg.tokens, row.tokens);
    }

    const currentKey = typeof query.sessionId === 'string' && query.sessionId !== '' ? sessionIndex.get(query.sessionId) ?? null : null;
    const current = currentKey === null ? null : workspaceRows.find((row) => row.key === currentKey) ?? null;
    const usageBill = writeUsageBill(workspaceRows, daily, new Date(nowMs).toISOString());

    const alertSummary = {
      over: workspaceRows.filter((w) => w.alert.level === 'over').length,
      warn: workspaceRows.filter((w) => w.alert.level === 'warn').length,
      ok: workspaceRows.filter((w) => w.alert.level === 'ok').length,
      configured: workspaceRows.filter((w) => w.alert.limit !== null).length,
      worst: workspaceRows
        .filter((w) => w.alert.limit !== null && w.alert.limit > 0)
        .map((w) => ({ key: w.key, label: w.label, todayCost: w.todayCost, limit: w.alert.limit, ratio: w.todayCost / w.alert.limit, level: w.alert.level }))
        .sort((a, b) => b.ratio - a.ratio)
        .slice(0, 5),
    };

    // 全量口径的窗口起点 = 最早一条可定位日期的用量记录所在北京日；无记录时退化为「今天 ~ 今天」。
    const windowFrom = allTime ? earliestDateKey ?? today : from;

    return {
      ok: true,
      generatedAt: new Date(nowMs).toISOString(),
      // 回显请求口径：整数（滚动 N 天）或 `'all'`（全量）。见 docs/SPEC.md §1。
      days,
      window: { from: windowFrom, to: today, timezone: 'Asia/Shanghai', timezoneOffsetMinutes: 480 },
      today: { date: today, cost: dailyTotalsMap.get(today)?.cost ?? 0, tokens: dailyTotalsMap.get(today)?.tokens ?? ZERO_TOKENS() },
      totals,
      peakSplit: { peak: { tokens: peakBuckets.peakTokens, cost: peakBuckets.peakCost }, idle: { tokens: peakBuckets.idleTokens, cost: peakBuckets.idleCost } },
      workspaces: workspaceRows,
      daily,
      current,
      currentSessionId: typeof query.sessionId === 'string' && query.sessionId !== '' ? query.sessionId : null,
      dailyTotals: [...dailyTotalsMap.values()].sort((a, b) => a.date.localeCompare(b.date)),
      models: [...modelsMap.values()].sort((a, b) => b.cost - a.cost),
      alerts: alertSummary,
      currency: pricing.currency,
      pricing: {
        effectiveFrom: pricing.effectiveFrom,
        currency: pricing.currency,
        peakMultiplier: pricing.peakMultiplier,
        reasoningIncludedInOutput: pricing.reasoningIncludedInOutput,
        inputIncludesCacheRead: pricing.inputIncludesCacheRead,
        rates: ratesTable(pricing),
        timezone: 'Asia/Shanghai',
        peakWindows: (pricing.peakWindows ?? []).map((window) => `${window.days.join('/')} ${window.from}-${window.to}`),
        peakWindowsDetail: pricing.peakWindows,
        tiers: pricingTableRows(pricing),
        families: pricing.families,
        models: pricing.models,
        fallbackTier: pricing.fallbackFamily,
        activeVersionId: activeVersionId(pricing, nowMs),
        versions: versionsForClient(pricing),
      },
      diagnostics: {
        ...diagnostics,
        filesFromCacheNow: diagnostics.filesFromCache,
        doubleCountInflationTokens: diagnostics.streamUsageTokens,
        doubleCountInflationPercent: diagnostics.usageTokens > 0 ? Number(((diagnostics.streamUsageTokens / diagnostics.usageTokens) * 100).toFixed(2)) : 0,
        beforeEffectiveFromCount,
        beforeEffectiveFromCost,
        unpricedUsageRecords,
        // 无时间戳（且无 createdAt 兜底）的用量记录：滚动与全量口径**都不计入窗口**，
        // 只体现在 lifetimeCost 上。显式计数，避免「全量口径为什么比累计少一点」变成静默差异。
        undatedUsageRecords,
        reasoningTokensTotal,
        // ⚠️ 以下是一组**反事实（counterfactual）**数字：**不是**账单口径，只是把
        // 「若按某种错误口径计算会是多少」摆出来，让口径正确性可被反证。
        // 权威账单是 `totals.cost`；它们被额外归到 `counterfactual` 命名空间下，
        // 以免被误当成「本实现的费用」。
        costIfReasoningAdded,
        costIfReasoningAddedDelta: costIfReasoningAdded - totals.cost,
        costIfReasoningAddedPercent: pct(costIfReasoningAdded),
        counterfactual: {
          billedCost: totals.cost,
          reasoningAddedCost: costIfReasoningAdded,
          reasoningAddedDelta: costIfReasoningAdded - totals.cost,
          reasoningAddedPercent: pct(costIfReasoningAdded),
          inputIncludesCacheReadCost: costIfInputIncludesCacheRead,
          inputIncludesCacheReadPercent: pct(costIfInputIncludesCacheRead),
          inputIncludesCacheReadOnlyCost: costIfInputIncludesCacheReadOnly,
          inputIncludesCacheReadOnlyPercent: pct(costIfInputIncludesCacheReadOnly),
          note: '这些数字是按错误口径重算的反事实值，用于自证；账单以 billedCost（= totals.cost）为准',
        },
        bucketRefutation: {
          inputGeCacheRecords,
          inputLtCacheRecords,
          inputLtCachePercent: inputGeCacheRecords + inputLtCacheRecords > 0 ? Number(((inputLtCacheRecords / (inputGeCacheRecords + inputLtCacheRecords)) * 100).toFixed(2)) : 0,
          sumInputTokens,
          sumCacheReadTokens,
          sumMinInputCache,
          missBucketZeroedRecords,
          missBucketZeroedPercent: inputGeCacheRecords + inputLtCacheRecords > 0 ? Number(((missBucketZeroedRecords / (inputGeCacheRecords + inputLtCacheRecords)) * 100).toFixed(2)) : 0,
          missPartDisjoint,
          missPartInclusive,
          costIfInputIncludesCacheRead,
          costIfInputIncludesCacheReadPercent: pct(costIfInputIncludesCacheRead),
          costIfInputIncludesCacheReadOnly,
          costIfInputIncludesCacheReadOnlyPercent: pct(costIfInputIncludesCacheReadOnly),
        },
        configProblems: problems,
        configSource: source,
        usageBill,
        workspacesWithData: workspaceRows.filter((w) => w.tokens.totalTokens > 0).length,
      },
      gaps,
    };
  }

  /** 强制重建缓存（清空内存 + 磁盘，并重新全量扫描）。 */
  function refresh() {
    cache.clear();
    if (persistCache) {
      try {
        mkdirSync(dataDir, { recursive: true });
        writeFileSync(cachePath, JSON.stringify({ version: CACHE_VERSION, savedAt: Date.now(), files: {} }), 'utf8');
      } catch (error) {
        log('warn', `重置账本缓存 ${cachePath} 失败（继续在内存里重建）`, error);
      }
    }
    const started = Date.now();
    const result = summary({ days: 30 });
    return {
      ok: true,
      rebuiltAt: new Date(now()).toISOString(),
      elapsedMs: Date.now() - started,
      filesFromCache: 0,
      sessionFiles: result.diagnostics.sessionFiles,
      usageRecords: result.diagnostics.usageRecords,
      problems: result.diagnostics.configProblems,
    };
  }

  /**
   * 写入配置覆盖（价格表 / 预警线）。
   * 有 settings 服务时写 settings 命名空间，否则写 `<dataDir>/config.json`；
   * 两种情况下都保留 config.json 作为兜底，保证「没有设置服务时也能改」。
   * @param {{pricing?:object, alerts?:object}} patch
   */
  async function setConfig(patch) {
    if (!isPlainObject(patch)) {
      const error = new Error('请求体必须是 JSON 对象');
      error.code = 'INVALID_BODY';
      throw error;
    }
    const problems = [];
    const warnings = [];
    let nextFileConfig = patch.reset === true ? {} : { ...fileConfig };
    let settingsPricingOverride = patch.pricing;
    if (patch.reset !== true && patch.pricing !== undefined) {
      const incoming = patch.pricing;
      if (!isPlainObject(incoming)) {
        problems.push('pricing 必须是对象');
      } else if (incoming.versions !== undefined) {
        // 约定 5：历史版本不可修改/删除（只允许 append）
        const error = new Error('历史价格版本不可修改或删除（只允许 pricing.append 追加新版本）');
        error.code = 'HISTORY_IMMUTABLE';
        throw error;
      } else if (incoming.append !== undefined) {
        if (!isPlainObject(incoming.append)) {
          problems.push('pricing.append 必须是对象');
        } else {
          const current = getConfig().pricing;
          const appended = appendVersion(current, incoming.append);
          problems.push(...appended.problems);
          warnings.push(...appended.warnings);
          if (appended.problems.length === 0 && appended.version !== null) {
            // 追加成功后，把**解析后的整表**同时写进 config.json 与 settings 用户段，
            // 保证「哪一层生效、价格从哪来」都是显式的、不依赖继承。
            const plain = toPlainPricing(appended.pricing);
            nextFileConfig.pricing = plain;
            settingsPricingOverride = plain;
          }
        }
      } else {
        const merged = mergePricingLayers([fileConfig.pricing, incoming]);
        const pricingProblems = normalizePricing(merged).problems;
        problems.push(...pricingProblems);
        if (pricingProblems.length === 0 && Object.keys(merged).length > 0) nextFileConfig.pricing = merged;
      }
    }
    if (patch.reset !== true && patch.alerts !== undefined) {
      const merged = mergeAlertsLayers([fileConfig.alerts, patch.alerts]);
      const alertsProblems = normalizeAlerts(merged).problems;
      problems.push(...alertsProblems);
      if (alertsProblems.length === 0) nextFileConfig.alerts = merged;
    }
    if (problems.length > 0) {
      const error = new Error(problems.join('; '));
      error.code = 'INVALID_CONFIG';
      error.problems = problems;
      throw error;
    }
    fileConfig = nextFileConfig;
    try {
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(configPath, JSON.stringify(fileConfig, null, 2), 'utf8');
    } catch (error) {
      log('warn', `写配置文件 ${configPath} 失败（本次修改仅对 settings 层生效）`, error);
    }
    let settingsWritten = false;
    if (settingsSource?.update) {
      try {
        if (patch.reset === true) {
          if (typeof settingsSource.replace === 'function') await settingsSource.replace({});
        } else {
          const settingsPatch = {};
          if (settingsPricingOverride !== undefined) settingsPatch.pricing = settingsPricingOverride;
          if (patch.alerts !== undefined) settingsPatch.alerts = patch.alerts;
          if (Object.keys(settingsPatch).length > 0) await settingsSource.update(settingsPatch);
        }
        settingsWritten = true;
      } catch (error) {
        log('warn', '写入 dsh-workspace-fee 设置失败', error);
      }
    }
    return { ...getConfig(), settingsWritten, configPath, warnings };
  }

  /**
   * 供「按段核对单价」使用的视图：生效版本 id、每个版本的段绝对值、覆盖率、未计价条数。
   * 让验证者可以用**一条命令**独立核对单价来源（见 scripts/report.mjs --segments）。
   */
  function pricingView() {
    const { pricing, source } = getConfig();
    const scanResult = scan();
    return {
      currency: pricing.currency,
      activeVersionId: activeVersionId(pricing, now()),
      source,
      rates: ratesTable(pricing),
      versions: versionsForClient(pricing).map((version) => ({
        id: version.id,
        effectiveFrom: version.effectiveFrom,
        note: version.note,
        builtin: version.builtin,
        models: version.models,
      })),
      unpricedUsageRecords: scanResult.diagnostics.unpricedUsageRecords,
    };
  }

  /**
   * 预演一次版本追加（`strict: true` 时路由层先拿它判 400）。
   * @param {object} append `pricing.append` 的请求体
   */
  function previewAppend(append) {
    const appended = appendVersion(getConfig().pricing, append);
    return { problems: appended.problems, warnings: appended.warnings, coverageHoles: appended.coverageHoles, version: appended.version };
  }

  /** 由 lib/index.js 在有 settings 服务时注入的动态来源。 */
  function bindSettings(source) {
    settingsSource = source;
  }

  /**
   * 把「按日账单」以 JSONL 落盘到 `usageDir`（默认 `<home>/dsh-usage`），
   * 供外部消费者（脚本、记账工具）直接读取，无需走 HTTP。
   *
   * 产物（**每次 summary/refresh 覆盖写**，内容幂等）：
   *   <usageDir>/<工作区目录名>.jsonl  每行一条 `{type:'workspace-day', …}`
   *   <usageDir>/summary.jsonl          每行一条 `{type:'day', …}`（全工作区按日合计）
   *
   * 写失败只告警（沙箱/权限），绝不影响账目正确性；结果计入
   * `diagnostics.usageBill = {dir, filesWritten, lines, error}`。
   */
  function writeUsageBill(workspaceRows, dateRows, generatedAt) {
    const result = { dir: usageDir, filesWritten: 0, lines: 0, error: null };
    try {
      mkdirSync(usageDir, { recursive: true });
      for (const row of workspaceRows) {
        const lines = dateRows
          .filter((entry) => entry.workspaceKey === row.key)
          .sort((a, b) => a.date.localeCompare(b.date))
          .map((entry) =>
            JSON.stringify({
              type: 'workspace-day',
              date: entry.date,
              workspaceKey: row.key,
              workspaceId: row.key,
              label: row.label,
              cwd: row.cwd,
              cost: entry.cost,
              currency: 'CNY',
              tokens: entry.tokens,
              sessions: entry.sessions,
              generatedAt,
            }),
          );
        writeFileSync(join(usageDir, `${row.key}.jsonl`), lines.length > 0 ? `${lines.join('\n')}\n` : '', 'utf8');
        result.filesWritten += 1;
        result.lines += lines.length;
      }
      const summaryLines = dateRows
        .slice()
        .sort((a, b) => a.date.localeCompare(b.date))
        .map((entry) => JSON.stringify({ type: 'day', date: entry.date, cost: entry.cost, currency: 'CNY', tokens: entry.tokens, generatedAt }));
      writeFileSync(join(usageDir, 'summary.jsonl'), summaryLines.length > 0 ? `${summaryLines.join('\n')}\n` : '', 'utf8');
      result.filesWritten += 1;
      result.lines += summaryLines.length;
    } catch (error) {
      result.error = String(error?.message ?? error);
      log('warn', `写按日 JSONL 账单到 ${usageDir} 失败（不影响账目）`, error);
    }
    return result;
  }

  return {
    paths: { home, sessionsRoot, dataDir, usageDir },
    getConfig,
    setConfig,
    previewAppend,
    pricingView,
    bindSettings,
    summary,
    refresh,
    scan,
    saveCacheToDisk,
    _internal: { cache, mergePricingLayers },
  };
}

export { beijingDateKey, beijingDateTime, DAY_MS };
