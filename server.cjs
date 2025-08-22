/* server.cjs
 * $tABS backend — Node 18 + Express (CommonJS)
 * - Serves static UI from project root
 * - Persists: data/tokens-lib.json, data/snapshots.json, data/token-stats.json
 * - JSON APIs as specified in the project brief
 */

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const express = require('express');

const app = express();
const PUBLIC_DIR = path.join(__dirname, "public");
console.log("Serving static from:", PUBLIC_DIR);

app.use(express.json({ limit: '2mb' }));
app.use(express.static('PUBLIC_DIR'));

// ------------------------------- Paths & helpers
const PORT = process.env.PORT || 8080;
const DATA_DIR = path.join(__dirname, 'data');
const FILE_TOKENS = path.join(DATA_DIR, 'tokens-lib.json');
const FILE_SNAPSHOTS = path.join(DATA_DIR, 'snapshots.json');
const FILE_TOKEN_STATS = path.join(DATA_DIR, 'token-stats.json');

// Ensure data directory + files exist
async function ensureDataFiles() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  const defaults = [
    [FILE_TOKENS, { tokens: [], pairs: {}, tokenPairs: {} }],
    [FILE_SNAPSHOTS, { latest: null, history: [] }],
    [FILE_TOKEN_STATS, { /* caLower: { ts, data } */ }],
  ];
  for (const [file, def] of defaults) {
    try { await fsp.access(file); }
    catch { await fsp.writeFile(file, JSON.stringify(def, null, 2)); }
  }
}

