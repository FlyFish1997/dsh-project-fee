/**
 * Client-bundle contract test for lib/client.js.
 *
 * Dependency-free: the hand-written bundle is executed inside a `node:vm` sandbox
 * with a stub `window.__ModuleLoader__`, a stub `require` (fake React / jsx-runtime)
 * and a stub `fetch`, then the real components are driven through the module's own
 * slot registration. The judged condition for "passed" is this process's exit code.
 *
 * Covered:
 *   a) the source parses (string/comment-aware bracket balance + vm.Script compile)
 *   b) the top level calls window.__ModuleLoader__.load exactly once
 *   c) in the sandbox, module.exports is { name, inject:['slots'], apply } and
 *      `apply` really runs, registering only into the whitelisted Session-header slot
 *   d) the registration hands back a disposer and the plugin effect releases it
 *   e) the header capsule renders a compact pill and the panel opens
 *   f) the loaded panel renders the required views (workspace bars, per-day trend,
 *      token detail, per-day bill, alert editor, pricing) for a canonical v1 payload
 *   g) loading / host-unreachable / empty / non-JSON states each render a visible
 *      message instead of a blank screen
 *   h) editing an alert line and blurring posts { alerts: { <id>: { limit } } }
 *   h2) a non-numeric threshold is refused locally and never posted
 *   i) Escape on document triggers the panel's close path
 *   j) the bundle paints with DSH theme variables, has titles/labels, and carries no
 *      hardcoded light background, no chart library and no ESM syntax
 *   k) package.json declares the browser half consistently
 */

import { readFileSync } from 'node:fs';
import { Script, createContext } from 'node:vm';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CLIENT = join(ROOT, 'lib', 'client.js');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

const WHITELIST = ['conversation.session.header.utilities', 'conversation.session.header.corner'];
const FORBIDDEN_SINGLE_SLOTS = ['main', 'sidebar', 'rightbar', 'conversation.session.header', 'conversation.session'];
const ALLOWED_REQUIRES = ['react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'];

/**
 * One shared fake React for the whole run: the renderer installs its hook
 * dispatcher onto this object, and every sandbox hands the very same instance to
 * the bundle through the stub `require`. A per-env instance would silently detach
 * the dispatcher and every hook call would throw.
 */
const FAKE_REACT = makeFakeReact();

/* -------------------------------------------------------------------------- *
 * stub environment
 * -------------------------------------------------------------------------- */

/** Fake React whose hooks are synchronously bound to the component being rendered. */
function makeFakeReact() {
	return {
		createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
		useState: () => { throw new Error('hook dispatcher not installed'); },
		useRef: () => { throw new Error('hook dispatcher not installed'); },
		useMemo: () => { throw new Error('hook dispatcher not installed'); },
		useCallback: () => { throw new Error('hook dispatcher not installed'); },
		useEffect: () => {},
		useLayoutEffect: () => {},
		Fragment: Symbol.for('react.fragment')
	};
}

function jsxRuntimeStub() {
	return {
		jsx: (type, props) => ({ type, props: props ?? {} }),
		jsxs: (type, props) => ({ type, props: props ?? {} }),
		Fragment: Symbol.for('react.fragment')
	};
}

/**
 * Build a fetch stub.
 * @param {(call: {url: string, opts: object}) => any} responder - returns
 *   {status, body}, a raw string body, an Error to reject with, or a Promise like fetch.
 */
function makeFakeFetch(responder) {
	const calls = [];
	const fake = (url, opts) => {
		const call = { url: String(url), opts: opts ?? {} };
		calls.push(call);
		const result = responder(call);
		if (result instanceof Error) return Promise.reject(result);
		if (result && typeof result.then === 'function') return result;
		if (typeof result === 'string') {
			return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(result) });
		}
		return Promise.resolve({
			ok: result.status >= 200 && result.status < 300,
			status: result.status,
			text: () => Promise.resolve(JSON.stringify(result.body))
		});
	};
	fake.calls = calls;
	fake.posts = () => calls.filter((c) => c.opts && c.opts.method === 'POST');
	return fake;
}

/**
 * A `/summary` payload in the real Host shape (docs/SPEC.md §2): `current` is the
 * same object as the matching entry in `workspaces`, alerts carry the Host's own
 * `level`, and token buckets are cachedInput/uncachedInput/output/reasoning.
 */
function canonicalSummary(overrides = {}) {
	const fee = {
		key: '--D-path-to-repo--',
		workspaceId: '--D-path-to-repo--',
		label: 'dsh-project-fee',
		cwd: 'D:\\path\\to\\dsh-workspace-fee',
		cwdSource: 'session-log',
		sessions: 3,
		usageRecords: 30,
		firstTime: 1789500000000,
		lastTime: 1789580000000,
		// Real Host token shape (raw log keys), with `inputTokens` including cacheRead.
		tokens: { inputTokens: 1900000, cacheReadTokens: 1000000, outputTokens: 200000, reasoningTokens: 40000, totalTokens: 3100000 },
		cost: 4.2,
		todayCost: 1.23,
		lifetimeCost: 9.9,
		alert: { limit: 5, level: 'ok' }
	};
	const exampleApp = {
		key: '--D-work-example-app--',
		workspaceId: '--D-work-example-app--',
		label: 'example-app',
		cwd: 'D:\\work\\example-app',
		cwdSource: 'session-log',
		sessions: 1,
		usageRecords: 12,
		firstTime: 1789400000000,
		lastTime: 1789570000000,
		tokens: { inputTokens: 300, cacheReadTokens: 100, outputTokens: 300, reasoningTokens: 0, totalTokens: 700 },
		cost: 2.3,
		todayCost: 2.3,
		lifetimeCost: 2.3,
		alert: { limit: 1, level: 'over' }
	};
	return {
		ok: true,
		generatedAt: 1789581447874,
		days: 7,
		current: fee,
		currentSessionId: 'session-under-test',
		totals: { tokens: 5000000, cost: 6.5 },
		workspaces: [fee, exampleApp],
		daily: [
			{
				date: '2026-09-16',
				workspaceKey: fee.key,
				workspaceId: fee.key,
				label: 'dsh-project-fee',
				cost: 2.0,
				tokens: { inputTokens: 900, cacheReadTokens: 500, outputTokens: 100, reasoningTokens: 0, totalTokens: 1500 },
				sessions: 2
			},
			{
				date: '2026-09-17',
				workspaceKey: fee.key,
				workspaceId: fee.key,
				label: 'dsh-project-fee',
				cost: 2.2,
				tokens: { inputTokens: 1000, cacheReadTokens: 500, outputTokens: 100, reasoningTokens: 0, totalTokens: 1600 },
				sessions: 1
			},
			{
				date: '2026-09-17',
				workspaceKey: exampleApp.key,
				workspaceId: exampleApp.key,
				label: 'example-app',
				cost: 2.3,
				tokens: { inputTokens: 300, cacheReadTokens: 100, outputTokens: 300, reasoningTokens: 0, totalTokens: 700 },
				sessions: 1
			}
		],
		currency: 'CNY',
		...overrides
	};
}

/**
 * A `/config` payload in the real Host shape (docs/SPEC.md §2): the panel-facing
 * keys sit at the top level, alert limits are always `{ limit }`, version ids live
 * on `id`, and `alertDefaults.warnRatio` drives the warn boundary.
 */
