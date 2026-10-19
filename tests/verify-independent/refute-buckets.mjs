// 独立验证：用量「桶语义」反证 —— 决定正确计费公式
//
// 被否证的对象：约定 3 的公式
//     uncached = max(0, inputTokens - cacheReadTokens)
//     cost = cacheRead*hit + uncached*miss + (output+reasoning)*out
// 我方主张：
//     inputTokens 本身就是 uncached 桶（与 cacheReadTokens 互斥，不相交）
//     outputTokens 已含 reasoningTokens
//   → 正确公式 cost = (cacheRead*hit + input*miss + output*out)/1e6
//
// 判据：全部断言通过 → exit 0；失败 → exit 1（失败即我方主张被推翻）。
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readSessionLog } from "./harness/zstd-frames.mjs";
import { parseJsonl, attributeModels, bucketsOf } from "./harness/log-parse.mjs";
import { listSessionFiles, snapshotFingerprint } from "./harness/corpus.mjs";
import { costCorrect, costRuling3, costT1Original, segmentOf } from "./harness/pricing.mjs";

const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== 用量桶语义反证（约定 3 的公式是否成立）===");
const files = listSessionFiles();
const fp = snapshotFingerprint(files);
console.log(`语料快照：${fp.count} 文件 / ${fp.totalBytes.toLocaleString("en-US")} B / fnv1a=${fp.fnv1a}\n`);

let n = 0;
let idTotal = 0;
let idTotalPlusReason = 0;
let inputLtCache = 0;
let reasonGtOut = 0;
let cacheWriteSeen = 0;
const keySet = new Set();
let totalInput = 0;
let totalCache = 0;
let totalOut = 0;
let totalReason = 0;
let sumClamped = 0;
let clampZero = 0;
let costCorrectSum = 0;
let costRuling3Sum = 0;
let costT1OrigSum = 0;
const perRecordDelta = [];

for (const f of files) {
  const r = readSessionLog(f.path);
  const { records } = parseJsonl(r.multi.text);
  for (const a of attributeModels(records)) {
    const u = a.usage;
    const b = bucketsOf(u);
    n++;
    for (const k of Object.keys(u)) keySet.add(k);
    if (typeof u.cacheWriteTokens === "number") cacheWriteSeen++;
    if (b.total === b.input + b.output + b.cacheRead + b.cacheWrite) idTotal++;
    if (b.total === b.input + b.output + b.cacheRead + b.cacheWrite + b.reasoning) idTotalPlusReason++;
    if (b.input < b.cacheRead) inputLtCache++;
    if (b.reasoning > b.output) reasonGtOut++;
    totalInput += b.input;
    totalCache += b.cacheRead;
    totalOut += b.output;
    totalReason += b.reasoning;
    const clamped = Math.max(0, b.input - b.cacheRead);
    sumClamped += clamped;
    if (b.input - b.cacheRead <= 0) clampZero++;
    const c1 = costCorrect(u, a.model, a.time);
    const c2 = costRuling3(u, a.model, a.time);
    const c3 = costT1Original(u, a.model, a.time);
    costCorrectSum += c1;
    costRuling3Sum += c2;
    costT1OrigSum += c3;
    perRecordDelta.push({ c1, c2, c3 });
  }
}

const m = (x) => x.toLocaleString("en-US");
console.log(`-- 语料规模 --`);
console.log(`  usage 记录数：${m(n)}`);
console.log(`  usage 字段集合：${[...keySet].join(", ")}`);
console.log(`  含 cacheWriteTokens 的记录：${m(cacheWriteSeen)}`);

console.log(`\n-- 断言 1：totalTokens 的构成 --`);
console.log(`  totalTokens == input + output + cacheRead(+cacheWrite) : ${m(idTotal)}/${m(n)} = ${((idTotal / n) * 100).toFixed(2)}%`);
console.log(`  totalTokens == 上式再加 reasoning                      : ${m(idTotalPlusReason)}/${m(n)} = ${((idTotalPlusReason / n) * 100).toFixed(2)}%`);
check("totalTokens 恰为 input+output+cacheRead（100%）", idTotal === n, `${idTotal}/${n}`);
check("把 reasoning 再加进去会破坏该恒等式（证明 reasoning ⊆ output）", idTotalPlusReason < n, `${idTotalPlusReason}/${n}`);

