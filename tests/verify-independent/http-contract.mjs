// 独立验证：HTTP 契约逐字段核对（三条契约路由 + health）
//
// 重要效力边界：这里走的是【直接调用真实路由处理器】（mock req/res）。
// 它证明不了：CORS / Cookie / 同源 fetch / 登录态 / 浏览器策略 —— 见 README.md。
//
// 若 docs/SPEC.md 缺失 → exit 2（契约无法被核对，绝不能算通过）。
import { existsSync, readFileSync } from "node:fs";
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
const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : typeof v);

console.log("=== HTTP 契约逐字段核对（替代路径：直接调用路由处理器）===");
const specPath = join(ROOT, "docs/SPEC.md");
if (!existsSync(join(ROOT, "lib/routes.js"))) {
  console.log("lib/routes.js 不存在 → 无法验证（不得判 pass）");
  process.exit(2);
}
if (!existsSync(specPath)) {
  console.log(`docs/SPEC.md 不存在 → 无法与冻结契约逐字段核对（不得判 pass）`);
  process.exit(2);
}
const spec = readFileSync(specPath, "utf8");
console.log(`SPEC: ${specPath}（${spec.length} 字符）`);

const { createRouteTable, ROUTE_PATHS } = await import(new URL("../../lib/routes.js", import.meta.url).href);
const { createLedger } = await import(new URL("../../lib/ledger.js", import.meta.url).href);

const frozen = freezeHome("http-contract", { clean: true });
const wsDir = "--D-work-http-probe--";
putSyntheticSession(
  frozen.home,
  wsDir,
  "session-00000000-0000-4000-8000-00000000dd01",
  zstdCompressSync(buildSessionLog({ cwd: "D:\\work\\http-probe", usage: { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cacheReadTokens: 0, reasoningTokens: 0 }, time: Date.now() })),
);
const ledger = createLedger({ home: frozen.home, persistCache: false });
const table = createRouteTable({ ledger, logger: () => {} });

// ---------- 0) SPEC 声明的路径必须都存在 ----------
console.log("\n-- 0) SPEC 里出现的路由路径 vs 真实路由表 --");
const specPaths = [...new Set((spec.match(/\/api\/dsh-workspace-fee\/[a-z-]+/g) ?? []))].sort();
const realPaths = table.map((r) => r.path).sort();
console.log(`  SPEC 声明：${specPaths.join(", ")}`);
console.log(`  实际注册：${realPaths.join(", ")}`);
for (const p of specPaths) {
  const ok = realPaths.includes(p);
  console.log(`  ${ok ? "OK  " : "FAIL"} SPEC 路径 ${p} 已注册`);
  check(`SPEC 声明的路径 ${p} 已注册`, ok, `real=${realPaths.join(",")}`);
}

// ---------- 1) 逐字段断言 ----------
function assertShape(name, obj, spec) {
  for (const [key, expected] of Object.entries(spec)) {
    const present = obj !== null && obj !== undefined && key in obj;
    const got = present ? typeOf(obj[key]) : "(缺失)";
    const ok = present && (expected === "*" || got === expected);
    console.log(`  ${ok ? "OK  " : "FAIL"} ${name}.${key} 期望=${expected} 实际=${got}`);
    check(`${name}.${key} 类型`, ok, `期望=${expected} 实际=${got}`);
  }
}

console.log("\n-- 1) GET /summary --");
const s = await callRoute(table, "GET", `${ROUTE_PATHS.summary}?days=30`);
console.log(`  status=${s.status}  content-type=${s.headers["content-type"]}  cache-control=${s.headers["cache-control"]}`);
check("GET /summary → 200", s.status === 200, `status=${s.status}`);
check("content-type 为 application/json; charset=utf-8", s.headers["content-type"] === "application/json; charset=utf-8", String(s.headers["content-type"]));
check("cache-control: no-store", s.headers["cache-control"] === "no-store", String(s.headers["cache-control"]));
assertShape("summary", s.json, {
  ok: "boolean",
  generatedAt: "string",
  days: "number",
  window: "object",
  today: "object",
  totals: "object",
  workspaces: "array",
  daily: "array",
});
assertShape("summary.window", s.json?.window, { from: "string", to: "string", timezone: "string", timezoneOffsetMinutes: "number" });
assertShape("summary.today", s.json?.today, { date: "string", cost: "number", tokens: "object" });
assertShape("summary.totals", s.json?.totals, { tokens: "object", cost: "number" });
assertShape("summary.today.tokens", s.json?.today?.tokens, {
  inputTokens: "number",
  outputTokens: "number",
  cacheReadTokens: "number",
  reasoningTokens: "number",
  totalTokens: "number",
});
{
  const w = (s.json?.workspaces ?? [])[0];
  console.log(`  workspaces[0] = ${JSON.stringify(w)}`);
  assertShape("workspace[0]", w, { key: "string", workspaceId: "string", label: "string", sessions: "number", usageRecords: "number", tokens: "object", cost: "number", alert: "object" });
  assertShape("workspace[0].alert", w?.alert, { limit: "*", level: "string" });
}

