// host-tools：会话调用面的单测（工具定义构造、参数钳制、注册降级、真实解析探测）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { buildToolDefinition, loadToolkit, profileCandidates, registerSessionSurfaces, TOOL_NAME, COMMAND_NAME } from '../lib/host-tools.js';

const KEY = '--D-work-alpha--';
const WS = {
  workspaceId: KEY,
  label: 'alpha',
  cwd: 'D:\\work\\alpha',
  todayCost: 1,
  lifetimeCost: 10,
  cost: 3,
  tokens: { cacheReadTokens: 100, inputTokens: 20, outputTokens: 5, reasoningTokens: 1, totalTokens: 125 },
  alert: { day: { limit: 5, level: 'ok', ratio: 0.2 }, total: { limit: 8, level: 'over', ratio: 1.25 }, level: 'over', limit: 5 },
};
const summary = { days: 7, workspaces: [WS], current: { workspaceId: KEY, label: 'alpha' } };

/** 最小 defineTool 替身：原样收下定义，便于断言。 */
const fakeDefineTool = (def) => def;

test('buildToolDefinition：名字与描述稳定，execute 从 exec.agent.cwd 零参数定位', async () => {
  let asked = null;
  const def = buildToolDefinition({
    defineTool: fakeDefineTool,
    getSummary: ({ days, sessionId }) => {
      asked = { days, sessionId };
      return summary;
    },
  });
  assert.equal(def.name, TOOL_NAME);
  assert.match(def.description, /当前工作区/);
  const out = await def.execute({}, { agent: { cwd: 'D:\\work\\alpha', sessionId: 's-1' } });
  assert.equal(out.ok, true);
  assert.equal(out.workspace.label, 'alpha');
  assert.equal(out.totalCost, 10, '累计花费取 lifetimeCost');
  assert.deepEqual(asked, { days: 7, sessionId: 's-1' }, '默认 7 天；sessionId 透传给账本');
});

test('buildToolDefinition：days 参数被钳制在 1..90，非法值回落 7', async () => {
  const seen = [];
  const def = buildToolDefinition({ defineTool: fakeDefineTool, getSummary: ({ days }) => { seen.push(days); return summary; } });
  await def.execute({ days: 999 }, { agent: { cwd: 'D:\\work\\alpha' } });
  await def.execute({ days: 0 }, { agent: { cwd: 'D:\\work\\alpha' } });
  await def.execute({ days: 'abc' }, { agent: { cwd: 'D:\\work\\alpha' } });
  await def.execute({ days: 30.7 }, { agent: { cwd: 'D:\\work\\alpha' } });
  assert.deepEqual(seen, [90, 1, 7, 30]);
});

test('buildToolDefinition：连 cwd 都没有时返回 ok=false，而不是抛异常', async () => {
  const def = buildToolDefinition({ defineTool: fakeDefineTool, getSummary: () => ({ workspaces: [], current: null }) });
  const out = await def.execute({}, { agent: {} });
  assert.equal(out.ok, false);
  assert.equal(out.reason, 'workspace-not-resolved');
});

test('buildToolDefinition：agent.session.id / cwd 的真实路径能被读到', async () => {
  // 实测踩过：我按 `agent.sessionId` / `agent.cwd` 读，而真实形状是 `agent.session.id`，
  // 且 Agent 不直接暴露 cwd → `/fee` 能跑但报「定位不到工作区」。
  let asked = null;
  const def = buildToolDefinition({
    defineTool: fakeDefineTool,
    getSummary: (q) => { asked = q; return summary; },
  });
  const out = await def.execute({}, { agent: { session: { id: 's-9', cwd: 'D:\\work\\alpha' } } });
  assert.equal(out.ok, true);
  assert.equal(out.workspace.label, 'alpha');
  assert.equal(asked.sessionId, 's-9', 'sessionId 必须取自 agent.session.id');
});

test('buildToolDefinition：presentResult 给出人话摘要（供 Host 本地消费方）', async () => {
  const def = buildToolDefinition({ defineTool: fakeDefineTool, getSummary: () => summary });
  const out = await def.execute({}, { agent: { cwd: 'D:\\work\\alpha' } });
  assert.match(def.presentResult(out), /工作区「alpha」/);
  assert.equal(def.presentResult({ ok: false, message: 'boom' }), 'boom');
});

