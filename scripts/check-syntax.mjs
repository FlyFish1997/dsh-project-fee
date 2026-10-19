// 机械闸门：全量语法 + 编码完整性检查。
//
// 为什么需要它：本项目两次事故都出在「改文件把模块改坏」——
//   1) lib/pricing.js 被 PowerShell 文本往返（GBK）改坏，整个插件装不上；
//   2) 一次编辑把模板串收尾引号写错，文件无法执行。
// 这类问题不该靠人记得检查。本脚本把它们变成一条可失败判据。
//
// 判据（全部以退出码表达）：
//   0 = 全部通过
//   1 = 有文件语法失败或含疑似乱码
//   2 = 扫描到的文件数为 0（**无法运行**，不是通过 —— 防止空转通过）
//
// 两个实测约束（本脚本为此特意避开）：
//   A) 受限环境**可能禁止捕获子进程 stdio**，所以 `execFileSync(node, ['--check', f])`
//      一律 EPERM。语法检查必须在**进程内**完成（见 parseCheck）。
//   B) 乱码检测**不能用手挑的特征字**：GBK 往返产物本身就是合法汉字，
//      手挑会同时误报正常中文。必须用**结构性判据**（见 looksMojibake）。
//
// 必须带 --experimental-vm-modules 运行（见 package.json 的 check:syntax）。
// 没有它就只能退化为「括号/引号配平」，而那会**误报**（正则字面量里的括号、
// 除号后的斜杠都会被错判）—— 一个会误报的闸门等于没有闸门，
// 因此退化模式**以 exit 2 报「无法运行」**，而不是给出一个不可信的绿。
//
// 用法：
//   node --experimental-vm-modules scripts/check-syntax.mjs
//   node --experimental-vm-modules scripts/check-syntax.mjs --json
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, extname, relative } from "node:path";
import vm from "node:vm";

const ROOT = process.cwd();
const JSON_OUT = process.argv.includes("--json");

const SCAN_DIRS = ["lib", "scripts", "tests", "docs"];
const SKIP_DIRS = new Set([
  "node_modules", ".git", ".tmp", ".tmp-home", ".logs", "__scratch",
]);
const CODE_EXT = new Set([".js", ".mjs", ".cjs"]);
const TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".ps1"]);

/**
 * 进程内语法检查（不能用子进程：沙箱拒绝捕获子进程 stdio）。
 * 优先用 vm.SourceTextModule 解析（支持 import/export），
 * 需要 --experimental-vm-modules；不可用时退化为 vm.Script + 括号/引号配平。
 * @returns {string|null} 错误描述，通过则 null
 */
function parseCheck(file, text) {
  if (typeof vm.SourceTextModule === "function") {
    try {
      new vm.SourceTextModule(text, { identifier: file });
      return null;
    } catch (err) {
      return String(err && err.message ? err.message : err);
    }
  }
  // 退化路径不可信（会误报），由调用方以 exit 2 处理。
  // 这里保留一个最小检查只是为了在确实没有 vm.SourceTextModule 时也能给出提示。
  return balanceCheck(text);
}

/** 轻量配平：引号、反引号、括号。忽略注释与字符串内部的分隔符是一个近似。 */
function balanceCheck(text) {
  const stack = [];
  let i = 0;
  const pairs = { "(": ")", "[": "]", "{": "}" };
  while (i < text.length) {
    const c = text[i];
    const n = text[i + 1];
    if (c === "/" && n === "/") { while (i < text.length && text[i] !== "\n") i += 1; continue; }
    if (c === "/" && n === "*") { i += 2; while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1; i += 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      i += 1;
      while (i < text.length && text[i] !== quote) {
        if (text[i] === "\\") i += 1;
        if (text[i] === "\n" && quote !== "`") {
          return `未闭合的字符串（${quote} 在换行前没有收尾）`;
        }
        i += 1;
      }
      if (i >= text.length) return `未闭合的字符串（${quote} 到文件结尾都没有收尾）`;
      i += 1;
      continue;
    }
    if (pairs[c]) stack.push(pairs[c]);
    else if (c === ")" || c === "]" || c === "}") {
      if (stack.pop() !== c) return `括号不配平：遇到意外的 '${c}'`;
    }
    i += 1;
  }
  if (stack.length > 0) return `括号不配平：缺少 ${stack.length} 个收尾`;
  return null;
}

