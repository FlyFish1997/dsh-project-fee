// 独立验证：**全量口径**（GET /summary?days=all）是不是真的等于「整份语料」，
// 并且能不能与 365 天滚动口径**区分开**。
//
// 做法（刻意不复用被测实现的解码/定价/聚合）：
//   1) 把真实会话日志冻结成快照，再往快照里**注入**一条 400 天前的合成记录 ——
//      这样「全量」必然比「近 365 天」多出这一条，判别力不是靠推理而是靠数据；
//   2) 我自己枚举文件（每目录取版本号最大的那个）、自己解码多帧 zstd、自己解析 JSONL、
//      自己归属模型、自己按峰谷定价（harness/），算出：全量总额、365 天总额、最早日期；
//   3) 调**真实路由处理器**拿 days=all / days=365 的响应，逐项对账。
//
// 判据：任何一项对不上 → exit 1。缺少被测产物 → exit 2（不得判 pass）。
//
// 效力边界：本检查是【直接调用路由处理器】（mock req/res）+【本地语料快照】。
// 证明不了：浏览器端渲染、CORS/Cookie/登录态、真实宿主里 dsh web 的装配。
import { existsSync, readFileSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { ROOT } from "./harness/runner.mjs";
import { freezeHome, fingerprintOfDir, putSyntheticSession } from "./harness/frozen-home.mjs";
import { callRoute } from "./harness/http.mjs";
import { buildSessionLog } from "./harness/fixtures.mjs";
import { readSessionLog } from "./harness/zstd-frames.mjs";
import { parseJsonl, attributeModels, dedupeByTypeSeq } from "./harness/log-parse.mjs";
import { beijingParts, costCorrect } from "./harness/pricing.mjs";

const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

const DAY_MS = 24 * 3600 * 1000;
const INJECTED_WS = "--D-work-alltime-probe--";
const INJECTED_SESSION = "session-00000000-0000-4000-8000-00000000ab01";

console.log("=== 全量口径（days=all）独立对账 ===");
for (const p of ["lib/routes.js", "lib/ledger.js", "docs/SPEC.md"]) {
  if (!existsSync(join(ROOT, p))) {
    console.log(`${p} 不存在 → 无法验证全量口径（不得判 pass）`);
    process.exit(2);
  }
}

// ---------- 1) 冻结快照 + 注入 400 天前的记录 ----------
const frozen = freezeHome("all-time-caliber", { clean: true });
const injectedTime = Date.now() - 400 * DAY_MS; // 必然落在 days=365 窗口之外
const injectedUsage = { inputTokens: 1_000_000, outputTokens: 0, totalTokens: 1_000_000, cacheReadTokens: 0, reasoningTokens: 0 };
putSyntheticSession(
  frozen.home,
  INJECTED_WS,
  INJECTED_SESSION,
  zstdCompressSync(buildSessionLog({ cwd: "D:\\work\\alltime-probe", usage: injectedUsage, time: injectedTime })),
);
const fp = fingerprintOfDir(frozen.sessionsRoot);
console.log(`冻结快照：${frozen.home}`);
console.log(`  文件=${fp.fingerprint.count}  字节=${fp.fingerprint.totalBytes.toLocaleString("en-US")}  fnv1a=${fp.fingerprint.fnv1a}`);
console.log(`  注入记录：${INJECTED_WS} @ ${new Date(injectedTime).toISOString()}（400 天前）`);

// 独立复算：同一条记录的应计金额（用我方独立定价，而不是被测实现）
const injectedCost = costCorrect(injectedUsage, "deepseek-flash", injectedTime);
console.log(`  注入记录独立自算金额：¥${injectedCost.toFixed(6)}`);

// ---------- 2) 独立解码 + 独立定价 ----------
const dateKeyOf = (ms) => beijingParts(ms).iso.slice(0, 10);
const todayKey = dateKeyOf(Date.now());
/** 北京日「今天 − n」（对 UTC 日做减法再取 ISO 日期，与运行机时区无关）。 */
function dayKeyMinus(n) {
  const [y, m, d] = todayKey.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) - n * DAY_MS).toISOString().slice(0, 10);
}
const from365 = dayKeyMinus(364); // days=365 的窗口下界（含今天共 365 个北京日）