test('loadToolkit：本地真实环境能否解析 @deepseek-ai/dsh-tools（探测，不强制要求）', async () => {
  // 走真实路径：插件目录刻意没有 node_modules，DSH 的包在 profile 里
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const roots = profileCandidates(home);
  const r = await loadToolkit(roots);
  if (r.error) {
    // 未安装时必须是**结构化失败**，不能抛异常
    assert.match(r.error, /无法解析/);
    console.log('    [探测] 本地未能解析 dsh-tools（工具面将降级）:', r.error.split('\n')[0]);
  } else {
    assert.equal(typeof r.mod.defineTool, 'function');
    console.log('    [探测] 解析成功:', r.from);
  }
});

test('profileCandidates：包含默认 profile 与 profiles 根', () => {
  const got = profileCandidates('C:\\home\\.dsh');
  assert.ok(got.includes(join('C:\\home\\.dsh', 'profiles', 'web')), '应包含默认 web profile');
  assert.ok(got.includes(join('C:\\home\\.dsh', 'profiles')), '应包含 profiles 根');
});

test('契约：用**真实** defineTool 校验工具定义形状（解析不到则 skip）', async (t) => {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  const toolkit = await loadToolkit(profileCandidates(home));
  if (toolkit.error) {
    t.skip('本地未解析到 @deepseek-ai/dsh-tools');
    return;
  }
  // 这条断言的价值：defineTool 会校验 JSON schema，写错形状会**直接抛错**。
  // 实测抓到过两处：`required:false` 不被接受；`output` 必须是 `{schema:{...}}` 而不是裸 schema。
  const def = buildToolDefinition({ defineTool: toolkit.mod.defineTool, getSummary: () => summary });
  assert.equal(def.name, TOOL_NAME);
  assert.equal(typeof def.execute, 'function');
  assert.equal(typeof def.presentResult, 'function');
  // `output.render` 是**必填**：漏了它，模型每次调用都会失败于
  //   `returned invalid output: output.render failed: userRender is not a function`
  // —— 工具能被调用、却永远拿不到结果（实测踩过，代价是一次重启）。
  assert.equal(typeof def.output?.render, 'function', 'output.render 必须存在');
  const blocks = def.output.render({}, { ok: true, message: '人话摘要' });
  assert.ok(Array.isArray(blocks) && blocks.length > 0, 'render 必须返回非空 ContentBlock[]');
  assert.equal(blocks[0].type, 'text');
  assert.equal(blocks[0].text, '人话摘要');
  const out = await def.execute({ days: 3 }, { agent: { cwd: 'D:\\work\\alpha' } });
  assert.equal(out.ok, true);
  const miss = await def.execute({}, { agent: {} });
  assert.equal(miss.ok, false, '连 cwd 都没有时返回结构化失败，不抛异常');
})

