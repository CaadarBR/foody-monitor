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

  // ── Pedido parado na mão do entregador ─────────────────────────────────────
  noCollectMinutes:  5,  // caiu pra ele e ele não coletou
  noDispatchMinutes: 5,  // coletou mas continua na loja
  promiseMinutes:   50,  // prazo padrão do pedido (provisório, até o CardápioWeb entrar)
  lateMarginMinutes: 10, // faltando isso pro prazo, já conta como "vai atrasar"

  // O Foody não documenta os nomes de status, então eles ficam aqui pra serem
  // ajustados sem mexer no código. O que não estiver em nenhuma lista aparece
  // no log e no ADM ("status vistos") pra ser encaixado depois.
  orderStatus: {
    // caiu pra ele e ainda não coletou
    waiting:   ['pending', 'waiting', 'assigned', 'accepted', 'new', 'created', 'sent'],
    // coletou, mas ainda não saiu da loja
    collected: ['collected', 'coletado', 'pickedUp', 'picked_up', 'pickup', 'withCourier'],
    // saiu pra entrega
    onRoute:   ['onGoing', 'dispatched', 'inRoute', 'onTheWay', 'outForDelivery', 'saiuParaEntrega', 'delivering'],
  },

  msgTemplates: {
    notCollected: 'Opa {nome}! O pedido #{pedido} caiu pra você há {tempo} e ainda não foi coletado. Consegue coletar agora?',
    noDispatch: 'Opa {nome}! Você coletou o pedido #{pedido} há {tempo} e ainda não saiu pra entrega. Consegue sair agora?',
    late:       '{nome}, o pedido #{pedido} {prazo} e ainda não saiu da loja. Precisa sair agora pra não atrasar!',
  },
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
      for (const k of ['noCollectMinutes', 'noDispatchMinutes', 'promiseMinutes', 'lateMarginMinutes']) {
        if (saved[k] != null) config[k] = saved[k];
      }
      // nomes da versão anterior, quando a fase do meio era "aceitou" em vez de "coletou"
      if (saved.noAcceptMinutes != null && saved.noCollectMinutes == null) {
        config.noCollectMinutes = saved.noAcceptMinutes;
      }
      if (saved.orderStatus) {
        const { atStore, ...resto } = saved.orderStatus;
        config.orderStatus = { ...config.orderStatus, ...resto };
        if (atStore && !saved.orderStatus.collected) config.orderStatus.collected = atStore;
      }
      if (saved.msgTemplates) {
        const { noAccept, ...resto } = saved.msgTemplates;
        config.msgTemplates = { ...config.msgTemplates, ...resto };
        if (noAccept && !saved.msgTemplates.notCollected) config.msgTemplates.notCollected = noAccept;
      }
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
    return JSON.parse(text);
  } finally {
    clearTimeout(timer);
  }
}

// ── Estado do monitor ─────────────────────────────────────────────────────────

const courierMap = new Map();
let activeAlerts    = [];
let readyOrdersCount = 0;
let lastUpdated      = null;
let sessionOk        = false;
let pollRunning      = false;
let hasLoggedStart   = false;
let currentOpDate    = operationalDate();
let shiftIdle         = false; // true quando, de madrugada, não há mais pedido pronto nem entrega em rota

let lastCookieAlertAt = 0;

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

// Ponto de partida do "parado desde". Nunca antes da última vez em que ele foi visto
// com pedido ativo, e nunca no futuro — o deliveryDate do Foody pode vir com fuso
// trocado ou desatualizado, e sem essas travas o contador acumula horas que o
// entregador não passou parado.
function clampIdle(raw, floor, now) {
  return Math.min(Math.max(raw, floor || 0), now);
}

