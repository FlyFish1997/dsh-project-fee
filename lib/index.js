/**
 * dsh-workspace-fee —— 宿主侧插件入口（cordis plugin）
 * ---------------------------------------------------------------------------
 * 形状与 DSH 内置插件一致：具名导出 `name` / `inject` / `apply`，**不 import
 * 任何 `@deepseek-ai/*` 包**，因此本包可以被放进任意 profile 而无需先装依赖。
 *
 * 职责：
 *   1. 建立账本（lib/ledger.js），并注册 `dsh-workspace-fee` 设置命名空间
 *      （`ctx.settings` 存在时；不存在则退化为 `<dataDir>/config.json`）；
 *   2. 通过 `ctx.webServer.register` 注册四个精确路由（lib/routes.js）；
 *   3. 定时把解析缓存落盘（失败只告警，不影响账目）。
 *
 * 组合配置（插件行 `config`，全部可选）：
 *   home         字符串  显式指定 DSH home（优先于 $DSH_HOME）
 *   sessionsRoot 字符串  会话日志根（优先于 $DSH_WORKSPACE_FEE_SESSIONS）
 *   dataDir      字符串  账本数据目录（优先于 $DSH_WORKSPACE_FEE_DATA）
 *   pricing      对象    价格表覆盖（最低优先级层）
 *   alerts       对象    预警线覆盖（最低优先级层）
 *   persistCache 布尔    是否把解析缓存写盘（默认 true）
 *   flushSeconds 数字    缓存落盘间隔秒数（默认 60，0 表示不定时落盘）
 */
import { createLedger, DEFAULT_ALERTS, SETTINGS_NAMESPACE, resolveDshHome } from './ledger.js';
import { profileCandidates, registerSessionSurfaces } from './host-tools.js';
import { DEFAULT_PRICING } from './pricing.js';
import { ROUTE_PATHS, createRouteTable } from './routes.js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** 插件名（cordis 行 `name` 使用包名，这里给出同样的标识）。 */
export const name = 'dsh-workspace-fee';

/** 只依赖 webServer；tools / commands 是**可选**服务，用 ctx.inject 子插件方式接入。 */
export const inject = ['webServer'];

/** 用于诊断，便于确认「盘上的代码是哪一版」。 */
const PLUGIN_VERSION = '0.2.0+surfaces-diagnostic';

/**
 * 把会话调用面的装配结果写到数据目录。
 *
 * 为什么需要：DSH 的日志只打到启动它的终端、**不落盘**，于是「工具/命令到底注册上没有」
 * 从外部无法查证 —— 这正是本次排障卡住的地方。写一份到盘上，任何人（包括排障者）
 * 都能直接读到装配事实，而不必依赖复述终端输出。
 *
 * 失败绝不影响插件：诊断本身是尽力而为。
 *
 * @param {string} dataDir 插件数据目录
 * @param {{tool:boolean, command:boolean, problems:string[]}} surfaces
 * @param {string} stage started | assembled | threw
 */
