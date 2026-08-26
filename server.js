const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const webpush = require('web-push');

// Evita que erros inesperados derrubem o processo
process.on('uncaughtException',  err  => console.error('[ERRO]', err));
process.on('unhandledRejection', reason => console.error('[PROMISE]', reason));

const SERVER_STARTED_AT = Date.now();

const app = express();
app.set('trust proxy', true);
app.use(express.json());

app.use(express.static(path.join(__dirname, 'public')));

const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);

// ── Config ────────────────────────────────────────────────────────────────────
// Salvo em logs/config.json — mesma pasta do volume persistente do EasyPanel

const CONFIG_FILE = path.join(LOGS_DIR, 'config.json');

let config = {
  cookie: '', alertMinutes: 15,
  adminPassword: '',   // senha do ADM MASTER (John) — protege Configurações e libera os dados
  allowedIps: [],       // IPs liberados a ver os dados sem precisar logar como ADM
  pollIntervalMs: 10000, // de quanto em quanto tempo consulta o Foody
};

function loadConfig() {
  if (process.env.FOODY_COOKIE) config.cookie = process.env.FOODY_COOKIE;
  if (process.env.ADMIN_PASSWORD) config.adminPassword = process.env.ADMIN_PASSWORD;
  // Tenta localização antiga (./config.json) para migrar cookie existente
  for (const f of ['./config.json', CONFIG_FILE]) {
    try {
      const saved = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (saved.cookie) config.cookie = saved.cookie;
      if (saved.alertMinutes) config.alertMinutes = saved.alertMinutes;
      if (saved.vapidKeys) config.vapidKeys = saved.vapidKeys;
      if (saved.adminPassword) config.adminPassword = saved.adminPassword;
      if (Array.isArray(saved.allowedIps)) config.allowedIps = saved.allowedIps;
      if (saved.pollIntervalMs) config.pollIntervalMs = saved.pollIntervalMs;
    } catch (e) {}
  }
}

function ensureVapidKeys() {
  if (!config.vapidKeys) {
    config.vapidKeys = webpush.generateVAPIDKeys();
    saveConfig();
    console.log('[INFO] Chaves VAPID geradas.');
  }
  webpush.setVapidDetails(
    'mailto:varandaspizzaria.mcz@gmail.com',
    config.vapidKeys.publicKey,
    config.vapidKeys.privateKey
  );
}

function saveConfig() {
  try { fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2)); } catch (e) {}
}

loadConfig();
ensureVapidKeys();

// ── Push subscriptions ────────────────────────────────────────────────────────

const SUBS_FILE = path.join(LOGS_DIR, 'push-subscriptions.json');
let pushSubscriptions = [];

function loadSubscriptions() {
  try { pushSubscriptions = JSON.parse(fs.readFileSync(SUBS_FILE, 'utf8')); } catch (e) {}
}

function saveSubscriptions() {
  try { fs.writeFileSync(SUBS_FILE, JSON.stringify(pushSubscriptions, null, 2)); } catch (e) {}
}

async function sendPush(payload) {
  if (!pushSubscriptions.length) return;
  const dead = new Set();
  await Promise.all(pushSubscriptions.map((sub, i) =>
    webpush.sendNotification(sub, JSON.stringify(payload)).catch(() => dead.add(i))
  ));
  if (dead.size) {
    pushSubscriptions = pushSubscriptions.filter((_, i) => !dead.has(i));
    saveSubscriptions();
  }
}

loadSubscriptions();

// ── Registro de visitantes (IP, dispositivo, SO, navegador) ──────────────────

const VISITS_FILE = path.join(LOGS_DIR, 'visits.json');
let visits = [];

function loadVisits() {
  try { visits = JSON.parse(fs.readFileSync(VISITS_FILE, 'utf8')); } catch (e) {}
}
function saveVisits() {
  try { fs.writeFileSync(VISITS_FILE, JSON.stringify(visits, null, 2)); } catch (e) {}
}
loadVisits();

