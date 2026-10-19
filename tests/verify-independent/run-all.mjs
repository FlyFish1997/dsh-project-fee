// 独立验证总入口：逐项跑，判据 = 子进程退出码（禁止用正则匹配日志文本判「失败 0 项」）
//
// 退出码语义：
//   0 = 所有「必须跑」的检查都跑了且全通过
//   1 = 有检查跑了但失败
//   2 = 有检查因缺少被测产物而【无法运行】——这绝不算通过（实现未交付时的正确结果）
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { runNode, runScript, ROOT, LOG_DIR } from "./harness/runner.mjs";
import { TMP_ROOT } from "./harness/frozen-home.mjs";

const has = (p) => existsSync(join(ROOT, p));

function anyTestFile() {
  const dirs = ["tests"];
  for (const d of dirs) {
    const abs = join(ROOT, d);
    if (!existsSync(abs)) continue;
    for (const f of readdirSync(abs)) if (/\.test\.mjs$/.test(f)) return true;
  }
  return false;
}

// impl:true 表示依赖被测产物；requires 缺失时记 NOT_RUN（不是 pass）
const CHECKS = [
  { name: "refute-buckets（桶语义反证：input 即 uncached / output 含 reasoning）", kind: "script", path: "tests/verify-independent/refute-buckets.mjs" },
  { name: "refute-frames（多帧/损坏/截断/非 JSONL）", kind: "script", path: "tests/verify-independent/refute-frames.mjs" },
  { name: "refute-caliber（data.usage vs chunk.usage 虚增）", kind: "script", path: "tests/verify-independent/refute-caliber.mjs" },
  { name: "pricing-boundary（我方自算的峰谷边界）", kind: "script", path: "tests/verify-independent/pricing-boundary.mjs" },
  { name: "snapshot-inventory（容量基线 + 全量刷新耗时）", kind: "script", path: "tests/verify-independent/snapshot-inventory.mjs" },
  { name: "source-integrity（源文件可解析 + 无乱码）", kind: "script", path: "tests/verify-independent/source-integrity.mjs" },
  { name: "pricing-impl（实现 vs 独立自算逐条对账）", kind: "script", path: "tests/verify-independent/pricing-impl.mjs", impl: true, requires: ["lib/pricing.js"] },
  { name: "accounting（CLI 报告 vs 独立解码对账，≥3 工作区）", kind: "script", path: "tests/verify-independent/accounting.mjs", impl: true, requires: ["scripts/report.mjs", "lib/report.js"] },
  { name: "all-time-caliber（全量口径 days=all vs 独立解码：窗口起点/总额/判别力）", kind: "script", path: "tests/verify-independent/all-time-caliber.mjs", impl: true, requires: ["lib/routes.js", "lib/ledger.js", "docs/SPEC.md"] },
  { name: "http-contract（三条路由按 SPEC 逐字段）", kind: "script", path: "tests/verify-independent/http-contract.mjs", impl: true, requires: ["lib/routes.js", "docs/SPEC.md"] },
  { name: "invalid-input（days/预警线 非法与边界）", kind: "script", path: "tests/verify-independent/invalid-input.mjs", impl: true, requires: ["lib/routes.js"] },
  { name: "alert-threshold（预警线双向 + 等值边界）", kind: "script", path: "tests/verify-independent/alert-threshold.mjs", impl: true, requires: ["lib/routes.js", "lib/ledger.js"] },
  { name: "gaps（损坏/截断/非 JSONL/空工作区/未来时间 计入 gaps）", kind: "script", path: "tests/verify-independent/gaps.mjs", impl: true, requires: ["lib/session-log.js"] },
  { name: "pricing-source（段内绝对值权威性 + 倍率二次加工分歧探测）", kind: "script", path: "tests/verify-independent/pricing-source.mjs", impl: true, requires: ["lib/pricing.js"] },
  { name: "discrimination（判别力：每条口径断言能区分几种错法）", kind: "script", path: "tests/verify-independent/discrimination.mjs", impl: false },
  { name: "caliber-immutability（口径开关是否回溯改写历史 = F-12）", kind: "script", path: "tests/verify-independent/caliber-immutability.mjs", impl: true, requires: ["lib/ledger.js"] },
  { name: "client-401（401/403 下客户端不白屏，有可见失败态）", kind: "script", path: "tests/verify-independent/client-401.mjs", impl: true, requires: ["lib/client.js"] },
  { name: "mutation-guard（变异覆盖矩阵：口径断言是否空转）", kind: "script", path: "tests/verify-independent/mutation-guard.mjs", impl: true, requires: ["lib/pricing.js"] },
  { name: "plugin self-test（等价命令：--test --test-isolation=none）", kind: "node", argv: ["--test", "--test-isolation=none", "tests/*.test.mjs"], impl: true, requires: ["tests"] },
];

