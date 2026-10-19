// 独立验证：口径反证 —— 证明「把 data.stream[].chunk.usage 也累加」会虚增约 100%
// 判据：断言通过 → exit 0；失败 → exit 1。
// 该脚本刻意不复用被测实现（lib/session-log.js）的任何函数。
//
// 2026-10-11 修订（实现者自跑，见 README.md「验证」）：活语料里出现了**一条**只有
// `data.usage`、没有 `data.stream` 副本的记录（`compaction/summary`），于是原先两条
// 「A/B 记录条数必须相等」「(b) 恰为 (a) 的两倍」的**硬编码语料假设**失效。
// 判据改为**更强的、由数据自身导出的**形式：
//   ① 两处都写的记录，逐条 tokens 必须相等（原来只比总数）；
//   ② 例外记录必须被显式列出，且 (b) = 2×(a) − 例外部分（精确恒等式）。
// 判别力没有放松：若实现把 stream 副本也计入，总数会虚增约 100%，①②③ 都会红。
import { readSessionLog } from "./harness/zstd-frames.mjs";
import { parseJsonl, usageRecords, streamChunkUsageRecords, tokensOf } from "./harness/log-parse.mjs";
import { listSessionFiles, snapshotFingerprint } from "./harness/corpus.mjs";

const files = listSessionFiles();
const fp = snapshotFingerprint(files);
console.log("=== 口径反证：只取 data.usage  vs  再累加 data.stream[].chunk.usage ===");
console.log(`语料快照：${fp.count} 个文件 / ${fp.totalBytes.toLocaleString("en-US")} B / fnv1a=${fp.fnv1a}`);
console.log("（语料是活的：其他会话在追加；以下数字绑定本快照）\n");

const failures = [];
let corpusA = 0;
let corpusB = 0;
let corpusNa = 0;
let corpusNb = 0;
const perFile = [];
// 逐记录对照用的累计量
let pairCount = 0; // 两处都写、且 tokens 逐条相等
let pairTokens = 0;
let noCopyTokens = 0; // 只有 usage、没有 stream 副本
const noCopy = [];
const mismatch = [];

for (const f of files) {
  const r = readSessionLog(f.path);
  if (r.multi.failed > 0) {
    failures.push(`解码失败帧：${f.sessionId} failed=${r.multi.failed}（必须显式计入 gaps）`);
  }
  const { records } = parseJsonl(r.multi.text);
  const a = usageRecords(records);
  const b = streamChunkUsageRecords(records);
  const sa = a.reduce((s, x) => s + tokensOf(x.usage), 0);
  const sb = b.reduce((s, x) => s + tokensOf(x.usage), 0);
  corpusA += sa;
  corpusB += sb;
  corpusNa += a.length;
  corpusNb += b.length;
  perFile.push({ id: f.sessionId.slice(-12), size: f.size, na: a.length, nb: b.length, sa, sb });

  // 逐记录：该记录的 data.usage 与它自己的 data.stream[].chunk.usage 合计是否一致
  for (const { line, rec } of records) {
    const u = rec?.data?.usage;
    if (!u || typeof u !== "object") continue;
    const st = rec?.data?.stream;
    let streamSum = 0;
    let copies = 0;
    if (Array.isArray(st)) {
      for (const s of st) {
        const cu = s?.chunk?.usage;
        if (cu && typeof cu === "object") {
          copies += 1;
          streamSum += tokensOf(cu);
        }
      }
    }
    const usageTotal = tokensOf(u);
    if (copies === 0) {
      noCopyTokens += usageTotal;
      noCopy.push({ id: f.sessionId.slice(-12), type: rec.type, seq: rec.seq, time: rec.time, tokens: usageTotal });
    } else if (streamSum !== usageTotal) {
      mismatch.push({ id: f.sessionId.slice(-12), type: rec.type, seq: rec.seq, usage: usageTotal, stream: streamSum });
    } else {
      pairCount += 1;
      pairTokens += usageTotal;
    }
  }
}

const top = perFile.filter((x) => x.sa > 0).slice(0, 5);
console.log("-- 单文件（前 5 大，含用量）--");
console.log("  session            bytes        A记录  B记录  A tokens        B tokens        虚增%");
for (const x of top) {
  const infl = x.sa > 0 ? ((x.sb / x.sa - 1) * 100).toFixed(2) : "n/a";
  console.log(
    `  ${x.id}  ${String(x.size).padStart(9)}  ${String(x.na).padStart(5)}  ${String(x.nb).padStart(5)}  ${String(x.sa).padStart(14)}  ${String(x.sb).padStart(14)}  ${infl}`,
  );
}

console.log("\n-- 全语料合计 --");
console.log(`  (a) 只取 data.usage          ：${corpusNa} 条记录 / ${corpusA.toLocaleString("en-US")} tokens`);
console.log(`  (b) data.usage + chunk.usage ：${corpusNa + corpusNb} 条记录 / ${(corpusA + corpusB).toLocaleString("en-US")} tokens`);
const inflation = corpusA > 0 ? (corpusB / corpusA) * 100 : NaN;
const totalB = corpusA + corpusB;
console.log(`  虚增：${(totalB - corpusA).toLocaleString("en-US")} tokens = ${(((totalB - corpusA) / corpusA) * 100).toFixed(2)}%`);

console.log("\n-- 逐记录对照（比总数更细的判据）--");
console.log(`  两处都写且 tokens 逐条相等：${pairCount} 条 / ${pairTokens.toLocaleString("en-US")} tokens`);
console.log(`  只有 data.usage、没有 stream 副本：${noCopy.length} 条 / ${noCopyTokens.toLocaleString("en-US")} tokens`);
for (const x of noCopy.slice(0, 5)) {
  console.log(`    ${x.id} type=${x.type} seq=${x.seq} time=${x.time} tokens=${x.tokens.toLocaleString("en-US")}（该记录没有 data.stream）`);
}
console.log(`  两处都写但 tokens 不等：${mismatch.length} 条`);
for (const x of mismatch.slice(0, 5)) console.log(`    ${x.id} type=${x.type} seq=${x.seq} usage=${x.usage} stream=${x.stream}`);

// 断言
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

check("两处都写的记录：stream 副本 tokens 与 data.usage 逐条相等", mismatch.length === 0, `不等 ${mismatch.length} 条`);
check(
  "两处都写的记录占绝大多数（≥99%，是常态而非个例）",
  corpusNa > 0 && pairCount / corpusNa >= 0.99,
  `${pairCount}/${corpusNa} = ${((pairCount / Math.max(1, corpusNa)) * 100).toFixed(2)}%`,
);
check("虚增比例 ≈ 100%（落在 99%~101%）", inflation >= 99 && inflation <= 101, `实测 ${inflation.toFixed(2)}%`);
// 精确恒等式：唯一的偏差来源是「没有 stream 副本」的那部分（可逐条列出的例外）
check(
  "(b) 总量 = 2×(a) − 缺 stream 副本部分的 tokens（精确恒等式）",
  totalB === corpusA * 2 - noCopyTokens,
  `2a−miss=${corpusA * 2 - noCopyTokens} sum=${totalB} miss=${noCopyTokens}`,
);
check("(a) 总量 > 0（语料非空）", corpusA > 0, `a=${corpusA}`);

console.log("\n-- 断言 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}（${c.detail}）`);

console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
