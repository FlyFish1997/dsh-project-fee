/**
 * 会话可调用的两个面：
 *   1. **模型工具** `workspace_fee` —— 模型能自己调用，于是你可以直接问「这个工作区花了多少钱」。
 *   2. **斜杠命令** `/fee` —— 你在交互式 UI 里直接看结果，**不产生模型消息**（不烧 token）。
 *
 * 两者都走同一份纯逻辑（`lib/fee-query.js`），且都从 `agent.cwd` / `sessionId`
 * **零参数**定位当前工作区 —— 你不需要告诉它你在哪个工作区。
 *
 * 关于依赖：本插件的其余部分刻意零 `@deepseek-ai/*` 依赖。工具面需要的
 * `defineTool` 通过**运行时解析**获取（先试插件自身，再试 profile 的 node_modules）；
 * 拿不到时**只禁用工具面并如实回报原因**，绝不让整个插件装不上。
 *
 * @module dsh-workspace-fee/host-tools
 */
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { queryWorkspaceFee } from './fee-query.js';

/** 工具对模型暴露的名字。 */
export const TOOL_NAME = 'workspace_fee';
/** 斜杠命令名（不带斜杠）。 */
export const COMMAND_NAME = 'fee';

/**
 * 猜测 DSH 安装位置，供 `@deepseek-ai/dsh-tools` 解析使用。
 *
 * 为什么需要：本插件以 `link:` 形式装在 profile 里，但**它自己的目录没有 node_modules**
 * （刻意零依赖），所以 `import '@deepseek-ai/dsh-tools'` 在插件目录的解析上下文里必然失败。
 * DSH 自己的包在 profile 的 node_modules 下，因此要把 profile 目录作为解析锚点。
 *
 * 候选（按可靠性排序）：
 *   ① 环境变量 `DSH_WORKSPACE_FEE_PROFILE`（显式指定，最高优先）
 *   ② 进程参数里的 `--profile <名字>`（DSH 启动方式）
 *   ③ `<DSH_HOME>/profiles/web`（默认 profile 名）
 *   ④ `<DSH_HOME>/profiles`
 *
 * @param {string} home DSH home
 * @returns {string[]}
 */
export function profileCandidates(home) {
  const out = [];
  const explicit = process.env.DSH_WORKSPACE_FEE_PROFILE;
  if (typeof explicit === 'string' && explicit.trim() !== '') out.push(explicit.trim());
  const argv = Array.isArray(process.argv) ? process.argv : [];
  const i = argv.findIndex((a) => a === '--profile');
  if (i >= 0 && typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('-')) out.push(argv[i + 1]);
  if (typeof home === 'string' && home !== '') {
    out.push(join(home, 'profiles', 'web'));
    out.push(join(home, 'profiles'));
  }
  return [...new Set(out)];
}

/**
 * 运行时解析 `@deepseek-ai/dsh-tools`。
 *
 * 候选锚点：① 显式传入的 roots；② profile 目录；③ 本插件自身；④ cwd。
 * 每个锚点都用一个假的 `noop.js` 路径建 `createRequire`，让它按 Node 的常规
 * 向上查找规则去找包（插件目录 → 上级 node_modules）。
 *
 * @param {string[]} roots 额外的解析根（例如 profile 目录）
 * @returns {Promise<{mod: object, from: string}|{error: string}>}
 */
export async function loadToolkit(roots = []) {
  const candidates = [];
  for (const root of roots) {
    if (typeof root === 'string' && root !== '') candidates.push(join(root, 'noop.js'));
  }
  candidates.push(import.meta.url, join(process.cwd(), 'noop.js'));
  const tried = [];
  const seen = new Set();
  for (const anchor of candidates) {
    if (seen.has(anchor)) continue;
    seen.add(anchor);
    try {
      const require = createRequire(anchor);
      const resolved = require.resolve('@deepseek-ai/dsh-tools');
      const mod = await import(pathToFileURL(resolved).href);
      if (typeof mod?.defineTool === 'function') return { mod, from: resolved };
      tried.push(`${anchor} → 解析到 ${resolved} 但没有 defineTool 导出`);
    } catch (error) {
      tried.push(`${anchor} → ${error?.code ?? error?.message ?? String(error)}`);
    }
  }
  return { error: `无法解析 @deepseek-ai/dsh-tools。已尝试：\n  - ${tried.join('\n  - ')}` };
}

