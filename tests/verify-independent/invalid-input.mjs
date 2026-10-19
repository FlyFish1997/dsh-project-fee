// 独立验证：非法与边界输入表
//   甲) days = 0 / -1 / abc / 99999 / 1.5 / 空 / 1 / 365，以及全量口径 all / ALL / allx
//   乙) 预警线写入：0 / 负数 / 非数字 / 超大值 / null
// 判据：期望与实测逐条对照，全部符合 → exit 0。
//
// 走的是真实路由处理器（mock req/res）。这是替代路径：
// 【证明不了】CORS / Cookie / 浏览器策略，VERIFY.md 必须标注。
import { existsSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { runNode, ROOT, LOG_DIR } from "./harness/runner.mjs";
import { freezeHome, putSyntheticSession } from "./harness/frozen-home.mjs";
import { callRoute } from "./harness/http.mjs";
import { buildSessionLog } from "./harness/fixtures.mjs";

const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== 非法与边界输入表 ===");
if (!existsSync(join(ROOT, "lib/routes.js"))) {
  console.log("lib/routes.js 不存在 → 无法验证（不得判 pass）");
  process.exit(2);
}

const { createRouteTable } = await import(new URL("../../lib/routes.js", import.meta.url).href);
const { createLedger } = await import(new URL("../../lib/ledger.js", import.meta.url).href);

// 造一个小的合成 home（含一个工作区、一条用量记录），避免跑全语料
const frozen = freezeHome("invalid-input", { clean: true });
const wsDir = "--D-work-synthetic-input--";
const now = Date.now();
putSyntheticSession(
  frozen.home,
  wsDir,
  "session-00000000-0000-4000-8000-00000000aa01",
  zstdCompressSync(buildSessionLog({ cwd: "D:\\work\\synthetic-input", usage: { inputTokens: 1000, outputTokens: 100, totalTokens: 1100, cacheReadTokens: 0, reasoningTokens: 0 }, time: now })),
);
console.log(`合成 home：${frozen.home}（1 个工作区）`);

function makeLedger() {
  return createLedger({ home: frozen.home, persistCache: false });
}

// ---------- 甲) days ----------
console.log("\n-- 甲) GET /summary?days=N --");
const ledger = makeLedger();
const table = createRouteTable({ ledger, logger: () => {} });
console.log(`${"days 取值".padEnd(12)} 期望      实测状态   ok:false?  判定`);
const DAYS = [
  ["(缺省)", null, 200, true],
  ["30", "30", 200, true],
  ["1", "1", 200, true],
  ["365", "365", 200, true],
  ["0", "0", 400, false],
  ["-1", "-1", 400, false],
  ["abc", "abc", 400, false],
  ["99999", "99999", 400, false],
  ["1.5", "1.5", 400, false],
  ["", "", 200, true],
  [" 30 ", "%2030%20", 200, true],
  ["-0", "-0", 400, false],
  ["1e3", "1e3", 400, false],
  // 全量口径是**显式字面量**：all / ALL 合法；拼错、混写一律 400（不能「非数字即全量」）
  ["all", "all", 200, true],
  ["ALL", "ALL", 200, true],
  [" all ", "%20all%20", 200, true],
  ["allx", "allx", 400, false],
  ["365all", "365all", 400, false],
  ["everything", "everything", 400, false],
];
for (const [label, raw, expectStatus, expectOk] of DAYS) {
  const url = raw === null ? "/api/dsh-workspace-fee/summary" : `/api/dsh-workspace-fee/summary?days=${raw}`;
  const r = await callRoute(table, "GET", url);
  const got = r.status;
  const okField = r.json?.ok;
  const judge = got === expectStatus && (expectOk ? okField === true : okField === false);
  console.log(
    `${String(label).padEnd(12)} ${String(expectStatus).padEnd(9)} ${String(got).padEnd(10)} ${String(okField).padEnd(10)} ${judge ? "OK" : "FAIL"}`,
  );
  check(`days=${label} → ${expectStatus}${expectOk ? " 且 ok:true" : " 且 ok:false"}`, judge, `status=${got} ok=${okField}`);
  // 200 时回显的 days 必须是「数字」或全量字面量 all —— 不得是 NaN/null/未定义
  if (got === 200) {
    const echoed = r.json?.days;
    check(
      `days=${label} 回显值合法（数字或 'all'）`,
      Number.isFinite(echoed) || echoed === "all",
      `days=${JSON.stringify(echoed)}`,
    );
  }
}

// ---------- 乙) 预警线 ----------
console.log("\n-- 乙) POST /config 写入预警线 --");
console.log(`${"alert 值".padEnd(20)} 期望      实测状态  ok?   判定`);
const ALERTS = [
  ["limit=5", { alerts: { [wsDir]: { limit: 5 } } }, 200, true],
  ["limit=0", { alerts: { [wsDir]: { limit: 0 } } }, null, null], // 0 允许（语义=不告警），需明确定义
  ["limit=-1", { alerts: { [wsDir]: { limit: -1 } } }, 400, false],
  ["limit='abc'", { alerts: { [wsDir]: { limit: "abc" } } }, 400, false],
  ["limit=NaN", { alerts: { [wsDir]: { limit: null } } }, null, null], // null = 清除，应 200
  ["limit=1e12", { alerts: { [wsDir]: { limit: 1e12 } } }, 200, true],
  ["limit=-0", { alerts: { [wsDir]: { limit: -0 } } }, null, null],
  ["limit=Infinity", { alerts: { [wsDir]: { limit: "Infinity" } } }, 400, false],
];
for (const [label, body, expectStatus, expectOk] of ALERTS) {
  const r = await callRoute(table, "POST", "/api/dsh-workspace-fee/config", body);
  const okField = r.json?.ok;
  const judge = expectStatus === null ? true : r.status === expectStatus && (expectOk ? okField === true : okField === false);
  console.log(`${label.padEnd(20)} ${String(expectStatus ?? "定义值").padEnd(9)} ${String(r.status).padEnd(9)} ${String(okField).padEnd(6)} ${judge ? "OK" : "FAIL"}`);
  if (expectStatus !== null) {
    check(`alert ${label} → ${expectStatus}${expectOk ? " 且 ok:true" : " 且 ok:false"}`, judge, `status=${r.status} ok=${okField}`);
  } else {
    // 未定死期望的场景：只要求「行为明确且不是 500/NaN」
    const defined = r.status === 200 || r.status === 400;
    console.log(`    → ${label} 的实际语义：status=${r.status}，写回 limit=${JSON.stringify(r.json?.alerts?.[wsDir]?.limit ?? null)}`);
    check(`alert ${label} 行为明确（200 或 400，且非 500）`, defined, `status=${r.status}`);
  }
}

// 拒绝后无副作用：负值被拒后，值不应变成 -1
{
  await callRoute(table, "POST", "/api/dsh-workspace-fee/config", { alerts: { [wsDir]: { limit: 7 } } });
  const before = await callRoute(table, "GET", "/api/dsh-workspace-fee/config");
  const b = before.json?.alerts?.[wsDir]?.limit;
  const rej = await callRoute(table, "POST", "/api/dsh-workspace-fee/config", { alerts: { [wsDir]: { limit: -3 } } });
  const after = await callRoute(table, "GET", "/api/dsh-workspace-fee/config");
  const a = after.json?.alerts?.[wsDir]?.limit;
  console.log(`\n  负值拒绝无副作用：拒绝前 limit=${b}，拒绝响应 status=${rej.status}，拒绝后 limit=${a}`);
  check("非法写入不改变既有预警线（无副作用）", b === 7 && a === 7, `before=${b} after=${a} rejectStatus=${rej.status}`);
}

// ---------- 丙) 方法与未知路径 ----------
console.log("\n-- 丙) 方法与路径 --");
{
  const cases = [
    ["POST", "/api/dsh-workspace-fee/summary", 405],
    ["GET", "/api/dsh-workspace-fee/refresh", 405],
    ["PUT", "/api/dsh-workspace-fee/config", 405],
  ];
  for (const [m, u, expect] of cases) {
    const r = await callRoute(table, m, u);
    const allow = r.headers?.allow;
    console.log(`  ${m} ${u} → ${r.status}（期望 ${expect}）Allow=${allow ?? "(无)"} ${r.status === expect ? "OK" : "FAIL"}`);
    check(`${m} ${u} → ${expect}`, r.status === expect, `got=${r.status}`);
  }
  const health = await callRoute(table, "GET", "/api/dsh-workspace-fee/health");
  console.log(`  GET /health → ${health.status} ${JSON.stringify(health.json)?.slice(0, 120)}`);
  check("GET /health → 200 且 ok:true", health.status === 200 && health.json?.ok === true, `status=${health.status} ok=${health.json?.ok}`);
}

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}（${c.detail}）`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
