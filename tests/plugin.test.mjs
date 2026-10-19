/**
 * 插件装配测试：导出形状、零第三方运行时依赖、路由注册与注销、settings 绑定。
 * 用法：node --test --test-isolation=none tests/plugin.test.mjs
 *
 * 说明（效力边界）：这里用一个**替身 ctx**（只实现 webServer.register / effect /
 * logger / settings 的公开形状）来验证装配逻辑。真正的 cordis 生命周期与 settings
 * 服务行为由 独立的真机端到端验证覆盖，不在本文件的证明范围内。
 */
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { name, inject, apply, createSettingsSchema, validatePluginConfig } from '../lib/index.js';
import { ROUTE_PATHS } from '../lib/routes.js';
import { cleanup, makeTempHome, sessionRecord, todayBeijing, usageRecord, writeSession } from './helpers/session-fixture.mjs';

const CWD = 'D:\\work\\alpha';
const LIB_DIR = join(import.meta.dirname, '..', 'lib');

/**
 * 用「今天 03:00（北京时间）」写记录：既是**今日**（window 过滤只看北京日），
 * 又必然落在**空闲时段**，因此单价确定（1e6 未命中 = 1.0 元），不依赖运行时刻。
 * apply() 里没有可注入的时钟（插件配置来自 YAML），所以插件测试必须用真实今日。
 */
const RECORD_AT = todayBeijing(3);

/** 替身 ctx：记录每次 effect 与每条注册的路由，便于断言装配与注销。 */
function fakeCtx({ withSettings = false, settingsValue = null } = {}) {
  const state = { effects: [], routes: [], disposed: 0, logs: [], registeredSettings: [] };
  const ctx = {
    logger: { info: (...args) => state.logs.push(['info', ...args]), warn: (...args) => state.logs.push(['warn', ...args]) },
    effect(fn, label) {
      const disposer = fn();
      state.effects.push({ label, disposer });
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    webServer: {
      register(route) {
        state.routes.push(route);
        return () => {
          state.disposed += 1;
        };
      },
    },
  };
  if (withSettings) {
    ctx.settings = {
      register(ns, schema, options) {
        state.registeredSettings.push({ ns, schema, options });
        let value = schema({ ...(options?.base ?? {}) });
        if (settingsValue !== null) value = schema({ ...(options?.base ?? {}), ...settingsValue });
        return {
          get: () => value,
          update: async (patch) => {
            value = schema({ ...value, ...patch });
            return { revision: 1 };
          },
          replace: async (section) => {
            value = schema(section);
            return { revision: 2 };
          },
          watch: () => () => {},
        };
      },
    };
  }
  return { ctx, state };
}

function buildHome() {
  const home = makeTempHome('plugin');
  writeSession(home, CWD, 's-a1', [
    sessionRecord({ id: 's-a1', cwd: CWD, createdAt: RECORD_AT - 60_000 }),
    usageRecord(1, RECORD_AT, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }),
  ]);
  return home;
}

test('插件导出形状与内置插件一致：name / inject / apply', () => {
  assert.equal(name, 'dsh-workspace-fee');
  assert.deepEqual(inject, ['webServer']);
  assert.equal(typeof apply, 'function');
});

