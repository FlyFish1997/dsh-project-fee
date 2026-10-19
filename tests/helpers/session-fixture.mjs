/**
 * 测试夹具：在**工作区内**造出一个合成 DSH home（会话日志 + 账本目录）。
 * 会话文件按多帧 zstd 拼接，与真实 DSH 日志同构（见 README.md）。
 *
 * 注意：测试只允许写工作区，因此 home 一律建在 `.tmp/` 下，收尾删除。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { encodeWorkspaceKey } from '../../lib/session-log.js';

const PROJECT_ROOT = resolve(import.meta.dirname, '..', '..');

/**
 * 测试临时目录的基址：默认 `<项目根>/.tmp`，可用环境变量 `DSH_TEST_TMP` 覆盖。
 *
 * 为什么需要覆盖（受限沙箱实测，见 README.md「测试与受限环境」）：`workspace-write` 下
 * **会话开始时就存在的子目录**（含 `.tmp/`）对受限子进程是只读的，而**新建的
 * 根级目录**可写。因此沙箱内跑测试要指到一个新建目录，例如
 * `$env:DSH_TEST_TMP='D:\...\dsh-project-fee\.runtmp'`。
 */
export function tempRoot() {
  const override = process.env.DSH_TEST_TMP;
  return override ? resolve(override) : join(PROJECT_ROOT, '.tmp');
}

/** 造一个临时 DSH home（`<tempRoot>/<prefix>-XXXX`），返回绝对路径。 */
export function makeTempHome(prefix = 'home') {
  const base = tempRoot();
  mkdirSync(base, { recursive: true });
  return mkdtempSync(join(base, `${prefix}-`));
}

/** 删除临时目录（失败忽略）。 */
export function cleanup(path) {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    /* 收尾失败不影响断言 */
  }
}

/** 把一个字符串压成一帧 zstd。 */
export function frame(text) {
  return zstdCompressSync(Buffer.from(text, 'utf8'));
}

/** 把多段文本各自压成一帧并拼接（与真实日志同构）。 */
export function multiFrame(chunks) {
  return Buffer.concat(chunks.map((chunk) => frame(chunk)));
}

/**
 * 写一个会话日志文件。
 * @param {string} home DSH home
 * @param {string} cwd 工作目录（用于计算目录名）
 * @param {string} sessionId 会话 id（同时作为目录名）
 * @param {Array<string|object>} lines JSONL 行（对象会被 JSON.stringify）
 * @param {{frameSize?:number, raw?:Buffer, fileName?:string}} [options]
 *   frameSize=每帧装几行；raw 直接写字节；
 *   fileName 指定日志文件名（默认 `session.v3.jsonl.zstd`，传 `session.v4.jsonl.zstd`
 *   可以造「同一会话目录里同时有 v3 与 v4」的语料，用于反证「不双计」）
 * @returns {{file:string, workspaceKey:string, dir:string}}
 */
export function writeSession(home, cwd, sessionId, lines, options = {}) {
  const workspaceKey = encodeWorkspaceKey(cwd);
  const dir = join(home, 'sessions', workspaceKey, sessionId);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, options.fileName ?? 'session.v3.jsonl.zstd');
  if (options.raw) {
    writeFileSync(file, options.raw);
    return { file, workspaceKey, dir };
  }
  const text = lines.map((line) => (typeof line === 'string' ? line : JSON.stringify(line))).join('\n');
  const perFrame = options.frameSize ?? 3;
  const rows = text.split('\n');
  const chunks = [];
  for (let i = 0; i < rows.length; i += perFrame) chunks.push(`${rows.slice(i, i + perFrame).join('\n')}\n`);
  writeFileSync(file, multiFrame(chunks));
  return { file, workspaceKey, dir };
}

/** `type:"session"` 头记录（无 seq/time，顶层带 cwd）。 */
export function sessionRecord({ id, cwd, createdAt, agentPreset = 'standard' }) {
  return { type: 'session', version: 3, id, cwd, createdAt, isSeeded: false, delegationDepth: 0, agentPreset };
}

/** `request/header` 记录（模型路由回退来源）。 */
export function headerRecord(seq, time, { provider = 'deepseek-official', model = 'deepseek-flash' } = {}) {
  return { type: 'request/header', seq, time, data: { header: { config: { provider, model } }, reason: 'initial' } };
}

/** `request/context` 记录。 */
export function contextRecord(seq, time, { provider = 'deepseek-official', model = 'deepseek-flash' } = {}) {
  return { type: 'request/context', seq, time, data: { provider, model, contextWindow: 1000000 } };
}

const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0, totalTokens: 0 };

/** 一条 assistant/message 用量记录；`stream` 里再写一份相同的用量（真实日志的重复写入）。 */
export function usageRecord(seq, time, usage, { model = 'deepseek-flash', provider = 'deepseek-official', withStream = true, withSource = true } = {}) {
  const full = { ...ZERO, ...usage, totalTokens: usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheReadTokens ?? 0) };
  const message = { role: 'assistant', content: [{ type: 'reasoning', text: 'x' }] };
  if (withSource) message.source = { kind: 'model', provider, model };
  return {
    type: 'assistant/message',
    seq,
    time,
    data: {
      turn: 1,
      step: 1,
      message,
      usage: full,
      ...(withStream ? { stream: [{ type: 'chunk', time, chunk: { type: 'usage', usage: full } }] } : {}),
    },
  };
}

/** 北京时间 → epoch ms（测试里构造时刻用，避免依赖运行机时区）。 */
export function beijing(year, month, day, hour, minute = 0) {
  return Date.UTC(year, month - 1, day, hour, minute) - 8 * 3600 * 1000;
}

/**
 * **今天**（真实时钟）北京时间的某个整点。
 * 用于需要与真实「今日」对齐、又不想依赖运行时刻的测试：取 03:00 之类的
 * 空闲时段即可同时保证「今日」与「单价确定」。
 */
export function todayBeijing(hour, minute = 0) {
  const p = beijingPartsValue(Date.now());
  return Date.UTC(p.y, p.m - 1, p.d, hour, minute) - 8 * 3600 * 1000;
}

function beijingPartsValue(epochMs) {
  const shifted = new Date(epochMs + 8 * 3600 * 1000);
  return { y: shifted.getUTCFullYear(), m: shifted.getUTCMonth() + 1, d: shifted.getUTCDate() };
}

export { PROJECT_ROOT };
