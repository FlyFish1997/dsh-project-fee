// 独立验证：数字对账 —— CLI（node scripts/report.mjs --json）vs 我方独立解码
//
// 做法：先把真实会话日志冻结成一份快照 DSH_HOME，CLI 与我的解码都指向这份快照，
//       消除「活语料」带来的漂移，从而做到逐字节可比。
//
// 判据：各工作区的 token 各桶必须逐项相等；费用差必须能被已知的单一根因解释。
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { runScript, ROOT } from "./harness/runner.mjs";
import { freezeHome, fingerprintOfDir } from "./harness/frozen-home.mjs";
import { readSessionLog } from "./harness/zstd-frames.mjs";
import { parseJsonl, attributeModels, bucketsOf } from "./harness/log-parse.mjs";
import { beijingParts, costCorrect, costT1Original, RATES_CNY } from "./harness/pricing.mjs";

const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== 数字对账：CLI vs 独立解码 ===");
if (!existsSync(join(ROOT, "scripts/report.mjs"))) {
  console.log("scripts/report.mjs 不存在 → 无法对账（实现未交付态，不得判 pass）");
  process.exit(2);
}

// 1) 冻结快照
const frozen = freezeHome("accounting");
const fp = fingerprintOfDir(frozen.sessionsRoot);
console.log(`冻结快照：${frozen.home}`);
console.log(`  文件=${fp.fingerprint.count}  字节=${fp.fingerprint.totalBytes.toLocaleString("en-US")}  fnv1a=${fp.fingerprint.fnv1a}`);

// 2) 跑 CLI（指向快照）
const r = runScript("accounting-cli", "scripts/report.mjs", ["--json"], { env: { DSH_HOME: frozen.home } });
console.log(`\nCLI：exit=${r.exitCode}  耗时=${r.ms}ms  log=${r.logPath}`);
check("CLI 退出码为 0", r.exitCode === 0, `exit=${r.exitCode}；尾部：${r.tail.slice(-300)}`);
if (r.exitCode !== 0) {
  console.log(r.tail);
  process.exit(1);
}
const cli = JSON.parse(r.text);
const W = cli.summary?.window ?? {};
console.log(`  window: ${W.from} → ${W.to} (${W.timezone}, offset=${W.timezoneOffsetMinutes}min)`);
console.log(`  days=${cli.days}  pricing.activeVersionId=${cli.summary?.pricing?.activeVersionId}`);

// 3) 独立解码同一份快照
const dateKeyOf = (ms) => beijingParts(ms).iso.slice(0, 10);
const inWindow = (ms) => {
  const d = dateKeyOf(ms);
  return (!W.from || d >= W.from) && (!W.to || d <= W.to);
};

const mine = new Map(); // workspaceDir -> {buckets, costCorrect, costBuggy, n}
let myRecords = 0;
let myFrames = 0;
let myFrameFail = 0;
let myBadLines = 0;
let myUsageTokens = 0;
let myStreamUsageTokens = 0;
const myModelCounts = { fromSource: 0, fromFallback: 0, unknown: 0 };
for (const f of fp.files) {
  const dec = readSessionLog(f.path);
  myFrames += dec.multi.candidateFrames;
  myFrameFail += dec.multi.failed;
  const { records, badLines } = parseJsonl(dec.multi.text);
  myBadLines += badLines.length;
  for (const { rec } of records) {
    const st = rec?.data?.stream;
    if (Array.isArray(st)) for (const s of st) if (s?.chunk?.usage && typeof s.chunk.usage.totalTokens === "number") myStreamUsageTokens += s.chunk.usage.totalTokens;
  }
  for (const a of attributeModels(records)) {
    myRecords++;
    // 独立复算模型归属计数（与实现同名计数器对账）
    if (a.model === null) myModelCounts.unknown++;
    else if (a.modelSource === "message.source") myModelCounts.fromSource++;
    else myModelCounts.fromFallback++;
    if (typeof a.usage.totalTokens === "number") myUsageTokens += a.usage.totalTokens;
    if (!inWindow(a.time)) continue;
    const b = bucketsOf(a.usage);
    const e = mine.get(f.workspaceDir) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0, costCorrect: 0, costBuggy: 0, n: 0 };
    e.input += b.input;
    e.output += b.output;
    e.cacheRead += b.cacheRead;
    e.cacheWrite += b.cacheWrite;
    e.reasoning += b.reasoning;
    e.total += b.total;
    e.costCorrect += costCorrect(a.usage, a.model, a.time);
    e.costBuggy += costT1Original(a.usage, a.model, a.time);
    e.n++;
    mine.set(f.workspaceDir, e);
  }
}
console.log(`\n独立解码：帧=${myFrames} 失败帧=${myFrameFail} 坏行=${myBadLines} usage记录=${myRecords}（窗口内计入 ${[...mine.values()].reduce((s, e) => s + e.n, 0)}）`);

