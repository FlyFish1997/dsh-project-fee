/**
 * 账本测试：窗口、按日北京日分桶、今日费用、预警线级别、current、缓存、缺口。
 * 用**注入时钟**保证「今日/窗口」可断言，不依赖运行时刻。
 * 用法：node --test --test-isolation=none tests/ledger.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { alertsForClient, alertLevel, createLedger, normalizeAlerts } from '../lib/ledger.js';
import { encodeWorkspaceKey } from '../lib/session-log.js';
import { beijing, cleanup, frame, makeTempHome, sessionRecord, usageRecord, writeSession } from './helpers/session-fixture.mjs';

/** 固定「现在」= 北京时间 2026-10-07 20:00（周三晚，空闲时段）。 */
const NOW = beijing(2026, 10, 7, 20, 0);

/** 造一个固定的合成 home。 */
function buildHome(prefix) {
  const home = makeTempHome(prefix);
  // 工作区 alpha：周一（10-05）三条用量：高峰 flash / 空闲 flash / 空闲 pro
  writeSession(home, 'D:\\work\\alpha', 's-a1', [
    sessionRecord({ id: 's-a1', cwd: 'D:\\work\\alpha', createdAt: beijing(2026, 10, 5, 9, 0) }),
    usageRecord(1, beijing(2026, 10, 5, 10, 0), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }, { model: 'deepseek-flash' }),
    usageRecord(2, beijing(2026, 10, 5, 22, 0), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }, { model: 'deepseek-flash' }),
    usageRecord(3, beijing(2026, 10, 5, 22, 30), { inputTokens: 0, outputTokens: 1_000_000, cacheReadTokens: 0, reasoningTokens: 0 }, { model: 'deepseek-v4-pro' }),
  ]);
  // 工作区 beta：今天（10-07）一条空闲 flash，昨天（10-06）两条
  writeSession(home, 'D:\\work\\beta', 's-b1', [
    sessionRecord({ id: 's-b1', cwd: 'D:\\work\\beta', createdAt: beijing(2026, 10, 7, 10, 0) }),
    usageRecord(1, beijing(2026, 10, 7, 20, 5), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }, { model: 'deepseek-flash' }),
    usageRecord(2, beijing(2026, 10, 6, 20, 5), { inputTokens: 2_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }, { model: 'deepseek-flash' }),
  ]);
  return home;
}

function ledgerFor(home, extra = {}) {
  return createLedger({ home, dataDir: join(home, 'workspace-fee'), now: () => NOW, persistCache: false, ...extra });
}

test('窗口内合计/按日/今日费用与价格口径一致（高峰 ×2、pro 档）', () => {
  const home = buildHome('ledger-basic');
  try {
    const ledger = ledgerFor(home);
    const s = ledger.summary({ days: 365 });
    assert.equal(s.ok, true);
    assert.equal(s.window.to, '2026-10-07');
    assert.equal(s.window.from, '2025-10-08');
    // alpha: 2.0(高峰 flash) + 1.0(空闲 flash) + 13.5(空闲 pro) = 16.5
    const alpha = s.workspaces.find((w) => w.label === 'alpha');
    const beta = s.workspaces.find((w) => w.label === 'beta');
    assert.equal(alpha.cost, 16.5);
    assert.equal(alpha.todayCost, 0);
    assert.equal(alpha.cwd, 'D:\\work\\alpha');
    assert.equal(alpha.cwdSource, 'session-log');
    assert.equal(alpha.sessions, 1);
    assert.equal(alpha.key, alpha.workspaceId, 'key 与 workspaceId 必须是同一个值（超集兼容）');
    assert.equal(beta.cost, 3.0);
    assert.equal(beta.todayCost, 1.0);
    assert.equal(s.totals.cost, 19.5);
    assert.equal(s.today.date, '2026-10-07');
    assert.equal(s.today.cost, 1.0);
    // 峰谷拆分
    assert.equal(s.peakSplit.peak.cost, 2.0);
    assert.equal(s.peakSplit.idle.cost, 17.5);
    assert.equal(s.totals.peakSurcharge, 1.0);
    assert.equal(s.totals.idleCost, 18.5);
    // 按日
    const daily = s.daily.map((row) => `${row.date}|${row.label}|${row.cost}`).sort();
    assert.deepEqual(daily, ['2026-10-05|alpha|16.5', '2026-10-06|beta|2', '2026-10-07|beta|1']);
    assert.equal(s.daily[0].workspaceId, s.daily[0].workspaceKey);
    assert.equal(s.daily[0].sessions, 1);
    // 模型分布
    assert.equal(s.models.length, 2);
    assert.equal(s.models.find((m) => m.model === 'deepseek-v4-pro').tierName, 'pro');
    // 自证数字
    assert.equal(s.diagnostics.framesFailed, 0);
    assert.equal(s.diagnostics.dedupeDisagreements, 0);
    assert.equal(s.diagnostics.usageRecords, 5);
    assert.equal(s.diagnostics.streamUsageTokens, s.diagnostics.usageTokens);
    assert.equal(s.diagnostics.doubleCountInflationPercent, 100);
    assert.equal(s.gaps.length, 0);
  } finally {
    cleanup(home);
  }
});

