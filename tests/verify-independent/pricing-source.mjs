// 独立验证：**定价来源权威性**（维护者点名的两项）
//   甲) 实现在用段表的绝对值是否等于 dsh-context 基准值
//   乙) 运行时定价是否**只**来自「段内绝对值」，而不是「基准价 × 倍率」二次加工
//   丙) 是否存在第二个能定价/能描述价格的来源（分歧探测）
//
// 判据：甲、乙必须成立；丙若发现分歧 → FAIL（验证者无法独立核对单价 = defect）。
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "./harness/runner.mjs";
import { beijingEpoch, RATES_CNY } from "./harness/pricing.mjs";

const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== 定价来源权威性 ===");
if (!existsSync(join(ROOT, "lib/pricing.js"))) {
  console.log("lib/pricing.js 不存在 → 无法验证（不得判 pass）");
  process.exit(2);
}
const P = await import(new URL("../../lib/pricing.js", import.meta.url).href);
const {
  normalizePricing, builtinVersion, allVersions, resolvePrice, priceUsage,
  pricingTableRows, isPeak, activeVersionId,
} = P;

const base = normalizePricing(undefined).pricing;

// ---------- 甲) 段表绝对值 vs dsh-context 基准 ----------
console.log("\n-- 甲) 当前生效版本的段表（绝对值）--");
const builtin = builtinVersion(base);
console.log(`  activeVersionId(builtin) = ${builtin.id}   effectiveFrom = ${new Date(builtin.effectiveFrom).toISOString()}`);
console.log(`  ${"family".padEnd(6)} ${"segment".padEnd(24)} ${"days".padEnd(14)} ${"from-to".padEnd(12)} ${"hit".padStart(6)} ${"miss".padStart(6)} ${"out".padStart(6)}`);
const segRows = [];
for (const family of Object.keys(base.families)) {
  for (const s of builtin.models[family].segments) {
    segRows.push({ family, ...s });
    console.log(`  ${family.padEnd(6)} ${String(s.id).padEnd(24)} ${JSON.stringify(s.days).padEnd(14)} ${(s.from + '-' + s.to).padEnd(12)} ${String(s.hit).padStart(6)} ${String(s.miss).padStart(6)} ${String(s.out).padStart(6)}`);
  }
}
// 基准：dsh-context 的 PRICES（CNY）
const EXPECT = {
  flash: { off: { hit: 0.02, miss: 1.0, out: 4.0 }, peak: { hit: 0.04, miss: 2.0, out: 8.0 } },
  pro: { off: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.3, miss: 9.0, out: 27.0 } },
};
console.log("\n  逐段断言（对照 dsh-context 基准）：");
for (const row of segRows) {
  // 注意：不能用 /peak/ 判类——「offpeak」里也含 "peak"（我第一版就栽在这，导致误报 4 条）
  const kind = /offpeak|off-peak/i.test(row.id) ? "off" : "peak";
  const e = EXPECT[row.family]?.[kind];
  if (!e) { check(`段 ${row.id} 的 family/kind 可识别`, false, `${row.family}/${kind}`); continue; }
  const ok = row.hit === e.hit && row.miss === e.miss && row.out === e.out;
  console.log(`    ${ok ? "OK  " : "FAIL"} ${row.id.padEnd(24)} hit=${row.hit} miss=${row.miss} out=${row.out}  期望 ${JSON.stringify(e)}`);
  check(`段 ${row.id} 绝对单价 == dsh-context 基准`, ok, `got h/m/o=${row.hit}/${row.miss}/${row.out} want ${e.hit}/${e.miss}/${e.out}`);
}
// 峰 = 空闲 × 2
for (const family of Object.keys(EXPECT)) {
  const e = EXPECT[family];
  const ok = e.peak.hit === e.off.hit * 2 && e.peak.miss === e.off.miss * 2 && e.peak.out === e.off.out * 2;
  check(`${family} 峰价 == 空闲价 × 2`, ok, JSON.stringify(e));
}

// ---------- 乙) 运行时定价来源 = 段内绝对值 ----------
console.log("\n-- 乙) 运行时是否只用段内绝对值（把倍率设成无法推出段值的怪值来证伪）--");
// 造一个自定义版本：高峰段用 3.0/5.0/0.5，**故意不等于** 基准 × multiplier
const CUSTOM_PEAK = { hit: 0.5, miss: 3.0, out: 5.0 };
const CUSTOM_IDLE = { hit: 0.02, miss: 1.0, out: 4.0 };
const customVersion = {
  id: "verify-custom-1",
  effectiveFrom: "2026-01-01T00:00:00+08:00",
  note: "独立验证者注入：段值故意 ≠ 基准×倍率",
  models: {
    flash: {
      segments: [
        { id: "v-peak", label: "自定义高峰", days: [1, 2, 3, 4, 5], from: "10:00", to: "11:00", ...CUSTOM_PEAK },
        { id: "v-idle-wd", label: "工作日空闲", days: [1, 2, 3, 4, 5], from: "00:00", to: "24:00", ...CUSTOM_IDLE },
        { id: "v-idle-all", label: "空闲兜底", days: [1, 2, 3, 4, 5, 6, 7], from: "00:00", to: "24:00", ...CUSTOM_IDLE },
      ],
    },
    pro: { segments: [{ id: "v-pro-idle", label: "pro空闲", days: [1, 2, 3, 4, 5, 6, 7], from: "00:00", to: "24:00", hit: 0.15, miss: 4.5, out: 13.5 }] },
  },
};
const withCustom = normalizePricing({ ...base, versions: [customVersion] });
console.log(`  normalizePricing problems = ${JSON.stringify(withCustom.problems)}`);
check("自定义版本被接受（无 problems）", withCustom.problems.length === 0, JSON.stringify(withCustom.problems));
const cp = withCustom.pricing;

