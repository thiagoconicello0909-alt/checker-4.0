import fs from "fs";
import path from "path";
import axios from "axios";
import { ROOT } from "./paths.js";
import { getNextProxy } from "./proxy.js";
import { buildHeaders } from "./trpc.js";

const CFG = path.join(ROOT, "captcha.json");
const LOG_ERROS = path.join(ROOT, "hits", "captcha_erros.txt");
const TLS_URL = "http://127.0.0.1:3334";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PADRAO = { provider: "disabled", apiKey: "", customApiUrl: "" };

const cacheSitekey = new Map();

export function loadCaptchaConfig() {
  try {
    return { ...PADRAO, ...JSON.parse(fs.readFileSync(CFG, "utf-8")) };
  } catch {
    return { ...PADRAO };
  }
}

export function saveCaptchaConfig(parcial) {
  const novo = { ...loadCaptchaConfig(), ...parcial };
  try { fs.writeFileSync(CFG, JSON.stringify(novo, null, 2), "utf-8"); } catch {}
  return novo;
}

function registrarErro(msg) {
  try {
    fs.mkdirSync(path.dirname(LOG_ERROS), { recursive: true });
    fs.appendFileSync(LOG_ERROS, `[${new Date().toISOString()}] ${msg}\n`, "utf-8");
  } catch {}
}

function extrairSitekey(html) {
  const padroes = [
    /data-sitekey=["']([^"']+)["']/i,
    /render=([A-Za-z0-9_-]{10,})/i,
    /sitekey["']?\s*[:=]\s*["']([^"']+)["']/i,
    /(0x4[A-Za-z0-9_-]{10,})/,
  ];
  for (const p of padroes) {
    const m = String(html).match(p);
    if (m && m[1]) return m[1];
  }
  return null;
}

/** Descobre a sitekey do Turnstile na página de login (com cache por domínio). */
export async function obterSitekey(casa) {
  if (cacheSitekey.has(casa.domain)) return cacheSitekey.get(casa.domain);

  const paginas = [casa.turnstilePage, "/login", "/", "/main", "/pt", "/main/login"].filter(Boolean);
  for (const pag of paginas) {
    const url = pag.startsWith("http") ? pag : `https://${casa.domain}${pag}`;
    try {
      const r = await axios.post(
        `${TLS_URL}/get`,
        { url, headers: { ...buildHeaders(casa, {}), accept: "text/html,application/xhtml+xml" }, body: "" },
        { timeout: 20000, validateStatus: () => true },
      );
      const html = String(r.data?.text ?? "");
      if (html.length < 200) continue;
      const key = extrairSitekey(html);
      if (key) {
        cacheSitekey.set(casa.domain, key);
        return key;
      }
    } catch (e) {
      registrarErro(`${casa.domain} | sitekey em ${url} | ${e.message}`);
    }
  }
  return null;
}

async function esperarResultado(url, corpo, chave = "solution", tentativas = 45) {
  for (let i = 0; i < tentativas; i++) {
    await sleep(2000);
    const r = await axios.post(url, corpo, { timeout: 30000 });
    const d = r.data || {};
    if (d.errorId && d.errorId !== 0) throw new Error(d.errorDescription || d.errorCode || "erro do provedor");
    if (d.status === "ready" || d.status === "ready_for_translation") return d[chave] || d;
  }
  throw new Error("timeout aguardando o provedor");
}

/* ---------------- Turnstile ---------------- */

async function turnstileCapSolver(cfg, domain, sitekey, proxy) {
  const criar = await axios.post("https://api.capsolver.com/createTask", {
    clientKey: cfg.apiKey,
    task: {
      type: "AntiTurnstileTaskProxyLess",
      websiteURL: `https://${domain}`,
      websiteKey: sitekey,
      ...(proxy ? { proxy } : {}),
    },
  }, { timeout: 30000 });
  if (criar.data?.errorId) throw new Error(criar.data.errorDescription || criar.data.errorCode);
  const taskId = criar.data?.taskId;
  if (!taskId) throw new Error("CapSolver não devolveu taskId");
  const sol = await esperarResultado("https://api.capsolver.com/getTaskResult", { clientKey: cfg.apiKey, taskId });
  return sol.token || null;
}

