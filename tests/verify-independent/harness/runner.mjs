// 独立验证用：子进程执行器
// 本地禁止捕获子进程 stdio（stdio:'pipe' 会 EPERM）→ 一律「重定向到文件再读」。
import { spawnSync } from "node:child_process";
import { openSync, closeSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const HERE = dirname(fileURLToPath(import.meta.url));
// HERE = <root>/tests/verify-independent/harness  → 上三级才是项目根
export const ROOT = join(HERE, "..", "..", "..");
// 日志留档目录：默认 `tests/verify-independent/.logs`；沙箱内跑（受限子进程写不了
// 已存在的子目录）时用 `DSH_TEST_TMP` 指到新建目录，见 README.md「测试与受限环境」。
export const LOG_DIR = process.env.DSH_TEST_TMP
  ? join(resolve(process.env.DSH_TEST_TMP), "verify-independent-logs")
  : join(HERE, "..", ".logs");

/**
 * 跑一个 node 调用，输出重定向到日志文件，判据 = 子进程退出码。
 * @returns {{name:string, exitCode:number|null, signal:string|null, ms:number, logPath:string, text:string, tail:string}}
 */
export function runNode(name, argv, opts = {}) {
  mkdirSync(LOG_DIR, { recursive: true });
  const logPath = join(LOG_DIR, `${name}.log`);
  // 纪律：测试前先轮转/清空日志
  writeFileSync(logPath, "");
  const fd = openSync(logPath, "a");
  const t0 = Date.now();
  let res;
  try {
    res = spawnSync(process.execPath, argv, {
      cwd: opts.cwd ?? ROOT,
      stdio: ["ignore", fd, fd],
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
    });
  } finally {
    closeSync(fd);
  }
  const ms = Date.now() - t0;
  const text = readFileSync(logPath, "utf8");
  const lines = text.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - 25)).join("\n");
  return { name, argv, exitCode: res.status, signal: res.signal, ms, logPath, text, tail };
}

/** 跑一个脚本（等价 runNode(name, [relPath, ...args])）。 */
export function runScript(name, relPath, args = [], opts = {}) {
  return runNode(name, [relPath, ...args], opts);
}
