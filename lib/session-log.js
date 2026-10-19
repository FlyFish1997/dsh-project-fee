/**
 * 会话日志解码与用量提取（session-log）
 * ---------------------------------------------------------------------------
 * 事实（实测与宿主源码核对）：
 *   1. 文件 `<DSH_HOME>/sessions/<编码工作目录>/<会话id>/session[.v<N>].jsonl.zstd`
 *      是**多帧 zstd 拼接流**，对整文件一次性解压只会得到第一帧（会话头）。
 *      必须扫描魔数 `28 B5 2F FD` 逐帧解压再拼接。
 *      **文件名带会话格式版本号，DSH 升级会换名**（实测
 *      `session.jsonl.zstd` → `session.v3.jsonl.zstd` → `session.v4.jsonl.zstd`），
 *      所以不能硬编码单个版本名（硬编码 v3 的症状：升级后新会话一条都读不到，
 *      今日花费恒为 0）。枚举与选版本见 `pickSessionLogFile()`。
 *   2. 解压后是 JSONL，每行一条记录，含 `type`/`seq`/`time`(epoch ms)/`data`。
 *   3. 用量只出现在 `assistant/message` 的 `data.usage`；同一条用量还会在
 *      `data.stream[].chunk.usage` 里再写一遍（实测 100% 重复）。
 *   4. 模型路由：`data.message.source.{provider,model}`（首选），
 *      `request/context.data.{provider,model}` 与
 *      `request/header.data.header.config.{provider,model}`（回退）。
 *   5. `type:"session"` 记录（无 seq/time/data）顶层带 `cwd`/`createdAt`，
 *      比解码目录名更可靠。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** zstd 帧魔数。 */
export const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/**
 * 会话日志**文件名模式**：`session.jsonl.zstd`（无版本段）或 `session.v<N>.jsonl.zstd`。
 *
 * 事实（实测）：DSH 会随会话格式版本升级**改文件名**；同一个 `sessions` 根下
 * 可以同时存在无版本段、v3、v4 三种文件。只认某一个版本名，升级后新增的会话
 * 就整段读不到（症状：今日花费恒为 0）。
 */
export const SESSION_LOG_FILE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/**
 * 文件名 → 会话格式版本号：`session.v4.jsonl.zstd` → 4；
 * 无版本段的 `session.jsonl.zstd` → 0（v1/v2 老格式）；不是会话日志 → null。
 * @param {string} fileName
 * @returns {number|null}
 */
export function sessionLogVersion(fileName) {
  const m = SESSION_LOG_FILE_RE.exec(typeof fileName === 'string' ? fileName : '');
  if (m === null) return null;
  return m[1] === undefined ? 0 : Number(m[1]);
}

/**
 * 在一个会话目录里挑选要读的日志文件，并给出被忽略的旧版本文件。
 *
 * **每个会话目录只取版本号最大的那一个文件**。理由（实测，同一会话目录同时
 * 存在 v3/v4）：v4 是**整篇重写**，不是增量——v3 的记录被 v4 完整覆盖
 * （记录条数与时间区间一致，或 v3 记录是 v4 的子集）。
 * 两个文件都读会把重叠记录算两遍：`(type,seq)` 去重只在**单个文件内**做
 * （`analyzeSessionFile` 一次只见一个文件），跨文件重复不会被消掉。
 *
 * @param {string} dir 会话目录（绝对路径）
 * @param {import('node:fs').Dirent[]} [entries] 已读到的目录项（省略则自行 readdirSync）
 * @returns {{filePath:string, fileName:string, version:number, superseded:string[]}|null}
 */
export function pickSessionLogFile(dir, entries) {
  const list = entries ?? readdirSync(dir, { withFileTypes: true });
  const candidates = [];
  for (const entry of list) {
    const name = typeof entry === 'string' ? entry : entry.name;
    const version = sessionLogVersion(name);
    if (version === null) continue;
    candidates.push({ name, version });
  }
  if (candidates.length === 0) return null;
  // 版本号降序；同版本（理论上不会出现）按名字降序，保证结果稳定可复现。
  candidates.sort((a, b) => (b.version - a.version) || (a.name < b.name ? 1 : a.name > b.name ? -1 : 0));
  const picked = candidates[0];
  return {
    filePath: join(dir, picked.name),
    fileName: picked.name,
    version: picked.version,
    superseded: candidates.slice(1).map((c) => c.name),
  };
}