function parseUserAgent(ua) {
  ua = ua || '';
  let os = 'Desconhecido';
  if (/windows nt 10/i.test(ua))            os = 'Windows 10/11';
  else if (/windows nt 6\.3/i.test(ua))     os = 'Windows 8.1';
  else if (/windows nt 6\.1/i.test(ua))     os = 'Windows 7';
  else if (/windows/i.test(ua))             os = 'Windows';
  else if (/android\s([\d.]+)/i.test(ua))   os = `Android ${RegExp.$1}`;
  else if (/iphone os ([\d_]+)/i.test(ua))  os = `iOS ${RegExp.$1.replace(/_/g, '.')}`;
  else if (/ipad.*os ([\d_]+)/i.test(ua))   os = `iPadOS ${RegExp.$1.replace(/_/g, '.')}`;
  else if (/mac os x ([\d_]+)/i.test(ua))   os = `macOS ${RegExp.$1.replace(/_/g, '.')}`;
  else if (/linux/i.test(ua))               os = 'Linux';

  let browser = 'Desconhecido';
  if (/edg\//i.test(ua))                              browser = 'Edge';
  else if (/opr\//i.test(ua))                         browser = 'Opera';
  else if (/chrome\//i.test(ua) && !/edg\/|opr\//i.test(ua)) browser = 'Chrome';
  else if (/firefox\//i.test(ua))                     browser = 'Firefox';
  else if (/safari\//i.test(ua) && !/chrome\//i.test(ua))    browser = 'Safari';

  const isTablet = /ipad|tablet/i.test(ua);
  const isMobile = !isTablet && /mobi|android|iphone|ipod/i.test(ua);

  // Modelo só costuma aparecer em Android (ex: "; SM-G991B Build/"). iOS não expõe modelo por privacidade.
  let model = null;
  const m = ua.match(/;\s*([A-Za-z0-9\- ]+)\sBuild\//);
  if (m) model = m[1].trim();

  return {
    os, browser, model,
    deviceType: isTablet ? 'tablet' : isMobile ? 'celular' : 'computador',
  };
}

// ── Logs ──────────────────────────────────────────────────────────────────────

function operationalDate() {
  const now = new Date();
  // Turno encerra às 05:00 BRT = 08:00 UTC. Usa UTC puro para evitar bug de fuso.
  if (now.getUTCHours() < 8) now.setUTCDate(now.getUTCDate() - 1);
  return now.toISOString().slice(0, 10);
}

// Timestamp (ms) de quando o turno atual começou (05:00 BRT / 08:00 UTC).
// Usado pra ignorar entregas de turnos passados ao calcular "desde quando descansando".
function operationalDayStartMs() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 8, 0, 0, 0));
  if (now.getUTCHours() < 8) start.setUTCDate(start.getUTCDate() - 1);
  return start.getTime();
}

// Madrugada = entre 00:00 e 05:00 BRT (03:00–08:00 UTC), quando a loja já fechou
// mas o turno operacional ainda não virou. É a janela em que faz sentido detectar
// "acabaram as entregas" — durante o dia um lull momentâneo não deve contar.
function isLateNightBRT() {
  const h = new Date().getUTCHours();
  return h >= 3 && h < 8;
}

function appendLog(entry) {
  const date = operationalDate();
  const file = path.join(LOGS_DIR, `${date}.json`);
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  logs.push({ timestamp: new Date().toISOString(), ...entry });
  try { fs.writeFileSync(file, JSON.stringify(logs, null, 2)); } catch (e) {}
}

// ── Foody API ─────────────────────────────────────────────────────────────────

function foodyHeaders() {
  return {
    'accept': '*/*',
    'accept-language': 'pt-BR,pt;q=0.9',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'referer': 'https://app.foodydelivery.com/u/0/home',
    'x-requested-with': 'XMLHttpRequest',
    'authuser': '0', // obrigatório pra API v2 (chat/conversas) — sem ele dá 400
    'cookie': config.cookie,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  };
}

async function foodyFetch(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(`${url}?_=${Date.now()}`, {
      headers: foodyHeaders(),
      signal: controller.signal,
    });
    const text = await r.text();
    if (!r.ok) {
      const err = new Error(`HTTP ${r.status}`);
      err.status = r.status;
      throw err;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      // Corpo não-JSON com 200 = provável página de login (cookie caiu).
      const err = new Error('resposta não-JSON do Foody');
      err.status = r.status;
      err.nonJson = true;
      throw err;
    }
  } finally {
    clearTimeout(timer);
  }
}

// Erro que indica sessão/cookie inválido de verdade (vs. instabilidade momentânea).
function isAuthError(e) {
  return !!e && (e.status === 401 || e.status === 403 || (e.nonJson && e.status === 200));
}

// POST no Foody (chat/ações). Usa a mesma sessão (cookie SESSION) do foodyFetch.
async function foodyPost(url, body) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { ...foodyHeaders(), 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`HTTP ${r.status}: ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : {};
  } finally {
    clearTimeout(timer);
  }
}

// ── Estado do monitor ─────────────────────────────────────────────────────────

const courierMap = new Map();
let activeAlerts    = [];
let readyOrdersCount = 0;

// Delay pra um pedido "pronto" contar como "esperando": o sistema leva ~10s pra
// despachar pra alguém, e o monitor (poll ~1s) é mais rápido que o Foody. Sem isso,
// dispara "tem pedido esperando" no instante que a pizza fica pronta (falso alarme).
const READY_DELAY_MS = 10000;
const readyOrderSince = new Map(); // uid do pedido pronto -> quando apareceu pronto

// Alertas de demora do entregador com o pedido já na mão:
//  - status 'dispatched' (recebeu, não aceitou) por +5min
//  - status 'accepted'   (aceitou, não saiu)    por +5min
const ACCEPT_DELAY_MS = 5 * 60 * 1000;
const orderStageSince = new Map(); // uid -> { status, since, alerted, courier, num }
let lastUpdated      = null;
let sessionOk        = false;
let pollRunning      = false;
let hasLoggedStart   = false;
let currentOpDate    = operationalDate();
let shiftIdle         = false; // true quando, de madrugada, não há mais pedido pronto nem entrega em rota

let lastCookieAlertAt = 0;
let consecutiveFailures = 0;

const STATE_FILE = path.join(LOGS_DIR, 'state.json');

function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({
      opDate:          currentOpDate,
      couriers:        [...courierMap.entries()],
      activeAlerts,
      readyOrdersCount,
      savedAt:         Date.now(),
    }));
  } catch (e) {}
}

function loadState() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (raw.opDate !== operationalDate()) {
      // Turno diferente — zera geral, não carrega nada do dia anterior.
      return;
    }
    for (const [id, cs] of raw.couriers) courierMap.set(id, cs);
    activeAlerts     = raw.activeAlerts     || [];
    readyOrdersCount = raw.readyOrdersCount || 0;
    console.log(`[INFO] Estado restaurado: ${courierMap.size} entregadores, ${activeAlerts.length} alertas.`);
  } catch (e) {}
}

// Guarda quando cada entregador apareceu pela primeira vez hoje
const courierOnlineSince = new Map(); // nome → timestamp

loadState();

function loadOnlineTimes() {
  try {
    const file = path.join(LOGS_DIR, `${operationalDate()}.json`);
    const logs = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of logs) {
      if (e.type === 'courier_online')
        courierOnlineSince.set(e.courierName, new Date(e.timestamp).getTime());
    }
    if (courierOnlineSince.size > 0)
      console.log(`[INFO] Horários de entrada restaurados: ${courierOnlineSince.size} entregadores.`);
  } catch (e) {}
}

loadOnlineTimes();

function addAlert(type, msg, courierName = null, extra = {}) {
  const alert = { id: Date.now(), type, msg, time: new Date().toISOString(), courierName, ...extra };
  activeAlerts.unshift(alert);
  if (activeAlerts.length > 30) activeAlerts.pop();
  appendLog({ type: 'alert', alertType: type, msg, courierName });
  console.log(`[ALERTA] ${msg}`);
  sendPush({
    title: type === 'missing' ? '🚨 Sumiu do mapa!'
      : type === 'single'    ? '✅ Saiu com 1 entrega'
      : type === 'cookie'    ? '🍪 Cookie expirado!'
      : type === 'shiftEnd'  ? '🌙 Expediente encerrado'
      : type === 'accept'    ? '⏳ Demora pra aceitar'
      : type === 'depart'    ? '⏳ Demora pra sair'
      : '⚠️ Demora no retorno',
    body: msg,
    tag: `${type}-${courierName || Date.now()}`,
    type,
  }).catch(e => console.error('[PUSH]', e.message));
  return alert;
}

// Congela o cronômetro de um alerta de etapa quando o entregador finalmente aceita/sai.
function resolveStageAlert(prev, now) {
  if (!prev || !prev.alerted || !prev.alertId) return;
  const al = activeAlerts.find(a => a.id === prev.alertId);
  if (al && !al.resolvedAt) al.resolvedAt = now;
}

function orderNumberOf(o) {
  return o.orderNumber ?? o.number ?? o.code ?? o.orderCode ?? o.orderId ?? o.id ?? null;
}

// Vigia quanto tempo cada pedido fica "recebido mas não aceito" (dispatched) e
// "aceito mas não saiu" (accepted). Passou de ACCEPT_DELAY_MS, alerta uma vez.
function trackOrderStages(ordersByCourierList) {
  const now  = Date.now();
  const seen = new Set();
  for (const co of ordersByCourierList || []) {
    const courier = (co.courierName || '').trim();
    for (const o of co.orders || []) {
      const key = o.uid || o.id;
      if (key == null) continue;
      seen.add(key);
      const prev = orderStageSince.get(key);
      if (!prev || prev.status !== o.status) {
        resolveStageAlert(prev, now); // etapa anterior terminou → congela o cronômetro
        orderStageSince.set(key, { status: o.status, since: now, alerted: false, alertId: null, courier, num: orderNumberOf(o) });
        continue;
      }
      if (!prev.alerted && now - prev.since >= ACCEPT_DELAY_MS) {
        if (o.status === 'dispatched') {
          const al = addAlert('accept', `${courier} recebeu o #${prev.num} e ainda não aceitou`, courier, { stageSince: prev.since });
          prev.alerted = true; prev.alertId = al.id;
        } else if (o.status === 'accepted') {
          const al = addAlert('depart', `${courier} aceitou o #${prev.num} mas ainda não saiu`, courier, { stageSince: prev.since });
          prev.alerted = true; prev.alertId = al.id;
        }
      }
    }
  }
  for (const k of orderStageSince.keys()) {
    if (!seen.has(k)) {
      resolveStageAlert(orderStageSince.get(k), now); // pedido saiu da lista → congela
      orderStageSince.delete(k);
    }
  }
}

