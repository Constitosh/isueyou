// server.cjs — Abstract chain tracker (CommonJS)
// - Seeds tokens/pairs from data/tokens-lib.json (no hard-coded CAs in code)
// - Grows library via /token-profiles/latest/v1 and user searches
// - Every 15 min: 1 consolidated snapshot -> data/snapshots.json (overwrites previous)
// - Keeps last 5 history entries per token
// - Aggregates 24h volume across ALL known pairs per token

const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();

const PUBLIC_DIR = path.join(__dirname, "public");
console.log("Serving static from:", PUBLIC_DIR);

app.use(express.static('PUBLIC_DIR'));
app.use(express.json());

// ---------- config & files ----------
const PORT = process.env.PORT || 8080;
const DATA_DIR   = path.resolve("data");
const SNAP_FILE  = path.join(DATA_DIR, "snapshots.json");
const LIB_FILE   = path.join(DATA_DIR, "tokens-lib.json");

const CHAIN = "abstract";
const TABS_ADDR = "0x8C3d850313EB9621605cD6A1ACb2830962426F67".toLowerCase();

const SCAN_INTERVAL_MS   = 15 * 60 * 1000; // single snapshot each run
const LATEST_INTERVAL_MS =  5 * 60 * 1000; // grow library via latest profiles
const TOKEN_HISTORY_LIMIT = 5;

// ---------- endpoints ----------
const DS_TOKENS_V1    = (csv)=> `https://api.dexscreener.com/tokens/v1/${CHAIN}/${csv}`;
const DS_PAIR_DETAILS = (pair)=> `https://api.dexscreener.com/latest/dex/pairs/${CHAIN}/${pair}`;
const DS_SEARCH       = (q)=>   `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(q)}`;
const DS_LATEST_PROF  =         `https://api.dexscreener.com/token-profiles/latest/v1`;

// Optional holders API (for header)
const API_KEY  = process.env.ABS_API_KEY || "H13F5VZ64YYK4M21QMPEW78SIKJS85UTWT";
const CHAIN_ID = 2741;
const ES_V2 = (addr)=> `https://api.etherscan.io/v2/api?chainid=${CHAIN_ID}&module=token&action=tokenholderlist&contractaddress=${addr}&page=1&offset=10000&apikey=${API_KEY}`;