/**
 * 扫描所有 zstd 帧的起始偏移。
 * @param {Buffer} buf
 * @returns {number[]} 升序偏移，末尾不含 `buf.length`。
 */
export function scanFrameOffsets(buf) {
  const offsets = [];
  let cursor = 0;
  for (;;) {
    const at = buf.indexOf(ZSTD_MAGIC, cursor);
    if (at < 0) break;
    offsets.push(at);
    cursor = at + ZSTD_MAGIC.length;
  }
  return offsets;
}

/**
 * 逐帧解压一个多帧 zstd 文件并拼接成文本。
 *
 * 返回的统计是**自证数字**：`frameTotal` / `framesDecoded` / `framesFailed`
 * 必须原样出现在报告里，否则无法反证「只解了第一帧」这一类错误。
 * @param {string} filePath
 * @returns {{
 *   file:string, rawBytes:number, frameTotal:number, framesDecoded:number,
 *   framesFailed:number, firstFrameBytes:number, decodedBytes:number,
 *   text:string, problems:Array<{kind:string,detail:string}>
 * }}
 */
export function decodeSessionFile(filePath) {
  const problems = [];
  const buf = readFileSync(filePath);
  const offsets = scanFrameOffsets(buf);
  if (offsets.length === 0) {
    problems.push({ kind: 'no-zstd-frames', detail: '文件里找不到任何 zstd 帧魔数' });
    return {
      file: filePath,
      rawBytes: buf.length,
      frameTotal: 0,
      framesDecoded: 0,
      framesFailed: 0,
      firstFrameBytes: 0,
      decodedBytes: 0,
      text: '',
      problems,
    };
  }
  if (offsets[0] !== 0) {
    problems.push({ kind: 'leading-bytes', detail: `首个 zstd 帧之前有 ${offsets[0]} 字节非帧数据，已忽略` });
  }
  let framesFailed = 0;
  let firstFrameBytes = 0;
  let boundaryFixes = 0;
  let text = '';
  for (let i = 0; i < offsets.length; i += 1) {
    const start = offsets[i];
    const end = i + 1 < offsets.length ? offsets[i + 1] : buf.length;
    try {
      const decoded = zstdDecompressSync(buf.subarray(start, end));
      if (i === 0) firstFrameBytes = decoded.length;
      const part = decoded.toString('utf8');
      // 真实日志里每帧以换行结尾；若某帧不是，直接拼接会把两条记录粘成一条。
      // 这里补一个换行并**记入 problems**，避免静默产出坏 JSONL。
      if (text !== '' && !text.endsWith('\n') && part !== '' && !part.startsWith('\n')) {
        text += '\n';
        boundaryFixes += 1;
      }
      text += part;
    } catch (error) {
      framesFailed += 1;
      problems.push({ kind: 'frame-decode-failed', detail: `第 ${i} 帧（偏移 ${start}，长度 ${end - start}）解压失败：${error?.message ?? error}` });
    }
  }
  if (boundaryFixes > 0) {
    problems.push({ kind: 'frame-boundary-without-newline', detail: `${boundaryFixes} 处帧边界没有换行，已补换行以免记录粘连` });
  }
  return {
    file: filePath,
    rawBytes: buf.length,
    frameTotal: offsets.length,
    framesDecoded: offsets.length - framesFailed,
    framesFailed,
    firstFrameBytes,
    decodedBytes: Buffer.byteLength(text, 'utf8'),
    boundaryFixes,
    text,
    problems,
  };
}

/**
 * 逐字去重（同一行文本只保留一次），返回去重后的行与统计。
 * @param {string} text
 * @returns {{lines:string[], lineCount:number, uniqueLineCount:number, exactDuplicateLines:number}}
 */
