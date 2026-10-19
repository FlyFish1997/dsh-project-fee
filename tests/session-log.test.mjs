/**
 * 会话日志解码测试：多帧 zstd、逐字去重 vs (type,seq) 去重、用量提取口径、缺口。
 * 用法：node --test --test-isolation=none tests/session-log.test.mjs
 */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import {
  ZSTD_MAGIC,
  analyzeSessionFile,
  decodeSessionFile,
  decodeWorkspaceKey,
  dedupeLines,
  dedupeByTypeSeq,
  encodeWorkspaceKey,
  lineNeedsParse,
  pickSessionLogFile,
  scanFrameOffsets,
  sessionLogVersion,
  wholeFileDecompressBytes,
} from '../lib/session-log.js';
import { beijing, cleanup, frame, makeTempHome, sessionRecord, usageRecord, writeSession } from './helpers/session-fixture.mjs';

test('目录名编码/解码与 DSH 口径一致（不把冒号替换成短横）', () => {
  assert.equal(encodeWorkspaceKey('D:\\work\\exampleapp'), '--D-work-exampleapp--');
  assert.equal(encodeWorkspaceKey('D:\\work\\examplebeta'), '--D-work-examplebeta--');
  assert.equal(decodeWorkspaceKey('--D-work-exampleapp--'), 'D:\\work\\exampleapp');
  assert.equal(decodeWorkspaceKey('--D-work-examplebeta--'), 'D:\\work\\examplebeta');
  assert.equal(decodeWorkspaceKey('garbage'), null);
});

test('多帧 zstd：必须逐帧解压；一次性整文件解压只得第一帧（会误导）', () => {
  const home = makeTempHome('frames');
  try {
    const lines = [sessionRecord({ id: 'session-a', cwd: 'D:\\tmp\\proj', createdAt: beijing(2026, 9, 14, 10, 0) })];
    for (let i = 1; i <= 9; i += 1) lines.push(usageRecord(i, beijing(2026, 9, 14, 10, i), { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 0, reasoningTokens: 0 }));
    const { file } = writeSession(home, 'D:\\tmp\\proj', 'session-a', lines, { frameSize: 2 });

    const decoded = decodeSessionFile(file);
    assert.equal(decoded.frameTotal, 5, '10 行 / 每帧 2 行 = 5 帧');
    assert.equal(decoded.framesDecoded, 5);
    assert.equal(decoded.framesFailed, 0);

    // 反证：整文件一次性解压只出第一帧
    const whole = wholeFileDecompressBytes(file);
    assert.equal(whole.error, null);
    assert.ok(whole.bytes > 0);
    assert.ok(whole.bytes < decoded.decodedBytes, `一次性解压 ${whole.bytes} 应远小于逐帧 ${decoded.decodedBytes}`);
    assert.equal(whole.bytes, decoded.firstFrameBytes);

    const analysis = analyzeSessionFile(file, { workspaceKey: 'k' });
    assert.equal(analysis.dedupeAgreement, true);
    assert.equal(analysis.usageRecordCount, 9);
    assert.equal(analysis.usageTokens, 9 * 1100);
    assert.equal(analysis.streamUsageTokens, 9 * 1100, 'stream 里那份用量被统计出来用于反证');
  } finally {
    cleanup(home);
  }
});

test('损坏帧被显式计入 framesFailed 与 problems，不静默丢弃', () => {
  const home = makeTempHome('corrupt');
  try {
    const good1 = frame(JSON.stringify(sessionRecord({ id: 's1', cwd: 'D:\\tmp\\p1', createdAt: beijing(2026, 9, 14, 10, 0) })));
    const broken = Buffer.concat([ZSTD_MAGIC, Buffer.from('this-is-not-a-valid-zstd-frame-payload', 'utf8')]);
    const good2 = frame(JSON.stringify(usageRecord(1, beijing(2026, 9, 14, 10, 5), { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 0 })));
    const file = join(home, 'broken.jsonl.zstd');
    writeFileSync(file, Buffer.concat([good1, broken, good2]));

    const decoded = decodeSessionFile(file);
    assert.equal(decoded.frameTotal, 3);
    assert.equal(decoded.framesDecoded, 2);
    assert.equal(decoded.framesFailed, 1);

    const analysis = analyzeSessionFile(file);
    assert.equal(analysis.framesFailed, 1);
    assert.ok(analysis.problems.some((p) => p.kind === 'frame-decode-failed'));
    assert.equal(analysis.usageRecordCount, 1, '剩余可解码帧的用量仍要计入，不能整文件丢弃');
  } finally {
    cleanup(home);
  }
});

