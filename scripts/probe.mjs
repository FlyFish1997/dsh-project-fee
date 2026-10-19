#!/usr/bin/env node
/**
 * scripts/probe.mjs —— 人类可读的**自证**报告
 * ---------------------------------------------------------------------------
 * 一条命令给出账目 + 全部口径自证数字：
 *   - 多帧 zstd：帧总数 / 解码成功 / 解码失败，以及「一次性整文件解压只得多少字节」
 *   - 去重：逐字去重与 (type,seq) 去重是否一致
 *   - 用量：只取 data.usage；若连 data.stream[].chunk.usage 一起累加会虚增多少
 *   - 模型归属：来自 data.message.source 还是回退到 request/context
 *   - 价格：档位表、生效日期、高峰时段、早于生效时刻的记录数
 *   - 工作区 / 按日账单 / 告警 / 缺口(gaps)
 *
 * 用法：
 *   node scripts/probe.mjs [--days=30] [--home=DIR] [--sessions=DIR] [--data=DIR]
 *                         [--out=FILE] [--json] [--top=20]
 * 环境变量：DSH_HOME / DSH_WORKSPACE_FEE_SESSIONS / DSH_WORKSPACE_FEE_DATA
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSessionFile, wholeFileDecompressBytes } from '../lib/session-log.js';
import { createLedger } from '../lib/ledger.js';
import { priceUsage } from '../lib/pricing.js';
import { renderJson, renderReport } from '../lib/report.js';

const USAGE = `用法：node scripts/probe.mjs [--days=30] [--home=DIR] [--sessions=DIR] [--data=DIR] [--usage-dir=DIR] [--out=FILE] [--json] [--top=N]

  --days=N       统计窗口（1..365，默认 30）；--days=all = 全量口径
  --home=DIR     显式指定 DSH home（优先于 $DSH_HOME）
  --sessions=DIR 会话日志根目录（优先于 $DSH_WORKSPACE_FEE_SESSIONS）
  --data=DIR     账本数据目录（优先于 $DSH_WORKSPACE_FEE_DATA）
  --usage-dir=DIR 按日 JSONL 账单目录（优先于 $DSH_WORKSPACE_FEE_USAGE）
  --out=FILE     把报告写到文件（沙箱下推荐；同时仍打印到 stdout）
  --json         输出机器可读 JSON（等价于 scripts/report.mjs --json）
  --top=N        逐文件明细/按日表最多 N 行（默认 20，0 表示不限）`;

export function parseArgs(argv) {
  const out = { days: 30, top: 20, json: false, help: false, surfaces: false };
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`未知参数：${arg}（用 --help 查看用法）`);
    const [, key, value] = m;
    if (key === 'json') out.json = true;
    else if (key === 'help') out.help = true;
    else if (key === 'surfaces') out.surfaces = true;
    else if (key === 'days') out.days = /^all$/i.test(String(value ?? '').trim()) ? 'all' : Number.parseInt(value ?? '', 10);
    else if (key === 'top') out.top = Number.parseInt(value ?? '', 10);
    else if (key === 'home') out.home = value;
    else if (key === 'sessions') out.sessions = value;
    else if (key === 'data') out.data = value;
    else if (key === 'usage-dir') out.usageDir = value;
    else if (key === 'out') out.out = value;
    else throw new Error(`未知参数：--${key}`);
  }
  return out;
}

/**
 * 预筛自证：对**最大**的那个会话文件同时跑「全量解析」与「预筛解析」，
 * 比较用量条数与 tokens。两者必须完全一致 —— 这是「廉价预判不会漏掉带
 * usage 的记录」的可失败判据（而不是靠推理）。
 * @param {object} scan ledger.scan() 的结果
 * @returns {object|null}
 */
