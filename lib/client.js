/**
 * dsh-workspace-fee — Client half.
 *
 * Hand-written, directly loadable browser bundle (no build toolchain, no chart
 * library). The DSH web boot handoff calls `window.__ModuleLoader__.load`, and
 * the module table supplies React through the injected `require`, so React is
 * never bundled here.
 *
 * The Session header's right-aligned utilities seat gets a compact fee capsule;
 * clicking it opens a panel with the per-workspace spend chart, a per-day trend,
 * a per-day bill, per-workspace token detail and the alert-threshold / pricing
 * editors. Every number comes from the Host's frozen HTTP contract:
 *   GET  /api/dsh-workspace-fee/summary?days=<7|30|90|all>&sessionId=<id>
 *   GET  /api/dsh-workspace-fee/config
 *   POST /api/dsh-workspace-fee/config
 *   POST /api/dsh-workspace-fee/refresh
 */

(function () {
	'use strict';

	if (typeof window === 'undefined' || !window.__ModuleLoader__ || typeof window.__ModuleLoader__.load !== 'function') {
		// Loaded outside the DSH web boot handoff: nothing to attach to.
		return;
	}

	window.__ModuleLoader__.load({
		id: 'dsh-workspace-fee',
		factory: function (require) {
			var module = { exports: {} };
			var exports = module.exports;

			var react = require('react');
			var jsxRuntime = require('react/jsx-runtime');
			var jsx = jsxRuntime.jsx;
			var jsxs = jsxRuntime.jsxs;
			var Fragment = jsxRuntime.Fragment;
			var createElement = react.createElement;
			var useCallback = react.useCallback;
			var useEffect = react.useEffect;
			var useMemo = react.useMemo;
			var useRef = react.useRef;
			var useState = react.useState;

			var NS = 'dsh-workspace-fee';
			var API = '/api/dsh-workspace-fee';
			// 统计口径档位：7 / 30 / 90 天，以及 'all'（全量口径 = 从最早一条记录到今天，见 docs/SPEC.md §1）。
			var DAY_CHOICES = [7, 30, 90, 'all'];
			var DEFAULT_DAYS = 7;
			var ALL_DAYS = 'all';
			/** 「7 天」/「全量」——用于档位按钮与括号内短语。 */
			function rangeLabel(d) { return d === ALL_DAYS ? '全量' : d + ' 天'; }
			/** 「近 7 天」/「全量」——用于「近 7 天总花费」这类标题。 */
			function rangeLabelNear(d) { return d === ALL_DAYS ? '全量' : '近 ' + d + ' 天'; }
			/** localStorage 里存的 days 只认数字或 'all'，其余回默认档（不猜）。 */
			function daysPref(raw) { return raw === ALL_DAYS || typeof raw === 'number' ? raw : DEFAULT_DAYS; }
			var TOP_WORKSPACES = 5;
			var POLL_MS = 60000;
			var LS_KEY = NS + '.ui.v1';

			var COLORS = {
				ok: 'var(--dsw-alias-state-success-primary,#3fb950)',
				warn: 'var(--dsw-alias-state-warning-primary,#d29922)',
				over: 'var(--dsw-alias-state-danger-primary,#f85149)',
				unknown: 'var(--dsw-alias-label-quaternary,#8b949e)',
				hit: 'var(--dsw-alias-state-success-primary,#3fb950)',
				miss: 'var(--dsw-alias-state-info-primary,#58a6ff)',
				out: 'var(--dsw-alias-label-secondary,#8b949e)'
			};

			/** The Host's warn ratio; refreshed from GET /config (alertDefaults.warnRatio). */
			var WARN_RATIO = 0.8;
			/** Understood values for the Host's alert contract, so display never contradicts it. */
			var LEVEL_ORDER = { ok: 0, warn: 1, over: 2, unknown: -1 };

			/** A limit is a real threshold only when it is a positive finite number. */
			function isThreshold(limit) {
				return typeof limit === 'number' && isFinite(limit) && limit > 0;
			}

			/**
			 * Fallback alert state, used only when the Host did not supply one.
			 * Mirrors SPEC §2: `todayCost >= limit` → over; `>= limit × warnRatio` → warn;
			 * a null/absent/non-positive limit is never a threshold, so the level is `ok`.
			 */
			function computeLevel(cost, limit) {
				var c = num(cost);
				if (!isFinite(c)) return 'unknown';
				if (!isThreshold(limit)) return 'ok';
				if (c >= limit) return 'over';
				if (c >= limit * WARN_RATIO) return 'warn';
				return 'ok';
			}

			/** Prefer the Host's own level; fall back to the documented rule, never invent. */
			function levelFor(cost, limit, hostAlert) {
				var limitOk = isThreshold(limit);
				if (hostAlert && typeof hostAlert.level === 'string' && hostAlert.level in LEVEL_ORDER) {
					// A non-positive limit means "no threshold" on the Host side too.
					if (!limitOk && hostAlert.level !== 'ok') return 'ok';
					return hostAlert.level;
				}
				return computeLevel(cost, limit);
			}

			/* ------------------------------------------------------------------ *
			 * CSS (inline, injected once, de-duplicated by data-plugin-css)
			 * ------------------------------------------------------------------ */

			var CSS = [
				'.dshfee-pill{display:inline-flex;align-items:center;gap:6px;height:26px;max-width:260px;padding:0 9px;border-radius:999px;',
				'border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-secondary);',
				'font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11px;line-height:1;',
				'font-variant-numeric:tabular-nums;cursor:pointer;white-space:nowrap;overflow:hidden}',
				'.dshfee-pill:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3));color:var(--dsw-alias-label-primary)}',
				'.dshfee-pill:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));outline-offset:1px}',
				'.dshfee-pill-name{overflow:hidden;text-overflow:ellipsis;max-width:110px}',
				'.dshfee-pill-cost{color:var(--dsw-alias-label-primary);font-weight:600}',
				'.dshfee-dot{width:7px;height:7px;border-radius:50%;flex:none;background:var(--dsw-alias-label-quaternary)}',

				'.dshfee-mask{position:fixed;inset:0;z-index:80;background:color-mix(in srgb,var(--dsw-alias-bg-base,#000) 55%,transparent);display:flex;align-items:flex-start;justify-content:center;padding:56px 16px 24px}',
				'.dshfee-panel{width:min(680px,100%);max-height:min(76vh,820px);overflow:auto;overscroll-behavior:contain;',
				'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);',
				'border-radius:12px;box-shadow:0 18px 48px rgba(0,0,0,.38);font-size:13px;',
				'font-family:var(--ds-font-family-code,ui-monospace,SFMono-Regular,Menlo,monospace)}',
				'.dshfee-panel *{box-sizing:border-box}',
				'.dshfee-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 14px;border-bottom:1px solid var(--dsw-alias-border-l1);position:sticky;top:0;background:var(--dsw-alias-bg-layer-1);z-index:2}',
				'.dshfee-head h2{margin:0;font-size:13px;font-weight:600;flex:1;min-width:120px}',
				'.dshfee-seg{display:inline-flex;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;overflow:hidden}',
				'.dshfee-seg button{border:0;background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:11px;padding:4px 9px;cursor:pointer}',
				'.dshfee-seg button[data-on="1"]{background:var(--dsw-alias-bg-layer-3);color:var(--dsw-alias-label-primary)}',
				'.dshfee-body{padding:12px 14px 16px;display:flex;flex-direction:column;gap:14px}',
				'.dshfee-card{background:var(--dsw-alias-bg-layer-2);border:1px solid var(--dsw-alias-border-l1);border-radius:10px;padding:12px}',
				'.dshfee-card h3{margin:0 0 10px;font-size:12px;font-weight:600;color:var(--dsw-alias-label-primary)}',
				'.dshfee-big{font-size:30px;font-weight:600;line-height:1.05;font-variant-numeric:tabular-nums}',
				'.dshfee-sub{color:var(--dsw-alias-label-secondary);font-size:11px;margin-top:4px}',
				'.dshfee-row{display:flex;align-items:center;gap:10px}',
				'.dshfee-muted{color:var(--dsw-alias-label-secondary)}',
				'.dshfee-empty{padding:18px 10px;text-align:center;color:var(--dsw-alias-label-secondary);font-size:12px;line-height:1.6}',
				'.dshfee-err{margin:0 0 10px;padding:9px 11px;border-radius:8px;border:1px solid color-mix(in srgb,var(--dsw-alias-state-danger-primary,#f85149) 45%,transparent);',
				'background:color-mix(in srgb,var(--dsw-alias-state-danger-primary,#f85149) 12%,transparent);color:var(--dsw-alias-label-primary);font-size:12px;display:flex;gap:8px;align-items:flex-start;flex-wrap:wrap}',
				'.dshfee-err b{font-weight:600}',
				'.dshfee-btn{border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary);',
				'font:inherit;font-size:11px;border-radius:7px;padding:4px 10px;cursor:pointer;flex:none}',
				'.dshfee-btn:hover{background:var(--dsw-alias-interactive-bg-hover,var(--dsw-alias-bg-layer-3))}',
				'.dshfee-btn[disabled]{opacity:.55;cursor:default}',
				'.dshfee-btn-primary{background:var(--dsw-alias-brand-primary,var(--dsw-alias-bg-layer-3));color:var(--dsw-alias-label-primary-inverse,#fff);border-color:transparent}',
				'.dshfee-bars{display:flex;flex-direction:column;gap:7px}',
				'.dshfee-bar{display:grid;grid-template-columns:132px 1fr 84px;align-items:center;gap:8px;cursor:default}',
				'.dshfee-bar-name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-primary);font-size:12px}',
				'.dshfee-bar-track{height:12px;border-radius:4px;background:var(--dsw-alias-bg-layer-1);overflow:hidden;min-width:20px}',
				'.dshfee-bar-fill{height:100%;border-radius:4px;background:var(--dsw-alias-label-secondary)}',
				'.dshfee-bar-cost{text-align:right;font-variant-numeric:tabular-nums;font-size:12px}',
				'.dshfee-bar[data-current="1"] .dshfee-bar-name{font-weight:600}',
				'.dshfee-chart{display:block;width:100%;height:auto;overflow:visible}',
				'.dshfee-axis{fill:var(--dsw-alias-label-secondary);font-size:9px;font-family:inherit}',
				'.dshfee-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1}',
				'.dshfee-barrect{fill:var(--dsw-alias-label-secondary)}',
				'.dshfee-barrect[data-level="warn"]{fill:var(--dsw-alias-state-warning-primary,#d29922)}',
				'.dshfee-barrect[data-level="over"]{fill:var(--dsw-alias-state-danger-primary,#f85149)}',
				'.dshfee-barrect[data-level="ok"]{fill:var(--dsw-alias-state-success-primary,#3fb950)}',
				'.dshfee-legend{display:flex;gap:12px;flex-wrap:wrap;margin-top:8px;color:var(--dsw-alias-label-secondary);font-size:11px}',
				'.dshfee-legend span{display:inline-flex;align-items:center;gap:5px}',
				'.dshfee-legend i{width:9px;height:9px;border-radius:2px;display:inline-block}',
				'.dshfee-stack{display:flex;height:10px;border-radius:4px;overflow:hidden;background:var(--dsw-alias-bg-layer-1);min-width:60px}',
				'.dshfee-stack i{display:block;height:100%}',
				'.dshfee-table{width:100%;border-collapse:collapse;font-size:11.5px;font-variant-numeric:tabular-nums}',
				'.dshfee-table th,.dshfee-table td{text-align:left;padding:5px 6px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
				'.dshfee-table th{color:var(--dsw-alias-label-secondary);font-weight:500;position:sticky;top:0;background:var(--dsw-alias-bg-layer-2)}',
				'.dshfee-table td.num,.dshfee-table th.num{text-align:right}',
				'.dshfee-details{border:1px solid var(--dsw-alias-border-l1);border-radius:10px;background:var(--dsw-alias-bg-layer-2)}',
				'.dshfee-details>summary{cursor:pointer;padding:10px 12px;font-size:12px;font-weight:600;border-radius:10px;list-style:none;display:flex;align-items:center;gap:8px}',
				'.dshfee-details>summary::-webkit-details-marker{display:none}',
				'.dshfee-details>summary::before{content:"▸";color:var(--dsw-alias-label-secondary);font-size:10px}',
				'.dshfee-details[open]>summary::before{content:"▾"}',
				'.dshfee-details>summary:focus-visible{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));outline-offset:-2px}',
				'.dshfee-details .dshfee-dbody{padding:2px 12px 12px;display:flex;flex-direction:column;gap:10px}',
				'.dshfee-hint{color:var(--dsw-alias-label-secondary);font-size:11px;line-height:1.5}',
				'.dshfee-field{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
				'.dshfee-input{font:inherit;font-size:11.5px;width:96px;padding:4px 7px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);',
				'background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums}',
				'.dshfee-input:focus{outline:2px solid var(--dsw-alias-brand-primary,var(--dsw-alias-label-primary));outline-offset:-1px}',
				'.dshfee-input[aria-invalid="true"]{border-color:var(--dsw-alias-state-danger-primary,#f85149)}',
				'.dshfee-input-wide{width:150px}',
				'.dshfee-select{font:inherit;font-size:11.5px;padding:4px 7px;border-radius:7px;border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}',
				// 预警线网格：**每个工作区是一个格子**（.rowlabel 左 / 日线 / 总线），
				// 行内再用 flex 排两条线。若把标签与两个输入框作为并列元素交给网格，
				// 它们会各占一格，第二个工作区的标签就会掉进输入框那一列 —— 错位。
				'.dshfee-alertgrid{display:grid;grid-template-columns:minmax(150px,1fr) auto;gap:10px 12px;align-items:center}',
				'.dshfee-alertgrid .lbl{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
				'.dshfee-alertgrid .lbl-c{display:flex;align-items:center;gap:6px;min-width:0}',
				'.dshfee-alertgrid .lbl-c .name{overflow:hidden;text-overflow:ellipsis}',
				'.dshfee-alertrow{display:contents}',
				'.dshfee-alertgrid .lines{display:flex;align-items:center;gap:12px;flex-wrap:wrap;justify-content:flex-end}',
				'.dshfee-alertgrid .line{display:flex;align-items:center;gap:4px}',
				'.dshfee-alertgrid .tag{font-size:10.5px;flex:none}',
				'.dshfee-alertgrid .spent{font-size:10.5px;flex:none}',
				// 窄屏：每个工作区改成整行，标签在上、两条线在下且左对齐
				'@media (max-width:560px){.dshfee-alertgrid{grid-template-columns:1fr}',
				'.dshfee-alertgrid .lines{grid-column:1 / -1;justify-content:flex-start}',
				'.dshfee-alertgrid .lbl-c{flex-wrap:wrap}}',
				'.dshfee-span2{grid-column:1/-1}',
				'.dshfee-inline-err{grid-column:1/-1;color:var(--dsw-alias-state-danger-primary,#f85149);font-size:11px}',
				'.dshfee-chip{display:inline-flex;align-items:center;gap:5px;font-size:10.5px;color:var(--dsw-alias-label-secondary);',
				'border:1px solid var(--dsw-alias-border-l1);border-radius:999px;padding:1px 7px}',
				'.dshfee-version{border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;display:flex;flex-direction:column;gap:6px}',
				'.dshfee-version[data-active="1"]{border-color:color-mix(in srgb,var(--dsw-alias-state-success-primary,#3fb950) 45%,transparent)}',
				'.dshfee-impact{border:1px solid color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 45%,transparent);',
				'background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#d29922) 10%,transparent);border-radius:8px;padding:9px 11px;font-size:11px;line-height:1.55}',
				'.dshfee-link{color:var(--dsw-alias-state-info-primary,#58a6ff);text-decoration:none}',
				'@media (max-width:520px){',
				'.dshfee-mask{padding:24px 8px 12px}',
				'.dshfee-panel{max-height:86vh}',
				'.dshfee-bar{grid-template-columns:1fr;gap:3px}',
				'.dshfee-bar-cost{text-align:left}',
				'.dshfee-table th,.dshfee-table td{white-space:normal}',
				'.dshfee-big{font-size:25px}',
				'}'
			].join('');

			function ensureStyle() {
				if (typeof document === 'undefined') return;
				var tagId = NS + '/client.css';
				if (document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') !== null) return;
				var tag = document.createElement('style');
				tag.dataset.plugin = NS;
				tag.dataset.pluginCss = tagId;
				tag.textContent = CSS;
				document.head.appendChild(tag);
			}

			/* ------------------------------------------------------------------ *
			 * formatting / parsing helpers
			 * ------------------------------------------------------------------ */

			function basename(p) {
				if (typeof p !== 'string' || p === '') return '';
				var s = p.replace(/[\\/]+$/, '');
				var i = Math.max(s.lastIndexOf('\\'), s.lastIndexOf('/'));
				return i >= 0 ? s.slice(i + 1) : s;
			}

			/** Whole Chinese yuan for the compact capsule. */
			function fmtYuan(v) {
				var n = num(v);
				if (!isFinite(n)) return '—';
				if (n === 0) return '¥0';
				if (Math.abs(n) < 10) return '¥' + n.toFixed(2);
				return '¥' + n.toFixed(0);
			}

			/** Up to four significant decimals, trailing zeros trimmed. */
			function fmtYuanExact(v) {
				var n = num(v);
				if (!isFinite(n)) return '—';
				var s = n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '');
				return '¥' + (s === '' ? '0' : s);
			}

			function fmtInt(v) {
				var n = num(v);
				if (!isFinite(n)) return '—';
				return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
			}

			/** Compact token count for tight columns (1.2M / 340k). */
			function fmtCompact(v) {
				var n = num(v);
				if (!isFinite(n)) return '—';
				var abs = Math.abs(n);
				if (abs >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, '') + 'B';
				if (abs >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
				if (abs >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, '') + 'k';
				return String(Math.round(n));
			}

			function num(v) {
				return typeof v === 'number' && isFinite(v) ? v : NaN;
			}

			function intOrNull(v) {
				return typeof v === 'number' && isFinite(v) ? Math.round(v) : null;
			}

			/** 'YYYY-MM-DD HH:mm' → epoch ms (browser local = the operator's wall clock). */
			function parseLocalTime(s) {
				if (typeof s !== 'string') return NaN;
				var m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/.exec(s.trim());
				if (!m) return NaN;
				var d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0);
				var t = d.getTime();
				return isFinite(t) ? t : NaN;
			}

			function localParts(epochMs) {
				var d = new Date(epochMs);
				var p = function (n) { return n < 10 ? '0' + n : String(n); };
				return {
					date: d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()),
					time: p(d.getHours()) + ':' + p(d.getMinutes())
				};
			}

			function nowLocalParts() {
				return localParts(Date.now());
			}

			/**
			 * Alert state for a cost against an optional limit, kept only for the local
			 * pre-save preview. `cost >= limit` counts as `over` (the line has been
			 * reached), and a null/absent/non-positive limit is not a threshold at all.
			 */
			function levelOf(cost, limit) {
				var c = num(cost);
				if (!isFinite(c)) return { level: 'unknown', ratio: null };
				if (!isThreshold(limit)) return { level: 'ok', ratio: null };
				var ratio = c / limit;
				if (c >= limit) return { level: 'over', ratio: ratio };
				if (ratio >= WARN_RATIO) return { level: 'warn', ratio: ratio };
				return { level: 'ok', ratio: ratio };
			}

			/** Skip background polls while the page is hidden, so a parked tab stops hitting the Host. */
			function pageVisible() {
				return typeof document === 'undefined' || document.visibilityState !== 'hidden';
			}

			/** The limit the Host actually used for one entity, else null. */
			function limitOf(entity) {
				return entity && entity.alert && isThreshold(entity.alert.limit) ? entity.alert.limit : null;
			}

			/** Final level used for painting: the Host's verdict when present. */
			function displayLevel(entity) {
				var limit = limitOf(entity);
				if (!limit) return 'ok';
				var cost = entity && typeof entity.cost === 'number' ? entity.cost : (entity ? entity.todayCost : NaN);
				return levelFor(cost, limit, entity ? entity.alert : null);
			}

			function levelColor(level) {
				return COLORS[level] || COLORS.unknown;
			}

			function levelText(level) {
				if (level === 'over') return '已超预警线';
				if (level === 'warn') return '接近预警线';
				if (level === 'ok') return '正常';
				return '未知';
			}

			/**
			 * Normalize one `Tokens` object into the client's four display buckets.
			 *
			 * SPEC §4.1 (v1.1) is the authority here:
			 *   - `inputTokens` is ALREADY the uncached bucket (`prompt_tokens - cacheRead`,
			 *     互斥桶) — cacheRead must NOT be subtracted from it a second time;
			 *   - `reasoningTokens` is a SUBSET of `completion_tokens`, so `outputTokens`
			 *     already includes it; it is a sub-figure, never a separate billed bucket.
			 *
			 * Derived names (`cachedInput`/`uncachedInput`) are accepted first because the
			 * frozen v1 contract named them; the raw log keys are the fallback. Accepting
			 * both keeps a rename on either side from silently zeroing the token detail.
			 */
			function normTokens(raw) {
				var o = raw && typeof raw === 'object' ? raw : {};
				var hit = num(o.cachedInput);
				if (!isFinite(hit)) hit = isFinite(num(o.cacheReadTokens)) ? num(o.cacheReadTokens) : 0;
				var miss = num(o.uncachedInput);
				if (!isFinite(miss)) miss = isFinite(num(o.inputTokens)) ? num(o.inputTokens) : 0;
				var out = num(o.output);
				if (!isFinite(out)) out = isFinite(num(o.outputTokens)) ? num(o.outputTokens) : 0;
				var reason = num(o.reasoning);
				if (!isFinite(reason)) reason = isFinite(num(o.reasoningTokens)) ? num(o.reasoningTokens) : 0;
				return { hit: hit, miss: miss, out: out, reasoning: reason };
			}

			/**
			 * The Host's own token total, when supplied. `reasoning` is a subset of
			 * `output`, so the four buckets must never simply be added together.
			 */
			function hostTokenTotalOf(raw) {
				var t = num(raw && raw.totalTokens);
				return isFinite(t) ? t : null;
			}

			/** Sum of the non-overlapping billed buckets shown in the charts. */
			function tokenSum(t) {
				return t.hit + t.miss + t.out;
			}

			function tokensOf(raw) {
				return normTokens(raw);
			}

			function addTokens(a, b) {
				return {
					hit: a.hit + b.hit,
					miss: a.miss + b.miss,
					out: a.out + b.out,
					reasoning: a.reasoning + b.reasoning
				};
			}

			function zeroTokens() {
				return { hit: 0, miss: 0, out: 0, reasoning: 0 };
			}

			/* ------------------------------------------------------------------ *
			 * host access
			 * ------------------------------------------------------------------ */

			function NetworkError(message, status) {
				var e = new Error(message);
				e.name = 'FeeNetworkError';
				e.status = status;
				return e;
			}

			/** Human sentence for a failed response, including the host's own error text. */
			function describeFailure(status, body) {
				var detail = body && typeof body === 'object' && typeof body.error === 'string' ? body.error : '';
				if (status === 401 || status === 403) return '需要登录后才能读取费用数据（HTTP ' + status + '）。请在本页登录后重试。';
				if (status === 409) return detail || '历史价格版本不可修改，请追加新版本。';
				if (status === 400) return detail || '请求参数不合法（HTTP 400）。';
				if (status === 0) return '部分响应不是合法 JSON，数据可能不完整。';
				return '宿主返回 HTTP ' + status + (detail ? '：' + detail : '。');
			}

			function readJson(res) {
				return res.text().then(function (text) {
					var body = null;
					var bad = false;
					if (text && text.length > 0) {
						try {
							body = JSON.parse(text);
						} catch (e) {
							bad = true;
						}
					}
					if (!res.ok) throw NetworkError(describeFailure(res.status, body), res.status);
					if (bad) throw NetworkError(describeFailure(0, null), 0);
					if (body === null || typeof body !== 'object') {
						throw NetworkError('宿主返回了空响应，无法解析费用数据。', res.status);
					}
					if (body.ok === false) {
						throw NetworkError(typeof body.error === 'string' ? body.error : '宿主拒绝了该请求。', res.status);
					}
					return body;
				});
			}

			function requestJson(url, init, signal) {
				var opts = { credentials: 'same-origin', signal: signal };
				if (init) {
					if (init.method) opts.method = init.method;
					if (init.body !== undefined) {
						opts.headers = { 'content-type': 'application/json' };
						opts.body = JSON.stringify(init.body);
					}
				}
				return fetch(url, opts).catch(function (err) {
					if (err && err.name === 'AbortError') throw err;
					var netErr = new Error('无法连接宿主（' + (err && err.message ? err.message : '网络错误') + '）。');
					netErr.name = 'FeeNetworkError';
					netErr.status = -1;
					netErr.reason = err && err.name;
					throw netErr;
				}).then(readJson);
			}

			function fetchSummary(sessionId, days, signal) {
				var q = '?days=' + encodeURIComponent(String(days));
				if (typeof sessionId === 'string' && sessionId !== '') {
					q += '&sessionId=' + encodeURIComponent(sessionId);
				}
				return requestJson(API + '/summary' + q, null, signal);
			}

			function fetchConfig(signal) {
				return requestJson(API + '/config', null, signal);
			}

			function postConfig(body, signal) {
				return requestJson(API + '/config', { method: 'POST', body: body }, signal);
			}

			function postRefresh(signal) {
				return requestJson(API + '/refresh', { method: 'POST', body: {} }, signal);
			}

			/* ------------------------------------------------------------------ *
			 * small UI atoms
			 * ------------------------------------------------------------------ */

			function Dot(props) {
				var level = props.level || 'unknown';
				return jsx('span', {
					className: 'dshfee-dot',
					style: { background: levelColor(level) },
					'aria-hidden': 'true'
				});
			}

			function ErrorNote(props) {
				var message = props.message || '未知错误';
				return jsxs('div', {
					className: 'dshfee-err',
					role: 'alert',
					children: [
						jsxs('span', { children: [jsx('b', { children: '出错了：' }), message] }),
						props.onRetry ? jsx('button', {
							type: 'button',
							className: 'dshfee-btn',
							onClick: props.onRetry,
							children: '重试'
						}) : null
					]
				});
			}

			function Empty(props) {
				return jsx('div', { className: 'dshfee-empty', children: props.children });
			}

			function Section(props) {
				return jsxs('details', {
					className: 'dshfee-details',
					onToggle: props.onToggle,
					children: [
						jsx('summary', { children: props.title }),
						jsx('div', { className: 'dshfee-dbody', children: props.children })
					]
				});
			}

			/**
			 * Share bar for one workspace's tokens.
			 *
			 * Draws exactly the three non-overlapping billed buckets (cache hit /
			 * uncached input / output). `reasoning` is a SUBSET of `output` (SPEC §4.1),
			 * so it is never a fourth segment — drawing it would double-count it.
			 */
			function TokenStack(props) {
				var t = props.tokens;
				var total = t.hit + t.miss + t.out;
				if (total <= 0 && t.reasoning <= 0) {
					return jsx('div', { className: 'dshfee-muted', style: { fontSize: '11px' }, children: '无 token 记录' });
				}
				var seg = function (value, color, label) {
					if (value <= 0 || total <= 0) return null;
					return jsx('i', {
						style: { width: (value / total * 100) + '%', background: color },
						title: label + '：' + fmtInt(value) + '（' + (value / total * 100).toFixed(1) + '%）'
					});
				};
				var caption = '缓存命中 ' + fmtInt(t.hit) + '，未命中 ' + fmtInt(t.miss) + '，输出 ' + fmtInt(t.out);
				if (t.reasoning > 0) caption += '（其中思考 ' + fmtInt(t.reasoning) + '，已含在输出内）';
				return jsxs('div', { children: [
					jsxs('div', {
						className: 'dshfee-stack',
						role: 'img',
						'aria-label': caption,
						children: [
							seg(t.hit, COLORS.hit, '缓存命中'),
							seg(t.miss, COLORS.miss, '未命中'),
							seg(t.out, COLORS.out, '输出')
						]
					}),
					t.reasoning > 0
						? jsx('div', { className: 'dshfee-muted', style: { fontSize: '10px', marginTop: '2px' }, children: '其中思考 ' + fmtInt(t.reasoning) + '（已含在「输出」内，不另计）' })
						: null
				] });
			}

			/* ------------------------------------------------------------------ *
			 * charts (inline SVG/CSS only)
			 * ------------------------------------------------------------------ */

			/** Horizontal per-workspace cost bars, coloured by alert level. */
			function WorkspaceBars(props) {
				var rows = props.rows;
				var currentId = props.currentId;
				if (rows.length === 0) return jsx(Empty, { children: '这段时间还没有任何工作区产生费用。' });
				var max = 0;
				for (var i = 0; i < rows.length; i++) {
					var c = num(rows[i].cost);
					if (isFinite(c) && c > max) max = c;
				}
				return jsx('div', {
					className: 'dshfee-bars',
					role: 'list',
					children: rows.map(function (w) {
						var cost = num(w.cost);
						var pct = max > 0 && isFinite(cost) ? Math.max(1.5, cost / max * 100) : 0;
						var tip = w.label + '：' + fmtYuanExact(cost) + '（' + fmtInt(w.tokens) + ' tokens，' + fmtInt(w.sessions) + ' 个会话）'
							+ '｜缓存命中 ' + fmtInt(w.tk.hit) + '，未命中 ' + fmtInt(w.tk.miss) + '，输出 ' + fmtInt(w.tk.out);
						return jsxs('div', {
							className: 'dshfee-bar',
							role: 'listitem',
							'data-current': w.workspaceId === currentId ? '1' : '0',
							title: tip,
							children: [
								jsx('span', { className: 'dshfee-bar-name', title: w.cwd || w.label, children: w.label + (w.workspaceId === currentId ? '（当前）' : '') }),
								jsx('span', { className: 'dshfee-bar-track', children: jsx('span', {
									className: 'dshfee-bar-fill',
									style: { width: pct + '%', background: levelColor(w.level) }
								}) }),
								jsx('span', { className: 'dshfee-bar-cost', children: fmtYuanExact(cost) })
							]
						});
					})
				});
			}

			/** Per-day cost columns; every column carries a native title tooltip. */
			function DailyTrend(props) {
				var days = props.days;
				if (days.length === 0) return jsx(Empty, { children: '这段时间还没有按日数据。' });
				var max = 0;
				var sum = 0;
				for (var i = 0; i < days.length; i++) {
					var c = num(days[i].cost);
					if (isFinite(c)) {
						sum += c;
						if (c > max) max = c;
					}
				}
				var w = 640;
				var h = 132;
				var padL = 4;
				var padB = 16;
				var padT = 6;
				var plotH = h - padB - padT;
				var slot = (w - padL * 2) / days.length;
				var barW = Math.max(2, Math.min(14, slot - 2));
				var labelEvery = Math.max(1, Math.ceil(days.length / 8));
				var children = [];
				children.push(jsx('line', {
					className: 'dshfee-grid',
					x1: padL, y1: h - padB, x2: w - padL, y2: h - padB
				}));
				for (var k = 0; k < days.length; k++) {
					var d = days[k];
					var cost = num(d.cost);
					var val = isFinite(cost) && cost > 0 ? cost : 0;
					var barH = max > 0 ? Math.max(val > 0 ? 1.5 : 0, val / max * plotH) : 0;
					var x = padL + k * slot + (slot - barW) / 2;
					var y = h - padB - barH;
					children.push(jsx('rect', {
						className: 'dshfee-barrect',
						'data-level': d.level || 'unknown',
						x: x,
						y: y,
						width: barW,
						height: barH,
						rx: 2,
						children: jsx('title', { children: d.date + '：' + fmtYuanExact(cost) + '（缓存命中 ' + fmtInt(d.tk.hit) + '，未命中 ' + fmtInt(d.tk.miss) + '，输出 ' + fmtInt(d.tk.out) + '）' })
					}));
					if (k % labelEvery === 0) {
						children.push(jsx('text', {
							className: 'dshfee-axis',
							x: x + barW / 2,
							y: h - 4,
							textAlign: 'middle',
							textAnchor: 'middle',
							children: d.date.slice(5)
						}));
					}
				}
				return jsxs('div', {
					children: [
						jsxs('svg', {
							className: 'dshfee-chart',
							viewBox: '0 0 ' + w + ' ' + h,
							preserveAspectRatio: 'none',
							role: 'img',
							'aria-label': '近 ' + days.length + ' 天每日费用柱状图，区间合计 ' + fmtYuanExact(sum),
							children: children
						}),
						jsx('div', { className: 'dshfee-sub', children: '区间合计 ' + fmtYuanExact(sum) + '　峰值 ' + fmtYuanExact(max) + '　悬停查看当天与 token 明细' })
					]
				});
			}

			/* ------------------------------------------------------------------ *
			 * panel
			 * ------------------------------------------------------------------ */

			function Panel(props) {
				var sessionId = props.sessionId;
				var onClose = props.onClose;
				var refreshToken = props.refreshToken;

				var initial = readPrefs();
				var daysState = useState(daysPref(initial.days));
				var days = daysState[0];
				var setDays = daysState[1];

				var stateStore = useState({ status: 'loading', data: null, error: null, refreshedAt: 0 });
				var state = stateStore[0];
				var setState = stateStore[1];

				var showAllState = useState(false);
				var showAll = showAllState[0];
				var setShowAll = showAllState[1];

				var busyState = useState('');
				var busy = busyState[0];
				var setBusy = busyState[1];

				var configStore = useState({ status: 'idle', data: null, error: null });
				var configState = configStore[0];
				var setConfigState = configStore[1];

				var draftStore = useState({});
				var drafts = draftStore[0];
				var setDrafts = draftStore[1];

				var localErrStore = useState({});
				var localErrs = localErrStore[0];
				var setLocalErrs = localErrStore[1];

				var globalErrState = useState('');
				var globalErr = globalErrState[0];
				var setGlobalErr = globalErrState[1];

				var priceModeState = useState(typeof initial.priceMode === 'string' ? initial.priceMode : 'preset');
				var priceMode = priceModeState[0];
				var setPriceMode = priceModeState[1];

				var appendAtState = useState(function () {
					var now = nowLocalParts();
					return { date: now.date, time: now.time, note: '', prices: null, errors: {} };
				});
				var appendAt = appendAtState[0];
				var setAppendAt = appendAtState[1];

				var recalcState = useState({ open: false, date: nowLocalParts().date, time: '00:00', confirm: '', errors: {} });
				var recalc = recalcState[0];
				var setRecalc = recalcState[1];

				var panelRef = useRef(null);
				var maskRef = useRef(null);

				useEffect(function () {
					writePrefs({ days: days, priceMode: priceMode });
				}, [days, priceMode]);

				var load = useCallback(function (mode) {
					var ctrl = new AbortController();
					setState(function (prev) {
						return { status: prev.data ? 'refreshing' : 'loading', data: prev.data, error: null, refreshedAt: prev.refreshedAt };
					});
					fetchSummary(sessionId, days, ctrl.signal).then(function (data) {
						setState({ status: 'ready', data: data, error: null, refreshedAt: Date.now() });
					}).catch(function (err) {
						if (err && err.name === 'AbortError') return;
						setState(function (prev) {
							return { status: prev.data ? 'ready' : 'error', data: prev.data, error: err, refreshedAt: prev.refreshedAt };
						});
					});
					return ctrl;
				}, [sessionId, days]);

				useEffect(function () {
					var ctrl = load();
					return function () { ctrl.abort(); };
				}, [load, refreshToken]);

				useEffect(function () {
					var timer = setInterval(function () {
						if (!pageVisible()) return; // hidden tab: do not poll the Host
						var ctrl = new AbortController();
						fetchSummary(sessionId, days, ctrl.signal).then(function (data) {
							setState({ status: 'ready', data: data, error: null, refreshedAt: Date.now() });
						}).catch(function () { /* keep last good data */ });
					}, POLL_MS);
					return function () { clearInterval(timer); };
				}, [sessionId, days]);

				useEffect(function () {
					var onKey = function (event) {
						if (event.key === 'Escape' || event.key === 'Esc') {
							event.preventDefault();
							onClose();
						}
					};
					document.addEventListener('keydown', onKey);
					if (panelRef.current && typeof panelRef.current.focus === 'function') panelRef.current.focus();
					return function () { document.removeEventListener('keydown', onKey); };
				}, [onClose]);

				var onMaskDown = useCallback(function (event) {
					if (event.target === maskRef.current) onClose();
				}, [onClose]);

				var data = state.data;
				// Host-reported configuration warnings (SPEC §2): the only surface where a
				// user can learn that a self-made pricing version left coverage gaps.
				var configProblems = configState.data && Array.isArray(configState.data.problems) ? configState.data.problems : [];
				var problems = configProblems.map(function (p) {
					if (typeof p === 'string') return p;
					if (p && typeof p === 'object') return String(p.message || p.detail || p.code || JSON.stringify(p));
					return String(p);
				});
				var unpriced = configState.data && configState.data.diagnostics && typeof configState.data.diagnostics.unpricedUsageRecords === 'number'
					? configState.data.diagnostics.unpricedUsageRecords
					: 0;
				// Prefer the Host's own totals so a displayed number can never contradict it;
				// `reasoning` is a subset of `output`, so summing all four would be wrong.
				var windowTokenTotal = (function () {
					var sum = 0;
					var seen = false;
					if (data && Array.isArray(data.workspaces)) {
						data.workspaces.forEach(function (w) {
							var t = hostTokenTotalOf(w.tokens);
							if (t !== null) { sum += t; seen = true; }
						});
					} else if (data && data.totals && data.totals.tokens) {
						var tt = hostTokenTotalOf(data.totals.tokens);
						if (tt !== null) { sum = tt; seen = true; }
					}
					return seen ? sum : null;
				})();
				var workspaces = data && Array.isArray(data.workspaces) ? data.workspaces : [];
				var dailyRows = data && Array.isArray(data.daily) ? data.daily : [];
				var current = data && data.current ? data.current : null;
				var totals = data && data.totals ? data.totals : null;

				// 双预警线：每个工作区两条线（day = 日线，total = 总线）。
				// 兼容旧的单值形态（数字 / {limit}）—— 一律理解为**日线**，总线为 null。
				var alertLimits = useMemo(function () {
					var out = {};
					var pick = function (v, which) {
						if (!v || typeof v !== 'object') return null;
						var raw = which === 'total' ? v.total : (v.day !== undefined ? v.day : v.limit);
						return typeof raw === 'number' && isFinite(raw) ? raw : null;
					};
					var alerts = configState.data && configState.data.alerts ? configState.data.alerts : null;
					if (alerts) {
						Object.keys(alerts).forEach(function (k) {
							out[k] = { day: pick(alerts[k], 'day'), total: pick(alerts[k], 'total') };
						});
					}
					// The summary's own alert limits win: they are what the host priced against.
					workspaces.forEach(function (w) {
						if (out[w.workspaceId] === undefined) {
							out[w.workspaceId] = {
								day: isThreshold(w.alert && w.alert.day && w.alert.day.limit) ? w.alert.day.limit : (isThreshold(w.alert && w.alert.limit) ? w.alert.limit : null),
								total: isThreshold(w.alert && w.alert.total && w.alert.total.limit) ? w.alert.total.limit : null,
							};
						}
					});
					if (current && out[current.workspaceId] === undefined) {
						out[current.workspaceId] = {
							day: isThreshold(current.alert && current.alert.day && current.alert.day.limit) ? current.alert.day.limit : (isThreshold(current.alert && current.alert.limit) ? current.alert.limit : null),
							total: isThreshold(current.alert && current.alert.total && current.alert.total.limit) ? current.alert.total.limit : null,
						};
					}
					return out;
				}, [configState.data, workspaces, current]);

				var model = useMemo(function () {
					/** 从 summary 的 alert 里取两条线的阈值，兼容旧的单值形态。 */
					var hostLines = function (alert) {
						if (!alert || typeof alert !== 'object') return { day: null, total: null };
						return {
							day: isThreshold(alert.day && alert.day.limit) ? alert.day.limit : (isThreshold(alert.limit) ? alert.limit : null),
							total: isThreshold(alert.total && alert.total.limit) ? alert.total.limit : null
						};
					};
					var rows = workspaces.map(function (w) {
						var tk = tokensOf(w.tokens);
						var host = hostLines(w.alert);
						var local = Object.prototype.hasOwnProperty.call(alertLimits, w.workspaceId) ? alertLimits[w.workspaceId] : null;
						var limitDay = local && isThreshold(local.day) ? local.day : host.day;
						var limitTotal = local && isThreshold(local.total) ? local.total : host.total;
						var lv = levelOf(w.cost, limitDay);
						var hostLevel = displayLevel(w);
						return {
							workspaceId: w.workspaceId,
							label: typeof w.label === 'string' && w.label !== '' ? w.label : (basename(w.cwd) || w.workspaceId),
							cwd: w.cwd,
							sessions: num(w.sessions),
							cost: num(w.cost),
							todayCost: num(w.todayCost),
							lifetimeCost: num(w.lifetimeCost),
							tk: tk,
							tokens: tokenSum(tk),
							limit: limitDay,
							limitTotal: limitTotal,
							// The Host's own verdict wins; the local rule only fills a gap.
							level: w.alert && typeof w.alert.level === 'string' ? hostLevel : lv.level,
							ratio: isThreshold(limitDay) ? (isFinite(num(w.cost)) ? num(w.cost) / limitDay : null) : null,
							hostAlert: w.alert || null
						};
					});
					rows.sort(function (a, b) {
						var av = isFinite(a.cost) ? a.cost : 0;
						var bv = isFinite(b.cost) ? b.cost : 0;
						if (bv !== av) return bv - av;
						return String(a.workspaceId).localeCompare(String(b.workspaceId));
					});

					var byDay = {};
					dailyRows.forEach(function (row) {
						var date = typeof row.date === 'string' ? row.date : '';
						if (date === '') return;
						var tk = tokensOf(row.tokens);
						var bucket = byDay[date] || (byDay[date] = { date: date, cost: 0, tk: zeroTokens(), sessions: 0, entries: [] });
						var c = num(row.cost);
						bucket.cost += isFinite(c) ? c : 0;
						bucket.tk = addTokens(bucket.tk, tk);
						var s = num(row.sessions);
						bucket.sessions += isFinite(s) ? s : 0;
						var label = typeof row.label === 'string' && row.label !== '' ? row.label
							: (typeof row.workspaceId === 'string' ? row.workspaceId : '未命名');
						bucket.entries.push({
							workspaceId: typeof row.workspaceId === 'string' ? row.workspaceId : label,
							label: label,
							cost: isFinite(c) ? c : 0,
							tk: tk
						});
					});
					var dayList = Object.keys(byDay).map(function (k) { return byDay[k]; });
					dayList.sort(function (a, b) { return a.date < b.date ? -1 : (a.date > b.date ? 1 : 0); });
					dayList.forEach(function (bucket) {
						bucket.entries.sort(function (a, b) { return b.cost - a.cost; });
					});

					var windowCost = 0;
					var windowTokens = zeroTokens();
					rows.forEach(function (r) {
						if (isFinite(r.cost)) windowCost += r.cost;
						windowTokens = addTokens(windowTokens, r.tk);
					});

					var topLimit = showAll ? rows.length : Math.min(TOP_WORKSPACES, rows.length);
					return {
						rows: rows,
						top: rows.slice(0, topLimit),
						hiddenCount: Math.max(0, rows.length - topLimit),
						days: dayList,
						windowCost: windowCost,
						windowTokens: windowTokens
					};
				}, [workspaces, dailyRows, alertLimits, showAll]);

				var applyConfig = function (body) {
					setBusy('save');
					setGlobalErr('');
					return postConfig(body, null).then(function () {
						setBusy('');
						var ctrl = new AbortController();
						return fetchSummary(sessionId, days, ctrl.signal).then(function (fresh) {
							setState({ status: 'ready', data: fresh, error: null, refreshedAt: Date.now() });
							return fetchConfig(null).then(function (cfg) {
								if (cfg) setConfigState({ status: 'ready', data: cfg, error: null });
							}).catch(function () { /* summary already refreshed; config echo is best-effort */ });
						});
					}).catch(function (err) {
						setBusy('');
						setGlobalErr(err && err.message ? err.message : String(err));
						throw err;
					});
				};

				var loadConfig = function () {
					if (configState.status === 'loading') return;
					setConfigState(function (prev) {
						return { status: 'loading', data: prev.data, error: null };
					});
					fetchConfig(null).then(function (cfg) {
						setConfigState({ status: 'ready', data: cfg, error: null });
						var warn = cfg && cfg.alertDefaults && typeof cfg.alertDefaults.warnRatio === 'number' && isFinite(cfg.alertDefaults.warnRatio)
							? cfg.alertDefaults.warnRatio
							: null;
						if (warn !== null && warn > 0 && warn <= 1) WARN_RATIO = warn;
						var presets = cfg && cfg.pricing && Array.isArray(cfg.pricing.versions) && cfg.pricing.versions.length > 0
							? cfg.pricing.versions[cfg.pricing.versions.length - 1]
							: null;
						setAppendAt(function (prev) {
							if (prev.prices) return prev;
							var seed = {};
							var models = presets && presets.models ? presets.models : null;
							if (models) {
								Object.keys(models).forEach(function (family) {
									var segs = models[family] && Array.isArray(models[family].segments) ? models[family].segments : [];
									seed[family] = segs.map(function (s) {
										return {
											id: typeof s.id === 'string' ? s.id : '',
											label: typeof s.label === 'string' ? s.label : '',
											days: Array.isArray(s.days) ? s.days.slice() : [],
											from: typeof s.from === 'string' ? s.from : '',
											to: typeof s.to === 'string' ? s.to : '',
											hit: String(s.hit),
											miss: String(s.miss),
											out: String(s.out)
										};
									});
								});
							}
							return { date: prev.date, time: prev.time, note: prev.note, prices: seed, errors: {} };
						});
					}).catch(function (err) {
						setConfigState({ status: 'error', data: null, error: err });
					});
				};

				/**
				 * 保存某个工作区的**两条**预警线（日线 + 总线）。
				 *
				 * 只提交改动的那一条（另一条为 undefined），宿主侧按字段合并 ——
				 * 于是「改日线」不会把已配好的总线抹掉。
				 *
				 * @param workspaceId 工作区 key
				 * @param which 'day' | 'total'
				 * @param raw 输入框里的原始文本（空串 = 取消该条线）
				 */
				var saveAlertLine = function (workspaceId, which, raw, fieldKey) {
					var text = typeof raw === 'string' ? raw.trim() : '';
					var next;
					if (text === '') {
						next = null; // empty input = "no threshold on this line"
					} else {
						var parsed = Number(text);
						if (!isFinite(parsed)) {
							setLocalErrs(function (prev) {
								var o = Object.assign({}, prev);
								o[fieldKey] = '预警线必须是数字（留空表示不预警）';
								return o;
							});
							return;
						}
						if (parsed < 0) {
							setLocalErrs(function (prev) {
								var o = Object.assign({}, prev);
								o[fieldKey] = '预警线不能是负数（留空表示不预警）';
								return o;
							});
							return;
						}
						next = parsed;
					}
					setLocalErrs(function (prev) {
						var o = Object.assign({}, prev);
						delete o[fieldKey];
						return o;
					});
					var body = { alerts: {} };
					var patch = {};
					patch[which] = next;
					body.alerts[workspaceId] = patch;
					applyConfig(body).catch(function () { /* surfaced via globalErr */ });
					setDrafts(function (prev) {
						var o = Object.assign({}, prev);
						o[fieldKey] = text;
						return o;
					});
				};

				/** 兼容旧调用点（单条 = 日线）。 */
				var saveAlert = function (workspaceId, raw) {
					return saveAlertLine(workspaceId, 'day', raw, workspaceId);
				};

				/**
				 * Build a COMPLETE `models` table from the editor seed.
				 *
				 * The Host rejects an empty `models` (约定 5: 追加必须自带完整 models，
				 * 不允许继承上一版本 —— 继承会让价格无法解释). Every `POST /config` body
				 * that carries `pricing.append` must therefore go through here, so a single
				 * place owns the "complete price table" invariant.
				 */
				var buildModels = function () {
					var errors = {};
					var models = {};
					var prices = appendAt.prices;
					var families = prices && typeof prices === 'object' ? Object.keys(prices) : [];
					if (families.length === 0) {
						errors.__pricing = '没有可用的价格模板（需要先成功读取配置），无法提交完整价目表。';
						return { models: models, errors: errors };
					}
					families.forEach(function (family) {
						var segs = (prices[family] || []).map(function (s) {
							var hit = Number(s.hit);
							var miss = Number(s.miss);
							var out = Number(s.out);
							if (!isFinite(hit) || !isFinite(miss) || !isFinite(out) || hit < 0 || miss < 0 || out < 0) {
								errors[family] = '单价必须是 ≥ 0 的数字';
							}
							return {
								id: s.id, label: s.label, days: s.days, from: s.from, to: s.to,
								hit: hit, miss: miss, out: out
							};
						});
						models[family] = { segments: segs };
					});
					return { models: models, errors: errors };
				};

				var submitAppend = function () {
					var at = parseLocalTime(appendAt.date + ' ' + appendAt.time);
					var errors = {};
					if (!isFinite(at)) errors.__effectiveFrom = '请填写生效时刻，格式 YYYY-MM-DD HH:mm';
					var built = buildModels();
					var models = built.models;
					Object.keys(built.errors).forEach(function (k) { errors[k] = built.errors[k]; });
					if (Object.keys(errors).length > 0) {
						setAppendAt(function (prev) { return Object.assign({}, prev, { errors: errors }); });
						return;
					}
					setAppendAt(function (prev) { return Object.assign({}, prev, { errors: {} }); });
					applyConfig({
						pricing: {
							append: {
								effectiveFrom: at,
								note: appendAt.note || '由费用面板追加',
								models: models
							}
						}
					}).then(function () {
						loadConfig();
					}).catch(function () { /* surfaced via globalErr */ });
				};

				var submitRecalc = function () {
					var errors = {};
					if (recalc.confirm !== 'RECALC') {
						errors.__confirm = '请输入 RECALC 以确认重算存量';
					}
					var at = parseLocalTime(recalc.date + ' ' + recalc.time);
					if (!isFinite(at)) errors.__at = '请填写生效时刻，格式 YYYY-MM-DD HH:mm';
					// Same complete-table requirement as `submitAppend`: the Host refuses an
					// empty `models`, so this path must carry the full price table too.
					var built = buildModels();
					var models = built.models;
					Object.keys(built.errors).forEach(function (k) { errors[k] = built.errors[k]; });
					if (Object.keys(errors).length > 0) {
						setRecalc(function (prev) { return Object.assign({}, prev, { errors: errors }); });
						return;
					}
					setRecalc(function (prev) { return Object.assign({}, prev, { errors: {} }); });
					applyConfig({
						pricing: {
							append: {
								effectiveFrom: at,
								note: '从指定时刻起重新计价（提交当前版本完整价目表）',
								models: models
							}
						}
					}).then(function () {
						loadConfig();
					}).catch(function () { /* surfaced via globalErr */ });
				};

				var doRefresh = function () {
					setBusy('refresh');
					setGlobalErr('');
					postRefresh(null).then(function () {
						setBusy('');
						load();
					}).catch(function (err) {
						setBusy('');
						setGlobalErr(err && err.message ? err.message : String(err));
					});
				};

				/* ---- render: header ---- */

				var header = jsxs('div', {
					className: 'dshfee-head',
					children: [
						jsx('h2', { children: '工作区费用' }),
						jsx('div', {
							className: 'dshfee-seg',
							role: 'group',
							'aria-label': '统计区间',
							children: DAY_CHOICES.map(function (d) {
								return jsx('button', {
									type: 'button',
									'data-on': d === days ? '1' : '0',
									'aria-pressed': d === days,
									title: d === ALL_DAYS ? '全量口径：从最早一条计费记录统计到今天' : '统计最近 ' + d + ' 天',
									onClick: function () { setDays(d); },
									children: rangeLabel(d)
								}, d);
							})
						}),
						jsx('button', {
							type: 'button',
							className: 'dshfee-btn',
							disabled: busy === 'refresh',
							title: '强制刷新宿主账本缓存（POST /refresh）',
							onClick: doRefresh,
							children: busy === 'refresh' ? '刷新中…' : '刷新'
						}),
						jsx('button', {
							type: 'button',
							className: 'dshfee-btn',
							'aria-label': '关闭费用面板',
							onClick: onClose,
							children: '关闭'
						})
					]
				});

				/* ---- render: body ---- */

				var bodyChildren = [];

				if (globalErr) {
					bodyChildren.push(jsx(ErrorNote, { message: globalErr, onRetry: null }, 'global-err'));
				}
				if (state.error && state.data) {
					bodyChildren.push(jsx(ErrorNote, {
						message: '本次刷新失败，下面显示的是上次成功的数据：' + (state.error.message || ''),
						onRetry: function () { load(); }
					}, 'stale-err'));
				}

				if (state.status === 'loading' && !data) {
					bodyChildren.push(jsxs('div', { className: 'dshfee-card', children: [
						jsx('div', { className: 'dshfee-big', style: { opacity: 0.5 }, children: '¥—' }),
						jsx('div', { className: 'dshfee-sub', children: '正在读取宿主费用数据…' })
					] }, 'loading'));
				} else if (state.status === 'error' && !data) {
					var status = state.error && typeof state.error.status === 'number' ? state.error.status : -1;
					var isNet = state.error && state.error.name === 'FeeNetworkError';
					bodyChildren.push(jsxs('div', { className: 'dshfee-card', children: [
						jsx('h3', { children: '读不到数据' }),
						jsx(ErrorNote, {
							message: (state.error && state.error.message) || '未知错误',
							onRetry: function () { load(); }
						}),
						jsxs('div', { className: 'dshfee-hint', children: [
							isNet
								? '宿主路由可能未安装或 dsh web 未重启，因此浏览器半加载了但宿主半还没生效。'
								: '当前没有可用于统计的费用记录。',
							jsx('br', {}),
							'接口：GET ' + API + '/summary?days=' + days,
							status >= 0 ? '　状态码：' + status : ''
						] })
					] }, 'error'));
				} else if (data) {
					var isEmpty = model.rows.length === 0 && model.days.length === 0;
					if (isEmpty) {
						bodyChildren.push(jsxs('div', { className: 'dshfee-card', children: [
							jsx('h3', { children: rangeLabelNear(days) + '总花费' }),
							jsx('div', { className: 'dshfee-big', children: fmtYuanExact(0) }),
							jsx('div', { className: 'dshfee-sub', children: '宿主已连通，但' + (days === ALL_DAYS ? '全量口径下' : '近 ' + days + ' 天内') + '还没有任何计费记录。' })
						] }, 'main-empty'));
						bodyChildren.push(jsx('div', { className: 'dshfee-card', children: jsx(Empty, {
							children: jsxs(Fragment, { children: [
								'没有可展示的工作区。',
								jsx('br', {}),
								'生成时间：' + (data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '未知')
							] })
						}) }, 'bars-empty'));
					} else {
						var currentLevel = current ? displayLevel({ cost: current.todayCost, alert: current.alert }) : 'unknown';
						var currentLimit = current ? limitOf({ alert: current.alert }) : null;
						var currentLine = current
							? jsxs('div', { className: 'dshfee-sub', children: [
								jsxs('span', { className: 'dshfee-row', style: { gap: '5px', display: 'inline-flex' }, children: [
									jsx(Dot, { level: currentLevel }),
									'当前工作区 ' + current.label + '（今日 ' + fmtYuanExact(current.todayCost) + '）'
								] }),
								'　',
								'预警线：' + (currentLimit ? fmtYuanExact(currentLimit) : '未设置'),
								'　',
								levelText(currentLevel)
							] })
							: jsx('div', { className: 'dshfee-sub', children: '未能识别当前工作区（宿主未返回 current），下面显示全部工作区合计。' });

						bodyChildren.push(jsxs('div', { className: 'dshfee-card', children: [
							jsx('h3', { children: rangeLabelNear(days) + '总花费' }),
							jsx('div', { className: 'dshfee-big', children: fmtYuanExact(model.windowCost) }),
							currentLine,
							jsxs('div', { className: 'dshfee-sub', children: [
								'共 ' + fmtInt(model.rows.length) + ' 个工作区／' + fmtInt(model.days.length) + ' 天有记录　合计 '
									+ fmtCompact(windowTokenTotal !== null ? windowTokenTotal : tokenSum(model.windowTokens)) + ' tokens'
									+ (windowTokenTotal !== null ? '（宿主 totalTokens）' : '（三桶相加，宿主未给 totalTokens）'),
								totals && typeof totals.cost === 'number' && Math.abs(totals.cost - model.windowCost) > 1e-6
									? '　（宿主 totals：' + fmtYuanExact(totals.cost) + '）' : ''
							] }),
							days === ALL_DAYS && data.window
								? jsx('div', { className: 'dshfee-sub', children: '全量口径区间：' + data.window.from + ' ~ ' + data.window.to + '（北京时间）'
									+ (num(data.diagnostics && data.diagnostics.undatedUsageRecords) > 0
										? '　另有 ' + fmtInt(data.diagnostics.undatedUsageRecords) + ' 条无时间戳记录不在窗口内（只体现在各工作区的累计花费）'
										: '') })
								: null
						] }, 'main'));

						bodyChildren.push(jsxs('div', { className: 'dshfee-card', children: [
							jsx('h3', { children: '按工作区花费（' + rangeLabel(days) + '，颜色=预警状态）' }),
							jsx(WorkspaceBars, { rows: model.top, currentId: current ? current.workspaceId : null }),
							model.hiddenCount > 0 || showAll
								? jsx('div', { style: { marginTop: '8px' }, children: jsx('button', {
									type: 'button',
									className: 'dshfee-btn',
									onClick: function () { setShowAll(!showAll); },
									children: showAll ? '只看前 ' + TOP_WORKSPACES + ' 名' : '展开全部 ' + model.rows.length + ' 个工作区'
								}) })
								: null
						] }, 'bars'));

						bodyChildren.push(jsxs('div', { className: 'dshfee-card', children: [
							jsx('h3', { children: '每日趋势（' + rangeLabelNear(days) + '）' }),
							jsx(DailyTrend, { days: model.days })
						] }, 'trend'));

						if (model.rows.length > 0) {
							bodyChildren.push(jsx(Section, { title: 'Token 明细（按工作区）', children: [
								jsx('div', { className: 'dshfee-legend', children: jsxs(Fragment, { children: [
									jsxs('span', { children: [jsx('i', { style: { background: COLORS.hit } }), '缓存命中'] }),
									jsxs('span', { children: [jsx('i', { style: { background: COLORS.miss } }), '未命中'] }),
									jsxs('span', { children: [jsx('i', { style: { background: COLORS.out } }), '输出'] }),
									jsxs('span', { children: [jsx('i', { style: { background: 'var(--dsw-alias-label-quaternary,#8b949e)' } }), '思考'] })
								] }) }),
								jsxs('table', { className: 'dshfee-table', children: [
									jsx('thead', { children: jsxs('tr', { children: [
										jsx('th', { children: '工作区' }),
										jsx('th', { className: 'num', children: '缓存命中' }),
										jsx('th', { className: 'num', children: '未命中' }),
										jsx('th', { className: 'num', children: '输出' }),
										jsx('th', { className: 'num', children: '费用' }),
										jsx('th', { children: '占比' })
									] }) }),
									jsx('tbody', { children: model.rows.map(function (w) {
										return jsxs('tr', { children: [
											jsx('td', { title: w.cwd || w.label, children: w.label }),
											jsx('td', { className: 'num', children: fmtInt(w.tk.hit) }),
											jsx('td', { className: 'num', children: fmtInt(w.tk.miss) }),
											jsx('td', { className: 'num', children: fmtInt(w.tk.out) }),
											jsx('td', { className: 'num', children: fmtYuanExact(w.cost) }),
											jsx('td', { children: jsx(TokenStack, { tokens: w.tk }) })
										] }, w.workspaceId);
									}) })
								] }),
								jsx('div', { className: 'dshfee-hint', children: '未命中 = 日志的 inputTokens（它本身已是未命中桶，不再减缓存命中）。「占比」条只画三个互不重叠的计费桶；思考 tokens 是「输出」的子集，单独标注、不叠加，也不另计费。' })
							] }, 'tokens'));
						}

						// 按日账单行数上限：7/30/90 天档保持原有的「最近 30 天」，全量档放开到全部日期。
						var billDays = model.days.slice().reverse();
						if (days !== ALL_DAYS) billDays = billDays.slice(0, 30);

						bodyChildren.push(jsx(Section, {
							title: days === ALL_DAYS
								? '按日账单（日期 × 工作区，全量 ' + fmtInt(billDays.length) + ' 天）'
								: '按日账单（日期 × 工作区，近 30 天）',
							children: billDays.length === 0
								? jsx(Empty, { children: days === ALL_DAYS ? '全量口径下没有按日记录。' : '近 30 天没有按日记录。' })
								: jsx('div', {
									style: { maxHeight: '420px', overflow: 'auto' },
									children: jsxs('table', { className: 'dshfee-table', children: [
										jsx('thead', { children: jsxs('tr', { children: [
											jsx('th', { children: '日期' }),
											jsx('th', { children: '工作区' }),
											jsx('th', { className: 'num', children: '会话' }),
											jsx('th', { className: 'num', children: '缓存命中' }),
											jsx('th', { className: 'num', children: '未命中' }),
											jsx('th', { className: 'num', children: '输出' }),
											jsx('th', { className: 'num', children: '费用' })
										] }) }),
										jsx('tbody', { children: billDays.map(function (bucket) {
											return bucket.entries.map(function (entry, idx) {
												var first = idx === 0;
												return jsxs('tr', {
													title: bucket.date + ' ' + entry.label,
													children: [
														jsx('td', { children: first ? bucket.date : '' }),
														jsx('td', { title: entry.workspaceId, children: entry.label }),
														jsx('td', { className: 'num', children: first ? fmtInt(bucket.sessions) : '' }),
														jsx('td', { className: 'num', children: fmtInt(entry.tk.hit) }),
														jsx('td', { className: 'num', children: fmtInt(entry.tk.miss) }),
														jsx('td', { className: 'num', children: fmtInt(entry.tk.out) }),
														jsx('td', { className: 'num', children: fmtYuanExact(entry.cost) })
													]
												}, bucket.date + '/' + entry.workspaceId);
											});
										}) })
									] })
								}),
							onToggle: function () { /* ids are stable; nothing to load */ }
						}, 'daily'));

						bodyChildren.push(jsx(Section, {
							title: '预警线（元，失焦即保存）',
							onToggle: function (event) {
								if (event && event.target && event.target.open) loadConfig();
							},
							children: jsxs(Fragment, { children: [
								jsx('div', { className: 'dshfee-hint', children: '为每个工作区单独设置**两条线**：日线比「今日花费」，总线比「累计花费」。留空 = 该条线不预警。达到线即算「已超」；到 80% 变黄。失焦即保存，状态栏与条形图颜色立即更新。' }),
								configState.status === 'loading' ? jsx('div', { className: 'dshfee-hint', children: '正在读取配置…' }) : null,
								configState.status === 'error' ? jsx(ErrorNote, {
									message: '配置读取失败：' + (configState.error && configState.error.message || '未知错误'),
									onRetry: loadConfig
								}) : null,
								jsx('div', { className: 'dshfee-alertgrid', children: model.rows.map(function (w) {
									var keyDay = w.workspaceId + '::day';
									var keyTotal = w.workspaceId + '::total';
									var draftOf = function (fieldKey, value) {
										return Object.prototype.hasOwnProperty.call(drafts, fieldKey)
											? drafts[fieldKey]
											: (value === null || value === undefined ? '' : String(value));
									};
									var dayDraft = draftOf(keyDay, w.limit);
									var totalDraft = draftOf(keyTotal, w.limitTotal);
									var err = localErrs[keyDay] || localErrs[keyTotal];
									var makeInput = function (fieldKey, which, value, label, placeholder) {
										return jsx('input', {
											className: 'dshfee-input',
											type: 'text',
											inputMode: 'decimal',
											value: value,
											placeholder: placeholder,
											title: label,
											'aria-label': w.label + ' 的' + label,
											'aria-invalid': (localErrs[fieldKey] ? 'true' : 'false'),
											onChange: function (event) {
												var v = event.target.value;
												setDrafts(function (prev) {
													var o = Object.assign({}, prev);
													o[fieldKey] = v;
													return o;
												});
											},
											onBlur: function (event) { saveAlertLine(w.workspaceId, which, event.target.value, fieldKey); },
											onKeyDown: function (event) {
												if (event.key === 'Enter') event.target.blur();
											}
										});
									};
									// **每个工作区恰好是网格里的一个格子**：标签 + 两条线在行内用 flex 排。
									// 早前把「标签 / 日线 / 总线」作为三个并列元素交给网格，网格把它们当三个格子，
									// 于是下一个工作区的标签被挤进了输入框那一列 —— 这就是错位的根因。
									// 样式全部写在 CSS 里（不用内联 style），否则会压过窄屏的媒体查询。
									return jsxs('div', { className: 'dshfee-alertrow', children: [
										jsxs('span', { className: 'lbl lbl-c', children: [
											jsx(Dot, { level: w.level }),
											jsx('span', { title: w.cwd || w.label, className: 'name', children: w.label }),
											jsx('span', { className: 'dshfee-muted spent', children: '今日 ' + fmtYuanExact(w.todayCost) + '　累计 ' + fmtYuanExact(w.lifetimeCost) })
										] }),
										jsxs('div', { className: 'lines', children: [
											jsxs('span', { className: 'line', children: [
												jsx('span', { className: 'dshfee-muted tag', children: '日线' }),
												makeInput(keyDay, 'day', dayDraft, '日预警线', '不预警')
											] }),
											jsxs('span', { className: 'line', children: [
												jsx('span', { className: 'dshfee-muted tag', children: '总线' }),
												makeInput(keyTotal, 'total', totalDraft, '总预警线', '不预警')
											] })
										] }),
										err ? jsx('span', { className: 'dshfee-inline-err', role: 'alert', children: err }) : null
									] }, w.workspaceId);
								}) })
							] })
						}, 'alerts'));

						bodyChildren.push(jsx(Section, {
							title: '价格设置',
							onToggle: function (event) {
								if (event && event.target && event.target.open) loadConfig();
							},
							children: jsxs(Fragment, { children: [
								jsxs('div', { className: 'dshfee-field', children: [
									jsx('label', { htmlFor: 'dshfee-price-mode', className: 'dshfee-muted', children: '价格模式' }),
									jsxs('select', {
										id: 'dshfee-price-mode',
										className: 'dshfee-select',
										value: priceMode,
										onChange: function (event) { setPriceMode(event.target.value); },
										children: [
											jsx('option', { value: 'preset', children: '默认官方价' }),
											jsx('option', { value: 'custom', children: '自定义' })
										]
									}),
									configState.data && configState.data.currency
										? jsx('span', { className: 'dshfee-chip', children: '货币 ' + configState.data.currency })
										: null,
									configState.data && configState.data.pricing && configState.data.pricing.activeVersionId
										? jsx('span', { className: 'dshfee-chip', children: '生效版本 ' + configState.data.pricing.activeVersionId })
										: null
								] }),
								jsx('div', { className: 'dshfee-hint', children: '「默认官方价」使用宿主内置费率，不做任何写入。「自定义」可改各时段单价，且只对生效时刻之后的新用量生效——已入账的历史数字不会被重算。时段按声明顺序命中第一条，保存时按分钟归一；内置版本保证 24/7 全覆盖，自建版本若留了空档，宿主会在下面给出告警。' }),
								problems.length > 0
									? jsxs('div', { className: 'dshfee-impact', role: 'status', children: [
										'⚠️ 宿主配置告警（' + problems.length + ' 条，未计价记录 ' + unpriced + ' 条）：',
										jsx('br', {}),
										problems.slice(0, 5).join('；'),
										problems.length > 5 ? '　…还有 ' + (problems.length - 5) + ' 条' : ''
									] })
									: null,
								unpriced > 0 && problems.length === 0
									? jsxs('div', { className: 'dshfee-impact', role: 'status', children: [
										'⚠️ 宿主报告有 ' + unpriced + ' 条用量记录未计价（未匹配到任何价格时段），这些记录的费用不计入上面的合计。'
									] })
									: null,
								loadVersions(configState, priceMode),
								priceMode === 'custom' || (recalc.open)
									? jsxs('div', { className: 'dshfee-version', children: [
										jsx('b', { children: '追加价格版本（只对之后的新用量生效）' }),
										jsxs('div', { className: 'dshfee-field', children: [
											jsx('label', { className: 'dshfee-muted', children: '生效时刻' }),
											jsx('input', {
												className: 'dshfee-input', type: 'date', value: appendAt.date, 'aria-label': '新版本生效日期',
												onChange: function (e) { var v = e.target.value; setAppendAt(function (p) { return Object.assign({}, p, { date: v }); }); }
											}),
											jsx('input', {
												className: 'dshfee-input', type: 'time', value: appendAt.time, 'aria-label': '新版本生效时间',
												onChange: function (e) { var v = e.target.value; setAppendAt(function (p) { return Object.assign({}, p, { time: v }); }); }
											}),
											jsx('input', {
												className: 'dshfee-input dshfee-input-wide', type: 'text', value: appendAt.note, placeholder: '备注（可选）', 'aria-label': '新版本备注',
												onChange: function (e) { var v = e.target.value; setAppendAt(function (p) { return Object.assign({}, p, { note: v }); }); }
											})
										] }),
										appendAt.errors.__effectiveFrom ? jsx('span', { className: 'dshfee-inline-err', role: 'alert', children: appendAt.errors.__effectiveFrom }) : null,
										appendAt.errors.__pricing ? jsx('span', { className: 'dshfee-inline-err', role: 'alert', children: appendAt.errors.__pricing }) : null,
										renderSegmentEditor(appendAt, setAppendAt),
										jsxs('div', { className: 'dshfee-row', children: [
											jsx('button', {
												type: 'button',
												className: 'dshfee-btn dshfee-btn-primary',
												disabled: busy === 'save',
												onClick: submitAppend,
												children: busy === 'save' ? '提交中…' : '提交新版本（不影响存量）'
											}),
											jsx('span', { className: 'dshfee-hint', children: '提交后返回的生效版本与单价会重新读取显示。' })
										] })
									] })
									: jsx('div', { className: 'dshfee-hint', children: '选择「自定义」后可编辑时段与单价；默认路径不会写入任何配置。' }),
								jsxs('details', {
									className: 'dshfee-details',
									onToggle: function (event) {
										if (event && event.target && event.target.open) {
											setRecalc(function (p) { return Object.assign({}, p, { open: true }); });
										}
									},
									children: [
										jsx('summary', { children: '从指定时刻起重新计价（会重算该时刻之后的存量）' }),
										jsxs('div', { className: 'dshfee-dbody', children: [
											jsx('div', { className: 'dshfee-impact', children: '⚠️ 这一步会重算该时刻之后**已经入账**的历史记录，改动存量数字。默认路径永不这样做。若只是想调价，请用上面的「追加价格版本」。' }),
											jsxs('div', { className: 'dshfee-field', children: [
												jsx('label', { className: 'dshfee-muted', children: '重算起点' }),
												jsx('input', {
													className: 'dshfee-input', type: 'date', value: recalc.date, 'aria-label': '重算起始日期',
													onChange: function (e) { var v = e.target.value; setRecalc(function (p) { return Object.assign({}, p, { date: v }); }); }
												}),
												jsx('input', {
													className: 'dshfee-input', type: 'time', value: recalc.time, 'aria-label': '重算起始时间',
													onChange: function (e) { var v = e.target.value; setRecalc(function (p) { return Object.assign({}, p, { time: v }); }); }
												}),
												jsx('input', {
													className: 'dshfee-input dshfee-input-wide', type: 'text', value: recalc.confirm, placeholder: '输入 RECALC 确认', 'aria-label': '重算确认词',
													onChange: function (e) { var v = e.target.value; setRecalc(function (p) { return Object.assign({}, p, { confirm: v }); }); }
												}),
												jsx('button', {
													type: 'button',
													className: 'dshfee-btn',
													disabled: busy === 'save' || recalc.confirm !== 'RECALC',
													onClick: submitRecalc,
													children: '确认重算存量'
												})
											] }),
											recalc.errors.__confirm ? jsx('span', { className: 'dshfee-inline-err', role: 'alert', children: recalc.errors.__confirm }) : null,
											recalc.errors.__at ? jsx('span', { className: 'dshfee-inline-err', role: 'alert', children: recalc.errors.__at }) : null,
											recalc.errors.__pricing ? jsx('span', { className: 'dshfee-inline-err', role: 'alert', children: recalc.errors.__pricing }) : null,
											jsxs('div', { className: 'dshfee-hint', children: [
												'提交时会带上**当前生效版本的完整价目表**（宿主不允许「继承上一版本」，继承会让价格无法解释），因此这一步要求配置已成功读取。',
												jsx('br', {}),
												'费用不物化：宿主按记录时刻现算，所以「挪生效时刻」本身就会让该时刻之后的记录改用新版本重算 —— 这正是本操作的效果，不需要额外开关。'
											] })
										] })
									]
								})
							] })
						}, 'pricing'));
					}
				}

				return jsx('div', {
					className: 'dshfee-mask',
					ref: maskRef,
					onMouseDown: onMaskDown,
					children: jsxs('div', {
						className: 'dshfee-panel',
						ref: panelRef,
						role: 'dialog',
						'aria-modal': 'true',
						'aria-label': '工作区费用面板',
						tabIndex: -1,
						children: [
							header,
							jsx('div', { className: 'dshfee-body', children: bodyChildren }),
							jsx('div', {
								className: 'dshfee-sub',
								style: { padding: '0 14px 12px' },
								children: (state.refreshedAt ? '数据时间：' + new Date(state.refreshedAt).toLocaleTimeString() + '　' : '')
									+ '宿主生成时间：' + (data && data.generatedAt ? new Date(data.generatedAt).toLocaleString() : '—')
									+ (state.status === 'refreshing' ? '　更新中…' : '')
							})
						]
					})
				});
			}

			/** Current pricing versions, read-only unless the operator opts into custom mode. */
			function loadVersions(configState, priceMode) {
				var cfg = configState.data;
				if (configState.status === 'loading' && !cfg) return jsx('div', { className: 'dshfee-hint', children: '正在读取价格版本…' });
				if (configState.status === 'error' && !cfg) {
					return jsx('div', { className: 'dshfee-hint', children: '价格版本读取失败，下面仍可追加新版本。' });
				}
				if (!cfg || !cfg.pricing || !Array.isArray(cfg.pricing.versions)) {
					return jsx('div', { className: 'dshfee-hint', children: priceMode === 'custom' ? '没有可编辑的价格版本模板。' : '未读取到价格版本。' });
				}
				var activeId = cfg.pricing.activeVersionId;
				return jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' }, children: cfg.pricing.versions.map(function (v) {
					var models = v.models && typeof v.models === 'object' ? v.models : {};
					var families = Object.keys(models);
					var when = typeof v.effectiveFrom === 'number' ? new Date(v.effectiveFrom).toLocaleString() : '—';
					// The Host's version id lives on `id`; accept `versionId` for tolerance.
					var versionId = typeof v.id === 'string' && v.id !== '' ? v.id : (typeof v.versionId === 'string' ? v.versionId : '(未命名版本)');
					return jsxs('div', {
						className: 'dshfee-version',
						'data-active': versionId === activeId ? '1' : '0',
						children: [
							jsxs('div', { className: 'dshfee-row', children: [
								jsx('span', { className: 'dshfee-chip', children: versionId }),
								jsx('span', { className: 'dshfee-muted', style: { fontSize: '11px' }, children: '生效 ' + when }),
								v.note ? jsx('span', { className: 'dshfee-muted', style: { fontSize: '11px', overflow: 'hidden', textOverflow: 'ellipsis' }, children: v.note }) : null,
								v.builtin ? jsx('span', { className: 'dshfee-chip', children: '内置' }) : null,
								versionId === activeId ? jsx('span', { className: 'dshfee-chip', children: '当前生效' }) : null
							] }),
							families.length === 0
								? jsx('div', { className: 'dshfee-hint', children: '该版本没有模型价格（可能是重算占位版本）。' })
								: jsx('table', { className: 'dshfee-table', children: [
									jsx('thead', { children: jsxs('tr', { children: [
										jsx('th', { children: '模型档' }),
										jsx('th', { children: '时段' }),
										jsx('th', { className: 'num', children: '命中' }),
										jsx('th', { className: 'num', children: '未命中' }),
										jsx('th', { className: 'num', children: '输出' })
									] }) }),
									jsx('tbody', { children: families.flatMap(function (family) {
										var segs = models[family] && Array.isArray(models[family].segments) ? models[family].segments : [];
										if (segs.length === 0) {
											return [jsxs('tr', { children: [
												jsx('td', { children: family }),
												jsx('td', { colSpan: 4, className: 'dshfee-muted', children: '无时段' })
											] }, family + '/none')];
										}
										return segs.map(function (s, i) {
											return jsxs('tr', {
												children: [
													jsx('td', { children: i === 0 ? family : '' }),
													jsx('td', { title: s.id || '', children: (s.label || s.id || '时段') + ' ' + (s.from || '') + '-' + (s.to || '') }),
													jsx('td', { className: 'num', children: String(s.hit) }),
													jsx('td', { className: 'num', children: String(s.miss) }),
													jsx('td', { className: 'num', children: String(s.out) })
												]
											}, family + '/' + (s.id || i));
										});
									}) })
								] })
						]
					}, versionId);
				}) });
			}

			/** Editable per-segment unit prices for the append-version form. */
			function renderSegmentEditor(appendAt, setAppendAt) {
				var prices = appendAt.prices;
				if (!prices || Object.keys(prices).length === 0) {
					return jsx('div', { className: 'dshfee-hint', children: '没有可编辑的时段模板（需要先成功读取配置）。' });
				}
				return jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '8px' }, children: Object.keys(prices).map(function (family) {
					var err = appendAt.errors[family];
					return jsxs('div', { className: 'dshfee-version', children: [
						jsx('b', { children: family }),
						prices[family].map(function (seg, idx) {
							var onNum = function (key) {
								return function (event) {
									var v = event.target.value;
									setAppendAt(function (prev) {
										var next = Object.assign({}, prev);
										var fam = next.prices[family].slice();
										fam[idx] = Object.assign({}, fam[idx]);
										fam[idx][key] = v;
										next.prices = Object.assign({}, next.prices);
										next.prices[family] = fam;
										var errs = Object.assign({}, next.errors);
										delete errs[family];
										next.errors = errs;
										return next;
									});
								};
							};
							return jsxs('div', { className: 'dshfee-field', children: [
								jsx('span', { className: 'dshfee-muted', style: { fontSize: '11px', minWidth: '96px' }, children: (seg.label || seg.id || '时段') + ' ' + (seg.from || '') + '-' + (seg.to || '') }),
								jsx('label', { className: 'dshfee-muted', style: { fontSize: '10.5px' }, children: '命中' }),
								jsx('input', {
									className: 'dshfee-input', type: 'text', inputMode: 'decimal', value: seg.hit,
									'aria-label': family + ' ' + (seg.label || seg.id) + ' 缓存命中单价',
									onChange: onNum('hit')
								}),
								jsx('label', { className: 'dshfee-muted', style: { fontSize: '10.5px' }, children: '未命中' }),
								jsx('input', {
									className: 'dshfee-input', type: 'text', inputMode: 'decimal', value: seg.miss,
									'aria-label': family + ' ' + (seg.label || seg.id) + ' 未命中单价',
									onChange: onNum('miss')
								}),
								jsx('label', { className: 'dshfee-muted', style: { fontSize: '10.5px' }, children: '输出' }),
								jsx('input', {
									className: 'dshfee-input', type: 'text', inputMode: 'decimal', value: seg.out,
									'aria-label': family + ' ' + (seg.label || seg.id) + ' 输出单价',
									onChange: onNum('out')
								})
							] }, family + '/' + idx);
						}),
						err ? jsx('span', { className: 'dshfee-inline-err', role: 'alert', children: err }) : null
					] }, family);
				}) });
			}

			function readPrefs() {
				try {
					var raw = window.localStorage.getItem(LS_KEY);
					if (!raw) return {};
					var parsed = JSON.parse(raw);
					return parsed && typeof parsed === 'object' ? parsed : {};
				} catch (e) {
					return {};
				}
			}

			function writePrefs(patch) {
				try {
					var next = Object.assign({}, readPrefs(), patch);
					window.localStorage.setItem(LS_KEY, JSON.stringify(next));
				} catch (e) { /* storage disabled: preferences are optional */ }
			}

			/* ------------------------------------------------------------------ *
			 * header capsule
			 * ------------------------------------------------------------------ */

			function FeePill(props) {
				var sessionId = typeof props.sessionId === 'string' ? props.sessionId : '';

				var openState = useState(false);
				var open = openState[0];
				var setOpen = openState[1];

				var refreshTokenState = useState(0);
				var refreshToken = refreshTokenState[0];
				var setRefreshToken = refreshTokenState[1];

				var stateStore = useState({ status: 'loading', data: null, error: null });
				var state = stateStore[0];
				var setState = stateStore[1];

				var daysStore = useState(function () {
					var p = readPrefs();
					return daysPref(p.days);
				});
				var days = daysStore[0];

				useEffect(function () {
					var ctrl = new AbortController();
					var alive = true;
					fetchSummary(sessionId, days, ctrl.signal).then(function (data) {
						if (alive) setState({ status: 'ready', data: data, error: null });
					}).catch(function (err) {
						if (!alive || (err && err.name === 'AbortError')) return;
						setState(function (prev) { return { status: 'error', data: prev.data, error: err }; });
					});
					return function () { alive = false; ctrl.abort(); };
				}, [sessionId, days, refreshToken]);

				// Keep the capsule's own read fresh without ever opening the panel.
				useEffect(function () {
					var timer = setInterval(function () {
						if (!pageVisible()) return; // hidden tab: do not poll the Host
						var ctrl = new AbortController();
						fetchSummary(sessionId, days, ctrl.signal).then(function (data) {
							setState({ status: 'ready', data: data, error: null });
						}).catch(function () { /* keep last good value */ });
					}, POLL_MS);
					return function () { clearInterval(timer); };
				}, [sessionId, days]);

				var current = state.data && state.data.current ? state.data.current : null;
				var label;
				var costText;
				var level = 'unknown';
				var title;

				if (current) {
					var currentLimit = limitOf({ alert: current.alert });
					label = current.label || basename(current.cwd) || current.workspaceId || '当前工作区';
					costText = fmtYuan(current.todayCost);
					level = displayLevel({ cost: current.todayCost, alert: current.alert });
					title = '工作区 ' + label
						+ '　今日 ' + fmtYuanExact(current.todayCost)
						+ '　预警线 ' + (currentLimit ? fmtYuanExact(currentLimit) : '未设置')
						+ '　状态 ' + levelText(level)
						+ '　（点击查看按工作区/按日费用）';
				} else if (state.status === 'error' && !state.data) {
					label = '费用';
					costText = '—';
					title = '读不到费用数据：' + (state.error && state.error.message ? state.error.message : '未知错误') + '　（点击查看详情）';
				} else if (state.status === 'loading' && !state.data) {
					label = '费用';
					costText = '…';
					title = '正在读取工作区费用…';
				} else {
					// Host reachable, but it could not resolve this Session's workspace.
					label = '今日';
					var totals = state.data && state.data.totals ? state.data.totals : null;
					costText = fmtYuan(totals ? totals.cost : state.data && state.data.current === null ? NaN : NaN);
					if (state.data && state.data.totals && typeof state.data.totals.cost === 'number') {
						title = '未能识别当前工作区，显示全部工作区合计 ' + fmtYuanExact(state.data.totals.cost) + '　（点击查看详情）';
					} else {
						title = '未能识别当前工作区　（点击查看详情）';
					}
				}

				var onClick = useCallback(function () {
					setRefreshToken(function (n) { return n + 1; });
					setOpen(true);
				}, []);

				var onClose = useCallback(function () {
					setOpen(false);
				}, []);

				return jsxs(Fragment, {
					children: [
						jsxs('button', {
							type: 'button',
							className: 'dshfee-pill',
							title: title,
							'aria-label': title,
							'aria-haspopup': 'dialog',
							'aria-expanded': open,
							onClick: onClick,
							children: [
								jsx(Dot, { level: level }),
								jsx('span', { className: 'dshfee-pill-name', children: label }),
								jsx('span', { className: 'dshfee-pill-cost', children: costText })
							]
						}),
						open ? jsx(Panel, { sessionId: sessionId, onClose: onClose, refreshToken: refreshToken }) : null
					]
				});
			}

			/* ------------------------------------------------------------------ *
			 * module surface
			 * ------------------------------------------------------------------ */

			function apply(ctx) {
				ensureStyle();
				var disposers = [];
				var disposer = ctx.slots.inject('conversation.session.header.utilities', function () {
					return ctx.slots.register({
						name: 'conversation.session.header.utilities',
						id: 'workspace-fee',
						order: 40
					}, function FeeHeaderEntry(props) {
						return createElement(FeePill, props || {});
					});
				});
				if (typeof disposer === 'function') disposers.push(disposer);

				// The shell may dispose the contribution instead of the plugin; cover both.
				ctx.effect(function () {
					return function () {
						for (var i = 0; i < disposers.length; i++) {
							try {
								disposers[i]();
							} catch (e) { /* already disposed */ }
						}
						disposers.length = 0;
					};
				}, 'dsh-workspace-fee: header capsule');
			}

			exports.name = NS;
			exports.inject = ['slots'];
			exports.apply = apply;
			return module.exports;
		}
	});
})();