function canonicalConfig() {
	return {
		ok: true,
		generatedAt: '2026-09-17T12:28:36.845Z',
		currency: 'CNY',
		alerts: {
			'--D-path-to-repo--': { limit: 5 },
			'--D-work-example-app--': { limit: 1 }
		},
		alertDefaults: { defaultLimit: null, warnRatio: 0.8 },
		pricing: {
			activeVersionId: 'builtin-2026-09-10',
			currency: 'CNY',
			effectiveFrom: '2026-09-10T12:00:00+08:00',
			peakMultiplier: 2,
			fallbackTier: 'flash',
			versions: [
				{
					id: 'builtin-2026-09-10',
					effectiveFrom: 1789531200000,
					note: '内置官方价（2026-09-10T12:00:00+08:00 起生效）',
					builtin: true,
					models: {
						flash: {
							segments: [
								{ id: 'flash-peak-1', label: '高峰 09:00-12:00', days: [1, 2, 3, 4, 5], from: '09:00', to: '12:00', hit: 0.04, miss: 2, out: 8 },
								{ id: 'flash-offpeak-all', label: '空闲兜底（含周末全天）', days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '24:00', hit: 0.02, miss: 1, out: 4 }
							]
						},
						pro: {
							segments: [
								{ id: 'pro-offpeak', label: '空闲', days: [1, 2, 3, 4, 5, 6, 7], from: '00:00', to: '24:00', hit: 0.15, miss: 4.5, out: 13.5 }
							]
						}
					}
				}
			]
		},
		config: {
			pricing: { currency: 'CNY', fallbackFamily: 'flash', models: { 'deepseek-flash': 'flash' } },
			alerts: { defaultLimit: null, warnRatio: 0.8, workspaces: { '--D-work-example-app--': 1 } }
		},
		source: { pricing: 'default', alerts: 'file', settingsAvailable: false },
		problems: []
	};
}

/**
 * Load the bundle in a stub browser sandbox.
 * @param {{fetchImpl?: Function}} [options] - optional fetch stub.
 * @returns {object} sandbox observations used by the assertions.
 */
function loadBundle(options = {}) {
	const src = readFileSync(CLIENT, 'utf8');
	const loads = [];
	const requested = [];
	const registrations = [];
	const disposersCalled = [];
	const effects = [];
	const listeners = {};
	const styleTags = [];

	const fakeReact = FAKE_REACT;

	const makeRequire = () => (id) => {
		requested.push(id);
		if (id === 'react') return fakeReact;
		if (id === 'react/jsx-runtime') return jsxRuntimeStub();
		if (id === '@deepseek-ai/dsh-client-ui-primitives') return {};
		throw new Error(`stub require got an unexpected module: ${id}`);
	};

	const fetchImpl = options.fetchImpl ?? makeFakeFetch(() => ({ status: 200, body: canonicalSummary() }));

	const doc = {
		head: { appendChild: (tag) => { styleTags.push(tag); } },
		createElement: () => ({ dataset: {}, textContent: '' }),
		querySelector: () => null,
		addEventListener: (type, fn) => { (listeners[type] ||= []).push(fn); },
		removeEventListener: (type, fn) => {
			if (!listeners[type]) return;
			listeners[type] = listeners[type].filter((f) => f !== fn);
		},
		fire: (type, event) => { (listeners[type] || []).slice().forEach((fn) => fn(event)); }
	};

	const storage = new Map();
	const timers = [];
	const window = {
		__ModuleLoader__: { load: (arg) => { loads.push(arg); } },
		localStorage: {
			getItem: (k) => (storage.has(k) ? storage.get(k) : null),
			setItem: (k, v) => { storage.set(k, String(v)); },
			removeItem: (k) => { storage.delete(k); }
		}
	};

	const sandbox = {
		window,
		document: doc,
		fetch: fetchImpl,
		console,
		setTimeout,
		clearTimeout,
		setInterval: (fn) => {
			// Intervals are recorded, never auto-run: a test fires them explicitly.
			timers.push(fn);
			return timers.length;
		},
		clearInterval: () => {},
		AbortController,
		URL,
		Math,
		JSON,
		Date,
		Error,
		Number,
		String,
		Object,
		Array,
		Symbol,
		isFinite,
		parseInt
	};
	sandbox.globalThis = sandbox;
	sandbox.self = sandbox;

	new Script(src, { filename: 'lib/client.js' }).runInContext(createContext(sandbox), { timeout: 10000 });

	const ctx = {
		effect: (fn, label) => { const d = fn(); effects.push({ dispose: d, label }); },
		slots: {
			inject: (key, fn) => {
				const out = fn();
				return typeof out === 'function' ? out : () => {};
			},
			register: (meta, Component) => {
				registrations.push({ meta, Component });
				return () => { disposersCalled.push(meta.id); };
			}
		}
	};

	return {
		src, loads, requested, registrations, disposersCalled, effects, doc, listeners,
		styleTags, storage, window, ctx, fakeReact, fetchImpl, makeRequire,
		timerCount: () => timers.length,
		fireTimers: () => timers.slice().forEach((fn) => fn()),
		instanceId: makeInstanceId()
	};
}

let instanceSeq = 0;
function makeInstanceId() {
	instanceSeq++;
	return 'env' + instanceSeq;
}

/* -------------------------------------------------------------------------- *
 * a small synchronous renderer for the plain {type, props} tree
 *
 * Each component instance gets its own fiber (hooks + deps) keyed by its path
 * down the tree, and hooks are dispatched to the innermost fiber. Rendering the
 * same tree again therefore behaves like React: state persists, setters update
 * the next render, and a nested component never steals its parent's hook slots.
 * -------------------------------------------------------------------------- */