test('★ 接线回归：index.apply 用 ctx.inject 启动子插件，并只给子插件它 inject 的服务', async (t) => {
  // 这条测试防的是**真实发生过的缺陷**：插件只 `inject=['webServer']`，
  // 而 apply 里直接读 `ctx.tools` / `ctx.commands` → 两个面静默跳过，
  // 用户看到「工具清单里没有这个插件、/fee 也不存在」。
  //
  // 判据的关键（**两次踩坑换来的**）：
  //   ① 子 ctx 上**只有**声明了的服务 —— 模拟 cordis 语义；
  //   ② 子插件 apply 的返回值必须**按 effect 规则校验**并抛错。
  //      实测踩过：`return registerSessionSurfaces(...)` 返回普通对象
  //      → cordis 抛 `Invalid effect` → 两个面双双消失。
  //      桩若不校验返回值，这条缺陷就测不出来（实际调试中曾如此）。
  // 这条测的是**接线**，不该由「本地装没装过 dsh」决定红绿。
  // 真实包 `@deepseek-ai/dsh-tools` 由宿主的「运行时解析」在宿主进程内提供，
  // 在 `node --test` 里解析不到 —— 那属于环境事实，不是接线缺陷；混在一起会
  // 产出假红（实测：2026-09-29 桌面版升级移除旧的全局 dsh 安装后即如此）。
  // 因此把解析目标钉到本仓库自带的**严格替身**，让接线成为唯一变量。
  const previousProfile = process.env.DSH_WORKSPACE_FEE_PROFILE;
  process.env.DSH_WORKSPACE_FEE_PROFILE = join(import.meta.dirname, 'fixtures', 'toolkit');
  t.after(() => {
    if (previousProfile === undefined) delete process.env.DSH_WORKSPACE_FEE_PROFILE;
    else process.env.DSH_WORKSPACE_FEE_PROFILE = previousProfile;
  });

  const { apply } = await import('../lib/index.js');
  const seen = { services: null, tool: null, command: null };
  const makeSubCtx = (services) => {
    const sub = { logger: { info() {}, warn() {} } };
    if (services.includes('tools')) sub.tools = { register: (d) => { seen.tool = d; } };
    if (services.includes('commands')) sub.commands = { register: (d) => { seen.command = d; } };
    return sub;
  };
  /** 复刻 cordis `safeCollect` 的校验：函数 / null / 可迭代 / 有 then 之外一律非法。 */
  const assertValidEffect = (e) => {
    if (typeof e === 'function') return;
    if (e === null || e === undefined) return;
    if (typeof e === 'object' && ('then' in e || Symbol.iterator in e || Symbol.asyncIterator in e)) return;
    throw new TypeError('Invalid effect');
  };
  const ctx = {
    webServer: { register: () => () => {} },
    effect: () => {},
    logger: { info() {}, warn() {} },
    inject: (services, cb) => {
      seen.services = services;
      const p = Promise.resolve(cb(makeSubCtx(services))).then((e) => {
        assertValidEffect(e); // ← 关键：桩要像真实运行时一样挑剔
        return e;
      });
      ctx.__injectPromise = p;
      return p;
    },
  };
  const out = apply(ctx, {});
  // 观察子插件启动本身：若回调返回值不合法，桩会以 Invalid effect 拒绝 —— 这里必须红，
  // 而不是变成一条无人观察的未处理拒绝。
  await ctx.__injectPromise;
  await out.surfacesPromise;
  assert.deepEqual(seen.services, ['tools', 'commands'], 'apply 必须经 ctx.inject 声明这两个服务');
  assert.equal(out.sessionSurfaces.tool, true, '工具面应注册成功');
  assert.equal(out.sessionSurfaces.command, true, '命令面应注册成功');
  assert.equal(seen.tool?.name, TOOL_NAME);
  assert.equal(seen.command?.name, COMMAND_NAME);
});

test('接线回归：ctx 没有 inject 时明确报告，而不是静默跳过', async () => {
  const { apply } = await import('../lib/index.js');
  const ctx = { webServer: { register: () => () => {} }, effect: () => {}, logger: { info() {}, warn() {} } };
  const out = apply(ctx, {});
  await out.surfacesPromise;
  assert.equal(out.sessionSurfaces.tool, false);
  assert.ok(
    out.sessionSurfaces.problems.some((p) => /ctx\.inject/.test(p)),
    '缺 ctx.inject 时必须给出明确原因（这正是之前静默跳过的形态）',
  );
});

test('registerSessionSurfaces：ctx 缺 tools/commands 时两个面各自降级且给出原因', async () => {
  const problems = [];
  const result = await registerSessionSurfaces({}, { getSummary: () => summary, warn: (m) => problems.push(m) });
  assert.equal(result.tool, false);
  assert.equal(result.command, false);
  assert.ok(result.problems.length >= 2, '工具面与命令面应各自给出原因');
  assert.ok(result.problems.some((p) => /ctx\.commands/.test(p)));
  assert.equal(problems.length, result.problems.length, '每个问题都应经 warn 报出');
});

