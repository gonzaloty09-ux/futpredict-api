import { requireAuth, cors, noCache, dbq, normNameAlias, parseCSV } from './core.js';
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
const CACHE = {}; // { 'E0:2627': { teams, ts } }

// M11: cors, dbq, normName (con alias) y parseCSV centralizados en core.js.
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
async function fetchCSV(url, ms) {
  const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, ms || 6000);
  try {
    const r = await fetch(url, { signal: c.signal });
    if (!r.ok) throw new Error('csv ' + r.status);
    return await r.text();
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

// B9: ponderación por recencia — un partido de la temporada actual pesa más que
// uno de hace 3 años. Peso exponencial 1 / 0.65 / 0.42 por temporada (índice 0 = actual).
function aggregate(allRows, weights) {
  const T = {};
  allRows.forEach(function (rows, si) {
    if (!rows.length) return;
    const w = (weights && weights[si] != null) ? weights[si] : 1;
    const head = rows[0]; const idx = {}; head.forEach(function (h, i) { idx[h.trim()] = i; });
    const need = ['HomeTeam', 'AwayTeam', 'HS', 'AS', 'HST', 'AST', 'HC', 'AC', 'HF', 'AF', 'HY', 'AY'];
    if (need.some(function (k) { return idx[k] == null; })) return; // temporada vieja sin esas columnas: se salta, no rompe
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; if (!r[idx.HomeTeam] || !r[idx.AwayTeam]) continue;
      const hn = normNameAlias(r[idx.HomeTeam]), an = normNameAlias(r[idx.AwayTeam]);
      const H = T[hn] = T[hn] || { sh: 0, sot: 0, cor: 0, fou: 0, yc: 0, n: 0, sw: 0 };
      const A = T[an] = T[an] || { sh: 0, sot: 0, cor: 0, fou: 0, yc: 0, n: 0, sw: 0 };
      const num = function (x) { const v = parseFloat(x); return isNaN(v) ? 0 : v; };
      H.sh += num(r[idx.HS]) * w; H.sot += num(r[idx.HST]) * w; H.cor += num(r[idx.HC]) * w; H.fou += num(r[idx.HF]) * w; H.yc += num(r[idx.HY]) * w; H.n++; H.sw += w;
      A.sh += num(r[idx.AS]) * w; A.sot += num(r[idx.AST]) * w; A.cor += num(r[idx.AC]) * w; A.fou += num(r[idx.AF]) * w; A.yc += num(r[idx.AY]) * w; A.n++; A.sw += w;
    }
  });
  const out = {};
  for (const k in T) {
    const t = T[k]; if (!t.n || !t.sw) continue;
    out[k] = { sh: +(t.sh / t.sw).toFixed(1), sot: +(t.sot / t.sw).toFixed(1), cor: +(t.cor / t.sw).toFixed(1), fou: +(t.fou / t.sw).toFixed(1), yc: +(t.yc / t.sw).toFixed(1), xg: null, n: t.n };
  }
  return out;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  noCache(res); // C1: private, no-store, DESPUÉS del chequeo de auth
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
      return fetchCSV(BASE + '/' + s + '/' + code + '.csv').then(function (t) { return { s: s, t: t }; }).catch(function () { return null; });
    }));
    const got = texts.filter(Boolean);
    if (!got.length) throw new Error('ninguna temporada respondió');
    const rowsList = got.map(function (g) { return parseCSV(g.t); });
    // B9: peso por recencia según la posición de la temporada (0 = actual).
    const weights = got.map(function (g) { return Math.pow(0.65, seasons.indexOf(g.s)); });
    const teams = aggregate(rowsList, weights);
    CACHE[cacheKey] = { teams: teams, ts: now };
    await kvSet('fdco:' + cacheKey, teams); // M5: await antes de responder (si no, el write puede perderse en serverless)
    return res.status(200).json({ ok: true, source: 'football-data.co.uk', seasons: seasons, teams: teams });
  } catch (e) {
    console.error('api/statshist', e);
    const kv = await kvGet('fdco:' + cacheKey);
    if (kv) { CACHE[cacheKey] = { teams: kv, ts: now }; return res.status(200).json({ ok: true, source: 'football-data.co.uk (caché)', seasons: seasons, teams: kv }); }
    const msg = (e && e.message) || '';
    return res.status(200).json({ ok: false, error: msg === 'ninguna temporada respondió' ? msg : 'error interno' });
  }
}
