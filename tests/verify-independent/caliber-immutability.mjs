// 独立验证：**口径开关的不可回溯性**（维护者点名的最高风险处）
//
// 维护者要求：「确认翻 `reasoningIncludedInOutput` 这个开关**不会**让任何已计价记录的 cost 改变解读，
//            且不存在『同账本混用两种口径 cost』。」
//
// 做法（不修改被测源码）：
//   1) 冻结 home，放入一条合成用量记录（reasoning>0 且 cacheRead>0，能同时暴露两种口径）；
//   2) 用**默认口径**建账本并落盘 → 记录汇总；
//   3) 在同一份 home（保留已落盘的账本）上用**翻转口径**再建账本 → 再取汇总；
//   4) 比较：已计价记录的数字是否被改写。
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { zstdCompressSync } from "node:zlib";
import { join } from "node:path";
import { ROOT } from "./harness/runner.mjs";
import { freezeHome, putSyntheticSession } from "./harness/frozen-home.mjs";
import { buildSessionLog } from "./harness/fixtures.mjs";

const failures = [];
const checks = [];
function check(label, ok, detail) {
  checks.push({ label, ok, detail });
  if (!ok) failures.push(`${label} — ${detail}`);
}

console.log("=== 口径开关的不可回溯性 ===");
if (!existsSync(join(ROOT, "lib/ledger.js"))) {
  console.log("lib/ledger.js 不存在 → 无法验证（不得判 pass）");
  process.exit(2);
}
const { createLedger } = await import(new URL("../../lib/ledger.js", import.meta.url).href);

const frozen = freezeHome("immutability", { clean: true });
const wsDir = "--D-work-immut--";
const now = Date.now();
// 关键取值：input < cacheRead（判别性不等式）+ reasoning>0（暴露重复计费）
const USAGE = { inputTokens: 739, cacheReadTokens: 16256, outputTokens: 199, reasoningTokens: 98, totalTokens: 17194 };
putSyntheticSession(
  frozen.home,
  wsDir,
  "session-00000000-0000-4000-8000-00000000ee01",
  zstdCompressSync(buildSessionLog({ cwd: "D:\\work\\immut", usage: USAGE, time: now })),
);
console.log(`合成用量：${JSON.stringify(USAGE)}（input<cacheRead 且 reasoning>0）`);

const wsCost = (s) => (s.workspaces ?? []).find((w) => w.workspaceId === wsDir || w.key === wsDir)?.cost;
const wsTokens = (s) => (s.workspaces ?? []).find((w) => w.workspaceId === wsDir || w.key === wsDir)?.tokens;

// 1) 默认口径，落盘
const l1 = createLedger({ home: frozen.home, persistCache: true });
const s1 = l1.summary({ days: 30 });
const c1 = wsCost(s1);
console.log(`\n[1] 默认口径（reasoningIncludedInOutput=true）        cost = ¥${c1}`);

// 2) 同 home、翻转口径
const l2 = createLedger({ home: frozen.home, persistCache: true, pricing: { reasoningIncludedInOutput: false } });
const s2 = l2.summary({ days: 30 });
const c2 = wsCost(s2);
console.log(`[2] 翻转口径（reasoningIncludedInOutput=false）      cost = ¥${c2}`);

// 3) 再建一个默认口径账本（两次读数应一致，排除随机性）
const l3 = createLedger({ home: frozen.home, persistCache: true });
const s3 = l3.summary({ days: 30 });
const c3 = wsCost(s3);
console.log(`[3] 再回默认口径                                     cost = ¥${c3}`);

// 4) 期望：正确公式算出的值（独立自算）
const expectedCorrect = (16256 * 0.02 + 739 * 1.0 + 199 * 4.0) / 1e6;
const expectedLegacy = (16256 * 0.02 + 739 * 1.0 + (199 + 98) * 4.0) / 1e6;
console.log(`\n独立自算：正确口径 = ¥${expectedCorrect.toFixed(9)}   旧口径(加 reasoning) = ¥${expectedLegacy.toFixed(9)}`);

console.log("\n-- 断言 --");
check("[1] 默认口径 == 独立自算的正确值", Math.abs(c1 - expectedCorrect) < 1e-9, `got=${c1} want=${expectedCorrect}`);
check("[3] 重复读取稳定（默认口径两次一致）", Math.abs(c1 - c3) < 1e-12, `c1=${c1} c3=${c3}`);

// 核心问题：翻转开关会不会改写**已计价**的数字？
const flippedChangedBook = Math.abs(c2 - c1) > 1e-12;
console.log(`  翻转开关后：已计价记录的数字${flippedChangedBook ? "**被改写**" : "未变"}（${c1} → ${c2}）`);
if (flippedChangedBook) {
  console.log(`  → 读数变化量 = ¥${(c2 - c1).toFixed(9)}；旧口径期望 = ¥${expectedLegacy.toFixed(9)}`);
  const matchesLegacy = Math.abs(c2 - expectedLegacy) < 1e-9;
  console.log(`  → 翻转后的值${matchesLegacy ? "恰等于旧口径期望" : "**既不等于旧口径也不等于正确口径**（更难解释）"}`);
}
check(
  "翻转口径开关不会改写已计价记录（存量不可回溯）",
  !flippedChangedBook,
  `默认 ¥${c1} → 翻转后 ¥${c2}（差 ¥${(c2 - c1).toFixed(9)}）`,
);
if (flippedChangedBook) {
  console.log("  ★ 这是一条**缺陷记录（F-12）**，不是本脚本的 bug：");
  console.log("    `reasoningIncludedInOutput` 是**全局口径开关、没有 effectiveFrom 时间作用域**，");
  console.log("    因此翻转它会**回溯改写全部历史**；且账本未逐条固化「该记录所用口径」，");
  console.log("    故同一账本在时间上混用两种口径是可能的 —— 正是维护者点名的『无法解释的数字』风险。");
  console.log("    效力边界：本轮每次都用新账本（未观察到持久化账本），");
  console.log("    所以本项证明的是**计算是回溯的**，不是**持久化账本会混用条目**。");
}

// 同账本是否可能混用两种口径：检查账本落盘内容里是否记录了每条记录所用口径
console.log("\n-- 账本落盘内容（口径是否被逐条记录）--");
const dataDir = join(frozen.home, "workspace-fee");
if (existsSync(dataDir)) {
  for (const f of readdirSync(dataDir)) {
    const p = join(dataDir, f);
    const st = statSync(p);
    console.log(`  ${f}  ${st.size}B`);
    if (f.endsWith(".json")) {
      const txt = readFileSync(p, "utf8");
      const mentions = ["reasoningIncludedInOutput", "inputIncludesCacheRead", "caliber", "口径"].filter((k) => txt.includes(k));
      console.log(`    提及口径字段：${mentions.length ? mentions.join(", ") : "（无）"}`);
      const hasPerRecordCost = /\"cost\"/.test(txt);
      console.log(`    是否逐条落盘 cost：${hasPerRecordCost ? "是" : "否（只缓存文件级指纹）"}`);
    }
  }
} else {
  console.log(`  ${dataDir} 不存在（未落盘）`);
}

console.log("\n-- 断言汇总 --");
for (const c of checks) console.log(`  ${c.ok ? "OK  " : "FAIL"} ${c.label}${c.ok ? "" : `（${c.detail}）`}`);
console.log(`\n=== 通过 ${checks.filter((c) => c.ok).length}/${checks.length} ===`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
process.exit(0);