export function dedupeLines(text) {
  const raw = text.split('\n');
  const lines = [];
  const seen = new Set();
  let nonEmpty = 0;
  let exactDuplicateLines = 0;
  for (const line of raw) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    nonEmpty += 1;
    if (seen.has(trimmed)) {
      exactDuplicateLines += 1;
      continue;
    }
    seen.add(trimmed);
    lines.push(trimmed);
  }
  return { lines, lineCount: nonEmpty, uniqueLineCount: seen.size, exactDuplicateLines };
}

/**
 * 按 `(type, seq)` 去重。缺少 `seq` 的记录（例如 `type:"session"`）用位置键，
 * 以免把本来不同的记录错误合并。
 * @param {object[]} records
 * @returns {{records:object[], typeSeqDuplicates:number, keptCount:number, noSeqRecords:number}}
 */
export function dedupeByTypeSeq(records) {
  const out = [];
  const seen = new Set();
  let typeSeqDuplicates = 0;
  let noSeqRecords = 0;
  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    let key;
    if (rec && rec.seq !== undefined && rec.seq !== null) key = `${rec.type}|${rec.seq}`;
    else {
      noSeqRecords += 1;
      key = `#no-seq|${i}|${rec?.type ?? ''}`;
    }
    if (seen.has(key)) {
      typeSeqDuplicates += 1;
      continue;
    }
    seen.add(key);
    out.push(rec);
  }
  return { records: out, typeSeqDuplicates, keptCount: out.length, noSeqRecords };
}

function usageOrUndefined(value) {
  if (typeof value !== 'object' || value === null) return undefined;
  return value;
}

/**
 * 增量式用量归集器：**逐条喂入、不保留记录数组**。
 *
 * 这是内存纪律的关键：`analyzeSessionFile` 每解析一行就喂进来，函数返回时只带出
 * 小对象（会话头 + 用量的 7 个字段），不会把整份 JSONL 的记录对象留在内存里。
 * 归集语义与 `extractUsage(records)` 完全一致（后者就是本函数的数组包装）。
 * @returns {{add:(rec:object, key:string)=>void, result:()=>object}}
 */