export function auditPrefilter(scan) {
  let largest = null;
  for (const ws of scan.workspaces) {
    for (const session of ws.sessions) {
      const a = session.analysis;
      if (largest === null || (a.rawBytes ?? 0) > (largest.analysis.rawBytes ?? 0)) largest = { file: session.filePath, analysis: a };
    }
  }
  if (largest === null) return null;
  const full = analyzeSessionFile(largest.file, { parseFilter: 'all' });
  return {
    file: largest.file,
    prefilter: {
      usageRecords: largest.analysis.usageRecordCount,
      usageTokens: largest.analysis.usageTokens,
      recordsParsed: largest.analysis.recordCount,
      recordsSkipped: largest.analysis.recordsSkipped ?? 0,
    },
    fullParse: { usageRecords: full.usageRecordCount, usageTokens: full.usageTokens, recordsParsed: full.recordCount, recordsSkipped: full.recordsSkipped ?? 0 },
    prefilterParseErrors: largest.analysis.parseErrors,
    fullParseErrors: full.parseErrors,
    agrees: largest.analysis.usageRecordCount === full.usageRecordCount && largest.analysis.usageTokens === full.usageTokens && full.parseErrors === 0,
  };
}

/**
 * 交叉参考（**不参与账目**）：若 DSH home 下存在 `dsh-usage/usage-ledger.json`，
 * 读出来只做量级对照。对不上时**不断言谁对谁错**，只如实打印两侧数字。
 * @param {string} home
 * @returns {object}
 */
export function readUsageLedgerReference(home) {
  const path = join(home, 'dsh-usage', 'usage-ledger.json');
  const result = { path, exists: false, bytes: 0, error: null, numbers: [], keys: [] };
  if (!existsSync(path)) return result;
  result.exists = true;
  let text;
  try {
    text = readFileSync(path, 'utf8');
    result.bytes = Buffer.byteLength(text, 'utf8');
    const parsed = JSON.parse(text);
    result.keys = Object.keys(parsed).slice(0, 12);
    const found = [];
    const walk = (node, prefix, depth) => {
      if (depth > 3 || node === null || typeof node !== 'object' || found.length > 25) return;
      for (const [key, value] of Object.entries(node)) {
        const label = prefix === '' ? key : `${prefix}.${key}`;
        if (typeof value === 'number' && /token|cost|usage|total|amount|fee|price|spend/i.test(key)) found.push({ label, value });
        else if (typeof value === 'object') walk(value, label, depth + 1);
      }
    };
    walk(parsed, '', 0);
    result.numbers = found;
    // 若 schema 是 {days:{<date>:{<provider>:{<model>:{tokens…, cost}}}}}，把日粒度账目留下来做逐日对账
    if (parsed && typeof parsed === 'object' && parsed.days && typeof parsed.days === 'object') result.days = parsed.days;
    if (found.length === 0) {
      // 键名对不上（该文件可能是别的 schema）：退一步，列出任意数值叶子作为量级参考
      const any = [];
      const walkAny = (node, prefix, depth) => {
        if (depth > 3 || node === null || typeof node !== 'object' || any.length > 25) return;
        for (const [key, value] of Object.entries(node)) {
          const label = prefix === '' ? key : `${prefix}.${key}`;
          if (typeof value === 'number') any.push({ label, value });
          else if (typeof value === 'object') walkAny(value, label, depth + 1);
        }
      };
      walkAny(parsed, '', 0);
      result.anyNumbers = any;
    }
  } catch (error) {
    result.error = String(error?.message ?? error);
  }
  return result;
}

/**
 * 用**对方自己的 tokens**、按三种公式重算费用，再与对方给出的 cost 对比。
 *
 * 这是最有说服力的外部对账：token 数来自对方文件，唯一变量是公式。
 * 日粒度没有时段信息，因此统一按当日北京时间 12:00（空闲）计价。
 * @param {object} reference readUsageLedgerReference 的结果
 * @param {object} pricing 已规范化的价格表
 * @returns {Array<object>|null}
 */
