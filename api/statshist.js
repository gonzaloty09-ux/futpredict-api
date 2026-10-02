// Historial multi-temporada de Football-Data.co.uk (CSV gratis, sin clave, sin límite de peticiones).
// Se usa como RESPALDO cuando la temporada actual (FutPythonTrader) todavía no tiene muestra suficiente
// para un equipo. Si esta fuente falla, el endpoint responde ok:false y no rompe nada.
const BASE = 'https://www.football-data.co.uk/mmz4281';
// Código de football-data.co.uk por liga, tal como aparece el nombre en football-data.org.
const CODE = {
  'premier league': 'E0', 'championship': 'E1',
  'primera division': 'SP1', 'la liga': 'SP1',
  'serie a': 'I1', 'bundesliga': 'D1',
  'ligue 1': 'F1', 'eredivisie': 'N1', 'primeira liga': 'P1'
};
// Alias para los nombres cortos que usa football-data.co.uk y no cruzan por substring con el nombre oficial.
const ALIAS = {
  'man united': 'manchester united', 'man utd': 'manchester united', 'man city': 'manchester city',
  'spurs': 'tottenham', 'wolves': 'wolverhampton', "nott'm forest": 'nottingham forest',
  'nottm forest': 'nottingham forest', 'newcastle': 'newcastle united', 'leicester': 'leicester city',
  'west brom': 'west bromwich albion', 'sheffield utd': 'sheffield united', 'qpr': 'queens park rangers'
};
const CACHE = {}; // { 'E0:2627': { teams, ts } }

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=86400');
}
function normName(s) {
  const n = String(s).toLowerCase()
    .replace(/[áàäâéèëêíìïîóòöôúùüûñç]/g, function (c) {
      return { á: 'a', à: 'a', ä: 'a', â: 'a', é: 'e', è: 'e', ë: 'e', ê: 'e', í: 'i', ì: 'i', ï: 'i', î: 'i', ó: 'o', ò: 'o', ö: 'o', ô: 'o', ú: 'u', ù: 'u', ü: 'u', û: 'u', ñ: 'n', ç: 'c' }[c] || c;
    })
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  return ALIAS[n] || n;
}
function seasonCodes() {
  // 'YYMM' del juego: julio corta la temporada europea. Trae la actual + 2 anteriores para tener muestra de verdad.
  const now = new Date(); const y = now.getUTCFullYear(); const m = now.getUTCMonth() + 1;
  const startYear = m >= 7 ? y : y - 1;
  const codes = [];
  for (let i = 0; i < 3; i++) {
    const a = startYear - i, b = a + 1;
    codes.push(String(a).slice(2) + String(b).slice(2));
  }
  return codes;
}
// Parser de CSV respetando comillas (football-data.co.uk a veces trae comas dentro de campos).
function parseCSV(text) {
  const rows = []; let row = []; let field = ''; let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false; }
      else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') { if (field !== '' || row.length) { row.push(field); rows.push(row); } row = []; field = ''; }
    else field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}
async function fetchCSV(url, ms) {
  const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, ms || 6000);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error('csv ' + r.status);
    return await r.text();
  } finally { clearTimeout(t); }
}
async function dbq(sql, params, ms) {
  const cs = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!cs) throw new Error('sin DATABASE_URL');
  const host = new URL(cs).hostname;
  const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, ms || 2500);
  try {
    const r = await fetch('https://' + host + '/sql', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': cs }, body: JSON.stringify({ query: sql, params: params || [] }), signal: c.signal });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || ('neon ' + r.status));
    return j.rows || [];
  } finally { clearTimeout(t); }
}
async function kvGet(k) {
  try {
    const rows = await dbq('select v from kv where k = $1', [k], 2500);
    if (!rows.length) return null;
    let v = rows[0].v; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return null; } }
    return v;
  } catch (e) { return null; }
}
async function kvSet(k, v) {
  try { await dbq('create table if not exists kv (k text primary key, v jsonb, ts timestamptz default now())', [], 2500); } catch (e) { }
  try { await dbq('insert into kv (k, v, ts) values ($1, $2::jsonb, now()) on conflict (k) do update set v = excluded.v, ts = now()', [k, JSON.stringify(v)], 2500); } catch (e) { }
}

function aggregate(allRows) {
  const T = {};
  allRows.forEach(function (rows) {
    if (!rows.length) return;
    const head = rows[0]; const idx = {}; head.forEach(function (h, i) { idx[h.trim()] = i; });
    const need = ['HomeTeam', 'AwayTeam', 'HS', 'AS', 'HST', 'AST', 'HC', 'AC', 'HF', 'AF', 'HY', 'AY'];
    if (need.some(function (k) { return idx[k] == null; })) return; // temporada vieja sin esas columnas: se salta, no rompe
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; if (!r[idx.HomeTeam] || !r[idx.AwayTeam]) continue;
      const hn = normName(r[idx.HomeTeam]), an = normName(r[idx.AwayTeam]);
      const H = T[hn] = T[hn] || { sh: 0, sot: 0, cor: 0, fou: 0, yc: 0, n: 0 };
      const A = T[an] = T[an] || { sh: 0, sot: 0, cor: 0, fou: 0, yc: 0, n: 0 };
      const num = function (x) { const v = parseFloat(x); return isNaN(v) ? 0 : v; };
      H.sh += num(r[idx.HS]); H.sot += num(r[idx.HST]); H.cor += num(r[idx.HC]); H.fou += num(r[idx.HF]); H.yc += num(r[idx.HY]); H.n++;
      A.sh += num(r[idx.AS]); A.sot += num(r[idx.AST]); A.cor += num(r[idx.AC]); A.fou += num(r[idx.AF]); A.yc += num(r[idx.AY]); A.n++;
    }
  });
  const out = {};
  for (const k in T) {
    const t = T[k]; if (!t.n) continue;
    out[k] = { sh: +(t.sh / t.n).toFixed(1), sot: +(t.sot / t.n).toFixed(1), cor: +(t.cor / t.n).toFixed(1), fou: +(t.fou / t.n).toFixed(1), yc: +(t.yc / t.n).toFixed(1), xg: null, n: t.n };
  }
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const league = (req.query.league || '').toLowerCase().trim();
  const code = CODE[league];
  if (!code) return res.status(200).json({ ok: false, error: 'liga sin código de football-data.co.uk' });
  const seasons = seasonCodes();
  const cacheKey = code + ':' + seasons.join(',');
  const now = Date.now();
  const mem = CACHE[cacheKey];
  if (mem && now - mem.ts < 6 * 60 * 60 * 1000) return res.status(200).json({ ok: true, source: 'football-data.co.uk', seasons: seasons, teams: mem.teams });
  try {
    const texts = await Promise.all(seasons.map(function (s) {
      return fetchCSV(BASE + '/' + s + '/' + code + '.csv').catch(function () { return null; });
    }));
    const rowsList = texts.filter(Boolean).map(parseCSV);
    if (!rowsList.length) throw new Error('ninguna temporada respondió');
    const teams = aggregate(rowsList);
    CACHE[cacheKey] = { teams: teams, ts: now };
    kvSet('fdco:' + cacheKey, teams);
    return res.status(200).json({ ok: true, source: 'football-data.co.uk', seasons: seasons, teams: teams });
  } catch (e) {
    const kv = await kvGet('fdco:' + cacheKey);
    if (kv) { CACHE[cacheKey] = { teams: kv, ts: now }; return res.status(200).json({ ok: true, source: 'football-data.co.uk (caché)', seasons: seasons, teams: kv }); }
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