console.log("\n-- 1b) GET /summary?days=all（全量口径）--");
{
  const a = await callRoute(table, "GET", `${ROUTE_PATHS.summary}?days=all`);
  console.log(`  status=${a.status}  days=${JSON.stringify(a.json?.days)}  window=${JSON.stringify(a.json?.window)}`);
  check("GET /summary?days=all → 200", a.status === 200, `status=${a.status}`);
  // days 在滚动口径下是数字，在全量口径下是字面量 'all'（SPEC v1.4 起）
  check("days=all 时 days 字段原样回显 'all'", a.json?.days === "all", `days=${JSON.stringify(a.json?.days)}`);
  assertShape("summary(days=all)", a.json, { ok: "boolean", generatedAt: "string", window: "object", totals: "object", workspaces: "array", daily: "array" });
  assertShape("summary(days=all).window", a.json?.window, { from: "string", to: "string", timezone: "string", timezoneOffsetMinutes: "number" });
  const fromAll = a.json?.window?.from;
  const from30 = s.json?.window?.from;
  console.log(`  全量窗口起点=${fromAll}　近 30 天窗口起点=${from30}`);
  // 注意：滚动口径的 from 是**算出来的**下界（可能没有数据），全量的 from 是**最早有数据的日期**，
  // 所以不能直接比大小 —— 只能用「全量 ⊇ 近 30 天」这条超集关系来判。
  const allDaily = new Map((a.json?.daily ?? []).map((d) => [`${d.date}|${d.workspaceKey ?? d.workspaceId}`, d.cost ?? 0]));
  const d30Daily = s.json?.daily ?? [];
  const missing = d30Daily.filter((d) => !allDaily.has(`${d.date}|${d.workspaceKey ?? d.workspaceId}`));
  console.log(`  近 30 天 daily=${d30Daily.length} 条，全量 daily=${allDaily.size} 条，其中 30 天里有而全量缺的=${missing.length}`);
  check("全量 daily 是近 30 天 daily 的超集（同日同工作区一条不缺）", missing.length === 0, `missing=${missing.length}`);
  const costDiff = d30Daily.filter((d) => Math.abs((allDaily.get(`${d.date}|${d.workspaceKey ?? d.workspaceId}`) ?? -1) - (d.cost ?? 0)) > 1e-9);
  check("同 (日期,工作区) 在全量与 30 天窗口下费用一致（全量没有重复计费）", costDiff.length === 0, `${costDiff.length} 条不一致`);
  const earliestDaily = (a.json?.daily ?? []).reduce((m, d) => (m === null || d.date < m ? d.date : m), null);
  check("全量窗口起点 = 最早有数据的北京日（有数据时）", earliestDaily === null || fromAll === earliestDaily, `from=${fromAll} dailyMin=${earliestDaily}`);
  check("全量窗口终点 = 今天（与 days=30 相同）", a.json?.window?.to === s.json?.window?.to, `all=${a.json?.window?.to} d30=${s.json?.window?.to}`);
  check("全量总额 ≥ 近 30 天总额（全量是超集）", (a.json?.totals?.cost ?? -1) >= (s.json?.totals?.cost ?? -1) - 1e-9, `all=¥${a.json?.totals?.cost} d30=¥${s.json?.totals?.cost}`);
  const wsSum = (a.json?.workspaces ?? []).reduce((sum, w) => sum + (w.cost ?? 0), 0);
  check("全量：Σ 工作区费用 = totals.cost", Math.abs(wsSum - (a.json?.totals?.cost ?? 0)) < 1e-6, `wsSum=¥${wsSum} totals=¥${a.json?.totals?.cost}`);
  check("SPEC 文本明确写明 days=all", /days=all/.test(spec), "SPEC 未提及 days=all");
}

console.log("\n-- 2) GET /config --");
const c = await callRoute(table, "GET", ROUTE_PATHS.config);
console.log(`  status=${c.status}`);
check("GET /config → 200", c.status === 200, `status=${c.status}`);
assertShape("config", c.json, { ok: "boolean", currency: "string", alerts: "object", pricing: "object", config: "object" });
assertShape("config.pricing", c.json?.pricing, { activeVersionId: "string", currency: "string", peakMultiplier: "number" });

console.log("\n-- 3) POST /config（写入预警线并回读）--");
const p = await callRoute(table, "POST", ROUTE_PATHS.config, { alerts: { [wsDir]: { limit: 3 } } });
console.log(`  status=${p.status}  回读 alerts=${JSON.stringify(p.json?.alerts?.[wsDir])}`);
check("POST /config → 200", p.status === 200, `status=${p.status}`);
check("写入的预警线被正确回读", p.json?.alerts?.[wsDir]?.limit === 3, JSON.stringify(p.json?.alerts?.[wsDir]));

console.log("\n-- 4) POST /refresh --");
const rf = await callRoute(table, "POST", ROUTE_PATHS.refresh);
console.log(`  status=${rf.status}  keys=${Object.keys(rf.json ?? {}).join(", ")}`);
check("POST /refresh → 200", rf.status === 200, `status=${rf.status}`);

console.log("\n-- 5) GET /health --");
const h = await callRoute(table, "GET", ROUTE_PATHS.health);
console.log(`  status=${h.status}  body=${JSON.stringify(h.json)}`);
check("GET /health → 200 且 ok:true", h.status === 200 && h.json?.ok === true, `status=${h.status}`);

console.log("\n-- 断言汇总 --");
const okCount = checks.filter((x) => x.ok).length;
for (const x of checks) if (!x.ok) console.log(`  FAIL ${x.label}（${x.detail}）`);
console.log(`\n=== 通过 ${okCount}/${checks.length} ===`);
console.log("效力边界：本检查为【直接调用路由处理器】，证明不了 CORS/Cookie/同源 fetch/浏览器策略。");
if (failures.length) process.exit(1);
process.exit(0);
