// 独立验证用：构造否证所需 fixture（全部自造，不含被测代码）
//
// 产物（tests/fixtures/）：
//   two-frame.jsonl.zstd      恰好 2 帧，两帧内容可区分 → 断言两帧都出现
//   truncated.jsonl.zstd      自造语料截断到 60% → 必须报错或计入 gaps
//   corrupt-frame.jsonl.zstd  自造语料第 2 帧中间被破坏 → 必须计入 gaps
//   non-jsonl.jsonl.zstd      合法 zstd 但行不是 JSON → 必须计入 gaps
//   future-time.jsonl.zstd    含未来时间戳记录 → 边界行为要明确定义
//   empty-workspace/          空工作区（无任何会话日志）
//
// 源语料是**自造**的（见 make-synthetic-corpus.mjs）：固定种子、可复现，测试不读取
// `$DSH_HOME/sessions` 里的任何真实会话日志。
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, statSync, rmSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readSessionLog } from "./zstd-frames.mjs";
import { makeSyntheticCorpus, SYNTHETIC_ROOT } from "./make-synthetic-corpus.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
// fixture 输出目录：默认 `tests/fixtures`（交付物，随仓库提交）；
// 沙箱内跑时用 `DSH_TEST_TMP` 指到可写的新建目录（受限子进程写不了已存在的子目录，
// 见 README.md「测试与受限环境」），这样验证也不会改写交付树里的 fixture。
export const FIXTURE_DIR = process.env.DSH_TEST_TMP
  ? join(resolve(process.env.DSH_TEST_TMP), "fixtures")
  : join(HERE, "..", "..", "fixtures");

