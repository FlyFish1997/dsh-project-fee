/**
 * 价格口径（pricing）
 * ---------------------------------------------------------------------------
 * 模型：**按生效时刻分段的「价格版本」**。
 *   pricing = {
 *     currency, effectiveFrom, peakMultiplier, fallbackFamily,
 *     reasoningIncludedInOutput,                                 // 见下「计费桶」
 *     peakWindows: [{days:[1..7], from:'HH:mm', to:'HH:mm'}],   // 1=周一 … 7=周日
 *     families: { <family>: {cacheRead, cacheMiss, output} },   // 内置基础费率（空闲价）
 *     models:   { <model>: <family> },                          // 模型 → 档位
 *     versions: [ {id, effectiveFrom(ms), note, models:{family:{segments:[…]}}} ]
 *   }
 *
 * 计费桶（**契约修订 v1.1**，依据见下）：
 *   cost = cacheReadTokens/1e6*hit + inputTokens/1e6*miss + outputBillable/1e6*out
 *   outputBillable = outputTokens（reasoningTokens 已包含在 outputTokens 内，**不再相加**）
 *
 * 依据（E2，读宿主源码）：
 *   - `@deepseek-ai/dsh-llm-deepseek/lib/index.js:1145-1165`：
 *     `inputTokens = prompt_tokens - cacheRead`（**互斥桶**，即缓存未命中部分）；
 *     `outputTokens = completion_tokens`；`reasoningTokens =
 *     completion_tokens_details.reasoning_tokens`。
 *   - `@earendil-works/pi-ai/dist/api/openai-completions.js:1194` 注释：
 *     “OpenAI completion_tokens already includes reasoning_tokens.”
 *   - `@deepseek-ai/dsh-token-meter/lib/types/turn-usage.js:29` 把
 *     `reasoningTokens > outputTokens` 判为**非法输入** → reasoning 是 output 的子集。
 *   E1 反证：真实语料里 `totalTokens == input + output + cacheRead` 成立，
 *   且 `reasoning > output` 出现 0 次。若把 reasoning 再加一遍，实测账单会明显虚增。
 *   把 `reasoningIncludedInOutput` 设为 `false` 可回到「output + reasoning」的旧口径
 *   （仅用于口径对照，默认不使用）。
 *
 * 计价时先按记录时刻选**最新一个 effectiveFrom ≤ 记录时刻**的版本，再在该版本
 * 里按顺序找**第一个**匹配 (星期, 时间区间) 的 segment（左闭右开，北京时间）；
 * 没有匹配或没有 segment 时回退到内置基础版本，并由 ledger 记入
 * diagnostics.unpricedUsageRecords（可见，不静默）。
 *
 * 内置基础版本由 `families` + `peakMultiplier` + `peakWindows` 生成，覆盖一整周，
 * 因此默认路径永远能匹配到 segment。高峰价 = 空闲价 × peakMultiplier。
 *
 * 价格来源日期：2026-09-10 12:00（`effectiveFrom` 仅作元数据；早于该时刻的记录
 * 仍按当前表计价，见 README.md 的口径限制）。
 */
import { beijingParts } from './time.js';

export { beijingParts };

/** 默认价格表来源日期（元数据）。 */
export const PRICE_TABLE_EFFECTIVE_FROM = '2026-09-10T12:00:00+08:00';

/** 内置「生效汇率表」：按币种 × 档位（元/tokens 每百万，**空闲**价）。 */
export const DEFAULT_RATES = Object.freeze({
  CNY: {
    flash: { cacheRead: 0.02, cacheMiss: 1.0, output: 4.0 },
    pro: { cacheRead: 0.15, cacheMiss: 4.5, output: 13.5 },
  },
  USD: {
    flash: { cacheRead: 0.003, cacheMiss: 0.15, output: 0.6 },
    pro: { cacheRead: 0.022, cacheMiss: 0.66, output: 1.98 },
  },
});

/** 默认货币。 */
export const DEFAULT_CURRENCY = 'CNY';

/** 内置基础费率（默认货币 = CNY，空闲时段）。 */
export const DEFAULT_PRICING = Object.freeze({
  currency: DEFAULT_CURRENCY,
  rates: DEFAULT_RATES,
  effectiveFrom: PRICE_TABLE_EFFECTIVE_FROM,
  peakMultiplier: 2,
  fallbackFamily: 'flash',
  // false = 日志里的 `inputTokens` 是**互斥桶**（已扣掉 cacheRead，宿主源码依据见文件头注释）。
  // true 仅用于口径对照（把 inputTokens 当含 cacheRead 的完整 prompt，未命中桶夹到 >= 0）。
  inputIncludesCacheRead: false,
  // false（默认）= reasoningTokens 已含在 outputTokens 内，不再相加；true = 旧口径对照。
  reasoningIncludedInOutput: true,
  peakWindows: [
    { days: [1, 2, 3, 4, 5], from: '09:00', to: '12:00' },
    { days: [1, 2, 3, 4, 5], from: '14:00', to: '18:00' },
  ],
  families: DEFAULT_RATES.CNY,
  models: {
    'deepseek-flash': 'flash',
    'deepseek-v4-flash': 'flash',
    'deepseek-v4-flash-vision-exp': 'flash',
    'deepseek-chat': 'flash',
    'deepseek-reasoner': 'flash',
    'deepseek-v4-pro': 'pro',
  },
  versions: [],
});

