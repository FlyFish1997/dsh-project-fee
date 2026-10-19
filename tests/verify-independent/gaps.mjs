// 独立验证：gaps 记账 —— 坏输入必须显式暴露，绝不静默跳过
// 用例：空工作区 / 损坏 zstd 帧 / 截断（帧边界）/ 截断（帧内）/ 非 JSONL 行 / 未来时间戳
import { existsSync, readFileSync, mkdirSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { ROOT } from "./harness/runner.mjs";
import { freezeHome, putSyntheticSession } from "./harness/frozen-home.mjs";
import { buildSessionLog, FIXTURE_DIR } from "./harness/fixtures.mjs";
import { readSessionLog } from "./harness/zstd-frames.mjs";
import { parseJsonl, usageRecords } from "./harness/log-parse.mjs";

const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== gaps 记账：坏输入不得静默跳过 ===");
if (!existsSync(join(ROOT, "lib/ledger.js"))) {
  console.log("lib/ledger.js 不存在 → 无法验证（不得判 pass）");
  process.exit(2);
}
const { createLedger } = await import(new URL("../../lib/ledger.js", import.meta.url).href);

const frozen = freezeHome("gaps", { clean: true });
const now = Date.now();
const W = (n) => `--D-work-gaps-${n}--`;
const S = (n) => `session-00000000-0000-4000-8000-00000000cc${n}`;

// 1) 正常工作区
putSyntheticSession(frozen.home, W("ok"), S("01"), zstdCompressSync(buildSessionLog({ cwd: "D:\\work\\gaps-ok", usage: { inputTokens: 1000, outputTokens: 10, totalTokens: 1010, cacheReadTokens: 0, reasoningTokens: 0 }, time: now })));
// 2) 损坏帧
putSyntheticSession(frozen.home, W("corrupt"), S("02"), readFileSync(join(FIXTURE_DIR, "corrupt-frame.jsonl.zstd")));
// 3) 截断（帧边界）
putSyntheticSession(frozen.home, W("truncated"), S("03"), readFileSync(join(FIXTURE_DIR, "truncated.jsonl.zstd")));
// 4) 截断（帧内）
putSyntheticSession(frozen.home, W("truncated-mid"), S("04"), readFileSync(join(FIXTURE_DIR, "truncated-mid-frame.jsonl.zstd")));
// 5) 非 JSONL
putSyntheticSession(frozen.home, W("nonjsonl"), S("05"), readFileSync(join(FIXTURE_DIR, "non-jsonl.jsonl.zstd")));
// 6) 空工作区（目录存在但没有任何会话文件）
mkdirSync(join(frozen.home, "sessions", W("empty")), { recursive: true });
// 6b) 会话目录存在但没有日志文件（SPEC §6: session-log-missing）
mkdirSync(join(frozen.home, "sessions", W("nolog"), S("06")), { recursive: true });
// 7) 未来时间戳
const future = now + 30 * 24 * 3600 * 1000;
putSyntheticSession(frozen.home, W("future"), S("07"), zstdCompressSync(buildSessionLog({ cwd: "D:\\work\\gaps-future", usage: { inputTokens: 500_000, outputTokens: 0, totalTokens: 500_000, cacheReadTokens: 0, reasoningTokens: 0 }, time: future })));

const ledger = createLedger({ home: frozen.home, persistCache: false });
// 用**全量口径**读取：自造语料的时间戳是固定值（2026-09-14），滚动 30 天窗口会随真实日期漂移
// 而把语料排除在窗口外，导致「实现记录数=0」被误判为丢数据。本检查只关心 gaps 与记录数，
// 与窗口无关，因此用 days=all 固定范围。
const summary = ledger.summary({ days: "all" });
const gaps = summary.gaps ?? [];
const d = summary.diagnostics ?? {};

console.log(`\n-- summary 概览 --`);
console.log(`  workspaces=${(summary.workspaces ?? []).length}  gaps=${gaps.length}`);
console.log(`  framesFailed=${d.framesFailed}  parseErrors=${d.parseErrors}  jsonlParseFailedFiles=${d.jsonlParseFailedFiles}  sessionFiles=${d.sessionFiles}`);
console.log(`\n-- gaps 明细（${gaps.length} 条）--`);
for (const g of gaps) console.log(`  ${JSON.stringify(g)}`);

const gapText = JSON.stringify(gaps);
console.log(`\n-- 逐用例判定 --`);
const CASES = [
  ["会话目录缺日志文件", W("nolog"), (g) => gapText.includes("session-log-missing")],
  ["损坏 zstd 帧", W("corrupt"), (g) => gapText.includes(g) || (d.framesFailed ?? 0) > 0],
  ["截断（帧边界）", W("truncated"), (g) => gapText.includes(g) || (d.framesFailed ?? 0) > 0],
  ["截断（帧内）", W("truncated-mid"), (g) => gapText.includes(g) || (d.framesFailed ?? 0) > 0 || (d.jsonlParseFailedFiles ?? 0) > 0],
  ["非 JSONL 行", W("nonjsonl"), (g) => gapText.includes(g) || (d.parseErrors ?? 0) > 0 || (d.jsonlParseFailedFiles ?? 0) > 0],
];
for (const [label, key, pred] of CASES) {
  const ws = (summary.workspaces ?? []).find((w) => w.workspaceId === key || w.key === key);
  const covered = pred(key);
  console.log(`  ${label.padEnd(16)} 工作区存在=${ws ? "是" : "否"}  记录数=${ws?.usageRecords ?? "-"}  已显式暴露=${covered ? "是" : "否"}  ${covered ? "OK" : "FAIL"}`);
  check(`${label} 被显式暴露（gaps 或诊断计数），不静默跳过`, covered, `gapText含=${gapText.includes(key)} framesFailed=${d.framesFailed} parseErrors=${d.parseErrors} jsonlParseFailedFiles=${d.jsonlParseFailedFiles}`);
}

// 坏文件的用量必须等于「我自己独立解码同一文件」的结果：
// 既不能凭空多算（静默假设），也不能凭空少算（静默丢弃可恢复的数据）。
console.log("\n-- 坏文件的用量必须与我的独立解码逐条一致 --");
{
  const expect = {};
  for (const name of ["corrupt-frame", "truncated", "truncated-mid-frame", "non-jsonl"]) {
    const dec = readSessionLog(join(FIXTURE_DIR, `${name}.jsonl.zstd`));
    const { records } = parseJsonl(dec.multi.text);
    expect[name] = { frames: dec.multi.candidateFrames, ok: dec.multi.ok, failed: dec.multi.failed, usages: usageRecords(records).length };
  }
  // 帧数取自当前自造语料（880 帧）：损坏 1 帧、截断 60% 后 529 帧。
  // 这些数字只出现在标签文案里，断言本身用的是独立解码得到的 expect[...]。
  const MAP = [
    ["损坏帧（1 帧坏、879 帧好）", W("corrupt"), "corrupt-frame"],
    ["截断（帧边界，529 帧全好）", W("truncated"), "truncated"],
    ["截断（帧内）", W("truncated-mid"), "truncated-mid-frame"],
    ["非 JSONL", W("nonjsonl"), "non-jsonl"],
  ];
  for (const [label, key, fx] of MAP) {
    const ws = (summary.workspaces ?? []).find((w) => w.workspaceId === key || w.key === key);
    const e = expect[fx];
    const got = ws?.usageRecords ?? 0;
    console.log(`  ${label.padEnd(24)} 独立解码 usageRecords=${String(e.usages).padStart(4)}  实现=${String(got).padStart(4)}  判定=${got === e.usages ? "一致 OK" : "不一致 FAIL"}`);
    check(`${label} 的 usageRecords 与独立解码一致（不凭空多算/少算）`, got === e.usages, `impl=${got} mine=${e.usages}`);
  }
  console.log(`  实现自报 framesFailed=${d.framesFailed}；我的独立解码：corrupt=${expect["corrupt-frame"].failed} 失败帧`);
  check("损坏帧被如实计数（framesFailed == 1）", d.framesFailed === expect["corrupt-frame"].failed, `impl=${d.framesFailed} mine=${expect["corrupt-frame"].failed}`);
  const corruptWs = (summary.workspaces ?? []).find((w) => w.workspaceId === W("corrupt") || w.key === W("corrupt"));
  console.log(`  → 损坏帧工作区 cost=¥${corruptWs?.cost}，来自 879 个完好帧的自造语料数据，**不是凭空成本**`);
}

// 未来时间戳：行为必须明确
console.log("\n-- 未来时间戳：行为必须明确（不得 NaN / 崩溃）--");
{
  const fw = (summary.workspaces ?? []).find((w) => w.workspaceId === W("future") || w.key === W("future"));
  console.log(`  future 工作区：usageRecords=${fw?.usageRecords ?? "-"} todayCost=${fw?.todayCost ?? "-"} lifetimeCost=${fw?.lifetimeCost ?? "-"} cost=${fw?.cost ?? "-"}`);
  const nums = [fw?.todayCost, fw?.lifetimeCost, fw?.cost].filter((x) => x !== undefined);
  check("未来时间记录的金额全部为有限数字（无 NaN/Infinity）", nums.length > 0 && nums.every((x) => Number.isFinite(x)), JSON.stringify(nums));
  const inToday = (fw?.todayCost ?? 0) > 0;
  console.log(`  → 语义：未来时间戳${inToday ? "被计入「今日」" : "未被计入「今日」"}（成本计入 lifetime=${(fw?.lifetimeCost ?? 0) > 0}）`);
  check("未来时间记录行为明确（要么计入今日、要么只计入 lifetime，且被如实报告）", inToday || (fw?.lifetimeCost ?? 0) > 0, `today=${fw?.todayCost} lifetime=${fw?.lifetimeCost}`);
}

// 空工作区：验收要求说「无会话日志的工作区…被显式计入 gaps」，
// 但 SPEC §6 的 kind 词表里没有对应取值。实测：不产生 gap，只在 workspaces 里显示 0 条。
console.log("\n-- 空工作区（SPEC 未定义 kind，但 验收要求提到）--");
{
  const key = W("empty");
  const inGaps = gapText.includes(key);
  const ws = (summary.workspaces ?? []).find((w) => w.workspaceId === key || w.key === key);
  console.log(`  工作区在 workspaces 列表中：${ws ? "是" : "否"}（记录数=${ws?.usageRecords ?? "-"}，成本=${ws?.cost ?? "-"}）`);
  console.log(`  在 gaps 中出现：${inGaps ? "是" : "否"}`);
  console.log(`  → 判定：SPEC §6 无对应 kind；行为是「显式列出但 0 成本」，用户能看到工作区存在，不会误以为有消耗。`);
  check(
    "空工作区被显式计入 gaps（验收要求；SPEC §6 未定义 kind，属口径不一致）",
    inGaps,
    `inGaps=${inGaps}；workspace 可见=${ws ? "是" : "否"}`,
  );
}

// 正常控制组必须完好
console.log("\n-- 控制组：正常工作区不受坏文件影响 --");
{
  const okWs = (summary.workspaces ?? []).find((w) => w.workspaceId === W("ok") || w.key === W("ok"));
  console.log(`  ok 工作区：usageRecords=${okWs?.usageRecords} cost=${okWs?.cost}`);
  check("正常控制组记录数 == 1", okWs?.usageRecords === 1, `usageRecords=${okWs?.usageRecords}`);
}

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}（${c.detail}）`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
