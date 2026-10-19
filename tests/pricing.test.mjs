/**
 * 价格口径测试：默认表数值、计费公式、峰谷边界、覆盖可配置、价格版本分段。
 * 用法：node --test tests/pricing.test.mjs
 */
import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { enumerateSessions } from '../lib/ledger.js';
import { analyzeSessionFile } from '../lib/session-log.js';
import {
  BUILTIN_VERSION_ID,
  DEFAULT_PRICING,
  activeVersionId,
  appendVersion,
  coverageHoles,
  familyOf,
  isPeak,
  normalizePricing,
  parseClock,
  parseInstant,
  priceUsage,
  resolvePrice,
  segmentMatches,
  tierOf,
  toPlainPricing,
  versionsForClient,
} from '../lib/pricing.js';
import { beijing, beijing as bj } from './helpers/session-fixture.mjs';

const pricing = () => normalizePricing(undefined).pricing;
const million = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 1_000_000 };

test('默认表：flash / pro 两档的空闲单价与契约一致', () => {
  const p = pricing();
  assert.deepEqual(p.families.flash, { cacheRead: 0.02, cacheMiss: 1.0, output: 4.0 });
  assert.deepEqual(p.families.pro, { cacheRead: 0.15, cacheMiss: 4.5, output: 13.5 });
  assert.equal(p.peakMultiplier, 2);
  assert.equal(p.currency, 'CNY');
  assert.equal(p.effectiveFrom, '2026-09-10T12:00:00+08:00');
  assert.equal(DEFAULT_PRICING.fallbackFamily, 'flash');
});

test('计费桶：cacheRead×hit + input×miss + output×out；reasoning 已含在 output 内不得再加', () => {
  const p = pricing();
  const t = bj(2026, 9, 14, 22, 0); // 周一晚：空闲
  const usage = { cacheReadTokens: 1_000_000, inputTokens: 1_000_000, outputTokens: 700_000, reasoningTokens: 300_000, totalTokens: 2_700_000 };
  const flash = priceUsage(usage, 'deepseek-flash', t, p);
  assert.equal(flash.cost, 0.02 + 1.0 + 0.7 * 4.0);
  assert.equal(flash.reasoningCountedSeparately, false);
  assert.equal(flash.outputBillableTokens, 700_000);
  const pro = priceUsage(usage, 'deepseek-v4-pro', t, p);
  assert.equal(pro.cost, 0.15 + 4.5 + 0.7 * 13.5);
  // 对照口径（旧契约）：显式开关才把 reasoning 再加一遍
  const legacyPricing = normalizePricing({ reasoningIncludedInOutput: false }).pricing;
  const legacy = priceUsage(usage, 'deepseek-flash', t, legacyPricing);
  assert.equal(legacy.reasoningCountedSeparately, true);
  assert.equal(legacy.outputBillableTokens, 1_000_000);
  assert.equal(legacy.cost, 0.02 + 1.0 + 1.0 * 4.0);
  assert.ok(legacy.cost > flash.cost, '旧口径必然大于正确口径（这正是要防的虚增）');
});

test('默认口径下 reasoning 不会改变费用（防回退到 output+reasoning）', () => {
  const p = pricing();
  const t = bj(2026, 9, 14, 22, 0);
  const base = { inputTokens: 0, outputTokens: 1000, cacheReadTokens: 0, totalTokens: 1000 };
  const withReasoning = { ...base, reasoningTokens: 1000 };
  assert.equal(priceUsage(base, 'deepseek-flash', t, p).cost, priceUsage(withReasoning, 'deepseek-flash', t, p).cost);
});

test('高峰价 = 空闲价 × 2；reasoning 不影响高峰/空闲比值', () => {
  const p = pricing();
  const peak = bj(2026, 9, 14, 10, 0);
  const idle = bj(2026, 9, 14, 22, 0);
  const a = priceUsage({ ...million, reasoningTokens: 0 }, 'deepseek-flash', peak, p);
  const b = priceUsage({ ...million, reasoningTokens: 0 }, 'deepseek-flash', idle, p);
  assert.equal(a.cost, b.cost * 2);
  assert.equal(a.idleCost, b.cost);
  assert.equal(a.peakSurcharge, b.cost);
  const withReasoning = priceUsage({ inputTokens: 0, outputTokens: 500_000, reasoningTokens: 500_000, cacheReadTokens: 0, totalTokens: 1_000_000 }, 'deepseek-flash', idle, p);
  assert.equal(withReasoning.cost, 2.0, '只按 output 的 500k 计费');
});