async function readJson(file, fallback) {
  try {
    const raw = await fsp.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}
async function writeJson(file, obj) {
  await fsp.writeFile(file, JSON.stringify(obj, null, 2));
}

// Number helpers
const fmt2 = (n) => Math.round(n * 100) / 100;

// ------------------------------- Dexscreener helpers
const DEX = {
  tokenInfo: (csvCas) => `https://api.dexscreener.com/tokens/v1/abstract/${csvCas}`,
  tokenPairs: (tokenCa) => `https://api.dexscreener.com/token-pairs/v1/abstract/${tokenCa}`,
  pairInfo: (pairCa) => `https://api.dexscreener.com/latest/dex/pairs/abstract/${pairCa}`,
  search: (q) => `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`,
  latestProfiles: () => `https://api.dexscreener.com/token-profiles/latest/v1`,
};

// fetch (Node18 global)
async function httpJson(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

function isCA(s) {
  return /^0x[a-fA-F0-9]{40}$/.test(String(s || '').trim());
}

// ------------------------------- Core computations
/**
 * Build a TokenRow for a single token from token info + aggregated volume across pairs
 */
async function buildTokenRow(tokenCa) {
  const ca = tokenCa.toLowerCase();

  // Per-token info
  const infoArr = await httpJson(DEX.tokenInfo(ca));
  const info = Array.isArray(infoArr) && infoArr.length ? infoArr[0] : null;
  if (!info) {
    return null;
  }

  // Aggregate 24h volume across all pairs for the token
  // Prefer tokenPairs endpoint (fast) with fallback to search if empty
  let pairs = [];
  try {
    const pr = await httpJson(DEX.tokenPairs(ca));
    if (Array.isArray(pr)) {
      pairs = pr;
    }
  } catch {
    // ignore
  }

  if (!pairs.length) {
    try {
      const s = await httpJson(DEX.search(ca));
      if (Array.isArray(s?.pairs)) {
        pairs = s.pairs.filter(p =>
          (p.baseToken?.address || '').toLowerCase() === ca.toLowerCase()
        );
      }
    } catch {
      // ignore
    }
  }

  let vol24 = 0;
  if (pairs.length) {
    for (const p of pairs) {
      const v = Number(p?.volume?.h24 || p?.volume24h || 0);
      if (isFinite(v)) vol24 += v;
    }
  }

  const row = {
    baseAddress: ca,
    name: info?.baseToken?.name || info?.info?.name || '—',
    symbol: info?.baseToken?.symbol || info?.info?.symbol || '',
    priceChange: {
      m5: Number(info?.priceChange?.m5 ?? null),
      h1: Number(info?.priceChange?.h1 ?? null),
      h6: Number(info?.priceChange?.h6 ?? null),
      h24: Number(info?.priceChange?.h24 ?? null),
    },
    marketCap: Number(info?.marketCap ?? null) || null,
    fdv: Number(info?.fdv ?? null) || null,
    volume24h: vol24,
    url: info?.url || null,
  };
  return row;
}

/**
 * Full runScan: compute banner + top gainers + top volume
 * banner fields: fdv (fallback to market cap), vol24, chg24, url
 */
async function runScan(tokensLib) {
  const tokens = tokensLib.tokens || [];
  if (!tokens.length) {
    return {
      ts: Date.now(),
      chain: 'abstract',
      banner: { holders: null, fdv: 0, marketCap: 0, vol24: 0, chg24: 0, url: 'https://dexscreener.com' },
      topGainers: [],
      topVol: [],
      tokensTracked: 0,
    };
  }

  // Fetch token rows in small parallel batches
  const BATCH = 8;
  const rows = [];
  for (let i = 0; i < tokens.length; i += BATCH) {
    const slice = tokens.slice(i, i + BATCH);
    const part = await Promise.all(slice.map(async (ca) => {
      try { return await buildTokenRow(ca); } catch { return null; }
    }));
    rows.push(...part.filter(Boolean));
  }

  // Compute banner from “$tABS” if present, else from summary
  let banner = {
    holders: null,
    fdv: 0,
    marketCap: 0,
    vol24: 0,
    chg24: 0,
    url: 'https://dexscreener.com',
  };

  // Try to find SPECIAL token in current list to feed banner
  const SPECIAL = '0x8c3d850313eb9621605cd6a1acb2830962426f67';
  const rowSpecial = rows.find(r => r.baseAddress.toLowerCase() === SPECIAL);
  if (rowSpecial) {
    banner.fdv = Number.isFinite(rowSpecial.fdv) && rowSpecial.fdv ? rowSpecial.fdv : (rowSpecial.marketCap || 0);
    banner.marketCap = rowSpecial.marketCap || 0;
    banner.vol24 = rowSpecial.volume24h || 0;
    banner.chg24 = Number(rowSpecial?.priceChange?.h24 || 0);
    banner.url = rowSpecial.url || banner.url;
  } else {
    // Otherwise aggregate a simple banner
    banner.vol24 = rows.reduce((s, r) => s + (r.volume24h || 0), 0);
    // pick a largest mcap row
    const mcapRow = rows.slice().sort((a, b) => (b.marketCap || 0) - (a.marketCap || 0))[0];
    if (mcapRow) {
      banner.fdv = Number.isFinite(mcapRow.fdv) && mcapRow.fdv ? mcapRow.fdv : (mcapRow.marketCap || 0);
      banner.marketCap = mcapRow.marketCap || 0;
      banner.chg24 = Number(mcapRow?.priceChange?.h24 || 0);
      banner.url = mcapRow.url || banner.url;
    }
  }

  // Sorters
  const gainers = rows
    .slice()
    .sort((a, b) => (Number(b?.priceChange?.h24 || 0) - Number(a?.priceChange?.h24 || 0)))
    .slice(0, 15);

  const topVol = rows
    .slice()
    .sort((a, b) => (Number(b?.volume24h || 0) - Number(a?.volume24h || 0)))
    .slice(0, 15);

  return {
    ts: Date.now(),
    chain: 'abstract',
    banner,
    topGainers: gainers,
    topVol,
    tokensTracked: tokens.length,
  };
}

/**
 * Discover pairs for a token and update the library
 */
async function discoverPairsForToken(tokensLib, tokenCa) {
  const ca = tokenCa.toLowerCase();
  if (!tokensLib.tokenPairs) tokensLib.tokenPairs = {};
  if (!tokensLib.pairs) tokensLib.pairs = {};

  let knownPairs = tokensLib.tokenPairs[ca] || [];

  // Use dex search to pull pairs
  try {
    const s = await httpJson(DEX.search(ca));
    const pairs = Array.isArray(s?.pairs) ? s.pairs : [];
    const relevant = pairs.filter(p => (p.baseToken?.address || '').toLowerCase() === ca);
    const pairAddrs = relevant
      .map(p => String(p.pairAddress || '').toLowerCase())
      .filter(p => /^0x[a-f0-9]{40}(:\w+)?$/.test(p))
      .map(p => (p.includes(':') ? p.split(':')[0] : p)); // strip chain prefix if any
    knownPairs = Array.from(new Set(knownPairs.concat(pairAddrs)));
  } catch {
    // ignore
  }

  tokensLib.tokenPairs[ca] = knownPairs;
  await writeJson(FILE_TOKENS, tokensLib);
  return knownPairs;
}

// ------------------------------- Schedulers
let scanning = false;

async function saveSnapshot(snapshotsObj, snapshot) {
  snapshotsObj.latest = snapshot;
  const hist = Array.isArray(snapshotsObj.history) ? snapshotsObj.history : [];
  hist.unshift({ ts: snapshot.ts, banner: snapshot.banner });
  while (hist.length > 5) hist.pop();
  snapshotsObj.history = hist;
  await writeJson(FILE_SNAPSHOTS, snapshotsObj);
}

async function doFullScan() {
  if (scanning) return null;
  scanning = true;
  try {
    await ensureDataFiles();
    const tokensLib = await readJson(FILE_TOKENS, { tokens: [], pairs: {}, tokenPairs: {} });
    const snapshot = await runScan(tokensLib);
    const snapshotsObj = await readJson(FILE_SNAPSHOTS, { latest: null, history: [] });
    await saveSnapshot(snapshotsObj, snapshot);
    return snapshot;
  } catch (e) {
    console.error('runScan failed:', e.message || e);
    return null;
  } finally {
    scanning = false;
  }
}

async function discoverNewProfiles() {
  try {
    await ensureDataFiles();
    const lib = await readJson(FILE_TOKENS, { tokens: [], pairs: {}, tokenPairs: {} });
    const tokensSet = new Set((lib.tokens || []).map(s => s.toLowerCase()));

    const latest = await httpJson(DEX.latestProfiles()).catch(() => null);
    const arr = Array.isArray(latest) ? latest : (Array.isArray(latest?.profiles) ? latest.profiles : []);
    let added = 0;
    for (const p of arr) {
      const ca = String(p?.address || p?.tokenAddress || '').toLowerCase();
      if (isCA(ca) && !tokensSet.has(ca)) {
        tokensSet.add(ca);
        added++;
      }
    }
    if (added > 0) {
      lib.tokens = Array.from(tokensSet);
      await writeJson(FILE_TOKENS, lib);
    }
  } catch (e) {
    // soft fail
  }
}

// Start timers after server is up
function startSchedulers() {
  // every 15 minutes — full scan
  setInterval(doFullScan, 15 * 60 * 1000);
  // every 5 minutes — discovery
  setInterval(discoverNewProfiles, 5 * 60 * 1000);
}

// ------------------------------- Routes: static
app.use(express.static(path.join(__dirname)));

// ------------------------------- Routes: API
app.post('/api/refresh', async (req, res) => {
  const snap = await doFullScan();
  if (!snap) return res.json({ ok: false, error: 'scan_failed' });
  return res.json({ ok: true, snapshot: snap });
});

app.get('/api/snapshot/latest', async (req, res) => {
  await ensureDataFiles();
  const snapshots = await readJson(FILE_SNAPSHOTS, { latest: null, history: [] });
  if (!snapshots.latest) {
    // run a lazy scan if nothing exists yet
    const snap = await doFullScan();
    if (!snap) return res.json({ snapshot: null });
    return res.json({ snapshot: snap });
  }
  return res.json({ snapshot: snapshots.latest });
});

app.post('/api/add-token', async (req, res) => {
  try {
    await ensureDataFiles();
    const { ca } = req.body || {};
    if (!isCA(ca)) return res.status(400).json({ ok: false, error: 'invalid_ca' });

    const lib = await readJson(FILE_TOKENS, { tokens: [], pairs: {}, tokenPairs: {} });
    const target = ca.toLowerCase();
    if (!lib.tokens.map(s => s.toLowerCase()).includes(target)) {
      lib.tokens.push(target);
      await writeJson(FILE_TOKENS, lib);
    }

    // discover pairs (stored in tokens-lib.json)
    await discoverPairsForToken(lib, target);

    // compute a TokenRow for immediate display
    const row = await buildTokenRow(target);
    if (!row) return res.json({ ok: false, error: 'not_found' });

    // update snapshots.latest.tokensTracked immediately (optional)
    const snapshots = await readJson(FILE_SNAPSHOTS, { latest: null, history: [] });
    const tracked = (await readJson(FILE_TOKENS, { tokens: [] })).tokens.length;

    return res.json({ ok: true, row, tokensTracked: tracked });
  } catch (e) {
    console.error('add-token error', e);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
});

// Deep scan persistence (used by abs-tabs-integration.js)
app.get('/api/token-stats/:ca', async (req, res) => {
  await ensureDataFiles();
  const ca = String(req.params.ca || '').toLowerCase();
  if (!isCA(ca)) return res.status(400).json({ ok: false, error: 'invalid_ca' });
  const map = await readJson(FILE_TOKEN_STATS, {});
  const rec = map[ca];
  if (!rec) return res.json({ ok: false, data: null });
  return res.json({ ok: true, ts: rec.ts, data: rec.data });
});

app.post('/api/token-stats/save', async (req, res) => {
  await ensureDataFiles();
  const { ca, data } = req.body || {};
  const addr = String(ca || '').toLowerCase();
  if (!isCA(addr)) return res.status(400).json({ ok: false, error: 'invalid_ca' });
  const map = await readJson(FILE_TOKEN_STATS, {});
  const now = Date.now();
  map[addr] = { ts: now, data };
  await writeJson(FILE_TOKEN_STATS, map);
  return res.json({ ok: true, ts: now });
});

// ------------------------------- Boot
const PORT = process.env.PORT || 8080;
(async () => {
  await ensureDataFiles();
  // Optional: kick off a warm scan on boot
  doFullScan().catch(()=>{});
  startSchedulers();
app.listen(8080, "0.0.0.0", ()=> console.log(`$tABS server listening on http://0.0.0.0:8080`));
  });
})();
