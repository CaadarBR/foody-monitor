const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);

// ── Config ────────────────────────────────────────────────────────────────────

let config = { cookie: '', alertMinutes: 15 };

function loadConfig() {
  try {
    const saved = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
    if (saved.cookie) config.cookie = saved.cookie;
    if (saved.alertMinutes) config.alertMinutes = saved.alertMinutes;
  } catch (e) {}
  if (process.env.FOODY_COOKIE) config.cookie = process.env.FOODY_COOKIE;
}

function saveConfig() {
  const toSave = { ...config };
  if (process.env.FOODY_COOKIE) delete toSave.cookie;
  try { fs.writeFileSync('./config.json', JSON.stringify(toSave, null, 2)); } catch (e) {}
}

loadConfig();

// ── Logs ──────────────────────────────────────────────────────────────────────

function operationalDate() {
  const now = new Date();
  if (now.getHours() < 5) now.setDate(now.getDate() - 1);
  return now.toISOString().slice(0, 10);
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
  const r = await fetch(`${url}?_=${Date.now()}`, { headers: foodyHeaders() });
  const text = await r.text();
  return JSON.parse(text); // lança exceção se não for JSON (sessão expirada)
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
    if (raw.opDate !== operationalDate()) return; // turno diferente, descarta
    for (const [id, cs] of raw.couriers) courierMap.set(id, cs);
    activeAlerts     = raw.activeAlerts     || [];
    readyOrdersCount = raw.readyOrdersCount || 0;
    console.log(`[INFO] Estado restaurado: ${courierMap.size} entregadores, ${activeAlerts.length} alertas.`);
  } catch (e) {}
}

loadState();

function addAlert(type, msg) {
  activeAlerts.unshift({ id: Date.now(), type, msg, time: new Date().toISOString() });
  if (activeAlerts.length > 30) activeAlerts.pop();
  appendLog({ type: 'alert', alertType: type, msg });
  console.log(`[ALERTA] ${msg}`);
}

function processTracking(trackingList, ordersByCourierList) {
  const now     = Date.now();
  const seenIds = new Set(trackingList.map(c => c.courierId));

  const ordersByName = new Map();
  for (const co of ordersByCourierList) {
    ordersByName.set(co.courierName.trim(), co.orders || []);
  }

  for (const tc of trackingList) {
    const id   = tc.courierId;
    const name = tc.courierName.trim();
    const all  = ordersByName.get(name) || [];

    const activeOrders    = all.filter(o => ['onGoing', 'accepted', 'dispatched'].includes(o.status));
    const deliveredOrders = all.filter(o => o.status === 'delivered' && o.deliveryDate);

    let finishedAt = null;
    if (activeOrders.length === 0 && deliveredOrders.length > 0) {
      const raw = Math.max(...deliveredOrders.map(o => new Date(o.deliveryDate).getTime()));
      finishedAt = Math.min(raw, now); // nunca usar timestamp futuro (possível offset de fuso)
    }

    if (!courierMap.has(id)) {
      const status = activeOrders.length > 0 ? 'delivering' : 'available';
      courierMap.set(id, {
        id, name,
        vehicleType: tc.vehicleType,
        lastSeen: now,
        lat: tc.latitute, lng: tc.longitude,
        activeOrderCount: activeOrders.length,
        finishedAt,
        status,
        statusSince: finishedAt || now,
        alerted: false,
      });
      appendLog({ type: 'courier_online', courierName: name, status });
      continue;
    }

    const cs = courierMap.get(id);
    const prev = cs.status;
    cs.lastSeen = now;
    cs.lat = tc.latitute;
    cs.lng = tc.longitude;
    cs.activeOrderCount = activeOrders.length;

    if (cs.status === 'missing') {
      cs.status     = activeOrders.length > 0 ? 'delivering' : 'available';
      cs.statusSince = finishedAt || now;
      cs.finishedAt  = finishedAt;
      cs.alerted    = false;
    } else if (activeOrders.length > 0) {
      if (cs.status !== 'delivering') {
        cs.status     = 'delivering';
        cs.statusSince = now;
        cs.finishedAt  = null;
        cs.alerted    = false;
      }
    } else {
      if (cs.status === 'delivering') {
        cs.finishedAt  = finishedAt || now;
        cs.statusSince = cs.finishedAt;
        cs.alerted    = false;
      }
      if (cs.finishedAt) {
        const elapsed = (now - cs.finishedAt) / 60000;
        if (readyOrdersCount > 0) {
          if (elapsed >= config.alertMinutes) {
            cs.status = 'alert';
            if (!cs.alerted) {
              cs.alerted = true;
              addAlert('slow', `${cs.name} terminou há ${Math.floor(elapsed)}min e tem pedido esperando!`);
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

  // Detecta quem sumiu do mapa
  for (const [id, cs] of courierMap) {
    if (!seenIds.has(id) && cs.status !== 'missing') {
      const prev = cs.status;
      cs.status     = 'missing';
      cs.statusSince = now;
      cs.alerted    = true;
      appendLog({ type: 'status_change', courierName: cs.name, from: prev, to: 'missing' });
      addAlert('missing', `${cs.name} sumiu do mapa!`);
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
      courierMap.clear();
      activeAlerts  = [];
      hasLoggedStart = false;
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
    lastUpdated = Date.now();
    sessionOk   = true;
    saveState();
  } catch (e) {
    sessionOk = false;
    console.error('[POLL]', e.message);
  } finally {
    pollRunning = false;
  }
}

setInterval(doPoll, 30 * 1000);
doPoll();

// ── Rotas HTTP ────────────────────────────────────────────────────────────────

app.get('/api/state', (req, res) => {
  res.json({
    configured:       !!config.cookie,
    sessionOk,
    lastUpdated,
    readyOrdersCount,
    alertMinutes:     config.alertMinutes,
    couriers:         [...courierMap.values()],
    alerts:           activeAlerts,
  });
});

app.post('/api/alerts/dismiss', (req, res) => {
  const { id } = req.body;
  activeAlerts = activeAlerts.filter(a => a.id !== id);
  res.json({ ok: true });
});

app.get('/config', (req, res) => {
  res.json({ configured: !!config.cookie, usingEnv: !!process.env.FOODY_COOKIE });
});

app.post('/config', (req, res) => {
  if (req.body.cookie) {
    config.cookie  = req.body.cookie.trim();
    hasLoggedStart = false;
    sessionOk      = false;
    doPoll();
  }
  if (req.body.alertMinutes) {
    config.alertMinutes = parseInt(req.body.alertMinutes) || 15;
  }
  if (!process.env.FOODY_COOKIE) saveConfig();
  res.json({ ok: true });
});

app.get('/api/log', (req, res) => {
  const date = req.query.date || operationalDate();
  const file = path.join(LOGS_DIR, `${date}.json`);
  try {
    res.json({ date, logs: JSON.parse(fs.readFileSync(file, 'utf8')) });
  } catch (e) {
    res.json({ date, logs: [] });
  }
});

app.get('/api/logs', (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('   Foody Monitor - Varandas Pizzaria');
  console.log('========================================');
  console.log(`\n  Acesse: http://localhost:${PORT}`);
  console.log(`  Cookie: ${config.cookie ? 'configurado ✓' : 'NÃO configurado ✗'}`);
  console.log('  Monitoramento 24/7: ATIVO\n');
});