// 4) 对账
const cliWs = cli.workspaces ?? [];
const withData = cliWs.filter((w) => (w.usageRecords ?? 0) > 0);
console.log(`\n-- 逐工作区对账（共 ${cliWs.length} 个，含数据 ${withData.length} 个）--`);
check("含数据工作区 ≥ 3（验收要求）", withData.length >= 3, `only ${withData.length}`);

const KEYS = [
  ["inputTokens", "input"],
  ["outputTokens", "output"],
  ["cacheReadTokens", "cacheRead"],
  ["reasoningTokens", "reasoning"],
];
let bucketMismatch = 0;
let costMismatch = 0;
let costBuggyExplains = 0;
let costBuggyDiscriminative = 0;
console.log(`${"工作区".padEnd(40)} ${"记录".padStart(6)} ${"桶一致".padStart(7)} ${"CLI费用".padStart(12)} ${"自算(正确)".padStart(12)} ${"自算(错公式)".padStart(13)}`);
for (const w of cliWs) {
  const m = mine.get(w.workspaceId) ?? mine.get(w.key);
  if (!m) {
    if ((w.usageRecords ?? 0) > 0) {
      bucketMismatch++;
      console.log(`  ${String(w.workspaceId).padEnd(38)} CLI 有数据但我在快照里找不到该工作区`);
    }
    continue;
  }
  let ok = true;
  const diffs = [];
  for (const [cliKey, myKey] of KEYS) {
    if ((w.tokens?.[cliKey] ?? 0) !== m[myKey]) {
      ok = false;
      diffs.push(`${cliKey}: cli=${w.tokens?.[cliKey]} mine=${m[myKey]}`);
    }
  }
  if ((w.usageRecords ?? 0) !== m.n) {
    ok = false;
    diffs.push(`usageRecords: cli=${w.usageRecords} mine=${m.n}`);
  }
  if ((w.tokens?.totalTokens ?? 0) !== m.total) {
    ok = false;
    diffs.push(`totalTokens: cli=${w.tokens?.totalTokens} mine=${m.total}`);
  }
  if (!ok) bucketMismatch++;
  const costOk = Math.abs((w.cost ?? 0) - m.costCorrect) < 1e-6;
  const buggyOk = Math.abs((w.cost ?? 0) - m.costBuggy) < 1e-6;
  // reasoningTokens = 0 的工作区：正确公式与「output+reasoning」错公式本来就同值，
  // 对「是否重复计费」没有判别力，因此不计入反事实匹配数（否则会把正常数据误判成回归）。
  const buggyDiscriminates = Math.abs(m.costBuggy - m.costCorrect) > 1e-9;
  if (!costOk) costMismatch++;
  if (buggyOk && buggyDiscriminates) costBuggyExplains++;
  if (buggyDiscriminates) costBuggyDiscriminative++;
  console.log(
    `${String(w.label ?? w.workspaceId).padEnd(40)} ${String(m.n).padStart(6)} ${String(ok ? "OK" : "DIFF").padStart(7)} ${String((w.cost ?? 0).toFixed(6)).padStart(12)} ${String(m.costCorrect.toFixed(6)).padStart(12)} ${String(m.costBuggy.toFixed(6)).padStart(13)}`,
  );
  if (diffs.length) console.log(`    ${diffs.join("  |  ")}`);
}

check("所有工作区的 token 各桶与独立解码逐项相等", bucketMismatch === 0, `${bucketMismatch} 个工作区不一致`);
check("所有工作区费用与独立自算（正确公式）相等", costMismatch === 0, `${costMismatch} 个工作区不一致`);
// 反事实对照：若实现回退到「output+reasoning」错公式，金额会变成 buggy 值。
// 这里只作信息记录（不是断言），因为正确实现下它本就不应等于 CLI 值。
console.log(
  `\n  反事实对照：CLI 费用等于「output+reasoning」错公式的工作区数 = ${costBuggyExplains}/${costBuggyDiscriminative}（只统计两公式有差异、具备判别力的工作区）` +
    `（若该值等于总数，说明 reasoning 重复计费缺陷重新出现 → 需立即复查 lib/pricing.js）`,
);
check(
  "reasoning 重复计费未回归（CLI 费用不得等于错公式结果）",
  costBuggyExplains === 0,
  `buggyMatches=${costBuggyExplains}/${costBuggyDiscriminative}`,
);