const results = [];
for (const c of CHECKS) {
  if (c.kind === "script" && !existsSync(join(ROOT, c.path))) {
    results.push({ ...c, status: "MISSING_SCRIPT", exitCode: null, ms: 0, tail: `验证脚本尚未编写：${c.path}` });
    continue;
  }
  if (c.impl) {
    const missing = (c.requires ?? []).filter((p) => !has(p));
    if (c.name.startsWith("plugin self-test") && !anyTestFile()) missing.push("tests/*.test.mjs");
    if (missing.length) {
      results.push({ ...c, status: "NOT_RUN", exitCode: null, ms: 0, tail: `缺少被测产物：${missing.join(", ")}` });
      continue;
    }
  }
  const r = c.kind === "node" ? runNode(c.name.split("（")[0], c.argv) : runScript(c.path.split("/").pop(), c.path);
  results.push({ ...c, status: r.exitCode === 0 ? "PASS" : "FAIL", exitCode: r.exitCode, signal: r.signal, ms: r.ms, logPath: r.logPath, tail: r.tail });
}

console.log("=".repeat(100));
console.log("dsh-workspace-fee 独立验证总表 —— 判据：子进程退出码");
console.log("=".repeat(100));
console.log(`${"检查项".padEnd(58)} 状态        退出码     耗时`);
for (const r of results) {
  const label = (r.name.length > 56 ? r.name.slice(0, 55) + "…" : r.name).padEnd(58);
  const code = r.exitCode === null ? "-" : String(r.exitCode);
  console.log(`${label} ${r.status.padEnd(11)} ${code.padEnd(10)} ${r.ms}ms`);
}

const failed = results.filter((r) => r.status === "FAIL");
const notRun = results.filter((r) => r.status === "NOT_RUN" || r.status === "MISSING_SCRIPT");

if (failed.length) {
  console.log("\n" + "-".repeat(100));
  console.log("失败项日志尾部（原始输出）：");
  for (const r of failed) {
    console.log(`\n### ${r.name}  exit=${r.exitCode}  log=${r.logPath ?? "(内联)"}`);
    console.log(r.tail);
  }
}
if (notRun.length) {
  console.log("\n" + "-".repeat(100));
  console.log("未能运行的检查（不算通过）：");
  for (const r of notRun) console.log(`  [${r.status}] ${r.name} — ${r.tail}`);
}

console.log("\n" + "=".repeat(100));
console.log(`合计 ${results.length} 项：通过 ${results.filter((r) => r.status === "PASS").length}、失败 ${failed.length}、未运行 ${notRun.length}`);

// 清理：TMP_ROOT 里是真实会话日志的副本（含会话内容），不留在交付物里。
// .logs 保留（本报告的原始输出留档）。
try {
  if (existsSync(TMP_ROOT)) {
    rmSync(TMP_ROOT, { recursive: true, force: true });
    console.log(`已清理验证临时目录 ${TMP_ROOT}（会话日志副本，不入交付）`);
  }
} catch (err) {
  console.log(`警告：清理 ${TMP_ROOT} 失败：${err?.message ?? err}`);
}

if (failed.length) {
  console.log("判定：FAIL（有检查未通过）→ exit 1");
  process.exit(1);
}
if (notRun.length) {
  console.log("判定：INCOMPLETE（有检查无法运行，绝不能算通过）→ exit 2");
  process.exit(2);
}
console.log("判定：全部通过 → exit 0");
process.exit(0);
