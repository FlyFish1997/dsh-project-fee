// 独立验证：源文件完整性
//  甲) 所有 JS/MJS 必须能被 Node 解析（node --check 退出码 0）
//  乙) 所有文本文件不得含乱码（GBK/UTF-8 误转的典型标记）或 U+FFFD
//
// 背景：本仓库已出现过 lib/pricing.js 被 PowerShell 文本往返写成乱码、
//       导致模块 import 直接 SyntaxError 的事故。这条检查专门守它。
import { readdirSync, readFileSync, statSync, openSync, closeSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, relative, extname } from "node:path";
import { ROOT, LOG_DIR } from "./harness/runner.mjs";
import { mkdirSync, writeFileSync } from "node:fs";

// .tmp-home / .logs 是验证过程产物：前者是会话日志副本（含真实会话内容，不入交付），
// 后者是本报告的原始输出留档。二者都不参与源码完整性扫描。
const SKIP_DIRS = new Set([".git", "node_modules", "__scratch", ".logs", ".tmp-home"]);
const CODE_EXT = new Set([".js", ".mjs", ".cjs"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".txt"]);
// 「UTF-8 中文被按 GBK 读出来」的典型产物码点（快速通道）。
// 刻意只写码点、不写字面——否则本文件会自我误报（已踩过两次）。
// 前 9 个是验证者自选；后半段由维护者提供的特征串扩充（16 个），
// 使**短片段**（不足 30 个 CJK 字）也能被快速通道抓到，不依赖结构判据的样本量。
const MOJIBAKE_CODEPOINTS = [
  0xfffd, // U+FFFD 替换字符
  0x951b, 0x9286, 0x934f, 0x93c4, 0x6d63, 0x9351, 0x9428, 0x947a,
  0x935c, 0x6d93, 0x9366, 0x7ee0, 0x7481, 0x7035, 0x93c2, 0x9422, 0x93c8, 0x6d60, 0x9354, 0x93c3,
];
const MOJIBAKE = new RegExp(`[${MOJIBAKE_CODEPOINTS.map((c) => `\\u{${c.toString(16)}}`).join("")}]`, "u");

// 结构性判据（主判据）：真实中文文本里高频常用字占比很高；
// 而被 GBK 误转的文本几乎不含这些常用字。仅靠「手挑标记字」会漏（已被反向测试抓到过一次）。
const COMMON_HANZI = new Set(
  "的一是不了在人有和中大为上个国我以要他时来用们生到作地于出就分对成会可主发年动同工也能下过子说产种面而方后多定行学法所民得经十三之进着等部度家电力里如水化高自二理起小物现实加量都两体制机当使点从业本去把性好应开它合还因由其些然前外天政四日那社义事平形相全表间样与关各重新线内数正心反你明看原又么利比或但质气第向道命此变条只没结解问意建月公无系军很情者最立代想已通并提直题程展五果料象员革位入常文总次品式活设及管特件长求老头基资边流路级少图山统接知较将组见计别她手角期根论运农指几九区强放决西被干做必战先回则任取据处队南给色光门即保治北造百规热领七海口东导器压志世金增争济阶油思术极交受联什认六共权收证改清己美再采转更单风切打白教速花带安场身车例真务具万每目至达走积示议声报斗完类八离华名确才科张信马节话米整空元况今集温传土许步群广石记需段研界拉林律叫且究观越织装影算低持音众书布复容儿须际商非验连断深难近矿千周委素技备半办青省列习响约支般史感劳便团往酸历市克何除消构府称太准精值号率族维划选标写存候毛亲快效斯院查江型眼王按格养易置派层片始却专状育厂京识适属圆包火住调满县局照参红细引听该铁价严龙飞".split(""),
);
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff]/gu;

