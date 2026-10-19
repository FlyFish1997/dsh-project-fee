// 独立验证：峰谷定价边界穷举（自算，不复用被测实现）
// 判据：全部断言通过 → exit 0；任一失败 → exit 1。
import {
  beijingEpoch,
  beijingParts,
  segmentOf,
  costCorrect,
  peakIsDoubleOfOff,
  RATES_CNY,
} from "./harness/pricing.mjs";

const DOW_ZH = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
let pass = 0;
const failures = [];

function check(label, actual, expected) {
  const ok = actual === expected;
  if (ok) pass++;
  else failures.push({ label, actual, expected });
  return ok;
}

// 选一个确定的工作日：2026-09-16（用代码自查 dow，不靠手算）
console.log("=== 峰谷定价边界穷举（北京时间 UTC+8）===");
console.log("峰值/空闲价（CNY / 1M tokens）:", JSON.stringify(RATES_CNY));

// 0) 峰价恰为空闲价 ×2
console.log("\n-- 断言 0：峰价 == 空闲价 × 2 --");
for (const row of peakIsDoubleOfOff()) {
  console.log(
    `  ${row.family.padEnd(5)} ${row.bucket.padEnd(4)} peak=${String(row.peak).padEnd(5)} off=${String(row.off).padEnd(5)} ratio=${row.ratio}`,
  );
  check(`peak=2*off ${row.family}.${row.bucket}`, row.ok, true);
}

// 找一个工作日与一个周末
function findWorkday() {
  for (let d = 14; d <= 21; d++) {
    const ms = beijingEpoch(2026, 9, d, 12, 0, 0);
    const dow = beijingParts(ms).dow;
    if (dow >= 1 && dow <= 5) return { day: d, dow };
  }
  throw new Error("no workday found");
}
function findWeekend() {
  for (let d = 14; d <= 21; d++) {
    const ms = beijingEpoch(2026, 9, d, 12, 0, 0);
    const dow = beijingParts(ms).dow;
    if (dow === 0 || dow === 6) return { day: d, dow };
  }
  throw new Error("no weekend found");
}
const wd = findWorkday();
const we = findWeekend();
console.log(`\n基准工作日：2026-09-${wd.day} (${DOW_ZH[wd.dow]})；基准周末日：2026-09-${we.day} (${DOW_ZH[we.dow]})`);

// 1) 工作日切换点
const CASES = [
  ["08:59:59", 8, 59, 59, "off"],
  ["09:00:00", 9, 0, 0, "peak"],
  ["11:59:59", 11, 59, 59, "peak"],
  ["12:00:00", 12, 0, 0, "off"],
  ["13:59:59", 13, 59, 59, "off"],
  ["14:00:00", 14, 0, 0, "peak"],
  ["17:59:59", 17, 59, 59, "peak"],
  ["18:00:00", 18, 0, 0, "off"],
];
console.log(`\n-- 断言 1：工作日 2026-09-${wd.day} 切换点 --`);
console.log("  时间(北京)  dow  实际segment  期望    单价miss  判定");
for (const [label, h, mi, s, expected] of CASES) {
  const ms = beijingEpoch(2026, 9, wd.day, h, mi, s);
  const p = beijingParts(ms);
  const seg = segmentOf(ms);
  const rate = RATES_CNY.flash[seg].miss;
  const ok = seg === expected;
  console.log(
    `  ${label}      ${p.dow}   ${seg.padEnd(5)}       ${expected.padEnd(5)}  ${String(rate).padEnd(8)} ${ok ? "OK" : "FAIL"}`,
  );
  check(`workday ${label} -> ${expected}`, seg, expected);
}

// 2) 周末全天若干点必为空闲
console.log(`\n-- 断言 2：周末 2026-09-${we.day} (${DOW_ZH[we.dow]}) 全天为空闲 --`);
for (const h of [0, 9, 10, 12, 14, 17, 18, 23]) {
  const ms = beijingEpoch(2026, 9, we.day, h, 0, 0);
  const seg = segmentOf(ms);
  console.log(`  ${String(h).padStart(2, "0")}:00:00  实际=${seg}  期望=off  ${seg === "off" ? "OK" : "FAIL"}`);
  check(`weekend ${h}:00 -> off`, seg, "off");
}

// 3) 跨时区：同一 UTC 瞬间在 UTC 与 UTC+8 的日界
console.log("\n-- 断言 3：UTC+8 日界不错位 --");
{
  // 北京时间 2026-09-16 00:00:00 == UTC 2026-09-15 16:00:00
  const ms = beijingEpoch(2026, 9, 16, 0, 0, 0);
  const utc = new Date(ms).toISOString();
  const bj = beijingParts(ms).iso;
  console.log(`  北京 ${bj} == UTC ${utc}；segment=${segmentOf(ms)}`);
  check("beijing 00:00 maps to prior UTC day", utc, "2026-09-15T16:00:00.000Z");
  check("beijing 00:00 is off-peak", segmentOf(ms), "off");

  // 北京时间 23:59:59 == UTC 同日 15:59:59
  const ms2 = beijingEpoch(2026, 9, 16, 23, 59, 59);
  console.log(`  北京 ${beijingParts(ms2).iso} == UTC ${new Date(ms2).toISOString()}；segment=${segmentOf(ms2)}`);
  check("beijing 23:59:59 is off-peak", segmentOf(ms2), "off");
  check("beijing 23:59:59 stays same beijing day", beijingParts(ms2).iso.startsWith("2026-09-16"), true);
}

// 4) 单价手算对照（独立于段位判定）
console.log("\n-- 断言 4：单价手算对照（flash, 高峰 vs 空闲）--");
{
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 };
  const peakMs = beijingEpoch(2026, 9, wd.day, 10, 0, 0);
  const offMs = beijingEpoch(2026, 9, wd.day, 20, 0, 0);
  const cp = costCorrect(usage, "deepseek-flash", peakMs);
  const co = costCorrect(usage, "deepseek-flash", offMs);
  console.log(`  100万 miss tokens：高峰 ¥${cp}，空闲 ¥${co}，比值 ${cp / co}`);
  check("1M miss @peak == 2.0 CNY", cp, 2.0);
  check("1M miss @off == 1.0 CNY", co, 1.0);
}

console.log(`\n=== 通过 ${pass} 项，失败 ${failures.length} 项 ===`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f.label}: 实际=${f.actual} 期望=${f.expected}`);
  process.exit(1);
}
process.exit(0);
