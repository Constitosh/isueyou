// server.cjs — $tABS backend (Express / Node 18+)
// - Serves static UI from /public
// - JSON APIs: /api/refresh, /api/snapshot/latest, /api/add-token
//              /api/token-stats/:ca  (GET)
//              /api/token-stats/save (POST)
// - Snapshots & caches persisted under ./data
// - Uses Node 18 global fetch (no extra deps)

const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- Paths & Files ----------
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

const TOKENS_LIB_FILE = path.join(DATA_DIR, 'tokens-lib.json');
const SNAPSHOTS_FILE  = path.join(DATA_DIR, 'snapshots.json');
const TOKEN_STATS_FILE= path.join(DATA_DIR, 'token-stats.json');

// Ensure data dir exists
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- Helpers ----------
function readJSON(file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw?.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    console.error('readJSON error for', file, e.message);
    return fallback;
  }
}
function writeJSON(file, obj) {
  try {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
    fs.renameSync(tmp, file);
    return true;
  } catch (e) {
    console.error('writeJSON error for', file, e.message);
    return false;
  }
}
const sleep = (ms)=> new Promise(r=> setTimeout(r, ms));
const clamp15 = (arr)=> Array.isArray(arr) ? arr.slice(0, 15) : [];

// ---------- Data Model Defaults ----------
function ensureTokensLib() {
  const lib = readJSON(TOKENS_LIB_FILE, null) || { tokens: [], tokenPairs: {}, pairsKnown: [] };
  if (!Array.isArray(lib.tokens)) lib.tokens = [];
  if (!lib.tokenPairs || typeof lib.tokenPairs !== 'object') lib.tokenPairs = {};
  if (!Array.isArray(lib.pairsKnown)) lib.pairsKnown = [];
  return lib;
}
function ensureSnapshots() {
  const s = readJSON(SNAPSHOTS_FILE, null) || { latest: null, history: [] };
  if (!Array.isArray(s.history)) s.history = [];
  return s;
}
function ensureTokenStatsFile() {
  const m = readJSON(TOKEN_STATS_FILE, null) || { byCA: {} };
  if (!m.byCA || typeof m.byCA !== 'object') m.byCA = {};
  return m;
}

// ---------- Dexscreener Helpers ----------
async function fetchTokenAbstract(ca) {
  // https://api.dexscreener.com/tokens/v1/abstract/{CSV}
  const url = `https://api.dexscreener.com/tokens/v1/abstract/${ca}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dexscreener token abstract HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) throw new Error('Token not found');
  return arr[0];
}
async function fetchPairsAbstract(pairCA) {
  // https://api.dexscreener.com/latest/dex/pairs/abstract/{PAIR_CA}
  const url = `https://api.dexscreener.com/latest/dex/pairs/abstract/${pairCA}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dexscreener pair abstract HTTP ${res.status}`);
  const obj = await res.json();
  // returns { pairAddress, volume: { h24: ... }, ... } or an array; normalize:
  if (Array.isArray(obj)) return obj[0] || null;
  return obj;
}
async function sumVolume24hForToken(ca, tokenPairsMap) {
  // Prefer aggregating all known pairs if present; otherwise fallback to token overview vol.h24
  const knownPairs = tokenPairsMap?.[ca.toLowerCase()] || [];
  let total = 0;
  if (knownPairs.length) {
    for (const pair of knownPairs) {
      try {
        const p = await fetchPairsAbstract(pair);
        const v = Number(p?.volume?.h24 || 0);
        if (isFinite(v)) total += v;
      } catch {}
      await sleep(60);
    }
    return total;
  }
  // fallback
  try {
    const t = await fetchTokenAbstract(ca);
    return Number(t?.volume?.h24 || 0);
  } catch {
    return 0;
  }
}
function makeRowFromTokenAbstract(t, ca, volume24h) {
  return {
    baseAddress: (t?.baseToken?.address || ca || '').toLowerCase(),
    name: t?.baseToken?.name || '',
    symbol: t?.baseToken?.symbol || '',
    priceChange: {
      m5: Number(t?.priceChange?.m5 ?? null),
      h1: Number(t?.priceChange?.h1 ?? null),
      h6: Number(t?.priceChange?.h6 ?? null),
      h24: Number(t?.priceChange?.h24 ?? null)
    },
    marketCap: t?.marketCap != null ? Number(t.marketCap) : null,
    fdv: t?.fdv != null ? Number(t.fdv) : null,
    volume24h: Number(volume24h || 0),
    url: t?.url || null
  };
}