// ---------- utils ----------
function ensureDir(){ if(!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR,{recursive:true}); }
function readJSON(file, fallback){ try{ return JSON.parse(fs.readFileSync(file,"utf8")); }catch{ return fallback; } }
function writeJSON(file, obj){ fs.writeFileSync(file, JSON.stringify(obj,null,2)); }
const uniqLower = (arr = []) => [...new Set(arr.filter(Boolean).map(x => String(x).toLowerCase()))];
const chunk = (arr, n) => { const out=[]; for(let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; };
const sum = (a)=> a.reduce((s,x)=> s + (Number.isFinite(x)? x : 0), 0);

// ---------- library ----------
function loadLib(){
  const lib = readJSON(LIB_FILE, { tokens:[], pairs:[], tokenPairs:{}, lastUpdated:0 });
  lib.tokens = Array.isArray(lib.tokens) ? uniqLower(lib.tokens) : [];
  lib.pairs  = Array.isArray(lib.pairs)  ? uniqLower(lib.pairs)  : [];
  lib.tokenPairs = lib.tokenPairs && typeof lib.tokenPairs === 'object' ? lib.tokenPairs : {};
  for(const k of Object.keys(lib.tokenPairs)) lib.tokenPairs[k] = uniqLower(lib.tokenPairs[k]);
  return lib;
}
function saveLib(lib){
  lib.tokens = uniqLower(lib.tokens);
  lib.pairs  = uniqLower(lib.pairs);
  for(const k of Object.keys(lib.tokenPairs||{})) lib.tokenPairs[k] = uniqLower(lib.tokenPairs[k]);
  lib.lastUpdated = Date.now();
  writeJSON(LIB_FILE, lib);
}

// Attach seed pairs to base tokens; backfill lib.tokens and lib.tokenPairs
async function attachPairsFromPairList(lib, pairList){
  for(const p of uniqLower(pairList)){
    try{
      const r = await fetch(DS_PAIR_DETAILS(p));
      if(!r.ok) continue;
      const j = await r.json().catch(()=>({}));
      const pair = Array.isArray(j.pairs) ? j.pairs[0] : null;
      if(!pair || (pair.chainId||"").toLowerCase() !== CHAIN) continue;
      const base = (pair.baseToken?.address || "").toLowerCase();
      if(!base) continue;
      lib.pairs = uniqLower([...lib.pairs, p]);
      lib.tokens = uniqLower([...lib.tokens, base]);
      lib.tokenPairs[base] = uniqLower([...(lib.tokenPairs[base]||[]), p]);
    }catch{}
  }
  saveLib(lib);
}

// Try to discover more pairs for a token via search
async function discoverPairsForToken(lib, tokenAddr){
  try{
    const r = await fetch(DS_SEARCH(tokenAddr));
    if(!r.ok) return;
    const j = await r.json().catch(()=>({}));
    const pairs = (j.pairs||[]).filter(p => (p.chainId||"").toLowerCase()===CHAIN && (p.baseToken?.address||"").toLowerCase()===tokenAddr);
    if(!pairs.length) return;
    const addrs = uniqLower(pairs.map(p=> p.pairAddress));
    lib.pairs = uniqLower([...lib.pairs, ...addrs]);
    lib.tokens = uniqLower([...lib.tokens, tokenAddr]);
    lib.tokenPairs[tokenAddr] = uniqLower([...(lib.tokenPairs[tokenAddr]||[]), ...addrs]);
    saveLib(lib);
  }catch{}
}

// Grow library from latest profiles
async function refreshLibFromLatestProfiles(){
  const lib = loadLib();
  try{
    const r = await fetch(DS_LATEST_PROF);
    if(!r.ok) return;
    const list = await r.json();
    if(!Array.isArray(list)) return;
    const abstracts = uniqLower(list
      .filter(x => (x?.chainId||"").toLowerCase()===CHAIN)
      .map(x => (x?.token?.address || x?.address || ""))
    );
    if(abstracts.length){
      lib.tokens = uniqLower([...lib.tokens, ...abstracts]);
      // discover pairs for new tokens (best effort)
      for(const t of abstracts) await discoverPairsForToken(lib, t);
      saveLib(lib);
    }
  }catch(e){ console.error("latest-profiles refresh failed:", e); }
}

// ---------- fetchers ----------
async function fetchTokensV1(addresses){
  const out=[];
  const chunks = chunk(uniqLower(addresses), 30);
  for(const c of chunks){
    try{
      const r = await fetch(DS_TOKENS_V1(c.join(",")));
      if(!r.ok) continue;
      const rows = await r.json().catch(()=>[]);
      for(const row of Array.isArray(rows)? rows : []) out.push(row);
    }catch{}
  }
  return out;
}

async function fetchPairsVolumes(pairAddrs){
  const m = new Map();
  for(const p of uniqLower(pairAddrs)){
    try{
      const r = await fetch(DS_PAIR_DETAILS(p));
      if(!r.ok) continue;
      const j = await r.json().catch(()=>({}));
      const pair = Array.isArray(j.pairs) ? j.pairs[0] : null;
      if(pair && (pair.chainId||"").toLowerCase()===CHAIN){
        const v = Number(pair?.volume?.h24 ?? 0);
        m.set(p, Number.isFinite(v)? v : 0);
      }
    }catch{}
  }
  return m;
}

async function countTokenHolders(addr){
  try{
    const r = await fetch(ES_V2(addr));
    if(!r.ok) return null;
    const j = await r.json().catch(()=>({}));
    if(String(j.status)!=="1" || !Array.isArray(j.result)) return null;
    return j.result.length || null;
  }catch{ return null; }
}

async function fetchBanner(){
  const rows = await fetchTokensV1([TABS_ADDR]);
  const row = Array.isArray(rows) ? rows[0] : null;
  const holders = await countTokenHolders(TABS_ADDR);
  return {
    holders,
    fdv: (typeof row?.fdv === 'number') ? row.fdv : null,
    marketCap: (typeof row?.marketCap === 'number') ? row.marketCap : null,
    vol24: row?.volume?.h24 ?? 0,
    chg24: row?.priceChange?.h24 ?? 0,
    url: row?.url || `https://dexscreener.com/${CHAIN}/${TABS_ADDR}`
  };
}

// Build token rows with aggregated pair volume
async function buildTokenRows(){
  const lib = loadLib();

  // /tokens/v1 base info
  const v1rows = await fetchTokensV1(lib.tokens);
  const v1map  = new Map(v1rows.map(r => [(r.baseToken?.address||"").toLowerCase(), r]));

  // pair volumes across all known pairs
  const allPairs = uniqLower(Object.values(lib.tokenPairs || {}).flat());
  const volMap = await fetchPairsVolumes(allPairs);

  // assemble per-token row
  const rows = [];
  for(const token of lib.tokens){
    const info = v1map.get(token);
    const name   = info?.baseToken?.name   || "";
    const symbol = info?.baseToken?.symbol || "";
    const priceChange = {
      m5 : info?.priceChange?.m5  ?? null,
      h1 : info?.priceChange?.h1  ?? null,
      h6 : info?.priceChange?.h6  ?? null,
      h24: info?.priceChange?.h24 ?? null,
    };
    const marketCap = (typeof info?.marketCap === 'number') ? info.marketCap : null;
    const fdv       = (typeof info?.fdv       === 'number') ? info.fdv       : null;
    const url       = info?.url || null;

    const pairs = (loadLib().tokenPairs[token] || []); // re-read to pick up new attach
    const pairVols = pairs.map(p => volMap.get(p) ?? 0);
    const sumPairs = sum(pairVols);
    const v1Vol    = Number(info?.volume?.h24 ?? 0);
    const volume24h = (sumPairs > 0 ? sumPairs : v1Vol);

    rows.push({ baseAddress: token, name, symbol, priceChange, marketCap, fdv, volume24h, url });
  }
  return rows;
}

// ---------- scanning & snapshot (single latest only) ----------
async function runScan(){
  const rows = await buildTokenRows();

  const topGainers = rows
    .filter(r => typeof r.priceChange?.h24 === 'number' && r.priceChange.h24 > 0)
    .sort((a,b)=> (b.priceChange.h24 - a.priceChange.h24) || ((b.volume24h||0)-(a.volume24h||0)))
    .slice(0,15);

  const topVol = [...rows]
    .sort((a,b)=> (b.volume24h||0) - (a.volume24h||0))
    .slice(0,15);

  const banner = await fetchBanner();
  const lib    = loadLib();
  const now    = Date.now();

  // history: keep last 5 per token
  const snapState = readJSON(SNAP_FILE, { snapshot:null, tokenHistory:{} });
  const tokenHistory = snapState.tokenHistory || {};
  for(const r of rows){
    tokenHistory[r.baseAddress] = [
      ...(tokenHistory[r.baseAddress]||[]),
      { ts: now, marketCap: r.marketCap, fdv: r.fdv, priceChange: r.priceChange, volume24h: r.volume24h }
    ].slice(-TOKEN_HISTORY_LIMIT);
  }

  const snapshot = {
    ts: now,
    chain: CHAIN,
    topGainers,
    topVol,
    banner,
    tokensTracked: lib.tokens.length
  };

  writeJSON(SNAP_FILE, { snapshot, tokenHistory });
  return snapshot;
}

let scanning=false;
async function scanAndSave(){
  if(scanning) return null;
  scanning=true;
  try{ return await runScan(); }
  catch(e){ console.error("scan failed:", e); return null; }
  finally{ scanning=false; }
}

// ---------- schedules ----------
setInterval(()=>{ refreshLibFromLatestProfiles().catch(()=>{}); }, LATEST_INTERVAL_MS);
setInterval(()=>{ scanAndSave().catch(()=>{}); }, SCAN_INTERVAL_MS);

// ---------- API ----------
app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET, POST");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  next();
});