// 常用汉字：GBK 往返产物**几乎不会**由这些字高频组成。
// 判据是结构性的 —— 一段 CJK 文本若「常用字占比」极低，就不是正常中文。
const COMMON_HAN = new Set(
  "的一是了我不人在他有这个上们来到时大地为子中你说生国年着就那和要她出也得里后自以会家可下而过天去能对小多然于心学么之都好看起发当没成只如事把还用第样道想作种开美总从无情己面最女但现前些所同日手又行意动方期它头经长儿回位分爱老因很给名法间斯知世什两次使身者被高已亲其进此话常与活正感".split(""),
);

/**
 * 结构性乱码判据。
 * @returns {boolean} 是否疑似 GBK 往返乱码
 */
function looksMojibake(text) {
  let cjk = 0;
  let common = 0;
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp >= 0x4e00 && cp <= 0x9fff) {
      cjk += 1;
      if (COMMON_HAN.has(ch)) common += 1;
    }
  }
  // CJK 太少不做判断（英文文件、少量中文示例都属正常）
  if (cjk < 30) return false;
  // 正常中文里常用字占比通常 >15%；GBK 往返产物接近 0%
  return common / cjk < 0.05;
}

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

const allFiles = SCAN_DIRS.flatMap((d) => walk(join(ROOT, d)));
const codeFiles = allFiles.filter((f) => CODE_EXT.has(extname(f)));
const textFiles = allFiles.filter((f) => TEXT_EXT.has(extname(f)));

const syntaxFailures = [];
const mojibakeHits = [];
const readFailures = [];

for (const f of codeFiles) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    readFailures.push(relative(ROOT, f));
    continue;
  }
  // 若文件里含 U+FFFD，说明它已经不是合法 UTF-8 往返的结果
  if (text.includes("\uFFFD")) {
    syntaxFailures.push({ file: relative(ROOT, f), detail: "含 U+FFFD 替换字符（编码已损坏）" });
    continue;
  }
  const err = parseCheck(f, text);
  if (err) syntaxFailures.push({ file: relative(ROOT, f), detail: err });
}

for (const f of textFiles) {
  let text;
  try {
    text = readFileSync(f, "utf8");
  } catch {
    readFailures.push(relative(ROOT, f));
    continue;
  }
  if (looksMojibake(text)) mojibakeHits.push(relative(ROOT, f));
}

const ok = syntaxFailures.length === 0 && mojibakeHits.length === 0;
const noFilesScanned = codeFiles.length === 0;
const strictParse = typeof vm.SourceTextModule === "function";

const report = {
  root: ROOT,
  strictParse,
  scannedCodes: codeFiles.length,
  scannedTexts: textFiles.length,
  skipped: readFailures.length,
  syntaxFailures,
  mojibakeHits,
  readFailures,
  ok,
};

if (JSON_OUT) {
  process.stdout.write(JSON.stringify(report, null, 2) + "\n");
} else {
  console.log("=== 语法与编码闸门 ===");
  console.log(`  扫描根目录   : ${ROOT}`);
  console.log(`  代码文件     : ${codeFiles.length} 个`);
  console.log(`  文本文件     : ${textFiles.length} 个（乱码检查）`);
  console.log(`  解析方式     : ${strictParse ? "vm.SourceTextModule（严格 ESM 解析）" : "vm.Script + 配平（退化模式）"}`);
  console.log(`  读取失败跳过 : ${readFailures.length} 个`);
  console.log("");
  if (noFilesScanned) {
    console.log("  [FAIL] 没有扫描到任何代码文件 —— 判为「无法运行」，不是通过。");
  } else if (ok) {
    console.log(`  [OK]   ${codeFiles.length} 个代码文件全部解析通过`);
    console.log(`  [OK]   ${textFiles.length} 个文本文件未发现结构性乱码特征`);
  } else {
    for (const s of syntaxFailures) {
      console.log(`  [FAIL] 语法失败: ${s.file}`);
      for (const line of String(s.detail).split("\n").slice(0, 3)) console.log("         " + line);
    }
    for (const m of mojibakeHits) console.log(`  [FAIL] 疑似结构性乱码: ${m}`);
  }
  if (readFailures.length > 0) {
    console.log("");
    console.log(`  读取失败（计入 skipped，不中断扫描）: ${readFailures.slice(0, 8).join(", ")}`);
  }
}

if (noFilesScanned) process.exit(2);
if (!strictParse) {
  if (!JSON_OUT) {
    console.log("");
    console.log("  [FAIL] 没有 vm.SourceTextModule —— 无法做严格语法检查，判为「无法运行」。");
    console.log("         请带 --experimental-vm-modules 运行：");
    console.log("           node --experimental-vm-modules scripts/check-syntax.mjs");
    console.log("         退化到「括号配平」会误报正常文件，所以这里不给可信度不足的绿。");
  }
  process.exit(2);
}
process.exit(ok ? 0 : 1);
