/**
 * Probe the three frozen Host routes against a running DSH web server and print
 * the REAL HTTP status of each call. A 401/403 means the GUI requires login; that
 * is recorded honestly — this script never reports a 200 it did not observe.
 *
 * Usage:
 *   node scripts/check-endpoints.mjs
 *   node scripts/check-endpoints.mjs --base=http://127.0.0.1:3080
 *   node scripts/check-endpoints.mjs --sessionId=<id> --json
 *   node scripts/check-endpoints.mjs --insecure   # accept a self-signed TLS cert
 *
 * Notes:
 *   - The default base URL matches the one the plugin's README documents
 *     (http://127.0.0.1:3080), so tests and docs use the same literal.
 *   - No cookie is sent by default. Pass --cookie="k=v" to replay a login cookie.
 *   - Exit code is 0 when the probe ran (whatever the HTTP status), and 1 only when
 *     the server could not be reached at all.
 */

import { writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
	const hit = args.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
	if (!hit) return fallback;
	const eq = hit.indexOf('=');
	return eq === -1 ? true : hit.slice(eq + 1);
};

const BASE = String(flag('base', 'http://127.0.0.1:3080')).replace(/\/+$/, '');
const SESSION_ID = flag('sessionId', null);
const COOKIE = flag('cookie', null);
const JSON_OUT = Boolean(flag('json', false));
const INSECURE = Boolean(flag('insecure', false));
const TIMEOUT_MS = Number(flag('timeout', '8000'));

if (INSECURE) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const API = `${BASE}/api/dsh-workspace-fee`;

/** One probe call; never throws — network failures are reported as status 0. */
async function probe(label, method, url, body) {
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
	const headers = {};
	if (COOKIE) headers.cookie = String(COOKIE);
	if (body !== undefined) headers['content-type'] = 'application/json';
	try {
		const res = await fetch(url, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: controller.signal,
			redirect: 'manual'
		});
		const text = await res.text();
		let parsed = null;
		let parseError = null;
		try {
			parsed = text === '' ? null : JSON.parse(text);
		} catch (err) {
			parseError = err && err.message ? err.message : String(err);
		}
		return {
			label,
			method,
			url,
			status: res.status,
			statusText: res.statusText,
			contentType: res.headers.get('content-type'),
			ms: Date.now() - started,
			bytes: text.length,
			excerpt: text.slice(0, 200).replace(/\s+/g, ' '),
			json: parsed,
			parseError,
			networkError: null
		};
	} catch (err) {
		return {
			label,
			method,
			url,
			status: 0,
			statusText: 'NETWORK ERROR',
			contentType: null,
			ms: Date.now() - started,
			bytes: 0,
			json: null,
			excerpt: '',
			parseError: null,
			networkError: err && err.name === 'AbortError' ? `timeout after ${TIMEOUT_MS}ms` : (err && err.message) || String(err)
		};
	} finally {
		clearTimeout(timer);
	}
}

/** A compact, honest reading of a response body. */
function summarise(result) {
	if (result.networkError) return `unreachable: ${result.networkError}`;
	if (result.status === 401 || result.status === 403) return '需要登录（浏览器带 cookie 时才可见真实数据）';
	if (result.parseError) return `非 JSON 响应（${result.parseError}）；前 120 字：${result.excerpt.slice(0, 120)}`;
	const body = result.json;
	if (body === null) return '(empty body)';
	if (body && body.ok === false) return `ok:false error=${JSON.stringify(body.error)}`;
	if (!body || typeof body !== 'object') return typeof body;
	const keys = Object.keys(body);
	if (Array.isArray(body.workspaces)) {
		return `ok=${body.ok} workspaces=${body.workspaces.length} daily=${Array.isArray(body.daily) ? body.daily.length : 'n/a'} current=${body.current ? body.current.label ?? body.current.workspaceId : 'null'} keys=[${keys.join(',')}]`;
	}
	if (Array.isArray(body.pricing?.versions)) {
		return `ok=${body.ok} currency=${body.currency} versions=${body.pricing.versions.length} active=${body.pricing.activeVersionId} alerts=${body.alerts ? Object.keys(body.alerts).length : 0}`;
	}
	return `ok=${body.ok} keys=[${keys.join(',')}]`;
}

const queries = SESSION_ID ? `?days=7&sessionId=${encodeURIComponent(String(SESSION_ID))}` : '?days=7';

const plan = [
	['summary  (GET)', 'GET', `${API}/summary${queries}`, undefined],
	['config   (GET)', 'GET', `${API}/config`, undefined],
	['refresh  (POST)', 'POST', `${API}/refresh`, {}],
	// Baseline: the same auth gate, on a path the plugin certainly does not own.
	// If this returns the SAME status as the three above, the observed status is an
	// auth/pre-route verdict and says nothing about whether the routes exist.
	['baseline (bogus path under same prefix)', 'GET', `${API}/__nonexistent_probe__`, undefined]
];

