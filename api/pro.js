// Módulo de predicciones avanzadas: Elo global, H2H, calibración por liga y
// predicción de estadísticas (Más de/Menos de por línea, rango probable y % de riesgo).
import { normName, sameTeam } from './espn.js';

// ---- Elo global entre competiciones (copas incluidas) ----
export function computeElo(finished) {
  const elo = {}; const K = 24, HA = 65;
  finished
    .filter(function (m) { return m.status === 'FINISHED' && m.score && m.score.fullTime && m.score.fullTime.home != null && m.score.fullTime.away != null; })
    .sort(function (a, b) { return (a.utcDate || '').localeCompare(b.utcDate || ''); })
    .forEach(function (m) {
      const h = m.homeTeam.name, a = m.awayTeam.name;
      const rh = elo[h] || 1500, ra = elo[a] || 1500;
      const eh = 1 / (1 + Math.pow(10, (ra - rh - HA) / 400));
      const hs = m.score.fullTime.home, as = m.score.fullTime.away;
      const sh = hs > as ? 1 : (hs === as ? 0.5 : 0);
      elo[h] = rh + K * (sh - eh);
      elo[a] = ra + K * ((1 - sh) - (1 - eh));
    });
  return elo;
}

// Ajuste de goles esperados por Elo: supremacy → λ. Devuelve [hL, aL].
export function eloLambda(hL, aL, eloH, eloA, sampleN) {
  const adj = Math.max(-0.7, Math.min(0.7, ((eloH - eloA + 65) / 400) * 0.9));
  const bl = sampleN >= 8 ? 0.3 : 0.5;
  return [Math.max(0.2, Math.min(3.7, hL + adj * bl)), Math.max(0.15, Math.min(3.3, aL - adj * bl))];
}

// ---- H2H: historial directo entre dos equipos ----
export function buildH2H(finished) {
  const map = {};
  finished
    .filter(function (m) { return m.status === 'FINISHED' && m.score && m.score.fullTime && m.score.fullTime.home != null; })
    .sort(function (a, b) { return (b.utcDate || '').localeCompare(a.utcDate || ''); })
    .forEach(function (m) {
      const k = [normName(m.homeTeam.name), normName(m.awayTeam.name)].sort().join('|');
      if (!map[k]) map[k] = [];
      if (map[k].length < 6) map[k].push({ d: (m.utcDate || '').slice(0, 10), hn: m.homeTeam.name, an: m.awayTeam.name, hs: m.score.fullTime.home, as: m.score.fullTime.away });
    });
  return map;
}
export function h2hOf(map, hn, an) {
  return map[[normName(hn), normName(an)].sort().join('|')] || null;
}

// ---- Calibración por liga: peso del mercado según Brier histórico (modelo vs mercado) ----
let LGW = null, LGW_TS = 0;
export async function leagueWeights(dbq, now) {
  if (LGW && now - LGW_TS < 30 * 60 * 1000) return LGW;
  try {
    const rows = await dbq("select league, pr, pk, rs from preds where estado <> 'pend' and rs is not null and pr is not null limit 5000", [], 2500);
    const L = {};
    rows.forEach(function (x) {
      const rs = String(x.rs).split('-'); const h = +rs[0], a = +rs[1];
      if (!isFinite(h) || !isFinite(a) || !Array.isArray(x.pr) || x.pr.length !== 3) return;
      const y = [h > a ? 1 : 0, h === a ? 1 : 0, h < a ? 1 : 0];
      const o = L[x.league] = L[x.league] || { n: 0, bM: 0, nK: 0, bK: 0 };
      o.n++; o.bM += (x.pr[0] - y[0]) * (x.pr[0] - y[0]) + (x.pr[1] - y[1]) * (x.pr[1] - y[1]) + (x.pr[2] - y[2]) * (x.pr[2] - y[2]);
      if (Array.isArray(x.pk) && x.pk.length === 3) { o.nK++; o.bK += (x.pk[0] - y[0]) * (x.pk[0] - y[0]) + (x.pk[1] - y[1]) * (x.pk[1] - y[1]) + (x.pk[2] - y[2]) * (x.pk[2] - y[2]); }
    });
    const w = {};
    Object.keys(L).forEach(function (k) {
      const o = L[k];
      if (o.n >= 15 && o.nK >= 10) {
        const bM = o.bM / o.n, bK = o.bK / o.nK;
        // Si el mercado acierta más que el modelo en esa liga (bK < bM), darle más peso. Límites 0.15–0.65.
        w[k] = Math.round(Math.min(0.65, Math.max(0.15, 0.4 + 2 * (bK - bM))) * 100) / 100;
      }
    });
    LGW = w; LGW_TS = now;
    return w;
  } catch (e) { return LGW || {}; }
}