function processTracking(trackingList, ordersByCourierList) {
  const now        = Date.now();
  const shiftStart = operationalDayStartMs();
  const seenIds    = new Set(trackingList.map(c => c.courierId));

  const ordersByName = new Map();
  for (const co of ordersByCourierList) {
    ordersByName.set(co.courierName.trim(), co.orders || []);
  }

  for (const tc of trackingList) {
    const id   = tc.courierId;
    const name = tc.courierName.trim();
    const all  = ordersByName.get(name) || [];

    const activeOrders    = all.filter(o => ['onGoing', 'accepted', 'dispatched'].includes(o.status));
    // Só conta entrega do turno atual — senão um entregador sem entrega hoje ainda
    // pega uma entrega antiga (de dias atrás) como referência e o timer de "descansando" explode.
    const deliveredOrders = all.filter(o =>
      o.status === 'delivered' && o.deliveryDate && new Date(o.deliveryDate).getTime() >= shiftStart
    );

    let finishedAt = null;
    let lastOrderNumber = null;
    if (activeOrders.length === 0 && deliveredOrders.length > 0) {
      const raw = Math.max(...deliveredOrders.map(o => new Date(o.deliveryDate).getTime()));
      finishedAt = Math.min(raw, now); // nunca usar timestamp futuro (possível offset de fuso)
      const last = deliveredOrders.reduce((a, b) =>
        new Date(a.deliveryDate).getTime() >= new Date(b.deliveryDate).getTime() ? a : b
      );
      lastOrderNumber = orderNumberOf(last);
    }

    if (!courierMap.has(id)) {
      const status = activeOrders.length > 0 ? 'delivering' : 'available';
      // Usa horário real de entrada do log (resiste a reinícios do servidor)
      const onlineAt = courierOnlineSince.get(name) || now;
      if (!courierOnlineSince.has(name)) {
        courierOnlineSince.set(name, now);
        appendLog({ type: 'courier_online', courierName: name, status });
      }
      courierMap.set(id, {
        id, name,
        vehicleType: tc.vehicleType,
        lastSeen: now,
        lat: tc.latitute, lng: tc.longitude,
        activeOrderCount: activeOrders.length,
        finishedAt,
        lastOrderNumber,
        status,
        statusSince: finishedAt || onlineAt,
        onlineAt,
        alerted: false,
      });
      continue;
    }

    const cs = courierMap.get(id);
    const prev = cs.status;
    cs.lastSeen = now;
    cs.lat = tc.latitute;
    cs.lng = tc.longitude;
    cs.activeOrderCount = activeOrders.length;
    if (lastOrderNumber != null) cs.lastOrderNumber = lastOrderNumber;

    if (activeOrders.length > 0) {
      if (cs.status !== 'delivering') {
        cs.status     = 'delivering';
        cs.statusSince = now;
        cs.finishedAt  = null;
        cs.alerted    = false;
        if (activeOrders.length === 1) {
          addAlert('single', `${cs.name} está com apenas 1 pedido para entrega`, cs.name);
        }
      }
    } else {
      if (cs.status === 'delivering') {
        cs.finishedAt  = finishedAt || now;
        cs.statusSince = now;
        cs.alerted    = false;
      }
      if (cs.finishedAt) {
        const elapsed = (now - cs.finishedAt) / 60000;
        if (readyOrdersCount > 0) {
          if (elapsed >= config.alertMinutes) {
            cs.status = 'alert';
            if (!cs.alerted) {
              cs.alerted = true;
              const ord = cs.lastOrderNumber ? `o #${cs.lastOrderNumber} ` : '';
              addAlert('slow', `${cs.name} terminou ${ord}há ${Math.floor(elapsed)}min e tem pedido esperando!`, cs.name);
            }
          } else if (elapsed >= config.alertMinutes * 0.65) {
            if (cs.status !== 'alert') cs.status = 'warning';
          } else {
            if (cs.status !== 'alert' && cs.status !== 'warning') cs.status = 'available';
          }
        } else {
          if (cs.status === 'alert' || cs.status === 'warning') cs.alerted = false;
          cs.status = 'available';
        }
      }
    }

    if (cs.status !== prev) {
      appendLog({ type: 'status_change', courierName: cs.name, from: prev, to: cs.status });
    }
  }

  // Detecta quem sumiu do mapa — avisa uma vez e tira o card da tela
  // (se ele reconectar depois, volta como um novo card, sem ficar preso mostrando timer).
  for (const [id, cs] of courierMap) {
    if (!seenIds.has(id)) {
      appendLog({ type: 'status_change', courierName: cs.name, from: cs.status, to: 'missing' });
      const coords = (cs.lat && cs.lng) ? { lat: cs.lat, lng: cs.lng } : {};
      addAlert('missing', `${cs.name} sumiu do mapa!`, cs.name, coords);
      courierMap.delete(id);
    }
  }
}