const results = [];
for (const [label, method, url, body] of plan) {
	const result = await probe(label, method, url, body);
	results.push(result);
	if (!JSON_OUT) {
		const statusText = result.status === 0 ? 'NO RESPONSE' : `${result.status} ${result.statusText}`;
		console.log(`${label}  ${method} ${url}`);
		console.log(`  → ${statusText}  (${result.ms}ms, ${result.bytes}B, content-type=${result.contentType ?? 'none'})`);
		console.log(`  → ${summarise(result)}`);
		if (result.status === 0 && result.networkError) {
			console.log('  → 宿主可能未运行，或地址不对；本脚本只如实记录，不伪造成功。');
		}
		console.log('');
	}
}

const reachable = results.filter((r) => r.status > 0);
const real = results.filter((r) => !r.label.startsWith('baseline'));
const baseline = results.find((r) => r.label.startsWith('baseline'));
const authGated = real.every((r) => r.status === 401 || r.status === 403);
const baselineMatches = baseline && real.every((r) => r.status === baseline.status);

const summary = {
	base: BASE,
	sessionId: SESSION_ID,
	withCookie: Boolean(COOKIE),
	probed: results.length,
	reachable: reachable.length,
	statuses: results.map((r) => ({ label: r.label, method: r.method, status: r.status, networkError: r.networkError })),
	authGated,
	baselineStatus: baseline ? baseline.status : null,
	baselineMatchesRealRoutes: Boolean(baselineMatches),
	note: reachable.length === 0
		? '宿主不可达：全部请求都没有得到 HTTP 响应。'
		: (authGated
			? (baselineMatches
				? `三条真实路由与「同前缀的假路径」返回了相同状态（${baseline.status}）。这说明该状态是登录/路由前置的判定，**不能**用来证明路由已注册或不存在。真实性必须由登录后的浏览器会话或直接调用路由处理器来验证。`
				: `三条真实路由要求登录（401/403），而同前缀假路径返回 ${baseline ? baseline.status : 'n/a'}——两者不同，说明判定发生在路由层之后。`)
			: '三条路由都返回了 HTTP 响应。')
};

if (JSON_OUT) {
	console.log(JSON.stringify({ summary, results }, null, 2));
}

// Optional machine-readable artifact; only written when asked, so a probe run
// leaves the working tree clean by default.
const OUT_PATH = flag('out', null);
if (OUT_PATH) {
	writeFileSync(String(OUT_PATH), JSON.stringify({ summary, results }, null, 2));
}

if (!JSON_OUT) {
	console.log(`汇总：探测 ${summary.probed} 条（含 1 条假路径基线），收到 HTTP 响应 ${summary.reachable} 条。`);
	console.log(summary.note);
	// Make the reading's limits unmissable: a bare status code invites the wrong inference.
	console.log('');
	console.log('效力边界（本探测能证明什么 / 不能证明什么）');
	if (reachable.length === 0) {
		console.log('  能证明：宿主在本地址上没有给出任何 HTTP 响应。');
		console.log('  不能证明：路由不存在——服务可能只是没在监听该地址。');
	} else if (authGated && baselineMatches) {
		console.log(`  能证明：这些请求都到达了某个 HTTP 服务，并统一得到 ${baseline.status}。`);
		console.log(`  不能证明：三条路由**已注册**——同前缀的假路径同样得到 ${baseline.status}，`);
		console.log('            说明判定发生在路由匹配之前，这个状态码与路由是否存在无关。');
		console.log('  不能证明：服务在正常工作（连首页也是同一状态）。');
		console.log('  要验证注册真实性：用登录后的浏览器会话，或直接 import 路由模块 + mock req/res 调用处理器。');
	} else if (authGated) {
		console.log('  能证明：三条真实路由要求登录（401/403）。');
		console.log(`  不能直接证明注册真实性——同前缀假路径返回 ${baseline ? baseline.status : 'n/a'}，两者判定层级需人工判读。`);
	} else {
		console.log('  能证明：三条路由都返回了 HTTP 响应（含各自状态码）。');
		console.log('  不能证明：响应体符合 docs/SPEC.md 的逐字段契约——那需要契约级断言。');
	}
	if (OUT_PATH) console.log(`（原始 JSON 已写入 ${OUT_PATH}）`);
	else console.log('（如需原始 JSON：加 --out=<path> 或 --json）');
}

// Exit 1 only when nothing answered at all — a 401 is a real, recorded observation.
process.exitCode = reachable.length === 0 ? 1 : 0;
