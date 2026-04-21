const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const LOGS_DIR = path.join(__dirname, 'logs');
if (!fs.existsSync(LOGS_DIR)) fs.mkdirSync(LOGS_DIR);

let cookieString = '';

try {
  const cfg = JSON.parse(fs.readFileSync('./config.json', 'utf8'));
  if (cfg.cookie) cookieString = cfg.cookie;
} catch (e) {}

// Turnos começam às 18h e podem ir até ~06h do dia seguinte
function operationalDate() {
  const now = new Date();
  if (now.getHours() < 6) now.setDate(now.getDate() - 1);
  return now.toISOString().slice(0, 10);
}

app.get('/config', (req, res) => {
  res.json({ configured: cookieString.length > 0 });
});

app.post('/config', (req, res) => {
  if (req.body.cookie) {
    cookieString = req.body.cookie.trim();
    fs.writeFileSync('./config.json', JSON.stringify({ cookie: cookieString }, null, 2));
  }
  res.json({ ok: true });
});

// ── Logs ────────────────────────────────────────────────────────────────────

app.post('/api/log', (req, res) => {
  const entry = req.body;
  if (!entry || !entry.type) return res.json({ ok: false });
  const date = operationalDate();
  const file = path.join(LOGS_DIR, `${date}.json`);
  let logs = [];
  try { logs = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  logs.push(entry);
  fs.writeFileSync(file, JSON.stringify(logs, null, 2));
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

// ── Foody proxy ──────────────────────────────────────────────────────────────

function foodyHeaders() {
  return {
    'accept': '*/*',
    'accept-language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
    'cache-control': 'no-cache',
    'pragma': 'no-cache',
    'referer': 'https://app.foodydelivery.com/u/0/home',
    'x-requested-with': 'XMLHttpRequest',
    'cookie': cookieString,
    'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36',
  };
}

async function foodyGet(endpoint, res) {
  if (!cookieString) {
    return res.status(401).json({ error: 'sem_sessao' });
  }
  try {
    const r = await fetch(
      `https://app.foodydelivery.com/api/home-data/${endpoint}?_=${Date.now()}`,
      { headers: foodyHeaders() }
    );
    const text = await r.text();
    try {
      res.json(JSON.parse(text));
    } catch {
      res.status(401).json({ error: 'sessao_expirada', raw: text.slice(0, 100) });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.get('/api/tracking', (req, res) => foodyGet('couriers-for-tracking', res));
app.get('/api/despatching', (req, res) => foodyGet('couriers-for-despatching', res));

app.get('/api/orders', async (req, res) => {
  if (!cookieString) return res.status(401).json({ error: 'sem_sessao' });
  try {
    const r = await fetch(
      `https://app.foodydelivery.com/api/order/listbycourier?_=${Date.now()}`,
      { headers: foodyHeaders() }
    );
    const text = await r.text();
    try { res.json(JSON.parse(text)); }
    catch { res.status(401).json({ error: 'sessao_expirada', raw: text.slice(0, 100) }); }
  } catch (e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('\n========================================');
  console.log('   Foody Monitor - Varandas Pizzaria');
  console.log('========================================');
  console.log(`\n  Acesse: http://localhost:${PORT}`);
  console.log('\n  Pressione Ctrl+C para parar.\n');
});