test('days 窗口会裁掉窗口外的数据，工作区费用随之变化', () => {
  const home = buildHome('ledger-window');
  try {
    const ledger = ledgerFor(home);
    const s2 = ledger.summary({ days: 2 }); // 10-06 ~ 10-07
    assert.equal(s2.window.from, '2026-10-06');
    assert.equal(s2.totals.cost, 3.0);
    assert.equal(s2.workspaces.find((w) => w.label === 'alpha').cost, 0);
    assert.equal(s2.workspaces.find((w) => w.label === 'beta').cost, 3.0);
    assert.equal(s2.daily.length, 2);
    // firstTime/lastTime 是**终身**口径，不受窗口裁剪；firstTime 由会话 createdAt 兜下界
    assert.equal(s2.workspaces.find((w) => w.label === 'alpha').firstTime, beijing(2026, 10, 5, 9, 0));
    const s1 = ledger.summary({ days: 1 });
    assert.equal(s1.totals.cost, 1.0);
  } finally {
    cleanup(home);
  }
});

test('days 非法入参抛错（路由层转 400），绝不静默返回空数组', () => {
  const home = buildHome('ledger-days');
  try {
    const ledger = ledgerFor(home);
    for (const days of [0, -1, 366, 1.5, Number.NaN, 'allx', 'EVERYTHING', '']) {
      assert.throws(() => ledger.summary({ days }), /days/, `days=${days} 应该抛错`);
    }
  } finally {
    cleanup(home);
  }
});

test("全量口径（days:'all'）覆盖 365 天上限之外的记录：窗口起点 = 最早一条记录", () => {
  const home = makeTempHome('ledger-all-time');
  try {
    // 同一个工作区：一条 400 天前的记录 + 一条今天的记录。
    // 400 天前在北京日上落在「今天 −399」，必然在 days=365 的滚动窗口之外；
    // 取 22:00 空闲时段，好让单价与今天那条一致（各 1.0，全量合计 2.0）。
    const oldTime = beijing(2025, 9, 3, 22, 0); // 2025-09-03 → 2026-10-07 之前 399 天
    writeSession(home, 'D:\\work\\gamma', 's-g1', [
      sessionRecord({ id: 's-g1', cwd: 'D:\\work\\gamma', createdAt: oldTime }),
      // 空闲 flash，1e6 未命中 → 1.0
      usageRecord(1, oldTime, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }, { model: 'deepseek-flash' }),
      // 今天空闲 flash，1e6 未命中 → 1.0
      usageRecord(2, beijing(2026, 10, 7, 20, 5), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }, { model: 'deepseek-flash' }),
    ]);
    const ledger = ledgerFor(home);

    // ① 滚动上限 365 天够不到 400 天前的那条记录
    const rolling = ledger.summary({ days: 365 });
    assert.equal(rolling.days, 365);
    assert.equal(rolling.totals.cost, 1.0, '365 天窗口必须裁掉 400 天前的记录');
    assert.equal(rolling.window.from, '2025-10-08');

    // ② 全量口径必须把它算进来，且窗口起点 = 最早一条记录所在北京日
    const all = ledger.summary({ days: 'all' });
    assert.equal(all.days, 'all', 'days 必须原样回显 all（client 据此切标签）');
    assert.equal(all.window.from, '2025-09-03');
    assert.equal(all.window.to, '2026-10-07');
    assert.equal(all.totals.cost, 2.0, '全量必须覆盖 365 天上限之外的记录');
    assert.equal(all.daily.map((d) => d.date).sort().join(','), '2025-09-03,2026-10-07');
    const gamma = all.workspaces.find((w) => w.label === 'gamma');
    assert.equal(gamma.cost, 2.0);
    assert.equal(gamma.usageRecords, 2);
    // 全量口径下「窗口内 cost」= 「终身 cost」（无无时间戳记录时就是这个恒等式）
    assert.equal(gamma.cost, gamma.lifetimeCost);
    assert.equal(gamma.lifetimeTokens, gamma.tokens.totalTokens);
    assert.equal(all.diagnostics.undatedUsageRecords, 0);

    // ③ 单日口径仍然只算今天，证明全量没有污染滚动口径
    assert.equal(ledger.summary({ days: 1 }).totals.cost, 1.0);
  } finally {
    cleanup(home);
  }
});

