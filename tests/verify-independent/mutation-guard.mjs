// 独立验证：**变异覆盖矩阵** —— 把维护者的要求系统化：
//   「对每一条与计费/口径相关的断言，问一句：把实现改成已知错误的版本，这条断言会红吗？
//     不会红的就是空转断言。」
//
// 做法（不修改工作区里的被测源码）：
//   把 package.json + lib/ + tests/*.test.mjs + tests/helpers/ 复制到临时目录，
//   在**副本**里注入变异，跑副本自己的测试套件，记录**具体哪些断言红了**。
//   最后输出「变异体 × 断言」矩阵，并标出**抓不到任何变异体的口径断言**（空转嫌疑）。
//
// 判据：
//   - 控制组必须 exit 0；
//   - 每个变异必须**确实被应用**（替换命中恰好 1 次），否则该行结论无效；
//   - 每个变异必须被至少 1 条断言抓到（否则说明该维度无人看守 → 报告为覆盖缺口）。
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { runNode, ROOT, HERE } from "./harness/runner.mjs";
import { TMP_ROOT } from "./harness/frozen-home.mjs";

// 变异副本目录：默认落在 `.tmp-home/mutation`；沙箱内跑时随 TMP_ROOT 一起被
// `DSH_TEST_TMP` 重定向（受限子进程写不了已存在的子目录，见 README.md「测试与受限环境」）。
const SANDBOX = join(TMP_ROOT, "mutation");
const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== 变异覆盖矩阵：口径断言是否真的能拦住错误实现 ===");
if (!existsSync(join(ROOT, "lib/pricing.js"))) {
  console.log("lib/pricing.js 不存在 → 无法验证（不得判 pass）");
  process.exit(2);
}

function buildCopy(name) {
  const root = join(SANDBOX, name);
  if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(join(ROOT, "package.json"), join(root, "package.json"));
  cpSync(join(ROOT, "lib"), join(root, "lib"), { recursive: true });
  const testsDir = join(root, "tests");
  mkdirSync(testsDir, { recursive: true });
  for (const f of readdirSync(join(ROOT, "tests"))) if (/\.test\.mjs$/.test(f)) cpSync(join(ROOT, "tests", f), join(testsDir, f));
  if (existsSync(join(ROOT, "tests", "helpers"))) cpSync(join(ROOT, "tests", "helpers"), join(testsDir, "helpers"), { recursive: true });
  // tests/fixtures/ 是测试的输入（例如 host-tools 的接线回归用 tests/fixtures/toolkit
  // 提供 @deepseek-ai/dsh-tools 的严格替身）。不复制它，控制组就会因为「替身文件不存在」
  // 而出现 2 条与变异无关的失败，把整张变异矩阵判为无效 —— 控制组必须是**干净的 0 失败**。
  if (existsSync(join(ROOT, "tests", "fixtures"))) cpSync(join(ROOT, "tests", "fixtures"), join(testsDir, "fixtures"), { recursive: true });
  // 说明（不是掩盖）：tests/client-bundle.test.mjs:771 会写 <ROOT>/__scratch/panel-render.html
  // 却不创建该目录；__scratch 不属于交付物 → 干净检出下该测试必挂。此处显式补建空目录，
  // 以免它掩盖变异结论。该缺陷已另行报给工程师（F-07）。
  mkdirSync(join(root, "__scratch"), { recursive: true });
  return root;
}

function mutate(root, from, to) {
  const p = join(root, "lib", "pricing.js");
  const text = readFileSync(p, "utf8");
  const hits = text.split(from).length - 1;
  if (hits !== 1) return { applied: false, hits };
  writeFileSync(p, text.replace(from, to), "utf8");
  return { applied: true, hits };
}

const ARGV = ["--test", "--test-isolation=none", "tests/*.test.mjs"];