/** 返回结构性命中信息：CJK 字数、常用字占比。 */
function hanziProfile(text) {
  const cjk = text.match(CJK_RE) ?? [];
  if (cjk.length === 0) return { cjk: 0, commonRatio: 1, suspicious: false };
  let common = 0;
  for (const ch of cjk) if (COMMON_HANZI.has(ch)) common++;
  const commonRatio = common / cjk.length;
  return { cjk: cjk.length, commonRatio, suspicious: cjk.length >= 30 && commonRatio < 0.05 };
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), out);
    } else if (e.isFile()) {
      out.push(join(dir, e.name));
    }
  }
  return out;
}

const roots = ["lib", "scripts", "tests", "docs"].map((d) => join(ROOT, d)).filter((d) => {
  try {
    return statSync(d).isDirectory();
  } catch {
    return false;
  }
});
const files = roots.flatMap((r) => walk(r));
console.log("=== 源文件完整性 ===");
console.log(`项目根：${ROOT}`);
console.log(`扫描根目录：${roots.map((r) => relative(ROOT, r)).join(", ")}`);
console.log(`文件数：${files.length}\n`);

// 防空转：扫不到文件时必须失败，否则本检查会「0 个文件 → 全部通过」
const vacuous = [];
if (roots.length === 0) vacuous.push("没有任何被测根目录存在（lib/ scripts/ tests/ docs/ 全缺）");
if (files.length === 0) vacuous.push("扫描到 0 个文件");
if (!files.some((f) => CODE_EXT.has(extname(f)))) vacuous.push("扫描到 0 个代码文件");
if (vacuous.length) {
  console.log("  FAIL 空转保护：本次检查没有真正检查到任何目标");
  for (const v of vacuous) console.log(`       ${v}`);
  process.exit(1);
}

mkdirSync(LOG_DIR, { recursive: true });
const checkLog = join(LOG_DIR, "source-integrity.check.log");
const failures = [];

