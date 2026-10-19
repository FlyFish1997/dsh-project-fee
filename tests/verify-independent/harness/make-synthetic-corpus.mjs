// 生成「自造大体量会话日志」，供多帧解码的否证夹具使用。
//
// 为什么需要它：损坏帧 / 截断夹具必须建立在一份**帧数多、可压缩**的日志上，
// 否则 frame 边界扫描与压缩比性质无法体现。
// 本生成器用固定种子产出同量级、同性质的语料，不含任何真实数据。
//
// 设计要点：帧数多、帧大小不均匀；记录结构与 DSH 会话日志同构
// （session 头 + 每帧 assistant/message(带 data.usage) + request/context + tool/result），
// 因此「多帧扫描 / 一次性解压静默截断 / 截断帧检测」这些性质都可被检验。
//
// 复现：node tests/verify-independent/harness/make-synthetic-corpus.mjs
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// 合成语料落盘位置：默认 `tests/verify-independent/fixtures/synthetic-home`；
// 沙箱内跑时随 `DSH_TEST_TMP` 重定向到可写目录（见 README.md「测试与受限环境」）。
export const SYNTHETIC_ROOT = process.env.DSH_TEST_TMP
  ? join(resolve(process.env.DSH_TEST_TMP), "fixtures", "synthetic-home")
  : join(HERE, "..", "fixtures", "synthetic-home");
export const SYNTHETIC_WS_DIR = "--D-work-synthetic-corpus--";
export const SYNTHETIC_SESSION_ID = "session-00000000-0000-4000-8000-0000000c0a1e";
export const SYNTHETIC_SOURCE_PATH = join(
  SYNTHETIC_ROOT,
  "sessions",
  SYNTHETIC_WS_DIR,
  SYNTHETIC_SESSION_ID,
  "session.v3.jsonl.zstd",
);