test('registerSessionSurfaces：假 ctx 下两个面都能注册，且返回 disposer 被 effect 接管', async () => {
  const registered = { tool: null, command: null };
  const effects = [];
  const ctx = {
    tools: { register: (def) => { registered.tool = def; return () => { registered.tool = null; }; } },
    commands: { register: (def) => { registered.command = def; return () => { registered.command = null; }; } },
    effect: (fn, label) => { effects.push({ fn, label }); },
  };
  // 用「按 sessionId 变化」的 getSummary：s-2 模拟「该工作区窗口内无用量」
  // （summary 里没有它、current 也为 null），从而走到合成零花费那条分支。
  const scopedSummary = ({ sessionId }) =>
    sessionId === 's-2' ? { days: 7, workspaces: [], current: null } : summary;
  const result = await registerSessionSurfaces(ctx, { getSummary: scopedSummary });
  // 工具面依赖能否解析到 dsh-tools；命令面不依赖任何外部包，必须成功
  assert.equal(result.command, true, '命令面不应依赖外部包，必须注册成功');
  assert.equal(registered.command.name, COMMAND_NAME);
  // 命令 handler：会话身份取自 **agent.session.id / agent.session.cwd**
  // （实测形状；`invocation.input` 是元数据描述符，用户输入在 `rawInput`）
  const ok = await registered.command.handler({ agent: { session: { id: 's-1', cwd: 'D:\\work\\alpha' } }, rawInput: '' });
  assert.equal(ok.kind, 'success');
  assert.match(ok.text, /工作区「alpha」/);
  // cwd 明确但窗口内无记录 → 合成零花费条目（不是 error）
  const empty = await registered.command.handler({ agent: { session: { id: 's-2', cwd: 'D:\\elsewhere' } }, rawInput: '' });
  assert.equal(empty.kind, 'success');
  assert.match(empty.text, /没有用量记录|¥0/);
  // 连 cwd 都没有 → 真正的定位失败
  const bad = await registered.command.handler({ agent: {}, rawInput: '' });
  assert.equal(bad.kind, 'error');
  assert.match(bad.text, /无法/);
  // 命令 handler 的 days 来自 **rawInput**
  const thirty = await registered.command.handler({ agent: { session: { id: 's-1', cwd: 'D:\\work\\alpha' } }, rawInput: ' 30 ' });
  assert.match(thirty.text, /近 30 天/);
  // 回归：若误用 invocation.input（元数据对象），days 会永远是 7
  const wrongField = await registered.command.handler({ agent: { session: { id: 's-1', cwd: 'D:\\work\\alpha' } }, input: ' 30 ' });
  assert.match(wrongField.text, /近 7 天/, '必须读 rawInput；input 是描述符，读它只会得到默认值');
  // **生命周期不靠 ctx.effect**：注册发生在调用方 ctx.inject 的子插件作用域内，
  // 卸载由 cordis 随子插件清理。实测：额外包一层 ctx.effect 会在真实运行时抛
  // `Invalid effect`，把两个面一起打掉 —— 所以这里断言**不**碰 ctx.effect。
  assert.equal(effects.length, 0, '不应再额外包 ctx.effect（真实运行时会抛 Invalid effect）');
});

test('registerSessionSurfaces：ctx.tools.register 抛错被吞下并计入 problems', async () => {
  const ctx = {
    tools: { register: () => { throw new Error('registry exploded'); } },
    commands: { register: () => () => {} },
    effect: () => {},
  };
  const result = await registerSessionSurfaces(ctx, { getSummary: () => summary });
  // 工具面失败（无论因解析还是抛错）不得影响命令面
  assert.equal(result.command, true);
  if (result.tool === false) assert.ok(result.problems.some((p) => /工具/.test(p)));
});

test('替身自证：fixtures/toolkit 的 defineTool 复刻了真实会抛的那些错', async () => {
  // 测试纪律：替身只复刻接口形状等于没测。这里断言替身**确实会抛**真实实现
  // 会抛的那几个错；替身一旦被改宽，上面那条接线断言就同时失去判据强度。
  const { defineTool } = await import('./fixtures/toolkit/node_modules/@deepseek-ai/dsh-tools/index.js');
  const base = {
    name: 'x',
    description: 'd',
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 't' }] },
    execute: async () => ({}),
  };
  assert.equal(defineTool(base).name, 'x', '合法定义必须通过');
  assert.throws(() => defineTool({ ...base, output: { schema: {} } }), /output\.render is required/);
  assert.throws(() => defineTool({ ...base, output: { render: () => [] } }), /output\.schema/);
  assert.throws(
    () => defineTool({ ...base, parameters: { days: { type: 'integer', required: false } } }),
    /unsupported JSON schema/,
    'required:false 是真实实现明确拒绝的形状',
  );
  assert.throws(() => defineTool({ ...base, timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => defineTool({ ...base, name: '   ' }), /name/);
  assert.throws(() => defineTool({ ...base, execute: undefined }), /execute/);
  // 阳性对照：真实实现接受 `required: true`，替身不得把它一并拒掉（否则是「更严格到失真」）。
  assert.equal(
    defineTool({ ...base, parameters: { days: { type: 'integer', required: true } } }).name,
    'x',
    'required:true 是合法形状，替身必须接受',
  );
});