// 甲) node --check
let parsed = 0;
console.log("-- 甲) node --check（语法可解析）--");
for (const f of files) {
  if (!CODE_EXT.has(extname(f))) continue;
  writeFileSync(checkLog, "");
  const fd = openSync(checkLog, "a");
  let res;
  try {
    res = spawnSync(process.execPath, ["--check", f], { stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
  const ok = res.status === 0;
  if (ok) parsed++;
  else {
    const msg = readFileSync(checkLog, "utf8").split("\n").slice(0, 4).join(" | ");
    failures.push(`${relative(ROOT, f)} 无法解析（exit=${res.status}）：${msg}`);
    console.log(`  FAIL ${relative(ROOT, f)}  exit=${res.status}`);
    console.log(`       ${msg}`);
  }
}
console.log(`  ${parsed}/${files.filter((f) => CODE_EXT.has(extname(f))).length} 个代码文件可解析`);

// 乙) 乱码标记
//
// 规则（刻意区分「引用证据」与「真被写坏」）：
//   - 代码文件：全文扫描（乱码出现在字符串字面量里同样要抓）
//   - Markdown  ：先剔除代码围栏与行内 code span 再扫描——
//                 因为本仓库的验证报告会**故意引用**乱码样本作为证据
//   - 兜底：任何文本文件若全文乱码标记 > 200 处，一律判失败
//           （真实事故是这个量级：lib/pricing.js 曾有 126+ 处、误报时上万处）
//
// 注意：new RegExp(re, "g") 会丢掉 u 标志，导致 \u{...} 退化成十六进制字符类（已踩过），
//       所以下面一律用 new RegExp(MOJIBAKE.source, "gu")。
console.log("\n-- 乙) 乱码标记（U+FFFD / GBK 误转标记）--");
const MASS_CORRUPTION_THRESHOLD = 200;
function stripMarkdownCode(text) {
  return text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
}
let mojibakeFiles = 0;
for (const f of files) {
  if (!TEXT_EXT.has(extname(f))) continue;
  const text = readFileSync(f, "utf8");
  const globalRe = new RegExp(MOJIBAKE.source, "gu");
  const rawCount = (text.match(globalRe) ?? []).length;
  const isMd = extname(f) === ".md";
  const scanText = isMd ? stripMarkdownCode(text) : text;
  const m = scanText.match(new RegExp(MOJIBAKE.source, "gu"));
  const massive = rawCount > MASS_CORRUPTION_THRESHOLD;
  const profile = hanziProfile(scanText);
  if ((m && m.length) || massive || profile.suspicious) {
    mojibakeFiles++;
    const scanLines = scanText.split("\n");
    const firstLine = scanLines.findIndex((l) => (new RegExp(MOJIBAKE.source, "u")).test(l));
    const reasons = [];
    if (massive) reasons.push(`全文标记字 ${rawCount} 处（>${MASS_CORRUPTION_THRESHOLD}，整体损坏）`);
    else if (m && m.length) reasons.push(`正文标记字 ${m.length} 处（代码围栏/行内 code 内另有 ${rawCount - m.length} 处，视为引用证据而不计）`);
    if (profile.suspicious) reasons.push(`常用汉字占比仅 ${(profile.commonRatio * 100).toFixed(1)}%（CJK ${profile.cjk} 字）→ 结构性乱码特征`);
    failures.push(`${relative(ROOT, f)} 乱码：${reasons.join("；")}`);
    console.log(`  FAIL ${relative(ROOT, f)}  ${reasons.join("；")}${firstLine >= 0 ? `，首个标记在第 ${firstLine + 1} 行` : ""}`);
  }
}
if (!mojibakeFiles) console.log("  所有文本文件无乱码（Markdown 的引用样本已按规则豁免）");

// 丙) 检测器自检（反「空转通过」）：证明它真的能抓到乱码，且不误报正常中文
console.log("\n-- 丙) 检测器自检（构造真实乱码，验证必被捕获）--");
{
  const ORIGINAL = "价格口径：按工作区维度监控 token 消耗与费用，顶部状态栏、图形化查询面板、预警线编辑。会话日志必须逐帧解码，只取 data.usage。";
  let mojibakeText = null;
  try {
    const dec = new TextDecoder("gbk");
    mojibakeText = dec.decode(Buffer.from(ORIGINAL, "utf8"));
  } catch (err) {
    console.log(`  无法构造 GBK 乱码样本（TextDecoder('gbk') 不可用：${err?.message ?? err}）→ 本项无法自检，显式记为未验证`);
    failures.push("检测器自检未执行：本环境没有 GBK 解码器，无法证明检测器能抓到乱码");
  }
  if (mojibakeText !== null) {
    const clean = hanziProfile(ORIGINAL);
    const dirty = hanziProfile(mojibakeText);
    console.log(`  正常中文：CJK=${clean.cjk}  常用字占比=${(clean.commonRatio * 100).toFixed(1)}%  判为可疑=${clean.suspicious}`);
    console.log(`  构造乱码：CJK=${dirty.cjk}  常用字占比=${(dirty.commonRatio * 100).toFixed(1)}%  判为可疑=${dirty.suspicious}`);
    console.log(`  乱码样本前 40 字：${mojibakeText.slice(0, 40)}`);
    const ok1 = clean.suspicious === false;
    const ok2 = dirty.suspicious === true;
    console.log(`  ${ok1 ? "OK  " : "FAIL"} 正常中文不被误报`);
    console.log(`  ${ok2 ? "OK  " : "FAIL"} 构造乱码必被捕获（检测器非空转）`);
    if (!ok1) failures.push("检测器误报：正常中文被判为乱码");
    if (!ok2) failures.push("检测器空转：构造的真实乱码没有被捕获");
  }
}

console.log("\n=== 判定 ===");
if (failures.length) {
  for (const f of failures) console.log(`  FAIL ${f}`);
  process.exit(1);
}
console.log(`  OK  ${files.length} 个文件：语法全部可解析、无乱码`);
process.exit(0);