test('预警线：ok / warn / over 三档，且接受两种写入形态', async () => {
  const home = buildHome('ledger-alert');
  try {
    const ledger = ledgerFor(home);
    assert.equal(ledger.summary({ days: 7 }).alerts.configured, 0);

    // 面板形态：{<workspaceKey>: {limit}}
    await ledger.setConfig({ alerts: { [workspaceKeyOf('D:\\work\\beta')]: { limit: 1 } } });
    const over = ledger.summary({ days: 7 });
    const beta = over.workspaces.find((w) => w.label === 'beta');
    assert.equal(beta.alert.limit, 1);
    assert.equal(beta.alert.level, 'over', 'todayCost 1.0 >= limit 1.0 应为 over');
    assert.equal(beta.alert.day.level, 'over');
    assert.equal(beta.alert.day.limit, 1);
    assert.equal(beta.alert.total.level, 'ok', '未配置总线 → 总线恒 ok');
    assert.equal(over.alerts.over, 1);
    assert.equal(over.alerts.configured, 1);

    // 宿主契约形态：{workspaces:{<key>: number}}，warn 档（1.0 ≥ 1.25×0.8）
    await ledger.setConfig({ alerts: { workspaces: { [workspaceKeyOf('D:\\work\\beta')]: 1.25 } } });
    const warn = ledger.summary({ days: 7 });
    assert.equal(warn.workspaces.find((w) => w.label === 'beta').alert.level, 'warn');
    assert.equal(warn.alerts.warn, 1);
    assert.equal(warn.alerts.worst[0].label, 'beta');

    // 无条件不预警
    await ledger.setConfig({ alerts: { workspaces: { [workspaceKeyOf('D:\\work\\beta')]: null } } });
    assert.equal(ledger.summary({ days: 7 }).workspaces.find((w) => w.label === 'beta').alert.level, 'ok');

    // 非法值 → 抛错（路由层 400）
    await assert.rejects(() => ledger.setConfig({ alerts: { workspaces: { k: -3 } } }), /alerts/);
  } finally {
    cleanup(home);
  }
});