let myFrames = 0;
let myFrameFail = 0;
let myBadLines = 0;
let myDuplicates = 0;
let myUsageRecords = 0;
let myUndated = 0;
let myFuture = 0;
let costAll = 0;
let nAll = 0;
let cos独立实现65 = 0;
let n365 = 0;
let earliest = null;
const oldPart = { cost: 0, n: 0 }; // 365 天窗口之外的记录（判别的关键部分）
const byWorkspace = new Map(); // workspaceDir -> {cost, n}
for (const f of fp.files) {
  const dec = readSessionLog(f.path);
  myFrames += dec.multi.candidateFrames;
  myFrameFail += dec.multi.failed;
  const { records, badLines } = parseJsonl(dec.multi.text);
  myBadLines += badLines.length;
  const { kept, dropped } = dedupeByTypeSeq(attributeModels(records));
  myDuplicates += dropped.length;
  for (const a of kept) {
    myUsageRecords++;
    const t = typeof a.time === "number" ? a.time : null;
    if (t === null) {
      myUndated++;
      continue;
    }
    const dk = dateKeyOf(t);
    if (dk > todayKey) {
      myFuture++;
      continue;
    }
    const c = costCorrect(a.usage, a.model, t);
    costAll += c;
    nAll++;
    if (earliest === null || dk < earliest) earliest = dk;
    const ws = byWorkspace.get(f.workspaceDir) ?? { cost: 0, n: 0 };
    ws.cost += c;
    ws.n++;
    byWorkspace.set(f.workspaceDir, ws);
    if (dk >= from365) {
      cos独立实现65 += c;
      n365++;
    } else {
      oldPart.cost += c;
      oldPart.n++;
    }
  }
}
console.log(
  `\n独立解码：帧=${myFrames} 失败帧=${myFrameFail} 坏行=${myBadLines} 用量记录=${myUsageRecords}` +
    `（重复 ${myDuplicates}、无时间戳 ${myUndated}、未来时间 ${myFuture}）`,
);
console.log(`  独立自算：全量=¥${costAll.toFixed(6)}（${nAll} 条）；近 365 天=¥${cos独立实现65.toFixed(6)}（${n365} 条）`);
console.log(`  其中 365 天窗口之外：${oldPart.n} 条 / ¥${oldPart.cost.toFixed(6)}；最早北京日=${earliest}`);

// 前提：没有重复记录时，逐条对账才成立；有重复就要先按实现口径去重再比（这里显式拦住）
check("独立解码未发现 (type,seq) 重复（保证逐条对账有效）", myDuplicates === 0, `dropped=${myDuplicates}`);

// ---------- 3) 调真实路由 ----------
const { createRouteTable, ROUTE_PATHS } = await import(new URL("../../lib/routes.js", import.meta.url).href);
const { createLedger } = await import(new URL("../../lib/ledger.js", import.meta.url).href);
const ledger = createLedger({ home: frozen.home, persistCache: false });
const table = createRouteTable({ ledger, logger: () => {} });

const all = await callRoute(table, "GET", `${ROUTE_PATHS.summary}?days=all`);
const r365 = await callRoute(table, "GET", `${ROUTE_PATHS.summary}?days=365`);
const roll30 = await callRoute(table, "GET", `${ROUTE_PATHS.summary}?days=30`);
const specText = readFileSync(join(ROOT, "docs/SPEC.md"), "utf8");

console.log(`\n路由：days=all → ${all.status}；days=365 → ${r365.status}；days=30 → ${roll30.status}`);
if (all.status !== 200 || r365.status !== 200) {
  console.log(`  响应体：${JSON.stringify(all.json ?? {}).slice(0, 400)}`);
  check("days=all / days=365 都返回 200", false, `all=${all.status} r365=${r365.status}`);
  console.log("\n=== 通过 0/" + checks.length + " ===");
  process.exit(1);
}
const A = all.json;
const R = r365.json;

const close = (a, b, tol = 1e-6) => Math.abs(a - b) < tol;
const dailySum = (S) => (S.daily ?? []).reduce((s, d) => s + (d.cost ?? 0), 0);
const wsSum = (S) => (S.workspaces ?? []).reduce((s, w) => s + (w.cost ?? 0), 0);

// ---------- 4) 断言 ----------
check("days=all 回显口径字符串 all（client 据此切标签）", A.days === "all", `days=${JSON.stringify(A.days)}`);
check("全量窗口 to = 今天（北京日）", A.window?.to === todayKey, `to=${A.window?.to} today=${todayKey}`);
check("全量窗口 from = 最早一条用量记录所在北京日（我方独立枚举）", A.window?.from === earliest, `from=${A.window?.from} mine=${earliest}`);
check("全量总额 = 独立解码总额", close(A.totals?.cost ?? -1, costAll), `route=¥${A.totals?.cost} mine=¥${costAll}`);
// 记账的 usageRecords 是「处理到的全部用量记录」；我的集合把它分成 有日期且不晚于今天 / 未来 / 无时间戳
check(
  "全量记入条数 + 未来时间 + 无时间戳 = 独立解码到的用量记录总数",
  (A.diagnostics?.usageRecords ?? -1) === nAll + myFuture + myUndated,
  `route=${A.diagnostics?.usageRecords} mine=${nAll}+${myFuture}+${myUndated}`,
);
check("全量: Σ 各工作区费用 = totals.cost", close(wsSum(A), A.totals?.cost ?? -1), `wsSum=¥${wsSum(A)} totals=¥${A.totals?.cost}`);
check("全量: Σ daily 费用 = totals.cost（含最早那天）", close(dailySum(A), A.totals?.cost ?? -1), `dailySum=¥${dailySum(A)} totals=¥${A.totals?.cost}`);
check("全量 daily 切片的每一天都在 [from,to] 内", (A.daily ?? []).every((d) => d.date >= A.window.from && d.date <= A.window.to), `daily=${(A.daily ?? []).length} 天`);
check("全量不含未来日期", (A.daily ?? []).every((d) => d.date <= todayKey), `today=${todayKey}`);

