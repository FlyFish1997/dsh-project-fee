// fee-query：会话级费用查询的纯逻辑单测（不依赖 DSH 运行时）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeWorkspaceFee, findWorkspace, queryWorkspaceFee, encodeWorkspaceKey } from '../lib/fee-query.js';

const KEY = encodeWorkspaceKey('D:\\work\\alpha');

function summaryWith(workspace, extra = {}) {
  return { days: 7, generatedAt: '2026-09-18T00:00:00.000Z', workspaces: workspace ? [workspace] : [], current: null, ...extra };
}

const WS = {
  workspaceId: KEY,
  key: KEY,
  label: 'alpha',
  cwd: 'D:\\work\\alpha',
  todayCost: 1.5,
  lifetimeCost: 42.25,
  cost: 6.75,
  tokens: { cacheReadTokens: 1_000_000, inputTokens: 20_000, outputTokens: 500, reasoningTokens: 120, totalTokens: 1_020_500 },
  alert: {
    day: { limit: 5, level: 'ok', ratio: 0.3 },
    total: { limit: 40, level: 'over', ratio: 1.056 },
    level: 'over',
    limit: 5,
  },
};

test('encodeWorkspaceKey 与真实实现的编码一致（复用 session-log 的实现）', () => {
  // 实测：`D:\work\alpha` → `--D-work-alpha--`（去盘符冒号；分隔符换单短横；两端各补一个短横）
  assert.equal(KEY, '--D-work-alpha--');
  assert.equal(encodeWorkspaceKey('D:\\path\\to\\repopath'), '--D-path-to-repopath--');
});

test('findWorkspace：优先用 sessionId 反查 current', () => {
  const s = summaryWith(WS, { current: { workspaceId: KEY, label: 'alpha', todayCost: 1.5, alert: WS.alert } });
  const row = findWorkspace(s, { sessionId: 's-1' });
  assert.equal(row.workspaceId, KEY);
  assert.equal(row.lifetimeCost, 42.25, '应返回 workspaces 里的完整行（含累计花费）');
});

test('findWorkspace：无 sessionId 时用 cwd 精确编码匹配', () => {
  const row = findWorkspace(summaryWith(WS), { cwd: 'D:\\work\\alpha' });
  assert.equal(row.workspaceId, KEY);
});

test('findWorkspace：cwd 有尾随分隔符也能匹配', () => {
  const row = findWorkspace(summaryWith(WS), { cwd: 'D:\\work\\alpha\\' });
  assert.equal(row.workspaceId, KEY);
});

test('findWorkspace：匹配不到时返回 null（不猜）', () => {
  assert.equal(findWorkspace(summaryWith(WS), { cwd: 'D:\\work\\nope' }), null);
  assert.equal(findWorkspace(summaryWith(null), { cwd: 'D:\\work\\alpha' }), null);
});

test('describeWorkspaceFee：定位失败时给出明确原因，而不是一个数字', () => {
  const r = describeWorkspaceFee({ workspace: null });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'workspace-not-resolved');
  assert.match(r.message, /无法/);
});

test('describeWorkspaceFee：双线各自给出级别，整体取更严重的一个', () => {
  const r = describeWorkspaceFee({ workspace: WS, days: 7 });
  assert.equal(r.ok, true);
  assert.equal(r.alert.level, 'over', '总线 over → 整体 over');
  assert.equal(r.alert.day.level, 'ok');
  assert.equal(r.alert.total.level, 'over');
  assert.match(r.alert.dayText, /日预警线 ¥5\.00/);
  assert.match(r.alert.totalText, /已超预警线/);
  assert.match(r.alert.totalText, /105\.6%/, '比例应显示出来');
});

test('describeWorkspaceFee：金额与 token 数字取自正确的字段', () => {
  const r = describeWorkspaceFee({ workspace: WS });
  assert.equal(r.todayCost, 1.5);
  assert.equal(r.totalCost, 42.25, '累计花费取 lifetimeCost，不是窗口内 cost');
  assert.equal(r.windowCost, 6.75);
  assert.equal(r.tokens.uncachedInput, 20_000);
  assert.equal(r.tokens.cachedInput, 1_000_000);
  assert.equal(r.tokens.reasoning, 120);
});

test('describeWorkspaceFee：未配置的线显示「未设置」而不是伪装成 ok', () => {
  const ws = { ...WS, alert: { day: { limit: null, level: 'ok', ratio: null }, total: { limit: null, level: 'ok', ratio: null }, level: 'ok', limit: null } };
  const r = describeWorkspaceFee({ workspace: ws });
  assert.match(r.alert.dayText, /未设置/);
  assert.match(r.alert.totalText, /未设置/);
});

test('describeWorkspaceFee：兼容旧的单值 alert 形状（理解为日线）', () => {
  const ws = { ...WS, alert: { limit: 2, level: 'warn' } };
  const r = describeWorkspaceFee({ workspace: ws });
  assert.equal(r.alert.day.limit, 2);
  assert.equal(r.alert.day.level, 'warn');
  assert.match(r.alert.totalText, /未设置/);
});

test('describeWorkspaceFee：口径提示必须出现在结果与 message 里', () => {
  const r = describeWorkspaceFee({ workspace: WS });
  assert.match(r.basis.note, /不是账单实付金额/);
  assert.match(r.message, /非账单实付额/);
});

test('queryWorkspaceFee：一步到位（cwd → 结果）', () => {
  const r = queryWorkspaceFee(summaryWith(WS), { cwd: 'D:\\work\\alpha' });
  assert.equal(r.ok, true);
  assert.equal(r.workspace.label, 'alpha');
  assert.equal(r.totalCost, 42.25);
});

test('queryWorkspaceFee：cwd 明确但窗口内无用量 → 合成零花费条目（不报错）', () => {
  // 这是真实场景：`/fee` 在本工作区还没有用量记录时执行。
  // 报「无法定位工作区」会让人以为插件坏了；显示「¥0，暂无用量记录」才是有用信息。
  const r = queryWorkspaceFee(summaryWith(WS), { cwd: 'D:\\elsewhere' });
  assert.equal(r.ok, true);
  assert.equal(r.totalCost, 0);
  assert.equal(r.todayCost, 0);
  assert.equal(r.workspace.label, 'elsewhere');
  assert.match(String(r.note ?? ''), /没有用量记录/);
});

test('queryWorkspaceFee：连 cwd 都没有时才是真正的定位失败', () => {
  const r = queryWorkspaceFee(summaryWith(WS), {});
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'workspace-not-resolved');
});

test('金额格式化：小额不显示成 ¥0.00', () => {
  const ws = { ...WS, todayCost: 0.00042 };
  const r = describeWorkspaceFee({ workspace: ws });
  assert.match(r.message, /¥0\.000420/, '小额应有有效数字，不能是 ¥0.00');
});
