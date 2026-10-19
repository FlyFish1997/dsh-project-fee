// 独立验证：**401 下的客户端失败态**（维护者点名要求）
//
// 为什么单独做：浏览器侧实现的 tests/client-bundle.test.mjs 用例 (g) 覆盖了
//   loading / unreachable / empty / non-JSON，**但没有覆盖 401**。
// 而 401 恰恰是本环境最可能遇到的真实情形（整台服务在登录门后，五条路径全 401）。
//
// 方法（诚实标注）：
//   把 tests/ 复制到临时目录，在**副本**的 client-bundle.test.mjs 末尾**注入我自己的 401 断言**，
//   跑副本；判据 = 子进程退出码。
//   → 复用其测试**脚手架**（vm + 桩 React + 渲染器），但**断言是我写的**，
//     断言内容是「401 必须渲染出可见的非空失败态且不抛未捕获异常」。
//   这不是端到端浏览器验证，证明不了浏览器策略。
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync, readdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { runScript, ROOT, HERE } from "./harness/runner.mjs";
import { TMP_ROOT } from "./harness/frozen-home.mjs";

// 副本目录：默认 `.tmp-home/client401`；沙箱内跑时随 TMP_ROOT 一起被 DSH_TEST_TMP 重定向。
const SANDBOX = join(TMP_ROOT, "client401");
const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== 401 下的客户端失败态（独立断言，复用其测试脚手架）===");
const cbTest = join(ROOT, "tests", "client-bundle.test.mjs");
if (!existsSync(cbTest)) {
  console.log("tests/client-bundle.test.mjs 不存在 → 无法验证（不得判 pass）");
  process.exit(2);
}

// 先做静态核验：实现里是否真有 401 分支
const clientSrc = readFileSync(join(ROOT, "lib", "client.js"), "utf8");
const has401 = /status === 401/.test(clientSrc);
console.log(`\n-- 静态核验 lib/client.js --`);
console.log(`  存在 401/403 专用文案分支：${has401}`);
for (const line of clientSrc.split("\n")) {
  if (/status === 401/.test(line)) console.log(`    ${line.trim().slice(0, 110)}`);
}
check("client.js 含 401 专用失败文案分支", has401, "未找到 status === 401");

// 复制并注入
if (existsSync(SANDBOX)) rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(SANDBOX, { recursive: true });
cpSync(join(ROOT, "package.json"), join(SANDBOX, "package.json"));
cpSync(join(ROOT, "lib"), join(SANDBOX, "lib"), { recursive: true });
const testsDir = join(SANDBOX, "tests");
mkdirSync(testsDir, { recursive: true });
for (const f of readdirSync(join(ROOT, "tests"))) if (/\.test\.mjs$/.test(f)) cpSync(join(ROOT, "tests", f), join(testsDir, f));
if (existsSync(join(ROOT, "tests", "helpers"))) cpSync(join(ROOT, "tests", "helpers"), join(testsDir, "helpers"), { recursive: true });
mkdirSync(join(SANDBOX, "__scratch"), { recursive: true }); // F-07 规避，见 mutation-guard 说明

const INJECT = `

// ===== 由独立验证者注入（独立验证：401 失败态）=====
test('401-失败态) 401 必须渲染出可见、非空的失败态，且不抛未捕获异常', async () => {
	const env = loadBundle({ fetchImpl: makeFakeFetch(() => ({ status: 401, body: { ok: false, error: 'unauthorized' } })) });
	const element = openPanel(env);
	const html = await settleRender(element);
	assert.ok(html.trim().length > 0, '401 不得渲染成空白面板（白屏）');
	assert.ok(html.includes('401'), '失败态里必须出现状态码 401，便于用户/支持定位');
	assert.ok(
		html.includes('需要登录') || html.includes('读不到数据') || html.includes('出错了') || html.includes('读不到'),
		'401 必须给出可见的失败文案，而不是静默空白'
	);
});

test('403-失败态) 403 与 401 走同一失败态分支', async () => {
	const env = loadBundle({ fetchImpl: makeFakeFetch(() => ({ status: 403, body: { ok: false, error: 'forbidden' } })) });
	const element = openPanel(env);
	const html = await settleRender(element);
	assert.ok(html.trim().length > 0, '403 不得渲染成空白面板');
	assert.ok(html.includes('403') || html.includes('需要登录') || html.includes('读不到数据') || html.includes('出错了'), '403 必须有可见失败态');
});
`;
const target = join(testsDir, "client-bundle.test.mjs");
// 关键：该文件用自建收集器 `const test = (name, fn) => CASES.push(...)`，
// 并在文件**末尾**用一个 for 循环跑 CASES —— 所以「追加到文件末尾」的 test() 注册**永远不会被执行**
//（第一版就栽在这里：输出仍是 17/17，我的两条断言根本没跑）。
// 必须插到 **runner 循环之前**。
const RUNNER_ANCHOR = "for (const [name, fn] of CASES) {";
const orig = readFileSync(target, "utf8");
const anchorCount = orig.split(RUNNER_ANCHOR).length - 1;
check("找到唯一的 runner 循环锚点", anchorCount === 1, `命中 ${anchorCount} 次`);
const patched = orig.replace(RUNNER_ANCHOR, INJECT + "\n" + RUNNER_ANCHOR);
writeFileSync(target, patched, "utf8");
const injected = readFileSync(target, "utf8").includes("401-失败态");
check("401 断言确实被注入副本（非空转）", injected, "注入失败");
check("注入位置在 runner 循环之前", readFileSync(target, "utf8").indexOf("401-失败态") < readFileSync(target, "utf8").indexOf(RUNNER_ANCHOR), "注入点晚于循环，会不执行");

console.log(`\n-- 运行：副本中的 client-bundle.test.mjs（含我注入的 2 条 401 断言）--`);
const r = runScript("client401", "tests/client-bundle.test.mjs", [], { cwd: SANDBOX });
console.log(`  exit=${r.exitCode}  log=${r.logPath}`);
const lines = r.text.split("\n");
for (const l of lines) if (/401-失败态|FAILED|checks passed|✖|FAIL -/.test(l)) console.log(`  ${l.trim()}`);
check("注入 401 断言后 client-bundle 测试退出码为 0", r.exitCode === 0, `exit=${r.exitCode}`);
check("注入的 401 断言确实跑到了（出现在输出里）", /401-失败态/.test(r.text), "输出里没有 401-失败态，可能未被执行");
check("注入的 401 断言没有失败", !/FAIL - 401-失败态|✖ 401-失败态/.test(r.text), "401 断言失败（可能白屏或缺少失败文案）");

const passedM = /(\d+)\/(\d+) client-bundle checks passed/.exec(r.text);
if (passedM) console.log(`  → 副本共 ${passedM[1]}/${passedM[2]} 项通过`);

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}${c.ok ? "" : `（${c.detail}）`}`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
console.log("效力边界：本项在 vm 沙箱中注入 401 响应，**证明不了**浏览器策略（CORS/Cookie/登录态）；");
console.log("          真实 401 行为需登录后的浏览器会话 —— 见 README.md 的 移交说明。");

try {
  rmSync(SANDBOX, { recursive: true, force: true });
} catch {}

if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