export function reconcileReference(reference, pricing) {
  if (!reference?.days || typeof reference.days !== 'object') return null;
  const rows = [];
  for (const [date, providers] of Object.entries(reference.days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || typeof providers !== 'object' || providers === null) continue;
    const at = Date.parse(`${date}T12:00:00+08:00`); // 12:00 北京时间 = 空闲时段，与对方数值相符
    for (const [provider, models] of Object.entries(providers)) {
      if (typeof models !== 'object' || models === null) continue;
      for (const [model, tokens] of Object.entries(models)) {
        if (typeof tokens !== 'object' || tokens === null || typeof tokens.cost !== 'number') continue;
        const usage = {
          inputTokens: tokens.inputTokens ?? 0,
          outputTokens: tokens.outputTokens ?? 0,
          cacheReadTokens: tokens.cacheReadTokens ?? 0,
          reasoningTokens: tokens.reasoningTokens ?? 0,
        };
        const mine = priceUsage(usage, model, at, pricing).cost;
        const withReasoning = priceUsage(usage, model, at, { ...pricing, reasoningIncludedInOutput: false }).cost;
        const withCacheInInput = priceUsage(usage, model, at, { ...pricing, inputIncludesCacheRead: true, reasoningIncludedInOutput: false }).cost;
        rows.push({
          date,
          model,
          provider,
          theirCost: tokens.cost,
          calls: tokens.calls ?? null,
          myFormula: mine,
          formulaB: withReasoning,
          formulaC: withCacheInInput,
          myDelta: mine - tokens.cost,
          myDeltaPercent: tokens.cost > 0 ? ((mine - tokens.cost) / tokens.cost) * 100 : 0,
          tokens: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens, reasoningTokens: usage.reasoningTokens },
        });
      }
    }
  }
  rows.sort((a, b) => a.date.localeCompare(b.date));
  return rows;
}