test('非 zstd 文件与不存在的文件各走一条显式缺口，不抛异常', () => {
  const home = makeTempHome('gaps');
  try {
    const notZstd = join(home, 'plain.jsonl.zstd');
    writeFileSync(notZstd, '{"type":"session"}\n');
    const decoded = decodeSessionFile(notZstd);
    assert.equal(decoded.frameTotal, 0);
    assert.ok(decoded.problems.some((p) => p.kind === 'no-zstd-frames'));
    assert.equal(scanFrameOffsets(Buffer.from('nothing here')).length, 0);

    const analysis = analyzeSessionFile(notZstd);
    assert.equal(analysis.recordCount, 0);

    const missing = analyzeSessionFile(join(home, 'does-not-exist.jsonl.zstd'));
    assert.ok(missing.problems.some((p) => p.kind === 'read-failed'));
    assert.equal(missing.usageRecordCount, 0);
  } finally {
    cleanup(home);
  }
});

test('逐字去重与 (type,seq) 去重在正常情况下给出同一结果', () => {
  const home = makeTempHome('dedupe');
  try {
    const rows = [
      JSON.stringify(sessionRecord({ id: 's1', cwd: 'D:\\tmp\\p2', createdAt: beijing(2026, 9, 14, 10, 0) })),
      JSON.stringify(usageRecord(1, beijing(2026, 9, 14, 10, 5), { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 0 })),
      JSON.stringify(usageRecord(2, beijing(2026, 9, 14, 10, 6), { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, reasoningTokens: 0 })),
    ];
    // 跨帧重复写入同一行（模拟追加写被复制）
    const { file } = writeSession(home, 'D:\\tmp\\p2', 's1', [rows[0], rows[1], rows[2], rows[1]]);
    const analysis = analyzeSessionFile(file);
    assert.equal(analysis.lineCount, 4);
    assert.equal(analysis.exactDuplicateLines, 1);
    assert.equal(analysis.recordCount, 3);
    assert.equal(analysis.typeSeqDuplicates, 0);
    assert.equal(analysis.dedupeAgreement, true, '两种去重法必须一致');
    assert.equal(analysis.usageTokens, 330);
  } finally {
    cleanup(home);
  }
});

test('(type,seq) 相同但内容不同：按 (type,seq) 去重淘汰后者，且 dedupeAgreement=false（不一致要看得见）', () => {
  const home = makeTempHome('dupseq');
  try {
    const a = JSON.stringify(usageRecord(7, beijing(2026, 9, 14, 10, 5), { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }));
    const b = JSON.stringify(usageRecord(7, beijing(2026, 9, 14, 11, 5), { inputTokens: 999, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }));
    const { file } = writeSession(home, 'D:\\tmp\\p3', 's1', [a, b]);
    const analysis = analyzeSessionFile(file);
    assert.equal(analysis.recordCount, 2);
    assert.equal(analysis.keptRecordCount, 1);
    assert.equal(analysis.typeSeqDuplicates, 1);
    assert.equal(analysis.dedupeAgreement, false);
    assert.equal(analysis.usageTokens, 100);
    // 直接验证两个纯函数
    assert.equal(dedupeLines('a\nb\na\n').exactDuplicateLines, 1);
    assert.equal(dedupeByTypeSeq([{ type: 'x', seq: 1 }, { type: 'x', seq: 1 }, { type: 'y' }, { type: 'y' }]).typeSeqDuplicates, 1);
  } finally {
    cleanup(home);
  }
});

test('用量口径：只取 data.usage；模型优先取 data.message.source，缺失时回退最近的 request/context', () => {
  const home = makeTempHome('usage');
  try {
    const lines = [
      sessionRecord({ id: 's1', cwd: 'D:\\tmp\\p4', createdAt: beijing(2026, 9, 14, 10, 0) }),
      // 1) 无 source 且此前没有任何路由记录 → unknown
      usageRecord(1, beijing(2026, 9, 14, 10, 1), { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }, { withSource: false }),
      // 路由出现
      { type: 'request/context', seq: 2, time: beijing(2026, 9, 14, 10, 2), data: { provider: 'deepseek-official', model: 'deepseek-v4-pro', contextWindow: 1 } },
      // 2) 无 source → 回退到最近的 request/context
      usageRecord(3, beijing(2026, 9, 14, 10, 3), { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }, { withSource: false }),
      // 3) 有 source → 用它（比最近路由更权威）
      usageRecord(4, beijing(2026, 9, 14, 10, 4), { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0 }, { model: 'deepseek-flash' }),
    ];
    const { file } = writeSession(home, 'D:\\tmp\\p4', 's1', lines);
    const analysis = analyzeSessionFile(file);
    assert.equal(analysis.usageRecordCount, 3);
    assert.equal(analysis.modelFromSourceCount, 1);
    assert.equal(analysis.modelFromFallbackCount, 1);
    assert.equal(analysis.unknownModelCount, 1);
    assert.equal(analysis.usages[0].model, null);
    assert.equal(analysis.usages[0].modelFrom, 'none');
    assert.equal(analysis.usages[1].model, 'deepseek-v4-pro');
    assert.equal(analysis.usages[1].modelFrom, 'request/context');
    assert.equal(analysis.usages[2].model, 'deepseek-flash');
    assert.equal(analysis.usages[2].modelFrom, 'message.source');
    assert.deepEqual({ ...analysis.usageTypeBreakdown }, { 'assistant/message': 3 });
    assert.equal(analysis.session.cwd, 'D:\\tmp\\p4');
    assert.equal(analysis.session.id, 's1');
  } finally {
    cleanup(home);
  }
});