function createRenderer(fakeReact) {
	const fibers = new Map();
	let stack = [];
	let instanceId = 'env0';
	const pendingEffects = [];

	const dispatch = {
		useState(init) {
			const f = currentFiber();
			const i = f.hookIndex++;
			if (!(i in f.hooks)) f.hooks[i] = typeof init === 'function' ? init() : init;
			return [f.hooks[i], (next) => { f.hooks[i] = typeof next === 'function' ? next(f.hooks[i]) : next; }];
		},
		useRef(init) {
			const f = currentFiber();
			const i = f.hookIndex++;
			if (!(i in f.hooks)) f.hooks[i] = { current: init };
			return f.hooks[i];
		},
		useMemo(fn) {
			const f = currentFiber();
			f.hookIndex++;
			return fn();
		},
		useCallback(fn, deps) {
			const f = currentFiber();
			const i = f.hookIndex++;
			const prev = f.deps[i];
			if (prev && sameDeps(prev, deps)) return f.hooks[i];
			f.hooks[i] = fn;
			f.deps[i] = deps;
			return fn;
		},
		/**
		 * Effects run after the synchronous pass (like React's commit phase). A
		 * recorded cleanup runs before the next execution of the same effect, and the
		 * effect only re-runs when its dependencies change.
		 */
		useEffect(fn, deps) {
			const f = currentFiber();
			const i = f.hookIndex++;
			const prev = f.deps[i];
			const changed = !prev || !sameDeps(prev, deps);
			f.deps[i] = deps;
			if (!changed) return;
			pendingEffects.push({ fiber: f, slot: i, fn });
		}
	};

	function sameDeps(a, b) {
		if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
		return true;
	}

	function currentFiber() {
		const f = stack[stack.length - 1];
		if (!f) throw new Error('hook called outside a render pass');
		return f;
	}

	fakeReact.useState = dispatch.useState;
	fakeReact.useRef = dispatch.useRef;
	fakeReact.useMemo = dispatch.useMemo;
	fakeReact.useCallback = dispatch.useCallback;
	fakeReact.useEffect = dispatch.useEffect;
	fakeReact.useLayoutEffect = dispatch.useEffect;
	fakeReact.__clearFibers = () => { fibers.clear(); stack = []; };

	const counters = { elem: 0, byKey: {} };
	/**
	 * Element node -> fiber identity, so a later walk reuses the very fibre that
	 * render created (otherwise a walk's own fibre would take the state setters and
	 * the render would never see them).
	 */
	const nodeFiber = new WeakMap();
	/** Element node -> its last rendered output, so a walk visits the same fiber tree. */
	const nodeOutput = new WeakMap();
	/**
	 * Element node -> the element tree it rendered last time. `collect` walks THIS,
	 * not `nodeOutput` (which holds the serialized string), so no component body is
	 * re-executed and the traversal cannot manufacture fresh, unmapped elements.
	 */
	const nodeRenderedChildren = new WeakMap();

	/**
	 * Serialize the element tree to markup-like text (tags + classes + attributes),
	 * so assertions can look for both visible copy and the classes/attributes the
	 * bundle sets. Text nodes are emitted verbatim.
	 */
	function render(node, key = '0') {
		if (node === null || node === undefined || node === false || node === true) return '';
		if (typeof node === 'string' || typeof node === 'number') return String(node);
		if (Array.isArray(node)) {
			// Flatten: jsx children commonly arrive as arrays nested inside arrays
			// (e.g. the 2-arity form `jsx('div', { children: [a, b] })`).
			return node.map((child, i) => render(child, `${key}.${i}`)).join('');
		}
		const props = node.props ?? {};
		if (typeof node.type === 'function') {
			const fiberKey = `${instanceId}|${key}|${node.type.name || 'anon'}`;
			let fiber = fibers.get(fiberKey);
			if (!fiber) {
				fiber = { hooks: [], deps: [], hookIndex: 0 };
				fibers.set(fiberKey, fiber);
			}
			fiber.hookIndex = 0;
			nodeFiber.set(node, fiber);
			stack.push(fiber);
			let rendered;
			try {
				rendered = node.type(props);
			} catch (err) {
				stack.pop();
				const wrapped = new Error(`component ${node.type.name || 'anon'} threw: ${err && err.message ? err.message : err}`);
				wrapped.cause = err;
				throw wrapped;
			}
			stack.pop();
			const childOut = render(rendered, fiberKey);
			nodeOutput.set(node, childOut);
			nodeRenderedChildren.set(node, rendered);
			return childOut;
		}
		counters.elem++;
		counters.byKey[key] = (counters.byKey[key] ?? 0) + 1;
		const inner = render(props.children !== undefined ? props.children : node.children, key);
		const attrs = [];
		if (props.className) attrs.push(`class="${String(props.className)}"`);
		if (props.title) attrs.push(`title="${String(props.title)}"`);
		if (props['aria-label']) attrs.push(`aria-label="${String(props['aria-label'])}"`);
		if (props.role) attrs.push(`role="${String(props.role)}"`);
		if (props.placeholder) attrs.push(`placeholder="${String(props.placeholder)}"`);
		if (props.value !== undefined && props.value !== null) attrs.push(`value="${String(props.value)}"`);
		if (props.href) attrs.push(`href="${String(props.href)}"`);
		const tag = typeof node.type === 'symbol' ? 'fragment' : String(node.type);
		return `<${tag}${attrs.length > 0 ? ' ' + attrs.join(' ') : ''}>${inner}</${tag}>`;
	}

	return {
		render,
		currentFiber,
		counters,
		/** Start a fresh component instance namespace for one sandbox. */
		forInstance(id) { instanceId = id; fibers.clear(); stack = []; },
		reset: () => { fibers.clear(); stack = []; pendingEffects.length = 0; },
		/** How many effects are waiting to run in the current commit. */
		pendingCount: () => pendingEffects.length,
		/** Run the effects committed since the last flush (React's commit phase). */
		flushEffects() {
			const queue = pendingEffects.splice(0, pendingEffects.length);
			for (const eff of queue) {
				const prevCleanup = eff.fiber.hooks[eff.slot];
				if (typeof prevCleanup === 'function') {
					try { prevCleanup(); } catch (err) { void err; }
				}
				let cleanup;
				try {
					cleanup = eff.fn();
				} catch (err) {
					throw new Error(`effect at hook ${eff.slot} threw: ${err && err.message ? err.message : err}`);
				}
				eff.fiber.hooks[eff.slot] = typeof cleanup === 'function' ? cleanup : null;
			}
		},
		/**
		 * Walk the last render's tree and return every element whose props satisfy
		 * `pred`. The walk reuses the render-time fibres (via the node identity maps),
		 * so a handler found here closes over the same state the render reads.
		 */
		/**
		 * Walk the element tree produced by the last render and return every node whose
		 * props satisfy `pred`. Component bodies are NOT re-executed: the traversal
		 * follows the children each component actually rendered last time, so handlers
		 * found here belong to the same fibre the render read its state from.
		 */
		collect(node, pred) {
			const hits = [];
			visit(node, 'c');
			return hits;

			function visit(current, curKey) {
				if (current === null || current === undefined) return;
				if (typeof current === 'string' || typeof current === 'number') return;
				if (Array.isArray(current)) {
					current.forEach((child, i) => visit(child, `${curKey}.${i}`));
					return;
				}
				if (typeof current !== 'object') return;
				const props = current.props ?? {};
				if (pred(current, props)) hits.push(current);
				if (typeof current.type === 'function') {
					const renderedChildren = nodeRenderedChildren.get(current);
					if (renderedChildren === undefined) return; // not part of the last render
					visit(renderedChildren, curKey);
					return;
				}
				visit(props.children !== undefined ? props.children : current.children, curKey);
			}
		}
	};
}

const renderer = createRenderer(FAKE_REACT);

/** Render a component tree to a searchable markup-ish string (effects are not run). */
function renderTree(node) {
	return renderer.render(node);
}

/** Find a node by its aria-label (component bodies are walked via recorded children). */
function byLabel(element, ariaLabel) {
	const hits = renderer.collect(element, (n, p) => p['aria-label'] === ariaLabel);
	return hits[0] ?? null;
}

/** Render and then run the effects the render committed (like React's commit phase). */
function renderAndFlush(node) {
	const html = renderer.render(node);
	renderer.flushEffects();
	return html;
}

/** Find the first node in the tree carrying `propName` as a function. */
function findApplier(node, propName) {
	const hits = renderer.collect(node, (n, p) => typeof p[propName] === 'function');
	return hits.length > 0 ? hits[0].props[propName] : undefined;
}

/** Every element in the tree carrying `propName` as a function. */
function collectByProp(node, propName) {
	return renderer.collect(node, (n, p) => typeof p[propName] === 'function');
}

/** 收集预警线输入框：它们都带 onBlur 且 className 为 dshfee-input。 */
function alertInputs(node) {
	return renderer.collect(node, (n, p) => typeof p.onBlur === 'function' && typeof p.className === 'string' && p.className.includes('dshfee-input'));
}

/** Pick the alert-threshold input (its value is a threshold, not an empty/date field). */
function pickAlertInput(node) {
	const candidates = renderer.collect(node, (n, p) => typeof p.onBlur === 'function' && typeof p.value === 'string');
	const numeric = candidates.filter((c) => c.props.value !== '' && /^[0-9.]+$/.test(String(c.props.value)));
	return numeric[0] ?? candidates[0];
}

/**
 * Mount the capsule, click it, and return the capsule element plus its props.
 * The returned element's children already include the open panel.
 */
function openPanel(env) {
	const mod = env.loads[0].factory(env.makeRequire());
	mod.apply(env.ctx);
	const entry = env.registrations.find((r) => r.meta.name === 'conversation.session.header.utilities');
	assert.ok(entry, 'the capsule must be registered');
	const element = { type: entry.Component, props: { sessionId: 'session-under-test' } };
	renderer.forInstance(env.instanceId);

	renderAndFlush(element);
	const onClick = findApplier(element, 'onClick');
	assert.equal(typeof onClick, 'function', 'the capsule must expose a click handler');
	onClick();
	const html = renderAndFlush(element);
	assert.ok(html.includes('dshfee-panel'), 'the panel must be open after the capsule click');
	return element;
}

/** Re-render the mounted capsule and return its rendered html. */
function rerender(element) {
	return renderTree(element);
}