/** 内置基础版本的 id。 */
export const BUILTIN_VERSION_ID = 'builtin-2026-09-10';

/**
 * 时间戳精度归一：版本 `effectiveFrom` 与记录 `time` 的比较一律**先向下取整到分钟**。
 * 理由（约定 2）：分段的解析精度就是分钟，若比较仍按毫秒，同一分钟内保存的版本与
 * 产生的记录会出现归属歧义。
 */
export const MINUTE_MS = 60 * 1000;

/** @param {number} ms @returns {number} 向下取整到分钟 */
export function toMinute(ms) {
  return Math.floor(Number(ms) / MINUTE_MS) * MINUTE_MS;
}

const RATE_KEYS = ['hit', 'miss', 'out'];
const FAMILY_RATE_KEYS = ['cacheRead', 'cacheMiss', 'output'];

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function cloneFamilies(families) {
  const out = {};
  for (const [name, rate] of Object.entries(families ?? {})) out[name] = { ...rate };
  return out;
}

function cloneRates(rates) {
  const out = {};
  for (const [code, table] of Object.entries(rates ?? {})) out[code] = cloneFamilies(table);
  return out;
}

/**
 * 把 `YYYY-MM-DD HH:mm` / 可解析的日期时间字符串 / epoch ms 解析成 epoch ms。
 * 裸日期时间字符串按**北京时间**解释（与峰谷、按日口径一致）。
 * @param {number|string|undefined} value
 * @returns {number|null}
 */
export function parseInstant(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const trimmed = value.trim();
    const local = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(trimmed);
    if (local) {
      const [, y, mo, d, h, mi, s] = local;
      return Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s ?? '0')) - 8 * 3600 * 1000;
    }
    const direct = Date.parse(trimmed);
    if (!Number.isNaN(direct)) return direct;
  }
  return null;
}

/** `HH:mm` → 分钟数；`24:00` 视为 1440。 */
export function parseClock(value) {
  if (typeof value !== 'string') return null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (hh === 24 && mm === 0) return 1440;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return hh * 60 + mm;
}

/** epoch ms → ISO 星期（1=周一 … 7=周日），北京时间。 */
export function isoWeekday(epochMs) {
  const dow = beijingParts(epochMs).dow;
  return dow === 0 ? 7 : dow;
}

/** epoch ms → 北京时间的当日分钟数。 */
export function minutesOfDay(epochMs) {
  const p = beijingParts(epochMs);
  return p.hh * 60 + p.mm;
}

/**
 * 内置基础版本的 segments（**三段、24/7 全覆盖**，顺序即匹配优先级）。
 *
 * 约定 3：默认版本必须由构造保证「任何时刻的唯一归属」——
 * 两段工作日高峰 + 一条「全部七天 00:00-24:00」兜底；左闭右开 + 声明顺序
 * ⇒ 周末与 18:00–次日 09:00 全部落兜底，**结构上不可能有未定价记录**。
 * @param {object} pricing 已规范化
 * @returns {Record<string, {segments:object[]}>}
 */
export function builtinVersionModels(pricing) {
  const multiplier = pricing?.peakMultiplier ?? 2;
  const windows = Array.isArray(pricing?.peakWindows) && pricing.peakWindows.length > 0 ? pricing.peakWindows : DEFAULT_PRICING.peakWindows;
  const models = {};
  for (const [family, rate] of Object.entries(pricing?.families ?? DEFAULT_PRICING.families)) {
    const peakSegments = windows.map((window, index) => ({
      id: `${family}-peak-${index + 1}`,
      label: `高峰 ${window.from}-${window.to}`,
      days: [...window.days],
      from: window.from,
      to: window.to,
      hit: rate.cacheRead * multiplier,
      miss: rate.cacheMiss * multiplier,
      out: rate.output * multiplier,
    }));
    const fallback = {
      id: `${family}-offpeak-all`,
      label: '空闲兜底（全部七天 00:00-24:00，含周末全天）',
      days: [1, 2, 3, 4, 5, 6, 7],
      from: '00:00',
      to: '24:00',
      hit: rate.cacheRead,
      miss: rate.cacheMiss,
      out: rate.output,
    };
    models[family] = { segments: [...peakSegments, fallback] };
  }
  return models;
}

/** 内置基础版本（作为版本列表的第一项）。 */
export function builtinVersion(pricing) {
  const effectiveFromMs = parseInstant(pricing?.effectiveFrom) ?? Date.parse(PRICE_TABLE_EFFECTIVE_FROM);
  return {
    id: BUILTIN_VERSION_ID,
    effectiveFrom: effectiveFromMs,
    note: `内置官方价（${pricing?.effectiveFrom ?? PRICE_TABLE_EFFECTIVE_FROM} 起生效）`,
    builtin: true,
    models: builtinVersionModels(pricing),
  };
}