test('零第三方运行时依赖：lib/ 下只能 import node: 内置模块或相对路径', () => {
  const offenders = [];
  const files = readdirSync(LIB_DIR).filter((f) => f.endsWith('.js'));
  assert.ok(files.length >= 7, `lib/ 下应有至少 7 个文件，实际 ${files.length}`);
  for (const file of files) {
    const text = readFileSync(join(LIB_DIR, file), 'utf8');
    const specifiers = [...text.matchAll(/(?:^|\n)\s*import\s+(?:[^'"]*?from\s+)?['"]([^'"]+)['"]/g)].map((m) => m[1]);
    for (const spec of specifiers) {
      if (spec.startsWith('node:') || spec.startsWith('./') || spec.startsWith('../')) continue;
      offenders.push(`${file} → ${spec}`);
    }
  }
  assert.deepEqual(offenders, [], `出现了第三方运行时依赖：${offenders.join(', ')}`);
  const pkg = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'));
  assert.deepEqual(pkg.dependencies ?? {}, {}, 'package.json 不应有运行时 dependencies');
});

test('apply：注册四条精确路由，并在 effect 注销时逐个释放', () => {
  const home = buildHome();
  try {
    const { ctx, state } = fakeCtx();
    const result = apply(ctx, { home, dataDir: join(home, 'workspace-fee'), persistCache: false, flushSeconds: 0 });
    assert.deepEqual(state.routes.map((r) => r.path), [ROUTE_PATHS.summary, ROUTE_PATHS.config, ROUTE_PATHS.refresh, ROUTE_PATHS.health]);
    for (const route of state.routes) {
      assert.equal(route.kind, 'exact');
      assert.equal(typeof route.handler, 'function');
    }
    // flushSeconds=0 → 只注册一个 effect（路由），不留定时器
    assert.equal(state.effects.length, 1);
    assert.equal(result.ledger.paths.dataDir, join(home, 'workspace-fee'));
    assert.equal(result.settingsScope, null);
    const summary = result.ledger.summary({ days: 7 });
    assert.equal(summary.totals.cost, 1.0);
    // 注销
    state.effects[0].disposer();
    assert.equal(state.disposed, 4);
  } finally {
    cleanup(home);
  }
});

test('apply：settings 可用时注册 dsh-workspace-fee 命名空间，且价格覆盖真的生效', () => {
  const home = buildHome();
  try {
    const { ctx, state } = fakeCtx({ withSettings: true, settingsValue: { pricing: { families: { flash: { cacheMiss: 10 } } } } });
    const result = apply(ctx, { home, dataDir: join(home, 'workspace-fee'), persistCache: false, flushSeconds: 0 });
    assert.equal(state.registeredSettings.length, 1);
    const [registration] = state.registeredSettings;
    assert.equal(registration.ns, 'dsh-workspace-fee');
    assert.equal(typeof registration.schema, 'function', 'schema 必须可调用（dsh-settings 直接调用它）');
    assert.deepEqual(registration.options.base, { pricing: {}, alerts: {} });
    // describe() 会调用 toJSON()：必须存在且是合法 JSON
    assert.equal(registration.schema.toJSON().type, 'object');
    assert.ok(Number.isFinite(JSON.stringify(registration.schema.toJSON()).length));
    // 归一化留在账本层：schema 只回放给定的键
    assert.deepEqual(registration.schema({}), {});
    assert.deepEqual(registration.schema({ pricing: { families: { flash: { cacheMiss: 10 } } } }).pricing.families.flash.cacheMiss, 10);

    const config = result.ledger.getConfig();
    assert.equal(config.source.settingsAvailable, true);
    assert.equal(config.source.pricing, 'settings');
    assert.equal(config.pricing.families.flash.cacheMiss, 10);
    // 成本按 settings 层重算：1e6 未命中 ×10 = 10 元
    assert.equal(result.ledger.summary({ days: 7 }).totals.cost, 10);

    // 无覆盖时来源仍应报 default（空层不算生效层）
    const clean = buildHome();
    try {
      const fresh = fakeCtx({ withSettings: true });
      const r2 = apply(fresh.ctx, { home: clean, dataDir: join(clean, 'workspace-fee'), persistCache: false, flushSeconds: 0 });
      assert.equal(r2.ledger.getConfig().source.settingsAvailable, true);
      assert.equal(r2.ledger.getConfig().source.pricing, 'default');
      assert.equal(r2.ledger.summary({ days: 7 }).totals.cost, 1.0);
    } finally {
      cleanup(clean);
    }
  } finally {
    cleanup(home);
  }
});

test('apply：settings.register 抛错时降级为 config.json 而不影响路由', () => {
  const home = buildHome();
  try {
    const { ctx, state } = fakeCtx({ withSettings: true });
    ctx.settings.register = () => {
      throw new Error('settings unavailable');
    };
    const result = apply(ctx, { home, dataDir: join(home, 'workspace-fee'), persistCache: false, flushSeconds: 0 });
    assert.equal(result.settingsScope, null);
    assert.equal(state.routes.length, 4);
    assert.ok(state.logs.some(([level, message]) => level === 'warn' && String(message).includes('设置命名空间')));
    assert.equal(result.ledger.getConfig().source.settingsAvailable, false);
  } finally {
    cleanup(home);
  }
});

test('apply：没有 settings 服务也能工作（配置走 config.json）', async () => {
  const home = buildHome();
  try {
    const { ctx, state } = fakeCtx();
    const result = apply(ctx, { home, dataDir: join(home, 'workspace-fee'), persistCache: false, flushSeconds: 0 });
    assert.equal(state.routes.length, 4);
    await result.ledger.setConfig({ alerts: { defaultLimit: 0.5 } });
    const summary = result.ledger.summary({ days: 7 });
    assert.equal(summary.workspaces[0].alert.limit, 0.5);
    assert.equal(summary.workspaces[0].alert.level, 'over');
    assert.equal(summary.diagnostics.configSource.alerts, 'file');
  } finally {
    cleanup(home);
  }
});

test('apply：persistCache 默认开启时会挂一个定时落盘 effect，并可被注销', () => {
  const home = buildHome();
  try {
    const { ctx, state } = fakeCtx();
    apply(ctx, { home, dataDir: join(home, 'workspace-fee'), flushSeconds: 1 });
    assert.equal(state.effects.length, 2);
    assert.match(state.effects[1].label, /cache flush/);
    assert.equal(typeof state.effects[1].disposer, 'function');
    state.effects[1].disposer();
  } finally {
    cleanup(home);
  }
});

test('validatePluginConfig：类型错误在装配期抛出，不让错误配置静默生效', () => {
  assert.deepEqual(validatePluginConfig(undefined), {});
  assert.deepEqual(validatePluginConfig(null), {});
  assert.throws(() => validatePluginConfig('nope'), /必须是对象/);
  assert.throws(() => validatePluginConfig({ home: '' }), /home/);
  assert.throws(() => validatePluginConfig({ dataDir: 5 }), /dataDir/);
  assert.throws(() => validatePluginConfig({ pricing: [] }), /pricing/);
  assert.throws(() => validatePluginConfig({ alerts: 'x' }), /alerts/);
  assert.throws(() => validatePluginConfig({ persistCache: 'yes' }), /persistCache/);
  assert.throws(() => validatePluginConfig({ flushSeconds: -1 }), /flushSeconds/);
  assert.equal(validatePluginConfig({ home: 'D:\\x', pricing: {}, alerts: {} }).home, 'D:\\x');
});

test('createSettingsSchema：只回放非空键，深拷贝输入（不会被外部改动污染）', () => {
  const schema = createSettingsSchema();
  const input = { pricing: { currency: 'JPY' }, alerts: { defaultLimit: 3 }, extra: 1 };
  const out = schema(input);
  assert.deepEqual(Object.keys(out).sort(), ['alerts', 'pricing']);
  assert.equal(out.pricing.currency, 'JPY');
  input.pricing.currency = 'USD';
  assert.equal(out.pricing.currency, 'JPY', 'schema 必须深拷贝，避免 settings 层被后续改动影响');
  assert.deepEqual(schema({ pricing: {} }), {});
});