async function turnstileDoisCaptcha(cfg, domain, sitekey, proxy) {
  const form = new URLSearchParams({
    key: cfg.apiKey,
    method: "turnstile",
    sitekey,
    pageurl: `https://${domain}`,
    json: "1",
  });
  if (proxy) {
    form.set("proxy", proxy.replace(/^https?:\/\//, ""));
    form.set("proxytype", "HTTP");
  }
  const criar = await axios.post("https://2captcha.com/in.php", form.toString(), {
    headers: { "content-type": "application/x-www-form-urlencoded" },
    timeout: 30000,
  });
  const id = typeof criar.data === "object" ? criar.data?.request : null;
  if (!id) throw new Error(typeof criar.data === "string" ? criar.data : "2Captcha recusou a tarefa");
  const sol = await esperarResultado(
    "https://2captcha.com/res.php",
    new URLSearchParams({ key: cfg.apiKey, action: "get", id: String(id), json: "1" }).toString(),
  );
  return sol.token || sol.gRecaptchaResponse || null;
}

async function turnstileAntiCaptcha(cfg, domain, sitekey, proxy) {
  const criar = await axios.post("https://api.anti-captcha.com/createTask", {
    clientKey: cfg.apiKey,
    task: {
      type: "TurnstileTaskProxyless",
      websiteURL: `https://${domain}`,
      websiteKey: sitekey,
      ...(proxy ? { proxy } : {}),
    },
  }, { timeout: 30000 });
  if (criar.data?.errorId) throw new Error(criar.data.errorDescription || criar.data.errorCode);
  const sol = await esperarResultado(
    "https://api.anti-captcha.com/getTaskResult",
    { clientKey: cfg.apiKey, taskId: criar.data?.taskId },
  );
  return sol.token || null;
}

/** Resolve Turnstile e devolve o token cru (string) ou null. */
export async function solveTurnstile(domain, sitekey) {
  const cfg = loadCaptchaConfig();
  if (cfg.provider === "disabled" || cfg.provider === "custom") return null;
  if (!cfg.apiKey) {
    registrarErro(`${domain} | turnstile | provedor ${cfg.provider} sem apiKey`);
    return null;
  }

  const proxy = getNextProxy() || null;
  try {
    let tok = null;
    if (cfg.provider === "capsolver") tok = await turnstileCapSolver(cfg, domain, sitekey, proxy);
    else if (cfg.provider === "2captcha") tok = await turnstileDoisCaptcha(cfg, domain, sitekey, proxy);
    else if (cfg.provider === "anticaptcha") tok = await turnstileAntiCaptcha(cfg, domain, sitekey, proxy);
    else throw new Error(`provedor desconhecido: ${cfg.provider}`);
    if (!tok) {
      registrarErro(`${domain} | turnstile | resposta sem token`);
      return null;
    }
    return tok;
  } catch (e) {
    registrarErro(`${domain} | turnstile | ${cfg.provider} | ${e.message}`);
    return null;
  }
}

/* ---------------- Geetest (fallback) ---------------- */

function normalizarGee(bruto) {
  if (!bruto) return null;
  const s = typeof bruto === "string" ? { hToken: bruto } : (bruto.solution || bruto);
  const out = {
    hToken: s.hToken || s.htoken || null,
    geeToken: s.geeToken || s.gee_token || s.captcha || null,
    lotNumber: s.lotNumber || s.lot_number || null,
    captchaOutput: s.captchaOutput || s.captcha_output || null,
    passToken: s.passToken || s.pass_token || null,
    genTime: s.genTime || s.gen_time || null,
  };
  return Object.values(out).some((v) => v !== null) ? out : null;
}

async function geeCapSolver(cfg, domain, captchaId, proxy) {
  const criar = await axios.post("https://api.capsolver.com/createTask", {
    clientKey: cfg.apiKey,
    task: { type: "Gt4", websiteURL: `https://${domain}`, captchaId, ...(proxy ? { proxy } : {}) },
  }, { timeout: 30000 });
  if (criar.data?.errorId) throw new Error(criar.data.errorDescription || criar.data.errorCode);
  return esperarResultado("https://api.capsolver.com/getTaskResult", { clientKey: cfg.apiKey, taskId: criar.data?.taskId });
}

async function geeDoisCaptcha(cfg, domain, captchaId, proxy) {
  const form = new URLSearchParams({
    key: cfg.apiKey, method: "geetest", version: "4", gt: captchaId, challenge: captchaId,
    pageurl: `https://${domain}`, json: "1",
  });
  if (proxy) {
    form.set("proxy", proxy.replace(/^https?:\/\//, ""));
    form.set("proxytype", "HTTP");
  }
  const criar = await axios.post("https://2captcha.com/in.php", form.toString(), {
    headers: { "content-type": "application/x-www-form-urlencoded" }, timeout: 30000,
  });
  const id = typeof criar.data === "object" ? criar.data?.request : null;
  if (!id) throw new Error("2Captcha recusou a tarefa");
  const sol = await esperarResultado(
    "https://2captcha.com/res.php",
    new URLSearchParams({ key: cfg.apiKey, action: "get", id: String(id), json: "1" }).toString(),
  );
  return {
    hToken: sol.hToken || sol.htoken, geeToken: sol.geeToken || sol.captcha,
    lotNumber: sol.lot_number, captchaOutput: sol.captcha_output, passToken: sol.pass_token, genTime: sol.gen_time,
  };
}

async function geeAntiCaptcha(cfg, domain, captchaId, proxy) {
  const criar = await axios.post("https://api.anti-captcha.com/createTask", {
    clientKey: cfg.apiKey,
    task: {
      type: "GeeTestTaskProxyless", websiteURL: `https://${domain}`,
      gt: captchaId, challenge: captchaId, version: 4, ...(proxy ? { proxy } : {}),
    },
  }, { timeout: 30000 });
  if (criar.data?.errorId) throw new Error(criar.data.errorDescription || criar.data.errorCode);
  return esperarResultado("https://api.anti-captcha.com/getTaskResult", { clientKey: cfg.apiKey, taskId: criar.data?.taskId });
}

/** Resolve Geetest v4 e devolve os campos do objeto ou null. */
export async function solveCaptcha(domain, tenantId, username, captchaId) {
  const cfg = loadCaptchaConfig();
  if (cfg.provider === "disabled") return null;
  if (cfg.provider === "custom") return null;
  if (!cfg.apiKey) return null;

  const proxy = getNextProxy() || null;
  try {
    let bruto = null;
    if (cfg.provider === "capsolver") bruto = await geeCapSolver(cfg, domain, captchaId, proxy);
    else if (cfg.provider === "2captcha") bruto = await geeDoisCaptcha(cfg, domain, captchaId, proxy);
    else if (cfg.provider === "anticaptcha") bruto = await geeAntiCaptcha(cfg, domain, captchaId, proxy);
    else throw new Error(`provedor desconhecido: ${cfg.provider}`);
    const sol = normalizarGee(bruto);
    if (!sol) registrarErro(`${domain} | geetest | resposta sem tokens`);
    return sol;
  } catch (e) {
    registrarErro(`${domain} | geetest | ${cfg.provider} | ${e.message}`);
    return null;
  }
}