/** 规范化一个 segment；非法返回 null 并写入 problems。 */
function normalizeSegment(input, path, problems) {
  if (!isPlainObject(input)) {
    problems.push(`${path} 必须是对象`);
    return null;
  }
  const from = parseClock(input.from);
  const to = parseClock(input.to);
  if (from === null) problems.push(`${path}.from 必须是 HH:mm`);
  if (to === null) problems.push(`${path}.to 必须是 HH:mm`);
  // 约定 2：`days` 空数组或缺省 = **全部七天**；只在「给了天数但含非法项」时报错。
  const ALL_DAYS = [1, 2, 3, 4, 5, 6, 7];
  let days;
  if (input.days === undefined || input.days === null || (Array.isArray(input.days) && input.days.length === 0)) {
    days = ALL_DAYS;
  } else if (!Array.isArray(input.days)) {
    problems.push(`${path}.days 必须是 1..7 的数组（空数组/缺省 = 全部七天），1=周一`);
    days = null;
  } else {
    const valid = input.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7);
    if (valid.length !== input.days.length) {
      problems.push(`${path}.days 只能包含 1..7 的整数（1=周一）`);
      days = null;
    } else {
      days = [...new Set(valid)].sort((a, b) => a - b);
    }
  }
  for (const key of RATE_KEYS) {
    if (!isFiniteNonNegative(input[key])) problems.push(`${path}.${key} 必须是非负有限数字`);
  }
  if (from === null || to === null || days === null || RATE_KEYS.some((key) => !isFiniteNonNegative(input[key]))) return null;
  return {
    id: typeof input.id === 'string' && input.id !== '' ? input.id : `${path}`,
    label: typeof input.label === 'string' ? input.label : '',
    days,
    from: input.from,
    to: input.to,
    fromMinutes: from,
    toMinutes: to,
    hit: input.hit,
    miss: input.miss,
    out: input.out,
  };
}

/** 规范化一个用户追加的价格版本。 */
function normalizeVersion(input, index, problems) {
  const path = `pricing.versions[${index}]`;
  if (!isPlainObject(input)) {
    problems.push(`${path} 必须是对象`);
    return null;
  }
  const effectiveFrom = parseInstant(input.effectiveFrom);
  if (effectiveFrom === null) problems.push(`${path}.effectiveFrom 必须是 epoch ms 或可解析的时间字符串`);
  if (!isPlainObject(input.models)) problems.push(`${path}.models 必须是对象`);
  if (effectiveFrom === null || !isPlainObject(input.models)) return null;
  const models = {};
  for (const [family, entry] of Object.entries(input.models)) {
    if (!isPlainObject(entry) || !Array.isArray(entry.segments)) {
      problems.push(`${path}.models.${family}.segments 必须是数组`);
      continue;
    }
    if (entry.segments.length === 0) {
      problems.push(`${path}.models.${family}.segments 不能为空（要继承上一版本就省略该 family）`);
      continue;
    }
    const segments = [];
    entry.segments.forEach((segment, segIndex) => {
      const normalized = normalizeSegment(segment, `${path}.models.${family}.segments[${segIndex}]`, problems);
      if (normalized) segments.push(normalized);
    });
    if (segments.length > 0) models[family] = { segments };
  }
  if (Object.keys(models).length === 0) {
    problems.push(`${path}.models 至少要有一个 family 的 segments`);
    return null;
  }
  return {
    id: typeof input.id === 'string' && input.id !== '' ? input.id : `v${index + 1}-${effectiveFrom}`,
    // 约定 2：版本生效时刻统一归一化到**分钟**，与记录时刻的比较同精度。
    effectiveFrom: toMinute(effectiveFrom),
    note: typeof input.note === 'string' ? input.note : '',
    builtin: false,
    models,
  };
}

/**
 * 检查一份 `models` 是否 24/7 全覆盖（约定 3）。
 * @param {object} models `{family: {segments: [...]}}`
 * @returns {Array<{family:string, missingMinutes:number, totalMinutes:number}>}
 */
export function coverageHoles(models) {
  const holes = [];
  const totalMinutes = 7 * 24 * 60;
  for (const [family, entry] of Object.entries(models ?? {})) {
    const segments = Array.isArray(entry?.segments) ? entry.segments : [];
    let missing = 0;
    for (let weekday = 1; weekday <= 7; weekday += 1) {
      for (let minutes = 0; minutes < 24 * 60; minutes += 1) {
        if (!segments.some((segment) => segmentMatches(segment, weekday, minutes))) missing += 1;
      }
    }
    if (missing > 0) holes.push({ family, missingMinutes: missing, totalMinutes });
  }
  return holes;
}

/**
 * 把任意覆盖值合并进默认表并做形状校验。非法字段记入 `problems` 并忽略；
 * 由调用方（lib/routes.js）决定是否 400。
 * @param {object|undefined|null} override
 * @returns {{pricing: object, problems: string[]}}
 */
