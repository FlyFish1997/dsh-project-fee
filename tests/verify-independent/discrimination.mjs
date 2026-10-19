// 独立验证：**判别力分析**（维护者采纳 浏览器侧实现的方法论，升级判据）
//
// 旧判据：这条断言会不会红？（只区分「正/反」，是弱断言）
// 新判据：这条断言能区分**几种**候选错法？
//   做法：先枚举候选错法 → 再用断言采用的取值算出各错法的结果 →
//         若两个错法给出**相同结果**，则该取值无法分离它们（弱断言）。
//
// 说明：本脚本里的「候选错法」全部由验证者**独立实现**，不复用被测代码；
//       它只做**取值分离性**分析（不依赖实现当前是否正确）。
// 「实现回退到某错法时断言真的会红」由 mutation-guard.mjs 的变异体实证覆盖。
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./harness/runner.mjs";
import { beijingEpoch } from "./harness/pricing.mjs";

const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== 判别力分析：每条口径断言能区分几种错法 ===");

// 期初判据：把「候选错法集合」定义清楚，再看取值能否两两分离
function separability(name, candidates, fixtures, valueOf) {
  const rows = candidates.map((c) => ({
    id: c.id,
    values: fixtures.map((f) => valueOf(c, f)),
  }));
  // 两两比较：若对**所有** fixture 取值都相同 → 该 fixture 集无法分离这两个错法
  const collisions = [];
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const same = rows[i].values.every((v, k) => Object.is(v, rows[j].values[k]));
      if (same) collisions.push(`${rows[i].id} ≡ ${rows[j].id}`);
    }
  }
  const n = rows.length;
  const pairs = (n * (n - 1)) / 2;
  const separated = pairs - collisions.length;
  console.log(`\n-- ${name} --`);
  console.log(`  候选错法 ${n} 个 → 两两组合 ${pairs} 对，可分离 ${separated} 对，冲突 ${collisions.length} 对`);
  console.log(`  ${"候选".padEnd(30)} ${fixtures.map((f, i) => `f${i}`).join("   ")}`);
  for (const r of rows) console.log(`  ${r.id.padEnd(30)} ${r.values.map((v) => String(typeof v === "number" ? +v.toFixed(9) : v).padStart(10)).join("   ")}`);
  if (collisions.length) for (const c of collisions) console.log(`    ⚠ 无法分离：${c}`);
  return { collisions, pairs, separated, n };
}

// ---------------- 1) 计费公式 ----------------
// 采用被测套件真实使用的夹具值（pricing.test.mjs 的 739/16256/199/98 与 700k/300k 两组）
const P_FIXTURES = [
  { id: "739/16256/199/98", u: { inputTokens: 739, cacheReadTokens: 16256, outputTokens: 199, reasoningTokens: 98 }, peak: false },
  { id: "700k/1M/300k", u: { inputTokens: 1_000_000, cacheReadTokens: 1_000_000, outputTokens: 700_000, reasoningTokens: 300_000 }, peak: false },
  { id: "0/0/500k/500k", u: { inputTokens: 0, cacheReadTokens: 0, outputTokens: 500_000, reasoningTokens: 500_000 }, peak: false },
];
const RATE = { flash: { off: { hit: 0.02, miss: 1.0, out: 4.0 }, peak: { hit: 0.04, miss: 2.0, out: 8.0 } }, pro: { off: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.3, miss: 9.0, out: 27.0 } } };
const P_CANDIDATES = [
  { id: "✅ correct (input即未命中;output含思考)", fn: (u, r) => (u.cacheReadTokens / 1e6) * r.hit + (u.inputTokens / 1e6) * r.miss + (u.outputTokens / 1e6) * r.out },
  { id: "❌ W1 加 reasoning 一次", fn: (u, r) => (u.cacheReadTokens / 1e6) * r.hit + (u.inputTokens / 1e6) * r.miss + ((u.outputTokens + u.reasoningTokens) / 1e6) * r.out },
  { id: "❌ W2 input 再减 cacheRead", fn: (u, r) => (u.cacheReadTokens / 1e6) * r.hit + (Math.max(0, u.inputTokens - u.cacheReadTokens) / 1e6) * r.miss + (u.outputTokens / 1e6) * r.out },
  { id: "❌ W3 漏计 reasoning（若口径相反）", fn: (u, r) => (u.cacheReadTokens / 1e6) * r.hit + (u.inputTokens / 1e6) * r.miss + ((u.outputTokens - u.reasoningTokens) / 1e6) * r.out },
  { id: "❌ W4 串档（flash 按 pro 价）", fn: (u, r, f) => (u.cacheReadTokens / 1e6) * RATE.pro.off.hit + (u.inputTokens / 1e6) * RATE.pro.off.miss + (u.outputTokens / 1e6) * RATE.pro.off.out },
  { id: "❌ W5 峰/闲取错（闲时按峰价）", fn: (u, r) => (u.cacheReadTokens / 1e6) * RATE.flash.peak.hit + (u.inputTokens / 1e6) * RATE.flash.peak.miss + (u.outputTokens / 1e6) * RATE.flash.peak.out },
];
{
  const res = separability("1) 计费公式（取值取自被测套件真实夹具）", P_CANDIDATES, P_FIXTURES, (c, f) => c.fn(f.u, RATE.flash.off));
  check("计费公式：6 个候选错法两两可分离（含 ③④⑤）", res.collisions.length === 0, res.collisions.join("; "));
}

