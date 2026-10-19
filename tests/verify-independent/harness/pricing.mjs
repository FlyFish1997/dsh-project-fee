// 独立验证用：峰谷定价（自算，刻意不复用被测实现）
//
// 依据（我自己实读）：
//  - dsh-context/lib/client.js:7383
//      total += (cacheRead*hit + (uncached+cacheWrite)*miss + output*out)/1e6
//  - dsh-context zh 文案：「按请求时间区分高峰（北京时间工作日 9:00–12:00、14:00–18:00）
//      与空闲时段（半价，周末全天均为空闲时段）」、峰值价 = 空闲价 ×2
//  - pi-ai openai-completions.js:1193  input = prompt - cacheRead - cacheWrite  （input 即 uncached）
//  - pi-ai openai-completions.js:1194  // OpenAI completion_tokens already includes reasoning_tokens.
//      → outputTokens 已含 reasoning，禁止再加 reasoningTokens

const HOUR_MS = 3600_000;

/** 人民币价目（CNY / 1M tokens）。键序 = dsh-context 的 family 顺序。 */
export const RATES_CNY = {
  flash: { off: { hit: 0.02, miss: 1.0, out: 4.0 }, peak: { hit: 0.04, miss: 2.0, out: 8.0 } },
  pro: { off: { hit: 0.15, miss: 4.5, out: 13.5 }, peak: { hit: 0.3, miss: 9.0, out: 27.0 } },
};

/** 由「北京时间」墙钟时间构造 epoch ms（与运行机器时区无关）。 */
export function beijingEpoch(y, month1, day, h = 0, mi = 0, s = 0) {
  return Date.UTC(y, month1 - 1, day, h - 8, mi, s);
}

/** 北京时间（UTC+8）下的日/时/分/秒，与运行机器时区无关。 */
export function beijingParts(epochMs) {
  const d = new Date(epochMs + 8 * HOUR_MS);
  return {
    dow: d.getUTCDay(), // 0=周日 … 6=周六
    h: d.getUTCHours(),
    m: d.getUTCMinutes(),
    s: d.getUTCSeconds(),
    iso: d.toISOString().replace("Z", "+08:00"),
  };
}

/** 高峰时段：北京时间工作日 [09:00,12:00) 或 [14:00,18:00)；周末全天空闲。 */
export function segmentOf(epochMs) {
  const { dow, h } = beijingParts(epochMs);
  if (dow === 0 || dow === 6) return "off";
  if (h >= 9 && h < 12) return "peak";
  if (h >= 14 && h < 18) return "peak";
  return "off";
}

/** 模型名 → 价目族。参照 dsh-context 的按模型名匹配（旧 ID 亦按 Flash）。 */
export function familyOf(model) {
  const m = String(model ?? "").toLowerCase();
  if (m.includes("pro")) return "pro";
  return "flash";
}

/** 正确口径：[cacheRead*hit + input*miss + output*out] / 1e6（input 已是 uncached）。 */
export function costCorrect(usage, model, epochMs) {
  const p = RATES_CNY[familyOf(model)][segmentOf(epochMs)];
  const i = usage.inputTokens ?? 0;
  const o = usage.outputTokens ?? 0;
  const c = usage.cacheReadTokens ?? 0;
  const cw = usage.cacheWriteTokens ?? 0;
  return (c * p.hit + (i + cw) * p.miss + o * p.out) / 1e6;
}

/** 反事实 A：约定 3 的公式（input 再减 cacheRead，output 再加 reasoning）。 */
export function costRuling3(usage, model, epochMs) {
  const p = RATES_CNY[familyOf(model)][segmentOf(epochMs)];
  const i = usage.inputTokens ?? 0;
  const c = usage.cacheReadTokens ?? 0;
  const o = usage.outputTokens ?? 0;
  const rs = usage.reasoningTokens ?? 0;
  const uncached = Math.max(0, i - c);
  return (c * p.hit + uncached * p.miss + (o + rs) * p.out) / 1e6;
}

/** 反事实 B：初始公式（input 不减 cache，但 output 加 reasoning）。 */
export function costT1Original(usage, model, epochMs) {
  const p = RATES_CNY[familyOf(model)][segmentOf(epochMs)];
  const i = usage.inputTokens ?? 0;
  const c = usage.cacheReadTokens ?? 0;
  const o = usage.outputTokens ?? 0;
  const rs = usage.reasoningTokens ?? 0;
  return (c * p.hit + i * p.miss + (o + rs) * p.out) / 1e6;
}

/** 断言峰价恰为空闲价 ×2。 */
export function peakIsDoubleOfOff() {
  const rows = [];
  for (const fam of Object.keys(RATES_CNY)) {
    for (const k of ["hit", "miss", "out"]) {
      const peak = RATES_CNY[fam].peak[k];
      const off = RATES_CNY[fam].off[k];
      rows.push({ family: fam, bucket: k, peak, off, ratio: peak / off, ok: peak === off * 2 });
    }
  }
  return rows;
}
