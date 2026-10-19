/**
 * 北京时间（UTC+8）时间口径
 * ---------------------------------------------------------------------------
 * 会话日志里的 `time` / `createdAt` 都是 epoch ms（UTC）。峰谷判定与「按日」
 * 分桶一律按北京时间 UTC+8，与宿主时区无关，因此这里不使用本地 Date 方法。
 */

/** 北京时间相对 UTC 的固定偏移（毫秒）。 */
export const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

/**
 * 把 epoch ms 拆成北京时间的日历部件。
 * @param {number} epochMs
 * @returns {{y:number,m:number,d:number,hh:number,mm:number,ss:number,dow:number}}
 */
export function beijingParts(epochMs) {
  const shifted = new Date(epochMs + BEIJING_OFFSET_MS);
  return {
    y: shifted.getUTCFullYear(),
    m: shifted.getUTCMonth() + 1,
    d: shifted.getUTCDate(),
    hh: shifted.getUTCHours(),
    mm: shifted.getUTCMinutes(),
    ss: shifted.getUTCSeconds(),
    dow: shifted.getUTCDay(),
  };
}

const pad2 = (n) => String(n).padStart(2, '0');

/** 北京时间的 `YYYY-MM-DD`。 */
export function beijingDateKey(epochMs) {
  const p = beijingParts(epochMs);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

/** 北京时间 `YYYY-MM-DD HH:mm:ss`。 */
export function beijingDateTime(epochMs) {
  const p = beijingParts(epochMs);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)} ${pad2(p.hh)}:${pad2(p.mm)}:${pad2(p.ss)}`;
}

/**
 * 把 `YYYY-MM-DD`（北京时间日）加上 n 天。
 * @param {string} dateKey
 * @param {number} deltaDays
 * @returns {string}
 */
export function addDays(dateKey, deltaDays) {
  const [y, m, d] = dateKey.split('-').map((x) => Number.parseInt(x, 10));
  const base = Date.UTC(y, m - 1, d) + deltaDays * 24 * 60 * 60 * 1000;
  const shifted = new Date(base);
  return `${shifted.getUTCFullYear()}-${pad2(shifted.getUTCMonth() + 1)}-${pad2(shifted.getUTCDate())}`;
}