function writeSurfaceDiagnostic(dataDir, surfaces, stage) {
  if (typeof dataDir !== 'string' || dataDir === '') return;
  try {
    mkdirSync(dataDir, { recursive: true });
    const payload = {
      at: new Date().toISOString(),
      stage,
      pluginVersion: PLUGIN_VERSION,
      inject: inject.slice(),
      requestedServices: ['tools', 'commands'],
      tool: surfaces.tool === true,
      command: surfaces.command === true,
      problems: surfaces.problems ?? [],
      ...(surfaces.stack ? { stack: surfaces.stack } : {}),
      hint:
        stage === 'started'
          ? '仅表示 apply 已进入；assembled 才是最终结果'
          : surfaces.tool && surfaces.command
            ? '两个面都已注册'
            : '见 problems：注册未完成（这会让模型工具与 /fee 都不可用）',
    };
    writeFileSync(join(dataDir, 'surfaces.json'), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  } catch {
    // 诊断写入失败不影响插件运行
  }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 校验插件行配置。非法类型直接抛出（装配期失败要看得见），
 * 非法**值**留给 normalizePricing/normalizeAlerts 记入 problems。
 * @param {unknown} config
 */
export function validatePluginConfig(config) {
  if (config === undefined || config === null) return {};
  if (!isPlainObject(config)) throw new TypeError('dsh-workspace-fee 的插件配置必须是对象');
  for (const key of ['home', 'sessionsRoot', 'dataDir']) {
    if (config[key] !== undefined && (typeof config[key] !== 'string' || config[key].trim() === '')) {
      throw new TypeError(`dsh-workspace-fee 配置项 ${key} 必须是非空字符串`);
    }
  }
  for (const key of ['pricing', 'alerts']) {
    if (config[key] !== undefined && !isPlainObject(config[key])) {
      throw new TypeError(`dsh-workspace-fee 配置项 ${key} 必须是对象`);
    }
  }
  if (config.persistCache !== undefined && typeof config.persistCache !== 'boolean') {
    throw new TypeError('dsh-workspace-fee 配置项 persistCache 必须是布尔值');
  }
  if (config.flushSeconds !== undefined && (typeof config.flushSeconds !== 'number' || !Number.isFinite(config.flushSeconds) || config.flushSeconds < 0)) {
    throw new TypeError('dsh-workspace-fee 配置项 flushSeconds 必须是非负有限数字');
  }
  return config;
}

/**
 * 构造 settings 命名空间 schema。
 *
 * dsh-settings 的 `register(ns, schema, …)` 只要求 schema 是**可调用**的解析器
 * （`schema(mergeLayers(base, 用户段)) → resolved`），并在 `describe()` 里调用
 * `.toJSON()`、在 `redactSecrets()` 里读取 `.type`。因此这里给出一个
 * 「函数 + toJSON」的精简 schema，既满足契约，又不需要引入 schemastery。
 *
 * schema **只回放真正给出的键**（原样克隆，不归一化）：归一化留给 lib/pricing.js
 * 与 lib/ledger.js，这样 `source.pricing` 才能如实反映「哪一层真正生效」，
 * 非法值也会在账本层被显式记入 problems。
 * @returns {Function & {toJSON: () => object}}
 */
export function createSettingsSchema() {
  const schema = (value) => {
    const raw = isPlainObject(value) ? value : {};
    const out = {};
    if (isPlainObject(raw.pricing) && Object.keys(raw.pricing).length > 0) out.pricing = cloneJson(raw.pricing);
    if (isPlainObject(raw.alerts) && Object.keys(raw.alerts).length > 0) out.alerts = cloneJson(raw.alerts);
    return out;
  };
  schema.toJSON = () => ({
    type: 'object',
    description: 'dsh-workspace-fee：价格表覆盖（pricing）与每工作区日预警线（alerts）',
  });
  return schema;
}

/** 只做 JSON 兼容的深拷贝（settings 层已拒绝非 JSON 数据）。 */
function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/** 组合配置的 base 层（settings 未覆盖时的取值）。 */
export function composedBase(config) {
  return {
    pricing: isPlainObject(config?.pricing) ? config.pricing : {},
    alerts: isPlainObject(config?.alerts) ? config.alerts : {},
  };
}

/**
 * 尝试绑定 settings 命名空间；失败只告警，返回 null。
 * @param {object} ctx cordis 上下文
 * @param {object} ledger
 * @param {object} base 组合配置的 base 层（来自插件行 config）
 * @param {(level:string,message:string,detail?:unknown)=>void} log
 * @returns {{scope:object|null, available:boolean}}
 */
export function bindSettings(ctx, ledger, base, log) {
  try {
    const settings = ctx?.settings;
    if (!settings || typeof settings.register !== 'function') return { scope: null, available: false };
    const scope = settings.register(SETTINGS_NAMESPACE, createSettingsSchema(), { base });
    ledger.bindSettings({
      get: () => scope.get(),
      update: (patch) => scope.update(patch),
      replace: (section) => scope.replace(section),
    });
    return { scope, available: true };
  } catch (error) {
    log('warn', `注册 ${SETTINGS_NAMESPACE} 设置命名空间失败，改用配置文件`, error);
    return { scope: null, available: false };
  }
}

/**
 * cordis 插件主体。
 * @param {object} ctx
 * @param {object} [config]
 */
export function apply(ctx, config) {
  const normalizedConfig = validatePluginConfig(config);
  const log = (level, message, detail) => {
    const text = detail === undefined ? `[dsh-workspace-fee] ${message}` : `[dsh-workspace-fee] ${message}`;
    try {
      if (level === 'warn') {
        if (typeof ctx?.logger?.warn === 'function') ctx.logger.warn(text, detail);
        else if (typeof console?.warn === 'function') console.warn(text, detail ?? '');
      } else if (typeof ctx?.logger?.info === 'function') ctx.logger.info(text, detail);
      else if (typeof console?.log === 'function') console.log(text, detail ?? '');
    } catch {
      // 日志本身就是尽力而为；绝不让日志失败影响账目。
    }
  };

  const ledger = createLedger({
    home: normalizedConfig.home,
    sessionsRoot: normalizedConfig.sessionsRoot,
    dataDir: normalizedConfig.dataDir,
    pricing: normalizedConfig.pricing,
    alerts: normalizedConfig.alerts,
    persistCache: normalizedConfig.persistCache,
    logger: log,
  });

  const settingsBinding = bindSettings(ctx, ledger, composedBase(normalizedConfig), log);
  if (!settingsBinding.available) log('info', 'settings 服务不可用，价格表/预警线将存放在 config.json');

  ctx.effect(() => {
    const routes = createRouteTable({ ledger, logger: log });
    const disposers = routes.map((route) => ctx.webServer.register(route));
    return () => {
      for (const dispose of disposers.reverse()) {
        try {
          dispose();
        } catch (error) {
          log('warn', '注销路由失败', error);
        }
      }
    };
  }, `dsh-workspace-fee: ${Object.keys(ROUTE_PATHS).length} routes`);

  const flushSeconds = normalizedConfig.flushSeconds ?? 60;
  if (normalizedConfig.persistCache !== false && flushSeconds > 0) {
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          ledger.saveCacheToDisk();
        } catch (error) {
          log('warn', '定时落盘解析缓存失败', error);
        }
      }, flushSeconds * 1000);
      if (typeof timer.unref === 'function') timer.unref();
      return () => clearInterval(timer);
    }, `dsh-workspace-fee: cache flush every ${flushSeconds}s`);
  }

  // ── 会话可调用面：模型工具 `workspace_fee` + 斜杠命令 `/fee` ──────────────
  //
  // 关键：这两个面需要 `tools` / `commands` 服务，但它们**不在**本插件的 `inject` 里。
  // 原因：cordis 的 `inject` 是**硬依赖** —— 写进去就等于「服务不在就不加载插件」，
  // 那会让核心的账目与状态栏一起失效。
  //
  // 正确写法是 `ctx.inject([...], cb)`：它把 cb 注册成**子插件**，只在那些服务出现时启动；
  // 服务缺失时子插件根本不跑，核心功能不受影响。这就是 cordis 里「可选能力」的写法。
  //
  // 实测教训：早前直接在 apply 里读 `ctx.tools` / `ctx.commands`（而插件只 inject 了
  // webServer）→ 两个面**静默跳过**，用户看到的是「工具清单里没有这个插件、/fee 也不存在」。
  const sessionSurfaces = { tool: false, command: false, problems: [] };
  let surfacesPromise = Promise.resolve(null);
  if (typeof ctx.inject !== 'function') {
    sessionSurfaces.problems.push('当前 cordis 上下文没有 ctx.inject —— 无法注册可选服务子插件，会话调用面不可用');
    log('warn', '当前 cordis 上下文没有 ctx.inject，会话调用面不可用');
  } else {
    // ⚠️ 子插件的 apply **绝不能返回普通对象**。
    //
    // cordis 会把 apply 的返回值（以及 Promise 的解析结果）**按 effect 规则校验**：
    // 只接受 函数 / null / 可迭代 / 有 then 的对象；普通对象会抛 `Invalid effect`。
    // 实测踩过：这里 `return registerSessionSurfaces(...)` 返回 `{tool,command,problems}`，
    // 于是整个子插件启动失败 —— 模型工具与 /fee **双双消失**，而诊断里只有一句
    // 「Invalid effect」，不看堆栈根本定位不到。
    //
    // 因此：回调用**副作用**回报结果，返回值保持 undefined。
    let reportSurfaces = () => {};
    const surfacesReported = new Promise((resolve) => {
      reportSurfaces = resolve;
    });
    ctx.inject(['tools', 'commands'], (scoped) => {
      // 刻意不 return：apply 的返回值会被当成 effect
      registerSessionSurfaces(scoped, {
        getSummary: ({ days, sessionId }) => ledger.summary(sessionId ? { days, sessionId } : { days }),
        // 解析根：DSH 的包在 profile 的 node_modules 里，而本插件目录刻意没有 node_modules
        resolveRoots: [
          ...profileCandidates(normalizedConfig.home ?? resolveDshHome()),
          normalizedConfig.home,
          ledger.paths?.dataDir,
        ].filter((x) => typeof x === 'string' && x !== ''),
        warn: (message) => log('warn', message),
      }).then(reportSurfaces, (error) => reportSurfaces({ tool: false, command: false, problems: [String(error?.message ?? error)] }));
      return undefined;
    });
    surfacesPromise = surfacesReported
      .catch(() => null)
      .then((result) => {
        sessionSurfaces.tool = result?.tool === true;
        sessionSurfaces.command = result?.command === true;
        sessionSurfaces.problems = result?.problems ?? [];
        writeSurfaceDiagnostic(ledger.paths?.dataDir, sessionSurfaces, 'assembled');
        log('info', `会话调用面：模型工具 ${sessionSurfaces.tool ? '已注册' : '未注册'}；斜杠命令 ${sessionSurfaces.command ? '已注册' : '未注册'}`);
        return result;
      })
      .catch((error) => {
        sessionSurfaces.problems = [`会话调用面注册失败：${error?.message ?? error}`];
        sessionSurfaces.stack = String(error?.stack ?? error ?? '').split('\n').slice(0, 12).join('\n');
        writeSurfaceDiagnostic(ledger.paths?.dataDir, sessionSurfaces, 'threw');
        log('warn', '会话调用面注册失败', error);
        return { tool: false, command: false, problems: sessionSurfaces.problems };
      });
  }
  writeSurfaceDiagnostic(ledger.paths?.dataDir, sessionSurfaces, 'started');

  log('info', `已挂载：路由 ${Object.values(ROUTE_PATHS).join(' , ')}；数据目录 ${ledger.paths.dataDir}`);
  return {
    ledger,
    settingsScope: settingsBinding.scope,
    routes: ROUTE_PATHS,
    defaults: { pricing: DEFAULT_PRICING, alerts: DEFAULT_ALERTS },
    sessionSurfaces,
    surfacesPromise,
  };
}

export { ROUTE_PATHS, SETTINGS_NAMESPACE };