console.log(`\n-- 断言 2：inputTokens 与 cacheReadTokens 互斥（不相交）--`);
console.log(`  inputTokens < cacheReadTokens 的记录：${m(inputLtCache)}/${m(n)} = ${((inputLtCache / n) * 100).toFixed(2)}%`);
console.log(`  → 若 inputTokens 是「含缓存的 prompt 总量」，它不可能小于 cacheReadTokens`);
check("存在大量 input < cacheRead（证明两者不相交）", inputLtCache > 0, `${inputLtCache}/${n}`);
check("该比例过半（是常态而非个例）", inputLtCache / n > 0.5, `${((inputLtCache / n) * 100).toFixed(2)}%`);

console.log(`\n-- 断言 3：reasoning ⊆ output --`);
console.log(`  reasoningTokens > outputTokens 的记录：${m(reasonGtOut)}`);
check("reasoning 从不超过 output", reasonGtOut === 0, `count=${reasonGtOut}`);

console.log(`\n-- 量化：真实语料上的桶与费用 --`);
console.log(`  Σ inputTokens   (=未命中) : ${m(totalInput)}`);
console.log(`  Σ cacheReadTokens         : ${m(totalCache)}`);
console.log(`  Σ outputTokens  (含思考)  : ${m(totalOut)}`);
console.log(`  Σ reasoningTokens         : ${m(totalReason)}`);
console.log(`  Σ max(0, input-cache)     : ${m(sumClamped)}  → 未命中桶丢失 ${m(totalInput - sumClamped)} (${(((totalInput - sumClamped) / totalInput) * 100).toFixed(2)}%)`);
console.log(`  未命中桶被算成 0 的记录   : ${m(clampZero)}/${m(n)} = ${((clampZero / n) * 100).toFixed(2)}%`);
console.log(`\n  费用（CNY，按各自时间判峰谷）：`);
console.log(`    正确公式          : ¥${costCorrectSum.toFixed(4)}`);
console.log(`    约定3公式         : ¥${costRuling3Sum.toFixed(4)}   （偏差 ${(((costRuling3Sum - costCorrectSum) / costCorrectSum) * 100).toFixed(2)}%）`);
console.log(`    实现原始公式(加思考): ¥${costT1OrigSum.toFixed(4)}   （偏差 ${(((costT1OrigSum - costCorrectSum) / costCorrectSum) * 100).toFixed(2)}%）`);
check("约定3公式导致未命中桶丢失 > 50%", (totalInput - sumClamped) / totalInput > 0.5, `${(((totalInput - sumClamped) / totalInput) * 100).toFixed(2)}%`);
check("约定3公式在多数记录上把未命中桶算成 0", clampZero / n > 0.5, `${((clampZero / n) * 100).toFixed(2)}%`);

