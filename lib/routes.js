/**
 * HTTP 路由（routes）
 * ---------------------------------------------------------------------------
 * 冻结契约见 docs/SPEC.md。四个端点：
 *   GET  /api/dsh-workspace-fee/summary?days=N|all
 *   GET  /api/dsh-workspace-fee/config
 *   POST /api/dsh-workspace-fee/config
 *   POST /api/dsh-workspace-fee/refresh
 *   GET  /api/dsh-workspace-fee/health   （附加，非契约）
 *
 * 响应纪律：
 *   - 无效入参一律 400 + `{ok:false,error}`；
 *   - 未预期异常一律 500 + `{ok:false,error}`，**绝不静默返回空数组**；
 *   - 方法不匹配 405 + `{ok:false,error}`，并在 `Allow` 头里列出允许的方法。
 */
import { ALL_TIME_DAYS, ROUTE_PREFIX, alertsForClient } from './ledger.js';
import { activeVersionId, pricingTableRows, versionsForClient } from './pricing.js';

/** 端点路径（client 侧依赖，变更须走 docs/SPEC.md 修订）。 */
export const ROUTE_PATHS = Object.freeze({
  summary: `${ROUTE_PREFIX}/summary`,
  config: `${ROUTE_PREFIX}/config`,
  refresh: `${ROUTE_PREFIX}/refresh`,
  health: `${ROUTE_PREFIX}/health`,
});

/**
 * 浏览器面板读取的 `/config` 顶层形态（约定 5 冻结）：
 * **顶层就是契约对象本身**（不套两层）——`alerts` / `currency` / `pricing` /
 * `source` / `problems` / `diagnostics`，同时再套一份完整对象到 `config` 里作为规范形态。
 * @param {object} config `ledger.getConfig()` 的结果
 * @param {object} [extra] 额外诊断（例如 `{unpricedUsageRecords}`）
 */
export function clientConfigView(config, extra = {}) {
  const { pricing, alerts } = config;
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    currency: pricing.currency,
    alerts: alertsForClient(alerts),
    alertDefaults: { defaultLimit: alerts.defaultLimit, warnRatio: alerts.warnRatio },
    pricing: {
      activeVersionId: activeVersionId(pricing, Date.now()),
      currency: pricing.currency,
      effectiveFrom: pricing.effectiveFrom,
      peakMultiplier: pricing.peakMultiplier,
      fallbackTier: pricing.fallbackFamily,
      models: pricing.models,
      families: pricing.families,
      /** @deprecated 便捷视图；权威模型是 `versions[].models[family].segments` */
      tiers: pricingTableRows(pricing),
      versions: versionsForClient(pricing),
    },
    source: config.source,
    problems: config.problems,
    diagnostics: { unpricedUsageRecords: null, ...extra },
    config: { pricing, alerts },
  };
}

/** 请求体上限（config 写入的体积上限，防止无界读取）。 */
export const MAX_BODY_BYTES = 256 * 1024;

/** 安全 JSON 响应。 */
export function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('content-length', String(body.length));
  res.setHeader('cache-control', 'no-store');
  res.end(body);
}

function sendError(res, status, error, extra = undefined) {
  sendJson(res, status, { ok: false, error: String(error), ...(extra === undefined ? {} : { details: extra }) });
}

function sendMethodNotAllowed(res, allowed) {
  res.setHeader('allow', allowed.join(', '));
  sendError(res, 405, `方法不允许，仅支持 ${allowed.join('/')}`);
}

function parseUrl(req) {
  return new URL(typeof req.url === 'string' && req.url !== '' ? req.url : '/', 'http://localhost');
}

/**
 * 读取并解析 JSON 请求体。
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<{ok:true,value:unknown}|{ok:false,error:string}>}
 */