test('alertLevel / normalizeAlerts / alertsForClient 的纯函数行为（双预警线）', () => {
  const A = (o) => alertLevel(o);
  // 两条线都为 null → ok
  assert.deepEqual(A({ todayCost: 0, lifetimeCost: 0, dayLimit: null, totalLimit: null, warnRatio: 0.8 }), {
    day: { level: 'ok', limit: null, ratio: null },
    total: { level: 'ok', limit: null, ratio: null },
    level: 'ok',
    limit: null,
  });
  // 日线 warn / over
  assert.equal(A({ todayCost: 0.9, lifetimeCost: 0.9, dayLimit: 1, warnRatio: 0.8 }).level, 'warn');
  assert.equal(A({ todayCost: 1, lifetimeCost: 1, dayLimit: 1, warnRatio: 0.8 }).level, 'over');
  // 日线 ok 但**总线 over** → 整体 over
  const t = A({ todayCost: 0.1, lifetimeCost: 50, dayLimit: 10, totalLimit: 40, warnRatio: 0.8 });
  assert.equal(t.day.level, 'ok');
  assert.equal(t.total.level, 'over');
  assert.equal(t.level, 'over', '整体级别取两条线中更严重的一个');
  // 日线 over 而总线 ok → 仍是 over
  const d = A({ todayCost: 50, lifetimeCost: 50, dayLimit: 10, totalLimit: 1000, warnRatio: 0.8 });
  assert.equal(d.day.level, 'over');
  assert.equal(d.total.level, 'ok');
  assert.equal(d.level, 'over');
  // 两条都 warn → warn
  assert.equal(A({ todayCost: 9, lifetimeCost: 90, dayLimit: 10, totalLimit: 100, warnRatio: 0.8 }).level, 'warn');
  // limit 字段保留为日线值（向后兼容旧消费方）
  assert.equal(A({ todayCost: 1, lifetimeCost: 1, dayLimit: 7, totalLimit: 99, warnRatio: 0.8 }).limit, 7);

  // 归一化：数字 / {limit} 一律理解为**日线**，总线为 null（老配置不失效）
  const n = normalizeAlerts({ ws1: { limit: 3 }, ws2: 4, ws3: null, ws4: { day: 5, total: 50 } }).alerts.workspaces;
  assert.deepEqual(n, {
    ws1: { day: 3, total: null },
    ws2: { day: 4, total: null },
    ws3: { day: null, total: null },
    ws4: { day: 5, total: 50 },
  });
  // 客户端形态同时给出 day/total，并保留 limit=day 兼容
  assert.deepEqual(alertsForClient({ workspaces: { ws1: { day: 3, total: 30 }, ws3: null } }), {
    ws1: { day: 3, total: 30, limit: 3 },
    ws3: { day: null, total: null, limit: null },
  });
  // 默认总线：工作区没有自身总线配置时用 defaultTotalLimit
  const withDefault = normalizeAlerts({ defaultTotalLimit: 88, ws1: { day: 1 } }).alerts;
  assert.equal(withDefault.defaultTotalLimit, 88);
  assert.equal(withDefault.workspaces.ws1.total, null, '自身配置里未写 total → 留 null，由 totalLimitOf 落回默认');
});

test('current 由 sessionId 反查（客户端 data.current），查不到为 null', () => {
  const home = buildHome('ledger-current');
  try {
    const ledger = ledgerFor(home);
    const hit = ledger.summary({ days: 7, sessionId: 's-b1' });
    assert.equal(hit.current.label, 'beta');
    assert.equal(hit.current.workspaceId, hit.current.key);
    const miss = ledger.summary({ days: 7, sessionId: 'no-such-session' });
    assert.equal(miss.current, null);
    assert.equal(ledger.summary({ days: 7 }).current, null);
  } finally {
    cleanup(home);
  }
});

test('缓存：首次全解、二次命中、refresh 强制重建', () => {
  const home = buildHome('ledger-cache');
  try {
    const ledger = createLedger({ home, dataDir: join(home, 'workspace-fee'), now: () => NOW, persistCache: true });
    const first = ledger.summary({ days: 7 });
    assert.equal(first.diagnostics.sessionFiles, 2);
    assert.equal(first.diagnostics.sessionsAnalyzed, 2);
    assert.equal(first.diagnostics.filesFromCache, 0);
    const second = ledger.summary({ days: 7 });
    assert.equal(second.diagnostics.filesFromCache, 2, '第二次应全部命中缓存');
    assert.equal(second.diagnostics.sessionsAnalyzed, 0);
    assert.equal(second.totals.cost, first.totals.cost);
    const refreshed = ledger.refresh();
    assert.equal(refreshed.filesFromCache, 0, 'refresh 必须清空缓存后重扫（若为 2 说明缓存没被清）');
    assert.equal(refreshed.sessionFiles, 2);
    assert.equal(refreshed.usageRecords, 5);
    const third = ledger.summary({ days: 7 });
    assert.equal(third.diagnostics.filesFromCache, 2, 'refresh 自身已完成全量重解，随后这次命中缓存');
    assert.equal(third.totals.cost, first.totals.cost);
    assert.equal(third.diagnostics.dedupeDisagreements, 0);
  } finally {
    cleanup(home);
  }
});