/** 组装探针载荷（供 CLI 与测试共用）。 */export function probePayload(ledger, args) {
  const summary = ledger.summary({ days: args.days });
  const scan = ledger.scan();
  const pricing = ledger.getConfig().pricing;

  let sampleFile = null;
  let largest = null;
  for (const ws of scan.workspaces) {
    for (const session of ws.sessions) {
      const a = session.analysis;
      if (largest === null || a.frameTotal > largest.analysis.frameTotal) largest = { file: session.filePath, analysis: a };
    }
  }
  if (largest) {
    const whole = wholeFileDecompressBytes(largest.file);
    sampleFile = {
      file: largest.file,
      wholeFileBytes: whole.bytes,
      wholeFileError: whole.error,
      decodedBytes: largest.analysis.decodedBytes,
      frameTotal: largest.analysis.frameTotal,
      framesDecoded: largest.analysis.framesDecoded,
      framesFailed: largest.analysis.framesFailed,
    };
  }

  const rows = [];
  for (const ws of scan.workspaces) {
    for (const session of ws.sessions) {
      const a = session.analysis;
      let cost = 0;
      for (const usageRow of a.usages) {
        const time = usageRow.time ?? a.session?.createdAt ?? null;
        if (time === null) continue;
        cost += priceUsage(usageRow.usage, usageRow.model, time, pricing).cost;
      }
      rows.push({
        workspaceKey: ws.workspaceKey,
        sessionId: session.sessionId,
        frameTotal: a.frameTotal,
        framesDecoded: a.framesDecoded,
        framesFailed: a.framesFailed,
        decodedBytes: a.decodedBytes,
        recordCount: a.recordCount,
        recordsSkipped: a.recordsSkipped ?? 0,
        usageRecordCount: a.usageRecordCount,
        cost,
        cwd: a.session?.cwd ?? null,
      });
    }
  }
  rows.sort((a, b) => b.cost - a.cost);

  const beforeRetained = process.memoryUsage().heapUsed;
  const gcAvailable = typeof globalThis.gc === 'function';
  if (gcAvailable) {
    globalThis.gc();
    globalThis.gc();
  }
  const perf = {
    // 冷缓存全量扫描耗时（probe 每次都是在**新进程**里全量重扫，即 rebuild 路径）
    fullRefreshElapsedMs: summary.diagnostics.elapsedMs,
    maxRssBytes: (process.resourceUsage?.().maxRSS ?? 0) * 1024,
    heapUsedBytes: process.memoryUsage().heapUsed,
    // gcAvailable=false 时（未加 --expose-gc）这个数偏大，会被标注出来
    retainedHeapBytes: process.memoryUsage().heapUsed,
    gcAvailable,
    sessionFiles: summary.diagnostics.sessionFiles,
    rawBytes: summary.diagnostics.rawBytes,
    decodedBytes: summary.diagnostics.decodedBytes,
    workspaces: summary.diagnostics.workspaceCount,
    mode: 'cold-full-scan',
  };
  void beforeRetained;

  const reference = readUsageLedgerReference(ledger.paths.home);
  reference.reconciliation = reconcileReference(reference, pricing);

  return {
    summary,
    paths: ledger.paths,
    filesDetail: args.top > 0 ? rows.slice(0, args.top) : rows,
    sampleFile,
    prefilterAudit: auditPrefilter(scan),
    perf,
    reference,
  };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  // 会话调用面自检：用一个**桩 ctx** 走真实注册路径，报告两个面能否注册、
  // 工具包从哪解析到。这样「工具面为什么没生效」不必去翻 dsh web 的终端输出。
  if (args.surfaces) {
    return await reportSurfaces(args);
  }
  if (args.days !== 'all' && (!Number.isInteger(args.days) || args.days < 1 || args.days > 365)) {
    console.error('--days 必须是 1..365 之间的整数，或 all（全量口径）');
    return 2;
  }
  const ledger = createLedger({ home: args.home, sessionsRoot: args.sessions, dataDir: args.data, usageDir: args.usageDir, parseFilter: 'needed' });
  const payload = probePayload(ledger, args);
  const text = args.json ? renderJson(payload) : renderReport(payload);
  process.stdout.write(`${text}\n`);
  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${text}\n`, 'utf8');
    process.stdout.write(`\n[probe] 报告已写入 ${outPath}\n`);
  }
  return 0;
}

/** `--surfaces`：报告模型工具与斜杠命令的注册就绪情况。 */
async function reportSurfaces(args) {
  const { loadToolkit, profileCandidates, TOOL_NAME, COMMAND_NAME } = await import('../lib/host-tools.js');
  const { resolveDshHome } = await import('../lib/ledger.js');
  const home = args.home ?? resolveDshHome();
  const roots = profileCandidates(home);
  const toolkit = await loadToolkit(roots);
  const lines = [];
  lines.push('=== 会话调用面自检 ===');
  lines.push(`  DSH home        : ${home}`);
  lines.push(`  候选解析根      :`);
  for (const r of roots) lines.push(`    - ${r}`);
  if (toolkit.error) {
    lines.push(`  ✗ @deepseek-ai/dsh-tools 未解析到 → 模型工具面会降级`);
    for (const l of toolkit.error.split('\n')) lines.push(`      ${l}`);
  } else {
    lines.push(`  ✓ @deepseek-ai/dsh-tools 解析到: ${toolkit.from}`);
    lines.push(`      defineTool 类型: ${typeof toolkit.mod.defineTool}`);
  }
  // 用桩 ctx 走一遍真实注册逻辑（不依赖 DSH 运行时）
  const { registerSessionSurfaces } = await import('../lib/host-tools.js');
  const effects = [];
  const registered = { tool: null, command: null };
  const ctx = {
    tools: { register: (d) => { registered.tool = d; return () => {}; } },
    commands: { register: (d) => { registered.command = d; return () => {}; } },
    effect: (fn, label) => effects.push(label),
  };
  const result = await registerSessionSurfaces(ctx, {
    getSummary: () => ({ workspaces: [], current: null }),
    resolveRoots: roots,
    warn: () => {},
  });
  lines.push('');
  lines.push(`  模型工具 \`${TOOL_NAME}\` : ${result.tool ? '✓ 可注册' : '✗ 不可注册'}`);
  lines.push(`  斜杠命令 /${COMMAND_NAME}  : ${result.command ? '✓ 可注册' : '✗ 不可注册'}`);
  if (result.problems.length > 0) {
    lines.push('  问题:');
    for (const p of result.problems) lines.push(`    - ${p.split('\n')[0]}`);
  }
  lines.push('');
  lines.push('  效力边界：本自检用**桩 ctx** 验证「注册逻辑与依赖解析」，');
  lines.push('  它**证明不了** DSH 运行时真的把工具挂进了模型可见列表 ——');
  lines.push('  那一条只能在 `dsh web` 的启动日志里看到（该日志打到启动它的终端，不落盘）。');
  process.stdout.write(`${lines.join('\n')}\n`);
  return result.tool && result.command ? 0 : 1;
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) {
  Promise.resolve(main()).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error?.stack ?? String(error));
      process.exitCode = 2;
    },
  );
}