export function readJsonBody(req, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolvePromise) => {
    const essence = String(req.headers['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
    if (essence !== '' && essence !== 'application/json') {
      resolvePromise({ ok: false, error: 'content-type 必须是 application/json' });
      return;
    }
    const chunks = [];
    let size = 0;
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolvePromise(result);
    };
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        finish({ ok: false, error: `请求体超过 ${maxBytes} 字节上限` });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => finish({ ok: false, error: `读取请求体失败：${error?.message ?? error}` }));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (text === '') {
        finish({ ok: true, value: {} });
        return;
      }
      try {
        finish({ ok: true, value: JSON.parse(text) });
      } catch (error) {
        finish({ ok: false, error: `请求体不是合法 JSON：${error?.message ?? error}` });
      }
    });
  });
}

/**
 * 解析 `days` 查询参数（契约见 docs/SPEC.md §1）。
 *
 * 接受两种口径：
 *   - 整数 `1..365`：滚动窗口 = 最近 N 个北京日（含今天）；
 *   - 字面量 `all`（大小写不敏感、忽略首尾空白）：**全量口径**，回显仍是 `'all'`。
 *
 * 其余一律 400（含 `0` / `-1` / `366` / `1.5` / `1e3` / `allx`）——
 * 「全量」是**显式字面量**，不是「任意非数字都能当全量」。
 *
 * @param {string|null} raw
 * @returns {{ok:true,days:number|'all'}|{ok:false,error:string}}
 */
export function parseDays(raw) {
  if (raw === null || raw === undefined || raw === '') return { ok: true, days: 30 };
  const text = String(raw).trim();
  if (text.toLowerCase() === ALL_TIME_DAYS) return { ok: true, days: ALL_TIME_DAYS };
  if (!/^-?\d+$/.test(text)) return { ok: false, error: 'days 必须是 1..365 之间的整数或 all（全量口径）' };
  const days = Number.parseInt(text, 10);
  if (!Number.isInteger(days) || days < 1 || days > 365) return { ok: false, error: 'days 必须是 1..365 之间的整数或 all（全量口径）' };
  return { ok: true, days };
}

/**
 * 构造路由表。
 * @param {{ledger:object, logger?:(level:string,message:string)=>void}} options
 * @returns {Array<{kind:'exact', path:string, handler:Function}>}
 */