// Formata uma duração em minutos como "2h14min" (ou "45min" quando < 1h).
function fmtMinutes(totalMinutes) {
  const mins = Math.max(0, Math.floor(totalMinutes));
  const h    = Math.floor(mins / 60);
  const m    = mins % 60;
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}min` : `${m}min`;
}

function alertTitle(type) {
  return type === 'missing'    ? '🚨 Sumiu do mapa!'
    : type === 'single'        ? '✅ Saiu com 1 entrega'
    : type === 'cookie'        ? '🍪 Cookie expirado!'
    : type === 'shiftEnd'      ? '🌙 Expediente encerrado'
    : type === 'notCollected'  ? '⏳ Pedido sem coletar'
    : type === 'noDispatch'    ? '🛵 Coletou e não saiu'
    : type === 'late'          ? '⏰ Vai estourar o prazo'
    : '⚠️ Demora no retorno';
}

function addAlert(type, msg, courierName = null, extra = {}) {
  activeAlerts.unshift({ id: Date.now(), type, msg, time: new Date().toISOString(), courierName, ...extra });
  if (activeAlerts.length > 30) activeAlerts.pop();
  appendLog({ type: 'alert', alertType: type, msg });
  console.log(`[ALERTA] ${msg}`);
  sendPush({
    title: alertTitle(type),
    body: msg,
    tag: `${type}-${courierName || Date.now()}`,
    type,
  }).catch(e => console.error('[PUSH]', e.message));
}

function orderNumberOf(o) {
  return o.orderNumber ?? o.number ?? o.code ?? o.orderCode ?? o.orderId ?? o.id ?? null;
}

function orderKeyOf(o) {
  return String(o.id ?? o.orderId ?? o.orderNumber ?? o.number ?? o.code ?? JSON.stringify(o).slice(0, 60));
}

// ── Pedido parado na mão do entregador ───────────────────────────────────────
// Todo pedido passa por três fases até ir pra rua: cai pro entregador (waiting),
// ele coleta mas continua na loja (collected) e finalmente sai pra entrega
// (onRoute). O alerta mora nas duas primeiras — depois que saiu, não tem o que cobrar.

const orderTracker      = new Map(); // "courierId:pedido" → fase + desde quando
const seenOrderStatuses = new Set(); // vocabulário real do Foody, pro ADM conferir
const warnedStatuses    = new Set();
let   orderFieldsSeen   = [];        // campos que o pedido traz (pra achar o prazo real)

function orderPhase(status) {
  const s = String(status || '');
  const b = config.orderStatus || {};
  if ((b.onRoute   || []).includes(s)) return 'onRoute';
  if ((b.collected || []).includes(s)) return 'collected';
  if ((b.waiting   || []).includes(s)) return 'waiting';
  if (['delivered', 'canceled', 'cancelled', 'concluded', 'finished'].includes(s)) return 'done';
  return 'unknown';
}

// Statuses que contam como "pedido na mão dele" pro resto do monitor.
function activeStatuses() {
  const b = config.orderStatus || {};
  return [...(b.collected || []), ...(b.onRoute || [])];
}

const ORDER_CREATED_FIELDS = ['createdDate', 'createdAt', 'orderDate', 'creationDate', 'dateCreated', 'date'];
const ORDER_DUE_FIELDS     = ['deliveryForecast', 'deliveryForecastDate', 'forecastDate', 'promisedDate', 'deliveryDeadline', 'estimatedDeliveryDate'];

function firstDateOf(o, fields) {
  for (const f of fields) {
    if (!o[f]) continue;
    const t = new Date(o[f]).getTime();
    if (!Number.isNaN(t)) return t;
  }
  return null;
}

// Prazo do pedido. Usa a previsão que vier do Foody; se não vier nenhuma, cai no
// prazo padrão configurado, contado da criação do pedido. É esse pedaço que o
// CardápioWeb vai substituir quando a integração existir.
function orderDueAt(o, firstSeen) {
  const explicit = firstDateOf(o, ORDER_DUE_FIELDS);
  if (explicit) return explicit;
  const created = firstDateOf(o, ORDER_CREATED_FIELDS) || firstSeen;
  return created + (config.promiseMinutes || 50) * 60000;
}

function fillTemplate(tpl, vars) {
  return String(tpl || '').replace(/\{(\w+)\}/g, (_, k) => (vars[k] != null ? vars[k] : `{${k}}`));
}

// "vence em 8min" / "estourou há 3min"
function duePhrase(msLeft) {
  return msLeft >= 0 ? `vence em ${fmtMinutes(msLeft / 60000)}` : `estourou há ${fmtMinutes(-msLeft / 60000)}`;
}

// Acompanha os pedidos de um entregador e dispara os alertas de pedido parado.
// Devolve o pedido parado há mais tempo, pra aparecer no card dele na tela.
function trackOrders(courierName, courierId, orders, now, seenKeys) {
  let held = null;

  for (const o of orders) {
    if (!orderFieldsSeen.length) {
      orderFieldsSeen = Object.keys(o);
      console.log(`[INFO] campos do pedido no Foody: ${orderFieldsSeen.join(', ')}`);
    }
    if (o.status) seenOrderStatuses.add(String(o.status));
    const phase = orderPhase(o.status);
    if (phase === 'done') continue;
    if (phase === 'unknown') {
      if (!warnedStatuses.has(o.status)) {
        warnedStatuses.add(o.status);
        console.log(`[INFO] status de pedido desconhecido: "${o.status}" — encaixe ele em orderStatus pra valer nos alertas de pedido parado.`);
      }
      continue;
    }

    const key = `${courierId}:${orderKeyOf(o)}`;
    seenKeys.add(key);

    let st = orderTracker.get(key);
    if (!st) {
      st = { phase, since: now, firstSeen: now, alerted: {} };
      orderTracker.set(key, st);
    }
    if (st.phase !== phase) {  // mudou de fase → o relógio recomeça
      st.phase = phase;
      st.since = now;
    }
    st.dueAt = orderDueAt(o, st.firstSeen);

    if (phase === 'onRoute') continue; // já está na rua, não tem o que cobrar

    const number  = orderNumberOf(o);
    const heldMin = (now - st.since) / 60000;
    const msLeft  = st.dueAt - now;
    const vars    = { nome: courierName, pedido: number, tempo: fmtMinutes(heldMin), prazo: duePhrase(msLeft) };

    if (phase === 'waiting' && heldMin >= (config.noCollectMinutes || 5) && !st.alerted.notCollected) {
      st.alerted.notCollected = true;
      addAlert('notCollected', `${courierName} está há ${fmtMinutes(heldMin)} sem coletar o pedido #${number}`, courierName, {
        orderNumber: number,
        suggestedMessage: fillTemplate(config.msgTemplates.notCollected, vars),
      });
    }

    if (phase === 'collected' && heldMin >= (config.noDispatchMinutes || 5) && !st.alerted.noDispatch) {
      st.alerted.noDispatch = true;
      addAlert('noDispatch', `${courierName} coletou o pedido #${number} há ${fmtMinutes(heldMin)} e ainda não saiu`, courierName, {
        orderNumber: number,
        suggestedMessage: fillTemplate(config.msgTemplates.noDispatch, vars),
      });
    }

    // Vai estourar o prazo com o pedido ainda na loja.
    if (msLeft <= (config.lateMarginMinutes || 10) * 60000 && !st.alerted.late) {
      st.alerted.late = true;
      addAlert('late', `Pedido #${number} com ${courierName} ${duePhrase(msLeft)} e ainda não saiu!`, courierName, {
        orderNumber: number,
        urgent: true,
        suggestedMessage: fillTemplate(config.msgTemplates.late, vars),
      });
    }

    if (!held || st.since < held.since) {
      held = { number, phase, since: st.since, dueAt: st.dueAt };
    }
  }

  return held;
}

