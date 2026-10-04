// Backtest walk-forward: replayea el historial real de una liga construyendo los ratings
// SOLO con partidos anteriores a cada uno (sin mirar el futuro) y mide Brier/log-loss/precisión.
// Uso: /api/backtest?cid=espn:bra.1  o  cid=PD1 (código football-data). Sin cache de probas: es medición honesta.
export const maxDuration = 20;
import { dbq, buildRatings, buildProbs, cl, cors } from './core.js';

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 'public, max-age=600');
  if (req.method === 'OPTIONS') return res.status(200).end();
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
      const hL = cl(rr.lH * H.attH * A.defA, 0.25, 3.6);
      const aL = cl(rr.lA * A.attA * H.defH, 0.2, 3.2);
      const sampleN = (H.n + A.n) / 2;
      const bp = buildProbs(hL, aL, sampleN, -0.06);
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
    const out = { ok: true, cid: cid, n: n, acc: Math.round(acc / n * 100), brier: +(brier / (3 * n)).toFixed(3), logloss: +(logloss / n).toFixed(3), brierBaseline: +(brierB / (3 * n)).toFixed(3), calib: Object.keys(calib).map(function (k) { return { dice: k + '%', n: calib[k].n, acerto: Math.round(calib[k].ok / calib[k].n * 100) }; }) };
    return res.status(200).json(out);
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