export function createRouteTable({ ledger, logger }) {
  const log = typeof logger === 'function' ? logger : () => {};

  const guard = (allowed, label, run) => async (req, res) => {
    const method = (req.method ?? 'GET').toUpperCase();
    if (!allowed.includes(method)) {
      sendMethodNotAllowed(res, allowed);
      return;
    }
    try {
      await run(req, res, parseUrl(req));
    } catch (error) {
      log('warn', `${label} 处理失败：${error?.stack ?? error}`);
      if (!res.headersSent) sendError(res, 500, `内部错误：${error?.message ?? error}`);
      else res.end();
    }
  };

  const summaryRoute = {
    kind: 'exact',
    path: ROUTE_PATHS.summary,
    handler: guard(['GET'], `GET ${ROUTE_PATHS.summary}`, async (req, res, url) => {
      const parsed = parseDays(url.searchParams.get('days'));
      if (!parsed.ok) {
        sendError(res, 400, parsed.error);
        return;
      }
      const sessionId = url.searchParams.get('sessionId');
      const summary = ledger.summary({ days: parsed.days, sessionId: sessionId ?? undefined });
      sendJson(res, 200, summary);
    }),
  };

  const configRoute = {
    kind: 'exact',
    path: ROUTE_PATHS.config,
    handler: guard(['GET', 'POST'], `${ROUTE_PATHS.config}`, async (req, res) => {
      const method = (req.method ?? 'GET').toUpperCase();
      if (method === 'GET') {
        // 让 /config 也能给出 unpricedUsageRecords：scan() 在缓存热时约 40 ms，冷时即全量扫
        let unpricedUsageRecords = null;
        try {
          unpricedUsageRecords = ledger.scan().diagnostics.unpricedUsageRecords;
        } catch {
          unpricedUsageRecords = null;
        }
        const view = clientConfigView(ledger.getConfig(), { unpricedUsageRecords });
        sendJson(res, 200, { ...view, paths: ledger.paths });
        return;
      }
      const body = await readJsonBody(req);
      if (!body.ok) {
        sendError(res, 400, body.error);
        return;
      }
      if (typeof body.value !== 'object' || body.value === null || Array.isArray(body.value)) {
        sendError(res, 400, '请求体必须是 JSON 对象，形如 {"pricing":{...},"alerts":{...}} 或 {"pricing":{"append":{...}}}');
        return;
      }
      // 约定 5：历史价格版本不可修改/删除（只允许 append）
      if (typeof body.value.pricing === 'object' && body.value.pricing !== null && !Array.isArray(body.value.pricing) && body.value.pricing.versions !== undefined) {
        sendError(res, 409, '历史价格版本不可修改或删除（只允许 POST pricing.append 追加新版本）');
        return;
      }
      try {
        const strict = body.value.strict === true;
        if (strict && typeof body.value.pricing === 'object' && body.value.pricing !== null && body.value.pricing.append !== undefined) {
          // strict：未覆盖 24/7 一律拒绝，而不是「接受但警告」
          const preview = ledger.previewAppend?.(body.value.pricing.append);
          if (preview && preview.warnings.length > 0) {
            sendError(res, 400, preview.warnings.join('; '), preview.warnings);
            return;
          }
        }
        const result = await ledger.setConfig(body.value);
        const view = clientConfigView(result, { unpricedUsageRecords: null });
        sendJson(res, 200, { ...view, settingsWritten: result.settingsWritten, configPath: result.configPath, warnings: result.warnings ?? [] });
      } catch (error) {
        if (error?.code === 'INVALID_CONFIG' || error?.code === 'INVALID_BODY') {
          sendError(res, 400, error.message, error.problems ?? undefined);
          return;
        }
        if (error?.code === 'HISTORY_IMMUTABLE') {
          sendError(res, 409, error.message);
          return;
        }
        throw error;
      }
    }),
  };

  const refreshRoute = {
    kind: 'exact',
    path: ROUTE_PATHS.refresh,
    handler: guard(['POST'], `POST ${ROUTE_PATHS.refresh}`, async (req, res) => {
      const result = ledger.refresh();
      sendJson(res, 200, result);
    }),
  };

  const healthRoute = {
    kind: 'exact',
    path: ROUTE_PATHS.health,
    handler: guard(['GET'], `GET ${ROUTE_PATHS.health}`, async (req, res) => {
      const config = ledger.getConfig();
      sendJson(res, 200, {
        ok: true,
        plugin: 'dsh-workspace-fee',
        generatedAt: new Date().toISOString(),
        settingsAvailable: config.source.settingsAvailable,
        paths: ledger.paths,
      });
    }),
  };

  // 四条精确路径互不重叠，分别由 lib/index.js 逐个 ctx.webServer.register 注册。
  return [summaryRoute, configRoute, refreshRoute, healthRoute];
}

/**
 * 验证者友好入口：返回**可独立 import 调用**的 handler（不依赖任何 cordis `ctx`）。
 *
 * 路由处理器本身就是 `(req, res) => Promise<void>` 的纯函数，业务逻辑全部在
 * `lib/ledger.js`；这里只是给它们起名字，方便「不启宿主、直接 mock req/res 调
 * handler」地核对契约字段（tests/routes.test.mjs 与 独立实现 的 http-contract.mjs 都这么做）。
 * `lib/index.js` 只负责把这些 handler 接到 `ctx.webServer.register` 上。
 * @param {object} ledger
 * @param {(level:string,message:string)=>void} [logger]
 * @returns {{summary:Function, config:Function, refresh:Function, health:Function, routes:Array}}
 */
export function createHandlers(ledger, logger) {
  const table = createRouteTable({ ledger, logger });
  const byPath = new Map(table.map((route) => [route.path, route.handler]));
  return {
    summary: byPath.get(ROUTE_PATHS.summary),
    config: byPath.get(ROUTE_PATHS.config),
    refresh: byPath.get(ROUTE_PATHS.refresh),
    health: byPath.get(ROUTE_PATHS.health),
    routes: table,
  };
}