export function normalizePricing(override) {
  const problems = [];
  const out = {
    currency: DEFAULT_PRICING.currency,
    rates: cloneRates(DEFAULT_RATES),
    effectiveFrom: DEFAULT_PRICING.effectiveFrom,
    peakMultiplier: DEFAULT_PRICING.peakMultiplier,
    fallbackFamily: DEFAULT_PRICING.fallbackFamily,
    inputIncludesCacheRead: DEFAULT_PRICING.inputIncludesCacheRead,
    reasoningIncludedInOutput: DEFAULT_PRICING.reasoningIncludedInOutput,
    peakWindows: DEFAULT_PRICING.peakWindows.map((w) => ({ days: [...w.days], from: w.from, to: w.to })),
    families: {},
    models: {},
    versions: [],
  };
  Object.assign(out.models, DEFAULT_PRICING.models);

  if (override === undefined || override === null) {
    out.families = cloneFamilies(out.rates[out.currency]);
    return { pricing: out, problems };
  }
  if (!isPlainObject(override)) {
    problems.push('pricing 必须是对象');
    out.families = cloneFamilies(out.rates[out.currency]);
    return { pricing: out, problems };
  }

  if (override.currency !== undefined) {
    if (typeof override.currency !== 'string' || override.currency.trim() === '') problems.push('pricing.currency 必须是非空字符串');
    else out.currency = override.currency.trim().toUpperCase();
  }
  if (override.effectiveFrom !== undefined) {
    if (parseInstant(override.effectiveFrom) === null) problems.push('pricing.effectiveFrom 必须可解析为时刻');
    else out.effectiveFrom = override.effectiveFrom;
  }
  if (override.peakMultiplier !== undefined) {
    if (!isFiniteNonNegative(override.peakMultiplier) || override.peakMultiplier < 1) problems.push('pricing.peakMultiplier 必须是不小于 1 的有限数字');
    else out.peakMultiplier = override.peakMultiplier;
  }
  if (override.peakWindows !== undefined) {
    if (!Array.isArray(override.peakWindows)) problems.push('pricing.peakWindows 必须是数组');
    else {
      const windows = [];
      override.peakWindows.forEach((window, index) => {
        if (!isPlainObject(window)) {
          problems.push(`pricing.peakWindows[${index}] 必须是对象`);
          return;
        }
        const from = parseClock(window.from);
        const to = parseClock(window.to);
        const days = Array.isArray(window.days) ? window.days.filter((d) => Number.isInteger(d) && d >= 1 && d <= 7) : [];
        if (from === null || to === null || days.length === 0) {
          problems.push(`pricing.peakWindows[${index}] 需要 {days:[1..7], from:'HH:mm', to:'HH:mm'}`);
          return;
        }
        windows.push({ days: [...new Set(days)].sort((a, b) => a - b), from: window.from, to: window.to });
      });
      if (windows.length > 0) out.peakWindows = windows;
    }
  }
  if (override.families !== undefined) {
    if (!isPlainObject(override.families)) problems.push('pricing.families 必须是对象');
    else {
      for (const [family, rate] of Object.entries(override.families)) {
        if (!isPlainObject(rate)) {
          problems.push(`pricing.families.${family} 必须是对象`);
          continue;
        }
        const merged = { ...(out.rates[out.currency]?.[family] ?? {}) };
        for (const key of FAMILY_RATE_KEYS) {
          if (rate[key] === undefined) continue;
          if (!isFiniteNonNegative(rate[key])) {
            problems.push(`pricing.families.${family}.${key} 必须是非负有限数字`);
            continue;
          }
          merged[key] = rate[key];
        }
        if (FAMILY_RATE_KEYS.some((key) => !isFiniteNonNegative(merged[key]))) problems.push(`pricing.families.${family} 缺少 cacheRead/cacheMiss/output`);
        out.rates[out.currency] = { ...(out.rates[out.currency] ?? {}), [family]: merged };
      }
    }
  }
  if (override.rates !== undefined) {
    if (!isPlainObject(override.rates)) problems.push('pricing.rates 必须是对象');
    else {
      for (const [code, table] of Object.entries(override.rates)) {
        const currency = String(code).trim().toUpperCase();
        if (!isPlainObject(table)) {
          problems.push(`pricing.rates.${currency} 必须是对象`);
          continue;
        }
        for (const [family, rate] of Object.entries(table)) {
          if (!isPlainObject(rate)) {
            problems.push(`pricing.rates.${currency}.${family} 必须是对象`);
            continue;
          }
          const merged = { ...(out.rates[currency]?.[family] ?? {}) };
          for (const key of FAMILY_RATE_KEYS) {
            if (rate[key] === undefined) continue;
            if (!isFiniteNonNegative(rate[key])) {
              problems.push(`pricing.rates.${currency}.${family}.${key} 必须是非负有限数字`);
              continue;
            }
            merged[key] = rate[key];
          }
          if (FAMILY_RATE_KEYS.some((key) => !isFiniteNonNegative(merged[key]))) problems.push(`pricing.rates.${currency}.${family} 缺少 cacheRead/cacheMiss/output`);
          out.rates[currency] = { ...(out.rates[currency] ?? {}), [family]: merged };
        }
      }
    }
  }
  // 选定货币必须有一张表；缺表就退回默认货币并显式告警（不静默按错价计费）。
  if (!isPlainObject(out.rates[out.currency])) {
    problems.push(`pricing.rates 里没有 ${out.currency} 表，已退回 ${DEFAULT_CURRENCY}`);
    out.currency = DEFAULT_CURRENCY;
  }
  out.families = cloneFamilies(out.rates[out.currency]);
  if (override.models !== undefined) {
    if (!isPlainObject(override.models)) problems.push('pricing.models 必须是对象');
    else {
      for (const [model, target] of Object.entries(override.models)) {
        if (typeof target === 'string' && target.trim() !== '') out.models[model] = target;
        else problems.push(`pricing.models.${model} 必须是非空字符串（档位名）`);
      }
    }
  }
  if (override.fallbackFamily !== undefined) {
    if (typeof override.fallbackFamily !== 'string' || !isPlainObject(out.families[override.fallbackFamily])) {
      problems.push('pricing.fallbackFamily 必须指向一个已定义的 family');
    } else out.fallbackFamily = override.fallbackFamily;
  }
  if (override.reasoningIncludedInOutput !== undefined) {
    if (typeof override.reasoningIncludedInOutput !== 'boolean') problems.push('pricing.reasoningIncludedInOutput 必须是布尔值');
    else out.reasoningIncludedInOutput = override.reasoningIncludedInOutput;
  }
  if (override.inputIncludesCacheRead !== undefined) {
    if (typeof override.inputIncludesCacheRead !== 'boolean') problems.push('pricing.inputIncludesCacheRead 必须是布尔值');
    else out.inputIncludesCacheRead = override.inputIncludesCacheRead;
  }
  if (override.versions !== undefined) {
    if (!Array.isArray(override.versions)) problems.push('pricing.versions 必须是数组');
    else {
      override.versions.forEach((entry, index) => {
        const normalized = normalizeVersion(entry, index, problems);
        if (normalized) out.versions.push(normalized);
      });
      out.versions.sort((a, b) => a.effectiveFrom - b.effectiveFrom);
    }
  }

  return { pricing: out, problems };
}