test('没有 usage 的记录不计费；session 头记录的 cwd 被提取', () => {
  const home = makeTempHome('nousage');
  try {
    const lines = [
      sessionRecord({ id: 's9', cwd: 'D:\\tmp\\p9', createdAt: beijing(2026, 9, 14, 10, 0) }),
      { type: 'tool/call', seq: 1, time: beijing(2026, 9, 14, 10, 1), data: { name: 'x', callId: 'c1', arguments: '{}' } },
      { type: 'step/end', seq: 2, time: beijing(2026, 9, 14, 10, 2), data: { turn: 1, step: 1 } },
    ];
    const { file } = writeSession(home, 'D:\\tmp\\p9', 's9', lines);
    const analysis = analyzeSessionFile(file);
    assert.equal(analysis.usageRecordCount, 0);
    assert.equal(analysis.usageTokens, 0);
    assert.equal(analysis.session.cwd, 'D:\\tmp\\p9');
  } finally {
    cleanup(home);
  }
});

test('解析预筛：needed 与 all 给出**完全相同**的用量（不漏），且确实跳过了无用行', () => {
  const home = makeTempHome('prefilter');
  try {
    const lines = [sessionRecord({ id: 's1', cwd: 'D:\\tmp\\pf', createdAt: beijing(2026, 9, 14, 10, 0) })];
    // 大量「无用」行（tool/call、tool/result、step/start…）
    for (let i = 1; i <= 40; i += 1) {
      lines.push({ type: 'tool/call', seq: i, time: beijing(2026, 9, 14, 10, i % 60), data: { turn: 1, step: i, callId: `c${i}`, name: 'pwsh', arguments: '{"command":"echo hi"}' } });
      lines.push({ type: 'step/end', seq: 1000 + i, time: beijing(2026, 9, 14, 11, i % 60), data: { turn: 1, step: i } });
    }
    // 有用行：用量记录（含 data.usage + stream chunk usage）
    lines.push(usageRecord(500, beijing(2026, 9, 14, 12, 0), { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, reasoningTokens: 5 }));
    // 边界：只有 stream 里的 chunk.usage，没有顶层 data.usage（也必须被选中）
    lines.push({
      type: 'assistant/message',
      seq: 501,
      time: beijing(2026, 9, 14, 12, 1),
      data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, stream: [{ type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 7, outputTokens: 1, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 8 } } }] },
    });
    const { file } = writeSession(home, 'D:\\tmp\\pf', 's1', lines);

    const needed = analyzeSessionFile(file, { parseFilter: 'needed' });
    const all = analyzeSessionFile(file, { parseFilter: 'all' });

    // 不漏：两种模式的用量条数、tokens、stream 双计、模型归属、会话头必须一致
    assert.equal(needed.usageRecordCount, all.usageRecordCount);
    assert.equal(needed.usageTokens, all.usageTokens);
    assert.equal(needed.streamUsageTokens, all.streamUsageTokens);
    assert.equal(needed.modelFromSourceCount, all.modelFromSourceCount);
    assert.equal(needed.session.cwd, all.session.cwd);
    assert.equal(needed.usageRecordCount, 1, '只计 data.usage 的那一条；仅有 chunk.usage 的不计入账单');
    // stream 反证：110（第一条的 chunk 副本，其 totalTokens = input+output+cacheRead = 110）+ 8（仅有 chunk.usage 的那条）
    assert.equal(needed.streamUsageTokens, 110 + 8, 'stream 里两份用量都被统计（用于反证）');
    // firstTime/lastTime 的定义域不同（已在 SPEC 写明）：预筛只看计费/路由记录，
    // 因此 firstTime 由 createdAt 兜下界、lastTime 可能早于全量口径的末次活动。
    assert.ok(needed.firstTime <= all.firstTime, `firstTime 兜底后应不晚于全量：${needed.firstTime} vs ${all.firstTime}`);
    assert.equal(needed.firstTime, beijing(2026, 9, 14, 10, 0), 'firstTime = 会话 createdAt');
    assert.ok(needed.lastTime <= all.lastTime, 'lastTime 反映末次计费活动，不晚于全量的末次活动');
    // 确实跳过：预筛解析行数远小于全量，且两者合计等于唯一行数
    assert.ok(needed.recordCount < all.recordCount, `预筛 ${needed.recordCount} 应小于全量 ${all.recordCount}`);
    assert.equal(needed.recordsSkipped, all.recordCount - needed.recordCount);
    assert.equal(needed.recordCount + needed.recordsSkipped, all.recordCount);
    assert.equal(all.recordsSkipped, 0);
    // 逐字去重与「解析+跳过」的覆盖关系
    assert.equal(needed.dedupeAgreement, true);
    assert.equal(all.dedupeAgreement, true);
    assert.equal(needed.recordCount, needed.uniqueLineCount - needed.recordsSkipped - needed.exactDuplicateLines);
    // 预筛选择器本身：无用行被排除、三种必需行都命中
    assert.equal(lineNeedsParse('{"type":"tool/call","seq":1,"data":{"name":"pwsh"}}'), false);
    assert.equal(lineNeedsParse('{"type":"assistant/message","data":{"usage":{}}}'), true);
    assert.equal(lineNeedsParse('{"type":"request/context","data":{"provider":"x","model":"y"}}'), true);
    assert.equal(lineNeedsParse('{"type":"session","version":3,"cwd":"D:\\\\x"}'), true);
  } finally {
    cleanup(home);
  }
});

