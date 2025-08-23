// server.cjs — $tABS backend (Express / Node 18+)
// Persists: data/tokens-lib.json, data/snapshots.json, data/token-stats.json

const path = require('path');
const fs = require('fs');
const express = require('express');

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- Paths ----------
const ROOT = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const PUBLIC_DIR = path.join(ROOT, 'public');

const TOKENS_LIB_FILE = path.join(DATA_DIR, 'tokens-lib.json');
const SNAPSHOTS_FILE  = path.join(DATA_DIR, 'snapshots.json');
const TOKEN_STATS_FILE= path.join(DATA_DIR, 'token-stats.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- JSON helpers ----------
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

// ---------- Data defaults ----------
function ensureTokensLib() {
  const lib = readJSON(TOKENS_LIB_FILE, null) || { tokens: [], tokenPairs: {} };
  if (!Array.isArray(lib.tokens)) lib.tokens = [];
  if (!lib.tokenPairs || typeof lib.tokenPairs !== 'object') lib.tokenPairs = {};
  // normalize lowercase
  lib.tokens = Array.from(new Set(lib.tokens.map(x=> String(x).toLowerCase())));
  const fixed = {};
  for (const [k,v] of Object.entries(lib.tokenPairs)) {
    const key = k.toLowerCase();
    const list = Array.isArray(v) ? v : [];
    fixed[key] = Array.from(new Set(list.map(p=>String(p).toLowerCase())));
  }
  lib.tokenPairs = fixed;
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

// ---------- Dexscreener helpers ----------
async function fetchTokenAbstract(ca) {
  const url = `https://api.dexscreener.com/tokens/v1/abstract/${ca}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dexscreener token abstract HTTP ${res.status}`);
  const arr = await res.json();
  if (!Array.isArray(arr) || !arr.length) throw new Error('Token not found');
  return arr[0];
}

// Search: discover all pairs for a token CA (and get their 24h vols in one go)
async function searchPairsForToken(ca) {
  const url = `https://api.dexscreener.com/latest/dex/search?q=${ca}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Dexscreener search HTTP ${res.status}`);
  const j = await res.json();
  const pairs = Array.isArray(j?.pairs) ? j.pairs : (Array.isArray(j) ? j : []);
  // only base token matches
  const filtered = pairs.filter(p => (p?.baseToken?.address || '').toLowerCase() === ca.toLowerCase());
  const pairAddrs = filtered
    .map(p => String(p?.pairAddress || '').toLowerCase())
    .filter(a => /^0x[0-9a-f]{40}$/.test(a));
  const volSum = filtered.reduce((s,p)=> s + (Number(p?.volume?.h24 || 0) || 0), 0);
  return { pairAddrs: Array.from(new Set(pairAddrs)), vol24: volSum };
}

// Aggregate 24h volume across pairs; updates tokens-lib tokenPairs when possible
async function sumVolume24hForToken(ca, tokensLib) {
  const key = ca.toLowerCase();
  const known = tokensLib.tokenPairs[key] || [];
  try {
    // Fresh discovery every time we build a snapshot (keeps volumes accurate)
    const { pairAddrs, vol24 } = await searchPairsForToken(key);
    if (pairAddrs.length) {
      // merge & persist discovered pairs
      const merged = Array.from(new Set([ ...known, ...pairAddrs ]));
      tokensLib.tokenPairs[key] = merged;
      writeJSON(TOKENS_LIB_FILE, tokensLib);
      return vol24;
    }
  } catch (e) {
    console.warn('searchPairsForToken failed:', key, e.message);
  }

  // Fallback to token abstract volume if search returns nothing
  try {
    const t = await fetchTokenAbstract(key);
    return Number(t?.volume?.h24 || 0);
  } catch {
    return 0;
  }
}

function makeRowFromTokenAbstract(t, ca, volume24h) {
  // Market Cap fallback to FDV if marketCap is missing (for UI column)
  const mcFallback = (t?.marketCap != null ? Number(t.marketCap) : null);
  const fdvNum = (t?.fdv != null ? Number(t.fdv) : null);
  const mcForRow = (mcFallback != null ? mcFallback : (fdvNum != null ? fdvNum : null));

  return {
    baseAddress: (t?.baseToken?.address || ca || '').toLowerCase(),
    name: t?.baseToken?.name || '',
    symbol: t?.baseToken?.symbol || '',
    priceChange: {
      m5: t?.priceChange?.m5 != null ? Number(t.priceChange.m5) : null,
      h1: t?.priceChange?.h1 != null ? Number(t.priceChange.h1) : null,
      h6: t?.priceChange?.h6 != null ? Number(t.priceChange.h6) : null,
      h24: t?.priceChange?.h24 != null ? Number(t.priceChange.h24) : null
    },
    marketCap: mcForRow,           // <<— table uses this (FDV fallback applied)
    fdv: fdvNum,                   // still keep raw fdv for header logic
    volume24h: Number(volume24h || 0),
    url: t?.url || null
  };
}

