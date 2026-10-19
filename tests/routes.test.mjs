/**
 * HTTP 契约测试：路由表、200/400/405/500 的响应形状，逐字段核对 docs/SPEC.md。
 * 用法：node --test --test-isolation=none tests/routes.test.mjs
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLedger } from '../lib/ledger.js';
import { MAX_BODY_BYTES, ROUTE_PATHS, createRouteTable, parseDays, readJsonBody } from '../lib/routes.js';
import { encodeWorkspaceKey } from '../lib/session-log.js';
import { beijing, cleanup, makeTempHome, sessionRecord, usageRecord, writeSession } from './helpers/session-fixture.mjs';

const NOW = beijing(2026, 10, 7, 20, 0);
const CWD = 'D:\\work\\alpha';

function buildLedger(extra = {}) {
  const home = makeTempHome('routes');
  writeSession(home, CWD, 's-a1', [
    sessionRecord({ id: 's-a1', cwd: CWD, createdAt: beijing(2026, 10, 5, 9, 0) }),
    usageRecord(1, beijing(2026, 10, 5, 10, 0), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }),
    usageRecord(2, beijing(2026, 10, 7, 20, 5), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }),
  ]);
  const ledger = createLedger({ home, dataDir: join(home, 'workspace-fee'), now: () => NOW, persistCache: false, ...extra });
  return { home, ledger };
}

function fakeRes() {
  const res = {
    statusCode: 200,
    headers: {},
    headersSent: false,
    body: undefined,
  };
  res.setHeader = (key, value) => {
    res.headers[String(key).toLowerCase()] = value;
  };
  res.end = (chunk) => {
    res.headersSent = true;
    res.body = chunk === undefined || chunk === null ? null : JSON.parse(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
  };
  res.destroy = () => {};
  return res;
}

function fakeReq({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const stream = Readable.from(body === null ? [] : [Buffer.from(body, 'utf8')]);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

async function call(handler, options) {
  const res = fakeRes();
  await handler(fakeReq(options), res);
  return res;
}

function routeMap(ledger) {
  const table = createRouteTable({ ledger, logger: () => {} });
  return new Map(table.map((route) => [route.path, route]));
}

test('路由表：四条精确路由，路径冻结', () => {
  const { home, ledger } = buildLedger();
  try {
    const table = createRouteTable({ ledger });
    assert.deepEqual(table.map((r) => r.path), [ROUTE_PATHS.summary, ROUTE_PATHS.config, ROUTE_PATHS.refresh, ROUTE_PATHS.health]);
    for (const route of table) {
      assert.equal(route.kind, 'exact');
      assert.equal(typeof route.handler, 'function');
    }
    assert.equal(ROUTE_PATHS.summary, '/api/dsh-workspace-fee/summary');
    assert.equal(ROUTE_PATHS.config, '/api/dsh-workspace-fee/config');
    assert.equal(ROUTE_PATHS.refresh, '/api/dsh-workspace-fee/refresh');
  } finally {
    cleanup(home);
  }
});

test('GET /summary：200 且逐字段符合契约（含 client 侧 workspaceId/current/daily 别名）', async () => {
  const { home, ledger } = buildLedger();
  try {
    const routes = routeMap(ledger);
    const res = await call(routes.get(ROUTE_PATHS.summary).handler, { url: `${ROUTE_PATHS.summary}?days=7&sessionId=s-a1` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/json; charset=utf-8');
    const body = res.body;
    assert.equal(body.ok, true);
    assert.equal(typeof body.generatedAt, 'string');
    assert.equal(body.days, 7);
    assert.deepEqual(Object.keys(body.window).sort(), ['from', 'timezone', 'timezoneOffsetMinutes', 'to']);
    assert.deepEqual(Object.keys(body.totals).sort(), ['cost', 'idleCost', 'peakSurcharge', 'tokens']);
    assert.deepEqual(Object.keys(body.totals.tokens).sort(), ['cacheReadTokens', 'inputTokens', 'outputTokens', 'reasoningTokens', 'totalTokens']);
    assert.ok(Array.isArray(body.workspaces));
    assert.ok(Array.isArray(body.daily));
    assert.ok(Array.isArray(body.gaps));

    const ws = body.workspaces[0];
    for (const key of ['key', 'workspaceId', 'label', 'cwd', 'sessions', 'firstTime', 'lastTime', 'tokens', 'cost', 'todayCost', 'alert']) {
      assert.ok(Object.hasOwn(ws, key), `workspaces[] 缺字段 ${key}`);
    }
    assert.equal(ws.key, ws.workspaceId);
    assert.equal(ws.label, 'alpha');
    assert.equal(ws.cwd, CWD);
    assert.deepEqual(ws.alert, {
      day: { limit: null, level: 'ok', ratio: null },
      total: { limit: null, level: 'ok', ratio: null },
      level: 'ok',
      limit: null,
    });
    // 窗口内：高峰 flash 1e6 → 2.0；今日空闲 flash 1e6 → 1.0
    assert.equal(ws.cost, 3.0);
    assert.equal(ws.todayCost, 1.0);

    const day = body.daily[0];
    for (const key of ['date', 'workspaceKey', 'workspaceId', 'label', 'sessions', 'cost', 'tokens']) {
      assert.ok(Object.hasOwn(day, key), `daily[] 缺字段 ${key}`);
    }
    // current 由 sessionId 反查
    assert.equal(body.current.label, 'alpha');
    assert.equal(body.current.workspaceId, body.current.key);
    // 自证数字必须出现在响应里
    assert.equal(body.diagnostics.streamUsageTokens, body.diagnostics.usageTokens);
    assert.equal(body.diagnostics.doubleCountInflationPercent, 100);
    assert.equal(body.diagnostics.dedupeDisagreements, 0);
  } finally {
    cleanup(home);
  }
});

test('GET /summary：days 非法一律 400 + {ok:false,error}；缺省 30', async () => {
  const { home, ledger } = buildLedger();
  try {
    const routes = routeMap(ledger);
    const handler = routes.get(ROUTE_PATHS.summary).handler;
    for (const bad of ['0', '-3', '366', 'abc', '1.5', 'NaN']) {
      const res = await call(handler, { url: `${ROUTE_PATHS.summary}?days=${bad}` });
      assert.equal(res.statusCode, 400, `days=${bad} 应为 400`);
      assert.equal(res.body.ok, false);
      assert.equal(typeof res.body.error, 'string');
      assert.ok(!Array.isArray(res.body.workspaces), '400 时绝不能返回空数组冒充成功');
    }
    const ok = await call(handler, { url: ROUTE_PATHS.summary });
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.days, 30);
  } finally {
    cleanup(home);
  }
});

test('parseDays 纯函数边界', () => {
  assert.deepEqual(parseDays(null), { ok: true, days: 30 });
  assert.deepEqual(parseDays(''), { ok: true, days: 30 });
  assert.deepEqual(parseDays('7'), { ok: true, days: 7 });
  assert.equal(parseDays('0').ok, false);
  assert.equal(parseDays('365').ok, true);
  assert.equal(parseDays('366').ok, false);
  // 全量口径是**显式字面量**：大小写与首尾空白可以容忍，拼错一律 400（不是「非数字即全量」）
  assert.deepEqual(parseDays('all'), { ok: true, days: 'all' });
  assert.deepEqual(parseDays('ALL'), { ok: true, days: 'all' });
  assert.deepEqual(parseDays(' All '), { ok: true, days: 'all' });
  assert.equal(parseDays('allx').ok, false);
  assert.equal(parseDays('alll').ok, false);
  assert.equal(parseDays('everything').ok, false);
});

test('GET /summary?days=all：全量口径回显给 client，且窗口下界不再是「今天 −N」', async () => {
  const { home, ledger } = buildLedger();
  try {
    const routes = routeMap(ledger);
    const handler = routes.get(ROUTE_PATHS.summary).handler;
    const res = await call(handler, { url: `${ROUTE_PATHS.summary}?days=all` });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.days, 'all', 'days 必须原样回显 all，供 client 判断口径');
    assert.equal(typeof res.body.window.from, 'string');
    // 全量窗口的起点 = 最早一条用量记录所在北京日（10-05 的那条），而不是 days=1 的今天
    assert.equal(res.body.window.from, '2026-10-05');
    assert.equal(res.body.window.to, '2026-10-07');
    assert.equal(res.body.diagnostics.undatedUsageRecords, 0);

    // 非法变体仍然 400：不能把任意字符串当全量
    const bad = await call(handler, { url: `${ROUTE_PATHS.summary}?days=allx` });
    assert.equal(bad.statusCode, 400);
    assert.equal(bad.body.ok, false);
  } finally {
    cleanup(home);
  }
});

test('方法不匹配：405 + Allow 头，不误报 400/500', async () => {
  const { home, ledger } = buildLedger();
  try {
    const routes = routeMap(ledger);
    const res = await call(routes.get(ROUTE_PATHS.summary).handler, { method: 'POST', url: ROUTE_PATHS.summary });
    assert.equal(res.statusCode, 405);
    assert.equal(res.headers.allow, 'GET');
    assert.equal(res.body.ok, false);
    const res2 = await call(routes.get(ROUTE_PATHS.refresh).handler, { method: 'GET', url: ROUTE_PATHS.refresh });
    assert.equal(res2.statusCode, 405);
    assert.equal(res2.headers.allow, 'POST');
  } finally {
    cleanup(home);
  }
});

test('POST /refresh：200 且给出重建证据', async () => {
  const { home, ledger } = buildLedger();
  try {
    const routes = routeMap(ledger);
    await call(routes.get(ROUTE_PATHS.summary).handler, { url: ROUTE_PATHS.summary }); // 让缓存预热
    const res = await call(routes.get(ROUTE_PATHS.refresh).handler, { method: 'POST', url: ROUTE_PATHS.refresh });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(typeof res.body.rebuiltAt, 'string');
    assert.equal(res.body.filesFromCache, 0);
    assert.equal(res.body.sessionFiles, 1);
    assert.equal(res.body.usageRecords, 2);
  } finally {
    cleanup(home);
  }
});

test('GET /config：顶层给面板形态，同时保留契约形态', async () => {
  const { home, ledger } = buildLedger();
  try {
    const routes = routeMap(ledger);
    const res = await call(routes.get(ROUTE_PATHS.config).handler, { url: ROUTE_PATHS.config });
    assert.equal(res.statusCode, 200);
    const body = res.body;
    assert.equal(body.ok, true);
    assert.equal(body.currency, 'CNY');
    assert.ok(Array.isArray(body.pricing.versions) && body.pricing.versions.length >= 1);
    assert.equal(body.pricing.versions[0].id, 'builtin-2026-09-10');
    // 约定 3：默认版本 = 两段工作日高峰 + 一条全部七天兜底
    assert.equal(body.pricing.versions[0].models.flash.segments.length, 3);
    assert.deepEqual(body.pricing.versions[0].models.flash.segments.map((s) => s.id), ['flash-peak-1', 'flash-peak-2', 'flash-offpeak-all']);
    assert.equal(typeof body.pricing.activeVersionId, 'string');
    assert.deepEqual(body.alerts, {});
    // 约定 5：顶层就是契约对象本身（不套两层），且顶层给 diagnostics
    assert.ok(Object.hasOwn(body, 'diagnostics'));
    assert.ok(Object.hasOwn(body.diagnostics, 'unpricedUsageRecords'));
    assert.equal(typeof body.diagnostics.unpricedUsageRecords, 'number');
    // 契约形态仍在
    assert.equal(body.config.pricing.currency, 'CNY');
    assert.equal(body.config.alerts.warnRatio, 0.8);
    assert.equal(body.source.pricing, 'default');
    assert.equal(body.source.settingsAvailable, false);
    assert.ok(body.paths.sessionsRoot);
  } finally {
    cleanup(home);
  }
});

test('POST /config：接受面板形态与契约形态；非法入参 400 且带 details', async () => {
  const { home, ledger } = buildLedger();
  try {
    const routes = routeMap(ledger);
    const handler = routes.get(ROUTE_PATHS.config).handler;
    const key = encodeWorkspaceKey(CWD);

    const post = (body, headers = { 'content-type': 'application/json' }) => call(handler, { method: 'POST', url: ROUTE_PATHS.config, headers, body: typeof body === 'string' ? body : JSON.stringify(body) });

    // 面板形态：{<workspaceKey>:{limit}} —— `limit` 仍可读，理解为**日线**
    const ok1 = await post({ alerts: { [key]: { limit: 1 } } });
    assert.equal(ok1.statusCode, 200);
    assert.deepEqual(ok1.body.alerts[key], { day: 1, total: null, limit: 1 });
    const summary1 = await call(routes.get(ROUTE_PATHS.summary).handler, { url: `${ROUTE_PATHS.summary}?days=7` });
    assert.equal(summary1.body.workspaces[0].alert.level, 'over');
    assert.equal(summary1.body.workspaces[0].alert.limit, 1);
    assert.equal(summary1.body.workspaces[0].alert.day.level, 'over');
    assert.equal(summary1.body.workspaces[0].alert.total.level, 'ok', '只配了日线 → 总线不预警');

    // 双线形态：{<key>:{day,total}} —— 总线可独立命中
    const both = await post({ alerts: { [key]: { day: 5, total: 2.5 } } });
    assert.equal(both.statusCode, 200);
    assert.deepEqual(both.body.alerts[key], { day: 5, total: 2.5, limit: 5 });
    const summaryBoth = await call(routes.get(ROUTE_PATHS.summary).handler, { url: `${ROUTE_PATHS.summary}?days=7` });
    assert.equal(summaryBoth.body.workspaces[0].alert.day.level, 'ok', '今日花费 < 日线 5');
    assert.equal(summaryBoth.body.workspaces[0].alert.total.level, 'over', '累计花费 >= 总线 2.5');
    assert.equal(summaryBoth.body.workspaces[0].alert.level, 'over', '整体级别取更严重的一个');

    // 契约形态：{workspaces:{<key>:number}} —— 数字只改**日线**，已有总线被保留
    const ok2 = await post({ alerts: { workspaces: { [key]: 3 } } });
    assert.equal(ok2.statusCode, 200);
    assert.deepEqual(ok2.body.alerts[key], { day: 3, total: 2.5, limit: 3 }, '数字形态只写日线，不抹掉已配的总线');

    // 价格版本追加（约定 5：必须自带完整 models，不得继承）
    const fullModels = { flash: { segments: [
      { id: 'peak', days: [1, 2, 3, 4, 5], from: '09:00', to: '12:00', hit: 0.04, miss: 2, out: 8 },
      { id: 'idle', days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '24:00', hit: 0.02, miss: 1, out: 4 },
    ] } };
    const ok3 = await post({ pricing: { append: { effectiveFrom: beijing(2026, 10, 6, 0, 0), models: fullModels } } });
    assert.equal(ok3.statusCode, 200, JSON.stringify(ok3.body.problems));
    assert.equal(ok3.body.pricing.versions.length, 2);
    assert.equal(ok3.body.source.pricing, 'file');
    assert.deepEqual(ok3.body.warnings, [], 'fullModels 覆盖 24/7 时不应有警告');

    // 约定 5：缺 models → 400；未覆盖 24/7 → 200 + warnings；strict:true → 400
    const noModels = await post({ pricing: { append: { effectiveFrom: beijing(2026, 10, 6, 0, 0), models: {} } } });
    assert.equal(noModels.statusCode, 400);
    assert.ok(noModels.body.details.some((d) => /models 必须完整给出/.test(d)));
    const holey = await post({ pricing: { append: { effectiveFrom: beijing(2026, 10, 7, 0, 0), models: { flash: { segments: [{ id: 'only-am', days: [1], from: '09:00', to: '12:00', hit: 1, miss: 1, out: 1 }] } } } } });
    assert.equal(holey.statusCode, 200, '未覆盖 24/7 → 接受但警告');
    assert.ok(holey.body.warnings.some((w) => /未覆盖时段/.test(w)));
    const strictHoley = await post({ strict: true, pricing: { append: { effectiveFrom: beijing(2026, 10, 8, 0, 0), models: { flash: { segments: [{ id: 'only-am', days: [1], from: '09:00', to: '12:00', hit: 1, miss: 1, out: 1 }] } } } } });
    assert.equal(strictHoley.statusCode, 400, 'strict:true 时未覆盖一律拒绝');
    assert.match(strictHoley.body.error, /未覆盖时段/);

    // 约定 5：历史版本不可改/删 → 409
    const wholesale = await post({ pricing: { versions: [] } });
    assert.equal(wholesale.statusCode, 409);
    assert.equal(wholesale.body.ok, false);
    assert.match(wholesale.body.error, /不可修改或删除/);

    for (const bad of [{ pricing: { families: { flash: { cacheMiss: -1 } } } }, { alerts: { workspaces: { k: -1 } } }, { pricing: { append: { effectiveFrom: 'nope', models: fullModels } } }]) {
      const res = await post(bad);
      assert.equal(res.statusCode, 400, JSON.stringify(bad));
      assert.equal(res.body.ok, false);
      assert.ok(Array.isArray(res.body.details) && res.body.details.length > 0);
    }

    // 非 JSON / 非对象 / 超长
    assert.equal((await post('{ not json', { 'content-type': 'application/json' })).statusCode, 400);
    assert.equal((await post([1, 2, 3])).statusCode, 400);
    assert.equal((await post('{}', { 'content-type': 'text/plain' })).statusCode, 400);
    const huge = JSON.stringify({ alerts: { x: 'y'.repeat(MAX_BODY_BYTES) } });
    const tooBig = await post(huge);
    assert.equal(tooBig.statusCode, 400);
    assert.match(tooBig.body.error, /上限/);
  } finally {
    cleanup(home);
  }
});

test('未预期异常 → 500 + {ok:false,error}，绝不静默返回空数组', async () => {
  const warnings = [];
  const boom = {
    summary() {
      throw new Error('boom-summary');
    },
    getConfig() {
      throw new Error('boom-config');
    },
    refresh() {
      throw new Error('boom-refresh');
    },
    paths: {},
  };
  const routes = new Map(createRouteTable({ ledger: boom, logger: (level, message) => warnings.push(`${level}:${message}`) }).map((r) => [r.path, r]));
  const res = await call(routes.get(ROUTE_PATHS.summary).handler, { url: `${ROUTE_PATHS.summary}?days=7` });
  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /boom-summary/);
  assert.ok(!Array.isArray(res.body.workspaces));
  const res2 = await call(routes.get(ROUTE_PATHS.config).handler, { url: ROUTE_PATHS.config });
  assert.equal(res2.statusCode, 500);
  assert.match(res2.body.error, /boom-config/);
  const res3 = await call(routes.get(ROUTE_PATHS.refresh).handler, { method: 'POST', url: ROUTE_PATHS.refresh });
  assert.equal(res3.statusCode, 500);
  assert.match(res3.body.error, /boom-refresh/);
  assert.equal(warnings.length, 3);
});

test('readJsonBody：空体视为 {}；非 application/json 拒绝', async () => {
  const empty = await readJsonBody(fakeReq({ method: 'POST', headers: {} }));
  assert.deepEqual(empty, { ok: true, value: {} });
  const noType = await readJsonBody(fakeReq({ method: 'POST', headers: {}, body: '{"a":1}' }));
  assert.deepEqual(noType, { ok: true, value: { a: 1 } });
  const wrong = await readJsonBody(fakeReq({ method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' }));
  assert.equal(wrong.ok, false);
  const suffix = await readJsonBody(fakeReq({ method: 'POST', headers: { 'content-type': 'application/json; charset=utf-8' }, body: '{"b":2}' }));
  assert.deepEqual(suffix, { ok: true, value: { b: 2 } });
});

test('GET /health：附加端点，报告 settings 可用性与路径', async () => {
  const { home, ledger } = buildLedger();
  try {
    const routes = routeMap(ledger);
    const res = await call(routes.get(ROUTE_PATHS.health).handler, { url: ROUTE_PATHS.health });
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.plugin, 'dsh-workspace-fee');
    assert.equal(res.body.settingsAvailable, false);
  } finally {
    cleanup(home);
  }
});