// ---- Predicción de estadísticas desde promedios reales colectados ----
export const SPK = [
  ['sh', 'Tiros'], ['sot', 'Tiros a puerta'], ['cor', 'Córners'], ['fou', 'Faltas'],
  ['yc', 'Amarillas'], ['sav', 'Salvadas (ARQ)'], ['off', 'Fueras de juego'], ['rc', 'Rojas'],
  ['blo', 'Tiros bloqueados'], ['pas', 'Pases'], ['cru', 'Centros'], ['lon', 'Balones largos'],
  ['tac', 'Entradas'], ['int', 'Intercepciones'], ['cle', 'Despejes'],
  ['pko', 'Penales'], ['pks', 'Penales rematados'], ['apas', 'Pases precisos'],
  ['acru', 'Centros precisos'], ['alon', 'Balones largos precisos'], ['etac', 'Entradas efectivas']
];
const ROLL = 12;

// STATS[team] = { n, sh: [últimos valores], shH/shA: solo como local/visitante, ... }
export function bumpStats(STATS, team, obs, isHome) {
  const s = STATS[team] = STATS[team] || { n: 0 };
  let any = false;
  const vk = isHome === true ? 'H' : (isHome === false ? 'A' : null);
  Object.keys(obs).forEach(function (k) {
    const v = obs[k];
    if (v == null || !isFinite(v)) return;
    if (!s[k]) s[k] = [];
    s[k].push(Math.round(v * 10) / 10);
    if (s[k].length > ROLL) s[k] = s[k].slice(-ROLL);
    if (vk) {
      const kk = k + vk;
      if (!s[kk]) s[kk] = [];
      s[kk].push(Math.round(v * 10) / 10);
      if (s[kk].length > ROLL) s[kk] = s[kk].slice(-ROLL);
    }
    any = true;
  });
  if (any) s.n = Math.max(s.n || 0, Math.min(ROLL, (s.sh || []).length));
  return any;
}
// Stats "permitidas": lo que los rivales le hicieron a este equipo (para ajustar por defensa rival).
export function bumpAllowed(STATS, team, oppObs) {
  const s = STATS[team] = STATS[team] || { n: 0 };
  Object.keys(oppObs).forEach(function (k) {
    const v = oppObs[k];
    if (v == null || !isFinite(v)) return;
    const kk = k + 'Ag';
    if (!s[kk]) s[kk] = [];
    s[kk].push(Math.round(v * 10) / 10);
    if (s[kk].length > ROLL) s[kk] = s[kk].slice(-ROLL);
  });
}
function avgA(a) { return a && a.length ? a.reduce(function (s, x) { return s + x; }, 0) / a.length : null; }
function globalAvg(STATS, k) {
  let sum = 0, cnt = 0;
  Object.keys(STATS).forEach(function (t) {
    const a = STATS[t][k];
    if (a && a.length) { a.forEach(function (x) { sum += x; cnt++; }); }
  });
  return cnt >= 30 ? sum / cnt : null;
}
// Promedio ponderado por localía: 65% en su condición, 35% general (si hay 2+ muestras de la condición).
function venueAvg(s, k, isHome) {
  const g = avgA(s[k]);
  if (g == null) return null;
  const v = avgA(s[k + (isHome ? 'H' : 'A')]);
  if (v == null || (s[k + (isHome ? 'H' : 'A')] || []).length < 2) return g;
  return 0.65 * v + 0.35 * g;
}
function nphi(z) {
  // Aproximación de Abramowitz-Stegun de la CDF normal.
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  let p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
// P(X > line) con X ~ BinomialNegativa(λ, r): permite sobre-dispersión (córners, faltas y tiros
// varían más de lo que la Poisson asume). Para λ grandes usa aproximación normal con varianza NB.
export function pOverNB(l, line, r) {
  if (l == null || l <= 0) return null;
  const rr = r || 8;
  if (l > 30) { const sd = Math.sqrt(l + l * l / rr); return 1 - nphi((line + 0.5 - l) / sd); }
  const q = l / (l + rr);
  const k0 = Math.floor(line) + 1;
  let cum = 0, term = Math.pow(rr / (l + rr), rr);
  for (let i = 0; i < k0; i++) { if (i > 0) term = term * ((i - 1 + rr) / i) * q; cum += term; }
  return Math.max(0, Math.min(1, 1 - cum));
}
function oneStat(name, lH, lA) {
  const lt = lH + lA;
  const line = Math.floor(lt) + 0.5;
  const po = pOverNB(lt, line, 8);
  if (po == null) return null;
  const pick = po >= 0.5 ? ('Más de ' + line) : ('Menos de ' + line);
  const risk = Math.round(100 - Math.max(po, 1 - po) * 100);
  const sd = Math.sqrt(Math.max(lt + lt * lt / 8, 0.5));
  const r0 = Math.max(0, Math.floor(lt - 0.7 * sd)), r1 = Math.ceil(lt + 0.7 * sd);
  const lh = Math.floor(lH) + 0.5, la = Math.floor(lA) + 0.5;
  const pho = pOverNB(lH, lh, 8), pao = pOverNB(lA, la, 8);
  return {
    name: name, line: line, pick: pick, p: Math.round(Math.max(po, 1 - po) * 100), risk: risk,
    r0: r0, r1: r1,
    hp: (pho >= 0.5 ? 'Más de ' : 'Menos de ') + lh, hpP: Math.round(Math.max(pho, 1 - pho) * 100),
    ap: (pao >= 0.5 ? 'Más de ' : 'Menos de ') + la, apP: Math.round(Math.max(pao, 1 - pao) * 100)
  };
}
// Devuelve lista de predicciones por estadística, o null si falta un equipo.
export function statPreds(STATS, hn, an, espnMatch) {
  const find = function (t) {
    if (STATS[t]) return STATS[t];
    if (!espnMatch) return null;
    const ks = Object.keys(STATS);
    for (let i = 0; i < ks.length; i++) { if (sameTeam(normName(t), normName(ks[i]))) return STATS[ks[i]]; }
    return null;
  };
  const A = find(hn), B = find(an);
  if (!A || !B) return null;
  const n = Math.min(A.n || 0, B.n || 0);
  if (n < 3) return null;
  // Riesgo extra honesto con muestra chica: cada muestra faltante suma ~5 puntos de riesgo.
  const extraRisk = Math.min(25, Math.max(0, (5 - n) * 5));
  const out = [];
  SPK.forEach(function (p) {
    const k = p[0];
    const aH0 = venueAvg(A, k, true), aA0 = venueAvg(B, k, false);
    if (aH0 == null || aA0 == null) return;
    // Ajuste por el rival: según lo que la defensa del oponente permite en esa stat
    // (promedio que le hacen) frente al promedio global. Factor suavizado y acotado.
    const gAll = globalAvg(STATS, k);
    const alB = gAll != null ? avgA(B[k + 'Ag']) : null;
    const alA = gAll != null ? avgA(A[k + 'Ag']) : null;
    const fB = alB != null ? Math.max(0.85, Math.min(1.2, alB / gAll)) : 1;
    const fA = alA != null ? Math.max(0.85, Math.min(1.2, alA / gAll)) : 1;
    const aH = aH0 * (1 + (fB - 1) * 0.7), aA = aA0 * (1 + (fA - 1) * 0.7);
    const r = oneStat(p[1], aH, aA);
    if (r) out.push(Object.assign({ k: k, n: n }, r, { risk: Math.min(85, r.risk + extraRisk), p: Math.max(15, r.p - extraRisk) }));
  });
  const pH = venueAvg(A, 'pos', true), pA = venueAvg(B, 'pos', false);
  if (pH != null && pA != null) {
    const ph = Math.round(50 + (pH - pA) / 2), pa = 100 - ph;
    out.push({ k: 'pos', name: 'Posesión %', n: n, ph: Math.min(90, Math.max(10, ph)), pa: Math.min(90, Math.max(10, pa)), risk: Math.min(85, Math.round(Math.max(15, Math.min(65, 65 - Math.abs(pH - pA) * 1.8)) + extraRisk)) });
  }
  return out.length ? out : null;
}
