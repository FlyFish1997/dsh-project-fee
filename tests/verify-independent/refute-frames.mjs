// 独立验证：多帧 zstd 反证
//  1) 一次性解压整文件的字节数远小于逐帧拼接（且可能「成功但静默截断」）
//  2) 恰好 2 帧的文件：断言两帧内容都出现
//  3) 损坏帧必须被检出（不得静默跳过）
//  4) 截断文件必须显式暴露失败/缺口
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readSessionLog } from "./harness/zstd-frames.mjs";
import { parseJsonl } from "./harness/log-parse.mjs";
import { listSessionFiles, snapshotFingerprint } from "./harness/corpus.mjs";
import { makeFixtures, FIXTURE_DIR } from "./harness/fixtures.mjs";

const fixturesMade = makeFixtures();
// 源语料是自造的，且 makeFixtures 结束时已从盘上清掉（它不是交付物）。
// 同进程内继续做「完整 vs 截断」对照所需的字节由这里取，不再依赖磁盘上的源文件。
const SOURCE_BUFFER = fixturesMade.sourceBuffer;
const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== 多帧解码反证 ===");

// 1) 全语料：一次性 vs 逐帧
const files = listSessionFiles();
const fp = snapshotFingerprint(files);
console.log(`语料快照：${fp.count} 文件 / ${fp.totalBytes.toLocaleString("en-US")} B / fnv1a=${fp.fnv1a}\n`);
console.log("-- 1) 一次性解压 vs 逐帧拼接（前 8 大文件）--");
console.log("  文件bytes     帧数   成功  失败   逐帧拼接bytes   一次性bytes   一次性/逐帧");
let anyOneShotSilentlyTruncated = 0;
for (const f of files.slice(0, 8)) {
  const r = readSessionLog(f.path);
  const os = r.oneShot.ok ? r.oneShot.bytes : null;
  const ratio = os !== null && r.multi.bytes > 0 ? (os / r.multi.bytes).toFixed(6) : "n/a";
  if (os !== null && os < r.multi.bytes) anyOneShotSilentlyTruncated++;
  console.log(
    `  ${String(r.rawBytes).padStart(9)}  ${String(r.multi.candidateFrames).padStart(5)}  ${String(r.multi.ok).padStart(5)}  ${String(r.multi.failed).padStart(5)}  ${String(r.multi.bytes).padStart(14)}  ${String(os ?? "ERR").padStart(12)}   ${ratio}`,
  );
}
{
  const biggest = files[0];
  const r = readSessionLog(biggest.path);
  const os = r.oneShot.ok ? r.oneShot.bytes : null;
  console.log(`\n  最大文件：${biggest.path}`);
  console.log(`    帧总数=${r.multi.candidateFrames} 解码成功=${r.multi.ok} 解码失败=${r.multi.failed}`);
  console.log(`    逐帧拼接=${r.multi.bytes.toLocaleString("en-US")}B   一次性解压=${os}B`);
  check("最大文件逐帧解码无失败", r.multi.failed === 0, `failed=${r.multi.failed}`);
  check("逐帧拼接字节 > 一次性解压字节", r.multi.bytes > (os ?? 0), `multi=${r.multi.bytes} oneShot=${os}`);
  check(
    "一次性解压只拿到极小片段（<1% 逐帧）",
    os !== null && os < r.multi.bytes * 0.01,
    `oneShot=${os} multi=${r.multi.bytes}`,
  );
  check("一次性解压「不报错但静默截断」这一情形存在", os !== null, `oneShot.ok=${r.oneShot.ok} bytes=${os}`);
}

// 2) 恰好 2 帧
console.log("\n-- 2) 恰好 2 帧文件：断言两帧内容都出现 --");
{
  const p = join(FIXTURE_DIR, "two-frame.jsonl.zstd");
  const r = readSessionLog(p);
  console.log(`  rawBytes=${r.rawBytes} 帧总数=${r.multi.candidateFrames} 成功=${r.multi.ok} 失败=${r.multi.failed} 拼接=${r.multi.bytes}B`);
  console.log(`  解出内容: ${JSON.stringify(r.multi.text)}`);
  const { records, badLines } = parseJsonl(r.multi.text);
  const types = records.map((x) => x.rec.type);
  console.log(`  解析记录 type: ${JSON.stringify(types)}  坏行=${badLines.length}`);
  check("恰好识别出 2 帧", r.multi.candidateFrames === 2, `candidateFrames=${r.multi.candidateFrames}`);
  check("两帧都解出", r.multi.ok === 2 && r.multi.failed === 0, `ok=${r.multi.ok} failed=${r.multi.failed}`);
  check("第 1 帧内容出现", types.includes("frame-one"), JSON.stringify(types));
  check("第 2 帧内容出现（只解首帧会漏掉它）", types.includes("frame-two"), JSON.stringify(types));
  const osB = r.oneShot.ok ? r.oneShot.bytes : -1;
  console.log(`  对照：一次性解压该 2 帧文件 = ${osB}B（只覆盖首帧内容）`);
  check("一次性解压漏掉第 2 帧", r.oneShot.ok && !parseJsonl(r.oneShot.buffer.toString("utf8")).records.some((x) => x.rec.type === "frame-two"), `oneShot=${osB}B`);
}

// 3) 损坏帧
console.log("\n-- 3) 损坏帧必须被检出 --");
{
  const p = join(FIXTURE_DIR, "corrupt-frame.jsonl.zstd");
  const r = readSessionLog(p);
  console.log(`  帧总数=${r.multi.candidateFrames} 成功=${r.multi.ok} 失败=${r.multi.failed}`);
  console.log(`  失败样例: ${JSON.stringify(r.multi.failures.slice(0, 2))}`);
  check("损坏帧被显式记为失败（不静默跳过）", r.multi.failed > 0, `failed=${r.multi.failed}`);
}

