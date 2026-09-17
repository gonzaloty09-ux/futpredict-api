const API = 'https://api.football-data.org/v4';
const CODES = ['CL', 'EL', 'PL', 'PD', 'SA', 'BL', 'FL1', 'DED'];
const cache = { data: null, ts: 0, key: '' };

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
    if (t.n < 2) continue;
    R[k] = { att: cl(t.gf / t.n / 1.35, 0.5, 2.5), def: cl(t.ga / t.n / 1.35, 0.5, 2.5) };
  }
  return R;
}
function buildForm(matches) {
  const sorted = matches.slice().sort(function (a, b) { return (a.utcDate || '').localeCompare(b.utcDate || ''); });
  const F = {};
  sorted.forEach(function (m) {
    const hs = m.score && m.score.fullTime ? m.score.fullTime.home : null;
    const as = m.score && m.score.fullTime ? m.score.fullTime.away : null;
    if (hs == null || as == null) return;
    const hn = m.homeTeam.name, an = m.awayTeam.name;
    const hr = hs > as ? 'W' : hs < as ? 'L' : 'D';
    const ar = hs > as ? 'L' : hs < as ? 'W' : 'D';
    (F[hn] = F[hn] || []).push(hr);
    (F[an] = F[an] || []).push(ar);
  });
  const out = {};
  for (const k in F) out[k] = F[k].slice(-5).reverse();
  return out;
}
async function fd(path, token, ms) {
  ms = ms || 8000;
  const c = new AbortController();
  const t = setTimeout(function () { c.abort(); }, ms);
  try {
    const r = await fetch(API + path, { headers: { 'X-Auth-Token': token }, signal: c.signal });
    if (!r.ok) throw new Error('fd ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return res.status(500).json({ ok: false, error: 'Falta FOOTBALL_DATA_TOKEN' });
  try {
    const now = Date.now();
    const qDate = req.query.date || null;
    const base = qDate ? new Date(qDate + 'T12:00:00Z') : new Date();
    const from = new Date(base.getTime() - 1 * 86400000).toISOString().split('T')[0];
    const to = new Date(base.getTime() + 6 * 86400000).toISOString().split('T')[0];
    const key = from + '_' + to;

    // UNA sola tanda de 8 llamadas en paralelo (rápido, dentro del límite)
    if (!cache.data || cache.key !== key || now - cache.ts > 30 * 60 * 1000) {
      const results = await Promise.all(CODES.map(function (c) {
        return fd('/competitions/' + c + '/matches?dateFrom=' + from + '&dateTo=' + to, token)
          .then(function (r) { return { m: r.matches || [] }; })
          .catch(function () { return { m: [] }; });
      }));
      const map = {};
      results.forEach(function (r) { r.m.forEach(function (m) { map[m.id] = m; }); });
      cache.data = Object.values(map);
      cache.ts = now; cache.key = key;
    }

    // Ratings y forma se calculan de los partidos YA TERMINADOS de la ventana (sin llamadas extra)
    const finished = cache.data.filter(function (m) {
      const s = (m.status || '').toUpperCase();
      return s.indexOf('FIN') === 0 || s.indexOf('FINAL') === 0;
    });
    const RAT = buildRatings(finished);
    const FORM = buildForm(finished);

    const out = [];
    cache.data.forEach(function (m) {
      const home = RAT[m.homeTeam.name] || { att: 1, def: 1 };
      const away = RAT[m.awayTeam.name] || { att: 1, def: 1 };
      const hL = cl(1.35 * home.att * away.def * 1.15, 0.3, 3.5);
      const aL = cl(1.35 * away.att * home.def, 0.2, 3.0);
      const probs = calcProbs(hL, aL);
      const main = probs.home >= probs.draw && probs.home >= probs.away ? 'home'
        : probs.away >= probs.home && probs.away >= probs.draw ? 'away' : 'draw';
      out.push({
        id: m.id, home: m.homeTeam.name, away: m.awayTeam.name,
        league: m.competition.name, time: m.utcDate, status: m.status,
        score: m.score && m.score.fullTime ? { home: m.score.fullTime.home, away: m.score.fullTime.away } : null,
        probs, main, hL: +hL.toFixed(2), aL: +aL.toFixed(2),
        formHome: FORM[m.homeTeam.name] || [], formAway: FORM[m.awayTeam.name] || []
      });
    });
    out.sort(function (a, b) { return (a.time || '').localeCompare(b.time || ''); });
    res.status(200).json({ ok: true, count: out.length, window: { from, to }, competitions: CODES, predictions: out, generated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
      }