test('峰谷边界（北京时间 2026-09-14 周一 / 09-19 周六 / 09-20 周日）逐点到界', () => {
  const p = pricing();
  const cases = [
    [bj(2026, 9, 14, 8, 59), false, 1],
    [bj(2026, 9, 14, 9, 0), true, 2],
    [bj(2026, 9, 14, 11, 59), true, 2],
    [bj(2026, 9, 14, 12, 0), false, 1],
    [bj(2026, 9, 14, 13, 59), false, 1],
    [bj(2026, 9, 14, 14, 0), true, 2],
    [bj(2026, 9, 14, 17, 59), true, 2],
    [bj(2026, 9, 14, 18, 0), false, 1],
    [bj(2026, 9, 18, 10, 0), true, 2], // 周五
    [bj(2026, 9, 19, 10, 0), false, 1], // 周六全天空闲
    [bj(2026, 9, 20, 10, 0), false, 1], // 周日全天空闲
  ];
  for (const [t, peak, factor] of cases) {
    assert.equal(isPeak(t, p), peak, `isPeak @ ${new Date(t).toISOString()}`);
    const priced = priceUsage(million, 'deepseek-flash', t, p);
    assert.equal(priced.peak, peak);
    assert.equal(priced.priceFactor, factor);
    assert.equal(priced.cost, 1.0 * factor);
  }
});

test('未知模型回退 flash 档但标记 known=false；deepseek-v4-pro 走 pro 档', () => {
  const p = pricing();
  const t = bj(2026, 9, 14, 22, 0);
  assert.equal(familyOf('deepseek-v4-pro', p).family, 'pro');
  assert.equal(familyOf('deepseek-v4-flash-vision-exp', p).family, 'flash');
  const unknown = priceUsage(million, 'some-unknown-model', t, p);
  assert.equal(unknown.family, 'flash');
  assert.equal(unknown.known, false);
  assert.equal(unknown.cost, 1.0);
  assert.equal(tierOf('deepseek-v4-pro', p).tierName, 'pro');
});

test('价格表必须可覆盖：改 families 后同一份用量费用随之变化（反硬编码）', () => {
  const t = bj(2026, 9, 14, 22, 0);
  const base = pricing();
  const before = priceUsage(million, 'deepseek-flash', t, base).cost;
  const overridden = normalizePricing({ families: { flash: { cacheMiss: 7 } } }).pricing;
  const after = priceUsage(million, 'deepseek-flash', t, overridden).cost;
  assert.equal(before, 1.0);
  assert.equal(after, 7.0);
  assert.notEqual(before, after);
  // models 映射也可覆盖
  const remapped = normalizePricing({ models: { 'some-unknown-model': 'pro' } }).pricing;
  assert.equal(priceUsage(million, 'some-unknown-model', t, remapped).cost, 4.5);
});

test('非法覆盖值记入 problems 而不是静默生效', () => {
  const bad = normalizePricing({ families: { flash: { cacheMiss: -1 } }, models: { x: 42 }, peakMultiplier: 0.5 });
  assert.ok(bad.problems.length >= 3, JSON.stringify(bad.problems));
  assert.equal(bad.pricing.families.flash.cacheMiss, 1.0);
});

