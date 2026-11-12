import { buildHeaders } from "./headers.js";
import { tlsPost } from "./tls.js";

/**
 * Verificação profunda — lista de bônus pendentes.
 * Rota de referência: /discount (aba canReceive, filtro "Pendente")
 * Endpoint padrão: POST /api/active/receivedAwardList
 *
 * status: 0 = pendente | timeDay: 60 = últimos 60 dias
 * Retorno: { ok, hit, total, somaTotal, itens[], erro }
 */

const MAX_ITENS = 10;

const CAMPOS = [
  "id", "activeId", "ruleId", "template", "activeType", "activeTypeText",
  "activeName", "bonusEnum", "bonusText", "reward", "status",
  "logCreateTime", "periodTime", "receiveTimeRemark", "canReceiveTime", "canGo",
];

const soNumero = (v) => {
  const n = Number(String(v ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

function enxugar(item) {
  const o = {};
  for (const k of CAMPOS) if (item?.[k] !== undefined && item?.[k] !== null) o[k] = item[k];
  return o;
}

function extrairLista(payload) {
  const d = payload?.data ?? payload ?? {};
  const lista = d.list || d.records || d.rows || d.pendingRewardList || [];
  const total = soNumero(d.total ?? d.count ?? lista.length);
  const soma = lista.reduce((acc, it) => acc + soNumero(it?.reward), 0);
  const somaTotal = soNumero(d.totalReward ?? d.totalAmount ?? d.sumReward ?? soma);
  return { lista: Array.isArray(lista) ? lista : [], total, soma, somaTotal };
}

export async function verificarBonus({ casa, token, deviceId, traceId }) {
  const cfg = casa.deepCheck || {};
  const endpoint = cfg.endpoint;
  const res = { ok: false, hit: false, total: 0, somaTotal: 0, itens: [], erro: null };

  if (!endpoint) {
    res.erro = "sem endpoint";
    return res;
  }
  if (!token) {
    res.erro = "sem token de sessão";
    return res;
  }

  const body = { ...(cfg.body || {}) };
  body.page = Number(body.page) || 1;
  body.pageSize = Math.min(Number(body.pageSize) || MAX_ITENS, MAX_ITENS);

  const host = casa.apiHost || casa.domain;
  const lang = casa.lang || "pt";
  const qs = new URLSearchParams({
    siteCode: String(casa.siteCode || ""),
    token: String(token),
    language: lang,
  });

  const headers = {
    ...buildHeaders(casa.domain, casa.siteCode || ""),
    ...(casa.headers || {}),
    token: String(token),
    language: lang,
    "accept-language": lang === "en" ? "en-US,en;q=0.9" : "pt-BR,pt;q=0.9",
  };
  if (deviceId) headers["x-device-id"] = deviceId;
  if (traceId) headers["x-trace-id"] = traceId;

  const raw = JSON.stringify(body);
  headers["content-length"] = Buffer.byteLength(raw).toString();

  try {
    const text = await tlsPost(`https://${host}${endpoint}?${qs.toString()}`, headers, raw);
    const payload = JSON.parse(text || "{}");

    if (Number(payload?.code) !== 1) {
      res.erro = payload?.msg || `code ${payload?.code}`;
      return res;
    }

    const { lista, total, soma, somaTotal } = extrairLista(payload);
    res.ok = true;
    res.total = total;
    res.somaTotal = somaTotal || soma;
    res.itens = lista.slice(0, MAX_ITENS).map(enxugar);
    res.hit = lista.length > 0;
  } catch (e) {
    res.erro = e?.response?.status ? `HTTP ${e.response.status}` : (e?.message || "erro");
  }

  return res;
}

export default verificarBonus;