test('缺口显式登记：空工作区、缺日志文件的会话目录、损坏帧、会话根不存在', () => {
  const home = buildHome('ledger-gaps');
  try {
    // 缺文件
    mkdirSync(join(home, 'sessions', '--D-work-gamma--', 's-g1'), { recursive: true });
    // 完全空的工作区目录（存在但没有任何会话子目录）
    mkdirSync(join(home, 'sessions', '--D-work-empty--'), { recursive: true });
    // 损坏帧（同一份日志里一帧坏，其余仍要计入）
    const good = frame(JSON.stringify(sessionRecord({ id: 's-d1', cwd: 'D:\\work\\delta', createdAt: beijing(2026, 10, 7, 9, 0) })));
    const broken = Buffer.concat([Buffer.from([0x28, 0xb5, 0x2f, 0xfd]), Buffer.from('not-a-frame')]);
    const usage = frame(JSON.stringify(usageRecord(1, beijing(2026, 10, 7, 20, 10), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 })));
    const dir = join(home, 'sessions', '--D-work-delta--', 's-d1');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'session.v3.jsonl.zstd'), Buffer.concat([good, broken, usage]));

    const ledger = ledgerFor(home);
    const s = ledger.summary({ days: 7 });
    const kinds = s.gaps.map((g) => g.kind).sort();
    assert.ok(kinds.includes('session-log-missing'), JSON.stringify(kinds));
    assert.ok(kinds.includes('frame-decode-failed'), JSON.stringify(kinds));
    assert.ok(kinds.includes('workspace-empty'), `空工作区必须被显式登记：${JSON.stringify(kinds)}`);
    // gamma（有会话目录但没有日志文件）与 empty（完全没有子目录）都没有可用日志
    assert.equal(s.diagnostics.workspacesWithoutLogs, 2);
    assert.equal(s.diagnostics.framesFailed, 1);
    // alpha 4 行/每帧 3 行 = 2 帧，beta 3 行 = 1 帧，delta 3 帧（其中 1 帧损坏）→ 解码成功 5
    assert.equal(s.diagnostics.framesDecoded, 5);
    assert.equal(s.diagnostics.frameTotal, 6);
    // 损坏文件里那一条可解码的用量仍要进账
    assert.equal(s.workspaces.find((w) => w.label === 'delta').todayCost, 1.0);
    // 会话根不存在：ok 仍为 true，但必须是显式缺口 + 空数组（不是静默）
    const empty = createLedger({ home: join(home, 'no-such-home'), dataDir: join(home, 'writable'), now: () => NOW, persistCache: false });
    const es = empty.summary({ days: 7 });
    assert.equal(es.ok, true);
    assert.deepEqual(es.workspaces, []);
    assert.equal(es.totals.cost, 0);
    assert.ok(es.gaps.some((g) => g.kind === 'sessions-root-missing'));
  } finally {
    cleanup(home);
  }
});

test('价格版本：append 之后的新版本只影响 effectiveFrom 之后的记录', async () => {
  const home = buildHome('ledger-version');
  try {
    const ledger = ledgerFor(home);
    const before = ledger.summary({ days: 7 });
    // 窗口 10-01~10-07 覆盖全部记录：alpha 16.5 + beta 3.0 = 19.5
    assert.equal(before.totals.cost, 19.5);
    assert.equal(before.pricing.activeVersionId, 'builtin-2026-09-10');

    const result = await ledger.setConfig({
      pricing: {
        append: {
          effectiveFrom: beijing(2026, 10, 6, 0, 0),
          note: '测试涨价',
          models: { flash: { segments: [{ id: 'flat', label: '统一', days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '24:00', hit: 1, miss: 10, out: 10 }] } },
        },
      },
    });
    assert.equal(result.pricing.versions.length, 1);
    assert.equal(result.source.pricing, 'file');
    const after = ledger.summary({ days: 7 });
    // alpha 的 10-05 记录仍走内置价（2.0 + 1.0 + 13.5 = 16.5）
    assert.equal(after.workspaces.find((w) => w.label === 'alpha').cost, 16.5);
    // beta 的 10-06/10-07 走新价：2e6 miss ×10 = 20，1e6 miss ×10 = 10
    assert.equal(after.workspaces.find((w) => w.label === 'beta').cost, 30);
    assert.equal(after.totals.cost, 46.5);
    assert.equal(after.pricing.activeVersionId, result.pricing.versions[0].id);

    // reset 清空覆盖
    const reset = await ledger.setConfig({ reset: true });
    assert.equal(reset.pricing.versions.length, 0);
    assert.equal(ledger.summary({ days: 7 }).totals.cost, 19.5);
  } finally {
    cleanup(home);
  }
});