test('帧边界缺换行时补换行并记入 problems，避免把两条记录粘成一条', () => {
  const home = makeTempHome('boundary');
  try {
    const a = JSON.stringify(sessionRecord({ id: 's1', cwd: 'D:\\tmp\\pb', createdAt: beijing(2026, 9, 14, 10, 0) }));
    const b = JSON.stringify(usageRecord(1, beijing(2026, 9, 14, 10, 5), { inputTokens: 100, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 }));
    // 两帧都不以换行结尾 —— 直接拼接会粘成一条
    const raw = Buffer.concat([frame(a), frame(b)]);
    const file = writeRaw(home, raw);
    const analysis = analyzeSessionFile(file);
    assert.equal(analysis.boundaryFixes, 1);
    assert.ok(analysis.problems.some((p) => p.kind === 'frame-boundary-without-newline'));
    assert.equal(analysis.parseErrors, 0);
    assert.equal(analysis.usageRecordCount, 1);
  } finally {
    cleanup(home);
  }
});

/** 把原始字节写成测试用的会话文件，返回路径。 */
function writeRaw(home, raw) {
  const file = join(home, 'raw-session.v3.jsonl.zstd');
  writeFileSync(file, raw);
  return file;
}

test('会话日志文件名带版本号：识别 v1/v3/v4，非日志名返回 null', () => {
  assert.equal(sessionLogVersion('session.v4.jsonl.zstd'), 4);
  assert.equal(sessionLogVersion('session.v3.jsonl.zstd'), 3);
  assert.equal(sessionLogVersion('session.v12.jsonl.zstd'), 12);
  assert.equal(sessionLogVersion('session.jsonl.zstd'), 0, '无版本段的老格式记 0，不能被当成「不是日志」');
  assert.equal(sessionLogVersion('session.v3.jsonl'), null);
  assert.equal(sessionLogVersion('notes.txt'), null);
  assert.equal(sessionLogVersion(undefined), null);
});

test('pickSessionLogFile：一个会话目录只取版本号最大的那个文件，旧版本进 superseded', () => {
  const home = makeTempHome('pick');
  try {
    const cwd = 'D:\\tmp\\pick';
    const lines = [sessionRecord({ id: 'session-p1', cwd, createdAt: beijing(2026, 10, 7, 9, 0) })];
    const { dir } = writeSession(home, cwd, 'session-p1', lines);
    // 目录里只有 v3
    let picked = pickSessionLogFile(dir);
    assert.equal(picked.fileName, 'session.v3.jsonl.zstd');
    assert.equal(picked.version, 3);
    assert.deepEqual(picked.superseded, []);

    // 再来一个 v4（DSH 升级后会整篇重写）：必须选 v4，且 v3 明确登记为被取代
    writeSession(home, cwd, 'session-p1', lines, { fileName: 'session.v4.jsonl.zstd' });
    picked = pickSessionLogFile(dir);
    assert.equal(picked.fileName, 'session.v4.jsonl.zstd');
    assert.equal(picked.version, 4);
    assert.deepEqual(picked.superseded, ['session.v3.jsonl.zstd']);

    // 目录里没有任何会话日志 → null（由调用方登记缺口，不静默）
    const emptyDir = join(home, 'empty-session');
    mkdirSync(emptyDir, { recursive: true });
    assert.equal(pickSessionLogFile(emptyDir), null);
  } finally {
    cleanup(home);
  }
});

