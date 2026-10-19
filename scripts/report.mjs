#!/usr/bin/env node
/**
 * scripts/report.mjs —— 机器可读报告（走同一份口径：lib/ledger.js）
 * ---------------------------------------------------------------------------
 * 用法：
 *   node scripts/report.mjs                       # 完整汇总 JSON（--json 是默认行为，保留以便脚本化）
 *   node scripts/report.mjs --json                # 同上
 *   node scripts/report.mjs --md                  # 人类可读 Markdown
 *   node scripts/report.mjs --raw                 # 只输出账本汇总对象（不含 scan 明细）
 *   node scripts/report.mjs --days=7 --out=FILE
 *
 * 退出码：0 成功；2 参数错误。异常一律非 0 并把错误写到 stderr（不静默）。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLedger } from '../lib/ledger.js';
import { renderJson, renderReport, renderSegmentTable } from '../lib/report.js';

const USAGE = `用法：node scripts/report.mjs [--json|--md|--raw] [--days=N] [--home=DIR] [--sessions=DIR] [--data=DIR] [--usage-dir=DIR] [--out=FILE] [--pretty]

  --json    完整 JSON（默认）：{ok, generatedAt, summary, diagnostics, gaps, paths}
  --raw     只输出 summary 对象（HTTP GET /summary 的响应体）
  --md      人类可读 Markdown
  --days=N  统计窗口（1..365，默认 30）；--days=all = 全量口径（最早一条记录 ~ 今天）
  --data=DIR     账本数据目录（优先于 $DSH_WORKSPACE_FEE_DATA）
  --usage-dir=DIR 按日 JSONL 账单目录（优先于 $DSH_WORKSPACE_FEE_USAGE）
  --out=FILE 写文件（沙箱下推荐；同时打印到 stdout）
  --pretty  紧凑 JSON 之外的美化输出（默认已美化）`;

export function parseArgs(argv) {
  const out = { days: 30, mode: 'json' };
  for (const arg of argv) {
    const m = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!m) throw new Error(`未知参数：${arg}（用 --help 查看用法）`);
    const [, key, value] = m;
    if (key === 'json') out.mode = 'json';
    else if (key === 'raw') out.mode = 'raw';
    else if (key === 'md') out.mode = 'md';
    else if (key === 'segments') out.mode = 'segments';
    else if (key === 'pretty') out.pretty = true;
    else if (key === 'help') out.help = true;
    else if (key === 'days') out.days = /^all$/i.test(String(value ?? '').trim()) ? 'all' : Number.parseInt(value ?? '', 10);
    else if (key === 'home') out.home = value;
    else if (key === 'sessions') out.sessions = value;
    else if (key === 'data') out.data = value;
    else if (key === 'usage-dir') out.usageDir = value;
    else if (key === 'out') out.out = value;
    else throw new Error(`未知参数：--${key}`);
  }
  return out;
}

export function buildPayload(ledger, args) {
  const summary = ledger.summary({ days: args.days });
  if (args.mode === 'raw') return summary;
  if (args.mode === 'md') return renderReport({ summary, paths: ledger.paths });
  if (args.mode === 'segments') return renderSegmentTable(ledger);
  return {
    ok: true,
    generatedAt: summary.generatedAt,
    days: summary.days,
    paths: ledger.paths,
    summary,
    diagnostics: summary.diagnostics,
    gaps: summary.gaps,
    workspaces: summary.workspaces,
    daily: summary.daily,
  };
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  if (args.help) {
    console.log(USAGE);
    return 0;
  }
  if (args.days !== 'all' && (!Number.isInteger(args.days) || args.days < 1 || args.days > 365)) {
    console.error('--days 必须是 1..365 之间的整数，或 all（全量口径）');
    return 2;
  }
  const ledger = createLedger({ home: args.home, sessionsRoot: args.sessions, dataDir: args.data, usageDir: args.usageDir });
  const payload = buildPayload(ledger, args);
  const text = typeof payload === 'string' ? payload : renderJson(payload);
  process.stdout.write(`${text}\n`);
  if (args.out) {
    const outPath = resolve(args.out);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, `${text}\n`, 'utf8');
    process.stdout.write(`\n[report] 已写入 ${outPath}\n`);
  }
  return 0;
}

const isEntryPoint = process.argv[1] !== undefined && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isEntryPoint) process.exitCode = main();
