// 独立验证用：多帧 zstd 解码器
// 刻意不复用被测实现（lib/session-log.js）的任何代码或常量。
// 作者：独立验证者。仅依赖 node:zlib。
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

export const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];

/** 扫描所有 zstd 帧魔数出现位置（可能包含压缩数据里的巧合假阳性，靠解压结果证伪）。 */
export function scanMagic(buf) {
  const starts = [];
  for (let i = 0; i + 3 < buf.length; i++) {
    if (
      buf[i] === ZSTD_MAGIC[0] &&
      buf[i + 1] === ZSTD_MAGIC[1] &&
      buf[i + 2] === ZSTD_MAGIC[2] &&
      buf[i + 3] === ZSTD_MAGIC[3]
    ) {
      starts.push(i);
    }
  }
  return starts;
}

/**
 * 逐帧解压并拼接。每个候选帧从本魔数到下一个魔数（或 EOF）。
 * 解压失败必须显式记录，绝不静默跳过。
 */
export function decodeFrames(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const starts = scanMagic(buf);
  const parts = [];
  const failures = [];
  let ok = 0;
  for (let k = 0; k < starts.length; k++) {
    const start = starts[k];
    const end = k + 1 < starts.length ? starts[k + 1] : buf.length;
    try {
      const out = zstdDecompressSync(buf.subarray(start, end));
      ok++;
      parts.push(out);
    } catch (err) {
      failures.push({ offset: start, end, code: err?.code ?? null, message: String(err?.message ?? err) });
    }
  }
  const joined = Buffer.concat(parts);
  return {
    candidateFrames: starts.length,
    frameStarts: starts,
    ok,
    failed: failures.length,
    failures,
    bytes: joined.length,
    buffer: joined,
    text: joined.toString("utf8"),
  };
}

/** 对整文件一次性解压。用于反证「一次性解压不可用」。 */
export function decodeOneShot(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  try {
    const out = zstdDecompressSync(buf);
    return { ok: true, bytes: out.length, buffer: out, error: null };
  } catch (err) {
    return { ok: false, bytes: null, buffer: null, error: { code: err?.code ?? null, message: String(err?.message ?? err) } };
  }
}

/**
 * 读一个 session.v3.jsonl.zstd：
 * - decoded：逐帧解码文本
 * - oneShot：一次性解码结果（对照）
 * 注意：一次性解压「成功但字节数远小」是最危险的情形（静默截断，不报错）。
 */
export function readSessionLog(path) {
  const raw = readFileSync(path);
  const multi = decodeFrames(raw);
  const oneShot = decodeOneShot(raw);
  return { path, rawBytes: raw.length, multi, oneShot };
}