test('parseInstant：裸日期时间按北京时间解释；parseClock 支持 24:00', () => {
  assert.equal(parseInstant('2026-09-10 12:00'), Date.UTC(2026, 8, 10, 4, 0));
  assert.equal(parseInstant(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(parseInstant('not-a-time'), null);
  assert.equal(parseClock('09:00'), 540);
  assert.equal(parseClock('24:00'), 1440);
  assert.equal(parseClock('24:01'), null);
  assert.equal(parseClock('9:00'), 540);
});

test('segmentMatches：左闭右开 + 跨夜区间', () => {
  const wrap = { days: [1], from: '22:00', to: '02:00' };
  assert.equal(segmentMatches(wrap, 1, 22 * 60), true);
  assert.equal(segmentMatches(wrap, 1, 23 * 60 + 59), true);
  assert.equal(segmentMatches(wrap, 1, 1 * 60 + 59), true);
  assert.equal(segmentMatches(wrap, 1, 2 * 60), false);
  assert.equal(segmentMatches(wrap, 2, 1 * 60), false); // 星期二不在 days 里
  assert.equal(segmentMatches({ days: [1], from: '09:00', to: '12:00' }, 1, 11 * 60 + 59), true);
  assert.equal(segmentMatches({ days: [1], from: '09:00', to: '12:00' }, 1, 12 * 60), false);
});

test('价格版本：追加版本只对 effectiveFrom 之后生效，之前沿用旧价', () => {
  const base = normalizePricing(undefined).pricing;
  const effectiveFrom = bj(2026, 9, 15, 0, 0);
  const appended = appendVersion(base, {
    effectiveFrom,
    note: '涨价',
    models: { flash: { segments: [{ id: 'flat', label: '统一价', days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '24:00', hit: 1, miss: 9, out: 9 }] } },
  });
  assert.deepEqual(appended.problems, []);
  assert.equal(appended.pricing.versions.length, 1);
  const p = appended.pricing;
  const before = bj(2026, 9, 14, 22, 0);
  const after = bj(2026, 9, 16, 22, 0);
  assert.equal(priceUsage(million, 'deepseek-flash', before, p).cost, 1.0);
  assert.equal(priceUsage(million, 'deepseek-flash', after, p).cost, 9.0);
  assert.equal(priceUsage(million, 'deepseek-flash', after, p).versionId, appended.version.id);
  assert.equal(activeVersionId(p, after), appended.version.id);
  assert.equal(activeVersionId(p, before), BUILTIN_VERSION_ID);
});

test('价格版本：models 为空时**拒绝**追加（约定 5 禁止继承上一版本）', () => {
  const base = normalizePricing(undefined).pricing;
  const empty = appendVersion(base, { effectiveFrom: bj(2026, 9, 15, 0, 0), models: {} });
  assert.ok(empty.problems.some((p) => /models 必须完整给出/.test(p)), JSON.stringify(empty.problems));
  assert.equal(empty.version, null);
  assert.equal(empty.pricing.versions.length, 0, '被拒绝时不得写入任何版本');
  // 缺 models 同样拒绝
  const missing = appendVersion(base, { effectiveFrom: bj(2026, 9, 15, 0, 0) });
  assert.ok(missing.problems.some((p) => /models 必须完整给出/.test(p)));
  assert.equal(missing.pricing.versions.length, 0);
});

test('价格版本：分段覆盖不到时**未计价**（source=unpriced、cost=0），禁止跨版本回退（约定 2）', () => {
  const base = normalizePricing(undefined).pricing;
  const appended = appendVersion(base, {
    effectiveFrom: bj(2026, 9, 15, 0, 0),
    models: { flash: { segments: [{ id: 'only-monday', days: [1], from: '00:00', to: '24:00', hit: 5, miss: 5, out: 5 }] } },
  });
  // 该版本只覆盖周一 → 系统会给出未覆盖警告（接受但警告）
  assert.ok(appended.warnings.some((w) => /未覆盖时段/.test(w)), JSON.stringify(appended.warnings));
  const p = appended.pricing;
  const monday = priceUsage(million, 'deepseek-flash', bj(2026, 9, 21, 12, 0), p);
  assert.equal(monday.cost, 5.0);
  assert.equal(monday.source, 'version');
  assert.equal(monday.unpriced, false);
  // 周二：该版本没有段命中 → **未计价**，不得回退到内置版本的价格
  const tuesday = priceUsage(million, 'deepseek-flash', bj(2026, 9, 22, 12, 0), p);
  assert.equal(tuesday.source, 'unpriced');
  assert.equal(tuesday.unpriced, true);
  assert.equal(tuesday.cost, 0, '未计价即金额 0，绝不悄悄用更早版本价格顶上');
  assert.equal(tuesday.versionId, appended.version.id);
  assert.equal(tuesday.rates.out, 0);
  // coverageHoles 能算出来
  const holes = coverageHoles(appended.version.models);
  assert.equal(holes.length, 1);
  assert.equal(holes[0].family, 'flash');
  assert.ok(holes[0].missingMinutes > 0);
});

test('匹配语义（约定 2）：days 空数组/缺省 = 全部七天；多段命中按声明顺序取第一条', () => {
  const base = normalizePricing(undefined).pricing;
  // days 缺省 = 全部七天
  const appended = appendVersion(base, {
    effectiveFrom: bj(2026, 9, 15, 0, 0),
    models: { flash: { segments: [
      { id: 'first-all', from: '00:00', to: '24:00', hit: 1, miss: 1, out: 1 }, // 缺省 days → 全部七天
      { id: 'second-never', days: [], from: '00:00', to: '24:00', hit: 9, miss: 9, out: 9 }, // 空数组 → 全部七天，但排在后面
    ] } },
  });
  assert.deepEqual(appended.problems, []);
  assert.deepEqual(appended.warnings, [], '两段合起来 24/7 全覆盖，不应有洞');
  assert.deepEqual(appended.version.models.flash.segments[0].days, [1, 2, 3, 4, 5, 6, 7]);
  const resolved = resolvePrice(bj(2026, 9, 20, 10, 0), 'deepseek-flash', appended.pricing); // 周日
  assert.equal(resolved.segmentId, 'first-all', '多段命中取声明顺序第一条');
  assert.equal(resolved.priced, true);
  // days 含非法项必须报错
  assert.ok(normalizePricing({ versions: [{ effectiveFrom: 1, models: { flash: { segments: [{ days: [0, 9], from: '00:00', to: '24:00', hit: 1, miss: 1, out: 1 }] } } }] }).problems.some((p) => /只能包含 1\.\.7/.test(p)));
});

test('时间戳精度归一（约定 2）：effectiveFrom 与记录比较前都向下取整到分钟', () => {
  const t0 = Date.UTC(2026, 8, 15, 4, 30, 0); // 北京时间 12:30:00
  const version = { effectiveFrom: t0 + 25_000, id: 'v-minute', models: { flash: { segments: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '24:00', hit: 7, miss: 7, out: 7 }] } } };
  const p = normalizePricing({ versions: [version] }).pricing;
  assert.equal(p.versions[0].effectiveFrom, t0, '版本生效时刻被归一到分钟');
  // 同一分钟内的记录（t0+10s）应归属这一版，而不是上一版
  const sameMinute = priceUsage(million, 'deepseek-flash', t0 + 10_000, p);
  assert.equal(sameMinute.versionId, 'v-minute');
  assert.equal(sameMinute.cost, 7.0);
  // 前一分钟的记录不属于这一版 → 落到内置版本
  const before = priceUsage(million, 'deepseek-flash', t0 - 60_000, p);
  assert.equal(before.versionId, 'builtin-2026-09-10');
});