// 4) 截断文件
console.log("\n-- 4) 截断文件：Node 的 zstd 对「截断」不报错（静默部分输出）--");
{
  const manifest = JSON.parse(readFileSync(join(FIXTURE_DIR, "MANIFEST.json"), "utf8"));
  const src = manifest.source;
  console.log(`  源文件（fixture 生成时锁定）：${src.path}`);
  console.log(`    完整：${src.rawBytes}B → ${src.frames} 帧 / ${src.decodedBytes}B`);
  const p = join(FIXTURE_DIR, "truncated.jsonl.zstd");
  const r = readSessionLog(p);
  console.log(`  截断（落在帧边界）：${r.rawBytes}B → ${r.multi.candidateFrames} 帧 / ${r.multi.bytes}B（失败帧=${r.multi.failed}）`);
  check("截断后帧数少于完整文件（缺失被如实反映，不是凭空补全）", r.multi.candidateFrames < src.frames, `${r.multi.candidateFrames} < ${src.frames}`);
  check("截断后拼接字节少于完整文件", r.multi.bytes < src.decodedBytes, `${r.multi.bytes} < ${src.decodedBytes}`);

  // 帧内截断：zstd 不抛错，只给部分字节
  const p2 = join(FIXTURE_DIR, "truncated-mid-frame.jsonl.zstd");
  const r2 = readSessionLog(p2);
  console.log(`\n  截断（落在帧内）：${r2.rawBytes}B → ${r2.multi.candidateFrames} 帧 / 成功=${r2.multi.ok} 失败=${r2.multi.failed}`);
  check(
    "★ Node zstd 对帧内截断【不抛错】（只能靠字节数缩水/坏行发现）",
    r2.multi.failed === 0,
    `failed=${r2.multi.failed}（若这里变成 >0，说明 Node 行为变了，需重新评估检测手段）`,
  );

  // 同一尾帧：完整 vs 截断，字节数应缩水（静默部分输出）
  const M = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
  function magicsOf(b) {
    const s = [];
    for (let i = 0; i + 3 < b.length; i++) if (b.compare(M, 0, 4, i, i + 4) === 0) s.push(i);
    return s;
  }
  const fullBuf = SOURCE_BUFFER;
  const fullStarts = magicsOf(fullBuf);
  const tStarts = magicsOf(readFileSync(p2));
  const idx = tStarts.length - 1;
  const { zstdDecompressSync } = await import("node:zlib");
  let fullTailLen = null;
  try {
    const s = fullStarts[idx];
    const e = idx + 1 < fullStarts.length ? fullStarts[idx + 1] : fullBuf.length;
    fullTailLen = zstdDecompressSync(fullBuf.subarray(s, e)).length;
  } catch (err) {
    console.log(`  完整尾帧解压异常：${err.code || err.message}`);
  }
  const tBuf = readFileSync(p2);
  const s = tStarts[idx];
  const tOut = zstdDecompressSync(tBuf.subarray(s, tBuf.length));
  console.log(`  同一帧 #${idx}：完整解压=${fullTailLen}B，截断后解压=${tOut.length}B（未抛错）`);
  check(
    "★ 截断帧「静默」吐出的字节数远小于完整帧（数据已被悄悄丢掉）",
    fullTailLen !== null && tOut.length < fullTailLen,
    `truncated=${tOut.length}B full=${fullTailLen}B`,
  );

  // 该静默丢失必须在某个层面暴露出来，否则就是静默跳过。
  //
  // 实测约束（Node v24.19.0，本地复现）：帧内截断是否吐出**部分字节**取决于帧的
  // 解压后规模 —— 约 <100KB 的帧被压成单块，截断后返回 **0 字节**（无部分输出）；
  // 只有更大的帧才会吐出部分内容。因此「部分输出 → JSONL 坏行」这条链路
  // **不能在所有语料上都被触发**，它依赖语料的帧规模。
  //
  // 所以这里的判据是：静默丢失必须**可被看见** —— 要么在 JSONL 层表现为坏行，
  // 要么表现为字节数缩水（由上面两条断言覆盖）。两者都不可见才是缺陷。
  const { records, badLines } = parseJsonl(r2.multi.text);
  console.log(`  JSONL 层：好记录=${records.length} 坏行=${badLines.length}`);
  console.log(`  尾部落下的片段：${JSON.stringify(r2.multi.text.slice(-40))}`);
  const lossVisible = badLines.length > 0 || r2.multi.bytes < src.decodedBytes;
  check(
    "★ 静默截断造成的丢失可被看见（JSONL 坏行 或 字节数缩水），不是无声无息",
    lossVisible,
    `badLines=${badLines.length} multiBytes=${r2.multi.bytes} < srcDecoded=${src.decodedBytes}`,
  );
}

// 5) 非 JSONL
console.log("\n-- 5) 合法 zstd 但行非 JSON --");
{
  const p = join(FIXTURE_DIR, "non-jsonl.jsonl.zstd");
  const r = readSessionLog(p);
  const { records, badLines } = parseJsonl(r.multi.text);
  console.log(`  解出=${JSON.stringify(r.multi.text)}`);
  console.log(`  好记录=${records.length} 坏行=${badLines.length} 坏行样例=${JSON.stringify(badLines[0] ?? null)}`);
  check("非 JSON 行被显式记为坏行", badLines.length === 3, `badLines=${badLines.length}`);
  check("合法行仍被保留", records.length === 1, `records=${records.length}`);
}

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}（${c.detail}）`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