// ── Loop de polling ───────────────────────────────────────────────────────────

async function doPoll() {
  if (!config.cookie || pollRunning) return;
  pollRunning = true;
  try {
    // Reseta o estado ao virar o turno (às 06h)
    const today = operationalDate();
    if (today !== currentOpDate) {
      currentOpDate = today;
      // Zera geral na virada do turno — sem carregar timer de ninguém pro dia seguinte.
      courierMap.clear();
      courierOnlineSince.clear();
      activeAlerts  = [];
      hasLoggedStart = false;
      shiftIdle      = false;
      console.log('[INFO] Novo turno — estado resetado.');
    }

    const [tracking, orders] = await Promise.all([
      foodyFetch('https://app.foodydelivery.com/api/home-data/couriers-for-tracking'),
      foodyFetch('https://app.foodydelivery.com/api/order/listbycourier'),
    ]);

    if (!Array.isArray(tracking.couriers)) throw new Error('resposta inesperada');

    if (!hasLoggedStart) {
      hasLoggedStart = true;
      appendLog({ type: 'session_start' });
      console.log('[INFO] Monitoramento iniciado com sucesso.');
    }

    // Pedidos prontos e sem entregador. Só contam como "esperando" após READY_DELAY_MS
    // pronto — dá tempo do sistema despachar pra alguém antes de alertar.
    const nowReady   = Date.now();
    const readyList  = (orders.pendingOrdersByCompany || []).filter(o => o.status === 'ready');
    const readyKeys  = new Set(readyList.map(o => o.uid || o.id));
    for (const o of readyList) {
      const k = o.uid || o.id;
      if (!readyOrderSince.has(k)) readyOrderSince.set(k, nowReady);
    }
    for (const k of readyOrderSince.keys()) {
      if (!readyKeys.has(k)) readyOrderSince.delete(k); // saiu de "pronto" (despachado/cancelado)
    }
    readyOrdersCount = readyList.filter(o => nowReady - readyOrderSince.get(o.uid || o.id) >= READY_DELAY_MS).length;

    trackOrderStages(orders.ordersByCourier || []);
    processTracking(tracking.couriers, orders.ordersByCourier || []);

    const noActiveOrders = ![...courierMap.values()].some(c => c.activeOrderCount > 0);
    const idleNow = isLateNightBRT() && readyOrdersCount === 0 && noActiveOrders;
    if (idleNow && !shiftIdle) {
      addAlert('shiftEnd', 'Expediente encerrado — sem pedidos pendentes.');
    }
    shiftIdle = idleNow;

    lastUpdated = Date.now();
    sessionOk   = true;
    consecutiveFailures = 0;
    saveState();
  } catch (e) {
    consecutiveFailures++;
    console.error('[POLL]', e.message, `(falha ${consecutiveFailures})`);

    // Blip isolado (timeout, 5xx momentâneo, JSON quebrado num ciclo) NÃO vira
    // "cookie expirou" — só derruba a sessão se for erro de auth de verdade OU
    // se falhar 3x seguidas (~30s), aí sim é queda persistente.
    const authLikely = isAuthError(e);
    if (authLikely || consecutiveFailures >= 3) {
      const wasOk = sessionOk;
      sessionOk = false;
      const now = Date.now();
      if (wasOk || now - lastCookieAlertAt > 30 * 60 * 1000) {
        lastCookieAlertAt = now;
        addAlert('cookie', authLikely
          ? 'Cookie do Foody expirou ou sessão caiu — abra o monitor e atualize o cookie nas Configurações!'
          : 'Monitor sem resposta do Foody há alguns ciclos — pode ser instabilidade. Se persistir, atualize o cookie.');
      }
    }
  } finally {
    pollRunning = false;
    broadcastState();
  }
}