function processTracking(trackingList, ordersByCourierList) {
  const now        = Date.now();
  const shiftStart = operationalDayStartMs();
  const seenIds    = new Set(trackingList.map(c => c.courierId));
  const seenOrders = new Set();

  const ordersByName = new Map();
  for (const co of ordersByCourierList) {
    ordersByName.set(co.courierName.trim(), co.orders || []);
  }

  for (const tc of trackingList) {
    const id   = tc.courierId;
    const name = tc.courierName.trim();
    const all  = ordersByName.get(name) || [];

    const activeOrders    = all.filter(o => activeStatuses().includes(o.status));
    // Pedido que caiu pra ele e ainda não foi pra rua — rende alerta e sugestão de mensagem
    const heldOrder       = trackOrders(name, id, all, now, seenOrders);
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
        heldOrder,
        finishedAt,
        lastActiveAt: activeOrders.length > 0 ? now : null,
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
    cs.heldOrder        = heldOrder;
    if (lastOrderNumber != null) cs.lastOrderNumber = lastOrderNumber;

    if (activeOrders.length > 0) {
      cs.lastActiveAt = now; // última vez visto com pedido na mão
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
        cs.alerted = false;
        // Terminou agora e o Foody ainda não publicou a entrega: conta a partir de agora.
        if (!finishedAt && !cs.finishedAt) cs.finishedAt = now;
      }
      // Recalcula SEMPRE (e não só ao sair de "em entrega"): se ele rodou mais uma
      // entrega sem o monitor pegar o estado intermediário, o relógio precisa voltar
      // pro fim dessa entrega em vez de continuar contando desde a primeira do turno.
      const ref = finishedAt || cs.finishedAt;
      if (ref) {
        const idleAt = clampIdle(ref, cs.lastActiveAt || 0, now);
        if (cs.finishedAt !== idleAt) {
          if (finishedAt && idleAt - finishedAt > 5 * 60000) {
            console.log(`[INFO] ${cs.name}: deliveryDate (${new Date(finishedAt).toISOString()}) é anterior ao último pedido ativo — contando de ${new Date(idleAt).toISOString()}.`);
          }
          cs.finishedAt  = idleAt;
          cs.statusSince = idleAt; // card e notificação contam do mesmo ponto
        }
      }
      if (cs.finishedAt) {
        const elapsed = (now - cs.finishedAt) / 60000;
        if (readyOrdersCount > 0) {
          if (elapsed >= config.alertMinutes) {
            cs.status = 'alert';
            if (!cs.alerted) {
              cs.alerted = true;
              addAlert('slow', `${cs.name} terminou há ${fmtMinutes(elapsed)} e tem pedido esperando!`, cs.name);
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

  // Pedido que saiu da lista (entregue, cancelado ou reatribuído) sai do rastreio
  for (const key of orderTracker.keys()) {
    if (!seenOrders.has(key)) orderTracker.delete(key);
  }

  // Detecta quem sumiu do mapa — avisa uma vez e tira o card da tela
  // (se ele reconectar depois, volta como um novo card, sem ficar preso mostrando timer).
  for (const [id, cs] of courierMap) {
    if (!seenIds.has(id)) {
      // O card sai da tela, então a última posição dele vai junto do alerta —
      // é o único rastro de onde ele estava quando o GPS parou de responder.
      const temPosicao = Number.isFinite(cs.lat) && Number.isFinite(cs.lng);
      const posicao = temPosicao ? { lat: cs.lat, lng: cs.lng, seenAt: cs.lastSeen } : {};
      appendLog({
        type: 'status_change', courierName: cs.name, from: cs.status, to: 'missing',
        ...(temPosicao ? { lat: cs.lat, lng: cs.lng } : {}),
      });
      addAlert('missing', `${cs.name} sumiu do mapa!`, cs.name, {
        ...posicao,
        lastOrderNumber: cs.lastOrderNumber || null,
      });
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

    readyOrdersCount = (orders.pendingOrdersByCompany || [])
      .filter(o => o.status === 'ready').length;

    processTracking(tracking.couriers, orders.ordersByCourier || []);

    const noActiveOrders = ![...courierMap.values()].some(c => c.activeOrderCount > 0);
    const idleNow = isLateNightBRT() && readyOrdersCount === 0 && noActiveOrders;
    if (idleNow && !shiftIdle) {
      addAlert('shiftEnd', 'Expediente encerrado — sem pedidos pendentes.');
    }
    shiftIdle = idleNow;

    lastUpdated = Date.now();
    sessionOk   = true;
    saveState();
  } catch (e) {
    const wasOk = sessionOk;
    sessionOk = false;
    console.error('[POLL]', e.message);

    // Avisa por push quando a sessão do Foody cai, pra não depender de alguém
    // abrir o site pra descobrir que o cookie expirou.
    const now = Date.now();
    if (wasOk || now - lastCookieAlertAt > 30 * 60 * 1000) {
      lastCookieAlertAt = now;
      addAlert('cookie', 'Cookie do Foody expirou ou sessão caiu — abra o monitor e atualize o cookie nas Configurações!');
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

function buildStatePayload() {
  return {
    configured:       !!config.cookie,
    sessionOk,
    lastUpdated,
    readyOrdersCount,
    shiftIdle,
    alertMinutes:     config.alertMinutes,
    lateMarginMinutes: config.lateMarginMinutes,
    couriers:         [...courierMap.values()],
    alerts:           activeAlerts,
    serverStartedAt:  SERVER_STARTED_AT,
    orderStatusesSeen: [...seenOrderStatuses],
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

app.get('/config', (req, res) => {
  res.json({ configured: !!config.cookie, usingEnv: !!process.env.FOODY_COOKIE });
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
    allowedIps:        config.allowedIps || [],
    pollIntervalMs:    config.pollIntervalMs || 10000,
    noCollectMinutes:  config.noCollectMinutes,
    noDispatchMinutes: config.noDispatchMinutes,
    promiseMinutes:    config.promiseMinutes,
    lateMarginMinutes: config.lateMarginMinutes,
    orderStatus:       config.orderStatus,
    msgTemplates:      config.msgTemplates,
    statusesSeen:      [...seenOrderStatuses],
    orderFieldsSeen,
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
  for (const k of ['noCollectMinutes', 'noDispatchMinutes', 'promiseMinutes', 'lateMarginMinutes']) {
    if (req.body[k] != null) config[k] = Math.max(1, parseInt(req.body[k]) || config[k]);
  }
  if (req.body.orderStatus) {
    const b = req.body.orderStatus;
    for (const fase of ['waiting', 'collected', 'onRoute']) {
      if (!Array.isArray(b[fase])) continue;
      const lista = b[fase].map(x => String(x).trim()).filter(Boolean);
      // 'waiting' pode ficar vazio (desliga o alerta de coleta). As outras duas não:
      // é delas que sai o "está com pedido na mão", que o resto do monitor usa.
      if (lista.length || fase === 'waiting') config.orderStatus[fase] = lista;
    }
  }
  if (req.body.msgTemplates) {
    for (const k of ['notCollected', 'noDispatch', 'late']) {
      if (typeof req.body.msgTemplates[k] === 'string' && req.body.msgTemplates[k].trim()) {
        config.msgTemplates[k] = req.body.msgTemplates[k].trim();
      }
    }
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
    const dates = fs.readdirSync(LOGS_DIR)
      .filter(f => f.endsWith('.json'))
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