export function createUsageFolder() {
  let session = null;
  const titles = [];
  const usages = [];
  let usageTokens = 0;
  let streamUsageTokens = 0;
  let modelFromSourceCount = 0;
  let modelFromFallbackCount = 0;
  let unknownModelCount = 0;
  let firstTime = null;
  let lastTime = null;
  let timeMissingCount = 0;
  const usageTypeBreakdown = Object.create(null);
  let lastRoute = null;
  let keptCount = 0;
  const seenKeys = new Set();

  return {
    /**
     * 喂入一条记录。返回该记录是否被保留（false = 按 (type,seq) 去重丢弃）。
     * @param {object} rec
     * @returns {boolean}
     */
    add(rec) {
      if (!rec || typeof rec !== 'object') return false;
      const key = rec.seq === undefined || rec.seq === null ? `#no-seq|${keptCount}` : `${rec.type}|${rec.seq}`;
      if (rec.seq !== undefined && rec.seq !== null) {
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
      }
      keptCount += 1;
      const data = usageOrUndefined(rec.data) ?? {};

      if (rec.type === 'session' && session === null) {
        session = {
          id: typeof rec.id === 'string' ? rec.id : null,
          version: rec.version ?? null,
          cwd: typeof rec.cwd === 'string' ? rec.cwd : null,
          createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : null,
          agentPreset: typeof rec.agentPreset === 'string' ? rec.agentPreset : null,
          delegationDepth: typeof rec.delegationDepth === 'number' ? rec.delegationDepth : null,
        };
      }

      if (rec.type === 'session/title' && typeof data.title === 'string' && data.title.trim() !== '') {
        titles.push(data.title.trim());
      }

      if (rec.type === 'request/context') {
        if (typeof data.provider === 'string' && typeof data.model === 'string') {
          lastRoute = { provider: data.provider, model: data.model, from: 'request/context' };
        }
      } else if (rec.type === 'request/header') {
        const config = usageOrUndefined(data.header)?.config;
        if (typeof config?.provider === 'string' && typeof config?.model === 'string') {
          lastRoute = { provider: config.provider, model: config.model, from: 'request/header' };
        }
      }

      const t = typeof rec.time === 'number' ? rec.time : null;
      if (t !== null) {
        if (firstTime === null || t < firstTime) firstTime = t;
        if (lastTime === null || t > lastTime) lastTime = t;
      } else if (rec.type !== 'session') {
        timeMissingCount += 1;
      }

      // 反证用：把 data.stream[].chunk.usage 里的那份用量也统计出来，
      // 让「若两处都累加会虚增多少」有真实数字。**对所有被解析的记录**都统计，
      // 不受「该记录是否带 data.usage」影响（否则反证会少算）。
      const stream = data.stream;
      if (Array.isArray(stream)) {
        for (const event of stream) {
          const chunkUsage = usageOrUndefined(usageOrUndefined(event)?.chunk)?.usage;
          if (chunkUsage && typeof chunkUsage.totalTokens === 'number') streamUsageTokens += chunkUsage.totalTokens;
        }
      }

      const usage = usageOrUndefined(data.usage);
      if (!usage) return true;

      const typeKey = String(rec.type);
      usageTypeBreakdown[typeKey] = (usageTypeBreakdown[typeKey] ?? 0) + 1;
      usageTokens += typeof usage.totalTokens === 'number' ? usage.totalTokens : 0;

      const source = usageOrUndefined(data.message)?.source;
      let provider = null;
      let model = null;
      let modelFrom = 'none';
      if (typeof source?.model === 'string' && source.model !== '') {
        model = source.model;
        provider = typeof source.provider === 'string' ? source.provider : null;
        modelFrom = 'message.source';
        modelFromSourceCount += 1;
      } else if (lastRoute) {
        model = lastRoute.model;
        provider = lastRoute.provider;
        modelFrom = lastRoute.from;
        modelFromFallbackCount += 1;
      } else {
        unknownModelCount += 1;
      }

      usages.push({ type: rec.type, seq: rec.seq ?? null, time: t, provider, model, modelFrom, usage });
      return true;
    },
    result() {
      return {
        session,
        titles,
        usages,
        usageTokens,
        streamUsageTokens,
        usageRecordCount: usages.length,
        modelFromSourceCount,
        modelFromFallbackCount,
        unknownModelCount,
        firstTime,
        lastTime,
        timeMissingCount,
        usageTypeBreakdown,
        keptCount,
      };
    },
  };
}

/**
 * 从记录数组里提取会话元信息与全部用量记录（数组包装，语义同 createUsageFolder）。
 * @param {object[]} records 已去重的记录
 * @returns {object}
 */
export function extractUsage(records) {
  const folder = createUsageFolder();
  let typeSeqDuplicates = 0;
  for (const rec of records ?? []) {
    if (!folder.add(rec)) typeSeqDuplicates += 1;
  }
  const result = folder.result();
  result.keptRecordCount = result.keptCount;
  result.typeSeqDuplicates = typeSeqDuplicates;
  return result;
}

/**
 * 解码「编码工作目录」目录名（回退口径；首选日志里的 `cwd`）。
 * 规则：去掉盘符冒号、`\` 换 `-`、两端各补一个 `-`（例 `D:\a\b` → `--D-a-b--`）。
 * **不把冒号替换成短横。** 该编码对目录名里本来就有的 `-` 是有损的，因此只能作为回退。
 * 形状不符（不是 `--<盘符>-…--`）时返回 null，不要把任意字符串硬解释成路径。
 * @param {string} key 例如 `--D-work-example-app--`
 * @returns {string|null}
 */