// Reagenda a cada ciclo lendo config.pollIntervalMs, pra dar pra mudar em tempo real pelo ADM MASTER
function schedulePoll() {
  setTimeout(async () => {
    await doPoll();
    schedulePoll();
  }, Math.max(200, config.pollIntervalMs || 10000));
}
schedulePoll();

// ── Rotas HTTP ────────────────────────────────────────────────────────────────

// Pedidos que o entregador está "segurando": recebeu e não aceitou (dispatched)
// ou aceitou e não saiu (accepted). Cada um vira um card com cronômetro ao vivo.
function buildHolding() {
  const out = [];
  for (const [uid, s] of orderStageSince) {
    if (s.status === 'dispatched' || s.status === 'accepted') {
      out.push({ uid, courier: s.courier, num: s.num, stage: s.status, since: s.since });
    }
  }
  return out;
}

function buildStatePayload() {
  return {
    configured:       !!config.cookie,
    sessionOk,
    lastUpdated,
    readyOrdersCount,
    shiftIdle,
    alertMinutes:     config.alertMinutes,
    couriers:         [...courierMap.values()],
    alerts:           activeAlerts,
    holding:          buildHolding(),
    serverStartedAt:  SERVER_STARTED_AT,
  };
}

const RESTRICTED_PAYLOAD = { restricted: true };

