// Calibración de picks de estadísticas (over/under por línea).
// Compara cada pick de stat logueado (preds.sp, guardado al abrir el modal pre-partido)
// con el valor real del partido (preds.sp_actual, del boxscore colectado).
import { requireAuth, cors, noCache, dbq } from './core.js';
import { SPK } from './pro.js';

const NAMES = {};
SPK.forEach(function (p) { NAMES[p[0]] = p[1]; });

function pj(x) { if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return null; } } return x; }
function pct(x) { return Math.round(x * 100); }

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  noCache(res); // como calibration.js: private, no-store, DESPUÉS del chequeo de auth
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method' });
  try {
    const rows = await dbq('select league, sp, sp_actual from preds where sp is not null and sp_actual is not null limit 2000', [], 15000);
    const byStat = {};
    const buckets = [['<55%', 0, 0.55], ['55-65%', 0.55, 0.65], ['65-75%', 0.65, 0.75], ['75%+', 0.75, 1.01]]
      .map(function (b) { return { range: b[0], lo: b[1], hi: b[2], n: 0, exp: 0, hit: 0 }; });
    let n = 0, expTot = 0, hitTot = 0, brierTot = 0;
    rows.forEach(function (r) {
      const sp = pj(r.sp), act = pj(r.sp_actual);
      if (!Array.isArray(sp) || !act || !act.t) return;
      sp.forEach(function (pk) {
        if (!pk || !pk.k || pk.line == null || pk.p == null) return;
        const a = act.t[pk.k];
        if (a == null || !isFinite(a)) return;
        const hit = pk.dir === 'o' ? (a > pk.line ? 1 : 0) : (a < pk.line ? 1 : 0);
        const p = pk.p / 100;
        n++; expTot += p; hitTot += hit; brierTot += (p - hit) * (p - hit);
        const s = byStat[pk.k] = byStat[pk.k] || { k: pk.k, n: 0, exp: 0, hit: 0, brier: 0 };
        s.n++; s.exp += p; s.hit += hit; s.brier += (p - hit) * (p - hit);
        for (let i = 0; i < buckets.length; i++) {
          const b = buckets[i];
          if (p >= b.lo && p < b.hi) { b.n++; b.exp += p; b.hit += hit; break; }
        }
      });
    });

    const stats = Object.keys(byStat).map(function (k) {
      const s = byStat[k];
      return {
        k: k, name: NAMES[k] || k, n: s.n,
        dice: pct(s.exp / s.n), acierta: pct(s.hit / s.n),
        brier: +(s.brier / s.n).toFixed(3)
      };
    }).sort(function (a, b) { return b.n - a.n; });

    const findings = [];
    if (!n) {
      findings.push('Todavía no hay picks de stats resueltos. Se acumulan solos: cada vez que abras el modal de un partido próximo se guarda su pick, y cuando el partido termina se compara con el valor real.');
    } else {
      const exp = expTot / n, hit = hitTot / n, diff = hit - exp;
      const brier = brierTot / n;
      if (n < 30) {
        findings.push('Muestra chica todavía (n=' + n + ' picks). Los desvíos son ruido por ahora; vuelve cuando haya más partidos resueltos.');
      } else if (diff >= 0.05) {
        findings.push('Tus picks de stats son conservadores: dices ' + pct(exp) + '% y aciertan ' + pct(hit) + '% (+' + pct(diff) + 'pp). Hay valor escondido en las líneas.');
      } else if (diff <= -0.05) {
        findings.push('Tus picks de stats son optimistas: dices ' + pct(exp) + '% y aciertan ' + pct(hit) + '% (' + pct(diff) + 'pp). Las líneas están exigentes.');
      } else {
        findings.push('Tus picks de stats calibran bien: dices ' + pct(exp) + '% y aciertan ' + pct(hit) + '%.');
      }
      findings.push('Brier de stats: ' + brier.toFixed(3) + ' (azar = 0.25, menor es mejor).');
      stats.forEach(function (s) {
        if (s.n < 10) return;
        const d = s.acierta - s.dice;
        if (d >= 10) findings.push((NAMES[s.k] || s.k) + ': dices ' + s.dice + '% y acierta ' + s.acierta + '% (n=' + s.n + '). Subestimas esta stat.');
        else if (d <= -10) findings.push((NAMES[s.k] || s.k) + ': dices ' + s.dice + '% y acierta ' + s.acierta + '% (n=' + s.n + '). Sobreestimas esta stat.');
      });
    }

    return res.status(200).json({
      ok: true,
      n: n,
      matches: rows.length,
      overall: n ? { dice: pct(expTot / n), acierta: pct(hitTot / n), brier: +(brierTot / n).toFixed(3) } : null,
      byStat: stats,
      byBucket: buckets.filter(function (b) { return b.n > 0; }).map(function (b) {
        return { range: b.range, n: b.n, dice: pct(b.exp / b.n), acierta: pct(b.hit / b.n) };
      }),
      findings: findings
    });
  } catch (e) {
    console.error('api/statcal', e);
    return res.status(500).json({ ok: false, error: 'error interno' });
  }
}