test('按日 JSONL 账单写入 usageDir（默认 <home>/dsh-usage，可用 DSH_WORKSPACE_FEE_USAGE 重定向）', () => {
  const home = buildHome('ledger-usage');
  const redirected = join(home, 'redirected-usage');
  try {
    const ledger = ledgerFor(home);
    const s = ledger.summary({ days: 7 });
    const bill = s.diagnostics.usageBill;
    assert.equal(bill.error, null, `写账单失败：${bill.error}`);
    assert.equal(bill.dir, join(home, 'dsh-usage'));
    // 2 个工作区 + summary.jsonl
    assert.equal(bill.filesWritten, 3);
    assert.equal(bill.lines, 3 + 3, '工作区按日 3 行 + 全工作区按日 3 行');

    const alphaKey = workspaceKeyOf('D:\\work\\alpha');
    const alphaLines = readFileSync(join(home, 'dsh-usage', `${alphaKey}.jsonl`), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(alphaLines.length, 1, 'alpha 只有 2026-10-05 一天');
    assert.deepEqual(
      { type: alphaLines[0].type, date: alphaLines[0].date, cost: alphaLines[0].cost, key: alphaLines[0].workspaceKey, sessions: alphaLines[0].sessions, currency: alphaLines[0].currency },
      { type: 'workspace-day', date: '2026-10-05', cost: 16.5, key: alphaKey, sessions: 1, currency: 'CNY' },
    );
    assert.equal(alphaLines[0].tokens.totalTokens > 0, true);

    const summaryLines = readFileSync(join(home, 'dsh-usage', 'summary.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.deepEqual(summaryLines.map((row) => row.date), ['2026-10-05', '2026-10-06', '2026-10-07']);
    assert.deepEqual(summaryLines.map((row) => row.type), ['day', 'day', 'day']);
    assert.equal(summaryLines.find((row) => row.date === '2026-10-06').cost, 2);
    assert.equal(summaryLines.find((row) => row.date === '2026-10-07').cost, 1);

    // 环境变量重定向（契约要求「可用环境变量重定向，便于测试」）
    process.env.DSH_WORKSPACE_FEE_USAGE = redirected;
    try {
      const l2 = ledgerFor(home);
      assert.equal(l2.paths.usageDir, redirected);
      const s2 = l2.summary({ days: 7 });
      assert.equal(s2.diagnostics.usageBill.dir, redirected);
      assert.ok(existsSync(join(redirected, 'summary.jsonl')));
      assert.equal(s2.diagnostics.usageBill.filesWritten, 3);
    } finally {
      delete process.env.DSH_WORKSPACE_FEE_USAGE;
    }

    // 写不进去时只告警，不影响账目（用「把 usageDir 指到一个文件」模拟失败）
    const blocked = join(home, 'not-a-dir.txt');
    writeFileSync(blocked, 'x');
    const l3 = ledgerFor(home, { usageDir: join(blocked, 'sub') });
    const s3 = l3.summary({ days: 7 });
    assert.ok(s3.diagnostics.usageBill.error !== null, '写失败必须被报告出来');
    assert.equal(s3.totals.cost, 19.5, '写账单失败不得影响账目');
  } finally {
    cleanup(home);
  }
});

test('口径反证数字：bucketRefutation 如实统计判别性指标，并给出三种算法总额', () => {
  const home = makeTempHome('ledger-bucket');
  try {
    // 一条 input < cacheRead（真实数据里占 99%+），一条 input > cacheRead
    writeSession(home, 'D:\\work\\gamma', 's-g1', [
      sessionRecord({ id: 's-g1', cwd: 'D:\\work\\gamma', createdAt: beijing(2026, 10, 7, 9, 0) }),
      usageRecord(1, beijing(2026, 10, 7, 20, 5), { inputTokens: 739, cacheReadTokens: 16256, outputTokens: 199, reasoningTokens: 98 }),
      usageRecord(2, beijing(2026, 10, 7, 20, 6), { inputTokens: 3000, cacheReadTokens: 1000, outputTokens: 100, reasoningTokens: 0 }),
    ]);
    const ledger = ledgerFor(home);
    const s = ledger.summary({ days: 7 });
    const r = s.diagnostics.bucketRefutation;
    assert.equal(r.inputGeCacheRecords, 1);
    assert.equal(r.inputLtCacheRecords, 1);
    assert.equal(r.inputLtCachePercent, 50);
    assert.equal(r.missBucketZeroedRecords, 1);
    assert.equal(r.missBucketZeroedPercent, 50);
    assert.equal(r.sumInputTokens, 3739);
    assert.equal(r.sumCacheReadTokens, 17256);
    assert.equal(r.sumMinInputCache, 1739);
    // 未命中分项：互斥桶 = 3739 tokens；对照口径 = 0 + 2000 = 2000 tokens
    assert.equal(Number(r.missPartDisjoint.toFixed(6)), Number((3739 / 1e6).toFixed(6)));
    assert.equal(Number(r.missPartInclusive.toFixed(6)), Number((2000 / 1e6).toFixed(6)));
    // 实际费用（空闲 flash）：hit 0.02 / miss 1 / out 4；reasoning 已含在 output，不再相加
    const expected = (16256 * 0.02 + 739 * 1 + 199 * 4) / 1e6 + (1000 * 0.02 + 3000 * 1 + 100 * 4) / 1e6;
    assert.ok(Math.abs(s.totals.cost - expected) < 1e-12, `${s.totals.cost} vs ${expected}`);
    // 三种算法：A(默认) / B(再加 reasoning) / C(input 当含 cache + reasoning)
    assert.ok(s.diagnostics.costIfReasoningAdded > s.totals.cost, 'B 必须大于 A（本例 reasoning=98）');
    assert.ok(s.diagnostics.costIfReasoningAddedPercent > 0);
    assert.ok(r.costIfInputIncludesCacheRead < s.diagnostics.costIfReasoningAdded, 'C 的未命中桶被夹小');
    assert.ok(r.costIfInputIncludesCacheReadOnly < s.totals.cost, '只把未命中桶夹到 0 会让总额变小');
    assert.ok(r.costIfInputIncludesCacheReadPercent < 0);
  } finally {
    cleanup(home);
  }
});

test('约定 2：版本分段留洞 → 记录未计价（cost=0）并列入 gaps，不得回退更早版本', async () => {
  const home = buildHome('ledger-unpriced');
  try {
    const ledger = ledgerFor(home);
    const before = ledger.summary({ days: 7 });
    assert.equal(before.diagnostics.unpricedUsageRecords, 0);
    assert.ok(!before.gaps.some((g) => g.kind === 'usage-unpriced'));

    // 追加一个只覆盖「周一 09:00-12:00」的版本，生效于 10-06 00:00（beta 的两条记录都落在它之后）
    const appended = await ledger.setConfig({
      pricing: {
        append: {
          effectiveFrom: beijing(2026, 10, 6, 0, 0),
          models: { flash: { segments: [{ id: 'only-mon-am', days: [1], from: '09:00', to: '12:00', hit: 1, miss: 1, out: 1 }] } },
        },
      },
    });
    assert.ok(appended.warnings.some((w) => /未覆盖时段/.test(w)), JSON.stringify(appended.warnings));

    const after = ledger.summary({ days: 7 });
    // beta 的两条记录（10-06 周二 20:05、10-07 周三 20:05）都落在洞外 → 未计价
    assert.equal(after.diagnostics.unpricedUsageRecords, 2, '未计价条数必须如实上报');
    const gap = after.gaps.find((g) => g.kind === 'usage-unpriced');
    assert.ok(gap, `gaps 必须显式登记未计价：${JSON.stringify(after.gaps.map((g) => g.kind))}`);
    assert.match(gap.detail, /2 条用量/);
    const beta = after.workspaces.find((w) => w.label === 'beta');
    assert.equal(beta.cost, 0, '未计价即 0 元，绝不悄悄用更早版本价格顶上');
    assert.equal(beta.tokens.totalTokens > 0, true, 'tokens 仍然照实统计（只是没计价）');
    // alpha 的 10-05 记录早于新版本 → 仍用内置版本
    assert.equal(after.workspaces.find((w) => w.label === 'alpha').cost, 16.5);
  } finally {
    cleanup(home);
  }
});

test('约定 5：POST /config 改/删历史版本 → HISTORY_IMMUTABLE（路由层转 409）', async () => {
  const home = buildHome('ledger-history');
  try {
    const ledger = ledgerFor(home);
    await assert.rejects(() => ledger.setConfig({ pricing: { versions: [] } }), (error) => error.code === 'HISTORY_IMMUTABLE');
    await assert.rejects(() => ledger.setConfig({ pricing: { versions: [{ effectiveFrom: 1, models: {} }] } }), (error) => error.code === 'HISTORY_IMMUTABLE');
    // 合法的 alert 写入不受影响
    const ok = await ledger.setConfig({ alerts: { defaultLimit: 3 } });
    assert.equal(ok.alerts.defaultLimit, 3);
  } finally {
    cleanup(home);
  }
});

test('配置写入持久化到 config.json，重启后仍生效；非法配置不落盘', async () => {
  const home = buildHome('ledger-persist');
  try {
    const a = ledgerFor(home);
    await assert.rejects(() => a.setConfig({ pricing: { families: { flash: { cacheMiss: -5 } } } }), /families/);
    await a.setConfig({ alerts: { defaultLimit: 2.5 } });
    const b = ledgerFor(home); // 模拟重启
    const summary = b.summary({ days: 7 });
    assert.equal(summary.diagnostics.configSource.alerts, 'file');
    assert.equal(summary.workspaces.find((w) => w.label === 'beta').alert.limit, 2.5);
  } finally {
    cleanup(home);
  }
});

/**
 * 回归：DSH 升级会话格式后文件名从 `session.v3.jsonl.zstd` 变成 `session.v4.jsonl.zstd`。
 *
 * 修复前（硬编码 v3）的症状：v4-only 的会话目录整段读不到 → 今日花费恒为 0，
 * 同时每个这样的目录都被记成 `session-log-missing`。
 * 修复后要求：① v4 会话被读到；② 同一目录里 v3+v4 并存时**只算一次**（v4 是整篇重写，
 * 两个文件都读会让重叠记录双计）；③ 版本分布出现在 diagnostics 里，可被外部反证。
 */
test('会话格式升级到 v4：v4-only 的会话要读到，v3+v4 并存时只算一次（不双计）', () => {
  const home = makeTempHome('ledger-v4');
  try {
    const cwdV4 = 'D:\\work\\vfour';
    // ① 只有 v4 的会话：修复前完全读不到
    writeSession(
      home,
      cwdV4,
      's-v4',
      [
        sessionRecord({ id: 's-v4', cwd: cwdV4, createdAt: beijing(2026, 10, 7, 9, 0) }),
        usageRecord(1, beijing(2026, 10, 7, 20, 5), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }),
      ],
      { fileName: 'session.v4.jsonl.zstd' },
    );

    // ② v3 与 v4 并存：v4 是 v3 的**超集**（同样的 2 条 + 新增 1 条）
    const cwdDup = 'D:\\work\\dup';
    const head = sessionRecord({ id: 's-dup', cwd: cwdDup, createdAt: beijing(2026, 10, 7, 9, 0) });
    const rec1 = usageRecord(1, beijing(2026, 10, 7, 20, 6), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 });
    const rec2 = usageRecord(2, beijing(2026, 10, 7, 20, 7), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 });
    const rec3 = usageRecord(3, beijing(2026, 10, 7, 20, 8), { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 });
    writeSession(home, cwdDup, 's-dup', [head, rec1, rec2]);
    writeSession(home, cwdDup, 's-dup', [head, rec1, rec2, rec3], { fileName: 'session.v4.jsonl.zstd' });

    const s = ledgerFor(home).summary({ days: 7 });
    const byLabel = (label) => s.workspaces.find((w) => w.label === label);

    // ① v4-only：1 条 1M 未命中 flash（空闲 1.0 元/M）→ 1.0 元
    assert.equal(byLabel('vfour').todayCost, 1.0);
    // ② v3+v4：只认 v4 的 3 条 → 3.0 元；若两个文件都读会是 5.0 元（双计）
    assert.equal(byLabel('dup').todayCost, 3.0);
    assert.equal(byLabel('dup').usageRecords, 3);

    // ③ 自证数字：读了 2 个 v4；dup 的 v3 被登记为被取代，且不产生 gap
    assert.equal(s.diagnostics.sessionFileVersions.v4, 2);
    assert.equal(s.diagnostics.sessionFileVersions.v3, undefined);
    assert.equal(s.diagnostics.supersededSessionFiles, 1);
    assert.deepEqual(s.diagnostics.supersededSamples, [
      { sessionId: 's-dup', used: 'session.v4.jsonl.zstd', ignored: ['session.v3.jsonl.zstd'] },
    ]);
    assert.equal(s.gaps.some((g) => g.kind === 'session-log-missing'), false, JSON.stringify(s.gaps));
  } finally {
    cleanup(home);
  }
});

/** 某个 cwd 的编码目录名（与 DSH 口径一致）。 */
function workspaceKeyOf(cwd) {
  return encodeWorkspaceKey(cwd);
}