test('versionsForClient：内置版本在最前，面板可从最后一个取模板', () => {
  const p = appendVersion(normalizePricing(undefined).pricing, {
    effectiveFrom: bj(2026, 9, 15, 0, 0),
    models: { flash: { segments: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '24:00', hit: 1, miss: 2, out: 3 }] } },
  }).pricing;
  const versions = versionsForClient(p);
  assert.equal(versions.length, 2);
  assert.equal(versions[0].id, BUILTIN_VERSION_ID);
  assert.equal(versions[0].builtin, true);
  assert.equal(versions[1].builtin, false);
  const segments = versions[0].models.flash.segments;
  // 约定 3：默认版本 = 两段工作日高峰 + 一条全部七天兜底（24/7 全覆盖）
  assert.deepEqual(segments.map((s) => s.id), ['flash-peak-1', 'flash-peak-2', 'flash-offpeak-all']);
  assert.equal(segments[0].hit, 0.04);
  assert.deepEqual(segments[2].days, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(segments[2].from, '00:00');
  assert.equal(segments[2].to, '24:00');
  assert.deepEqual(coverageHoles({ flash: { segments } }), [], '默认版本必须 24/7 无洞');
  // 内置版本内置覆盖一整周：任意时刻都能解析出 segment
  for (const [y, m, d] of [[2026, 9, 19], [2026, 9, 20], [2026, 9, 14]]) {
    for (const hour of [0, 3, 9, 12, 14, 18, 23]) {
      const resolved = resolvePrice(bj(y, m, d, hour), 'deepseek-flash', pricing());
      assert.notEqual(resolved.segmentId, null, `${y}-${m}-${d} ${hour}:00 无 segment`);
      assert.equal(resolved.source, 'version');
    }
  }
});

