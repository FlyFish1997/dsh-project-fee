// 独立验证用：真实语料枚举 + 快照（活语料，必须固定快照才可复现）
import { readdirSync, statSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function dshHome() {
  return process.env.DSH_HOME || join(homedir(), ".dsh");
}

export function sessionsRoot() {
  return join(dshHome(), "sessions");
}

/** 会话日志文件名（DSH 会随格式版本换名：session.jsonl.zstd / session.v3 / session.v4 …）。 */
const SESSION_FILE_RE = /^session(?:\.v(\d+))?\.jsonl\.zstd$/;

/**
 * 一个会话目录里要读的日志文件：**取版本号最大的那一个**。
 * 同一目录可能同时存在 v3 与 v4，而 v4 是整篇重写 —— 两个都读会双计。
 */
function pickSessionFile(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const hits = [];
  for (const name of names) {
    const m = SESSION_FILE_RE.exec(name);
    if (m) hits.push({ name, version: m[1] === undefined ? 0 : Number(m[1]) });
  }
  if (hits.length === 0) return null;
  hits.sort((a, b) => b.version - a.version || (a.name < b.name ? 1 : -1));
  return join(dir, hits[0].name);
}

/** 枚举全部真实会话日志：{workspaceDir, sessionId, path, size, mtimeMs} */
export function listSessionFiles() {
  const root = sessionsRoot();
  const out = [];
  if (!existsSync(root)) return out;
  for (const ws of readdirSync(root)) {
    const wp = join(root, ws);
    let ids;
    try { ids = readdirSync(wp); } catch { continue; }
    for (const sid of ids) {
      const f = pickSessionFile(join(wp, sid));
      if (f === null) continue;
      try {
        const st = statSync(f);
        if (st.isFile()) out.push({ workspaceDir: ws, sessionId: sid, path: f, size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
  out.sort((a, b) => b.size - a.size);
  return out;
}

/** 快照指纹：固定「哪些文件、各多大」，让数字可复现（语料是活的）。 */
export function snapshotFingerprint(files) {
  const lines = files.map((f) => `${f.workspaceDir}/${f.sessionId}\t${f.size}\t${Math.round(f.mtimeMs)}`);
  const joined = lines.join("\n");
  let h = 2166136261 >>> 0;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return { count: files.length, totalBytes: files.reduce((a, f) => a + f.size, 0), fnv1a: h.toString(16).padStart(8, "0") };
}

/** 读取测试取值必须与文档一致 —— 统一从环境/文档取值，避免 localhost vs 127.0.0.1 漂移。 */
export function guiBaseUrl() {
  return process.env.DSH_VERIFY_BASE_URL || "http://127.0.0.1:3080";
}
