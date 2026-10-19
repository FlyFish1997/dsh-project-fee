// 独立验证：把「被测实现的定价」与「我自算的定价」逐条对账
//   甲) 峰谷边界：直接调用实现的 isPeak / priceUsage 在切换点上的判定
//   乙) 真实记录逐条对账：实现 priceUsage vs 我方独立 costCorrect
//   丙) 根因隔离：若不一致，判断差额是否恰为「outputTokens 被重复加上 reasoningTokens」
//
// 判据：全部断言通过 → exit 0；否则 exit 1。
import { existsSync } from "node:fs";
import { readSessionLog } from "./harness/zstd-frames.mjs";
import { parseJsonl, attributeModels } from "./harness/log-parse.mjs";
import { listSessionFiles, snapshotFingerprint } from "./harness/corpus.mjs";
import { beijingEpoch, beijingParts, segmentOf, costCorrect, RATES_CNY } from "./harness/pricing.mjs";

const IMPL = new URL("../../lib/pricing.js", import.meta.url);
const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== 定价：实现 vs 独立自算 ===");
if (!existsSync(IMPL)) {
  console.log("lib/pricing.js 不存在 → 无法对账（这是 实现未交付的状态，不得判 pass）");
  process.exit(2);
}
const impl = await import(IMPL.href);
console.log(`导入实现：${IMPL.pathname}`);
console.log(`导出：${Object.keys(impl).join(", ")}`);

// ---------- 甲) 峰谷边界（直接打实现） ----------
console.log("\n-- 甲) 峰谷切换点（调用实现的 isPeak）--");
const CASES = [
  ["08:59:59", 8, 59, 59, false],
  ["09:00:00", 9, 0, 0, true],
  ["11:59:59", 11, 59, 59, true],
  ["12:00:00", 12, 0, 0, false],
  ["13:59:59", 13, 59, 59, false],
  ["14:00:00", 14, 0, 0, true],
  ["17:59:59", 17, 59, 59, true],
  ["18:00:00", 18, 0, 0, false],
];
function findWorkday() {
  for (let d = 14; d <= 21; d++) {
    const dow = beijingParts(beijingEpoch(2026, 9, d, 12, 0, 0)).dow;
    if (dow >= 1 && dow <= 5) return { day: d, dow };
  }
  throw new Error("no workday");
}
function findWeekend() {
  for (let d = 14; d <= 21; d++) {
    const dow = beijingParts(beijingEpoch(2026, 9, d, 12, 0, 0)).dow;
    if (dow === 0 || dow === 6) return { day: d, dow };
  }
  throw new Error("no weekend");
}
const wd = findWorkday();
const we = findWeekend();
console.log(`  工作日=2026-09-${wd.day}  周末=2026-09-${we.day}`);
console.log("  时间(北京)  实现isPeak  期望   判定");
for (const [label, h, mi, s, expectPeak] of CASES) {
  const ms = beijingEpoch(2026, 9, wd.day, h, mi, s);
  const got = impl.isPeak(ms);
  console.log(`  ${label}     ${String(got).padEnd(9)} ${String(expectPeak).padEnd(6)} ${got === expectPeak ? "OK" : "FAIL"}`);
  check(`impl isPeak workday ${label} == ${expectPeak}`, got === expectPeak, `got=${got}`);
}
console.log("  周末抽样：");
for (const h of [0, 9, 10, 14, 18, 23]) {
  const ms = beijingEpoch(2026, 9, we.day, h, 0, 0);
  const got = impl.isPeak(ms);
  console.log(`    ${String(h).padStart(2, "0")}:00  impl=${got}  期望=false  ${got === false ? "OK" : "FAIL"}`);
  check(`impl isPeak weekend ${h}:00 == false`, got === false, `got=${got}`);
}

// 峰价恰为空闲价 ×2：打实现 priceUsage，同一 usage 在 peak/off 两点
console.log("\n-- 乙) 峰价 == 空闲价 ×2（打实现 priceUsage）--");
{
  const usage = { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 };
  const peakMs = beijingEpoch(2026, 9, wd.day, 10, 0, 0);
  const offMs = beijingEpoch(2026, 9, wd.day, 20, 0, 0);
  const cp = impl.priceUsage(usage, "deepseek-flash", peakMs);
  const co = impl.priceUsage(usage, "deepseek-flash", offMs);
  console.log(`  1M miss：peak=¥${cp.cost} off=¥${co.cost} ratio=${cp.cost / co.cost}`);
  check("impl 峰/闲比 == 2", cp.cost === co.cost * 2, `${cp.cost} vs ${co.cost}`);
  check("impl 空闲 miss 单价 == 1.0 CNY/M", co.cost === 1.0, `got=${co.cost}`);
}