app.get('/api/state', (req, res) => {
  res.json(hasDataAccess(req) ? buildStatePayload() : RESTRICTED_PAYLOAD);
});

// ── Tempo real (Server-Sent Events) ──────────────────────────────────────────

const sseClients = new Set(); // { res, access }

function broadcastState() {
  const full       = `data: ${JSON.stringify(buildStatePayload())}\n\n`;
  const restricted = `data: ${JSON.stringify(RESTRICTED_PAYLOAD)}\n\n`;
  for (const client of sseClients) client.res.write(client.access ? full : restricted);
}

app.get('/api/stream', (req, res) => {
  res.set({
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
  res.flushHeaders();
  const access = hasDataAccess(req);
  const client = { res, access };
  res.write(`data: ${JSON.stringify(access ? buildStatePayload() : RESTRICTED_PAYLOAD)}\n\n`);
  sseClients.add(client);
  req.on('close', () => sseClients.delete(client));
});

// Mantém as conexões SSE vivas atrás do proxy do EasyPanel
setInterval(() => {
  for (const client of sseClients) client.res.write(':keep-alive\n\n');
}, 20 * 1000);

app.post('/api/alerts/dismiss', (req, res) => {
  const { id } = req.body;
  activeAlerts = activeAlerts.filter(a => a.id !== id);
  res.json({ ok: true });
});

// Cutucar entregador: manda mensagem no chat interno do Foody (mesma sessão do monitor).
// Fluxo: acha o courierUid pelo nome → cria/pega a conversa → envia a mensagem.
app.post('/api/nudge', async (req, res) => {
  const name    = (req.body.name    || '').trim();
  const message = (req.body.message || '').trim();
  if (!name || !message)  return res.status(400).json({ ok: false, error: 'Nome e mensagem são obrigatórios.' });
  if (!config.cookie)     return res.status(400).json({ ok: false, error: 'Sessão do Foody não configurada.' });

  const norm = s => (s || '').trim().toLowerCase();
  try {
    const list = await foodyFetch('https://app.foodydelivery.com/api/v2/conversations/couriers-for-conversation');
    const couriers = list.couriers || [];
    const match = couriers.find(c => norm(c.courierName) === norm(name))
      || couriers.find(c => norm(c.courierName).startsWith(norm(name)) || norm(name).startsWith(norm(c.courierName)));
    if (!match) return res.status(404).json({ ok: false, error: `Entregador "${name}" não encontrado no chat do Foody.` });

    const conv = await foodyPost('https://app.foodydelivery.com/api/v2/conversations/create-or-get-conversation', { courierUid: match.courierUid });
    if (!conv.conversationUid) throw new Error('Não consegui abrir a conversa.');

    const sent = await foodyPost(`https://app.foodydelivery.com/api/v2/conversations/${conv.conversationUid}/send-message`, { body: message });
    console.log(`[NUDGE] "${message}" → ${match.courierName}`);
    res.json({ ok: true, courierName: match.courierName, messageUid: sent.messageUid });
  } catch (e) {
    console.error('[NUDGE]', e.message);
    res.status(502).json({ ok: false, error: e.message });
  }
});

// TEMP probe — ver o ciclo de status dos pedidos ao vivo (pra calibrar os alertas)
app.get('/api/orders-debug', async (req, res) => {
  try {
    const orders = await foodyFetch('https://app.foodydelivery.com/api/order/listbycourier');
    const byCourier = (orders.ordersByCourier || []).flatMap(co =>
      (co.orders || []).map(o => ({ courier: co.courierName, id: o.id, uid: o.uid, status: o.status, date: o.date, due: o.deliveryDueDate })));
    const pending = (orders.pendingOrdersByCompany || []).map(o => ({ id: o.id, status: o.status, customer: o.customerName }));
    res.json({ byCourier, pending });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/config', (req, res) => {
  res.json({ configured: !!config.cookie, usingEnv: !!process.env.FOODY_COOKIE });
});

// TEMP probe — espiar a "fila de entregadores" (company-connections agrega os
// couriersForDespatching = disponíveis pra receber). Só pra descobrir os campos.
app.get('/api/fila-debug', async (req, res) => {
  if (!hasDataAccess(req)) return res.status(401).json({ error: 'sem acesso' });
  try {
    const cc = await foodyFetch('https://app.foodydelivery.com/api/home-data/company-connections');
    const trk = await foodyFetch('https://app.foodydelivery.com/api/home-data/couriers-for-tracking');
    res.json({
      company_connections_keys: Object.keys(cc || {}),
      couriersForDespatching: cc.couriersForDespatching || null,
      companyCourierConnectionStatus: cc.companyCourierConnectionStatus || null,
      couriersForTracking_sample: (trk.couriers || [])[0] || null,
      couriersForTracking_count: (trk.couriers || []).length,
    });
  } catch (e) { res.json({ error: e.message }); }
});

function isAdmin(req) {
  const pass = req.headers['x-admin-password'] || req.query.adminPassword;
  return !!config.adminPassword && pass === config.adminPassword;
}

function ipAllowed(req) {
  const ip = (req.ip || '').replace('::ffff:', '');
  return (config.allowedIps || []).includes(ip);
}

// Libera os dados do painel só pra IP liberado ou ADM MASTER logado.
// Todo mundo abre o site — o que muda é se os dados aparecem ou não.
function hasDataAccess(req) {
  return ipAllowed(req) || isAdmin(req);
}

app.post('/config', (req, res) => {
  if (config.adminPassword && !isAdmin(req)) {
    return res.status(401).json({ ok: false, error: 'unauthorized' });
  }
  if (req.body.cookie) {
    config.cookie  = req.body.cookie.trim();
    hasLoggedStart = false;
    sessionOk      = false;
    doPoll();
  }
  if (req.body.alertMinutes) {
    config.alertMinutes = parseInt(req.body.alertMinutes) || 15;
  }
  saveConfig();
  res.json({ ok: true });
});

// ── ADM MASTER (John) ─────────────────────────────────────────────────────────

app.post('/api/admin/verify', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ ok: false });
  if (!config.adminPassword) {
    // Primeira senha cadastrada vira a senha do ADM MASTER
    config.adminPassword = password;
    saveConfig();
    return res.json({ ok: true, created: true });
  }
  res.json({ ok: config.adminPassword === password });
});