test('货币切换：CNY / USD 两套内置价表按契约数值出厂，高峰 = 空闲 × 2', () => {
  const cny = normalizePricing(undefined).pricing;
  const usd = normalizePricing({ currency: 'USD' }).pricing;
  assert.equal(cny.currency, 'CNY');
  assert.deepEqual(cny.families.flash, { cacheRead: 0.02, cacheMiss: 1.0, output: 4.0 });
  assert.deepEqual(cny.families.pro, { cacheRead: 0.15, cacheMiss: 4.5, output: 13.5 });
  assert.deepEqual(usd.families.flash, { cacheRead: 0.003, cacheMiss: 0.15, output: 0.6 });
  assert.deepEqual(usd.families.pro, { cacheRead: 0.022, cacheMiss: 0.66, output: 1.98 });
  const idle = bj(2026, 9, 14, 22, 0);
  const peak = bj(2026, 9, 14, 10, 0);
  // 逐个数字对照契约里给出的高峰价
  const cases = [
    [cny, 'flash', { cacheReadTokens: 1e6 }, 0.02, 0.04],
    [cny, 'flash', { inputTokens: 1e6 }, 1.0, 2.0],
    [cny, 'flash', { outputTokens: 1e6 }, 4.0, 8.0],
    [cny, 'deepseek-v4-pro', { cacheReadTokens: 1e6 }, 0.15, 0.3],
    [cny, 'deepseek-v4-pro', { inputTokens: 1e6 }, 4.5, 9.0],
    [cny, 'deepseek-v4-pro', { outputTokens: 1e6 }, 13.5, 27.0],
    [usd, 'flash', { cacheReadTokens: 1e6 }, 0.003, 0.006],
    [usd, 'flash', { inputTokens: 1e6 }, 0.15, 0.3],
    [usd, 'flash', { outputTokens: 1e6 }, 0.6, 1.2],
    [usd, 'deepseek-v4-pro', { cacheReadTokens: 1e6 }, 0.022, 0.044],
    [usd, 'deepseek-v4-pro', { inputTokens: 1e6 }, 0.66, 1.32],
    [usd, 'deepseek-v4-pro', { outputTokens: 1e6 }, 1.98, 3.96],
  ];
  for (const [table, model, usage, offPrice, peakPrice] of cases) {
    assert.equal(priceUsage(usage, model, idle, table).cost, offPrice, `${table.currency}/${model} 空闲 ${JSON.stringify(usage)}`);
    assert.equal(priceUsage(usage, model, peak, table).cost, peakPrice, `${table.currency}/${model} 高峰 ${JSON.stringify(usage)}`);
  }
  // 新币种：显式提供 rates 表即可切换
  const jpy = normalizePricing({ rates: { JPY: { flash: { cacheRead: 1, cacheMiss: 2, output: 3 } } }, currency: 'JPY' }).pricing;
  assert.equal(jpy.currency, 'JPY');
  assert.equal(priceUsage({ inputTokens: 1e6 }, 'deepseek-flash', idle, jpy).cost, 2);
  // 选了没有表的币种 → 显式告警并退回默认货币（不静默按错价计费）
  const missing = normalizePricing({ currency: 'JPY' });
  assert.ok(missing.problems.some((problem) => /没有 JPY 表/.test(problem)), JSON.stringify(missing.problems));
  assert.equal(missing.pricing.currency, 'CNY');
  // families 是「当前货币」的简写覆盖，不动其它币种
  const over = normalizePricing({ currency: 'USD', families: { flash: { cacheMiss: 1 } } }).pricing;
  assert.equal(over.families.flash.cacheMiss, 1);
  assert.equal(over.rates.USD.flash.cacheMiss, 1);
  assert.equal(over.rates.CNY.flash.cacheMiss, 1, 'CNY 表不受影响');
});