/** Debug aid: print a shallow view of a rendered tree. */

/** The `<details>` whose summary text contains `title`. */
function pickSection(element, title) {
	const all = renderer.collect(element, (n) => n.type === 'details');
	return all.find((d) => {
		const kids = d.props.children;
		const first = Array.isArray(kids) ? kids[0] : kids;
		const text = first && first.props ? String(first.props.children ?? '') : '';
		return text.includes(title);
	});
}

/** Let queued microtasks (promise chains) settle. */
function tick() {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Let the pending promise chains settle and then re-render, repeatedly, so that
 * state updates scheduled by resolved fetches actually reach the screen.
 */
async function settleRender(element, rounds = 4) {
	let html = '';
	for (let i = 0; i < rounds; i++) {
		await tick();
		html = renderAndFlush(element);
	}
	return html;
}

/* -------------------------------------------------------------------------- *
 * cases
 * -------------------------------------------------------------------------- */

const CASES = [];
const test = (name, fn) => CASES.push([name, fn]);

test('a) lib/client.js parses (bracket balance + vm compile)', () => {
	const src = readFileSync(CLIENT, 'utf8');
	const stack = [];
	let mode = null;
	let i = 0;
	const closes = { ')': '(', ']': '[', '}': '{' };
	while (i < src.length) {
		const c = src[i];
		const c2 = src.slice(i, i + 2);
		if (mode === null) {
			if (c2 === '//') { mode = '//'; i += 2; continue; }
			if (c2 === '/*') { mode = '/*'; i += 2; continue; }
			if (c === "'" || c === '"' || c === '`') { mode = c; i++; continue; }
			if (c === '(' || c === '[' || c === '{') { stack.push(c); i++; continue; }
			if (c === ')' || c === ']' || c === '}') {
				const top = stack.pop();
				assert.equal(top, closes[c], `bracket mismatch near offset ${i}`);
				i++; continue;
			}
			i++; continue;
		}
		if (mode === '//') { if (c === '\n') mode = null; i++; continue; }
		if (mode === '/*') { if (c2 === '*/') { mode = null; i += 2; continue; } i++; continue; }
		if (c === '\\') { i += 2; continue; }
		if (c === mode) mode = null;
		i++;
	}
	assert.equal(stack.length, 0, 'unclosed brackets remain');
	new Script(src, { filename: 'lib/client.js' });
});

test('b) top level calls window.__ModuleLoader__.load exactly once', () => {
	const env = loadBundle();
	assert.equal(env.loads.length, 1, `expected 1 load() call, got ${env.loads.length}`);
	assert.equal(env.loads[0].id, PKG.name, 'the load id must be the package name');
	assert.equal(typeof env.loads[0].factory, 'function', 'the load must carry a factory');
	assert.ok(env.styleTags.length <= 1, 'the stylesheet must be injected at most once');
});

test('c) apply() runs and registers only into the whitelisted header slot', () => {
	const env = loadBundle();
	const mod = env.loads[0].factory(env.makeRequire());
	assert.equal(typeof mod, 'object', 'module.exports must be an object');
	assert.equal(mod.name, PKG.name, 'exports.name must be the package id');
	assert.ok(Array.isArray(mod.inject), 'exports.inject must be an array');
	assert.ok(mod.inject.includes('slots'), 'exports.inject must include "slots"');
	assert.equal(typeof mod.apply, 'function', 'exports.apply must be a function');

	mod.apply(env.ctx);
	assert.ok(env.registrations.length >= 1, 'apply must register at least one entry');
	for (const reg of env.registrations) {
		assert.ok(WHITELIST.includes(reg.meta.name), `registered into a non-whitelisted slot: ${reg.meta.name}`);
		for (const bad of FORBIDDEN_SINGLE_SLOTS) {
			assert.notEqual(reg.meta.name, bad, `registered into a forbidden single slot: ${bad}`);
		}
		assert.equal(reg.meta.id, 'workspace-fee', 'the slot entry needs a stable id');
		assert.equal(typeof reg.Component, 'function', 'the slot entry must be a component');
	}
	assert.ok(
		env.registrations.some((r) => r.meta.name === 'conversation.session.header.utilities'),
		'the capsule must land in conversation.session.header.utilities'
	);
	for (const id of env.requested) {
		assert.ok(ALLOWED_REQUIRES.includes(id), `unexpected require("${id}") — no extra runtime dependency is allowed`);
	}
	assert.ok(env.requested.includes('react'), 'React must come from the injected require');
});

test('d) registration returns a disposer and the plugin effect releases it', () => {
	const env = loadBundle();
	const mod = env.loads[0].factory(env.makeRequire());
	mod.apply(env.ctx);
	assert.equal(env.disposersCalled.length, 0, 'the disposer must not run at registration time');
	assert.ok(env.effects.length >= 1, 'apply must register a disposal effect');
	for (const eff of env.effects) {
		if (typeof eff.dispose === 'function') eff.dispose();
	}
	assert.ok(env.disposersCalled.includes('workspace-fee'), 'effect cleanup must call the slot disposer');
});

test('e) capsule renders a compact pill and the panel opens', () => {
	const env = loadBundle();
	const mod = env.loads[0].factory(env.makeRequire());
	mod.apply(env.ctx);
	const entry = env.registrations.find((r) => r.meta.name === 'conversation.session.header.utilities');
	assert.ok(entry, 'the capsule must be registered into the header utilities seat');
	const element = { type: entry.Component, props: { sessionId: 'session-under-test' } };
	renderer.forInstance(env.instanceId);

	let html = renderTree(element);
	assert.ok(html.includes('dshfee-pill'), 'the capsule (pill) must render');
	assert.ok(html.includes('dshfee-dot'), 'the capsule must show the alert status dot');
	assert.ok(html.includes('dshfee-pill-name'), 'the capsule must show the workspace name');
	assert.ok(html.includes('dshfee-pill-cost'), 'the capsule must show today cost');
	assert.ok(!html.includes('dshfee-panel'), 'the panel must start closed');

	const click = findApplier(element, 'onClick');
	assert.equal(typeof click, 'function', 'the capsule must be clickable');
	click();
	html = renderTree(element);
	assert.ok(html.includes('dshfee-mask'), 'the panel must open with a dismissable mask');
	assert.ok(html.includes('dshfee-panel'), 'the panel container must render');
	assert.ok(html.includes('正在读取宿主费用数据'), 'the first paint must show the loading state');
	assert.ok(html.includes('dshfee-pill'), 'the capsule must stay mounted behind the panel');
});

test('f) loaded panel renders bars, trend, token detail, daily bill, alerts and pricing', async () => {
	const fetchImpl = makeFakeFetch((call) => ({
		status: 200,
		body: call.url.includes('/config') ? canonicalConfig() : canonicalSummary()
	}));
	const env = loadBundle({ fetchImpl });
	const element = openPanel(env);

	const html = await settleRender(element);
	// No artifact is written: this test must stay self-contained (it used to dump the
	// rendered HTML into `__scratch/`, a directory that is not a deliverable, so a clean
	// checkout failed with ENOENT). The assertions below are the actual evidence.

	assert.ok(!html.includes('正在读取宿主费用数据'), 'the loading text must be gone after the fetch settles');
	assert.ok(html.includes('近 7 天总花费'), 'the panel must show the window total');
	assert.ok(html.includes('按工作区花费'), 'the panel must show the per-workspace cost chart');
	assert.ok(html.includes('dshfee-bar-fill'), 'the per-workspace bars must be drawn');
	assert.ok(html.includes('每日趋势'), 'the panel must show the per-day trend');
	assert.ok(html.includes('dshfee-barrect') || html.includes('<rect'), 'the trend must be inline SVG');
	assert.ok(html.includes('Token 明细'), 'the panel must offer the per-workspace token detail');
	assert.ok(html.includes('按日账单'), 'the panel must offer the per-day bill');
	assert.ok(html.includes('预警线'), 'the panel must offer the alert-threshold editor');
	assert.ok(html.includes('价格设置'), 'the panel must offer the pricing section');
	assert.ok(html.includes('缓存命中') && html.includes('未命中') && html.includes('输出'), 'the legend must use the frozen bucket wording');
	assert.ok(html.includes('dsh-project-fee'), 'the current workspace label must be rendered');
	assert.ok(html.includes('example-app'), 'every workspace must be represented');
	assert.ok(html.includes('2026-09-16'), 'the per-day bill must contain real dates');
	assert.ok(html.includes('¥'), 'costs must be rendered in the configured currency');
	assert.ok(!html.includes('NaN'), 'no NaN may leak into the rendered panel');
	assert.ok(!html.includes('undefined'), 'no raw undefined may leak into the rendered panel');
});

test('f2) 全量档（days=all）：四档区间控件、请求带 days=all、标签与按日账单切到全量口径', async () => {
	const allTime = canonicalSummary({
		days: 'all',
		window: { from: '2026-05-01', to: '2026-09-17', timezone: 'Asia/Shanghai', timezoneOffsetMinutes: 480 },
		diagnostics: { undatedUsageRecords: 2 }
	});
	const fetchImpl = makeFakeFetch((call) => ({
		status: 200,
		body: call.url.includes('/config') ? canonicalConfig() : allTime
	}));
	const env = loadBundle({ fetchImpl });
	const element = openPanel(env);
	let html = await settleRender(element);

	// 默认档必须仍是 7 天（全量是**新增**档，不改默认口径）
	assert.ok(html.includes('近 7 天总花费'), 'the default range must stay 7 days');
	assert.ok(html.includes('>7 天<') && html.includes('>30 天<') && html.includes('>90 天<'), 'the three rolling ranges must stay');
	assert.ok(html.includes('>全量<'), 'the all-time range button must exist');

	const rangeButtons = renderer.collect(element, (n, p) => typeof p.onClick === 'function' && ['7 天', '30 天', '90 天', '全量'].includes(String(p.children)));
	assert.equal(rangeButtons.length, 4, 'the range control must be 7/30/90/全量');
	const allBtn = rangeButtons.find((b) => String(b.props.children) === '全量');
	assert.ok(allBtn, 'the all-time button must be found');
	assert.equal(String(allBtn.props['data-on']), '0', 'the all-time range must start unselected');

	allBtn.props.onClick();
	html = await settleRender(element);

	assert.ok(fetchImpl.calls.some((c) => c.url.includes('days=all')), 'the all-time range must request days=all');
	assert.ok(html.includes('全量总花费'), 'the total card must switch to the all-time caliber');
	assert.ok(html.includes('按工作区花费（全量'), 'the per-workspace card must switch to the all-time caliber');
	assert.ok(html.includes('每日趋势（全量）'), 'the trend card must switch to the all-time caliber');
	assert.ok(html.includes('按日账单（日期 × 工作区，全量'), 'the daily bill must switch to the all-time caliber');
	assert.ok(html.includes('全量口径区间：2026-05-01 ~ 2026-09-17'), 'the panel must show the real all-time window');
	assert.ok(html.includes('无时间戳记录'), 'undated records must be surfaced, never silently dropped');
	assert.ok(!html.includes('NaN'), 'the all-time range must not leak NaN');
	assert.ok(!html.includes('undefined'), 'the all-time range must not leak undefined');
});

test('g) loading / unreachable / empty / non-JSON each render a visible state', async () => {
	{
		const env = loadBundle({ fetchImpl: makeFakeFetch(() => new Promise(() => {})) });
		const element = openPanel(env);
		const html = renderAndFlush(element);
		assert.ok(html.includes('正在读取宿主费用数据'), 'the loading state must be visible');
	}
	{
		const env = loadBundle({ fetchImpl: makeFakeFetch(() => new TypeError('Failed to fetch')) });
		const element = openPanel(env);
		const html = await settleRender(element);
		assert.ok(html.includes('读不到数据'), 'an unreachable host must show an explicit error block');
		assert.ok(html.includes('无法连接宿主'), 'the network reason must be spelled out');
		assert.ok(html.trim().length > 0, 'the error state must not be blank');
	}
	{
		const empty = canonicalSummary({ workspaces: [], daily: [], totals: { tokens: 0, cost: 0 }, current: null });
		const env = loadBundle({
			fetchImpl: makeFakeFetch((call) => ({
				status: 200,
				body: call.url.includes('/config') ? canonicalConfig() : empty
			}))
		});
		const element = openPanel(env);
		const html = await settleRender(element);
		assert.ok(html.includes('还没有任何计费记录') || html.includes('没有可展示的工作区'), 'the empty state must be explicit');
		assert.ok(html.trim().length > 0, 'the empty state must not be blank');
	}
	{
		const env = loadBundle({ fetchImpl: makeFakeFetch(() => '<html>please log in</html>') });
		const element = openPanel(env);
		const html = await settleRender(element);
		assert.ok(html.includes('出错了') || html.includes('读不到数据'), 'a non-JSON body must surface an error, not a blank panel');
	}
});

test('h) editing an alert limit and blurring POSTs { alerts: { id: { limit } } }', async () => {
	const fetchImpl = makeFakeFetch((call) => {
		if (call.url.includes('/config')) {
			const body = call.opts && call.opts.body ? JSON.parse(call.opts.body) : null;
			const cfg = canonicalConfig();
			if (body && body.alerts) {
				for (const [id, entry] of Object.entries(body.alerts)) cfg.alerts[id] = entry;
			}
			return { status: 200, body: cfg };
		}
		return { status: 200, body: canonicalSummary() };
	});
	const env = loadBundle({ fetchImpl });
	const element = openPanel(env);
	await settleRender(element);

	const input = pickAlertInput(element);
	assert.ok(input, 'the alert editor must render an editable input');
	input.props.onChange({ target: { value: '9.5' } });
	input.props.onBlur({ target: { value: '9.5' } });
	await tick(); await tick(); await tick();

	const post = env.fetchImpl.posts().find((c) => c.url.endsWith('/config'));
	assert.ok(post, 'blurring must POST to /config');
	const body = JSON.parse(post.opts.body);
	assert.ok(body.alerts && typeof body.alerts === 'object', 'the body must carry an alerts object');
	const entries = Object.entries(body.alerts);
	assert.equal(entries.length, 1, 'exactly one workspace threshold per save');
	// 双预警线：单个输入框失焦只提交**该条线**（这里 pickAlertInput 取的是第一个 = 日线）
	assert.equal(entries[0][1].day, 9.5, 'the day line must be sent as a number');
	assert.ok(!('limit' in entries[0][1]), 'the new shape uses {day,total}, not the legacy {limit}');
	assert.ok(!('total' in entries[0][1]), 'editing the day line must NOT touch the total line');
	assert.ok(String(entries[0][0]).length > 0, 'the alerts key must be a workspaceId');
	assert.equal(post.opts.credentials, 'same-origin', 'the request must be same-origin');
	assert.ok(!post.opts.body.includes('NaN'), 'the body must never carry NaN');
});

test('h3) the alert editor renders TWO lines per workspace (day + total)', async () => {
	const env = loadBundle({ fetchImpl: makeFakeFetch((call) => ({ status: 200, body: call.url.includes('/config') ? canonicalConfig() : canonicalSummary() })) });
	const element = openPanel(env);
	const html = await settleRender(element);
	assert.ok(html.includes('日线'), 'the day line must be labelled');
	assert.ok(html.includes('总线'), 'the total line must be labelled');
	const inputs = alertInputs(element);
	assert.ok(inputs.length >= 2, `expected at least 2 threshold inputs, found ${inputs.length}`);
});

test('h5) each workspace is exactly ONE grid cell (label + one .lines block) — 防错位回归', async () => {
	const env = loadBundle({ fetchImpl: makeFakeFetch((call) => ({ status: 200, body: call.url.includes('/config') ? canonicalConfig() : canonicalSummary() })) });
	const element = openPanel(env);
	const html = await settleRender(element);
	// 错位的成因：把「标签 / 日线 / 总线」作为三个并列元素交给网格，网格把它们当三个格子，
	// 于是第二个工作区的标签被挤进输入框那一列。
	// 正确结构：每个工作区一个 .dshfee-alertrow（display:contents），内含 1 个 .lbl-c 与 1 个 .lines。
	const labels = renderer.collect(element, (n, p) => typeof p.className === 'string' && p.className.includes('lbl-c'));
	const lineBlocks = renderer.collect(element, (n, p) => typeof p.className === 'string' && p.className === 'lines');
	assert.ok(labels.length >= 2, `expected >=2 workspace labels, found ${labels.length}`);
	assert.equal(labels.length, lineBlocks.length, 'every workspace label must pair with exactly one .lines block');
	for (const block of lineBlocks) {
		const lines = renderer.collect(block, (n, p) => typeof p.className === 'string' && p.className === 'line');
		assert.equal(lines.length, 2, 'each workspace must render exactly two threshold lines');
	}
	// 行包装必须用 CSS 类而不是内联 style —— 内联会压过窄屏媒体查询
	assert.ok(!html.includes('display:contents'), 'the row wrapper must not use inline display:contents');
});

test('h4) editing the TOTAL line posts { total } without touching the day line', async () => {
	const env = loadBundle({ fetchImpl: makeFakeFetch((call) => ({ status: 200, body: call.url.includes('/config') ? canonicalConfig() : canonicalSummary() })) });
	const element = openPanel(env);
	await settleRender(element);
	const inputs = alertInputs(element);
	assert.ok(inputs.length >= 2, 'need both inputs');
	// 第二个输入框 = 总线
	const totalInput = inputs[1];
	totalInput.props.onChange({ target: { value: '120' } });
	totalInput.props.onBlur({ target: { value: '120' } });
	await tick(); await tick(); await tick();
	const post = env.fetchImpl.posts().find((c) => c.url.endsWith('/config'));
	assert.ok(post, 'blurring the total input must POST');
	const body = JSON.parse(post.opts.body);
	const entries = Object.entries(body.alerts);
	assert.equal(entries[0][1].total, 120, 'the total line must carry the value');
	assert.ok(!('day' in entries[0][1]), 'editing the total line must NOT touch the day line');
});

test('h2) a non-numeric threshold is refused locally and never posted', async () => {
	const fetchImpl = makeFakeFetch((call) => ({
		status: 200,
		body: call.url.includes('/config') ? canonicalConfig() : canonicalSummary()
	}));
	const env = loadBundle({ fetchImpl });
	const element = openPanel(env);
	await settleRender(element);
	const before = env.fetchImpl.posts().length;
	const input = pickAlertInput(element);
	assert.ok(input, 'the alert editor must render an editable input');
	input.props.onChange({ target: { value: 'abc' } });
	input.props.onBlur({ target: { value: 'abc' } });
	await tick(); await tick();
	assert.equal(env.fetchImpl.posts().length, before, 'an invalid threshold must not reach the host');
	assert.ok(renderAndFlush(element).includes('预警线必须是数字'), 'the invalid value must be reported inline');
});

test('i) Escape on document triggers the panel close path', () => {
	const env = loadBundle();
	const element = openPanel(env);
	assert.ok(renderAndFlush(element).includes('dshfee-panel'), 'the panel must start open');
	env.doc.fire('keydown', { key: 'Escape', preventDefault() {} });
	const html = renderAndFlush(element);
	assert.ok(!html.includes('dshfee-panel'), 'Escape must close the panel');
	assert.ok(html.includes('dshfee-pill'), 'the capsule must remain after closing');
});

test('j) paints with DSH theme variables, no light background, no chart lib, no ESM syntax', () => {
	const src = readFileSync(CLIENT, 'utf8');
	const withoutTokens = src.replace(/--dsw-alias[^;"']*/g, '');
	assert.ok(src.includes('var(--dsw-alias-'), 'the bundle must paint with DSH theme variables');
	assert.ok(!/#(fff|ffffff|FFFFFF)\b/.test(withoutTokens), 'no hardcoded light background is allowed');
	assert.ok(src.includes('aria-label'), 'interactive elements need aria-label');
	assert.ok(src.includes('aria-modal'), 'the panel must be a modal dialog');
	assert.ok(src.includes('title:'), 'elements must carry title tooltips');
	assert.ok(src.includes("=== 'Escape'"), 'Escape handling must exist');
	assert.ok(src.includes('onMouseDown'), 'the mask must be dismissable');
	assert.ok(src.includes('data-plugin-css'), 'styles must be de-duplicated by data-plugin-css');
	assert.ok(src.includes('@media (max-width:520px)'), 'a <520px stacking rule must exist');
	assert.ok(!/\bimport\s+/.test(src), 'the bundle must not contain ESM import syntax');
	assert.ok(!/\bexport\s+(default|const|function|let|var|class)\b/.test(src), 'the bundle must not contain ESM export syntax');
	for (const banned of ['d3', 'chart.js', 'echarts', 'recharts', 'bootstrap', 'tailwind']) {
		assert.ok(!src.includes(`require('${banned}`) && !src.includes(`require("${banned}`), `no "${banned}" dependency is allowed`);
	}
});

test('k) package.json declares the browser half consistently', () => {
	assert.equal(PKG.name, 'dsh-workspace-fee', 'the package name is the plugin id');
	assert.equal(PKG.dsh?.client?.platform, 'web', 'dsh.client.platform must be "web"');
	assert.ok(Array.isArray(PKG.dsh?.client?.inject), 'dsh.client.inject must be an array');
	assert.equal(PKG.exports?.['./client'], './lib/client.js', 'exports["./client"] must point at lib/client.js');
	assert.equal(PKG.type, 'module', 'the package must be ESM');
});

test('l) limit 0 / null is never treated as a threshold (SPEC §2: level is always ok)', async () => {
	const zero = canonicalSummary({
		workspaces: [
			{ key: 'w0', workspaceId: 'w0', label: 'zero-limit', cwd: null, sessions: 1, tokens: { inputTokens: 20, cacheReadTokens: 10, outputTokens: 10, reasoningTokens: 0, totalTokens: 40 }, cost: 9.9, todayCost: 9.9, alert: { limit: 0, level: 'ok' } },
			{ key: 'w1', workspaceId: 'w1', label: 'null-limit', cwd: null, sessions: 1, tokens: { inputTokens: 20, cacheReadTokens: 10, outputTokens: 10, reasoningTokens: 0, totalTokens: 40 }, cost: 8.8, todayCost: 8.8, alert: { limit: null, level: 'ok' } }
		],
		daily: []
	});
	zero.current = zero.workspaces[0];
	const env = loadBundle({
		fetchImpl: makeFakeFetch((call) => ({ status: 200, body: call.url.includes('/config') ? canonicalConfig() : zero }))
	});
	const element = openPanel(env);
	const html = await settleRender(element);
	const overMentions = (html.match(/已超预警线/g) || []).length;
	assert.equal(overMentions, 0, 'a 0/null limit must never be painted as over');
	assert.ok(html.includes('正常') || html.includes('未设置'), 'a 0/null limit reads as no threshold');
	assert.ok(!html.includes('预警线：¥0'), 'a 0 limit is not shown as a real 0-yuan threshold');

	// The capsule's dot must not use the danger colour for a non-threshold limit.
	const capsuleHtml = renderAndFlush({ type: element.type, props: { sessionId: 'session-under-test' } });
	void capsuleHtml;
	const dots = renderer.collect(element, (n, p) => typeof p.className === 'string' && p.className.includes('dshfee-dot'));
	const dangerColor = 'state-danger-primary';
	for (const dot of dots) {
		const style = dot.props.style || {};
		assert.ok(!String(style.background || '').includes(dangerColor), 'no danger dot for a non-threshold limit');
	}
});

test('m) reads the Host token shape correctly under SPEC v1.1 (inputTokens is the miss bucket)', async () => {
	// Distinctive values, plus a totalTokens that pins the rule:
	// cacheRead=400 + input=1000 + output=200 must equal totalTokens=1600. If the client
	// wrongly subtracted cacheRead from input (miss=600), the three buckets would sum to
	// 1200 and contradict the Host's own total.
	const hostShape = canonicalSummary({
		workspaces: [{
			key: 'wS', workspaceId: 'wS', label: 'shape-ws', cwd: null, sessions: 1,
			tokens: { inputTokens: 1000, cacheReadTokens: 400, outputTokens: 200, reasoningTokens: 13, totalTokens: 1600 },
			cost: 1.5, todayCost: 1.5, alert: { limit: null, level: 'ok' }
		}],
		daily: []
	});
	hostShape.current = hostShape.workspaces[0];
	const hostEnv = loadBundle({
		fetchImpl: makeFakeFetch((call) => ({ status: 200, body: call.url.includes('/config') ? canonicalConfig() : hostShape }))
	});
	const hostElement = openPanel(hostEnv);
	const hostHtml = await settleRender(hostElement);
	assert.ok(
		hostHtml.includes('缓存命中 400，未命中 1,000，输出 200'),
		`host tokens must normalise to hit=400 miss=1000 out=200; got: ${
			(hostHtml.match(/缓存命中[^"]*?(?=")/) || ['(no token stack found)'])[0]}`
	);
	assert.ok(
		!hostHtml.includes('未命中 600'),
		'cacheRead must NOT be subtracted from inputTokens (SPEC v1.1: it is already the miss bucket)'
	);
	// reasoning is a SUBSET of output: a labelled sub-figure, never a 4th billed bucket.
	assert.ok(hostHtml.includes('其中思考 13'), 'reasoning must be labelled as a sub-figure');
	// ...and it must never be DROPPED either: the operator needs it to judge value.
	assert.ok(
		/其中思考\s*13（已含在「输出」内，不另计）/.test(hostHtml),
		'the reasoning sub-figure must stay visible with the "already inside output" wording'
	);
	assert.ok(
		!/[\d,，\s]输出\s*200\s*／?\s*思考\s*13/.test(hostHtml) && !hostHtml.includes('，思考 13'),
		'reasoning must never be rendered as a peer bucket next to 输出'
	);
	// The headline total must be the Host's own 1,600 (not 400+1000+200+13, and not 1200).
	assert.ok(hostHtml.includes('1,600'), 'the headline total must be the Host totalTokens (1600)');
	assert.ok(!hostHtml.includes('1,613'), 'the buckets must never be summed with reasoning (1613)');
	assert.ok(!hostHtml.includes('1,200'), 'cacheRead must not be subtracted from inputTokens (1200)');

	// The reasoning sub-figure must be present but must NOT be a 4th stack segment:
	// the billed-bucket stack holds exactly the three non-overlapping buckets.
	const stacks = renderer.collect(hostElement, (n, p) => typeof p.className === 'string' && p.className === 'dshfee-stack');
	assert.ok(stacks.length >= 1, 'the token stack must render');
	for (const stack of stacks) {
		const kids = (stack.props.children || []).filter(Boolean);
		assert.ok(kids.length <= 3, `the billed-bucket stack must hold at most 3 segments, found ${kids.length}`);
		const widths = kids.map((k) => String((k.props && k.props.style && k.props.style.width) || ''));
		assert.ok(
			widths.every((w) => !w.includes('reasoning')),
			'no segment may represent reasoning'
		);
	}

	// The derived v1 names must still produce the SAME buckets, with the same total.
	const legacyShape = canonicalSummary({
		workspaces: [{
			key: 'wS', workspaceId: 'wS', label: 'shape-ws', cwd: null, sessions: 1,
			tokens: { cachedInput: 400, uncachedInput: 1000, output: 200, reasoning: 13, totalTokens: 1600 },
			cost: 1.5, todayCost: 1.5, alert: { limit: null, level: 'ok' }
		}],
		daily: []
	});
	legacyShape.current = legacyShape.workspaces[0];
	const legacyEnv = loadBundle({
		fetchImpl: makeFakeFetch((call) => ({ status: 200, body: call.url.includes('/config') ? canonicalConfig() : legacyShape }))
	});
	const legacyHtml = await settleRender(openPanel(legacyEnv));
	assert.ok(
		legacyHtml.includes('缓存命中 400，未命中 1,000，输出 200'),
		'the derived bucket names must normalise to the same buckets'
	);
	assert.ok(legacyHtml.includes('1,600'), 'both shapes must report the same Host total');
});

test('n) a hidden tab stops polling; a failed poll keeps the last good data', async () => {
	let failNext = false;
	const fetchImpl = makeFakeFetch((call) => {
		if (call.url.includes('/config')) return { status: 200, body: canonicalConfig() };
		if (failNext) return new TypeError('Failed to fetch');
		return { status: 200, body: canonicalSummary() };
	});
	const env = loadBundle({ fetchImpl });
	const element = openPanel(env);
	await settleRender(element, 2);
	const afterOpen = env.fetchImpl.calls.length;
	assert.ok(afterOpen >= 1, 'opening the panel must read /summary');
	assert.ok(env.timerCount() >= 1, 'a poll must be scheduled (setInterval)');

	// Hidden tab: the poll must not hit the Host.
	env.doc.visibilityState = 'hidden';
	env.fireTimers();
	await tick();
	assert.equal(env.fetchImpl.calls.length, afterOpen, 'a hidden tab must not poll the Host');

	// Visible again + a failing poll: data must survive.
	env.doc.visibilityState = 'visible';
	failNext = true;
	env.fireTimers();
	await tick();
	await tick();
	const html = renderAndFlush(element);
	assert.ok(env.fetchImpl.calls.length > afterOpen, 'a visible tab polls again');
	assert.ok(html.includes('近 7 天总花费'), 'the panel must keep its last good data after a failed poll');
	assert.ok(html.includes('dsh-project-fee'), 'the last good workspace data must survive a poll failure');
	assert.ok(!html.includes('正在读取宿主费用数据'), 'a failed background poll must not fall back to loading');
});

test('o) the four grouped sections are collapsed by default (first screen <= 2 blocks)', async () => {
	const env = loadBundle();
	const element = openPanel(env);
	// Let the fetch settle, then render, so the recorded tree holds the real panel.
	await settleRender(element, 2);
	renderAndFlush(element);
	const details = renderer.collect(element, (n) => n.type === 'details');
	assert.ok(details.length >= 4, `expected the grouped sections as <details>, found ${details.length}`);
	const openOnes = details.filter((d) => d.props.open);
	assert.equal(openOnes.length, 0, `no <details> may be open by default, found ${openOnes.length} open`);
	const titles = details.map((d) => {
		const kids = d.props.children;
		const first = Array.isArray(kids) ? kids[0] : kids;
		return first && first.props ? String(first.props.children ?? '') : '';
	});
	for (const label of ['按日账单', 'Token 明细', '预警线', '价格设置']) {
		assert.ok(titles.some((t) => t.includes(label)), `the "${label}" section must exist as a collapsed <details>`);
	}
});

test('q) every pricing.append body carries a COMPLETE models table (约定 5: 空 models 会被 400)', async () => {
	const posts = [];
	const env = loadBundle({
		fetchImpl: makeFakeFetch((call) => {
			if (call.url.includes('/config') && call.opts && call.opts.method === 'POST') {
				posts.push(JSON.parse(call.opts.body));
			}
			return { status: 200, body: call.url.includes('/config') ? canonicalConfig() : canonicalSummary() };
		})
	});
	const element = openPanel(env);
	await settleRender(element, 2);

	// Load the config seed, then open both editors.
	pickSection(element, '价格设置').props.onToggle({ target: { open: true } });
	await settleRender(element, 2);
	// The append-version editor only renders in custom-price mode.
	const modeSelect = renderer.collect(element, (n, p) => n.type === 'select' && p.id === 'dshfee-price-mode')[0];
	assert.ok(modeSelect, 'the price-mode select must exist');
	modeSelect.props.onChange({ target: { value: 'custom' } });
	await settleRender(element, 2);

	/** Assert one append body is a complete price table. */
	const assertCompleteAppend = (body, label) => {
		const append = body && body.pricing && body.pricing.append;
		assert.ok(append, `${label}: the body must carry pricing.append`);
		const models = append.models;
		assert.ok(models && typeof models === 'object', `${label}: models must be an object`);
		const families = Object.keys(models);
		assert.ok(families.length >= 1, `${label}: models must NOT be empty (the Host rejects it with 400)`);
		for (const family of families) {
			const segs = models[family] && models[family].segments;
			assert.ok(Array.isArray(segs) && segs.length >= 1, `${label}: family "${family}" must carry segments`);
			for (const seg of segs) {
				for (const key of ['id', 'label', 'days', 'from', 'to', 'hit', 'miss', 'out']) {
					assert.ok(key in seg, `${label}: segment is missing "${key}"`);
				}
				assert.equal(typeof seg.hit, 'number', `${label}: segment.hit must be a number`);
				assert.equal(typeof seg.miss, 'number', `${label}: segment.miss must be a number`);
				assert.equal(typeof seg.out, 'number', `${label}: segment.out must be a number`);
			}
		}
		assert.ok(!('repriceExisting' in append), `${label}: must not send fields the Host ignores`);
	};

	// (1) the plain "append version" path.
	const appendButton = renderer
		.collect(element, (n, p) => typeof p.onClick === 'function' && String(p.children || '').includes('提交新版本'))[0];
	assert.ok(appendButton, 'the append-version button must exist');
	appendButton.props.onClick();
	await tick(); await tick();
	assert.ok(posts.length >= 1, 'submitting a new version must POST /config');
	assertCompleteAppend(posts[posts.length - 1], 'submitAppend');
	void byLabel(element, '新版本生效日期');

	// (2) the "reprice from a chosen instant" path — this is the one that used to send {}.
	pickSection(element, '从指定时刻起重新计价').props.onToggle({ target: { open: true } });
	await settleRender(element, 2);
	const confirmInput = byLabel(element, '重算确认词');
	assert.ok(confirmInput, 'the recalc confirm input must exist');
	confirmInput.props.onChange({ target: { value: 'RECALC' } });
	renderAndFlush(element);
	const recalcButton = renderer
		.collect(element, (n, p) => typeof p.onClick === 'function' && String(p.children || '').includes('确认重算存量'))[0];
	assert.ok(recalcButton, 'the recalc button must exist');
	const before = posts.length;
	recalcButton.props.onClick();
	await tick(); await tick(); await tick();
	assert.ok(posts.length > before, 'the recalc path must still POST /config');
	const recalcBody = posts[posts.length - 1];
	assertCompleteAppend(recalcBody, 'submitRecalc');

	// (3) reversal lock: the exact shape that the Host 400s must never be produced.
	for (const body of posts) {
		const models = body.pricing.append.models;
		assert.notDeepEqual(models, {}, 'an empty models table must never be sent (regression target)');
		assert.ok(
			Object.values(models).every((m) => Array.isArray(m.segments) && m.segments.length > 0),
			'no family may be sent with an empty segment list'
		);
	}
});

test('q2) the append-version path refuses to submit an empty price table', async () => {
	// No successful /config read => no usable seed => the client must NOT send {}.
	const env = loadBundle({
		fetchImpl: makeFakeFetch((call) => {
			if (call.url.includes('/config')) return { status: 500, body: { ok: false, error: 'config unavailable' } };
			return { status: 200, body: canonicalSummary() };
		})
	});
	const element = openPanel(env);
	await settleRender(element, 2);
	pickSection(element, '价格设置').props.onToggle({ target: { open: true } });
	await settleRender(element, 2);
	const modeSelect = renderer.collect(element, (n, p) => n.type === 'select' && p.id === 'dshfee-price-mode')[0];
	modeSelect.props.onChange({ target: { value: 'custom' } });
	await settleRender(element, 2);

	const appendButton = renderer
		.collect(element, (n, p) => typeof p.onClick === 'function' && String(p.children || '').includes('提交新版本'))[0];
	assert.ok(appendButton, 'the append-version button must exist');
	appendButton.props.onClick();
	await tick(); await tick();

	const configPosts = env.fetchImpl.posts().filter((c) => c.url.endsWith('/config'));
	assert.equal(configPosts.length, 0, 'an empty price table must never be POSTed (the Host 400s it)');
	const html = renderAndFlush(element);
	assert.ok(html.includes('没有可用的价格模板'), 'the refusal must be explained inline, not silent');
});

test('p) surfaces the Host config problems[] / unpriced diagnostics in the pricing section', async () => {
	const cfg = canonicalConfig();
	cfg.problems = ['flash 版本缺少 00:00-09:00 的兜底时段'];
	cfg.diagnostics = { unpricedUsageRecords: 7 };
	const env = loadBundle({
		fetchImpl: makeFakeFetch((call) => ({ status: 200, body: call.url.includes('/config') ? cfg : canonicalSummary() }))
	});
	const element = openPanel(env);
	await settleRender(element, 2);
	// The pricing section loads /config only when it is first expanded.
	const priceToggle = pickSection(element, '价格设置');
	assert.ok(priceToggle, 'the pricing <details> must expose an onToggle handler');
	priceToggle.props.onToggle({ target: { open: true } });
	const html = await settleRender(element, 2);
	assert.ok(html.includes('宿主配置告警'), 'config problems must be surfaced, not swallowed');
	assert.ok(html.includes('缺少 00:00-09:00 的兜底时段'), 'the problem text must be shown');

	// The diagnostics figure surfaces even when problems[] is empty.
	const cfg2 = canonicalConfig();
	cfg2.problems = [];
	cfg2.diagnostics = { unpricedUsageRecords: 7 };
	const env2 = loadBundle({
		fetchImpl: makeFakeFetch((call) => ({ status: 200, body: call.url.includes('/config') ? cfg2 : canonicalSummary() }))
	});
	const element2 = openPanel(env2);
	await settleRender(element2, 2);
	const toggle2 = pickSection(element2, '价格设置');
	toggle2.props.onToggle({ target: { open: true } });
	const html2 = await settleRender(element2, 2);
	assert.ok(html2.includes('未计价'), 'unpriced usage records must be surfaced to the user');
});

/* -------------------------------------------------------------------------- *
 * run every case sequentially, then judge by exit code
 * -------------------------------------------------------------------------- */

let failed = 0;
for (const [name, fn] of CASES) {
	try {
		await fn();
		console.log(`ok   - ${name}`);
	} catch (err) {
		failed++;
		console.log(`FAIL - ${name}`);
		console.log('       ' + (err && err.message ? err.message : String(err)));
	}
}

if (failed > 0) {
	console.error(`\n${failed}/${CASES.length} client-bundle checks FAILED`);
	process.exitCode = 1;
} else {
	console.log(`\n${CASES.length}/${CASES.length} client-bundle checks passed`);
}