app.get('/api/admin/visits', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({ visits });
});

app.get('/api/admin/access', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  res.json({
    allowedIps:     config.allowedIps || [],
    pollIntervalMs: config.pollIntervalMs || 10000,
  });
});

app.post('/api/admin/access', (req, res) => {
  if (!isAdmin(req)) return res.status(401).json({ error: 'unauthorized' });
  if (Array.isArray(req.body.allowedIps)) {
    config.allowedIps = req.body.allowedIps.map(s => String(s).trim()).filter(Boolean);
  }
  if (req.body.pollIntervalMs) {
    config.pollIntervalMs = Math.max(200, parseInt(req.body.pollIntervalMs) || 10000);
  }
  saveConfig();
  res.json({ ok: true });
});

app.post('/api/track', (req, res) => {
  const ua     = req.headers['user-agent'] || '';
  const parsed = parseUserAgent(ua);
  const extra  = req.body || {};
  visits.unshift({
    ip:         (req.ip || '').replace('::ffff:', ''),
    time:       new Date().toISOString(),
    os:         parsed.os,
    browser:    parsed.browser,
    deviceType: parsed.deviceType,
    model:      parsed.model,
    screen:     extra.screen   || null,
    lang:       extra.lang     || null,
    tz:         extra.tz       || null,
    platform:   extra.platform || null,
    ua,
  });
  if (visits.length > 500) visits.length = 500;
  saveVisits();
  res.json({ ok: true });
});