// ---------------- 2) 桶语义（计费量怎么取） ----------------
const B_CANDIDATES = [
  { id: "✅ correct: cacheRead*hit + input*miss", fn: (u, r) => (u.cacheReadTokens / 1e6) * r.hit + (u.inputTokens / 1e6) * r.miss },
  { id: "❌ 相减 max(0,input-cacheRead)*miss", fn: (u, r) => (u.cacheReadTokens / 1e6) * r.hit + (Math.max(0, u.inputTokens - u.cacheReadTokens) / 1e6) * r.miss },
  { id: "❌ 把 reasoning 当第四桶另加", fn: (u, r) => (u.cacheReadTokens / 1e6) * r.hit + (u.inputTokens / 1e6) * r.miss + (u.reasoningTokens / 1e6) * r.out },
  { id: "❌ 用 totalTokens 当计费量", fn: (u, r) => ((u.totalTokens ?? u.inputTokens + u.cacheReadTokens + u.outputTokens) / 1e6) * r.out },
];
{
  const fx = P_FIXTURES.map((f) => ({ ...f, u: { ...f.u, totalTokens: f.u.inputTokens + f.u.cacheReadTokens + f.u.outputTokens } }));
  const res = separability("2) 桶语义（计费量如何取）", B_CANDIDATES, fx, (c, f) => c.fn(f.u, RATE.flash.off));
  check("桶语义：4 个候选两两可分离", res.collisions.length === 0, res.collisions.join("; "));
}

// ---------------- 3) 预警线阈值 ----------------
const A_CANDIDATES = [
  { id: "✅ correct (null→ok, 0→ok, >=→over, ratio 0.8)", fn: (t, lim, ratio) => (lim === null || !(lim > 0) ? "ok" : t >= lim ? "over" : t >= lim * ratio ? "warn" : "ok") },
  { id: "❌ W1 null 当 0 处理", fn: (t, lim, ratio) => { const L = lim === null ? 0 : lim; return t >= L ? "over" : t >= L * ratio ? "warn" : "ok"; } },
  { id: "❌ W2 limit:0 当有效线", fn: (t, lim, ratio) => (lim === null ? "ok" : t >= lim ? "over" : t >= lim * ratio ? "warn" : "ok") },
  { id: "❌ W3 恰好等于 → warn（而非 over）", fn: (t, lim, ratio) => (lim === null || !(lim > 0) ? "ok" : t > lim ? "over" : t >= lim * ratio ? "warn" : "ok") },
  { id: "❌ W4 ratio 用错分母（lim 当分母）", fn: (t, lim, ratio) => (lim === null || !(lim > 0) ? "ok" : t >= lim ? "over" : t >= lim / (ratio || 1) ? "warn" : "ok") },
];
{
  // 关键取值：让「恰好等于」与「null/0」被分别暴露
  const fx = [
    { t: 1.0, lim: 1.0, ratio: 0.8, note: "恰好等于" },
    { t: 0.9, lim: 1.0, ratio: 0.8, note: "落在 warn 带" },
    { t: 5, lim: null, ratio: 0.8, note: "未设线" },
    { t: 5, lim: 0, ratio: 0.8, note: "线=0" },
    { t: 0.85, lim: 1.0, ratio: 0.8, note: "ratio 边界附近" },
  ];
  const res = separability("3) 预警线阈值", A_CANDIDATES, fx, (c, f) => c.fn(f.t, f.lim, f.ratio));
  check("预警线：5 个候选两两可分离", res.collisions.length === 0, res.collisions.join("; "));
  console.log(`  取值说明：${fx.map((f, i) => `f${i}=${f.note}`).join("，")}`);
}