/** 确定性 PRNG（mulberry32）——保证每次生成字节级一致。 */
function prng(seed) {
  let a = seed >>> 0;
  return function next() {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const MODELS = ["deepseek-flash", "deepseek-flash", "deepseek-flash", "deepseek-v4-pro"];
const CWD = "D:\\work\\synthetic-corpus";
const T0 = Date.UTC(2026, 8, 14, 1, 0, 0); // 2026-09-14 09:00 北京时间（周一，高峰）

/**
 * 生成一份自造会话日志（多帧 zstd）。
 * @param {object} [opts]
 * @param {number} [opts.frames] 目标帧数
 * @param {number} [opts.recordsPerFrame] 每帧记录数
 * @param {number} [opts.seed] PRNG 种子
 * @returns {{raw:Buffer, frames:number, decodedBytes:number, usages:number}}
 */
/**
 * 每帧附带的结构化填充。
 *
 * 为什么需要它：真实会话日志之所以有 ~3x 压缩比与 MB 级体积，主要来自工具结果、
 * 长消息正文这类大块文本。若自造语料只有小记录，体积会小一个数量级，
 * 「多帧扫描 / 压缩比 / 截断检测」这些性质就无法在同量级上被检验。
 * 这里用**可复现的合成文本**（非随机噪声）填充到同量级 ——
 * 噪声几乎不可压缩，会让磁盘体积远超真实日志，反而不像真实语料。
 */
function makePadding(rnd, targetBytes) {
  const words = ["record", "usage", "session", "token", "cache", "output", "input", "step", "turn", "workspace"];
  const parts = [];
  let n = 0;
  let round = 0;
  while (n < targetBytes) {
    round += 1;
    const line =
      `${String(round).padStart(4, "0")}  ` +
      Array.from({ length: 12 }, () => words[Math.floor(rnd() * words.length)]).join(" ") +
      `  ref=${Math.floor(rnd() * 1e9).toString(36)}  status=ok\n`;
    parts.push(line);
    n += line.length;
  }
  return parts.join("");
}

export function buildSyntheticCorpus(opts = {}) {
  const frames = opts.frames ?? 880;
  const perFrame = opts.recordsPerFrame ?? 4;
  const padBytesPerFrame = opts.padBytesPerFrame ?? 8_000;
  const rnd = prng(opts.seed ?? 20260914);

  const chunks = [];
  let seq = 0;
  let usages = 0;
  let decodedBytes = 0;
  let time = T0;

  const header =
    JSON.stringify({
      type: "session",
      version: 3,
      id: SYNTHETIC_SESSION_ID,
      createdAt: T0,
      cwd: CWD,
      isSeeded: false,
      agentPreset: "standard",
    }) + "\n";
  chunks.push(Buffer.from(header, "utf8"));
  decodedBytes += Buffer.byteLength(header);

  for (let fi = 0; fi < frames; fi += 1) {
    const lines = [];
    for (let ri = 0; ri < perFrame; ri += 1) {
      seq += 1;
      time += 1500 + Math.floor(rnd() * 4000);
      const model = MODELS[Math.floor(rnd() * MODELS.length)];
      // 桶语义与真实 DSH 日志一致：input 即未命中桶，output 已含 reasoning
      const cacheRead = Math.floor(rnd() * 9000) + 1024;
      const input = Math.floor(rnd() * 1200);
      const output = Math.floor(rnd() * 600) + 30;
      const reasoning = Math.floor(output * rnd() * 0.6);
      const usage = {
        inputTokens: input,
        outputTokens: output,
        totalTokens: input + output + cacheRead,
        cacheReadTokens: cacheRead,
        reasoningTokens: reasoning,
      };
      usages += 1;
      lines.push(
        JSON.stringify({
          type: "assistant/message",
          seq,
          time,
          data: {
            turn: fi + 1,
            step: ri + 1,
            message: {
              role: "assistant",
              content: [{ type: "text", text: `synthetic record ${seq}` }],
              source: { kind: "model", provider: "deepseek-official", model },
            },
            usage,
          },
        }),
      );
      if (ri === 0) {
        lines.push(
          JSON.stringify({
            type: "request/context",
            seq,
            time,
            data: { provider: "deepseek-official", model, contextWindow: 1000000 },
          }),
        );
      }
      if (ri === perFrame - 1) {
        // 模拟该帧内一次工具结果的体量（可复现、非噪声）。
        // 帧大小刻意**不均匀**：真实日志里帧长度差异很大（小到 80B、大到数十 KB），
        // 而「帧内截断静默吐出部分字节」这一性质只在**多块**帧上才成立 ——
        // 均匀的大帧会被压成单块，截断后一个字节都吐不出来。每第 5 帧留小，
        // 保证语料里既有小块帧也有大块帧，与真实形态一致。
        const pad = fi % 5 === 2 ? 0 : padBytesPerFrame;
        if (pad > 0) {
          lines.push(
            JSON.stringify({
              type: "tool/result",
              seq,
              time,
              data: { callId: `call-${seq}`, name: "read", output: makePadding(rnd, pad) },
            }),
          );
        }
      }
    }
    // 每帧独立压缩 → 形成多帧拼接流（与真实日志的写入方式一致）
    const payload = Buffer.from(lines.join("\n") + "\n", "utf8");
    decodedBytes += payload.length;
    chunks.push(zstdCompressSync(payload));
  }

  return { raw: Buffer.concat(chunks), frames, decodedBytes, usages };
}

/** 写入自造语料目录（幂等：已存在则先清空）。 */
export function makeSyntheticCorpus(opts = {}) {
  const built = buildSyntheticCorpus(opts);
  if (existsSync(SYNTHETIC_ROOT)) rmSync(SYNTHETIC_ROOT, { recursive: true, force: true });
  mkdirSync(dirname(SYNTHETIC_SOURCE_PATH), { recursive: true });
  writeFileSync(SYNTHETIC_SOURCE_PATH, built.raw);
  return { ...built, path: SYNTHETIC_SOURCE_PATH };
}

// 直接执行时：生成并打印性质
if (process.argv[1] && process.argv[1].endsWith("make-synthetic-corpus.mjs")) {
  const r = makeSyntheticCorpus();
  console.log("自造语料已生成:", r.path);
  console.log(`  帧数        : ${r.frames}`);
  console.log(`  磁盘字节    : ${r.raw.length.toLocaleString("en-US")} B`);
  console.log(`  解压字节    : ${r.decodedBytes.toLocaleString("en-US")} B`);
  console.log(`  压缩比      : ${(r.decodedBytes / r.raw.length).toFixed(2)}x`);
  console.log(`  usage 记录  : ${r.usages}`);
}
