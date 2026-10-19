// 独立验证：容量基线（全量刷新规模 + 实测耗时）
// 约定 4 给了参考量级；这里由我自己重测，并用它作为性能用例的基线。
import { readSessionLog } from "./harness/zstd-frames.mjs";
import { parseJsonl, usageRecords } from "./harness/log-parse.mjs";
import { listSessionFiles, snapshotFingerprint } from "./harness/corpus.mjs";

const files = listSessionFiles();
const fp = snapshotFingerprint(files);
const sizes = files.map((f) => f.size).sort((a, b) => a - b);
const median = sizes.length % 2 ? sizes[(sizes.length - 1) / 2] : Math.round((sizes[sizes.length / 2 - 1] + sizes[sizes.length / 2]) / 2);

console.log("=== 容量基线（我自己重测）===");
console.log(`语料快照：${fp.count} 文件 / ${fp.totalBytes.toLocaleString("en-US")} B / fnv1a=${fp.fnv1a}`);
console.log(`单文件：max=${sizes[sizes.length - 1].toLocaleString("en-US")}B  median=${median.toLocaleString("en-US")}B  min=${sizes[0].toLocaleString("en-US")}B`);

const byWs = new Map();
for (const f of files) {
  const e = byWs.get(f.workspaceDir) ?? { n: 0, bytes: 0 };
  e.n++;
  e.bytes += f.size;
  byWs.set(f.workspaceDir, e);
}
console.log(`\n工作区数：${byWs.size}`);
for (const [ws, e] of [...byWs.entries()].sort((a, b) => b[1].bytes - a[1].bytes)) {
  console.log(`  ${ws.padEnd(46)} ${String(e.n).padStart(3)} 个会话  ${e.bytes.toLocaleString("en-US").padStart(12)} B`);
}

// 全量逐帧解码 + 解析，实测耗时
console.log("\n-- 全量刷新实测（逐帧解码 + JSONL 解析 + 用量归集）--");
const t0 = Date.now();
let frames = 0;
let failed = 0;
let decoded = 0;
let records = 0;
let usages = 0;
let peakRss = 0;
for (const f of files) {
  const r = readSessionLog(f.path);
  frames += r.multi.candidateFrames;
  failed += r.multi.failed;
  decoded += r.multi.bytes;
  const { records: recs } = parseJsonl(r.multi.text);
  records += recs.length;
  usages += usageRecords(recs).length;
  const rss = process.memoryUsage().rss;
  if (rss > peakRss) peakRss = rss;
}
const ms = Date.now() - t0;
console.log(`  文件=${files.length}  帧=${frames}  失败帧=${failed}  解压字节=${decoded.toLocaleString("en-US")}`);
console.log(`  JSONL 记录=${records.toLocaleString("en-US")}  用量记录=${usages.toLocaleString("en-US")}`);
console.log(`  实测耗时=${ms} ms   峰值 RSS=${(peakRss / 1048576).toFixed(1)} MiB`);
console.log(`  吞吐=${(fp.totalBytes / 1048576 / (ms / 1000)).toFixed(1)} MiB/s（压缩输入口径）`);

const failures = [];
if (failed > 0) failures.push(`全量刷新出现 ${failed} 个失败帧（不得静默跳过）`);
if (ms > 60000) failures.push(`全量刷新耗时 ${ms}ms 超过 60s 阈值`);

console.log("\n=== 判定 ===");
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`  OK  全量 ${files.length} 文件 / ${decoded.toLocaleString("en-US")} 字节在 ${ms}ms 内完成，无失败帧、无 OOM`);
process.exit(0);