/** 内部 models（含 fromMinutes/toMinutes）→ 客户端形态（面板会逐字段回填）。 */
function clientModels(models) {
  const out = {};
  for (const [family, entry] of Object.entries(models ?? {})) {
    out[family] = {
      segments: (entry.segments ?? []).map((segment) => ({
        id: segment.id,
        label: segment.label ?? '',
        days: [...(segment.days ?? [])],
        from: segment.from,
        to: segment.to,
        hit: segment.hit,
        miss: segment.miss,
        out: segment.out,
      })),
    };
  }
  return out;
}

/** 全部版本（内置在前，用户版本按 effectiveFrom 升序）。 */
export function allVersions(pricing) {
  const normalized = pricing?.families ? pricing : normalizePricing(pricing).pricing;
  const builtin = builtinVersion(normalized);
  return [builtin, ...normalized.versions.map((version) => ({ ...version, builtin: false }))];
}

/**
 * 追加一个价格版本（**只追加，不修改、不删除历史版本**）。
 *
 * 约定 5：追加的版本**必须自带完整 `models`** —— 不允许「只写 delta 然后继承上一版本」，
 * 继承会让价格不可解释。缺 `models` / 空 `models` → 记入 `problems`（路由层转 400）。
 * @param {object} pricing 已规范化（或可规范化）
 * @param {{effectiveFrom:number|string, note?:string, models?:object, id?:string}} append
 * @returns {{pricing:object, problems:string[], warnings:string[], version:object|null, coverageHoles:Array}}
 */
export function appendVersion(pricing, append) {
  const normalized = normalizePricing(pricing).pricing;
  const problems = [];
  const warnings = [];
  const effectiveFrom = parseInstant(append?.effectiveFrom);
  if (effectiveFrom === null) problems.push('pricing.append.effectiveFrom 必须可解析为时刻');
  const hasModels = isPlainObject(append?.models) && Object.keys(append.models).length > 0;
  if (!hasModels) {
    problems.push('pricing.append.models 必须完整给出（不允许继承上一版本：继承会让价格不可解释）');
  }
  if (problems.length > 0) return { pricing: normalized, problems, warnings, version: null, coverageHoles: [] };
  const candidate = {
    id: typeof append?.id === 'string' && append.id !== '' ? append.id : `v${normalized.versions.length + 1}-${toMinute(effectiveFrom)}`,
    effectiveFrom,
    note: typeof append?.note === 'string' ? append.note : '',
    models: append.models,
  };
  const base = toPlainPricing(normalized);
  const next = normalizePricing({ ...base, versions: [...base.versions, candidate] });
  if (next.problems.length > 0) return { pricing: normalized, problems: next.problems, warnings, version: null, coverageHoles: [] };
  const added = next.pricing.versions.find((version) => version.id === candidate.id) ?? null;
  // 约定 5：未覆盖 24/7 → **接受但警告**（路由层在 strict:true 时改判 400）
  const holes = coverageHoles(added?.models ?? {});
  for (const hole of holes) {
    warnings.push(`版本 ${added?.id ?? candidate.id} 的档位 ${hole.family} 存在未覆盖时段（${hole.missingMinutes}/${hole.totalMinutes} 分钟），这些时段的新用量将不计价并计入 gaps`);
  }
  return { pricing: next.pricing, problems, warnings, version: added, coverageHoles: holes };
}