{
  const mondayPeak = beijingEpoch(2026, 9, 14, 10, 30); // 周一 10:30 → 命中 v-peak
  const r = resolvePrice(mondayPeak, "deepseek-flash", cp);
  console.log(`  周一 10:30 resolvePrice → ${JSON.stringify(r)}`);
  check("resolvePrice 返回段内绝对值（miss=3.0 而非 1.0×2=2.0）", r.miss === 3.0 && r.hit === 0.5 && r.out === 5.0, JSON.stringify(r));
  check("resolvePrice 标记 source='version'", r.source === "version", `source=${r.source}`);

  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  const got = priceUsage(usage, "deepseek-flash", mondayPeak, cp);
  const expectSeg = (1_000_000 / 1e6) * 3.0;
  const expectMul = (1_000_000 / 1e6) * (1.0 * 2);
  console.log(`  1M miss @周一10:30：实测 ¥${got.cost}  段内绝对值期望 ¥${expectSeg}  「基准×倍率」会是 ¥${expectMul}`);
  check("运行时费用 == 段内绝对值（不是基准×倍率）", got.cost === expectSeg, `got=${got.cost} seg=${expectSeg} mul=${expectMul}`);
}

// ---------- 丙) 分歧探测 ----------
console.log("\n-- 丙) 是否存在第二个定价/描述来源（应无分歧）--");
{
  // C1: /config 暴露的 tiers（pricingTableRows）是否与段内绝对值一致
  const rows = pricingTableRows(cp);
  console.log("  pricingTableRows（/config → pricing.tiers，面板展示用）：");
  for (const row of rows) console.log(`    ${JSON.stringify(row)}`);
  const peakSegs = segRows.filter((r) => /peak/i.test(r.id));
  let diverge = 0;
  for (const row of rows) {
    if (row.tier === "flash") {
      const seg = peakSegs.find((s) => s.family === "flash");
      if (seg && (row.peakCacheMiss !== seg.miss || row.peakOutput !== seg.out)) {
        diverge++;
        console.log(`    → 分歧：展示 peakCacheMiss=${row.peakCacheMiss} / peakOutput=${row.peakOutput}，但实际计费段 miss=${seg.miss} / out=${seg.out}`);
      }
    }
  }
  // 用自定义版本再探一次（更容易暴露：高峰段是 3.0/5.0，而倍率推出来是 1.0×2=2.0 / 4.0×2=8.0）
  const rowsCustom = pricingTableRows(cp).find((r) => r.tier === "flash");
  const customSegRow = { miss: CUSTOM_PEAK.miss, out: CUSTOM_PEAK.out };
  const c1Bad = rowsCustom.peakCacheMiss !== customSegRow.miss || rowsCustom.peakOutput !== customSegRow.out;
  console.log(`  自定义版本下：tiers.flash.peakCacheMiss=${rowsCustom.peakCacheMiss} peakOutput=${rowsCustom.peakOutput}`);
  console.log(`                实际高峰段 miss=${customSegRow.miss} out=${customSegRow.out}`);
  check(
    "C1：/config 的 pricing.tiers 与运行时实际计费单价一致（否则无法用它独立核对单价）",
    !c1Bad,
    c1Bad ? `tiers 显示 miss=${rowsCustom.peakCacheMiss}/out=${rowsCustom.peakOutput}，实际段 miss=${customSegRow.miss}/out=${customSegRow.out}（tiers 由 基准×peakMultiplier 二次推导）` : "一致",
  );

  // C2: isPeak 与「实际命中哪个段」是否一致
  const monday14 = beijingEpoch(2026, 9, 14, 14, 0); // 基准里这是高峰；但自定义段表里 14:00 是空闲
  const r14 = resolvePrice(monday14, "deepseek-flash", cp);
  const p14 = isPeak(monday14, cp);
  console.log(`  周一 14:00：resolvePrice 命中段=${r14.segmentId} miss=${r14.miss}；isPeak=${p14}`);
  const segIsPeak = r14.miss === CUSTOM_PEAK.miss;
  const c2Bad = segIsPeak !== p14;
  check(
    "C2：isPeak（峰谷标注/peakSplit）与段表实际命中保持一致",
    !c2Bad,
    c2Bad ? `段表实际为${segIsPeak ? "高峰" : "空闲"}（miss=${r14.miss}），但 isPeak=${p14}（来自 peakWindows）→ 报告峰谷拆分与实际计费矛盾` : "一致",
  );
}

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}（${c.detail}）`);
const okCount = checks.filter((c) => c.ok).length;
console.log(`\n=== 通过 ${okCount}/${checks.length} ===`);
if (failures.length) {
  console.log("\n判定：存在分歧 → 验证者无法仅凭 API 独立核对单价（defect）。");
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