test('inputIncludesCacheRead 对照口径：默认关闭，开启时未命中桶夹到 >= 0', () => {
  const p = normalizePricing(undefined).pricing;
  assert.equal(p.inputIncludesCacheRead, false, '默认必须是互斥桶口径');
  assert.equal(p.reasoningIncludedInOutput, true);
  const t = bj(2026, 9, 14, 22, 0);
  const usage = { inputTokens: 739, cacheReadTokens: 16256, outputTokens: 199, reasoningTokens: 98, totalTokens: 17194 };
  const a = priceUsage(usage, 'deepseek-flash', t, p);
  assert.equal(a.missTokens, 739, '默认：inputTokens 本身就是未命中桶');
  assert.ok(Math.abs(a.cost - (16256 * 0.02 + 739 * 1 + 199 * 4) / 1e6) < 1e-12);
  const alt = normalizePricing({ inputIncludesCacheRead: true }).pricing;
  const c = priceUsage(usage, 'deepseek-flash', t, alt);
  assert.equal(c.missTokens, 0, 'input < cacheRead → 未命中桶被夹成 0');
  assert.ok(Math.abs(c.cost - (16256 * 0.02 + 199 * 4) / 1e6) < 1e-12);
  // input 真的大于 cacheRead 时，对照口径只取差值
  assert.equal(priceUsage({ inputTokens: 3000, cacheReadTokens: 1000 }, 'deepseek-flash', t, alt).missTokens, 2000);
  // 非法类型被拒绝
  assert.ok(normalizePricing({ inputIncludesCacheRead: 'yes' }).problems.some((x) => /inputIncludesCacheRead/.test(x)));
});

test('回归守卫：inputTokens 即未命中桶（错误公式会把它减成 0），且 reasoning 不另加', () => {
  // 取真实样本形状：cacheReadTokens(16256) > inputTokens(739) —— 全语料 98.9%~99.2% 的记录都长这样。
  const p = normalizePricing(undefined).pricing;
  const t = bj(2026, 9, 14, 22, 0); // 空闲
  const sample = { inputTokens: 739, cacheReadTokens: 16256, outputTokens: 199, reasoningTokens: 98, totalTokens: 17194 };

  const priced = priceUsage(sample, 'deepseek-flash', t, p);
  // ① miss 桶必须等于 inputTokens；若有人把「input 含 cacheRead」写回来，这里会变成 0 → 立刻变红
  assert.equal(priced.missTokens, sample.inputTokens, 'miss 桶 == inputTokens（错误公式下为 0）');
  assert.notEqual(priced.missTokens, 0);
  // ② 费用必须等于「hit×cacheRead + miss×input + out×output」，不含 reasoning
  assert.ok(Math.abs(priced.cost - (16256 * 0.02 + 739 * 1.0 + 199 * 4.0) / 1e6) < 1e-12, `实际 ${priced.cost}`);
  // ③ 若把 reasoning 再加一遍会明显更大（本例 +0.000392 元）
  const wrongReasoning = priceUsage(sample, 'deepseek-flash', t, { ...p, reasoningIncludedInOutput: false });
  assert.ok(wrongReasoning.cost > priced.cost);
  assert.ok(Math.abs(wrongReasoning.cost - priced.cost - (98 * 4.0) / 1e6) < 1e-12);
  // ④ 逐条求和：未命中桶总量必须等于 Σ inputTokens（错误公式会丢掉绝大部分）
  const batch = [
    { inputTokens: 739, cacheReadTokens: 16256, outputTokens: 199, reasoningTokens: 98 },
    { inputTokens: 289, cacheReadTokens: 22656, outputTokens: 54, reasoningTokens: 0 },
    { inputTokens: 4506, cacheReadTokens: 18048, outputTokens: 125, reasoningTokens: 8 },
  ];
  const sumInput = batch.reduce((acc, u) => acc + u.inputTokens, 0);
  const sumMiss = batch.reduce((acc, u) => acc + priceUsage(u, 'deepseek-flash', t, p).missTokens, 0);
  assert.equal(sumMiss, sumInput, '未命中桶总量 == Σ inputTokens');
  const wrongPricing = normalizePricing({ inputIncludesCacheRead: true }).pricing;
  const sumWrongMiss = batch.reduce((acc, u) => acc + priceUsage(u, 'deepseek-flash', t, wrongPricing).missTokens, 0);
  assert.equal(sumWrongMiss, 0, '错误口径下这三条记录的未命中桶全部变成 0（这就是要防的缺陷）');
  assert.ok(sumWrongMiss < sumMiss, '错误口径必然丢掉未命中桶');
  // ⑤ 明确锁死「reasoning 不加」：与 (output+reasoning) 口径必须**不等**
  const correctOut = (16256 * 0.02 + 739 * 1.0 + 199 * 4.0) / 1e6;
  const wrongOut = (16256 * 0.02 + 739 * 1.0 + (199 + 98) * 4.0) / 1e6;
  assert.ok(Math.abs(priced.cost - correctOut) < 1e-12, `cost 必须等于 output-only 口径：${priced.cost} vs ${correctOut}`);
  assert.ok(Math.abs(priced.cost - wrongOut) > 1e-9, 'cost 必须**不等于** (output+reasoning) 口径（明确锁死 reasoning 不加）');
});

