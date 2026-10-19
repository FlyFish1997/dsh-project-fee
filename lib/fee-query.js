/**
 * 会话级费用查询 —— 让**工作区里的会话**知道自己花了多少。
 *
 * 这一层是**纯逻辑**：输入「一个 sessionId + 一份 summary」，输出结构化结果与一句人话。
 * 不 import 任何 `@deepseek-ai/*`，也不碰 webServer / tools / commands ——
 * 那些注册面在 `lib/host-tools.js` 里，好让本文件可以被直接单测。
 *
 * @module dsh-workspace-fee/fee-query
 */
import { encodeWorkspaceKey } from './session-log.js';

export { encodeWorkspaceKey };

/** 金额格式化：小额多给两位有效数字，避免 ¥0.00 这种看不出差别的显示。 */
function fmtYuan(n) {
  if (!Number.isFinite(n)) return '¥-';
  if (n === 0) return '¥0';
  if (n >= 1) return `¥${n.toFixed(2)}`;
  if (n >= 0.01) return `¥${n.toFixed(4)}`;
  return `¥${n.toPrecision(3)}`;
}

function fmtTokens(n) {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/**
 * 在 summary 里定位「当前会话所属的工作区」。
 *
 * 顺序：① 用 sessionId 反查 `summary.current`（宿主已按 sessionId 解析）；
 * ② 用 cwd 编码出 workspaceId 精确匹配；③ 用 label 匹配 cwd 末段。
 * 都找不到就返回 null —— **不猜**，让调用方给出「无法定位」而不是一个错的数字。
 *
 * @param {object} summary ledger.summary() 的结果
 * @param {{sessionId?: string, cwd?: string}} who
 * @returns {object|null}
 */
export function findWorkspace(summary, who = {}) {
  const rows = Array.isArray(summary?.workspaces) ? summary.workspaces : [];
  const { sessionId, cwd } = who;
  // ① sessionId 反查
  if (typeof sessionId === 'string' && sessionId !== '') {
    const cur = summary?.current;
    if (cur && (cur.workspaceId || cur.key)) {
      const id = cur.workspaceId ?? cur.key;
      const row = rows.find((w) => (w.workspaceId ?? w.key) === id);
      if (row) return row;
      // current 有但 workspaces 里没有（窗口内无用量）→ 用 current 自身
      return { ...cur, sessions: cur.sessions ?? 0, cost: cur.cost ?? 0, tokens: cur.tokens ?? null, _fromCurrent: true };
    }
  }
  // ② cwd 精确编码匹配
  const key = encodeWorkspaceKey(cwd);
  if (key !== null) {
    const row = rows.find((w) => (w.workspaceId ?? w.key) === key);
    if (row) return row;
  }
  // ③ label 匹配 cwd 末段
  if (typeof cwd === 'string' && cwd.trim() !== '') {
    const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
    if (base) {
      const row = rows.find((w) => w.label === base);
      if (row) return row;
    }
  }
  return null;
}

/** 从 alert（双线形状）里抽出可读的线信息，兼容旧的单值形状。 */
function readAlertLines(alert) {
  if (!alert || typeof alert !== 'object') {
    return { level: 'ok', day: null, total: null };
  }
  // 新形态
  if (alert.day || alert.total) {
    return {
      level: alert.level ?? 'ok',
      day: alert.day ? { limit: alert.day.limit ?? null, level: alert.day.level ?? 'ok', ratio: alert.day.ratio ?? null } : null,
      total: alert.total ? { limit: alert.total.limit ?? null, level: alert.total.level ?? 'ok', ratio: alert.total.ratio ?? null } : null,
    };
  }
  // 旧形态 {limit, level}
  return {
    level: alert.level ?? 'ok',
    day: { limit: alert.limit ?? null, level: alert.level ?? 'ok', ratio: null },
    total: null,
  };
}

const LEVEL_ZH = { ok: '正常', warn: '接近预警线', over: '已超预警线' };

/** `days` 的**全量口径**字面量（与 docs/SPEC.md §1、lib/ledger.js 的 ALL_TIME_DAYS 一致）。 */
const ALL_TIME_DAYS = 'all';

/**
 * 把一个工作区的账目整理成会话可读的结果。
 *
 * 计费口径提示写进结果里，是因为 **模型看到这个数字后可能会转述给用户** ——
 * 不提口径的话，用户很容易以为它就是账单实付额。
 *
 * @param {{workspace: object, days?: number, generatedAt?: string}} input
 */
export function describeWorkspaceFee(input) {
  const { workspace, days = 7 } = input ?? {};
  if (!workspace) {
    return {
      ok: false,
      reason: 'workspace-not-resolved',
      message: '无法从当前会话定位工作区：宿主未返回 current，且 cwd 未能匹配到任何工作区。请显式提供工作区路径。',
    };
  }
  const tokens = workspace.tokens ?? {};
  const alert = readAlertLines(workspace.alert);
  const todayCost = Number(workspace.todayCost ?? 0);
  const totalCost = Number(workspace.lifetimeCost ?? workspace.cost ?? 0);
  const windowCost = Number(workspace.cost ?? 0);
  // `days` 可能是整数（滚动 N 天）或全量口径字面量 'all'（例如 summary 来自 /summary?days=all）。
  const scopeText = days === ALL_TIME_DAYS ? '全量' : `近 ${days} 天`;
  const lineText = (label, line) => {
    if (!line || line.limit === null || line.limit === undefined) return `${label}未设置`;
    const pct = Number.isFinite(line.ratio) ? `（已用 ${(line.ratio * 100).toFixed(1)}%）` : '';
    return `${label}${fmtYuan(line.limit)}，当前 ${LEVEL_ZH[line.level] ?? line.level}${pct}`;
  };
  return {
    ok: true,
    workspace: {
      id: workspace.workspaceId ?? workspace.key ?? null,
      label: workspace.label ?? null,
      cwd: workspace.cwd ?? null,
    },
    todayCost,
    totalCost,
    windowCost,
    /** 统计口径：整数 = 滚动 N 天；字符串 `'all'` = 全量口径。 */
    windowDays: days,
    tokens: {
      cachedInput: tokens.cacheReadTokens ?? 0,
      uncachedInput: tokens.inputTokens ?? 0,
      output: tokens.outputTokens ?? 0,
      reasoning: tokens.reasoningTokens ?? 0,
      total: tokens.totalTokens ?? 0,
    },
    alert: {
      level: alert.level,
      day: alert.day,
      total: alert.total,
      dayText: lineText('日预警线 ', alert.day),
      totalText: lineText('总预警线 ', alert.total),
    },
    basis: {
      currency: 'CNY',
      pricingVersionId: workspace.pricingVersionId ?? null,
      note: '按 DeepSeek 官方刊例价估算（峰谷分时、思考已含在输出内），不是账单实付金额；含缓存命中/未命中分档。',
    },
    message: [
      `工作区「${workspace.label ?? workspace.key ?? '未知'}」`,
      `今日花费 ${fmtYuan(todayCost)}；累计花费 ${fmtYuan(totalCost)}（${scopeText}窗口内 ${fmtYuan(windowCost)}）。`,
      `预警：${lineText('日线 ', alert.day)}；${lineText('总线 ', alert.total)}。`,
      `Token（窗口内）：缓存命中 ${fmtTokens(tokens.cacheReadTokens)} / 未命中 ${fmtTokens(tokens.inputTokens)} / 输出 ${fmtTokens(tokens.outputTokens)}（其中思考 ${fmtTokens(tokens.reasoningTokens)}）。`,
      '口径：按官方刊例价估算，非账单实付额。',
    ].join(''),
  };
}

/**
 * 一步到位：从 summary + 会话身份得到结果。
 *
 * 兜底：若在 summary 里匹配不到（常见于**本工作区在窗口内还没有用量记录**），
 * 但 cwd 明确，就合成一个零花费条目 —— 用户看到「¥0，暂无用量记录」比看到
 * 「无法定位工作区」有用得多。只有**连 cwd 都没有**时才报定位失败。
 *
 * @param {object} summary
 * @param {{sessionId?: string, cwd?: string, days?: number}} who
 */
export function queryWorkspaceFee(summary, who = {}) {
  const days = who.days ?? summary?.days ?? 7;
  const found = findWorkspace(summary, who);
  if (found) return describeWorkspaceFee({ workspace: found, days, generatedAt: summary?.generatedAt });
  const cwd = typeof who.cwd === 'string' && who.cwd !== '' ? who.cwd : null;
  if (cwd !== null) {
    const key = encodeWorkspaceKey(cwd);
    const label = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).pop() || key;
    const out = describeWorkspaceFee({
      workspace: {
        workspaceId: key,
        label,
        cwd,
        sessions: 0,
        cost: 0,
        todayCost: 0,
        lifetimeCost: 0,
        tokens: {},
        alert: { day: { limit: null, level: 'ok', ratio: null }, total: { limit: null, level: 'ok', ratio: null }, level: 'ok', limit: null },
      },
      days,
      generatedAt: summary?.generatedAt,
    });
    out.note = '本工作区在统计窗口内没有用量记录，因此各项花费为 0（不是定位失败）。';
    return out;
  }
  return describeWorkspaceFee({ workspace: null, days });
}