app.get('/api/log', (req, res) => {
  if (!hasDataAccess(req)) return res.status(401).json({ date: null, logs: [] });
  const date = req.query.date || operationalDate();
  const file = path.join(LOGS_DIR, `${date}.json`);
  try {
    res.json({ date, logs: JSON.parse(fs.readFileSync(file, 'utf8')) });
  } catch (e) {
    res.json({ date, logs: [] });
  }
});

app.get('/api/logs', (req, res) => {
  if (!hasDataAccess(req)) return res.status(401).json({ dates: [] });
  try {
    // Só os arquivos de log diário (YYYY-MM-DD.json) — ignora config/visits/state/push-subscriptions
    const dates = fs.readdirSync(LOGS_DIR)
      .filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .map(f => f.replace('.json', ''))
      .sort().reverse();
    res.json({ dates });
  } catch (e) {
    res.json({ dates: [] });
  }
});

// ── Push routes ───────────────────────────────────────────────────────────────

app.get('/api/push/vapid-key', (req, res) => {
  res.json({ publicKey: config.vapidKeys.publicKey });
});

app.post('/api/push/subscribe', (req, res) => {
  const sub = req.body;
  if (!sub?.endpoint) return res.status(400).json({ error: 'invalid' });
  if (!pushSubscriptions.find(s => s.endpoint === sub.endpoint)) {
    pushSubscriptions.push(sub);
    saveSubscriptions();
  }
  res.json({ ok: true });
});

app.delete('/api/push/subscribe', (req, res) => {
  const { endpoint } = req.body || {};
  pushSubscriptions = pushSubscriptions.filter(s => s.endpoint !== endpoint);
  saveSubscriptions();
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('   Foody Monitor - Varandas Pizzaria');
  console.log('========================================');
  console.log(`\n  Acesse: http://localhost:${PORT}`);
  console.log(`  Cookie: ${config.cookie ? 'configurado ✓' : 'NÃO configurado ✗'}`);
  console.log('  Monitoramento 24/7: ATIVO\n');
});