/**
 * 构造模型的工具定义对象（不注册）。
 * @param {object} deps
 * @param {Function} deps.defineTool
 * @param {() => object} deps.getSummary 取账本 summary（由调用方注入，便于测试）
 * @returns {object}
 */
export function buildToolDefinition({ defineTool, getSummary }) {
  return defineTool({
    name: TOOL_NAME,
    description:
      '查询**当前工作区**的 token 消耗与费用（人民币）。无需参数：工作区取自当前会话的 cwd。' +
      '返回今日花费、累计花费、近 N 天花费、token 分档（缓存命中/未命中/输出）、' +
      '以及两条预警线（日线/总线）的状态。数字按 DeepSeek 官方刊例价**估算**，不是账单实付额。',
    parameters: {
      days: {
        type: 'integer',
        description: '回溯天数，用于「窗口内花费」与 token 分档；默认 7，范围 1–90。',
        // 不写 required（缺省即可选）。实测：required 存在时必须是 true，
        // 写 required:false 会被 defineTool 以「unsupported JSON schema」拒绝。
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: true,
        properties: {
          ok: { type: 'boolean', description: '是否成功定位到工作区' },
          reason: { type: 'string', description: 'ok=false 时说明原因' },
          message: { type: 'string', description: '一句人话摘要（可直接展示给用户）' },
        },
      },
      // `render` 是**必填**：工具输出必须投影成模型可见的 ContentBlock[]。
      // 实测漏了它 → 模型每次调用都失败：
      //   `tool "workspace_fee" returned invalid output: output.render failed: userRender is not a function`
      // 表现为「工具能被调用，但永远拿不到结果」。这是宿主工具契约里最容易漏的一格。
      render(_args, value) {
        const text =
          value && typeof value.message === 'string' && value.message !== ''
            ? value.message
            : JSON.stringify(value ?? null);
        return [{ type: 'text', text }];
      },
    },
    async execute(args, exec) {
      const days = clampDays(args?.days);
      const who = agentIdentity(exec?.agent);
      const summary = getSummary({ days, sessionId: who.sessionId });
      return queryWorkspaceFee(summary, { sessionId: who.sessionId, cwd: who.cwd, days });
    },
    // 供 Host 本地消费方（非模型面）使用：一句人话摘要
    presentResult(value) {
      if (!value || value.ok !== true) return value?.message ?? '费用查询失败';
      return value.message;
    },
  });
}

/**
 * 从 agent 取出「会话身份」（sessionId + cwd）。
 *
 * 实测（读了内置插件源码后才对的）：
 *   - 会话 id 在 **`agent.session.id`**，不是 `agent.sessionId`；
 *     内置插件一律写 `invocation.agent.session.id`。
 *   - `Agent` 接口**不直接暴露 cwd**（`cwd` 在 `AgentSetupCommit` 上，不在 Agent 上）。
 * 这里按多路径兜底，任一条命中都能定位工作区。
 *
 * 教训：这两个字段名我是**猜的**，于是 `/fee` 能跑但报「定位不到工作区」。
 * 凡是读宿主对象，必须先看内置插件的真实用法。
 *
 * @param {object} agent
 * @returns {{sessionId: string|null, cwd: string|null}}
 */
export function agentIdentity(agent) {
  if (!agent || typeof agent !== 'object') return { sessionId: null, cwd: null };
  const session = agent.session && typeof agent.session === 'object' ? agent.session : null;
  const pick = (...vals) => {
    for (const v of vals) if (typeof v === 'string' && v !== '') return v;
    return null;
  };
  return {
    sessionId: pick(agent.sessionId, session?.id, agent.id),
    cwd: pick(
      agent.cwd,
      session?.cwd,
      session?.header?.cwd,
      session?.metadata?.cwd,
      session?.creation?.cwd,
    ),
  };
}