// ---------------- 4) 峰谷切换点（每点只能一个 segment 命中） ----------------
console.log("\n-- 4) 峰谷切换点：每个时刻只能有一个 segment 命中 --");
const SEGMENTS = [
  { id: "peak-1", days: [1, 2, 3, 4, 5], from: 9 * 60, to: 12 * 60 },
  { id: "peak-2", days: [1, 2, 3, 4, 5], from: 14 * 60, to: 18 * 60 },
  { id: "off-wd", days: [1, 2, 3, 4, 5], from: 0, to: 1440 },
  { id: "off-all", days: [1, 2, 3, 4, 5, 6, 7], from: 0, to: 1440 },
];
function isoWeekday(ms) { const d = new Date(ms + 8 * 3600 * 1000).getUTCDay(); return d === 0 ? 7 : d; }
function minutesOfDay(ms) { const d = new Date(ms + 8 * 3600 * 1000); return d.getUTCHours() * 60 + d.getUTCMinutes(); }
function matches(seg, wd, m) { return seg.days.includes(wd) && m >= seg.from && m < seg.to; }
const PTS = [
  ["工作日 08:59:59", 2026, 9, 14, 8, 59, "off-wd"],
  ["工作日 09:00:00", 2026, 9, 14, 9, 0, "peak-1"],
  ["工作日 11:59:59", 2026, 9, 14, 11, 59, "peak-1"],
  ["工作日 12:00:00", 2026, 9, 14, 12, 0, "off-wd"],
  ["工作日 13:59:59", 2026, 9, 14, 13, 59, "off-wd"],
  ["工作日 14:00:00", 2026, 9, 14, 14, 0, "peak-2"],
  ["工作日 17:59:59", 2026, 9, 14, 17, 59, "peak-2"],
  ["工作日 18:00:00", 2026, 9, 14, 18, 0, "off-wd"],
  ["周六 10:00", 2026, 9, 19, 10, 0, "off-all"],
  ["周日 14:00", 2026, 9, 20, 14, 0, "off-all"],
];
// 候选错法：把区间端点解释成右闭 / 用 UTC 判日 / 周末也算高峰
const PEAK_MODELS = [
  { id: "✅ 正确（左闭右开 + UTC+8 + 周末空闲）", wd: isoWeekday, mod: minutesOfDay, off: false },
  { id: "❌ 端点右闭（12:00 也算高峰）", wd: isoWeekday, mod: minutesOfDay, off: false, rightClosed: true },
  { id: "❌ 用 UTC 判星期/分钟", wd: (ms) => new Date(ms).getUTCDay(), mod: (ms) => new Date(ms).getUTCHours() * 60 + new Date(ms).getUTCMinutes(), off: false },
  { id: "❌ 周末也算高峰", wd: isoWeekday, mod: minutesOfDay, off: true, weekendPeak: true },
];
let segViolations = 0;
console.log(`  ${"时刻".padEnd(18)} 命中数  命中的 segment`);
for (const [label, y, mo, d, h, mi, expectSeg] of PTS) {
  const ms = beijingEpoch(y, mo, d, h, mi, 0);
  const wd = isoWeekday(ms);
  const m = minutesOfDay(ms);
  // 正确模型下：先匹配高峰段，再空闲兜底（与实现的段顺序语义一致）
  const hitsPeak = SEGMENTS.slice(0, 2).filter((s) => matches(s, wd, m)).map((s) => s.id);
  const hitsIdle = SEGMENTS.slice(2).filter((s) => matches(s, wd, m)).map((s) => s.id);
  // 断言：高峰段命中数 <=1；且「高峰命中」与「期望是高峰」一致
  const expectPeak = expectSeg.startsWith("peak");
  const ok = hitsPeak.length === 1 ? expectPeak : hitsPeak.length === 0 ? !expectPeak : false;
  if (!ok) segViolations++;
  console.log(`  ${label.padEnd(18)} ${String(hitsPeak.length).padStart(4)}    ${hitsPeak.length ? hitsPeak.join(",") : "（无高峰段命中 → 落到空闲）"}  ${ok ? "OK" : "FAIL"}`);
  check(`切换点 ${label} 只有单一归属且与期望一致`, ok, `hitsPeak=${hitsPeak.length} expect=${expectSeg}`);
}
check("全部切换点无多命中/零命中", segViolations === 0, `${segViolations} 个违规`);
// 分离性：三种错法在 10 个点上应给出不同的「高峰/空闲」串
{
  const verdict = (model) =>
    PTS.map(([, y, mo, d, h, mi]) => {
      const ms = beijingEpoch(y, mo, d, h, mi, 0);
      let wd = model.wd(ms);
      if (typeof wd === "number" && wd === 0 && model.wd === isoWeekday) wd = 7;
      const m = model.mod(ms);
      const peak = SEGMENTS.slice(0, 2).some((s) => {
        const days = model.weekendPeak ? [1, 2, 3, 4, 5, 6, 7] : s.days;
        return days.includes(wd) && (model.rightClosed ? m >= s.from && m <= s.to : m >= s.from && m < s.to);
      });
      return peak ? "P" : "o";
    }).join("");
  const sigs = PEAK_MODELS.map((mo) => ({ id: mo.id, sig: verdict(mo) }));
  console.log("\n  各模型的「高峰/空闲」指纹（10 个切换点）：");
  for (const s of sigs) console.log(`    ${s.sig}  ${s.id}`);
  const uniq = new Set(sigs.map((s) => s.sig));
  console.log(`  → 互异指纹 ${uniq.size}/${sigs.length}`);
  check("峰谷：4 个候选模型在这 10 个点上指纹互异（取值可分离）", uniq.size === sigs.length, `仅 ${uniq.size} 种指纹`);
}

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}${c.ok ? "" : `（${c.detail}）`}`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
console.log("效力边界：本脚本只做**取值分离性**分析（候选错法由验证者独立实现）。");
console.log("          「实现真的回退到某错法时断言会红」由 mutation-guard.mjs 的变异体实证覆盖。");
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