/** 把规范化后的 pricing 还原成「可再喂给 normalizePricing」的纯覆盖对象。 */
export function toPlainPricing(pricing) {
  const normalized = pricing?.families ? pricing : normalizePricing(pricing).pricing;
  return {
    currency: normalized.currency,
    rates: cloneRates(normalized.rates),
    effectiveFrom: normalized.effectiveFrom,
    peakMultiplier: normalized.peakMultiplier,
    fallbackFamily: normalized.fallbackFamily,
    reasoningIncludedInOutput: normalized.reasoningIncludedInOutput,
    inputIncludesCacheRead: normalized.inputIncludesCacheRead,
    peakWindows: normalized.peakWindows,
    families: normalized.families,
    models: normalized.models,
    versions: normalized.versions.map((version) => ({
      id: version.id,
      effectiveFrom: version.effectiveFrom,
      note: version.note,
      models: clientModels(version.models),
    })),
  };
}

/** 供 `/config` GET 使用的版本列表（面板从**最后一个**元素取模板）。 */
export function versionsForClient(pricing) {
  return allVersions(pricing).map((version) => ({
    id: version.id,
    effectiveFrom: version.effectiveFrom,
    note: version.note,
    builtin: version.builtin === true,
    models: clientModels(version.models),
  }));
}

/** 某时刻生效的版本 id（供 /config 展示）。 */
export function activeVersionId(pricing, atMs = Date.now()) {
  const versions = allVersions(pricing);
  let active = versions[0];
  for (const version of versions) {
    if (version.effectiveFrom <= atMs) active = version;
  }
  return active.id;
}

/** 模型 → 档位（family）。未知模型回退 `fallbackFamily`。 */
export function familyOf(model, pricing) {
  const normalized = pricing?.families ? pricing : normalizePricing(pricing).pricing;
  const key = typeof model === 'string' ? model : '';
  const mapped = normalized.models?.[key];
  if (typeof mapped === 'string' && isPlainObject(normalized.families?.[mapped])) return { family: mapped, known: true };
  const fallback = isPlainObject(normalized.families?.[normalized.fallbackFamily]) ? normalized.fallbackFamily : 'flash';
  return { family: fallback, known: false };
}

/** 兼容旧名（报告/测试用）。 */
export function tierOf(model, pricing) {
  const { family, known } = familyOf(model, pricing);
  const normalized = pricing?.families ? pricing : normalizePricing(pricing).pricing;
  return { tierName: family, tier: normalized.families[family], known };
}

/** segment 是否命中给定的（ISO 星期, 当日分钟）。`days` 空/缺省视为全部七天。 */
export function segmentMatches(segment, weekday, minutes) {
  const days = Array.isArray(segment.days) && segment.days.length > 0 ? segment.days : [1, 2, 3, 4, 5, 6, 7];
  if (!days.includes(weekday)) return false;
  const from = segment.fromMinutes ?? parseClock(segment.from);
  let to = segment.toMinutes ?? parseClock(segment.to);
  if (from === null || to === null) return false;
  if (to === 0) to = 1440;
  if (to > from) return minutes >= from && minutes < to;
  // to <= from：跨夜区间（左闭右开）。from === to 时按「全天」处理（[from,24:00) ∪ [00:00,to) 恰好覆盖全天）。
  return minutes >= from || minutes < to;
}

/**
 * 解析某时刻 / 某模型的计价档。
 *
 * 选择规则（约定 2）：
 *   1. 版本：取**最新一个 `toMinute(effectiveFrom) <= toMinute(记录时刻)`** 的版本；
 *      若记录早于所有版本，则用内置版本作为**下界**（早于价格表生效时刻的记录仍按当前表计价，
 *      条数与金额记入 `diagnostics.beforeEffectiveFromCount/Cost`）。
 *   2. 分段：在该版本 `models[<family>].segments` 里按**声明顺序**取**第一个**命中
 *      (星期, 时间区间) 的 segment；多段命中按声明顺序解决，不报错、不报歧义。
 *   3. **禁止跨版本回退**：分段都没命中 ⇒ 该记录**未计价**（`unpriced: true`，
 *      计入 `diagnostics.unpricedUsageRecords` 并列入 `gaps`），**不得**用更早版本的价格顶上。
 * @param {number} epochMs
 * @param {string|undefined} model
 * @param {object} pricing
 * @returns {{priced:boolean, hit:number, miss:number, out:number, versionId:string, segmentId:string|null, source:'version'|'unpriced', family:string, known:boolean}}
 */
function activeVersionAt(normalized, epochMs) {
  const versions = allVersions(normalized);
  const at = toMinute(epochMs);
  let active = versions[0];
  for (const version of versions) {
    if (toMinute(version.effectiveFrom) <= at) active = version;
  }
  return active;
}