app.post("/api/refresh", async (req,res)=>{
  if(scanning){
    const st = readJSON(SNAP_FILE, { snapshot:null });
    return res.json({ ok:true, snapshot: st.snapshot, notice:"busy" });
  }
  const snap = await scanAndSave();
  if(!snap){
    const st = readJSON(SNAP_FILE, { snapshot:null });
    return res.json({ ok: !!st.snapshot, snapshot: st.snapshot, notice:"fallback" });
  }
  res.json({ ok:true, snapshot: snap });
});

app.get("/api/snapshot/latest", (req,res)=>{
  const st = readJSON(SNAP_FILE, { snapshot:null });
  res.json({ ok:true, snapshot: st.snapshot });
});

// Add token from user search; discover pairs; return row and updated tokensTracked
app.post("/api/add-token", async (req,res)=>{
  try{
    const { ca } = req.body || {};
    const addr = String(ca||"").toLowerCase();
    if(!/^0x[a-fA-F0-9]{40}$/.test(addr)) return res.status(400).json({ ok:false, error:"invalid_ca" });

    const lib = loadLib();
    if(!lib.tokens.includes(addr)){ lib.tokens.push(addr); saveLib(lib); }
    await discoverPairsForToken(lib, addr);

    const rows = await buildTokenRows();
    const row  = rows.find(r => r.baseAddress === addr) || null;

    // history append
    const state = readJSON(SNAP_FILE, { snapshot:null, tokenHistory:{} });
    state.tokenHistory[addr] = [
      ...(state.tokenHistory[addr]||[]),
      { ts: Date.now(), marketCap: row?.marketCap ?? null, fdv: row?.fdv ?? null, priceChange: row?.priceChange ?? null, volume24h: row?.volume24h ?? 0 }
    ].slice(-TOKEN_HISTORY_LIMIT);
    writeJSON(SNAP_FILE, state);

    return res.json({ ok:true, row, tokensTracked: loadLib().tokens.length });
  }catch(e){
    console.error(e);
    res.status(500).json({ ok:false, error:"internal" });
  }
});

app.use(express.static(path.resolve("public")));

// ---------- boot ----------
(async ()=>{
  ensureDir();
  // Ensure files exist
  if(!fs.existsSync(LIB_FILE)) writeJSON(LIB_FILE, { tokens:[], pairs:[], tokenPairs:{}, lastUpdated:0 });
  if(!fs.existsSync(SNAP_FILE)) writeJSON(SNAP_FILE, { snapshot:null, tokenHistory:{} });

  // Attach any seed pairs from library to their base tokens on first boot
  const lib = loadLib();
  if(Array.isArray(lib.pairs) && lib.pairs.length){
    await attachPairsFromPairList(lib, lib.pairs);
  }
  // Initial grow + initial scan
  await refreshLibFromLatestProfiles().catch(()=>{});
  await scanAndSave().catch(()=>{});

  app.listen(8080, "0.0.0.0", ()=> console.log(`$tABS server listening on http://0.0.0.0:8080`));
})();
