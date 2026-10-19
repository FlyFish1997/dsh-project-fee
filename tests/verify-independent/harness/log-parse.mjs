// 独立验证用：JSONL 解析 + gaps 记账（刻意不复用被测实现）
// 原则：任何坏行/非 JSONL 行都必须显式落到 gaps，绝不静默跳过。

/** 解析解码后的文本为记录；坏行单独收集。 */
export function parseJsonl(text) {
  const records = [];
  const badLines = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.trim() === "") continue;
    try {
      records.push({ line: i + 1, rec: JSON.parse(raw) });
    } catch (err) {
      badLines.push({ line: i + 1, snippet: raw.slice(0, 120), error: String(err?.message ?? err) });
    }
  }
  return { records, badLines };
}

/** 取出所有带 data.usage 的记录。 */
export function usageRecords(records) {
  const out = [];
  for (const { line, rec } of records) {
    const u = rec?.data?.usage;
    if (u && typeof u === "object") out.push({ line, type: rec.type, seq: rec.seq, time: rec.time, usage: u });
  }
  return out;
}

/** 口径 B：把 data.stream[].chunk.usage 也当成用量来源。 */
export function streamChunkUsageRecords(records) {
  const out = [];
  for (const { line, rec } of records) {
    const st = rec?.data?.stream;
    if (!Array.isArray(st)) continue;
    for (const s of st) {
      const u = s?.chunk?.usage;
      if (u && typeof u === "object") out.push({ line, type: rec.type, seq: rec.seq, time: rec.time, usage: u });
    }
  }
  return out;
}

/** 按 (type,seq) 去重，保留首次出现。 */
export function dedupeByTypeSeq(items) {
  const seen = new Set();
  const kept = [];
  const dropped = [];
  for (const it of items) {
    const key = `${it.type}#${it.seq}`;
    if (seen.has(key)) dropped.push(it);
    else {
      seen.add(key);
      kept.push(it);
    }
  }
  return { kept, dropped };
}

/** 四个 token 桶求和（按 DSH 语义：input 即 uncached）。 */
export function bucketsOf(u) {
  return {
    input: u.inputTokens ?? 0,
    output: u.outputTokens ?? 0,
    cacheRead: u.cacheReadTokens ?? 0,
    cacheWrite: u.cacheWriteTokens ?? 0,
    reasoning: u.reasoningTokens ?? 0,
    total: u.totalTokens ?? 0,
  };
}

/**
 * 模型归属（我自己的实现，独立于被测代码）：
 *   1) 优先取用量记录自身的 data.message.source.model
 *   2) 否则回退到此前最近一次 request/context 或 request/header 的 model
 */
export function attributeModels(records) {
  let last = null;
  const out = [];
  for (const { line, rec } of records) {
    const t = rec?.type;
    if (t === "request/context" && rec?.data?.model) last = rec.data.model;
    else if (t === "request/header" && rec?.data?.header?.config?.model) last = rec.data.header.config.model;
    const u = rec?.data?.usage;
    if (!u) continue;
    const direct = rec?.data?.message?.source?.model ?? null;
    out.push({ line, type: t, seq: rec.seq, time: rec.time, model: direct ?? last, modelSource: direct ? "message.source" : "fallback", usage: u });
  }
  return out;
}

/** token 总量（单一桶口径，用于反证 (a) 侧）。 */
export function tokensOf(u) {
  const b = bucketsOf(u);
  return b.input + b.output + b.cacheRead + b.cacheWrite;
}