// 5) 交叉核对 CLI 自报的诊断量
console.log("\n-- CLI 自报诊断 vs 我的独立计数 --");
const d = cli.diagnostics ?? {};
const rows = [
  ["frameTotal", d.frameTotal, myFrames],
  ["framesFailed", d.framesFailed, myFrameFail],
  ["usageRecords", d.usageRecords, myRecords],
  ["sessionFiles", d.sessionFiles, fp.fingerprint.count],
];
for (const [k, cliV, myV] of rows) {
  const ok = cliV === myV;
  console.log(`  ${k.padEnd(16)} cli=${String(cliV).padStart(8)} mine=${String(myV).padStart(8)} ${ok ? "OK" : "DIFF"}`);
  check(`诊断 ${k} 与独立计数一致`, ok, `cli=${cliV} mine=${myV}`);
}
console.log(`  ${"usageTokens".padEnd(16)} cli=${String(d.usageTokens).padStart(8)} mine=${String(myUsageTokens).padStart(8)} ${d.usageTokens === myUsageTokens ? "OK" : "DIFF"}`);
console.log(`  ${"streamUsageTokens".padEnd(16)} cli=${String(d.streamUsageTokens).padStart(8)} mine=${String(myStreamUsageTokens).padStart(8)} ${d.streamUsageTokens === myStreamUsageTokens ? "OK" : "DIFF"}`);

// 模型归属计数：用我方独立实现 attributeModels() 复算，回应「模型归属是否被改断言迁就实现」
{
  const mineSrc = myModelCounts.fromSource;
  const mineFb = myModelCounts.fromFallback;
  const mineUnknown = myModelCounts.unknown;
  const rows2 = [
    ["modelFromSourceCount", d.modelFromSourceCount, mineSrc],
    ["modelFromFallbackCount", d.modelFromFallbackCount, mineFb],
    ["unknownModelCount", d.unknownModelCount, mineUnknown],
  ];
  console.log("\n-- 模型归属计数：CLI vs 我方独立 attributeModels() --");
  for (const [k, cliV, myV] of rows2) {
    const ok = cliV === myV;
    console.log(`  ${k.padEnd(22)} cli=${String(cliV).padStart(8)} mine=${String(myV).padStart(8)} ${ok ? "OK" : "DIFF"}`);
    check(`诊断 ${k} 与独立复算一致`, ok, `cli=${cliV} mine=${myV}`);
  }
}
// 双计虚增比：**不再硬编码 100**（2026-10-11 活语料里出现 1 条只有 data.usage、没有 stream 副本的
// `compaction/summary` 记录 → 99.97%）。判据改为「与我的独立复算逐值一致」且仍 >99%（双计仍会虚增近一倍）。
// 逐工作区的桶与费用对账（上面那几条）才是真正拦住双计/漏计的判据；见 README.md「验证」。
const myInflation = myUsageTokens > 0 ? Number(((myStreamUsageTokens / myUsageTokens) * 100).toFixed(2)) : 0;
const myMissingStreamTokens = myUsageTokens - myStreamUsageTokens;
console.log(`  ${"doubleCountInflation%".padEnd(16)} cli=${d.doubleCountInflationPercent}  mine=${myInflation.toFixed(2)}  （缺 stream 副本 ${myMissingStreamTokens.toLocaleString("en-US")} tokens）`);
check(
  "doubleCountInflationPercent 与独立复算逐值一致，且仍 >99%（双计会虚增近一倍）",
  d.doubleCountInflationPercent === myInflation && myInflation > 99,
  `cli=${d.doubleCountInflationPercent} mine=${myInflation.toFixed(2)}`,
);

// 6) 合计
const sumCli = withData.reduce((s, w) => s + (w.cost ?? 0), 0);
const sumMine = [...mine.values()].reduce((s, e) => s + e.costCorrect, 0);
const sumBuggy = [...mine.values()].reduce((s, e) => s + e.costBuggy, 0);
console.log(`\n-- 合计 --`);
console.log(`  CLI 各工作区费用之和   : ¥${sumCli.toFixed(6)}`);
console.log(`  独立自算（正确公式）   : ¥${sumMine.toFixed(6)}`);
console.log(`  独立自算（错公式）     : ¥${sumBuggy.toFixed(6)}`);
console.log(`  CLI 与错公式的差额     : ¥${(sumCli - sumBuggy).toFixed(6)}（应≈0，用于确认根因）`);
console.log(`  CLI 与正确公式的差额   : ¥${(sumCli - sumMine).toFixed(6)}（= reasoning 重复计费，${(((sumCli - sumMine) / sumMine) * 100).toFixed(2)}%）`);

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}（${c.detail}）`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
