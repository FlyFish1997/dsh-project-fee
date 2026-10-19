/**
 * 报告渲染（report）
 * ---------------------------------------------------------------------------
 * 纯格式化：把 ledger 的汇总对象渲染成人类可读文本 / Markdown / JSON 文本。
 * 不含 I/O；写文件由 scripts/*.mjs 负责（沙箱下脚本必须写文件再由人读）。
 */
import { beijingDateTime } from './time.js';
import { coverageHoles } from './pricing.js';

/** 金额展示：小额多留小数，避免四舍五入成 0.00。 */
export function formatCost(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 'n/a';
  if (n === 0) return '0';
  if (Math.abs(n) < 0.0001) return n.toExponential(3);
  return n.toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

/** token 数展示：每三位加分隔。 */
export function formatTokens(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 'n/a';
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function tokensBrief(tokens) {
  return `in ${formatTokens(tokens?.inputTokens)} / out ${formatTokens(tokens?.outputTokens)} / cacheRead ${formatTokens(tokens?.cacheReadTokens)} / reasoning ${formatTokens(tokens?.reasoningTokens)} / total ${formatTokens(tokens?.totalTokens)}`;
}

function timeCell(epochMs) {
  return typeof epochMs === 'number' ? beijingDateTime(epochMs) : '-';
}

/** 工作区账目表（Markdown）。 */
export function renderWorkspaceTable(summary) {
  const rows = [
    '| 工作区 | 标签 | cwd | 会话 | 窗口内 tokens | 窗口内费用(元) | 今日费用(元) | 预警线 | 级别 |',
    '|---|---|---|---:|---:|---:|---:|---:|---|',
  ];
  for (const ws of summary.workspaces) {
    rows.push(
      `| \`${ws.key}\` | ${ws.label} | \`${ws.cwd ?? '-'}\` | ${ws.sessions} | ${formatTokens(ws.tokens.totalTokens)} | ${formatCost(ws.cost)} | ${formatCost(ws.todayCost)} | ${ws.alert.limit === null ? '-' : formatCost(ws.alert.limit)} | ${ws.alert.level} |`,
    );
  }
  return rows.join('\n');
}

/** 按日账单表（Markdown，仅窗口内有数据的日期）。 */
export function renderDailyTable(summary, limit = 60) {
  const rows = ['| 日期(北京) | 工作区 | 费用(元) | total tokens | cacheRead | output |', '|---|---|---:|---:|---:|---:|'];
  for (const row of summary.daily.slice(0, limit)) {
    rows.push(`| ${row.date} | \`${row.workspaceKey}\` | ${formatCost(row.cost)} | ${formatTokens(row.tokens.totalTokens)} | ${formatTokens(row.tokens.cacheReadTokens)} | ${formatTokens(row.tokens.outputTokens)} |`);
  }
  if (summary.daily.length > limit) rows.push(`| … | 其余 ${summary.daily.length - limit} 行省略 | | | | |`);
  return rows.join('\n');
}

/** 价格表（Markdown）。 */
export function renderPricingTable(summary) {
  const rows = ['| 档位 | 缓存命中(空闲) | 缓存未命中(空闲) | 输出(空闲) | 缓存命中(高峰) | 缓存未命中(高峰) | 输出(高峰) |', '|---|---:|---:|---:|---:|---:|---:|'];
  for (const row of summary.pricing.tiers) {
    rows.push(`| ${row.tier} | ${row.cacheRead} | ${row.cacheMiss} | ${row.output} | ${row.peakCacheRead} | ${row.peakCacheMiss} | ${row.peakOutput} |`);
  }
  return rows.join('\n');
}

/** 缺口清单（Markdown）。 */
export function renderGaps(gaps, limit = 40) {
  if (gaps.length === 0) return '_无缺口（全部会话日志均可解码）_';
  const rows = ['| # | kind | path | detail |', '|---:|---|---|---|'];
  gaps.slice(0, limit).forEach((gap, index) => {
    rows.push(`| ${index + 1} | ${gap.kind} | \`${gap.path ?? '-'}\` | ${String(gap.detail ?? '').replace(/\|/g, '\\|')} |`);
  });
  if (gaps.length > limit) rows.push(`| … | 其余 ${gaps.length - limit} 条省略 | | |`);
  return rows.join('\n');
}

/**
 * 完整的人类可读报告（Markdown）。selfProof 段落是「口径可被反证」的载体：
 * 帧统计、去重统计、双计虚增、模型归属来源都必须出现。
 * @param {{summary:object, paths:object, filesDetail?:object[], sampleFile?:object}} input
 * @returns {string}
 */
export function renderReport(input) {
  const { summary, paths } = input;
  const d = summary.diagnostics;
  const lines = [];
  lines.push('# dsh-workspace-fee 宿主侧报告');
  lines.push('');
  lines.push(`- 生成时间：${summary.generatedAt}`);
  lines.push(`- 数据目录（DSH home）：\`${paths.home}\``);
  lines.push(`- 会话日志根目录：\`${paths.sessionsRoot}\``);
  lines.push(`- 账本数据目录：\`${paths.dataDir}\``);
  lines.push(`- 按日 JSONL 账单目录：\`${paths.usageDir}\`（写入 ${d.usageBill?.filesWritten ?? 0} 个文件 / ${d.usageBill?.lines ?? 0} 行${d.usageBill?.error ? `；**失败：${d.usageBill.error}**` : ''}）`);  lines.push(`- 统计口径：${summary.days === 'all' ? '**全量**（最早一条记录 ~ 今天）' : `近 ${summary.days} 天`}；窗口 ${summary.window.from} ~ ${summary.window.to}（北京时间 UTC+8）`);
  lines.push(`- 扫描耗时：${d.elapsedMs} ms；工作区 ${d.workspaceCount} 个；会话文件 ${d.sessionFiles} 个（本次新解 ${d.sessionsAnalyzed}，缓存命中 ${d.filesFromCache}）`);
  lines.push('');

  lines.push('## 1. 解码自证（多帧 zstd）');
  lines.push('');
  lines.push(`- 帧总数 / 解码成功 / 解码失败：**${d.frameTotal} / ${d.framesDecoded} / ${d.framesFailed}**`);
  lines.push(`- 原始字节：${formatTokens(d.rawBytes)}；逐帧拼接解压后：${formatTokens(d.decodedBytes)} 字节`);
  if (input.sampleFile) {
    const s = input.sampleFile;
    lines.push(`- 抽样文件 \`${s.file}\`：一次性整文件解压只得 **${formatTokens(s.wholeFileBytes)}** 字节（第一帧），逐帧拼接后 ${formatTokens(s.decodedBytes)} 字节 → 相差 ${s.wholeFileBytes > 0 ? (s.decodedBytes / s.wholeFileBytes).toFixed(1) : 'n/a'} 倍`);
  }
  lines.push(`- JSONL 解析失败行：${d.parseErrors}（涉及文件 ${d.jsonlParseFailedFiles} 个）`);
  lines.push('');

  lines.push('## 2. 去重自证（两种去重法必须一致）');
  lines.push('');
  lines.push(`- 非空行数：${formatTokens(d.records)}；逐字去重后唯一行数：${formatTokens(d.records - d.exactDuplicateLines)}（逐字重复 ${d.exactDuplicateLines} 行）`);
  lines.push(`- 按 (type,seq) 去重丢弃：${d.typeSeqDuplicates} 条`);
  lines.push(`- 两种去重法结果不一致的文件数：**${d.dedupeDisagreements}**（0 表示一致）`);
  lines.push('');

  lines.push('## 3. 用量口径自证');
  lines.push('');
  lines.push(`- 计入账目的用量记录：**${formatTokens(d.usageRecords)}** 条，来源 type 分布：${JSON.stringify(d.usageTypeBreakdown)}`);
  lines.push(`- \`data.usage.totalTokens\` 合计：${formatTokens(d.usageTokens)}`);
  lines.push(`- 若同时累加 \`data.stream[].chunk.usage\`：再 ${formatTokens(d.streamUsageTokens)}（+${d.doubleCountInflationPercent}%）→ 账单翻倍。**本插件只取 data.usage**。`);
  lines.push(`- 计费桶：\`cacheRead×hit + input×miss + output×out\`（reasoning **已含在 output 内，不再相加**；契约修订 v1.1，依据见 docs/SPEC.md §4.1）`);
  lines.push(`- 若按旧口径把 reasoning 再加一遍：+${formatCost(d.costIfReasoningAddedDelta)} 元（+${d.costIfReasoningAddedPercent}%，reasoning 合计 ${formatTokens(d.reasoningTokensTotal)} tokens）→ **这是实测的虚增幅度**`);
  const r = d.bucketRefutation;
  if (r) {
    lines.push('');
    lines.push('### 计费桶正确性的**可反证**数字（同一份数据、三种口径）');
    lines.push('');
    lines.push('| 口径 | 总费用（当前货币） | 相对正确口径 |');
    lines.push('|---|---:|---:|');
    lines.push(`| ✅ **正确口径**（本插件默认）\`(cacheRead×hit + input×miss + output×out)/1e6\` | **${formatCost(summary.totals.cost)}** | — |`);
    lines.push(`| ❌ 错误口径①：**input 全额按 miss + 再加 reasoning** \`…+ (output+reasoning)×out\` | ${formatCost(d.costIfReasoningAdded)} | **+${d.costIfReasoningAddedPercent}%** |`);
    lines.push(`| ❌ 错误口径②：**input 当含 cacheRead**（未命中桶夹到 ≥0）+ 再加 reasoning \`…+ max(0,input−cacheRead)×miss + (output+reasoning)×out\` | ${formatCost(r.costIfInputIncludesCacheRead)} | **+${r.costIfInputIncludesCacheReadPercent}%** |`);
    lines.push('');
    lines.push(`**正确 ${formatCost(summary.totals.cost)} 元 vs 错误①（input 全额 miss 且再加 reasoning）${formatCost(d.costIfReasoningAdded)} 元 → 偏差 +${d.costIfReasoningAddedPercent}%**`);
    lines.push('');
    lines.push(`判别性证据：\`inputTokens >= cacheReadTokens\` 的记录 **${formatTokens(r.inputGeCacheRecords)}**/${formatTokens(r.inputGeCacheRecords + r.inputLtCacheRecords)}，`
      + `\`inputTokens < cacheReadTokens\` 的 **${formatTokens(r.inputLtCacheRecords)}** 条（**${r.inputLtCachePercent}%**）。`);
    lines.push(`Σ inputTokens = ${formatTokens(r.sumInputTokens)}，Σ cacheReadTokens = ${formatTokens(r.sumCacheReadTokens)}`
      + `（**Σ input 只有 Σ cacheRead 的 ${r.sumCacheReadTokens > 0 ? ((r.sumInputTokens / r.sumCacheReadTokens) * 100).toFixed(2) : 'n/a'}%**）。`);
    lines.push('→ 若 `inputTokens` 是「含 cacheRead 的完整 prompt」，则 `input >= cacheRead` 必须**恒成立**；实测绝大多数相反。');
    lines.push(`按错误口径② 的夹 0 规则，未命中桶被清零的记录 **${formatTokens(r.missBucketZeroedRecords)}** 条（**${r.missBucketZeroedPercent}%**）：`
      + `未命中分项从 ${formatCost(r.missPartDisjoint)} 元缩到 ${formatCost(r.missPartInclusive)} 元。`);
    lines.push('（注：`totalTokens == input + output + cacheRead` 对两种假设**都成立**，因此它不是判别性证据 —— 宿主 `totalTokens = prompt_tokens + completion_tokens`。）');
  }
  lines.push(`- 模型归属来源：\`data.message.source\` ${formatTokens(d.modelFromSourceCount)} 条；回退到最近的 request/context|request/header ${formatTokens(d.modelFromFallbackCount)} 条；完全未知 ${formatTokens(d.unknownModelCount)} 条`);
  lines.push('');

  lines.push('## 4. 价格口径');
  lines.push('');
  lines.push(`- 价格表来源：默认表 + 覆盖层；当前生效层：pricing=${d.configSource.pricing} / alerts=${d.configSource.alerts}${d.configSource.settingsAvailable ? '（settings 服务可用）' : '（settings 服务不可用）'}`);
  lines.push(`- 价格生效日期（元数据）：${summary.pricing.effectiveFrom}；币种：${summary.pricing.currency}；高峰倍率：×${summary.pricing.peakMultiplier}`);
  lines.push(`- 高峰时段（北京时间）：${summary.pricing.peakWindows.join('、')}；其余时段（含周末全天）为空闲`);
  lines.push(`- 早于价格生效时刻的记录：${d.beforeEffectiveFromCount} 条，费用 ${formatCost(d.beforeEffectiveFromCost)} 元（**仍按当前表计价**，口径限制，见 README.md）`);
  if (d.configProblems.length > 0) lines.push(`- 配置告警：${d.configProblems.join('; ')}`);
  lines.push('');
  lines.push(renderPricingTable(summary));
  lines.push('');

  lines.push('## 5. 汇总');
  lines.push('');
  lines.push(`- 窗口内合计：**${formatCost(summary.totals.cost)} 元**，${formatTokens(summary.totals.tokens.totalTokens)} tokens（${tokensBrief(summary.totals.tokens)}）`);
  lines.push(`- 其中空闲价等效 ${formatCost(summary.totals.idleCost)} 元，高峰加价 ${formatCost(summary.totals.peakSurcharge)} 元`);
  lines.push(`- 高峰 tokens ${formatTokens(summary.peakSplit.peak.tokens)}（${formatCost(summary.peakSplit.peak.cost)} 元）/ 空闲 tokens ${formatTokens(summary.peakSplit.idle.tokens)}（${formatCost(summary.peakSplit.idle.cost)} 元）`);
  lines.push(`- 今日（${summary.today.date}）：${formatCost(summary.today.cost)} 元 / ${formatTokens(summary.today.tokens.totalTokens)} tokens`);
  lines.push(`- 预警：over ${summary.alerts.over} 个 / warn ${summary.alerts.warn} 个 / ok ${summary.alerts.ok} 个（已配置预警线 ${summary.alerts.configured} 个）`);
  lines.push('');
  lines.push('### 工作区');
  lines.push('');
  lines.push(renderWorkspaceTable(summary));
  lines.push('');

  if (summary.models.length > 0) {
    lines.push('### 模型分布');
    lines.push('');
    lines.push('| provider | model | 档位 | 已知档位 | 费用(元) | total tokens |');
    lines.push('|---|---|---|---|---:|---:|');
    for (const m of summary.models) {
      lines.push(`| ${m.provider ?? '-'} | ${m.model ?? '-'} | ${m.tierName} | ${m.known ? 'yes' : 'no (fallback)'} | ${formatCost(m.cost)} | ${formatTokens(m.tokens.totalTokens)} |`);
    }
    lines.push('');
  }

  lines.push('### 按日账单');
  lines.push('');
  lines.push(renderDailyTable(summary));
  lines.push('');

  lines.push('## 6. 缺口（gaps）');
  lines.push('');
  lines.push(`共 ${summary.gaps.length} 条。这些是**处理不到的输入**，不是「零消耗」。`);
  lines.push('');
  lines.push(renderGaps(summary.gaps));
  lines.push('');

  if (Array.isArray(input.filesDetail) && input.filesDetail.length > 0) {
    lines.push('## 7. 逐文件明细');
    lines.push('');
    lines.push('| 工作区 | 会话 | 帧(总/成功/失败) | 逐帧解压字节 | 记录 | 用量 | 费用(元) | cwd(日志) |');
    lines.push('|---|---|---|---:|---:|---:|---:|---|');
    for (const row of input.filesDetail) {
      lines.push(`| \`${row.workspaceKey}\` | ${row.sessionId} | ${row.frameTotal}/${row.framesDecoded}/${row.framesFailed} | ${formatTokens(row.decodedBytes)} | ${row.recordCount} | ${row.usageRecordCount} | ${formatCost(row.cost)} | \`${row.cwd ?? '-'}\` |`);
    }
    lines.push('');
  }
  if (input.perf) {
    const p = input.perf;
    lines.push('## 8. 性能与预筛自证');
    lines.push('');
    lines.push(`- **冷缓存全量刷新耗时：${p.fullRefreshElapsedMs} ms**（${p.mode}：${p.sessionFiles} 个文件 / ${formatTokens(p.rawBytes)} 原始字节 / ${formatTokens(p.decodedBytes)} 解压字节 / ${p.workspaces} 个工作区）`);
    lines.push(`- 进程峰值 RSS：**${(p.maxRssBytes / 1024 / 1024).toFixed(1)} MiB**（含 V8 尚未回收的临时对象）；扫描结束时 heapUsed ${(p.heapUsedBytes / 1024 / 1024).toFixed(1)} MiB`);
    lines.push(`- **GC 后存活堆**：${p.gcAvailable ? `**${(p.retainedHeapBytes / 1024 / 1024).toFixed(1)} MiB**（已显式 gc 两次，代表真正驻留的账目对象）` : '未测量（要拿到这个数请用 `node --expose-gc scripts/probe.mjs`）'}`);
    lines.push(`- 逐文件处理 + 单遍归集：解码文本与记录对象只活在单文件调用内，` + '`analyzeSessionFile` 每解析一行就喂进增量归集器（`createUsageFolder`），**不保留记录数组**，只带出小对象（每条用量 7 字段）；增量路径按 (mtime + size) 跳过未变文件（本次为 rebuild 路径，故全部重解）');
    if (d.parseFilter !== undefined) {
      lines.push(`- 解析预筛（parseFilter=${d.parseFilter}）：只 JSON.parse 含 \`${'{'}"usage"/"model"/"cwd"{'}'}\` 子串的行，全库解析 ${formatTokens(d.records)} 行 / 跳过 ${formatTokens(d.recordsSkipped)} 行`);
    }
    const audit = input.prefilterAudit;
    if (audit) {
      const ok = audit.agrees ? '**一致（未漏）**' : '**不一致（口径缺陷）**';
      lines.push('');
      lines.push(`### 预筛不会漏掉带 usage 的记录（抽样 ${'`'}${audit.file}${'`'}）`);
      lines.push('');
      lines.push(`| 解析方式 | 解析记录 | 跳过记录 | usage 条数 | usage tokens | 解析失败 |`);
      lines.push('|---|---:|---:|---:|---:|---:|');
      lines.push(`| 预筛（needed，默认） | ${formatTokens(audit.prefilter.recordsParsed)} | ${formatTokens(audit.prefilter.recordsSkipped)} | ${formatTokens(audit.prefilter.usageRecords)} | ${formatTokens(audit.prefilter.usageTokens)} | ${audit.prefilterParseErrors} |`);
      lines.push(`| 全量（all，审计） | ${formatTokens(audit.fullParse.recordsParsed)} | ${formatTokens(audit.fullParse.recordsSkipped)} | ${formatTokens(audit.fullParse.usageRecords)} | ${formatTokens(audit.fullParse.usageTokens)} | ${audit.fullParseErrors} |`);
      lines.push('');
      lines.push(`判定：${ok}（全量解析无失败、usage 条数与 tokens 完全相同）`);
    }
    lines.push('');
  }

  if (input.reference) {
    const ref = input.reference;
    lines.push('## 9. 交叉参考（**不参与账目**）');
    lines.push('');
    lines.push(`- \`${ref.path}\`：${ref.exists ? `存在，${formatTokens(ref.bytes)} 字节，顶层键 ${JSON.stringify(ref.keys)}` : '不存在'}`);
    if (ref.exists && !ref.error && ref.numbers.length > 0) {
      lines.push(`- 该文件里出现的量级数字（前 25 个，仅对照）：`);
      for (const item of ref.numbers.slice(0, 25)) lines.push(`  - \`${item.label}\` = ${item.value}`);
      lines.push(`- 本插件同一份数据的合计：tokens ${formatTokens(summary.totals.tokens.totalTokens)}，费用 ${formatCost(summary.totals.cost)} ${summary.pricing.currency}`);
      lines.push('- **对不上时不断言谁对谁错**：两者口径、时间窗、数据源都可能不同，这里只并排列出。');
    } else if (ref.exists && !ref.error && Array.isArray(ref.anyNumbers) && ref.anyNumbers.length > 0) {
      lines.push('- 键名对不上账目字段，列出其中任意数值叶子作为量级参考（前 20 个）：');
      for (const item of ref.anyNumbers.slice(0, 20)) lines.push(`  - \`${item.label}\` = ${item.value}`);
      lines.push(`- 本插件同一份数据的合计（**只是并列，不作断言**）：tokens ${formatTokens(summary.totals.tokens.totalTokens)}，费用 ${formatCost(summary.totals.cost)} ${summary.pricing.currency}`);
    } else if (ref.error) {
      lines.push(`- 读取失败：${ref.error}`);
    }
    if (Array.isArray(ref.reconciliation) && ref.reconciliation.length > 0) {
      lines.push('');
      lines.push('### 用**对方自己的 tokens** 重算三种公式 vs 对方给出的 cost');
      lines.push('');
      lines.push('（日粒度无时段信息，统一按当日北京时间 12:00 = 空闲价重算；token 数取自对方文件，唯一变量是公式）');
      lines.push('');
      lines.push('| 日期 | 模型 | 对方 cost | 本插件公式 | B: +reasoning | C: input 含 cache | 本插件相对差 |');
      lines.push('|---|---|---:|---:|---:|---:|---:|');
      for (const row of ref.reconciliation) {
        lines.push(`| ${row.date} | ${row.model} | ${formatCost(row.theirCost)} | ${formatCost(row.myFormula)} | ${formatCost(row.formulaB)} | ${formatCost(row.formulaC)} | ${row.myDeltaPercent.toFixed(4)}% |`);
      }
      const worst = ref.reconciliation.reduce((acc, row) => Math.max(acc, Math.abs(row.myDeltaPercent)), 0);
      lines.push('');
      lines.push(`- **最大相对偏差 ${worst.toFixed(4)}%**：本插件公式与对方的日费用逐日吻合；B（再加 reasoning）与 C（input 含 cache）都明显偏离对方数值。`);
      lines.push('- 这**支持**「input 即未命中桶、reasoning 不另加」，但仍**不作谁对谁错的断言**：对方可能按逐调用时段计价、时间窗或币种也可能不同。');
    }
    lines.push('');
  }

  lines.push('---');
  lines.push('');
  lines.push('口径与接口契约见 `docs/SPEC.md`；环境约束见 `README.md`。');
  return lines.join('\n');
}

/** 机器可读 JSON 文本（缩进 2）。 */
export function renderJson(value) {
  return JSON.stringify(value, null, 2);
}

const WEEKDAY_LABELS = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

/** `1,2,3,4,5` → `Mon-Fri(1-5)`；`1..7` → `ALL(1-7)`。 */
export function formatDays(days) {
  const list = Array.isArray(days) && days.length > 0 ? [...days].sort((a, b) => a - b) : [1, 2, 3, 4, 5, 6, 7];
  if (list.length === 7) return 'ALL(1-7)';
  if (list.length === 5 && list.every((d) => d <= 5)) return 'Mon-Fri(1-5)';
  if (list.length === 2 && list[0] === 6 && list[1] === 7) return 'Sat-Sun(6-7)';
  return `${list.map((d) => WEEKDAY_LABELS[d] ?? d).join(',')}(${list.join('-')})`;
}

/**
 * 独立核对单价的**单条命令**所需输出：当前生效版本 + 每个段的 days/from/to/绝对值单价。
 *
 * 这是验证者按段核对单价的前提：运行时**只读** segment 的 `hit/miss/out` 绝对值，
 * `peakMultiplier` 不参与计费（仅用于生成内置默认版本的段、以及渲染便捷视图）。
 * @param {object} ledger
 * @returns {string}
 */
export function renderSegmentTable(ledger) {
  const view = ledger.pricingView();
  const lines = ['# 生效定价（按段核对单价）', ''];
  lines.push(`- 币种：**${view.currency}**（多币种费率见 \`/config → pricing.rates\`）`);
  lines.push(`- 当前生效版本：**${view.activeVersionId}**`);
  lines.push(`- 价格表来源层：${view.source.pricing}${view.source.settingsAvailable ? '（settings 服务可用）' : ''}`);
  lines.push(`- **运行时权威定价 = 下面的段绝对值** \`hit/miss/out\`；\`peakMultiplier\` 不参与计费（仅用于生成内置默认版本的段）。`);
  lines.push('');
  for (const version of view.versions) {
    const flag = version.id === view.activeVersionId ? ' ← **当前生效**' : '';
    lines.push(`## 版本 \`${version.id}\`${flag}`);
    lines.push('');
    lines.push(`- effectiveFrom：${version.effectiveFrom}（北京时间 ${beijingDateTime(version.effectiveFrom)}，已归一到分钟）`);
    lines.push(`- 备注：${version.note || '（无）'}${version.builtin ? '　*内置默认版本（由 rates + peakMultiplier + peakWindows 构造，构造后即固定为绝对值）*' : ''}`);
    for (const [family, entry] of Object.entries(version.models ?? {})) {
      lines.push('');
      lines.push(`档位 \`${family}\`：`);
      lines.push('');
      lines.push('| # | segment id | label | days | from | to | hit | miss | out |');
      lines.push('|---:|---|---|---|---|---|---:|---:|---:|');
      (entry.segments ?? []).forEach((segment, index) => {
        lines.push(`| ${index + 1} | \`${segment.id}\` | ${segment.label ?? ''} | ${formatDays(segment.days)} | ${segment.from} | ${segment.to} | ${segment.hit} | ${segment.miss} | ${segment.out} |`);
      });
      const holes = coverageHoles(entry.models ? entry.models : { [family]: entry });
      lines.push('');
      lines.push(`- 该档位 24/7 覆盖：${holes.length === 0 ? '**无洞**' : `**有洞**（${holes.map((h) => `${h.missingMinutes}/${h.totalMinutes} 分钟`).join('、')}）`}`);
    }
    lines.push('');
  }
  lines.push(`- 未计价记录（\`unpricedUsageRecords\`）：**${view.unpricedUsageRecords}**（>0 表示有记录落在某版本的未覆盖时段，已列入 \`gaps[]\`）`);
  lines.push(`- 匹配语义：` + '`days` 1=周一…7=周日（空/缺省=全七天）；区间**左闭右开**；`to<=from` 为**跨夜**；**多段命中取声明顺序第一条**；版本取 `toMinute(effectiveFrom) <= toMinute(记录时刻)` 的最新一个；**未命中任何段即未计价，不回退更早版本**');
  return lines.join('\n');
}
