// 独立验证用：直接调用真实路由处理器（mock req/res）
//
// 为什么走这条路：GUI 需要登录，直接打 127.0.0.1:3080 会 401（预期行为）。
// 本替代路径能核对「字段名/类型/状态码」，但【证明不了】CORS/Cookie/浏览器策略
// —— 这一点必须在 VERIFY.md 里明确标注。
import { EventEmitter } from "node:events";

/** 构造一个够用的 mock req。 */
export function makeReq({ method = "GET", url = "/", headers = {}, body = null } = {}) {
  const req = new EventEmitter();
  req.method = method;
  req.url = url;
  req.headers = { ...headers };
  if (body !== null && body !== undefined) {
    const buf = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    if (req.headers["content-type"] === undefined) req.headers["content-type"] = "application/json";
    req.headers["content-length"] = String(buf.length);
    process.nextTick(() => {
      req.emit("data", buf);
      req.emit("end");
    });
  } else {
    process.nextTick(() => req.emit("end"));
  }
  return req;
}

/** 构造一个够用的 mock res，结束后可读取 {status, headers, body, json}。 */
export function makeRes() {
  const res = new EventEmitter();
  res.statusCode = 200;
  res.headersSent = false;
  res.headers = {};
  res.chunks = [];
  res.setHeader = (k, v) => {
    res.headers[String(k).toLowerCase()] = v;
  };
  res.getHeader = (k) => res.headers[String(k).toLowerCase()];
  res.end = (chunk) => {
    if (chunk !== undefined && chunk !== null) res.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), "utf8"));
    res.headersSent = true;
    const text = Buffer.concat(res.chunks).toString("utf8");
    res.text = text;
    try {
      res.json = text === "" ? null : JSON.parse(text);
    } catch {
      res.json = undefined;
    }
    res.finished = true;
  };
  res.destroy = () => {
    res.finished = true;
  };
  return res;
}

/**
 * 调用真实路由表里的处理器。
 * @returns {Promise<{matched:boolean, status:number, headers:object, text:string, json:any}>}
 */
export async function callRoute(table, method, url, body = null, headers = {}) {
  const pathOnly = url.split("?")[0];
  const route = table.find((r) => r.path === pathOnly);
  if (!route) return { matched: false, status: 0, headers: {}, text: "", json: undefined };
  const req = makeReq({ method, url, headers, body });
  const res = makeRes();
  await route.handler(req, res);
  // 处理器内部是 async，等一轮微任务确保 res.end 已发生
  if (!res.finished) await new Promise((r) => setTimeout(r, 50));
  return { matched: true, status: res.statusCode, headers: res.headers, text: res.text, json: res.json };
}