/** 造一个「看起来合法」的会话日志（可指定 cwd / 时间戳 / 用量）。 */
export function buildSessionLog({ cwd = "D:\\work\\synthetic", sessionId = "session-00000000-0000-4000-8000-000000000001", usage = null, time = Date.now() } = {}) {
  const recs = [];
  recs.push({ type: "session", version: 3, id: sessionId, createdAt: time, cwd, isSeeded: false });
  if (usage) {
    recs.push({
      type: "assistant/message",
      seq: 1,
      time,
      data: {
        turn: 1,
        step: 1,
        message: { role: "assistant", content: [{ type: "text", text: "synthetic" }], source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
        usage,
      },
    });
  }
  return Buffer.from(recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
}

export function makeFixtures() {
  mkdirSync(FIXTURE_DIR, { recursive: true });
  const made = [];

  // 1) 恰好 2 帧
  {
    const a = Buffer.from('{"type":"frame-one","seq":1,"time":1,"data":{"usage":{"inputTokens":10,"outputTokens":1,"totalTokens":11,"cacheReadTokens":0,"reasoningTokens":0}}}\n', "utf8");
    const b = Buffer.from('{"type":"frame-two","seq":2,"time":2,"data":{"usage":{"inputTokens":20,"outputTokens":2,"totalTokens":22,"cacheReadTokens":0,"reasoningTokens":0}}}\n', "utf8");
    const buf = Buffer.concat([zstdCompressSync(a), zstdCompressSync(b)]);
    const p = join(FIXTURE_DIR, "two-frame.jsonl.zstd");
    writeFileSync(p, buf);
    made.push({ path: p, bytes: buf.length, note: "2 frames, distinct payloads" });
  }

  // 源语料：**自造**（固定种子、可复现），不含任何真实会话内容
  const synthetic = makeSyntheticCorpus();
  const sourceStats = {
    kind: "synthetic",
    generator: "harness/make-synthetic-corpus.mjs",
    seed: 20260914,
    path: relative(join(HERE, "..", "..", ".."), synthetic.path).split("\\").join("/"),
    rawBytes: synthetic.raw.length,
    frames: synthetic.frames,
    decodedBytes: synthetic.decodedBytes,
    note: "自造多帧语料；不使用 $DSH_HOME/sessions 中的真实日志",
  };
  {
    const raw = synthetic.raw;
    // 2) 截断到 60%
    {
      const buf = raw.subarray(0, Math.floor(raw.length * 0.6));
      const p = join(FIXTURE_DIR, "truncated.jsonl.zstd");
      writeFileSync(p, buf);
      made.push({ path: p, bytes: buf.length, note: `truncated 60% of ${raw.length}B synthetic corpus` });
    }
    // 3) 破坏第 2 帧中间
    {
      const buf = Buffer.from(raw);
      const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
      const starts = [];
      for (let i = 0; i + 3 < buf.length; i++) if (buf.compare(magic, 0, 4, i, i + 4) === 0) starts.push(i);
      if (starts.length >= 3) {
        const s2 = starts[1];
        const s3 = starts[2];
        const mid = Math.floor((s2 + s3) / 2);
        for (let k = mid; k < Math.min(mid + 16, s3); k++) buf[k] = 0xff;
        const p = join(FIXTURE_DIR, "corrupt-frame.jsonl.zstd");
        writeFileSync(p, buf);
        made.push({ path: p, bytes: buf.length, note: `corrupted byte range ${mid}..${Math.min(mid + 16, s3)} inside frame#2 (frames total ${starts.length})` });
      }
      // 3b) 确定性地截断在某一帧内部（帧头后 3 字节处切断）→ 该帧必然解压失败
      if (starts.length >= 3) {
        const cut = Math.min(starts[2] + 20, starts[3] - 1);
        const buf2 = Buffer.from(raw.subarray(0, cut));
        const p2 = join(FIXTURE_DIR, "truncated-mid-frame.jsonl.zstd");
        writeFileSync(p2, buf2);
        made.push({ path: p2, bytes: buf2.length, note: `cut ${cut}B inside frame#3 (deterministic mid-frame truncation)` });
      }
    }
  }

  // 4) 合法 zstd、行非 JSON
  {
    const payload = Buffer.from("THIS IS NOT JSON\nNEITHER IS THIS\n{\"ok\":1}\n{\"broken\":\n", "utf8");
    const buf = zstdCompressSync(payload);
    const p = join(FIXTURE_DIR, "non-jsonl.jsonl.zstd");
    writeFileSync(p, buf);
    made.push({ path: p, bytes: buf.length, note: "valid zstd, 3 of 4 lines not valid JSON" });
  }

  // 5) 未来时间戳
  {
    const future = Date.now() + 30 * 24 * 3600 * 1000;
    const buf = zstdCompressSync(
      buildSessionLog({ sessionId: "session-00000000-0000-4000-8000-0000000000ff", usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 0, reasoningTokens: 0 }, time: future }),
    );
    const p = join(FIXTURE_DIR, "future-time.jsonl.zstd");
    writeFileSync(p, buf);
    made.push({ path: p, bytes: buf.length, note: `record time = now + 30d (${new Date(future).toISOString()})` });
  }

  // 6) 空工作区
  {
    const d = join(FIXTURE_DIR, "empty-workspace");
    mkdirSync(d, { recursive: true });
    made.push({ path: d, bytes: 0, note: "directory with no session logs" });
  }

  // 7) 合成「跨峰谷」会话（同一工作区，8 条记录落在边界点上）
  {
    const recs = [];
    const cwd = "D:\\work\\synthetic-boundary";
    recs.push({ type: "session", version: 3, id: "session-00000000-0000-4000-8000-00000000000b", cwd, isSeeded: false, createdAt: 1789000000000 });
    recs.push({ type: "request/context", seq: 1, time: 1789000000000, data: { provider: "deepseek-official", model: "deepseek-flash" } });
    // 2026-09-14 是周一；北京时间 08:59:59 等 8 个点
    const pts = [[8, 59, 59], [9, 0, 0], [11, 59, 59], [12, 0, 0], [13, 59, 59], [14, 0, 0], [17, 59, 59], [18, 0, 0]];
    let seq = 2;
    for (const [h, mi, s] of pts) {
      const ms = Date.UTC(2026, 8, 14, h - 8, mi, s);
      recs.push({
        type: "assistant/message",
        seq: seq++,
        time: ms,
        data: {
          turn: 1, step: 1,
          message: { role: "assistant", content: [{ type: "text", text: "x" }], source: { kind: "model", provider: "deepseek-official", model: "deepseek-flash" } },
          usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cacheReadTokens: 0, reasoningTokens: 0 },
        },
      });
    }
    const buf = zstdCompressSync(Buffer.from(recs.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8"));
    const p = join(FIXTURE_DIR, "boundary-peak-valley.jsonl.zstd");
    writeFileSync(p, buf);
    made.push({ path: p, bytes: buf.length, note: "8 records at Beijing workday switch points, 1M miss tokens each" });
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    note: "全部自造 fixture，供独立验证的否证复现；源语料由 harness/make-synthetic-corpus.mjs 生成，**不含任何真实会话内容**",
    source: sourceStats,
    fixtures: made.map((m) => ({ file: m.path.replace(FIXTURE_DIR, "").replace(/^[\\/]/, ""), bytes: m.bytes, note: m.note })),
  };
  writeFileSync(join(FIXTURE_DIR, "MANIFEST.json"), JSON.stringify(manifest, null, 2), "utf8");
  // 自造源语料本身不是交付物。这里把它从盘上清掉，但把 buffer 挂在返回数组上，
  // 供调用方在同一进程内继续做「完整 vs 截断」的对照（不再依赖它还在盘上）。
  made.sourceBuffer = Buffer.from(synthetic.raw);
  made.sourceStats = sourceStats;
  if (existsSync(SYNTHETIC_ROOT)) rmSync(SYNTHETIC_ROOT, { recursive: true, force: true });
  return made;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const made = makeFixtures();
  console.log(`fixtures written to ${FIXTURE_DIR}:`);
  for (const m of made) console.log(`  ${m.path}  ${m.bytes}B  ${m.note}`);
}