function clampDays(value) {
  // `Number('')` 是 0（不是 NaN），若直接钳制会变成 1 天 ——
  // 实测：`/fee` 不带参数时窗口显示成「近 1 天」。空输入必须回到默认值。
  const text = typeof value === 'string' ? value.trim() : value;
  if (text === '' || text === null || text === undefined) return 7;
  const n = Number(text);
  if (!Number.isFinite(n)) return 7;
  return Math.min(90, Math.max(1, Math.trunc(n)));
}

/**
 * 注册模型工具 + 斜杠命令。
 *
 * 两个面**各自独立降级**：工具面失败不影响命令面，反之亦然；
 * 失败原因汇总到返回值里，由 `lib/index.js` 打日志并放进 `/health` 的诊断。
 *
 * @param {object} ctx cordis 上下文
 * @param {object} opts
 * @param {() => object} opts.getSummary
 * @param {string[]} [opts.resolveRoots] 额外解析根（profile 目录）
 * @param {(msg: string) => void} [opts.warn]
 * @returns {Promise<{tool: boolean, command: boolean, problems: string[]}>}
 */
export async function registerSessionSurfaces(ctx, { getSummary, resolveRoots = [], warn = () => {} }) {
  const problems = [];
  let tool = false;
  let command = false;

  // ── 模型工具 ──────────────────────────────────────────────────────────
  //
  // 生命周期：**不额外包 ctx.effect**。这两个注册都发生在调用方 `ctx.inject([...], cb)`
  // 的**子插件作用域**内 —— 子插件卸载时 cordis 会自行清理它的注册。再包一层 effect
  // 既多余，也会与真实运行时冲突（实测报 `Invalid effect`，导致两个面一起失败）。
  const toolkit = await loadToolkit(resolveRoots);
  if (toolkit.error) {
    problems.push(`模型工具未注册：${toolkit.error}`);
  } else if (typeof ctx?.tools?.register !== 'function') {
    problems.push('模型工具未注册：当前组合没有 ctx.tools（缺少 dsh-tools 服务）');
  } else {
    try {
      const definition = buildToolDefinition({ defineTool: toolkit.mod.defineTool, getSummary });
      ctx.tools.register(definition);
      tool = true;
    } catch (error) {
      problems.push(`模型工具注册抛错：${error?.message ?? error}`);
    }
  }

  // ── 斜杠命令 ──────────────────────────────────────────────────────────
  if (typeof ctx?.commands?.register !== 'function') {
    problems.push('斜杠命令未注册：当前组合没有 ctx.commands（缺少 dsh-commands 服务）');
  } else {
    try {
      ctx.commands.register({
        name: COMMAND_NAME,
        description: '查看当前工作区的花费与预警状态（不产生模型消息）',
        input: { hint: '[天数，默认 7]' },
        handler: async (invocation) => {
          // 文本参数是 **`rawInput`**；`invocation.input` 是元数据描述符，不是用户输入。
          const raw = typeof invocation?.rawInput === 'string' ? invocation.rawInput : '';
          const days = clampDays(raw.trim());
          const who = agentIdentity(invocation?.agent);
          const summary = getSummary({ days, sessionId: who.sessionId });
          const result = queryWorkspaceFee(summary, { sessionId: who.sessionId, cwd: who.cwd, days });
          if (result.ok !== true) {
            // 把**实际取到的身份**写进报错：定位失败时最需要知道的就是
            // 「哪个字段是空的」，否则只能靠猜（实际调试中容易因此反复）。
            const diag = `（诊断：sessionId=${who.sessionId ?? 'null'}；cwd=${who.cwd ?? 'null'}）`;
            return { kind: 'error', text: `${result.message}${diag}` };
          }
          return { kind: 'success', text: result.message };
        },
      });
      command = true;
    } catch (error) {
      problems.push(`斜杠命令注册抛错：${error?.message ?? error}`);
    }
  }

  for (const p of problems) warn(p);
  return { tool, command, problems };
}