test('运行时权威 = 段绝对值：改 peakMultiplier 不影响显式版本的计费（倍率不参与计费）', () => {
  const appended = appendVersion(normalizePricing(undefined).pricing, {
    effectiveFrom: bj(2026, 10, 1, 0, 0),
    models: { flash: { segments: [{ days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '24:00', hit: 0.02, miss: 1, out: 4 }] } },
  }).pricing;
  const at = bj(2026, 10, 5, 10, 0); // 周一上午；显式版本是全天统一价
  const before = priceUsage(million, 'deepseek-flash', at, appended).cost;
  const bumped = normalizePricing({ ...toPlainPricing(appended), peakMultiplier: 9 }).pricing;
  const after = priceUsage(million, 'deepseek-flash', at, bumped).cost;
  assert.equal(before, 1.0);
  assert.equal(after, before, '倍率变了，显式版本的计费必须一字不变');
  // 追加的版本不会被倍率二次加工：段里的绝对值原样保留
  assert.equal(bumped.versions[0].models.flash.segments[0].miss, 1);
  assert.equal(bumped.versions[0].models.flash.segments[0].out, 4);
  // 倍率只影响**内置默认版本**的构造（段一旦生成即为绝对值）
  assert.equal(priceUsage(million, 'deepseek-flash', at, normalizePricing(undefined).pricing).cost, 2.0);
  assert.equal(priceUsage(million, 'deepseek-flash', at, normalizePricing({ peakMultiplier: 3 }).pricing).cost, 3.0);
});