export function resolvePrice(epochMs, model, pricing) {
  const normalized = pricing?.families ? pricing : normalizePricing(pricing).pricing;
  const { family, known } = familyOf(model, normalized);
  const active = activeVersionAt(normalized, epochMs);
  const weekday = isoWeekday(epochMs);
  const minutes = minutesOfDay(epochMs);
  const segments = active?.models?.[family]?.segments;
  if (Array.isArray(segments)) {
    for (const segment of segments) {
      if (segmentMatches(segment, weekday, minutes)) {
        return { priced: true, hit: segment.hit, miss: segment.miss, out: segment.out, versionId: active.id, segmentId: segment.id, source: 'version', family, known };
      }
    }
  }
  // 未计价：显式返回，由 ledger 计数并列入 gaps（不静默回退到更早版本）
  return { priced: false, hit: 0, miss: 0, out: 0, versionId: active?.id ?? versions[0].id, segmentId: null, source: 'unpriced', family, known };
}

/**
 * 峰谷判定：**取自当前生效版本的段表**，而不是全局 `peakWindows`。
 *
 * 为什么：`peakWindows` + `peakMultiplier` 只用于**生成内置默认段表**，不参与运行时判断。
 * 若这里仍读 peakWindows，用户把自定义版本的高峰挪到别的时段后，计费会跟着段表走、
 * 而峰谷归属不会 —— 报告里的 peakSplit 就会把空闲时段记成高峰，与计费矛盾。
 *
 * 语义：只要**当前生效版本中任一档位**在该时刻命中一个「单价高于该档空闲基准」的段，
 * 即判为高峰。默认版本各档高峰时段一致，因此与旧行为等价；
 * 自定义版本改时段后，归属会跟着变。
 *
 * 注意：`isPeak` 不接收 model，所以这里跨档位取「任一命中即高峰」。
 * `priceUsage` 是按具体档位判定的（更精确），两者在默认版本下一致。
 *
 * @param {number} epochMs
 * @param {object} pricing
 * @returns {boolean}
 */