export function decodeWorkspaceKey(key) {
  if (typeof key !== 'string') return null;
  const matched = /^--([A-Za-z])(?:-(.*))?--$/.exec(key);
  if (!matched) return null;
  const drive = matched[1].toUpperCase();
  const rest = matched[2] ?? '';
  return rest === '' ? `${drive}:\\` : `${drive}:\\${rest.replace(/-/g, '\\')}`;
}

/**
 * 编码工作目录（与 DSH 目录名口径一致；用于测试与 fixture 生成）。
 * @param {string} cwd 绝对路径，例如 `D:\work\example-app`
 * @returns {string} 例如 `--D-work-example-app--`
 */
export function encodeWorkspaceKey(cwd) {
  const withoutColon = String(cwd).replace(/:/g, '');
  const dashed = withoutColon.replace(/\\/g, '-').replace(/\//g, '-');
  return `--${dashed}--`;
}

/**
 * 廉价预判：这一行**是否可能**含我们需要的记录？
 *
 * 保留的三种记录与其必然出现的子串：
 *   - `assistant/message`（用量）：`data.usage` 一定序列化成 `"usage"`；
 *   - `request/context` / `request/header`（模型归属回退）：一定含 `"model"`；
 *   - `type:"session"` 头（cwd）：一定含 `"cwd"`。
 * 因此这是**超集**选择器：任何带 `data.usage` 的记录都必然被选中，
 * **不可能漏掉计数**（`scripts/probe.mjs` 会用「抽样文件全量解析 vs 预筛解析」
 * 拿真实数字复核这一点）。子串命中偏多只会多解析几行，不会算错。
 */
export const PREFILTER_NEEDLES = Object.freeze(['"usage"', '"model"', '"cwd"']);

/** @param {string} line @returns {boolean} */
export function lineNeedsParse(line) {
  for (const needle of PREFILTER_NEEDLES) {
    if (line.includes(needle)) return true;
  }
  return false;
}

/**
 * 读取并分析一个会话日志文件（不做缓存；缓存由 lib/ledger.js 负责）。
 *
 * **内存纪律**：解码文本只在本次调用内存活，函数返回时只带出**小对象**
 * （每条用量记录 7 个字段 + 会话头），不带出解码文本、不带出全部记录对象。
 * 调用方（ledger）逐文件处理，因此峰值内存 ≈ 单个文件的解码文本。
 *
 * @param {string} filePath
 * @param {object} [options]
 * @param {string} [options.workspaceKey] 所属工作区目录名
 * @param {'needed'|'all'} [options.parseFilter] `'needed'`（默认，性能路径）只 JSON.parse
 *   预判命中的行；`'all'` 全量解析（审计/自证用，两种模式必须给出同一份用量）
 * @returns {object} 分析结果（含全部自证数字与 problems）
 */
export function analyzeSessionFile(filePath, options = {}) {
  const parseFilter = options.parseFilter === 'all' ? 'all' : 'needed';
  const base = { file: filePath, workspaceKey: options.workspaceKey ?? null, parseFilter, problems: [] };
  let decoded;
  try {
    decoded = decodeSessionFile(filePath);
  } catch (error) {
    return {
      ...base,
      rawBytes: null,
      frameTotal: 0,
      framesDecoded: 0,
      framesFailed: 0,
      firstFrameBytes: 0,
      boundaryFixes: 0,
      decodedBytes: 0,
      lineCount: 0,
      uniqueLineCount: 0,
      recordsSkipped: 0,
      exactDuplicateLines: 0,
      parseErrors: 0,
      parseErrorSamples: [],
      recordCount: 0,
      keptRecordCount: 0,
      typeSeqDuplicates: 0,
      noSeqRecords: 0,
      dedupeAgreement: true,
      session: null,
      titles: [],
      usages: [],
      usageTokens: 0,
      streamUsageTokens: 0,
      usageRecordCount: 0,
      modelFromSourceCount: 0,
      modelFromFallbackCount: 0,
      unknownModelCount: 0,
      firstTime: null,
      lastTime: null,
      timeMissingCount: 0,
      usageTypeBreakdown: {},
      problems: [{ kind: 'read-failed', detail: String(error?.message ?? error) }],
    };
  }

  const problems = [...base.problems, ...decoded.problems];
  const { lines, lineCount, uniqueLineCount, exactDuplicateLines } = dedupeLines(decoded.text);
  // 逐字去重跑在**全部行**上（纯字符串操作，很便宜），预筛只影响「解析哪些行」。
  const selected = parseFilter === 'all' ? lines : lines.filter((line) => lineNeedsParse(line));
  const recordsSkipped = lines.length - selected.length;
  // 单遍处理：每行解析后立刻喂进归集器，**不留记录数组**（内存纪律）。
  const folder = createUsageFolder();
  const parseErrorSamples = [];
  let parseErrors = 0;
  let parsedCount = 0;
  let typeSeqDuplicates = 0;
  for (const line of selected) {
    let rec;
    try {
      rec = JSON.parse(line);
    } catch (error) {
      parseErrors += 1;
      if (parseErrorSamples.length < 3) parseErrorSamples.push({ line: line.slice(0, 200), error: String(error?.message ?? error) });
      continue;
    }
    parsedCount += 1;
    if (!folder.add(rec)) typeSeqDuplicates += 1;
  }
  if (parseErrors > 0) problems.push({ kind: 'jsonl-parse-failed', detail: `${parseErrors} 行无法解析为 JSON` });

  const extraction = folder.result();
  // firstTime 用会话头的 createdAt 兜一个下界：预筛只解析计费/路由记录，
  // 若不兜底，「工作区首次活动」会被推到第一次计费所在的时刻。
  if (extraction.session?.createdAt !== null && extraction.session?.createdAt !== undefined) {
    extraction.firstTime = extraction.firstTime === null ? extraction.session.createdAt : Math.min(extraction.firstTime, extraction.session.createdAt);
  }
  const deduped = { keptCount: extraction.keptCount, typeSeqDuplicates };

  // 自证（两条都必须成立）：
  //   1) 逐字去重的唯一行 = 预筛保留下来的行 + 预筛跳过的行（覆盖全部输入，没有丢行）；
  //   2) 在**参与计费的记录子集**上，(type,seq) 去重没有再丢弃任何记录
  //      —— 若两者不等，说明同一条记录被写了两种不同内容，必须让人看见。
  const dedupeAgreement = parsedCount + recordsSkipped === lines.length && deduped.keptCount === parsedCount;

  return {
    ...base,
    rawBytes: decoded.rawBytes,
    frameTotal: decoded.frameTotal,
    framesDecoded: decoded.framesDecoded,
    framesFailed: decoded.framesFailed,
    firstFrameBytes: decoded.firstFrameBytes,
    boundaryFixes: decoded.boundaryFixes,
    decodedBytes: decoded.decodedBytes,
    lineCount,
    uniqueLineCount,
    recordsSkipped,
    exactDuplicateLines,
    parseErrors,
    parseErrorSamples,
    recordCount: parsedCount,
    keptRecordCount: deduped.keptCount,
    typeSeqDuplicates: deduped.typeSeqDuplicates,
    noSeqRecords: deduped.noSeqRecords,
    dedupeAgreement,
    ...extraction,
    problems,
  };
}

/** 只读文件状态，用于缓存失效判定。 */
export function statSessionFile(filePath) {
  const st = statSync(filePath);
  return { size: st.size, mtimeMs: st.mtimeMs };
}

/**
 * 反证辅助：对整文件**一次性**解压能拿到多少字节。
 * 多帧 zstd 只解出第一帧（通常是会话头），这个数字必须与逐帧拼接的
 * `decodedBytes` 一起出现在报告里，否则「只解了第一帧」无法被反证。
 * @param {string} filePath
 * @returns {{bytes:number, error:string|null}}
 */
export function wholeFileDecompressBytes(filePath) {
  try {
    return { bytes: zstdDecompressSync(readFileSync(filePath)).length, error: null };
  } catch (error) {
    return { bytes: 0, error: String(error?.message ?? error) };
  }
}

