const API = 'https://api.football-data.org/v4';
const cache = { data: null, ts: 0, key: '' };
const HIST = {};

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function cl(v, a, b) { return Math.max(a, Math.min(b, v)); }
function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poisson(l, k) { return (Math.pow(l, k) * Math.exp(-l)) / factorial(k); }
function calcProbs(hL, aL) {
  let hW = 0, d = 0, aW = 0;
  for (let h = 0; h <= 7; h++) for (let a = 0; a <= 7; a++) {
    const p = poisson(hL, h) * poisson(aL, a);
    if (h > a) hW += p; else if (h === a) d += p; else aW += p;
  }
  const t = hW + d + aW;
  return { home: Math.round(hW / t * 100), draw: Math.round(d / t * 100), away: Math.round(aW / t * 100) };
}
function buildRatings(matches) {
  const T = {};
  for (const m of matches) {
    const hs = m.score && m.score.fullTime ? m.score.fullTime.home : null;
    const as = m.score && m.score.fullTime ? m.score.fullTime.away : null;
    if (hs == null || as == null) continue;
    const hn = m.homeTeam.name, an = m.awayTeam.name;
    T[hn] = T[hn] || { gf: 0, ga: 0, n: 0 };
    T[an] = T[an] || { gf: 0, ga: 0, n: 0 };
    T[hn].gf += hs; T[hn].ga += as; T[hn].n++;
    T[an].gf += as; T[an].ga += hs; T[an].n++;
  }
  const R = {};
  for (const k in T) {
    const t = T[k];
    if (t.n < 3) continue;
    R[k] = { att: cl(t.gf / t.n / 1.35, 0.5, 2.5), def: cl(t.ga / t.n / 1.35, 0.5, 2.5) };
  }
  return R;
}
async function fd(path, token) {
  const r = await fetch(API + path, { headers: { 'X-Auth-Token': token } });
  if (!r.ok) throw new Error('football-data error ' + r.status);
  return r.json();
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'Falta FOOTBALL_DATA_TOKEN' });
  try {
    const now = Date.now();
    // Fecha opcional: /api/predictions?date=YYYY-MM-DD
    const qDate = req.query.date || null;
    const base = qDate ? new Date(qDate + 'T12:00:00Z') : new Date();
    const from = new Date(base.getTime() - 1 * 86400000).toISOString().split('T')[0];
    const to = new Date(base.getTime() + 6 * 86400000).toISOString().split('T')[0];
    const cacheKey = from + '_' + to;

    if (!cache.data || cache.key !== cacheKey || now - cache.ts > 10 * 60 * 1000) {
      const fx = await fd('/matches?dateFrom=' + from + '&dateTo=' + to, token);
      cache.data = fx.matches || [];
      cache.ts = now;
      cache.key = cacheKey;
    }

    const comps = {};
    for (const m of cache.data) comps[m.competition.id] = true;
    for (const cid of Object.keys(comps)) {
      if (!HIST[cid] || now - HIST[cid].ts > 60 * 60 * 1000) {
        try {
          const h = await fd('/competitions/' + cid + '/matches?status=FINISHED&limit=60', token);
          HIST[cid] = { ratings: buildRatings(h.matches || []), ts: now };
        } catch (e) { HIST[cid] = { ratings: {}, ts: now }; }
      }
    }

    const out = [];
    for (const m of cache.data) {
      const R = (HIST[m.competition.id] && HIST[m.competition.id].ratings) || {};
      const home = R[m.homeTeam.name] || { att: 1, def: 1 };
      const away = R[m.awayTeam.name] || { att: 1, def: 1 };
      const hL = cl(1.35 * home.att * away.def * 1.15, 0.3, 3.5);
      const aL = cl(1.35 * away.att * home.def, 0.2, 3.0);
      const probs = calcProbs(hL, aL);
      const main = probs.home >= probs.draw && probs.home >= probs.away ? 'home'
        : probs.away >= probs.home && probs.away >= probs.draw ? 'away' : 'draw';
      out.push({
        id: m.id,
        home: m.homeTeam.name,
        away: m.awayTeam.name,
        league: m.competition.name,
        time: m.utcDate,
        status: m.status,
        score: m.score && m.score.fullTime ? { home: m.score.fullTime.home, away: m.score.fullTime.away } : null,
        probs, main, hL: +hL.toFixed(2), aL: +aL.toFixed(2)
      });
    }
    out.sort((a, b) => (a.time || '').localeCompare(b.time || ''));
    res.status(200).json({ ok: true, count: out.length, window: { from, to }, predictions: out, generated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
  }
