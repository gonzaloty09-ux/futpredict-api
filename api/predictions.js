const API = 'https://api.football-data.org/v4';
const ODDS_API = 'https://api.the-odds-api.com/v4';
export const maxDuration = 20;
import { espnMatches, sameFixture, espnRefresh, espnRestore, espnHistFeeds, espnInfo, espnAggs, buildAggMap, compactAgg } from './espn.js';
import { computeElo, eloLambda, buildH2H, h2hOf, leagueWeights, statPreds, bumpStats } from './pro.js';
const cache = { data: null, ts: 0, key: '' };
let FD_ERRS = [];
const HIST = {};
const ODDS = {};
const STATS = {};
let SEEDED = null;
let SEED_TS = 0;
let ODDS_LEFT = null;
let ODDS_LEFT_TS = 0;
let KV_READY = false;
let KV_LOADED = 0;
let KV_ERR = null;
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
function slimMatches(ms) {
return ms.map(function (m) {
const ft = m.score && m.score.fullTime ? { home: m.score.fullTime.home, away: m.score.fullTime.away } : { home: null, away: null };
return { utcDate: m.utcDate, homeTeam: { name: m.homeTeam.name }, awayTeam: { name: m.awayTeam.name }, score: { fullTime: ft } };
});
}
function mkHist(ms, ts, now) {
const rr = buildRatings(ms, now);
return { R: rr.R, lH: rr.lH, lA: rr.lA, form: buildForm(ms), _matches: ms, ts: ts, ok: true, count: ms.length };
}
async function kvSave(k, v) {
try { await dbq('insert into kv (k, v, ts) values ($1, $2::jsonb, now()) on conflict (k) do update set v = excluded.v, ts = now()', [k, JSON.stringify(v)], 3000); } catch (e) { KV_ERR = String((e && e.message) || e); }
}
async function kvLoad(now) {
if (now - KV_LOADED < 60000) return;
KV_LOADED = now;
try {
if (!KV_READY) { await dbq('create table if not exists kv (k text primary key, v jsonb, ts timestamptz default now()')); KV_READY = true; }
const rows = await dbq('select k, v, (extract(epoch from ts) * 1000)::float8 as ms from kv');
KV_ERR = null;
rows.forEach(function (r) {
let v = r.v; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return; } }
const ms = Number(r.ms);
if (r.k.indexOf('h:') === 0 && v && v.matches) {
const cid = r.k.slice(2);
if (!HIST[cid] || !HIST[cid].ok || HIST[cid].ts < ms) HIST[cid] = mkHist(v.matches, ms, now);
} else if (r.k.indexOf('o:') === 0 && v && v.list) {
const sp = r.k.slice(2);
if (!ODDS[sp] || ODDS[sp].ts < ms) ODDS[sp] = { list: v.list, ts: ms };
} else if (r.k.indexOf('e:espn:') === 0 && v && v.fin) {
espnRestore(r.k.slice(7), v, ms);
} else if (r.k === 'es:stats' && v && typeof v === 'object') {
Object.keys(v).forEach(function (t) { if (!STATS[t] || (v[t] && (v[t].n || 0) >= (STATS[t].n || 0))) STATS[t] = v[t]; });
} else if (r.k === 'es:seeded' && v && typeof v === 'object') {
if (!SEEDED || Object.keys(v).length > Object.keys(SEEDED).length) SEEDED = v;
} else if (r.k === 'm:left' && v && v.left != null && ms > ODDS_LEFT_TS) {
ODDS_LEFT = Number(v.left); ODDS_LEFT_TS = ms;
}
});
} catch (e) { KV_ERR = String((e && e.message) || e); }
}
const RHO = -0.06;
const MARKET_W = 0.4;
async function statsSeed(now, kvSave) {
if (now - SEED_TS < 45000) return;
SEED_TS = now;
if (!SEEDED) SEEDED = {};
if (Object.keys(SEEDED).length > 2000) SEEDED = {};
const cands = espnMatches()
.filter(function (m) { return m.status === 'FINISHED' && m.score && m.score.fullTime && m.score.fullTime.home != null && !SEEDED[m.id]; });
const upTeams = {};
espnMatches().forEach(function (m) {
if (m.status !== 'SCHEDULED' && m.status !== 'IN_PLAY7) return;
upTeams[m.homeTeam.name] = 1; upTeams[m.awayTeam.name] = 1;
});
cands.sort(function (a, b) {
const ua = (upTeams[a.homeTeam.name] || upTeams[a.awayTeam.name]) ? 1 : 0;
const ub = (upTeams[b.homeTeam.name] || upTeams[b.awayTeam.name]) ? 1 : 0;
if (ua !== ub) return ub - ua;
return (b.utcDate || '').localeCompare(a.utcDate || '');
});
const list = cands.slice(0, 8);
if (!list.length) return;
let ch = false;
await Promise.all(list.map(function (m) {
const code = String(m.competition.id).slice(5), ev = String(m.id).slice(5);
const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, 6000);
return fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + code + '/summary?event=' + ev, { signal: c.signal })
.then(function (r) { return r.ok ? r.json() : null; })
.then(function (s) {
clearTimeout(t);
SEEDED[m.id] = 1;
if (!s || !s.boxscore || !s.boxscore.teams) return;
const st = function (team, name) { const x = (team.statistics || []).find(function (z) { return z.name === name; }); return x ? parseFloat(x.displayValue) : null; };
s.boxscore.teams.forEach(function (tm) {
if (!tm.team || !tm.team.displayName) return;
const o = {
sh: st(tm, 'totalShots'), sot: st(tm, 'shotsOnTarget'), pos: st(tm, 'possessionPct'),
cor: st(tm, 'wonCorners'), fou: st(tm, 'foulsCommitted'), yc: st(tm, 'yellowCards'),
sav: st(tm, 'saves'), off: st(tm, 'offsides'), rc: st(tm, 'redCards')
};
if (Object.keys(o).some(function (k) { return o[k] != null; })) { if (bumpStats(STATS, tm.team.displayName, o)) ch = true; }
});
})
.catch(function () { clearTimeout(t); });
}));
if (ch) { await kvSave('es:stats', STATS); await kvSave('es:seeded', SEEDED); }
}
const DECAY_D = 60;
const HIST_MAX = 200;
function cors(res) {
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
function cl(v, a, b) { return Math.max(a, Math.min(b, v)); }
function normName(s) {
return String(s).toLowerCase()
.replace(/[áàäâéèëêìéìüéëëæééþëíì], function (c) {
return { á: 'a', à: 'a', ä: 'a', â: 'a', é: 'e', é: 'e', ë: 'e', é: 'e', í: 'i', ø: 'i', ï: 'i', î: 'i', ó: 'o', ò: 'o', ö: 'o', ô: 'o', ú: 'u', ù: 'u', ü: 'u', û: 'u', ñ: 'n', ÷: 'c' }[c] || c;
})
.replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
function mapLeague(name) {
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
if (n.indexOf('mls') !== -1 || n.indexOf('major league soccer') !== -1) return 'soccer_usa_lms';
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
function invLambda(pOver) {
let best = 1.5, bd = 9;
for (let l = 0.4; l <= 4.6; l += 0.05) {
const p = 1 - poisson(l, 0) - poisson(l, 1) - poisson(l, 2);
const d = Math.abs(p - pOver);
if (d < bd) { bd = d; best = l; }
}
return best;
}
function buildRatings(matches, nowMs) {
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
const p = poisson(hL, h) * poisson(aL, a) * tau(h, a, hL, aL, RLO);
tot += p; sc.push({ h: h, a: a, p: p / tot });
if (h > a) hW += p; else if (h === a) d += p; else aW += p;
}
sc.sort(function (x y, y) { return y.p - x.p; });
const s = sampleN / (sampleN + 4); const b = 100 / 3;
let ph = Math.round(b + (hW / tot * 100 - b) * s);
let pd = Math.round(b + (d / tot * 100 - b) * s);
let pa = Math.round(b + (aW / tot * 100 - b) * s);
if (ph + pd + pa !== 100) pa = 100 - ph - pd;
return { probs: { home: ph, draw: pd, away: pa }, top: sc.slice(0, 3) };
}
async function fd(path, token, ms) {
ms = ms || 5000;
const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, ms);
try {
const r = await fetch(API + path, { headers: { 'X-Auth-Token': token }, signal: c.signal });
if (!r.ok) throw new Error('fd ' + r.status);
return await r.json();
} finally { clearTimeout(t); }
}
async function fetchOdds(sport, key) {
const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, 5000);
try {
const r = await fetch(ODDS_API + '/sports/' + sport + '/odds?apiKey=' + key + '&regions=eu&markets=h2h,totals&oddsFormat=decimal', { signal: c.signal });
const left = r.headers.get('x-requests-remaining');
if (left != null && left !== '') { ODDS_LEFT = Number(left); ODDS_LEFT_TS = Date.now(); }
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
(mkk.outcomes || []).forEach(function (oc) {
if (oc.point === 2.5) { got = true; if (oc.name === 'Over') ov += oc.price; else if (oc.name === 'Under') un += oc.price; }
});
if (got) nb++;
}
});
});
if (n > 0 && h && d && a) list.push({ h: h / n, d: d / n, a: a / n, ov: nb ? ov / nb : 0, un: nb ? un / nb : 0, nh: normName(ev.home_team), na: normName(ev.away_team) });
});
return list;
} finally { clearTimeout(t); }
}
const GENERIC = { fc: 1, sc: 1, ca: 1, cd: 1, ec: 1, rb: 1, cf: 1, ac: 1, as: 1, afc: 1, club: 1, clube: 1, de: 1, do: 1, da: 1 };
function nameTokens(n) {
return String(n).split(' ').filter(function (w) { return w && !GENERIC[w]; });
}
function sameTeam(a, b) {
if (!a || !b) return false;
if (a.indexOf(b) !== -1 || b.indexOf(a) !== -1) return true;
const ta = nameTokens(a), tb = nameTokens(b);
if (!ta.length || !tb.length) return false;
const small = ta.length <= tb.length ? ta : tb;
const big = ta.length <= tb.length ? tb : ta;
return small.every(function (w) { return big.indexOf(w) !== -1; });
}
function findOdds(list, fh, fa) {
if (!fh || !fa) return null;
for (let i = 0; i < list.length; i++) {
const e = list[i];
if (sameTeam(fh, e.nh) && sameTeam(fa, e.na)) return e;
}
return null;
}
function isUpcoming(status) {
const s = (status || '').toUpperCase();
return s.indexOf('FIN') !== 0 && s.indexOf('POST') !== 0;
}
export default async function handler(req, res) {
cors(res);
res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
if (req.method === 'OPTIONS') return res.status(200).end();
const token = process.env.FOOTBALL_DATA_TOKEN;
const oddsKey = process.env.ODDS_API_KEY || null;
if (!token) return res.status(500).json({ ok: false, error: 'Falta FOOTBALL_DATA_TOKEN' });
try {
const now = Date.now();
const qDate = req.query.date || null;
const base = q Date ? null : null;
} catch (e) { }
}