// ---------- Snapshot Builder ----------
async function buildSnapshot() {
  const tokensLib = ensureTokensLib();
  const tokens = tokensLib.tokens || [];

  const rows = [];
  for (const ca of tokens) {
    try {
      const t = await fetchTokenAbstract(ca);
      const vol24 = await sumVolume24hForToken(ca, tokensLib); // also updates tokenPairs in lib
      rows.push(makeRowFromTokenAbstract(t, ca, vol24));
    } catch (e) {
      console.warn('Token fetch failed:', ca, e.message);
    }
    await sleep(60);
  }

  const topGainers = [...rows].sort((a,b)=> (Number(b.priceChange?.h24||0) - Number(a.priceChange?.h24||0)));
  const topVol     = [...rows].sort((a,b)=> (Number(b.volume24h||0) - Number(a.volume24h||0)));

  const volSum = rows.reduce((s,r)=> s + (Number(r.volume24h)||0), 0);
  // Header "Market Cap" shows FDV as fallback if marketCap missing
  const capAny = (rows.find(r=> Number.isFinite(r.marketCap))?.marketCap)
              ?? (rows.find(r=> Number.isFinite(r.fdv))?.fdv)
              ?? 0;

  const snapshot = {
    ts: Date.now(),
    chain: 'abstract',
    banner: {
      holders: null,
      fdv: Number.isFinite(capAny) ? Number(capAny) : null, // used by header "Market Cap"
      marketCap: null,
      vol24: volSum,
      chg24: 0,
      url: 'https://dexscreener.com/abstract'
    },
    topGainers: clamp15(topGainers),
    topVol:     clamp15(topVol),
    tokensTracked: tokens.length
  };

  const S = ensureSnapshots();
  S.latest = snapshot;
  S.history.unshift(snapshot);
  S.history = S.history.slice(0, 5);
  writeJSON(SNAPSHOTS_FILE, S);

  return snapshot;
}

// ---------- Scan lock ----------
let isScanning = false;
async function runScan() {
  if (isScanning) return ensureSnapshots().latest || null;
  isScanning = true;
  try { return await buildSnapshot(); }
  finally { isScanning = false; }
}

// ---------- APIs ----------
app.post('/api/refresh', async (req, res) => {
  try {
    const snap = await runScan();
    res.json({ ok: true, snapshot: snap });
  } catch (e) {
    console.error('/api/refresh error:', e);
    res.status(500).json({ ok:false, error: e.message || String(e) });
  }
});

app.get('/api/snapshot/latest', (req, res) => {
  try {
    const S = ensureSnapshots();
    res.json({ ok: true, snapshot: S.latest || null });
  } catch (e) {
    res.status(500).json({ ok:false, error: e.message || String(e) });
  }
});

// Add a token to library + discover pairs + return computed row
app.post('/api/add-token', async (req, res) => {
  const caRaw = (req.body?.ca || '').trim();
  const isCA = /^0x[a-fA-F0-9]{40}$/.test(caRaw);
  if (!isCA) return res.status(400).json({ ok:false, error:'Invalid contract address' });
  const ca = caRaw.toLowerCase();

  try {
    const lib = ensureTokensLib();
    if (!lib.tokens.includes(ca)) lib.tokens.push(ca);

    // Discover / update pairs and compute aggregated 24h vol
    const vol24 = await sumVolume24hForToken(ca, lib); // also persists pairs to tokens-lib.json

    const t = await fetchTokenAbstract(ca);
    const row = makeRowFromTokenAbstract(t, ca, vol24);

    // Persist tokens-lib (tokens list may have changed)
    writeJSON(TOKENS_LIB_FILE, lib);

    res.json({ ok:true, row, tokensTracked: lib.tokens.length });
  } catch (e) {
    console.error('/api/add-token error:', ca, e.message);
    res.status(500).json({ ok:false, error:e.message || String(e) });
  }
});

// Deep-scan cache used by abs-tabs-integration.js
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
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-store')
}));
console.log('Serving static from:', PUBLIC_DIR);

// SPA fallback
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
});

// ---------- Boot ----------
const PORT = process.env.PORT || 8080;
const HOST = process.env.HOST || '0.0.0.0';

process.on('unhandledRejection', (err)=> console.error('UNHANDLED REJECTION:', err));
process.on('uncaughtException',  (err)=> console.error('UNCAUGHT EXCEPTION:', err));

app.listen(PORT, HOST, () => {
  console.log(`Server running at http://${HOST}:${PORT} (env PORT=${process.env.PORT || 'unset'})`);
});