test('真实语料回归：inputTokens < cacheReadTokens 的记录，miss 桶 == inputTokens（不是 0），且 output 未被加 reasoning', (t) => {
  // 契约验收补充（维护者 + 独立验证者共同建议）：
  // 取**真实记录**中 cacheReadTokens>0 且 inputTokens<cacheReadTokens 的样本，断言
  //   miss 桶 == inputTokens（错误公式下会是 0）
  //   output 桶没有被额外加上 reasoningTokens
  // 本地没有真实会话日志时**显式跳过**（不是静默通过）。
  const sessionsRoot = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : join(homedir(), '.dsh', 'sessions');
  if (!existsSync(sessionsRoot)) {
    t.skip(`本地没有真实会话日志（${sessionsRoot}），跳过真实语料断言`);
    return;
  }
  const { workspaces } = enumerateSessions(sessionsRoot);
  // 优先挑**小文件**（中位数 ≈ 445 KB），既拿到真实样本又不拖慢测试
  const candidates = [];
  for (const ws of workspaces) {
    for (const file of ws.files) {
      let size = Number.MAX_SAFE_INTEGER;
      try {
        size = statSync(file.filePath).size;
      } catch {
        continue;
      }
      candidates.push({ file, size });
    }
  }
  candidates.sort((a, b) => a.size - b.size);
  const samples = [];
  let filesRead = 0;
  for (const candidate of candidates) {
    if (samples.length >= 60 || filesRead >= 8) break;
    let analysis;
    try {
      analysis = analyzeSessionFile(candidate.file.filePath);
    } catch {
      continue;
    }
    // 只把**真正含用量**的文件计入配额：会话格式升级后同一目录会换成 v4 文件，
    // 而最小的文件常常是「只有会话头、没有用量」的空日志——若照旧按文件计数，
    // 它们会把 6 个配额吃光，导致样本数为 0 而整条真实语料断言静默跳过。
    if (analysis.usageRecordCount === 0) continue;
    filesRead += 1;
    for (const row of analysis.usages) {
      const u = row.usage ?? {};
      if ((u.cacheReadTokens ?? 0) > 0 && (u.inputTokens ?? 0) < (u.cacheReadTokens ?? 0)) samples.push(u);
    }
  }
  if (samples.length < 10) {
    t.skip(`真实语料里只找到 ${samples.length} 条满足 input<cacheRead 的样本（<10），跳过`);
    return;
  }

  const p = normalizePricing(undefined).pricing;
  const wrongBuckets = normalizePricing({ inputIncludesCacheRead: true }).pricing;
  const wrongReasoning = normalizePricing({ reasoningIncludedInOutput: false }).pricing;
  const at = bj(2026, 9, 14, 22, 0); // 空闲
  let sumInput = 0;
  let sumMiss = 0;
  let sumMissWrong = 0;
  let costCorrect = 0;
  let costWrongBuckets = 0;
  let costWrongReasoning = 0;
  for (const u of samples) {
    const priced = priceUsage(u, 'deepseek-flash', at, p);
    sumInput += u.inputTokens ?? 0;
    sumMiss += priced.missTokens;
    sumMissWrong += priceUsage(u, 'deepseek-flash', at, wrongBuckets).missTokens;
    costCorrect += priced.cost;
    costWrongBuckets += priceUsage(u, 'deepseek-flash', at, wrongBuckets).cost;
    costWrongReasoning += priceUsage(u, 'deepseek-flash', at, wrongReasoning).cost;
  }
  // ① miss 桶必须等于 Σ inputTokens；错误口径会把它夹成 0
  assert.equal(sumMiss, sumInput, `miss 桶应等于 Σ inputTokens（${sumInput}），实际 ${sumMiss}`);
  assert.ok(sumInput > 0);
  assert.equal(sumMissWrong, 0, '错误口径下这批真实样本的未命中桶全部变成 0（正是要防的缺陷）');
  // ② output 不得被额外加 reasoning：错误口径必然更大，且差额恰为 Σreasoning×out
  assert.ok(costWrongReasoning > costCorrect, '再加 reasoning 必然更大');
  const reasoningTokens = samples.reduce((acc, u) => acc + (u.reasoningTokens ?? 0), 0);
  assert.ok(Math.abs(costWrongReasoning - costCorrect - (reasoningTokens * 4.0) / 1e6) < 1e-9);
  // ③ 错误口径（input 当含 cache + 加 reasoning）与正确口径的偏差方向
  assert.notEqual(costWrongBuckets, costCorrect);
  t.diagnostic(
    `真实样本 ${samples.length} 条（读 ${filesRead} 个文件）：Σinput=${sumInput} / Σmiss=${sumMiss} / 错误口径 Σmiss=${sumMissWrong}；`
      + `正确 ${costCorrect.toFixed(6)} 元，错误①（加 reasoning）${costWrongReasoning.toFixed(6)} 元（+${(((costWrongReasoning - costCorrect) / costCorrect) * 100).toFixed(2)}%），`
      + `错误②（input 含 cache + 加 reasoning）${costWrongBuckets.toFixed(6)} 元`,
  );
});

test('appendVersion 的非法输入被拒绝而不是静默忽略', () => {
  const base = normalizePricing(undefined).pricing;
  const bad = appendVersion(base, { effectiveFrom: 'nope', models: {} });
  assert.ok(bad.problems.length > 0);
  assert.equal(bad.version, null);
  assert.equal(bad.pricing.versions.length, 0);
});