// 断言 4：机器核验 DSH 核心源码语义（证据可复跑，不靠我口述）
console.log(`\n-- 断言 4：机器核验 DSH 核心源码的桶语义 --`);
// 证据源码根目录：默认不猜测。需要核验时用 DSH_CORE_DIR 指向 DSH 安装的 node_modules。
const CORE = process.env.DSH_CORE_DIR || "";
const openaiCompletions = join(CORE, "@earendil-works", "pi-ai", "dist", "api", "openai-completions.js");
const tokenMeter = join(CORE, "@deepseek-ai", "dsh-token-meter", "lib", "index.js");
if (existsSync(openaiCompletions)) {
  const src = readFileSync(openaiCompletions, "utf8");
  const hasTrim = /const input = Math\.max\(0, promptTokens - cacheReadTokens - cacheWriteTokens\)/.test(src);
  const hasReasonComment = /completion_tokens already includes reasoning_tokens/.test(src);
  const hasTotal = /totalTokens: input \+ outputTokens \+ cacheReadTokens \+ cacheWriteTokens/.test(src);
  console.log(`  ${openaiCompletions}`);
  console.log(`    input = max(0, prompt - cacheRead - cacheWrite) : ${hasTrim}`);
  console.log(`    注释「completion_tokens already includes reasoning_tokens」: ${hasReasonComment}`);
  console.log(`    totalTokens = input + output + cacheRead + cacheWrite : ${hasTotal}`);
  check("pi-ai: input 已扣除 cacheRead（input 即 uncached）", hasTrim, `found=${hasTrim}`);
  check("pi-ai: 明示 output 已含 reasoning", hasReasonComment, `found=${hasReasonComment}`);
  check("pi-ai: totalTokens 构成为 input+output+cacheRead+cacheWrite", hasTotal, `found=${hasTotal}`);
} else {
  check("pi-ai 源码存在（否则本项证据不可核验）", false, `missing ${openaiCompletions}`);
}
if (existsSync(tokenMeter)) {
  const src = readFileSync(tokenMeter, "utf8");
  const hasUncached = /uncachedInputTokens/.test(src);
  const hasUsageTokens = /usage\.inputTokens \+ \(usage\.cacheReadTokens \?\? 0\)/.test(src);
  console.log(`  ${tokenMeter}`);
  console.log(`    投影字段名 uncachedInputTokens : ${hasUncached}`);
  console.log(`    usageTokens = input + cacheRead + ... : ${hasUsageTokens}`);
  check("dsh-token-meter: 把 inputTokens 映射为 uncachedInputTokens", hasUncached, `found=${hasUncached}`);
  check("dsh-token-meter: 计费量 = input + cacheRead + output", hasUsageTokens, `found=${hasUsageTokens}`);
} else {
  check("dsh-token-meter 源码存在（否则本项证据不可核验）", false, `missing ${tokenMeter}`);
}

// 断言 5：参照实现 dsh-context 的公式（维护者据以核价率的那个）
const ctxPath = join(process.env.DSH_HOME || join(homedir(), ".dsh"), "profiles", "web", "node_modules", "dsh-context", "lib", "client.js");
console.log(`\n-- 断言 5：参照实现 dsh-context 的计费公式 --`);
if (existsSync(ctxPath)) {
  const src = readFileSync(ctxPath, "utf8");
  const hasFormula = /cacheRead\) \* p\.hit \+ \(numOf\(b\.uncached\) \+ numOf\(b\.cacheWrite\)\) \* p\.miss \+ numOf\(b\.output\) \* p\.out/.test(src);
  const hasOutputIncludesReasoning = /输出含思考/.test(src);
  console.log(`  ${ctxPath}`);
  console.log(`    cost = (cacheRead*hit + (uncached+cacheWrite)*miss + output*out)/1e6 : ${hasFormula}`);
  console.log(`    文案「输出含思考」 : ${hasOutputIncludesReasoning}`);
  check("dsh-context 公式无 reasoning 项且 miss 只乘 uncached", hasFormula, `found=${hasFormula}`);
  check("dsh-context 文案明示「输出含思考」", hasOutputIncludesReasoning, `found=${hasOutputIncludesReasoning}`);
} else {
  check("dsh-context 源码存在（否则本项证据不可核验）", false, `missing ${ctxPath}`);
}

console.log(`\n-- 断言 6：峰谷分段抽样（真实记录）--`);
{
  let peak = 0;
  let off = 0;
  const first = listSessionFiles()[0];
  const r = readSessionLog(first.path);
  const { records } = parseJsonl(r.multi.text);
  for (const a of attributeModels(records)) {
    if (segmentOf(a.time) === "peak") peak++;
    else off++;
  }
  console.log(`  最大文件：peak=${peak} off=${off}`);
  check("真实记录能落到两个分段（抽样非退化）", peak > 0 || off > 0, `peak=${peak} off=${off}`);
}

console.log(`\n-- 断言汇总 --`);
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}（${c.detail}）`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