// ---------- Snapshot Builder ----------
async function buildSnapshot() {
  const tokensLib = ensureTokensLib();
  const tokens = tokensLib.tokens || [];
  const tokenPairsMap = tokensLib.tokenPairs || {};

  const rows = [];
  for (const ca of tokens) {
    try {
      const t = await fetchTokenAbstract(ca);
      const vol24 = await sumVolume24hForToken(ca, tokenPairsMap);
      rows.push(makeRowFromTokenAbstract(t, ca, vol24));
    } catch (e) {
      console.warn('Token fetch failed:', ca, e.message);
    }
    await sleep(80);
  }

  // Compute top lists
  const topGainers = [...rows].sort((a,b) => (Number(b.priceChange?.h24||0) - Number(a.priceChange?.h24||0)));
  const topVol     = [...rows].sort((a,b) => (Number(b.volume24h||0) - Number(a.volume24h||0)));

  // Banner — simplest aggregate
  const volSum = rows.reduce((s,r)=> s + (Number(r.volume24h)||0), 0);
  const capAny = rows.find(r=> Number.isFinite(r.fdv))?.fdv ?? rows.find(r=> Number.isFinite(r.marketCap))?.marketCap ?? 0;

  const snapshot = {
    ts: Date.now(),
    chain: 'abstract',
    banner: {
      holders: null,         // filled on client for special CA via abs-tabs-integration.js
      fdv: Number.isFinite(capAny) ? Number(capAny) : null,
      marketCap: null,
      vol24: volSum,
      chg24: 0,
      url: 'https://dexscreener.com/abstract'
    },
    topGainers: clamp15(topGainers),
    topVol:     clamp15(topVol),
    tokensTracked: tokens.length
  };

  // Persist last 5 snapshots (global)
  const S = ensureSnapshots();
  S.latest = snapshot;
  S.history.unshift(snapshot);
  S.history = S.history.slice(0, 5);
  writeJSON(SNAPSHOTS_FILE, S);

  return snapshot;
}

// ---------- Scan lock + Scheduler ----------
let isScanning = false;
async function runScan() {
  if (isScanning) {
    const S = ensureSnapshots();
    return S.latest || null;
  }
  isScanning = true;
  try {
    return await buildSnapshot();
  } finally {
    isScanning = false;
  }
}

// ---------- API: Snapshot ----------
app.post('/api/refresh', async (req, res) => {
  try {
    const snap = await runScan();
    res.json({ ok: true, snapshot: snap });
  } catch (e) {
    console.error('/api/refresh error:', e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

app.get('/api/snapshot/latest', (req, res) => {
  try {
    const S = ensureSnapshots();
    res.json({ ok: true, snapshot: S.latest || null });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
});

// ---------- API: Add token ----------
app.post('/api/add-token', async (req, res) => {
  const caRaw = (req.body?.ca || '').trim();
  const isCA = /^0x[a-fA-F0-9]{40}$/.test(caRaw);
  if (!isCA) return res.status(400).json({ ok:false, error:'Invalid contract address' });
  const ca = caRaw.toLowerCase();

  try {
    const t = await fetchTokenAbstract(ca);
    const lib = ensureTokensLib();
    if (!lib.tokens.includes(ca)) lib.tokens.push(ca);

    // Try to grow tokenPairs map from latest Dexscreener discovery (best-effort)
    // NOTE: if your discovery job already fills tokenPairs, we keep it.
    if (!Array.isArray(lib.tokenPairs[ca])) lib.tokenPairs[ca] = [];

    const vol24 = await sumVolume24hForToken(ca, lib.tokenPairs);
    const row = makeRowFromTokenAbstract(t, ca, vol24);

    // Save lib & update snapshots latest row history (lightweight)
    writeJSON(TOKENS_LIB_FILE, lib);

    res.json({ ok:true, row, tokensTracked: lib.tokens.length });
  } catch (e) {
    console.error('/api/add-token error:', ca, e.message);
    res.status(500).json({ ok:false, error:e.message || String(e) });
  }
});

// ---------- API: Token deep-scan cache (abs-tabs-integration.js) ----------
app.get('/api/token-stats/:ca', (req, res) => {
  const ca = (req.params.ca || '').toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(ca)) return res.status(400).json({ ok:false, error:'bad ca' });
  const m = ensureTokenStatsFile();
  const rec = m.byCA[ca];
  if (!rec) return res.json({ ok:false, error:'not found' });
  res.json({ ok:true, ts: rec.ts, data: rec.data });
});

app.post('/api/token-stats/save', (req, res) => {
  const ca = (req.body?.ca || '').toLowerCase();
  const data = req.body?.data;
  if (!/^0x[0-9a-f]{40}$/.test(ca)) return res.status(400).json({ ok:false, error:'bad ca' });
  if (!data || typeof data !== 'object') return res.status(400).json({ ok:false, error:'bad data' });

  const m = ensureTokenStatsFile();
  const ts = Date.now();
  m.byCA[ca] = { ts, data };
  const ok = writeJSON(TOKEN_STATS_FILE, m);
  if (!ok) return res.status(500).json({ ok:false, error:'persist failed' });
  res.json({ ok:true, ts });
});

// ---------- Static ----------
app.use(express.static(PUBLIC_DIR, {
  extensions: ['html'],
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store');
  }
}));
console.log('Serving static from:', PUBLIC_DIR);

// Fallback to index.html (SPA-ish)
app.get('*', (req, res, next) => {
  // Only fall back for non-API requests
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------- Boot ----------
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

process.on('unhandledRejection', (err) => {
  console.error('UNHANDLED REJECTION:', err);
});
process.on('uncaughtException', (err) => {
  console.error('UNCAUGHT EXCEPTION:', err);
});

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT} (env PORT=${process.env.PORT || 'unset'})`);
});
