import crypto from "crypto";
import axios from "axios";
import { getNextProxy } from "./proxy.js";
import { c } from "./ui.js";

const TLS_URL = "http://127.0.0.1:3334";

let minInterval = 0;
let nextSlot = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function setRateLimit(ms) {
  minInterval = Math.max(0, Number(ms) || 0);
}

async function gate() {
  if (!minInterval) return;
  const now = Date.now();
  const slot = Math.max(now, nextSlot);
  nextSlot = slot + minInterval * (0.75 + Math.random() * 0.5);
  const wait = slot - now;
  if (wait > 0) await sleep(wait);
}

function randomTrace(len = 8) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

/** Define header removendo duplicata com caixa diferente. */
function setH(headers, nome, valor) {
  const alvo = nome.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === alvo) delete headers[k];
  if (valor !== undefined && valor !== null && valor !== "") headers[nome] = String(valor);
}

export function buildHeaders(casa, auth = {}) {
  const a = typeof auth === "string" ? { token: auth } : (auth || {});
  const headers = { ...(casa.headers || {}) };

  headers.origin = `https://${casa.domain}`;
  headers.referer = `https://${casa.domain}/`;

  // headers fixos do app
  setH(headers, "tenantId", casa.tenantId);
  setH(headers, "channelId", casa.channelId ?? 0);
  setH(headers, "X-Device-Id", casa.deviceId);
  setH(headers, "X-Device-Type", casa.deviceType || "DesktopOS");
  setH(headers, "X-Client-Version", casa.clientVersion || "v242");
  setH(headers, "X-Trace-ID", randomTrace());
  setH(headers, "Client-Language", casa.language || "pt-BR");
  setH(headers, "content-type", "application/json");
  if (casa.flag) setH(headers, "X-Flag", casa.flag);
 if (!casa.fingerprint) {
    casa.fingerprint = crypto.randomUUID();
    casa.fingerprintRequest = crypto.randomUUID();
  }
  setH(headers, "X-Fingerprint-Id", casa.fingerprint);
  setH(headers, "X-Fingerprint-Request-Id", casa.fingerprintRequest);

  // credenciais: token no Authorization, authTag em X-Auth-Tag (é o que o guard lê)
// Authorization = token do auth.login (nunca o authTag)
  if (a.token) {
    const scheme = casa.authScheme;
    setH(headers, "Authorization", scheme === "" ? a.token : `${scheme || "Bearer"} ${a.token}`);
  } else {
    setH(headers, "Authorization", undefined);
  }
  setH(headers, "X-Auth-Tag", a.authTag);
  setH(headers, "x-token-data", a.tokenData);
  setH(headers, "X-Tag", a.tag);
  setH(headers, "userId", a.userId);
  setH(headers, "X-Request-Source", "web_client");
  
  for (const k of Object.keys(headers)) if (k.toLowerCase() === "content-length") delete headers[k];
  return headers;
}

export function credVariants(auth) {
  const a = typeof auth === "string" ? { token: auth } : (auth || {});
  const lista = [a.authTag, a.tokenData, a.token].filter((x) => typeof x === "string" && x.length > 8);
  const unicos = [...new Set(lista)];
  return unicos.length ? unicos : [null];
}

export function withAuth(auth, cred) {
  const a = typeof auth === "string" ? { token: auth } : { ...(auth || {}) };
  if (!cred) return a;
  return { ...a, authTag: cred, tokenData: a.tokenData || cred };
}

export function extractAuth(norm) {
  const d = norm?.data || {};
  return {
    tag: typeof d.tag === "string" ? d.tag : null,
    authTag: typeof d.authTag === "string" ? d.authTag : null,
    tokenData: typeof d.tokenData === "string" ? d.tokenData : null,
    userId: d.userId ?? null,
  };
}

export function withRouter(casa, procedure) {
  const prefix = casa.loginPath.replace(/[^/]+$/, "");
  return prefix + procedure;
}

export function infoPath(casa) {
  return casa.infoPath || withRouter(casa, "vip.info");
}

export function buildQuery(path, input) {
  const q = encodeURIComponent(JSON.stringify(input ?? { json: {} }));
  return `${path}${path.includes("?") ? "&" : "?"}input=${q}`;
}

const RATE = /muitas solicita|too many|rate limit|429|aguarde um momento/i;
const RETRYABLE = /timeout|ECONNRESET|socket|502|503|504|offline|proxy/i;

async function request(casa, metodo, path, payload, auth) {
  const isGet = metodo === "GET";
  const url = isGet
    ? `https://${casa.apiHost}${buildQuery(path, payload)}`
    : `https://${casa.apiHost}${path}`;

  let ultimoErro = "";
  for (let tentativa = 1; tentativa <= 4; tentativa++) {
    await gate();
    const proxy = getNextProxy();
    let res;
    try {
      res = await axios.post(`${TLS_URL}/${isGet ? "get" : "post"}`, {
        url,
        headers: buildHeaders(casa, auth),
        body: isGet ? "" : JSON.stringify(payload ?? { json: {} }),
        ...(proxy ? { proxy } : {}),
      }, { timeout: 30000, validateStatus: () => true });
    } catch (e) {
      ultimoErro = `TLSProxy offline: ${e.message}`;
      if (tentativa < 4) { await sleep(800 * tentativa + Math.random() * 500); continue; }
      throw new Error(ultimoErro);
    }

    if (res.data?.error) {
      ultimoErro = `TLSProxy: ${res.data.error}`;
      if (tentativa < 4 && RETRYABLE.test(ultimoErro)) { await sleep(800 * tentativa + Math.random() * 500); continue; }
      throw new Error(ultimoErro);
    }
    if (res.status !== 200) {
      ultimoErro = `TLSProxy status ${res.status}`;
      if (tentativa < 4 && RETRYABLE.test(ultimoErro)) { await sleep(900 * tentativa + Math.random() * 600); continue; }
      throw new Error(ultimoErro);
    }

    const text = res.data?.text ?? "";
    const cabeca = text.slice(0, 500);
    if (tentativa < 4 && RATE.test(cabeca)) {
      await sleep(3500 * tentativa + Math.random() * 1500);
      continue;
    }
    if (tentativa < 4 && RETRYABLE.test(cabeca)) {
      await sleep(900 * tentativa + Math.random() * 600);
      continue;
    }
    return text;
  }
  throw new Error(ultimoErro || "falha na requisição");
}

