const API = 'https://api.football-data.org/v4';
const ODDS_API = 'https://api.the-odds-api.com/v4';
const FPT = 'https://futpythontrader.com.br/api/download';
const cache = { data: null, ts: 0, key: '' };
const HIST = {};
const ODDS = {};
const STATS = {};
const RHO = -0.06;
const MARKET_W = 0.4;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function cl(v, a, b) { return Math.max(a, Math.min(b, v)); }
function normName(s) {
  return String(s).toLowerCase()
    .replace(/[áàäâéèëêíìïîóòöôúùüûñç]/g, function (c) {
      return { á: 'a', à: 'a', ä: 'a', â: 'a', é: 'e', è: 'e', ë: 'e', ê: 'e', í: 'i', ì: 'i', ï: 'i', î: 'i', ó: 'o', ò: 'o', ö: 'o', ô: 'o', ú: 'u', ù: 'u', ü: 'u', û: 'u', ñ: 'n', ç: 'c' }[c] || c;
    })
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function mapLeague(name) {
  const n = String(name).toLowerCase();
  if (n.indexOf('premier league') !== -1) return 'soccer_epl';
  if (n.indexOf('primera division') !== -1 || n.indexOf('la liga') !== -1) return 'soccer_spain_la_liga';
  if (n.indexOf('serie a') !== -1) return 'soccer_italy_serie_a';
  if (n.indexOf('bundesliga') !== -1) return 'soccer_germany_bundesliga';
  if (n.indexOf('ligue 1') !== -1) return 'soccer_france_ligue_one';
  if (n.indexOf('champions') !== -1) return 'soccer_uefa_champs_league';
  if (n.indexOf('europa league') !== -1) return 'soccer_uefa_europa_league';
  if (n.indexOf('eredivisie') !== -1) return 'soccer_netherlands_eredivisie';
  if (n.indexOf('primeira liga') !== -1) return 'soccer_portugal_primeira_liga';
  if (n.indexOf('championship') !== -1) return 'soccer_efl_champ';
  if (n.indexOf('libertadores') !== -1) return 'soccer_conmebol_libertadores';
  return null;
}
function statsSource(leagueName) {
  const n = String(leagueName).toLowerCase();
  if (n.indexOf('premier league') !== -1) return { c: 'england', l: 'premier-league', s: ['2026-2027', '2025-2026'] };
  if (n.indexOf('championship') !== -1) return { c: 'england', l: 'championship', s: ['2026-2027', '2025-2026'] };
  if (n.indexOf('primera division') !== -1 || n.indexOf('la liga') !== -1) return { c: 'spain', l: 'laliga', s: ['2026-2027', '2025-2026'] };
  if (n.indexOf('serie a') !== -1) return { c: 'italy', l: 'serie-a', s: ['2026-2027', '2025-2026'] };
  if (n.indexOf('bundesliga') !== -1) return { c: 'germany', l: 'bundesliga', s: ['2026-2027', '2025-2026'] };
  if (n.indexOf('ligue 1') !== -1) return { c: 'france', l: 'ligue-1', s: ['2026-2027', '2025-2026'] };
  if (n.indexOf('eredivisie') !== -1) return { c: 'netherlands', l: 'eredivisie', s: ['2026-2027', '2025-2026'] };
  if (n.indexOf('primeira liga') !== -1) return { c: 'portugal', l: 'liga-portugal', s: ['2026-2027', '2025-2026'] };
  if (n.indexOf('champions') !== -1) return { c: 'europe', l: 'champions-league', s: ['2026-2027', '2025-2026'] };
  if (n.indexOf('europa league') !== -1) return { c: 'europe', l: 'europa-league', s: ['2026-2027', '2025-2026'] };
  if (n.indexOf('libertadores') !== -1) return { c: 'south-america', l: 'copa-libertadores', s: ['2026', '2025'] };
  return null;
}
function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }
function poisson(l, k) { return (Math.pow(l, k) * Math.exp(-l)) / factorial(k); }
function tau(h, a, hL, aL, rho) {
  if (h === 0 && a === 0) return 1 - hL * aL * rho;
  if (h === 0 && a === 1) return 1 + hL * rho;
  if (h === 1 && a === 0) return 1 + aL * rho;
  if (h === 1 && a === 1) return 1 - rho;
  return 1;
}
function buildRatings(matches, nowMs) {
  const T = {}; let sh = 0, sa = 0, sw = 0;
  matches.forEach(function (m) {
    const hs = m.score && m.score.fullTime ? m.score.fullTime.home : null;
    const as = m.score && m.score.fullTime ? m.score.fullTime.away : null;
    if (hs == null || as == null) return;
    const t = new Date(m.utcDate).getTime();
    const w = Math.exp(-((nowMs - t) / 86400000) / 28);
    const hn = m.homeTeam.name, an = m.awayTeam.name;
    const H = T[hn] = T[hn] || { hg: 0, hga: 0, hn: 0, ag: 0, aga: 0, an: 0 };
    const A = T[an] = T[an] || { hg: 0, hga: 0, hn: 0, ag: 0, aga: 0, an: 0 };
    H.hg += hs * w; H.hga += as * w; H.hn += w;
    A.ag += as * w; A.aga += hs * w; A.an += w;
    sh += hs * w; sa += as * w; sw += w;
  });
  const lH = sw ? sh / sw : 1.35, lA = sw ? sa / sw : 1.15;
  const R = {};
  for (const k in T) {
    const t = T[k];
    const kH = t.hn / (t.hn + 5), kA = t.an / (t.an + 5);
    R[k] = {
      attH: cl(t.hn ? 1 + (((t.hg / t.hn) / lH) - 1) * kH : 1, 0.4, 2.6),
      defH: cl(t.hn ? 1 + (((t.hga / t.hn) / lA) - 1) * kH : 1, 0.4, 2.6),
      attA: cl(t.an ? 1 + (((t.ag / t.an) / lA) - 1) * kA : 1, 0.4, 2.6),
      defA: cl(t.an ? 1 + (((t.aga / t.an) / lH) - 1) * kA : 1, 0.4, 2.6),
      n: t.hn + t.an
    };
  }
  return { R: R, lH: lH, lA: lA };
}
function buildForm(matches) {
  const sorted = matches.slice().sort(function (a, b) { return (a.utcDate || '').localeCompare(b.utcDate || ''); });
  const F = {};
  sorted.forEach(function (m) {
    const hs = m.score && m.score.fullTime ? m.score.fullTime.home : null;
    const as = m.score && m.score.fullTime ? m.score.fullTime.away : null;
    if (hs == null || as == null) return;
    const hn = m.homeTeam.name, an = m.awayTeam.name;
    (F[hn] = F[hn] || []).push(hs > as ? 'W' : hs < as ? 'L' : 'D');
    (F[an] = F[an] || []).push(hs > as ? 'L' : hs < as ? 'W' : 'D');
  });
  const out = {};
  for (const k in F) out[k] = F[k].slice(-5).reverse();
  return out;
}
function buildProbs(hL, aL, sampleN) {
  const maxG = 8; let tot = 0, hW = 0, d = 0, aW = 0; const sc = [];
  for (let h = 0; h <= maxG; h++) for (let a = 0; a <= maxG; a++) {
    const p = poisson(hL, h) * poisson(aL, a) * tau(h, a, hL, aL, RHO);
    tot += p; sc.push({ h: h, a: a, p: p / tot });
    if (h > a) hW += p; else if (h === a) d += p; else aW += p;
  }
  sc.sort(function (x, y) { return y.p - x.p; });
  const s = sampleN / (sampleN + 4); const b = 100 / 3;
  let ph = Math.round(b + (hW / tot * 100 - b) * s);
  let pd = Math.round(b + (d / tot * 100 - b) * s);
  let pa = Math.round(b + (aW / tot * 100 - b) * s);
  if (ph + pd + pa !== 100) pa = 100 - ph - pd;
  return { probs: { home: ph, draw: pd, away: pa }, top: sc.slice(0, 3) };
}
async function fd(path, token, ms) {
  ms = ms || 6000;
  const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, ms);
  try {
    const r = await fetch(API + path, { headers: { 'X-Auth-Token': token }, signal: c.signal });
    if (!r.ok) throw new Error('fd ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function fetchOdds(sport, key) {
  const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, 6000);
  try {
    const r = await fetch(ODDS_API + '/sports/' + sport + '/odds?apiKey=' + key + '&regions=eu&markets=h2h&oddsFormat=decimal', { signal: c.signal });
    if (!r.ok) throw new Error('odds ' + r.status);
    const data = await r.json();
    const list = [];
    (data || []).forEach(function (ev) {
      let h = 0, d = 0, a = 0, n = 0;
      (ev.bookmakers || []).forEach(function (bk) {
        (bk.markets || []).forEach(function (mk) {
          if (mk.key !== 'h2h') return;
          (mk.outcomes || []).forEach(function (oc) {
            if (oc.name === ev.home_team) h += oc.price;
            else if (oc.name === ev.away_team) a += oc.price;
            else if (oc.name === 'Draw') d += oc.price;
          });
          n++;
        });
      });
      if (n > 0 && h && d && a) list.push({ h: h / n, d: d / n, a: a / n, nh: normName(ev.home_team), na: normName(ev.away_team) });
    });
    return list;
  } finally { clearTimeout(t); }
}
function findOdds(list, fh, fa) {
  if (!fh || !fa) return null;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const mh = (fh.indexOf(e.nh) !== -1 || e.nh.indexOf(fh) !== -1);
    const ma = (fa.indexOf(e.na) !== -1 || e.na.indexOf(fa) !== -1);
    if (mh && ma) return e;
  }
  return null;
}
function isUpcoming(status) {
  const s = (status || '').toUpperCase();
  return s.indexOf('FIN') !== 0 && s.indexOf('POST') !== 0;
}
async function fetchStats(cfg, key) {
  for (const season of cfg.s) {
    try {
      const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, 9000);
      const r = await fetch(FPT + '/' + cfg.c + '/' + cfg.l + '/' + season + '?api_key=' + key, { signal: c.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const text = await r.text();
      const lines = text.trim().split(/\r?\n/);
      if (lines.length < 2) continue;
      const head = lines[0].split(',');
      const idx = {}; head.forEach(function (h, i) { idx[h.trim().toLowerCase()] = i; });
      // Búsqueda tolerante de columnas por patrón
      function findCol(test) { for (const k in idx) { if (test(k)) return idx[k]; } return -1; }
      const cHome = idx['home'], cAway = idx['away'];
      if (cHome === undefined || cAway === undefined) continue;
      const cShH = findCol(function (k) { return k.indexOf('shots') !== -1 && k.indexOf('home') !== -1 && k.indexOf('target') === -1 && k.indexOf('off') === -1; });
      const cShA = findCol(function (k) { return k.indexOf('shots') !== -1 && k.indexOf('away') !== -1 && k.indexOf('target') === -1 && k.indexOf('off') === -1; });
      const cSoH = findCol(function (k) { return k.indexOf('home') !== -1 && (k.indexOf('on_target') !== -1 || (k.indexOf('target') !== -1 && k.indexOf('off') === -1)); });
      const cSoA = findCol(function (k) { return k.indexOf('away') !== -1 && (k.indexOf('on_target') !== -1 || (k.indexOf('target') !== -1 && k.indexOf('off') === -1)); });
      const cCoH = findCol(function (k) { return k.indexOf('corner') !== -1 && k.indexOf('home') !== -1; });
      const cCoA = findCol(function (k) { return k.indexOf('corner') !== -1 && k.indexOf('away') !== -1; });
      const cFoH = findCol(function (k) { return k.indexOf('foul') !== -1 && k.indexOf('home') !== -1; });
      const cFoA = findCol(function (k) { return k.indexOf('foul') !== -1 && k.indexOf('away') !== -1; });
      const cYcH = findCol(function (k) { return k.indexOf('yellow') !== -1 && k.indexOf('home') !== -1; });
      const cYcA = findCol(function (k) { return k.indexOf('yellow') !== -1 && k.indexOf('away') !== -1; });
      const cXgH = findCol(function (k) { return k.indexOf('xg') !== -1 && k.indexOf('home') !== -1; });
      const cXgA = findCol(function (k) { return k.indexOf('xg') !== -1 && k.indexOf('away') !== -1; });
      if (cShH === -1 && cXgH === -1) continue;
      const agg = {};
      for (let i = 1; i < lines.length; i++) {
        const col = lines[i].split(',');
        const hn = (col[cHome] || '').trim(), an = (col[cAway] || '').trim();
        if (!hn || !an) continue;
        function num(ci) { if (ci === -1 || ci === undefined) return null; const v = parseFloat(col[ci]); return isFinite(v) ? v : null; }
        const shH = num(cShH), shA = num(cShA), soH = num(cSoH), soA = num(cSoA), coH = num(cCoH), coA = num(cCoA),
          foH = num(cFoH), foA = num(cFoA), ycH = num(cYcH), ycA = num(cYcA), xgH = num(cXgH), xgA = num(cXgA);
        if (shH == null && xgH == null && shA == null && xgA == null) continue;
        const add = function (team, sh, so, co, fo, yc, xg) {
          const a = agg[team] = agg[team] || { sh: 0, sot: 0, cor: 0, fou: 0, yc: 0, xg: 0, n: 0 };
          a.sh += sh || 0; a.sot += so || 0; a.cor += co || 0; a.fou += fo || 0; a.yc += yc || 0; a.xg += xg || 0; a.n++;
        };
        add(hn, shH, soH, coH, foH, ycH, xgH);
        add(an, shA, soA, coA, foA, ycA, xgA);
      }
      const out = {};
      for (const k in agg) {
        const a = agg[k];
        if (a.n < 3) continue;
        out[normName(k)] = {
          sh: +(a.sh / a.n).toFixed(1), sot: +(a.sot / a.n).toFixed(1), cor: +(a.cor / a.n).toFixed(1),
          fou: +(a.fou / a.n).toFixed(1), yc: +(a.yc / a.n).toFixed(1), xg: +(a.xg / a.n).toFixed(2), n: a.n
        };
      }
      if (Object.keys(out).length) return out;
    } catch (e) { /* siguiente temporada */ }
  }
  return null;
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const token = process.env.FOOTBALL_DATA_TOKEN;
  const oddsKey = process.env.ODDS_API_KEY || null;
  const fptKey = process.env.FUTPYTHON_API_KEY || null;
  if (!token) return res.status(500).json({ ok: false, error: 'Falta FOOTBALL_DATA_TOKEN' });
  try {
    const now = Date.now();
    const qDate = req.query.date || null;
    const base = qDate ? new Date(qDate + 'T12:00:00Z') : new Date();
    const from = new Date(base.getTime() - 3 * 86400000).toISOString().split('T')[0];
    const to = new Date(base.getTime() + 6 * 86400000).toISOString().split('T')[0];
    const key = from + '_' + to;

    if (!cache.data || cache.key !== key || now - cache.ts > 30 * 60 * 1000) {
      const all = await Promise.all([
        fd('/matches?dateFrom=' + from + '&dateTo=' + to, token).then(function (r) { return r.matches || []; }).catch(function () { return []; }),
        fd('/competitions/CL/matches?dateFrom=' + from + '&dateTo=' + to, token).then(function (r) { return r.matches || []; }).catch(function () { return []; }),
        fd('/competitions/EL/matches?dateFrom=' + from + '&dateTo=' + to, token).then(function (r) { return r.matches || []; }).catch(function () { return []; })
      ]);
      const map = {};
      all.forEach(function (arr) { arr.forEach(function (m) { map[m.id] = m; }); });
      cache.data = Object.values(map);
      cache.ts = now; cache.key = key;
    }

    const finished = cache.data.filter(function (m) { return !isUpcoming(m.status); });
    const FB = buildRatings(finished, now);

    const comps = {};
    const upcomingComps = {};
    cache.data.forEach(function (m) {
      comps[m.competition.id] = true;
      if (isUpcoming(m.status)) upcomingComps[m.competition.id] = true;
    });
    const missing = Object.keys(comps).filter(function (cid) {
      const e = HIST[cid];
      const ttl = (e && e.ok) ? 60 * 60 * 1000 : 60 * 1000;
      return !e || now - e.ts > ttl;
    });
    missing.sort(function (a, b) { return (upcomingComps[b] ? 1 : 0) - (upcomingComps[a] ? 1 : 0); });
    await Promise.all(missing.slice(0, 5).map(function (cid) {
      return fd('/competitions/' + cid + '/matches?status=FINISHED&limit=80', token)
        .then(function (h) {
          const rr = buildRatings(h.matches || [], now);
          HIST[cid] = { R: rr.R, lH: rr.lH, lA: rr.lA, form: buildForm(h.matches || []), ts: now, ok: true };
        })
        .catch(function () { HIST[cid] = { R: {}, lH: 1.35, lA: 1.15, form: {}, ts: now, ok: false }; });
    }));

    const out = [];
    cache.data.forEach(function (m) {
      const hn = m.homeTeam.name, an = m.awayTeam.name;
      const H = HIST[m.competition.id];
      let src = null;
      if (H && H.ok && H.R[hn] && H.R[an]) src = H;
      else if (FB.R[hn] && FB.R[an]) src = { R: FB.R, lH: FB.lH, lA: FB.lA, form: {} };
      const DEF = { attH: 1, defH: 1, attA: 1, defA: 1, n: 0 };
      const home = src ? (src.R[hn] || DEF) : DEF;
      const away = src ? (src.R[an] || DEF) : DEF;
      const lH = src ? src.lH : 1.35, lA = src ? src.lA : 1.15;
      const hL = cl(lH * home.attH * away.defA, 0.25, 3.6);
      const aL = cl(lA * away.attA * home.defH, 0.2, 3.2);
      const sampleN = (home.n + away.n) / 2;
      const bp = buildProbs(hL, aL, sampleN);
      const formOf = function (team) { return (H && H.form && H.form[team]) ? H.form[team] : []; };
      out.push({
        id: m.id, home: hn, away: an,
        league: m.competition.name, time: m.utcDate, status: m.status,
        score: m.score && m.score.fullTime ? { home: m.score.fullTime.home, away: m.score.fullTime.away } : null,
        probs: bp.probs, modelProbs: bp.probs, main: '', hL: +hL.toFixed(2), aL: +aL.toFixed(2), sampleN: Math.round(sampleN),
        formHome: formOf(hn), formAway: formOf(an),
        odds: null, value: [], stats: null
      });
    });

    if (oddsKey) {
      const sports = {};
      const upSports = {};
      out.forEach(function (p) {
        const s = mapLeague(p.league);
        if (s) { sports[s] = true; if (isUpcoming(p.status)) upSports[s] = true; }
      });
      const need = Object.keys(sports).filter(function (s) {
        const e = ODDS[s]; return !e || now - e.ts > 30 * 60 * 1000;
      });
      need.sort(function (a, b) { return (upSports[b] ? 1 : 0) - (upSports[a] ? 1 : 0); });
      await Promise.all(need.slice(0, 2).map(function (s) {
        return fetchOdds(s, oddsKey)
          .then(function (list) { ODDS[s] = { list: list, ts: now }; })
          .catch(function () { ODDS[s] = { list: [], ts: now }; });
      }));
      out.forEach(function (p) {
        const s = mapLeague(p.league); if (!s || !ODDS[s]) return;
        const o = findOdds(ODDS[s].list, normName(p.home), normName(p.away));
        if (!o) return;
        const ih = 1 / o.h, id = 1 / o.d, ia = 1 / o.a; const t = ih + id + ia;
        const mh = ih / t * 100, md = id / t * 100, ma = ia / t * 100;
        p.odds = { h: +o.h.toFixed(2), d: +o.d.toFixed(2), a: +o.a.toFixed(2) };
        p.marketProbs = { home: Math.round(mh), draw: Math.round(md), away: Math.round(ma) };
        p.probs = {
          home: Math.round(p.modelProbs.home * (1 - MARKET_W) + mh * MARKET_W),
          draw: Math.round(p.modelProbs.draw * (1 - MARKET_W) + md * MARKET_W),
          away: Math.round(p.modelProbs.away * (1 - MARKET_W) + ma * MARKET_W)
        };
        if (p.probs.home + p.probs.draw + p.probs.away !== 100) p.probs.away = 100 - p.probs.home - p.probs.draw;
        const v = [];
        if (p.modelProbs.home - mh >= 4) v.push({ side: '1', edge: Math.round(p.modelProbs.home - mh) });
        if (p.modelProbs.draw - md >= 4) v.push({ side: 'X', edge: Math.round(p.modelProbs.draw - md) });
        if (p.modelProbs.away - ma >= 4) v.push({ side: '2', edge: Math.round(p.modelProbs.away - ma) });
        p.value = v;
      });
    }

    if (fptKey) {
      const srcs = {};
      out.forEach(function (p) {
        if (!isUpcoming(p.status)) return;
        const cfg = statsSource(p.league);
        if (cfg) srcs[p.league] = cfg;
      });
      const needS = Object.keys(srcs).filter(function (lg) {
        const e = STATS[lg]; return !e || now - e.ts > 20 * 60 * 60 * 1000;
      }).slice(0, 3);
      for (const lg of needS) {
        const agg = await fetchStats(srcs[lg], fptKey);
        STATS[lg] = { agg: agg, ts: now };
      }
      out.forEach(function (p) {
        const e = STATS[p.league];
        if (!e || !e.agg) return;
        const h = e.agg[normName(p.home)], a = e.agg[normName(p.away)];
        if (h && a) p.stats = { home: h, away: a };
      });
    }

    out.forEach(function (p) {
      p.main = p.probs.home >= p.probs.draw && p.probs.home >= p.probs.away ? 'home'
        : p.probs.away >= p.probs.home && p.probs.away >= p.probs.draw ? 'away' : 'draw';
    });
    out.sort(function (a, b) { return (a.time || '').localeCompare(b.time || ''); });
    res.status(200).json({ ok: true, count: out.length, window: { from, to }, oddsEnabled: !!oddsKey, statsEnabled: !!fptKey, predictions: out, generated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
      }
