// 独立验证：预警线双向 + 等值边界
//   1) 设为「低于今日花费」→ level='over'
//   2) 调高到「高于今日花费」→ 回到 'ok'
//   3) 恰好等于今日花费 → 行为必须明确定义（实现用 >=，故期望 'over'）
//   4) warn 带（默认 warnRatio=0.8）行为
// 全程走真实路由处理器（mock req/res）；这是替代路径，证明不了浏览器策略。
import { existsSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { ROOT } from "./harness/runner.mjs";
import { freezeHome, putSyntheticSession } from "./harness/frozen-home.mjs";
import { callRoute } from "./harness/http.mjs";
import { buildSessionLog } from "./harness/fixtures.mjs";

const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== 预警线双向验证 ===");
if (!existsSync(join(ROOT, "lib/routes.js"))) {
  console.log("lib/routes.js 不存在 → 无法验证（不得判 pass）");
  process.exit(2);
}
const { createRouteTable } = await import(new URL("../../lib/routes.js", import.meta.url).href);
const { createLedger } = await import(new URL("../../lib/ledger.js", import.meta.url).href);

const frozen = freezeHome("alert", { clean: true });
const wsDir = "--D-work-alert-probe--";
const now = Date.now();
// 一条今天的用量记录：input=1,000,000（空闲 miss 1.0 元/百万）→ 今日花费 ≈ ¥1
const usage = { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cacheReadTokens: 0, reasoningTokens: 0 };
putSyntheticSession(
  frozen.home,
  wsDir,
  "session-00000000-0000-4000-8000-00000000bb01",
  zstdCompressSync(buildSessionLog({ cwd: "D:\\work\\alert-probe", usage, time: now })),
);
const ledger = createLedger({ home: frozen.home, persistCache: false });
const table = createRouteTable({ ledger, logger: () => {} });

async function summary() {
  const r = await callRoute(table, "GET", "/api/dsh-workspace-fee/summary?days=30");
  const w = (r.json?.workspaces ?? []).find((x) => x.workspaceId === wsDir || x.key === wsDir);
  return { status: r.status, w, json: r.json };
}
async function setLimit(limit) {
  return callRoute(table, "POST", "/api/dsh-workspace-fee/config", { alerts: { [wsDir]: { limit } } });
}

const s0 = await summary();
const todayCost = s0.w?.todayCost;
console.log(`今日花费（工作区 ${wsDir}）：¥${todayCost}`);
check("合成工作区的今日花费 > 0（用例非退化）", typeof todayCost === "number" && todayCost > 0, `todayCost=${todayCost}`);
if (!(todayCost > 0)) {
  console.log("合成记录未被计入今日，无法继续断言");
  process.exit(1);
}

async function levelAfter(limit, label) {
  const set = await setLimit(limit);
  const s = await summary();
  const lvl = s.w?.alert?.level;
  const gotLimit = s.w?.alert?.limit;
  console.log(`  ${label.padEnd(34)} limit=${String(limit).padEnd(12)} POST=${set.status} → level='${lvl}' (回读 limit=${gotLimit})`);
  return lvl;
}

console.log("\n-- 1) 低于今日花费 → over --");
{
  const lvl = await levelAfter(todayCost * 0.5, "limit = 今日花费 × 0.5");
  check("低于今日花费 → level='over'", lvl === "over", `got='${lvl}'`);
}
console.log("-- 2) 高于今日花费 → ok --");
{
  const lvl = await levelAfter(todayCost * 2, "limit = 今日花费 × 2");
  check("高于今日花费 → level='ok'", lvl === "ok", `got='${lvl}'`);
}
console.log("-- 3) 恰好等于今日花费 → 边界必须有明确定义（实现用 >=，期望 over）--");
{
  const lvl = await levelAfter(todayCost, "limit = 今日花费（精确相等）");
  check("恰好等于预警线 → level='over'（>= 语义，边界已定义）", lvl === "over", `got='${lvl}'`);
}
console.log("-- 4) warn 带（默认 warnRatio=0.8）--");
{
  const lvl = await levelAfter(todayCost * 1.1, "limit = 今日花费 × 1.1（0.909 ≥ 0.8）");
  check("落在 warn 带 → level='warn'", lvl === "warn", `got='${lvl}'`);
}
console.log("-- 5) 清空预警线 → 回到 ok --");
{
  const lvl = await levelAfter(null, "limit = null（清除）");
  check("清除预警线 → level='ok'", lvl === "ok", `got='${lvl}'`);
}
console.log("-- 6) limit=0 的语义（0 被视为「未设」，即永不告警）--");
{
  const lvl = await levelAfter(0, "limit = 0");
  console.log("    → 语义：0 被当作「未设置」（limitOf 返回 0，alertLevel 要求 limit>0 才判定）→ 永不告警。");
  console.log("      这是明确定义的行为，但与直觉「0 元预警线应立刻告警」相反，需在文档里写明。");
  check("limit=0 行为明确（不抛错、且有确定 level）", lvl === "ok" || lvl === "warn" || lvl === "over", `got='${lvl}'`);
}

// 状态栏/图表着色依据：summary 顶层 alerts 汇总也要跟着变
console.log("\n-- 7) 顶层 alerts 汇总随预警线变化 --");
{
  await setLimit(todayCost * 0.5);
  const a = await summary();
  const overCount = a.json?.alerts?.over;
  console.log(`  limit=今日×0.5 时：alerts=${JSON.stringify(a.json?.alerts)}`);
  check("低于花费时顶层 alerts.over ≥ 1", (overCount ?? 0) >= 1, `over=${overCount}`);
  await setLimit(todayCost * 2);
  const b = await summary();
  console.log(`  limit=今日×2   时：alerts=${JSON.stringify(b.json?.alerts)}`);
  check("调高后顶层 alerts.over 归零", (b.json?.alerts?.over ?? -1) === 0, `over=${b.json?.alerts?.over}`);
}

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}（${c.detail}）`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