// 判别力：全量必须比 365 天多出「365 天窗口之外」的那部分（本快照里 = 注入记录 + 任何更早的真实记录）
check(
  "判别力：days=all 严格大于 days=365（否则全量等于 365，需求未被满足）",
  (A.totals?.cost ?? 0) > (R.totals?.cost ?? 0) + 1e-9,
  `all=¥${A.totals?.cost} r365=¥${R.totals?.cost}`,
);
check(
  "差额恰等于 365 天窗口之外的独立自算金额（可解释为单一根因）",
  close((A.totals?.cost ?? 0) - (R.totals?.cost ?? 0), oldPart.cost),
  `Δ=¥${((A.totals?.cost ?? 0) - (R.totals?.cost ?? 0)).toFixed(6)} mine=¥${oldPart.cost.toFixed(6)}`,
);
check("注入的 400 天前记录落在「365 天之外」那一部分里（金额可独立复算）", oldPart.cost >= injectedCost - 1e-9, `old=¥${oldPart.cost.toFixed(6)} injected=¥${injectedCost.toFixed(6)}`);

// 365 天滚动口径本身没被改动（对照）
check("days=365 总额 = 独立解码的 365 天窗口总额", close(R.totals?.cost ?? -1, cos独立实现65), `route=¥${R.totals?.cost} mine=¥${cos独立实现65}`);
check("days=365 窗口下界 = 今天 −364", R.window?.from === from365, `from=${R.window?.from} mine=${from365}`);
check("days=365 回显数字 365（未被全量口径污染）", R.days === 365, `days=${JSON.stringify(R.days)}`);

// 无时间戳记录：两种口径都不计入窗口，但必须显式可见（不静默）
check(
  "diagnostics.undatedUsageRecords = 独立计数的无时间戳记录数（all）",
  (A.diagnostics?.undatedUsageRecords ?? -1) === myUndated,
  `route=${A.diagnostics?.undatedUsageRecords} mine=${myUndated}`,
);
check(
  "diagnostics.undatedUsageRecords 不随口径变化（365 天同值）",
  (R.diagnostics?.undatedUsageRecords ?? -1) === myUndated,
  `route=${R.diagnostics?.undatedUsageRecords} mine=${myUndated}`,
);

// 契约文档与实现对得上：SPEC 必须**明确**写明 days 支持 all（不能靠别处的 'all' 字面量蒙混）
check("docs/SPEC.md 写明了 days=all（口径与文档同步）", /days=all/.test(specText), "SPEC 里找不到 days=all");

console.log("\n-- 逐工作区对账（全量口径，取有数据的）--");
let wsMismatch = 0;
for (const w of A.workspaces ?? []) {
  const m = byWorkspace.get(w.workspaceId ?? w.key);
  if (!m) {
    if ((w.usageRecords ?? 0) > 0) {
      wsMismatch++;
      console.log(`  ${String(w.label).padEnd(20)} 路由有数据但独立枚举里没有`);
    }
    continue;
  }
  const ok = close(w.cost ?? -1, m.cost) && (w.usageRecords ?? -1) === m.n;
  if (!ok) wsMismatch++;
  console.log(`  ${String(w.label).padEnd(20)} 记录 route=${String(w.usageRecords).padStart(5)} mine=${String(m.n).padStart(5)}  费用 route=¥${(w.cost ?? 0).toFixed(6)} mine=¥${m.cost.toFixed(6)}  ${ok ? "OK" : "DIFF"}`);
}
check("全量口径下每个工作区的费用与记录数都与独立解码一致", wsMismatch === 0, `${wsMismatch} 个工作区不一致`);

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}（${c.detail}）`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
console.log("效力边界：直接调用路由处理器 + 本地语料快照；证明不了浏览器渲染、登录态与真实宿主装配。");
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