// ---------- 丙) 真实记录逐条对账 ----------
console.log("\n-- 丙) 真实记录逐条对账（实现 vs 独立自算）--");
const files = listSessionFiles();
const fp = snapshotFingerprint(files);
console.log(`  语料快照：${fp.count} 文件 / ${fp.totalBytes.toLocaleString("en-US")} B / fnv1a=${fp.fnv1a}`);
let n = 0;
let mismatch = 0;
let exact = 0;
let implSum = 0;
let mineSum = 0;
let reasoningTermSum = 0;
let mismatchAfterRemovingReasoning = 0;
const samples = [];
for (const f of files) {
  const r = readSessionLog(f.path);
  const { records } = parseJsonl(r.multi.text);
  for (const a of attributeModels(records)) {
    const u = a.usage;
    n++;
    const got = impl.priceUsage(u, a.model, a.time);
    const want = costCorrect(u, a.model, a.time);
    implSum += got.cost;
    mineSum += want;
    const seg = segmentOf(a.time);
    const fam = String(a.model ?? "").includes("pro") ? "pro" : "flash";
    const rateOut = RATES_CNY[fam][seg].out;
    const reasonTerm = ((u.reasoningTokens ?? 0) / 1e6) * rateOut;
    reasoningTermSum += reasonTerm;
    if (Math.abs(got.cost - want) < 1e-12) {
      exact++;
    } else {
      mismatch++;
      if (samples.length < 3) samples.push({ seq: a.seq, time: a.time, usage: u, impl: got.cost, mine: want, diff: got.cost - want, reasonTerm });
      // 根因隔离：只在不一致记录上判断「减去 reasoning 项后是否恰好吻合」
      if (Math.abs(got.cost - reasonTerm - want) < 1e-9) mismatchAfterRemovingReasoning++;
    }
  }
}
console.log(`  记录数：${n.toLocaleString("en-US")}`);
console.log(`  实现合计：¥${implSum.toFixed(4)}`);
console.log(`  自算合计：¥${mineSum.toFixed(4)}`);
console.log(`  差额    ：¥${(implSum - mineSum).toFixed(4)}  (${(((implSum - mineSum) / mineSum) * 100).toFixed(2)}%)`);
console.log(`  差额中「reasoning 项」贡献：¥${reasoningTermSum.toFixed(4)}`);
console.log(`  逐条完全一致：${exact.toLocaleString("en-US")}/${n.toLocaleString("en-US")}`);
console.log(`  逐条不一致  ：${mismatch.toLocaleString("en-US")}`);
console.log(`  去掉 reasoning 项后一致：${mismatchAfterRemovingReasoning.toLocaleString("en-US")}/${mismatch.toLocaleString("en-US")}（根因隔离）`);
if (samples.length) {
  console.log("  不一致样例：");
  for (const s of samples) {
    console.log(`    seq=${s.seq} usage=${JSON.stringify(s.usage)}`);
    console.log(`      impl=¥${s.impl.toFixed(9)} mine=¥${s.mine.toFixed(9)} diff=¥${s.diff.toFixed(9)} reasoning项=¥${s.reasonTerm.toFixed(9)}`);
  }
}
check(
  "实现的费用合计与独立自算一致",
  Math.abs(implSum - mineSum) < 1e-6,
  `impl=¥${implSum.toFixed(4)} mine=¥${mineSum.toFixed(4)} 差额=¥${(implSum - mineSum).toFixed(4)}`,
);

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}（${c.detail}）`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
if (failures.length) {
  console.log("\n根因结论：");
  if (mismatch > 0 && mismatchAfterRemovingReasoning === mismatch) {
    console.log("  ★ 全部不一致都可归因到同一个根因：`(outputTokens + reasoningTokens) * out` 把思考 tokens 重复计费一次。");
  } else if (mismatch > 0) {
    console.log("  ★ 存在无法用 reasoning 重复计费解释的不一致 → 另有结构性问题，需进一步定位。");
  }
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