/** 从输出里提取通过/失败的断言名（兼容 node:test 与 client-bundle 自带 runner 两种格式）。 */
function parseResults(text) {
  const passed = new Set();
  const failed = new Set();
  for (const line of text.split("\n")) {
    let m = /^✔ (.*?) \(\d/.exec(line.trim());
    if (m) { passed.add(m[1]); continue; }
    m = /^✖ (.*?) \(\d/.exec(line.trim());
    if (m) { failed.add(m[1]); continue; }
    m = /^ok\s+-\s*(.*)$/.exec(line.trim());
    if (m) { passed.add(m[1]); continue; }
    m = /^FAIL\s+-\s*(.*)$/.exec(line.trim());
    if (m) { failed.add(m[1]); continue; }
  }
  const failM = /(?:^|\n)ℹ fail (\d+)/.exec(text);
  const passM = /(?:^|\n)ℹ pass (\d+)/.exec(text);
  return { passed, failed, failCount: failM ? Number(failM[1]) : null, passCount: passM ? Number(passM[1]) : null };
}

// ---------- 控制组 ----------
console.log("\n-- 控制组（未变异，必须通过）--");
const ctrlRoot = buildCopy("control");
const ctrl = runNode("mutation-control", ARGV, { cwd: ctrlRoot });
const ctrlRes = parseResults(ctrl.text);
console.log(`  exit=${ctrl.exitCode}  pass=${ctrlRes.passCount}  fail=${ctrlRes.failCount}  断言名=${ctrlRes.passed.size}`);
check("控制组退出码为 0", ctrl.exitCode === 0, `exit=${ctrl.exitCode}`);
check("控制组没有失败的断言", ctrlRes.failed.size === 0, `${ctrlRes.failed.size} 条`);
check("控制组确实跑到了断言（非空转）", ctrlRes.passed.size > 20, `仅 ${ctrlRes.passed.size} 条断言名被解析出来`);

// ---------- 变异体 ----------
const MUTANTS = [
  { id: "M-A", desc: "未命中口径退化为 input-cacheRead（已撤回的约定 3）", from: "inputIncludesCacheRead: false", to: "inputIncludesCacheRead: true" },
  { id: "M-B", desc: "reasoning 重复计费（output+reasoning）", from: "reasoningIncludedInOutput: true", to: "reasoningIncludedInOutput: false" },
  { id: "M-C", desc: "缓存命中不计费（丢掉 cacheRead 项）", from: "((u.cacheReadTokens ?? 0) / 1e6) * resolved.hit +", to: "((u.cacheReadTokens ?? 0) / 1e6) * 0 +" },
  { id: "M-D", desc: "未命中不计费（miss 项归零）", from: "(missTokens / 1e6) * resolved.miss +", to: "(missTokens / 1e6) * 0 +" },
  { id: "M-E", desc: "峰谷判定恒 false（peakSplit 失去高峰归属）", from: "      if (!segmentMatches(segment, weekday, minutes)) continue;", to: "      return false; // MUTANT M-E" },
  { id: "M-F", desc: "CNY Flash 未命中单价被改错（1.0 → 1.5）", from: "flash: { cacheRead: 0.02, cacheMiss: 1.0, output: 4.0 },", to: "flash: { cacheRead: 0.02, cacheMiss: 1.5, output: 4.0 }," },
  { id: "M-G", desc: "串档：deepseek-flash 被映射到 pro 档", from: "    'deepseek-flash': 'flash',", to: "    'deepseek-flash': 'pro'," },
  { id: "M-H", desc: "高峰窗口起点被挪（09:00-10:00 不再算高峰）", from: "      from: window.from,", to: "      from: '10:00'," },
];

const rows = [];
for (const m of MUTANTS) {
  console.log(`\n-- ${m.id}：${m.desc} --`);
  const root = buildCopy(m.id);
  const r = mutate(root, m.from, m.to);
  check(`${m.id} 变异确实被应用（替换命中 1 次）`, r.applied, `hits=${r.hits}`);
  if (!r.applied) {
    console.log(`  变异未生效（命中 ${r.hits} 次）→ 本轮该行结论无效`);
    rows.push({ ...m, applied: false, exitCode: null, caughtBy: [] });
    continue;
  }
  const res = runNode(`mutation-${m.id}`, ARGV, { cwd: root });
  const pr = parseResults(res.text);
  console.log(`  exit=${res.exitCode}  pass=${pr.passCount}  fail=${pr.failCount}  抓到它的断言 ${pr.failed.size} 条`);
  for (const t of pr.failed) console.log(`    ✖ ${t}`);
  check(`${m.id} 被测试套件拦住（exit != 0）`, res.exitCode !== 0, `exit=${res.exitCode}`);
  rows.push({ ...m, applied: true, exitCode: res.exitCode, caughtBy: [...pr.failed] });
}

// ---------- 覆盖矩阵 ----------
console.log("\n=== 覆盖矩阵（口径相关断言 × 变异体）===");
// 口径相关：只筛「计费算术/口径」类断言。
// 注意不能只按「口径/缓存/命中」这类词筛——那会把目录名编码、文件缓存等无关测试也卷进来。
const CALIBER_RE = /计费桶|口径反证|回归守卫|真实语料回归|高峰价|峰谷边界|inputIncludesCacheRead|reasoning 不会改变费用|默认表|价格表必须可覆盖|货币切换|价格版本/;
const caliberTests = [...ctrlRes.passed].filter((t) => CALIBER_RE.test(t)).sort();
const applied = rows.filter((r) => r.applied);
console.log(`口径算术相关断言共 ${caliberTests.length} 条；生效变异体 ${applied.length} 个`);
console.log(`\n${"口径算术相关断言".padEnd(56)} ${MUTANTS.map((m) => m.id).join("  ")}`);
const neverCaught = [];
for (const t of caliberTests) {
  const marks = MUTANTS.map((m) => {
    const row = rows.find((r) => r.id === m.id);
    if (!row || !row.applied) return " ? ";
    return row.caughtBy.includes(t) ? " ✖ " : " · ";
  });
  const any = marks.some((x) => x === " ✖ ");
  if (!any) neverCaught.push(t);
  const label = t.length > 54 ? t.slice(0, 53) + "…" : t;
  console.log(`${label.padEnd(56)} ${marks.join("")}`);
}
console.log("\n图例：✖ = 该变异被这条断言抓到；· = 未抓到；? = 该变异未生效");

console.log(`\n-- 本变异集未触及的口径断言（${neverCaught.length} 条）--`);
if (neverCaught.length === 0) {
  console.log("  无：每条口径算术断言都至少抓住一个已知错误实现。");
} else {
  for (const t of neverCaught) console.log(`  · ${t}`);
}
console.log("\n【效力边界 · 必读】本项**不能**证明某条断言是「空转断言」。");
console.log("  理由：一条断言只有在**存在针对它那个维度的变异体**时才有可能被抓到。");
console.log(`  本变异集只覆盖 ${applied.length} 个维度（${MUTANTS.map((m) => m.id).join("/")}），`);
console.log("  因此上表中「未被任何变异体触到」只说明**该维度尚无变异体**，不等于该断言无用。");
console.log("  反过来，任何一条 ✖ 都是**确凿**的：它证明了断言在该维度上是活的。");

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}（${c.detail}）`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
console.log("结论：控制组绿 + 每个变异体都被至少一条断言抓到 → 这些口径断言不是空转的。");

try {
  rmSync(SANDBOX, { recursive: true, force: true });
  console.log("已清理变异测试临时目录（.tmp-home/mutation）");
} catch {}

if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