export const post = (casa, path, body, auth) => request(casa, "POST", path, body, auth);
export const get = (casa, path, input, auth) => request(casa, "GET", path, input, auth);

export function normalize(raw) {
  let obj = raw;
  if (typeof obj === "string") {
    try {
      obj = JSON.parse(obj);
    } catch {
      return { ok: false, code: "parse", msg: String(obj).slice(0, 160) };
    }
  }
  if (!obj || typeof obj !== "object") return { ok: false, code: "empty", msg: "resposta vazia" };

  const err = obj.error?.json || obj.error;
  if (err) {
    return {
      ok: false,
      code: err.data?.code ?? err.code ?? null,
      msg: err.message || err.data?.message || "erro",
      data: null,
    };
  }

  const payload = obj.result?.data?.json ?? obj.result?.data ?? obj.data?.json ?? obj.data ?? obj;
  const code = payload?.code ?? payload?.errorCode ?? 0;
  const msg = String(payload?.msg || payload?.message || "");
  const okFlag = obj.result !== undefined || code === 0 || code === "0" || code === 200 || code === "200";

  return { ok: okFlag, code, msg, data: payload };
}

export function deepFind(root, keys, maxDepth = 8) {
  const queue = [[root, 0]];
  const wanted = keys.map((k) => k.toLowerCase());
  while (queue.length) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== "object" || depth > maxDepth) continue;
    for (const [k, v] of Object.entries(node)) {
      if (v === null || v === "" || typeof v === "object") continue;
      if (wanted.includes(k.toLowerCase())) return v;
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") queue.push([v, depth + 1]);
  }
  return null;
}

const LABEL_KEYS = /^(name|title|label|channelname|bankname|bank_name|methodname|withdrawname|payname|pay_name|typename|type_name|desc|description|remark|account_name)$/;

export function collectLabels(root, max = 30) {
  const out = new Set();
  const queue = [[root, 0]];
  while (queue.length && out.size < max) {
    const [node, depth] = queue.shift();
    if (!node || typeof node !== "object" || depth > 9) continue;
    for (const [k, v] of Object.entries(node)) {
      if (typeof v === "string" && LABEL_KEYS.test(k.toLowerCase())) {
        const val = v.trim();
        if (val && val.length <= 40 && !/^\d+$/.test(val)) out.add(val);
      } else if (typeof v === "number" && /^(type|channeltype|channel_type|withdrawtype)$/i.test(k)) {
        out.add(`tipo=${v}`);
      }
    }
    for (const v of Object.values(node)) if (v && typeof v === "object") queue.push([v, depth + 1]);
  }
  return [...out];
}

export function hasData(payload) {
  if (payload === null || payload === undefined) return false;
  if (Array.isArray(payload)) return payload.length > 0;
  if (typeof payload === "object") {
    const keys = Object.keys(payload).filter((k) => !["code", "msg", "message", "success"].includes(k));
    return keys.length > 0;
  }
  return true;
}

/** Procedures reais da página de perfil (VIP + saldo). */
export const PERFIL_PROCS = [
  "user.details",
  "user.assets",
  "vip.info",
  "user.info",
  "vip.vip",
  "member.perfil",
];

export const PROBE_PATHS = ["vip.info", "user.assets", "user.details"];

export async function probe(casa, auth) {
  const found = [];
  for (const proc of PROBE_PATHS) {
    const path = withRouter(casa, proc);
    for (const metodo of ["GET", "POST"]) {
      const payload = { json: {} };
      try {
        const raw = metodo === "GET"
          ? await get(casa, path, payload, auth)
          : await post(casa, path, payload, auth);
        const norm = normalize(raw);
        if (norm.ok && hasData(norm.data)) {
          found.push({ path, body: payload, metodo, sample: norm.data });
          break;
        }
      } catch {}
    }
    if (found.length >= 3) break;
  }
  return found;
}

export async function probePerfil(casa, auth) {
  const lista = [...new Set([...(casa.perfilProcs || []), ...PERFIL_PROCS])];
  for (const proc of lista) {
    const path = withRouter(casa, proc);
    for (const metodo of ["GET", "POST"]) {
      try {
        const raw = metodo === "GET"
          ? await get(casa, path, { json: {} }, auth)
          : await post(casa, path, { json: {} }, auth);
        const norm = normalize(raw);
        if (norm.ok && hasData(norm.data)) return { path, body: { json: {} }, metodo, sample: norm.data };
      } catch {}
    }
  }
  return null;
}

export function probeLog(line) {
  process.stdout.write(`  ${c.DIM}${line}${c.RESET}\n`);
}