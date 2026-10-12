// Backtest walk-forward: replayea el historial real de una liga construyendo los ratings
// SOLO con partidos anteriores a cada uno (sin mirar el futuro) y mide Brier/log-loss/precisión.
// Uso: /api/backtest?cid=espn:bra.1  o  cid=PD1 (código football-data). Sin cache de probas: es medición honesta.
//
// A4: el pipeline replica la producción tanto como es posible sin datos externos:
// ratings + descanso (restFactor) + blend con Elo (eloLambda) + damping de copas ×0.95 +
// rho calibrado por liga desde la tasa de empates del prefijo + sampleN mejorado.
// Diferencias restantes vs producción (documentadas): sin perfFactor (requiere STATS de
// ESPN no disponibles aquí), sin mezcla con mercado (requiere cuotas), sin leagueWeights.
// Brier en escala "suma por partido" (baseline azar = 0.667), igual que el dashboard.
export const maxDuration = 20;
import { dbq, buildRatings, buildProbs, cl, cors, noCache, requireAuth } from './core.js';
import { computeElo, eloLambda } from './pro.js';

function restFactor(r) { if (r == null) return 1; if (r <= 3) return 0.94; if (r >= 8) return 1.03; return 1; }
function restDays(prefix, team, tMs) {
  let last = null;
  for (let i = 0; i < prefix.length; i++) {
    const x = prefix[i];
    if (x.homeTeam.name !== team && x.awayTeam.name !== team) continue;
    const xt = new Date(x.utcDate).getTime();
    if (xt < tMs - 3600000 && (last == null || xt > last)) last = xt;
  }
  if (last == null) return null;
  return Math.round((tMs - last) / 86400000);
}
function rhoOfPrefix(prefix) {
  // Como en producción: si la liga empata más de lo esperado, rho más negativo.
  let d = 0, n = 0;
  for (let i = 0; i < prefix.length; i++) {
    const s = prefix[i].score && prefix[i].score.fullTime;
    if (!s || s.home == null || s.away == null) continue;
    n++; if (s.home === s.away) d++;
  }
  if (n < 20) return -0.06;
  return Math.max(-0.12, Math.min(0.02, -0.06 + (d / n - 0.25) * 0.25));
}
const CUPW = ['champions', 'europa', 'libertadores', 'sudamericana', 'cup', 'copa', 'pokal', 'coppa', 'coupe', 'nations'];
function isCupCid(cid) {
  const c = String(cid).toLowerCase();
  return CUPW.some(function (w) { return c.indexOf(w) !== -1; });
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  noCache(res); // C1: private, no-store, DESPUÉS del chequeo de auth
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method' });
  const cid = String(req.query.cid || '');
  if (!/^[\w.:_-]{2,40}$/.test(cid)) return res.status(400).json({ ok: false, error: 'cid' });
  try {
    const key = cid.indexOf('espn:') === 0 ? 'e:espn:' + cid.slice(5) : 'h:' + cid;
    const rows = await dbq('select v from kv where k = $1 limit 1', [key], 4000);
    if (!rows.length) return res.status(200).json({ ok: false, error: 'sin historial para ' + cid });
    let v = rows[0].v;
    if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return res.status(200).json({ ok: false, error: 'kv corrupto' }); } }
    const raw = (cid.indexOf('espn:') === 0 ? (v.fin || []) : (v.matches || []))
      .filter(function (m) { return m && m.score && m.score.fullTime && m.score.fullTime.home != null && m.score.fullTime.away != null && m.utcDate; })
      .sort(function (a, b) { return (a.utcDate || '').localeCompare(b.utcDate || ''); });
    if (raw.length < 25) return res.status(200).json({ ok: false, error: 'historial insuficiente (' + raw.length + ')', n: raw.length });
    const ms = raw.slice(-150);
    const cup = isCupCid(cid);
    let n = 0, acc = 0, brier = 0, logloss = 0, brierB = 0;
    const calib = [];
    ms.forEach(function (m, i) {
      if (i < 10) return;
      const hn = m.homeTeam.name, an = m.awayTeam.name;
      if (!hn || !an) return;
      const t = new Date(m.utcDate).getTime();
      const prefix = ms.slice(0, i).filter(function (x) { return new Date(x.utcDate).getTime() < t; });
      const rr = buildRatings(prefix, t);
      const H = rr.R[hn], A = rr.R[an];
      if (!H || !A) return;
      // Pipeline cercano a producción (ver comentario superior del archivo).
      const hL0 = cl(rr.lH * H.attH * A.defA * restFactor(restDays(prefix, hn, t)), 0.25, 3.6);
      const aL0 = cl(rr.lA * A.attA * H.defH * restFactor(restDays(prefix, an, t)), 0.2, 3.2);
      const sampleN = Math.max((H.n + A.n) / 2, (Math.min(H.nc || 0, 25) + Math.min(A.nc || 0, 25)) / 2);
      const EL = computeElo(prefix);
      const adj = eloLambda(hL0, aL0, EL[hn] || 1500, EL[an] || 1500, sampleN);
      let hL = adj[0], aL = adj[1];
      if (cup) { hL *= 0.95; aL *= 0.95; } // damping de copas como en producción
      const bp = buildProbs(hL, aL, sampleN, rhoOfPrefix(prefix));
      const hs = m.score.fullTime.home, as = m.score.fullTime.away;
      const y = [hs > as ? 1 : 0, hs === as ? 1 : 0, hs < as ? 1 : 0];
      const pr = [bp.probs.home / 100, bp.probs.draw / 100, bp.probs.away / 100];
      n++;
      const pick = pr[0] >= pr[1] && pr[0] >= pr[2] ? 0 : (pr[2] >= pr[1] ? 2 : 1);
      if (y[pick] === 1) acc++;
      for (let k = 0; k < 3; k++) {
        brier += (pr[k] - y[k]) * (pr[k] - y[k]);
        brierB += (1 / 3 - y[k]) * (1 / 3 - y[k]);
        logloss -= y[k] * Math.log(Math.max(0.01, pr[k]));
      }
      const bpct = Math.round(pr[pick] * 10) * 10;
      const b = calib[bpct] = calib[bpct] || { n: 0, ok: 0 };
      b.n++; if (y[pick] === 1) b.ok++;
    });
    if (!n) return res.status(200).json({ ok: false, error: 'sin predicciones evaluables' });
    // A4: Brier en escala "suma por partido" (baseline azar = 0.667), igual que el dashboard.
    const out = {
      ok: true, cid: cid, n: n, acc: Math.round(acc / n * 100),
      brier: +(brier / n).toFixed(3), logloss: +(logloss / n).toFixed(3), brierBaseline: +(brierB / n).toFixed(3),
      calib: Object.keys(calib).map(function (k) { return { dice: k + '%', n: calib[k].n, acerto: Math.round(calib[k].ok / calib[k].n * 100) }; }),
      nota: 'Pipeline cercano a producción (ratings+descanso+Elo+rho por liga+damping copas). Sin perfFactor(xG) ni mezcla con mercado: el Brier real con mercado puede diferir.'
    };
    return res.status(200).json(out);
  } catch (e) {
    console.error('api/backtest', e);
    return res.status(200).json({ ok: false, error: 'error interno' });
  }
}
