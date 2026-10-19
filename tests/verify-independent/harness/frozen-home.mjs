// 独立验证用：冻结语料快照
//
// 为什么需要：真实 sessions 目录是「活」的（其他会话在持续追加），
// 直接对比「CLI 跑一次 vs 我跑一次」会因期间新增记录而漂移。
// 做法：把当前真实会话日志复制到一个临时 DSH_HOME，之后 CLI 与我的独立解码
// 都指向同一份快照 → 两侧看到完全相同的字节，可比性成立。
import { mkdirSync, readdirSync, copyFileSync, existsSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { sessionsRoot, listSessionFiles, snapshotFingerprint } from "./corpus.mjs";
import { HERE } from "./runner.mjs";

/** 快照目录基址：默认 `tests/verify-independent/.tmp-home`；可用 `DSH_TEST_TMP` 覆盖。
 *  受限沙箱实测：会话开始时就存在的子目录对受限子进程只读，新建目录可写，
 *  因此沙箱内跑独立验证要指到新建目录（见 README.md「测试与受限环境」）。 */
export const TMP_ROOT = process.env.DSH_TEST_TMP
  ? join(resolve(process.env.DSH_TEST_TMP), "verify-independent")
  : join(HERE, "..", ".tmp-home");

/** 冻结一份会话快照到 <dir>/sessions，返回 {home, sessionsRoot, fingerprint}。 */
export function freezeHome(name = "frozen", { clean = true } = {}) {
  const home = join(TMP_ROOT, name);
  const dest = join(home, "sessions");
  if (clean && existsSync(home)) rmSync(home, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });

  const src = sessionsRoot();
  const copied = [];
  // 每个会话目录只复制**版本号最大的那个日志文件**（枚举口径同真语料：v4 是整篇重写，
  // v3/v4 都复制会让快照里出现重复记录），文件名原样保留。
  for (const row of listSessionFiles()) {
    if (!String(row.path).startsWith(src)) continue;
    const outDir = join(dest, row.workspaceDir, row.sessionId);
    mkdirSync(outDir, { recursive: true });
    copyFileSync(row.path, join(outDir, basename(row.path)));
    copied.push({ workspaceDir: row.workspaceDir, sessionId: row.sessionId });
  }
  return { home, sessionsRoot: dest, copied };
}

/** 用固定文件清单算快照指纹（与 corpus 的算法一致）。 */
export function fingerprintOfDir(dir) {
  const out = [];
  for (const ws of readdirSync(dir)) {
    const wp = join(dir, ws);
    for (const sid of readdirSync(wp)) {
      const sub = join(wp, sid);
      // 与 corpus.listSessionFiles 同口径：取版本号最大的文件
      let names = [];
      try {
        names = readdirSync(sub);
      } catch {
        continue;
      }
      const hits = names.filter((n) => /^session(?:\.v(\d+))?\.jsonl\.zstd$/.test(n));
      if (hits.length === 0) continue;
      hits.sort((a, b) => {
        const va = /\.v(\d+)\./.exec(a);
        const vb = /\.v(\d+)\./.exec(b);
        return (vb ? Number(vb[1]) : 0) - (va ? Number(va[1]) : 0) || (a < b ? 1 : -1);
      });
      const f = join(sub, hits[0]);
      try {
        const st = statSync(f);
        out.push({ workspaceDir: ws, sessionId: sid, path: f, size: st.size, mtimeMs: st.mtimeMs });
      } catch {}
    }
  }
  out.sort((a, b) => b.size - a.size);
  return { files: out, fingerprint: snapshotFingerprint(out) };
}

/** 往快照里放一个「合成工作区」：sessions/<编码目录>/<会话id>/<fileName> */
export function putSyntheticSession(home, workspaceDirName, sessionId, zstdBuffer, fileName = "session.v4.jsonl.zstd") {
  const outDir = join(home, "sessions", workspaceDirName, sessionId);
  mkdirSync(outDir, { recursive: true });
  const p = join(outDir, fileName);
  writeFileSync(p, zstdBuffer);
  return p;
}