export function isPeak(epochMs, pricing) {
  const normalized = pricing?.families ? pricing : normalizePricing(pricing).pricing;
  const active = activeVersionAt(normalized, epochMs);
  const models = active?.models;
  if (!models || typeof models !== 'object') return false;
  const weekday = isoWeekday(epochMs);
  const minutes = minutesOfDay(epochMs);
  for (const [family, spec] of Object.entries(models)) {
    const segments = spec?.segments;
    if (!Array.isArray(segments)) continue;
    const base = normalized.families?.[family] ?? normalized.rates?.[normalized.currency]?.[family] ?? null;
    for (const segment of segments) {
      if (!segmentMatches(segment, weekday, minutes)) continue;
      if (base === null) continue;
      if (
        (segment.hit ?? 0) > (base.cacheRead ?? 0) ||
        (segment.miss ?? 0) > (base.cacheMiss ?? 0) ||
        (segment.out ?? 0) > (base.output ?? 0)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 计算一条用量记录的费用。
 *
 *   outputBillable = outputTokens                        （默认：reasoning 已在 output 内）
 *                  = outputTokens + reasoningTokens      （reasoningIncludedInOutput=false）
 *   cost = cacheReadTokens/1e6*hit + inputTokens/1e6*miss + outputBillable/1e6*out
 *
 * @param {object} usage
 * @param {string|undefined} model
 * @param {number} epochMs
 * @param {object} pricing
 * @returns {{cost:number, idleCost:number, peakSurcharge:number, peak:boolean, tierName:string, family:string, known:boolean, priceFactor:number, versionId:string, segmentId:string|null, source:string, outputBillableTokens:number, reasoningCountedSeparately:boolean}}
 */
export function priceUsage(usage, model, epochMs, pricing) {
  const normalized = pricing?.families ? pricing : normalizePricing(pricing).pricing;
  const u = usage ?? {};
  const resolved = resolvePrice(epochMs, model, normalized);
  const separateReasoning = normalized.reasoningIncludedInOutput === false;
  const outputBillableTokens = (u.outputTokens ?? 0) + (separateReasoning ? (u.reasoningTokens ?? 0) : 0);
  // 未命中桶：默认 inputTokens 本身就是互斥桶（宿主 `inputTokens = prompt_tokens - cacheRead`）。
  // 对照口径 inputIncludesCacheRead=true 时按「input 含 cacheRead」处理并夹到 >= 0。
  const missTokens = normalized.inputIncludesCacheRead === true
    ? Math.max(0, (u.inputTokens ?? 0) - (u.cacheReadTokens ?? 0))
    : (u.inputTokens ?? 0);
  const cost =
    ((u.cacheReadTokens ?? 0) / 1e6) * resolved.hit +
    (missTokens / 1e6) * resolved.miss +
    (outputBillableTokens / 1e6) * resolved.out;
  // 未计价记录的单价全为 0（金额为 0），由 ledger 计入 unpricedUsageRecords 与 gaps。
  const idleRate = resolved.priced === true
    ? normalized.families[resolved.family] ?? normalized.rates?.[normalized.currency]?.flash ?? DEFAULT_PRICING.families.flash
    : { cacheRead: 0, cacheMiss: 0, output: 0 };
  const idleCost =
    ((u.cacheReadTokens ?? 0) / 1e6) * idleRate.cacheRead +
    (missTokens / 1e6) * idleRate.cacheMiss +
    (outputBillableTokens / 1e6) * idleRate.output;
  // 峰谷归属**取自实际命中的 segment**（而不是再走一遍全局 `peakWindows`）。
  //
  // 为什么必须这样：`peakWindows` + `peakMultiplier` 只用来**生成内置默认段表**，
  // 不参与运行时判断。若这里仍读 peakWindows，用户把自定义版本的高峰挪到别的时段后，
  // 计费会跟着段表走、而峰谷归属不会 —— 于是 peakSplit 把空闲时段记成高峰，
  // 报告的拆分数字就与计费不一致（契约项「改时段定义后归属随之变化」不满足）。
  //
  // 判定方式：把命中段的单价与**该档位的空闲基准价**比较；段价更高即高峰段。
  // 段 schema 没有显式的「是否高峰」字段，这样判定不需要改配置格式。
  const baseRate = resolved.priced === true
    ? normalized.families?.[resolved.family] ?? normalized.rates?.[normalized.currency]?.flash ?? null
    : null;
  const peak = baseRate !== null && (
    resolved.hit > (baseRate.cacheRead ?? 0) ||
    resolved.miss > (baseRate.cacheMiss ?? 0) ||
    resolved.out > (baseRate.output ?? 0)
  );
  return {
    cost,
    idleCost,
    peakSurcharge: cost - idleCost,
    peak,
    tierName: resolved.family,
    family: resolved.family,
    known: resolved.known,
    priceFactor: resolved.priced === true && baseRate !== null && (baseRate.cacheMiss ?? 0) > 0
      ? resolved.miss / baseRate.cacheMiss
      : 1,
    versionId: resolved.versionId,
    segmentId: resolved.segmentId,
    source: resolved.source,
    unpriced: resolved.priced !== true,
    outputBillableTokens,
    missTokens,
    reasoningCountedSeparately: separateReasoning,
    rates: { hit: resolved.hit, miss: resolved.miss, out: resolved.out },
  };
}

/** 供报告/`/config` 展示的**全部币种**费率表（原始内置值 + 覆盖后的值）。 */
export function ratesTable(pricing) {
  const normalized = pricing?.rates ? pricing : normalizePricing(pricing).pricing;
  const out = {};
  for (const [code, table] of Object.entries(normalized.rates ?? {})) out[code] = cloneFamilies(table);
  return out;
}

/**
 * 供报告 / `/config` 展示的扁平价格表（**当前货币**；空闲列 = 基准价，高峰列 = **实际计费段**）。
 *
 * 为什么要从段表取高峰列，而不是 `基准价 × peakMultiplier`：
 *   `peakMultiplier` / `peakWindows` 只用于**生成内置默认段表**，不参与运行时计费。
 *   若这里再用倍率推导一遍，当用户的自定义版本把高峰段设成非 2 倍（或挪到别的时段）时，
 *   这张表会显示一个**与实际收费不一致**的单价 —— 用户与验证者据此核对单价必然得出错误结论。
 *
 * 取法：每个档位取「单价高于该档空闲基准」的**第一个** segment 作为高峰列
 * （按声明顺序，与 `resolvePrice` 的命中顺序语义一致）；没有这样的段则高峰列等于空闲列。
 *
 * @param {object} pricing
 * @returns {Array<{tier:string, cacheRead:number, cacheMiss:number, output:number, peakCacheRead:number, peakCacheMiss:number, peakOutput:number, peakSegmentId:string|null, source:string}>}
 */
export function pricingTableRows(pricing) {
  const normalized = pricing?.families ? pricing : normalizePricing(pricing).pricing;
  const active = activeVersionAt(normalized, Date.now());
  return Object.entries(normalized.families ?? {}).map(([name, rate]) => {
    const segments = active?.models?.[name]?.segments;
    let peakSeg = null;
    if (Array.isArray(segments)) {
      for (const segment of segments) {
        if (
          (segment.hit ?? 0) > (rate.cacheRead ?? 0) ||
          (segment.miss ?? 0) > (rate.cacheMiss ?? 0) ||
          (segment.out ?? 0) > (rate.output ?? 0)
        ) {
          peakSeg = segment;
          break;
        }
      }
    }
    return {
      tier: name,
      // 空闲列 = 该档基准价（未覆盖时的内置空闲价）
      cacheRead: rate.cacheRead,
      cacheMiss: rate.cacheMiss,
      output: rate.output,
      // 高峰列 = 实际计费段内绝对值；无高峰段时与空闲列相同
      peakCacheRead: peakSeg ? peakSeg.hit : rate.cacheRead,
      peakCacheMiss: peakSeg ? peakSeg.miss : rate.cacheMiss,
      peakOutput: peakSeg ? peakSeg.out : rate.output,
      peakSegmentId: peakSeg ? peakSeg.id : null,
      source: peakSeg ? 'segment' : 'base',
    };
  });
}
