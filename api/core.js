// Utilidades del modelo: DB, ratings Dixon-Coles, Poisson, mapeo de ligas, cuotas.
export const DECAY_D = 60;

export async function dbq(sql, params, ms) {
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
export function slimMatches(ms) {
  return ms.map(function (m) {
    const ft = m.score && m.score.fullTime ? { home: m.score.fullTime.home, away: m.score.fullTime.away } : { home: null, away: null };
    return { utcDate: m.utcDate, homeTeam: { name: m.homeTeam.name }, awayTeam: { name: m.awayTeam.name }, score: { fullTime: ft } };
  });
}
export function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
export function cl(v, a, b) { return Math.max(a, Math.min(b, v)); }
export function normName(s) {
  return String(s).toLowerCase()
    .replace(/[áàäâéèëêíìïîóòöôúùüûñç]/g, function (c) {
      return { á: 'a', à: 'a', ä: 'a', â: 'a', é: 'e', è: 'e', ë: 'e', ê: 'e', í: 'i', ì: 'i', ï: 'i', î: 'i', ó: 'o', ò: 'o', ö: 'o', ô: 'o', ú: 'u', ù: 'u', ü: 'u', û: 'u', ñ: 'n', ç: 'c' }[c] || c;
    })
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
export function mapLeague(name) {
  const n = String(name).toLowerCase();
  if (n.indexOf('bundesliga 2') !== -1 || n.indexOf('2. bundesliga') !== -1) return null;
  if (n.indexOf('serie b') !== -1 || n.indexOf('série b') !== -1) return null;
  if (n.indexOf('ligue 2') !== -1) return null;
  if (n.indexOf('laliga 2') !== -1) return null;
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
  if (n.indexOf('sudamericana') !== -1) return 'soccer_conmebol_sudamericana';
  if (n.indexOf('brasileiro') !== -1 || n.indexOf('brasileirão') !== -1) return 'soccer_brazil_campeonato';
  if (n.indexOf('mls') !== -1 || n.indexOf('major league soccer') !== -1) return 'soccer_usa_mls';
  if (n.indexOf('world cup') !== -1 || n.indexOf('mundial') !== -1) return 'soccer_fifa_world_cup';
  if (n.indexOf('euro') !== -1 && n.indexOf('championship') !== -1) return 'soccer_uefa_european_championship';
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
const RHO = -0.06;
export function invLambda(pOver) {
  let best = 1.5, bd = 9;
  for (let l = 0.4; l <= 4.6; l += 0.05) {
    const p = 1 - poisson(l, 0) - poisson(l, 1) - poisson(l, 2);
    const d = Math.abs(p - pOver);
    if (d < bd) { bd = d; best = l; }
  }
  return best;
}
export function buildRatings(matches, nowMs) {
  const T = {}; let sh = 0, sa = 0, sw = 0;
  matches.forEach(function (m) {
    const hs = m.score && m.score.fullTime ? m.score.fullTime.home : null;
    const as = m.score && m.score.fullTime ? m.score.fullTime.away : null;
    if (hs == null || as == null) return;
    const t = new Date(m.utcDate).getTime();
    const w = Math.exp(-((nowMs - t) / 86400000) / DECAY_D);
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
export function buildForm(matches) {
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
export function mkHist(ms, ts, now) {
  const rr = buildRatings(ms, now);
  return { R: rr.R, lH: rr.lH, lA: rr.lA, form: buildForm(ms), _matches: ms, ts: ts, ok: true, count: ms.length };
}
export function buildProbs(hL, aL, sampleN, rho) {
  const R = rho != null ? rho : RHO;
  const maxG = 8; let tot = 0, hW = 0, d = 0, aW = 0; const sc = [];
  for (let h = 0; h <= maxG; h++) for (let a = 0; a <= maxG; a++) {
    const p = poisson(hL, h) * poisson(aL, a) * tau(h, a, hL, aL, R);
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
export async function fd(path, token, ms) {
  ms = ms || 5000;
  const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, ms);
  try {
    const r = await fetch('https://api.football-data.org/v4' + path, { headers: { 'X-Auth-Token': token }, signal: c.signal });
    if (!r.ok) throw new Error('fd ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
export async function fetchOdds(sport, key) {
  const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, 5000);
  try {
    const r = await fetch('https://api.the-odds-api.com/v4/sports/' + sport + '/odds?apiKey=' + key + '&regions=eu&markets=h2h,totals&oddsFormat=decimal', { signal: c.signal });
    const left = r.headers.get('x-requests-remaining');
    if (!r.ok) throw new Error('odds ' + r.status);
    const data = await r.json();
    const list = [];
    (data || []).forEach(function (ev) {
      let h = 0, d = 0, a = 0, n = 0, ov = 0, un = 0, nb = 0;
      (ev.bookmakers || []).forEach(function (bk) {
        (bk.markets || []).forEach(function (mk) {
          if (mk.key === 'h2h') {
            (mk.outcomes || []).forEach(function (oc) {
              if (oc.name === ev.home_team) h += oc.price;
              else if (oc.name === ev.away_team) a += oc.price;
              else if (oc.name === 'Draw') d += oc.price;
            });
            n++;
          } else if (mk.key === 'totals') {
            let got = false;
            (mk.outcomes || []).forEach(function (oc) {
              if (oc.point === 2.5) { got = true; if (oc.name === 'Over') ov += oc.price; else if (oc.name === 'Under') un += oc.price; }
            });
            if (got) nb++;
          }
        });
      });
      if (n > 0 && h && d && a) list.push({ h: h / n, d: d / n, a: a / n, ov: nb ? ov / nb : 0, un: nb ? un / nb : 0, nh: normName(ev.home_team), na: normName(ev.away_team) });
    });
    return { list: list, left: (left != null && left !== '') ? Number(left) : null };
  } finally { clearTimeout(t); }
}
const GENERIC = { fc: 1, sc: 1, ca: 1, cd: 1, ec: 1, rb: 1, cf: 1, ac: 1, as: 1, afc: 1, club: 1, clube: 1, de: 1, do: 1, da: 1 };
function nameTokens(n) {
  return String(n).split(' ').filter(function (w) { return w && !GENERIC[w]; });
}
export function sameTeam(a, b) {
  if (!a || !b) return false;
  if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return true;
  const ta = nameTokens(a), tb = nameTokens(b);
  if (!ta.length || !tb.length) return false;
  let small = ta, big = tb;
  if (ta.length > tb.length) { small = tb; big = ta; }
  let hit = 0;
  for (let i = 0; i < small.length; i++) { if (big.indexOf(small[i]) !== -1) hit++; }
  return hit === small.length;
}
export function findOdds(list, fh, fa) {
  if (!fh || !fa) return null;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    if (sameTeam(fh, e.nh) && sameTeam(fa, e.na)) return e;
  }
  return null;
}
export function isUpcoming(status) {
  const s = (status || '').toUpperCase();
  return s.indexOf('FIN') !== 0 && s.indexOf('POST') !== 0;
}
