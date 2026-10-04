export const maxDuration = 20;
import { dbq, slimMatches, mkHist, buildRatings, buildProbs, invLambda, normName, mapLeague, fd, fetchOdds, findOdds, isUpcoming, cors, cl } from './core.js';
import { espnMatches, sameFixture, espnRefresh, espnRestore, espnHistFeeds, espnInfo, espnAggs, buildAggMap, compactAgg } from './espn.js';
import { computeElo, eloLambda, buildH2H, h2hOf, leagueWeights, statPreds, bumpStats, bumpAllowed, perfFactor } from './pro.js';

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
const MARKET_W = 0.4;
const HIST_MAX = 200;
// Rate limit por IP (ventana fija de 1 minuto, en memoria por instancia).
const RL = {};
function rateOk(req) {
  const ip = String(((req.headers['x-forwarded-for'] || '') + '').split(',')[0] || 'x').trim();
  const min = Math.floor(Date.now() / 60000);
  if (Object.keys(RL).length > 800) { Object.keys(RL).forEach(function (k) { if (RL[k].min !== min) delete RL[k]; }); }
  const e = RL[ip];
  if (!e || e.min !== min) { RL[ip] = { min: min, n: 1 }; return true; }
  e.n++;
  return e.n <= 60;
}

async function kvSave(k, v) {
  try { await dbq('insert into kv (k, v, ts) values ($1, $2::jsonb, now()) on conflict (k) do update set v = excluded.v, ts = now()', [k, JSON.stringify(v)], 3000); } catch (e) { KV_ERR = String((e && e.message) || e); }
}
async function kvLoad(now) {
  if (now - KV_LOADED < 15000) return;
  KV_LOADED = now;
  try {
    if (!KV_READY) { await dbq('create table if not exists kv (k text primary key, v jsonb, ts timestamptz default now())'); KV_READY = true; }
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
        // Union de claves: las instancias colaboran, nunca se pisan el progreso.
        SEEDED = Object.assign(SEEDED || {}, v);
      } else if (r.k === 'm:left' && v && v.left != null && ms > ODDS_LEFT_TS) {
        ODDS_LEFT = Number(v.left); ODDS_LEFT_TS = ms;
      }
    });
  } catch (e) { KV_ERR = String((e && e.message) || e); }
}
async function statsSeed(now) {
  if (now - SEED_TS < 20000) return;
  SEED_TS = now;
  if (!SEEDED) SEEDED = {};
  if (Object.keys(SEEDED).length > 4000) SEEDED = {};
  const colecta = function (ev) {
    const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, 6000);
    return fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + ev.path, { signal: c.signal })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (s) {
        clearTimeout(t);
        if (!s || !s.boxscore || !s.boxscore.teams) return false;
        const st = function (team, name) { const x = (team.statistics || []).find(function (z) { return z.name === name; }); return x ? parseFloat(x.displayValue) : null; };
        let ch = false;
        const arr = [];
        // Goles reales del partido (header) para medir sobre/sub-rendimiento vs xG estimado.
        const goals = {};
        try {
          ((s.header || {}).competitions || []).forEach(function (cc) {
            (cc.competitors || []).forEach(function (cp) { if (cp.id != null && cp.score != null) goals[String(cp.id)] = parseFloat(cp.score); });
          });
        } catch (e) {}
        s.boxscore.teams.forEach(function (tm) {
          if (!tm.team || !tm.team.displayName) return;
          const o = {
            sh: st(tm, 'totalShots'), sot: st(tm, 'shotsOnTarget'), pos: st(tm, 'possessionPct'),
            cor: st(tm, 'wonCorners'), fou: st(tm, 'foulsCommitted'), yc: st(tm, 'yellowCards'),
            sav: st(tm, 'saves'), off: st(tm, 'offsides'), rc: st(tm, 'redCards'),
            blo: st(tm, 'blockedShots'), pas: st(tm, 'totalPasses'), cru: st(tm, 'totalCrosses'),
            lon: st(tm, 'totalLongBalls'), tac: st(tm, 'totalTackles'), int: st(tm, 'interceptions'),
            cle: st(tm, 'totalClearance'), pko: st(tm, 'penaltyKickGoals'), pks: st(tm, 'penaltyKickShots'),
            apas: st(tm, 'accuratePasses'), acru: st(tm, 'accurateCrosses'), alon: st(tm, 'accurateLongBalls'),
            etac: st(tm, 'effectiveTackles')
          };
          const my = goals[String(tm.team.id)];
          if (my != null && isFinite(my)) o.gf = my;
          // xG estimado propio (sin API externa): SoT ~0.25, tiro fuera ~0.04, penal ~0.79.
          if (o.sot != null) {
            const xg = 0.25 * o.sot + 0.04 * Math.max(0, (o.sh || 0) - o.sot) + 0.79 * (o.pko || 0);
            o.xg = Math.round(xg * 100) / 100;
          }
          arr.push({ name: tm.team.displayName, o: o, home: tm.homeAway === 'home' });
        });
        if (arr.length === 2 && arr[0].o.gf != null && arr[1].o.gf != null) { arr[0].o.ga = arr[1].o.gf; arr[1].o.ga = arr[0].o.gf; }
        arr.forEach(function (x) {
          if (Object.keys(x.o).some(function (k) { return x.o[k] != null; })) { if (bumpStats(STATS, x.name, x.o, x.home)) ch = true; }
        });
        if (arr.length === 2) {
          if (bumpAllowed(STATS, arr[0].name, arr[1].o)) ch = true;
          if (bumpAllowed(STATS, arr[1].name, arr[0].o)) ch = true;
        }
        return ch;
      })
      .catch(function () { clearTimeout(t); return false; });
  };

  // Fase 1: partidos proximos con algun equipo sin datos -> colectar los ultimos 5 de cada uno
  // (el summary del proximo expone los IDs de esos 10 partidos; cada boxscore aporta stats de 2 equipos).
  // Solo se marca como hecho si la colecta tuvo exito: los fallidos se reintentan en el proximo ciclo.
  const necesita = function (nm) { const s = STATS[nm]; return !s || (s.sh || []).length < 3; };
  const up = espnMatches()
    .filter(function (m) { return (m.status === 'SCHEDULED' || m.status === 'IN_PLAY') && (necesita(m.homeTeam.name) || necesita(m.awayTeam.name)); })
    .sort(function (a, b) { return (a.utcDate || '').localeCompare(b.utcDate || ''); })
    .slice(0, 6);
  for (const m of up) {
    if (SEEDED['L5:' + m.id]) continue;
    const code = String(m.competition.id).slice(5);
    const sum = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + code + '/summary?event=' + String(m.id).slice(5)).then(function (x) { return x.ok ? x.json() : null; }).catch(function () { return null; });
    if (!sum || !sum.lastFiveGames) continue;
    const ids = [];
    sum.lastFiveGames.forEach(function (e) {
      (e.events || []).forEach(function (ev) { if (ev.id && ids.indexOf(String(ev.id)) === -1) ids.push(String(ev.id)); });
    });
    if (!ids.length) continue;
    const res = await Promise.all(ids.slice(0, 10).map(function (gid) {
      if (SEEDED['g:' + gid]) return Promise.resolve(false);
      return colecta({ path: code + '/summary?event=' + gid }).then(function (ok) { if (ok) SEEDED['g:' + gid] = 1; return ok; });
    }));
    if (res.some(function (x) { return x; })) SEEDED['L5:' + m.id] = 1;
    await kvSave('es:stats', STATS); await kvSave('es:seeded', SEEDED);
  }

  // Fase 2: partidos finalizados directamente (llenado general).
  const cands = espnMatches()
    .filter(function (m) { return m.status === 'FINISHED' && m.score && m.score.fullTime && m.score.fullTime.home != null && !SEEDED[m.id]; });
  const upTeams = {};
  espnMatches().forEach(function (m) {
    if (m.status !== 'SCHEDULED' && m.status !== 'IN_PLAY') return;
    upTeams[m.homeTeam.name] = 1; upTeams[m.awayTeam.name] = 1;
  });
  cands.sort(function (a, b) {
    const ua = (upTeams[a.homeTeam.name] || upTeams[a.awayTeam.name]) ? 1 : 0;
    const ub = (upTeams[b.homeTeam.name] || upTeams[b.awayTeam.name]) ? 1 : 0;
    if (ua !== ub) return ub - ua;
    return (b.utcDate || '').localeCompare(a.utcDate || '');
  });
  const list = cands.slice(0, 12);
  if (!list.length) return;
  let ch = false;
  await Promise.all(list.map(function (m) {
    const code = String(m.competition.id).slice(5), ev = String(m.id).slice(5);
    SEEDED[m.id] = 1;
    return colecta({ path: code + '/summary?event=' + ev }).then(function (c) { if (c) ch = true; });
  }));
  if (ch) { await kvSave('es:stats', STATS); await kvSave('es:seeded', SEEDED); }
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method' });
  if (!rateOk(req)) return res.status(429).json({ ok: false, error: 'rate limit: esperá un momento y recargá' });
  const token = process.env.FOOTBALL_DATA_TOKEN;
  const oddsKey = process.env.ODDS_API_KEY || null;
  if (!token) return res.status(500).json({ ok: false, error: 'Falta FOOTBALL_DATA_TOKEN' });
  try {
    const now = Date.now();
    const qDate = req.query.date || null;
    const base = qDate ? new Date(qDate + 'T12:00:00Z') : new Date();
    const from = new Date(base.getTime() - 3 * 86400000).toISOString().split('T')[0];
    const to = new Date(base.getTime() + 6 * 86400000).toISOString().split('T')[0];
    const key = from + '_' + to;
    const fromMs = new Date(from + 'T00:00:00Z').getTime();

    if (!cache.data || cache.key !== key || now - cache.ts > 30 * 60 * 1000) {
      FD_ERRS = [];
      const grab = function (label) { return function (e) { FD_ERRS.push(label + ': ' + String((e && e.message) || e)); return []; }; };
      const all = await Promise.all([
        fd('/matches?dateFrom=' + from + '&dateTo=' + to, token).then(function (r) { return r.matches || []; }).catch(grab('matches')),
        fd('/competitions/CL/matches?dateFrom=' + from + '&dateTo=' + to, token).then(function (r) { return r.matches || []; }).catch(grab('CL')),
        fd('/competitions/EL/matches?dateFrom=' + from + '&dateTo=' + to, token).then(function (r) { return r.matches || []; }).catch(grab('EL')),
        fd('/competitions/WC/matches?dateFrom=' + from + '&dateTo=' + to, token).then(function (r) { return r.matches || []; }).catch(grab('WC')),
        fd('/competitions/EC/matches?dateFrom=' + from + '&dateTo=' + to, token).then(function (r) { return r.matches || []; }).catch(grab('EC'))
      ]);
      const map = {};
      all.forEach(function (arr) { arr.forEach(function (m) { map[m.id] = m; }); });
      const arr2 = Object.values(map);
      if (arr2.length) { cache.data = arr2; cache.ts = now; cache.key = key; }
    }
    if (!cache.data) cache.data = [];

    await kvLoad(now);
    await espnRefresh(now, kvSave);
    await statsSeed(now);
    const LGW = await leagueWeights(dbq, now);

    espnHistFeeds().forEach(function (f) {
      if (HIST[f.cid] && HIST[f.cid].ok && now - HIST[f.cid].ts < 15 * 60 * 1000) return;
      HIST[f.cid] = mkHist(slimMatches(f.fin), now, now);
    });

    const esM = espnMatches().filter(function (em) {
      return !cache.data.some(function (f) { return sameFixture(f, em); });
    });
    const DATA = cache.data.concat(esM);

    if (!DATA.length) {
      return res.status(200).json({ ok: true, count: 0, window: { from, to }, oddsEnabled: !!oddsKey, predictions: [], generated: new Date().toISOString(), errors: FD_ERRS, note: 'cargando, volvé a abrir en unos segundos' });
    }

    const finished = DATA.filter(function (m) { return !isUpcoming(m.status); });
    const FB = buildRatings(finished, now);
    const EL = computeElo(finished);
    const H2HMAP = buildH2H(finished);
    const isE = function (m) { return String(m.competition.id).indexOf('espn:') === 0; };

    const teamFin = {};
    finished.forEach(function (m) {
      const t = new Date(m.utcDate).getTime();
      (teamFin[m.homeTeam.name] = teamFin[m.homeTeam.name] || []).push(t);
      (teamFin[m.awayTeam.name] = teamFin[m.awayTeam.name] || []).push(t);
    });
    for (const cid in HIST) {
      const H = HIST[cid];
      if (!H || !H.ok || !H._matches) continue;
      H._matches.forEach(function (m) {
        const t = new Date(m.utcDate).getTime();
        (teamFin[m.homeTeam.name] = teamFin[m.homeTeam.name] || []).push(t);
        (teamFin[m.awayTeam.name] = teamFin[m.awayTeam.name] || []).push(t);
      });
    }
    for (const k in teamFin) teamFin[k].sort(function (a, b) { return a - b; });
    function restDays(team, tMs) {
      const arr = teamFin[team]; if (!arr) return null;
      let last = null;
      for (const x of arr) { if (x < tMs - 3600000) last = x; else break; }
      if (last == null) return null;
      return Math.round((tMs - last) / 86400000);
    }
    function restFactor(r) { if (r == null) return 1; if (r <= 3) return 0.94; if (r >= 8) return 1.03; return 1; }

    const comps = {};
    const upCount = {};
    DATA.forEach(function (m) {
      comps[m.competition.id] = true;
      if (isUpcoming(m.status)) upCount[m.competition.id] = (upCount[m.competition.id] || 0) + 1;
    });
    const missing = Object.keys(comps).filter(function (cid) {
      if (String(cid).indexOf('espn:') === 0) return false;
      const e = HIST[cid];
      const ttl = (e && e.ok) ? 3 * 60 * 60 * 1000 : 60 * 1000;
      return !e || now - e.ts > ttl;
    });
    missing.sort(function (a, b) {
      const ea = HIST[a] ? 1 : 0, eb = HIST[b] ? 1 : 0;
      if (ea !== eb) return ea - eb;
      return (upCount[b] || 0) - (upCount[a] || 0);
    });
    await Promise.all(missing.slice(0, 4).map(function (cid) {
      return fd('/competitions/' + cid + '/matches?status=FINISHED', token, 6000)
        .then(function (h) {
          const ms = slimMatches((h.matches || []).slice().sort(function (a, b) { return (b.utcDate || '').localeCompare(a.utcDate || ''); }).slice(0, HIST_MAX));
          HIST[cid] = mkHist(ms, now, now);
          return kvSave('h:' + cid, { matches: ms });
        })
        .catch(function (e) { HIST[cid] = { R: {}, lH: 1.35, lA: 1.15, form: {}, ts: now, ok: false, err: String((e && e.message) || e) }; });
    }));

    const AGGS = espnAggs();
    // Rho calibrado por liga: si la liga empata más de lo esperado (25% típico), rho más negativo
    // aumenta la masa de marcadores bajos (0-0, 1-1); si empata menos, se relaja. Acotado [-0.12, 0.02].
    const RHO_L = {};
    for (const cid in HIST) {
      const H = HIST[cid];
      if (!H || !H.ok || !H._matches || !H._matches.length) continue;
      const fin = H._matches.filter(function (m) { return m.score && m.score.fullTime && m.score.fullTime.home != null && m.score.fullTime.away != null; });
      if (fin.length < 20) { RHO_L[cid] = -0.06; continue; }
      const dr = fin.filter(function (m) { return m.score.fullTime.home === m.score.fullTime.away; }).length / fin.length;
      RHO_L[cid] = Math.max(-0.12, Math.min(0.02, -0.06 + (dr - 0.25) * 0.25));
    }
    const rhoOf = function (cid) { return RHO_L[cid] != null ? RHO_L[cid] : -0.06; };
    const fdFin = {};
    DATA.forEach(function (m) {
      if (String(m.competition.id).indexOf('espn:') === 0) return;
      if (isUpcoming(m.status) || !m.score || !m.score.fullTime || m.score.fullTime.home == null || m.score.fullTime.away == null) return;
      (fdFin[m.competition.id] = fdFin[m.competition.id] || []).push(m);
    });
    Object.keys(fdFin).forEach(function (cid) {
      if (AGGS[cid]) return;
      const c = compactAgg(buildAggMap(fdFin[cid]));
      if (Object.keys(c).length) AGGS[cid] = c;
    });

    const out = [];
    DATA.forEach(function (m) {
      const tMs = new Date(m.utcDate).getTime();
      if (tMs < fromMs) return;
      const hn = m.homeTeam.name, an = m.awayTeam.name;
      const H = HIST[m.competition.id];
      // Ratings cruzados: si el historial propio de la competencia tiene poca muestra por equipo
      // (tipico en copas), se usa el pool global (incluye liga local) que es mas estable.
      let src = null;
      if (H && H.ok && H.R[hn] && H.R[an] && (H.R[hn].n + H.R[an].n) >= 8) src = H;
      else if (FB.R[hn] && FB.R[an]) src = { R: FB.R, lH: FB.lH, lA: FB.lA, form: {} };
      else if (H && H.ok && H.R[hn] && H.R[an]) src = H;
      const DEF = { attH: 1, defH: 1, attA: 1, defA: 1, n: 0 };
      const home = src ? (src.R[hn] || DEF) : DEF;
      const away = src ? (src.R[an] || DEF) : DEF;
      const lH = src ? src.lH : 1.35, lA = src ? src.lA : 1.15;
      const rH = restDays(hn, tMs), rA = restDays(an, tMs);
      const hL0 = cl(lH * home.attH * away.defA * restFactor(rH), 0.25, 3.6);
      const aL0 = cl(lA * away.attA * home.defH * restFactor(rA), 0.2, 3.2);
      const sampleN = (home.n + away.n) / 2;
      const adj = eloLambda(hL0, aL0, EL[hn] || 1500, EL[an] || 1500, sampleN);
      let hL = adj[0], aL = adj[1];
      // Instancias de copa (eliminacion directa): el juego tiende a ser mas cauteloso -> lambda algo menor.
      if (['uefa.champions', 'uefa.europa', 'uefa.conference', 'conmebol.libertadores', 'conmebol.sudamericana', 'copa.del.rey', 'fa.cup', 'efl.cup', 'dfb.pokal', 'coppa.italia', 'coupe.de.france', 'uefa.nations'].indexOf(String(m.competition.id).replace('espn:', '')) !== -1) { hL *= 0.95; aL *= 0.95; }
      // Regresion por finalizacion (xG estimado propio): anotar muy por encima de las chances
      // generadas es insostenible; ajuste suave ±12% por equipo.
      hL = cl(hL * perfFactor(STATS, hn), 0.25, 3.6);
      aL = cl(aL * perfFactor(STATS, an), 0.2, 3.2);
      const bp = buildProbs(hL, aL, sampleN, rhoOf(m.competition.id));
      const formOf = function (team) { return (H && H.form && H.form[team]) ? H.form[team] : []; };
      const cid = m.competition.id;
      const AG = AGGS[cid] || {};
      out.push({
        id: m.id, cid: cid, home: hn, away: an,
        league: m.competition.name, time: m.utcDate, status: m.status,
        score: m.score && m.score.fullTime ? { home: m.score.fullTime.home, away: m.score.fullTime.away } : null,
        probs: bp.probs, modelProbs: bp.probs, main: '', hL: +hL.toFixed(2), aL: +aL.toFixed(2), sampleN: Math.round(sampleN),
        restHome: rH, restAway: rA,
        formHome: (formOf(hn).length ? formOf(hn) : (m.formHome || [])), formAway: (formOf(an).length ? formOf(an) : (m.formAway || [])),
        aggH: AG[hn] || null, aggA: AG[an] || null,
        lcode: String(cid).indexOf('espn:') === 0 ? cid.slice(5) : null,
        rho: +rhoOf(cid).toFixed(3),
        sp: statPreds(STATS, hn, an, isE(m)),
        h2h: h2hOf(H2HMAP, hn, an),
        odds: null, value: [], stats: null
      });
    });

    if (oddsKey) {
      const upSports = {};
      const soon = {};
      const soonN = {};
      out.forEach(function (p) {
        const s = mapLeague(p.league);
        if (s && isUpcoming(p.status)) {
          upSports[s] = true;
          if (new Date(p.time).getTime() - now < 36 * 3600000) { soon[s] = true; soonN[s] = (soonN[s] || 0) + 1; }
        }
      });
      const need = Object.keys(upSports).filter(function (s) {
        const e = ODDS[s]; if (!e) return true;
        const ttl = e.fail ? 3 * 60 * 1000 : (e.ttlO || (soon[s] ? 8 * 60 * 60 * 1000 : 24 * 60 * 60 * 1000));
        return now - e.ts > ttl;
      });
      need.sort(function (a, b) { return (soonN[b] || 0) - (soonN[a] || 0); });
      const budgetOk = ODDS_LEFT === null || ODDS_LEFT >= 60 || (now - ODDS_LEFT_TS > 24 * 60 * 60 * 1000);
      if (budgetOk) {
        await Promise.all(need.slice(0, 2).map(function (s) {
          return fetchOdds(s, oddsKey)
            .then(function (res2) {
              if (res2.left != null) { ODDS_LEFT = res2.left; ODDS_LEFT_TS = Date.now(); }
              ODDS[s] = res2.list.length ? { list: res2.list, ts: now } : { list: [], ts: now, ttlO: 30 * 60 * 1000 };
              if (res2.list.length) return Promise.all([kvSave('o:' + s, { list: res2.list }), kvSave('m:left', { left: ODDS_LEFT })]);
            })
            .catch(function () { const e = ODDS[s]; ODDS[s] = { list: (e && e.list) || [], ts: now, fail: true }; });
        }));
      }
      out.forEach(function (p) {
        const s = mapLeague(p.league); if (!s || !ODDS[s]) return;
        const o = findOdds(ODDS[s].list, normName(p.home), normName(p.away));
        if (!o) return;
        if (o.ov && o.un) {
          const pOver = (1 / o.ov) / ((1 / o.ov) + (1 / o.un));
          const lt = invLambda(pOver);
          const f = lt / (p.hL + p.aL);
          if (f > 0.6 && f < 1.6) { p.hL = +(p.hL * f).toFixed(2); p.aL = +(p.aL * f).toFixed(2); }
        }
        const bp2 = buildProbs(p.hL, p.aL, p.sampleN, p.rho);
        p.modelProbs = bp2.probs;
        const ih = 1 / o.h, id = 1 / o.d, ia = 1 / o.a; const t = ih + id + ia;
        const mh = ih / t * 100, md = id / t * 100, ma = ia / t * 100;
        p.odds = { h: +o.h.toFixed(2), d: +o.d.toFixed(2), a: +o.a.toFixed(2) };
        p.marketProbs = { home: Math.round(mh), draw: Math.round(md), away: Math.round(ma) };
        const W = (LGW && LGW[p.league] != null) ? LGW[p.league] : MARKET_W;
        p.probs = {
          home: Math.round(bp2.probs.home * (1 - W) + mh * W),
          draw: Math.round(bp2.probs.draw * (1 - W) + md * W),
          away: Math.round(bp2.probs.away * (1 - W) + ma * W)
        };
        if (p.probs.home + p.probs.draw + p.probs.away !== 100) p.probs.away = 100 - p.probs.home - p.probs.draw;
        const v = [];
        if (p.sampleN >= 4) {
          const sides = [['1', bp2.probs.home, mh, o.h], ['X', bp2.probs.draw, md, o.d], ['2', bp2.probs.away, ma, o.a]];
          sides.forEach(function (x) {
            const e = x[1] - x[2];
            if (e >= 4) {
              const pr = x[1] / 100, d = x[3];
              const k = d > 1 ? Math.max(0, (pr * d - 1) / (d - 1)) : 0;
              v.push({ side: x[0], edge: Math.round(e), kelly: +Math.min(3, k * 25).toFixed(1) });
            }
          });
        }
        p.value = v;
      });
    }

    out.forEach(function (p) {
      p.main = p.probs.home >= p.probs.draw && p.probs.home >= p.probs.away ? 'home'
        : p.probs.away >= p.probs.home && p.probs.away >= p.probs.draw ? 'away' : 'draw';
    });
    out.sort(function (a, b) { return (a.time || '').localeCompare(b.time || ''); });
    const compName = {};
    DATA.forEach(function (m) { compName[m.competition.id] = m.competition.name; });
    const histInfo = {};
    for (const cid in comps) {
      const e = HIST[cid];
      histInfo[compName[cid] || cid] = e ? (e.ok ? { ok: true, partidos: e.count } : { ok: false, err: e.err || 'sin datos' }) : { ok: false, err: 'aun no consultado' };
    }
    res.status(200).json({ ok: true, parser: 'v20', hist: histInfo, kv: KV_ERR || 'ok', count: out.length, window: { from, to }, oddsEnabled: !!oddsKey, oddsLeft: ODDS_LEFT, espn: espnInfo(), statsTeams: Object.keys(STATS).length, predictions: out, generated: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}