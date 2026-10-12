import { dbq, cors, noCache, requireAuth } from './core.js';
import { SPK } from './pro.js';

// Análisis profundo de calibración: compara pronósticos guardados vs resultados
// reales y genera conclusiones en español sobre dónde se desvía el modelo.
const q = function (sql, params) { return dbq(sql, params, 8000); };
function pj(x) { if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return null; } } return x; }
function num(v) { v = Number(v); return isFinite(v) ? v : null; }
// Acepta [h,d,a] o {home,draw,away}, en 0-100 o en 0-1. Devuelve [h,d,a] en 0-1.
function tri(x) {
  x = pj(x);
  if (!x) return null;
  var t = null;
  if (Array.isArray(x) && x.length >= 3) t = [num(x[0]), num(x[1]), num(x[2])];
  else if (typeof x === 'object') t = [num(x.home), num(x.draw), num(x.away)];
  if (!t || t[0] == null || t[1] == null || t[2] == null) return null;
  if (t[0] + t[1] + t[2] > 1.5) t = [t[0] / 100, t[1] / 100, t[2] / 100];
  return t;
}
var IDX = { home: 0, draw: 1, away: 2 };
var NAMES = ['home', 'draw', 'away'];
var PLBL = { home: 'local (1)', draw: 'empate (X)', away: 'visita (2)' };
function actualOutcome(rs) {
  if (!rs) return null;
  var m = String(rs).trim().match(/^(-?\d+)\s*-\s*(-?\d+)$/);
  if (!m) return null;
  var h = Number(m[1]), a = Number(m[2]);
  return h > a ? 'home' : h < a ? 'away' : 'draw';
}
function pct1(x) { return Math.round(x * 100); }

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  noCache(res); // C1: private, no-store, DESPUÉS del chequeo de auth
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method' });
  // Modo stats (?stats=1): calibración de picks over/under en vez de 1X2.
  // (Fusionado aquí porque el plan Hobby limita a 12 serverless functions.)
  if (req.query && req.query.stats === '1') return statCalibration(res);
  try {
    var rows = await q("select league, pred, pr, pm, pk, estado, rs, clv, sn from preds where estado in ('win','loss') limit 5000");
    var BK = [['<50%', 0, 0.5], ['50-60%', 0.5, 0.6], ['60-70%', 0.6, 0.7], ['70-80%', 0.7, 0.8], ['80%+', 0.8, 1.01]];
    var buckets = BK.map(function (b) { return { range: b[0], lo: b[1], hi: b[2], n: 0, exp: 0, hit: 0 }; });
    var byPick = { home: { n: 0, exp: 0, hit: 0 }, draw: { n: 0, exp: 0, hit: 0 }, away: { n: 0, exp: 0, hit: 0 } };
    var leagues = {};
    var src = {
      blend: { n: 0, exp: 0, hit: 0, brier: 0 },
      model: { n: 0, exp: 0, hit: 0, brier: 0 },
      market: { n: 0, exp: 0, hit: 0, brier: 0 }
    };
    var clvs = [], n = 0;
    rows.forEach(function (r) {
      var pr = tri(r.pr);
      var pi = IDX[r.pred];
      if (!pr || pi == null) return;
      var conf = pr[pi];
      var hit = r.estado === 'win' ? 1 : 0;
      var actual = actualOutcome(r.rs);
      n++;
      for (var i = 0; i < buckets.length; i++) {
        var b = buckets[i];
        if (conf >= b.lo && conf < b.hi) { b.n++; b.exp += conf; b.hit += hit; break; }
      }
      var bp = byPick[r.pred];
      if (bp) { bp.n++; bp.exp += conf; bp.hit += hit; }
      var lg = leagues[r.league || '¿?'] = leagues[r.league || '¿?'] || { n: 0, exp: 0, hit: 0 };
      lg.n++; lg.exp += conf; lg.hit += hit;
      // Modelo puro y mercado: su propio pick vs resultado real (vía marcador).
      [['model', r.pm], ['market', r.pk]].forEach(function (pair) {
        var t = tri(pair[1]);
        if (!t || !actual) return;
        var mi = t[0] >= t[1] && t[0] >= t[2] ? 0 : t[1] >= t[2] ? 1 : 2;
        var s = src[pair[0]];
        s.n++; s.exp += t[mi]; s.hit += (NAMES[mi] === actual ? 1 : 0);
        var o = [actual === 'home' ? 1 : 0, actual === 'draw' ? 1 : 0, actual === 'away' ? 1 : 0];
        s.brier += (t[0] - o[0]) * (t[0] - o[0]) + (t[1] - o[1]) * (t[1] - o[1]) + (t[2] - o[2]) * (t[2] - o[2]);
      });
      var s2 = src.blend;
      s2.n++; s2.exp += conf; s2.hit += hit;
      if (actual) {
        var o2 = [actual === 'home' ? 1 : 0, actual === 'draw' ? 1 : 0, actual === 'away' ? 1 : 0];
        s2.brier += (pr[0] - o2[0]) * (pr[0] - o2[0]) + (pr[1] - o2[1]) * (pr[1] - o2[1]) + (pr[2] - o2[2]) * (pr[2] - o2[2]);
      }
      if (r.clv != null && isFinite(Number(r.clv))) clvs.push(Number(r.clv));
    });

    function fin(o) {
      o.exp = o.n ? o.exp / o.n : 0;
      o.hit = o.n ? o.hit / o.n : 0;
      o.diff = o.hit - o.exp;
      if (o.brier != null) o.brier = o.n ? +(o.brier / o.n).toFixed(3) : null;
      return o;
    }
    buckets.forEach(fin);
    Object.keys(byPick).forEach(function (k) { fin(byPick[k]); });
    var lgList = Object.keys(leagues).map(function (k) { var o = fin(leagues[k]); o.league = k; return o; })
      .filter(function (o) { return o.n >= 10; })
      .sort(function (a, b) { return Math.abs(b.diff) - Math.abs(a.diff); });
    Object.keys(src).forEach(function (k) { fin(src[k]); });
    var clvAvg = clvs.length ? +(clvs.reduce(function (s, x) { return s + x; }, 0) / clvs.length).toFixed(1) : null;

    // ---- Conclusiones en español ----
    var findings = [];
    function pp(x) { return pct1(x) + '%'; }
    function dp(x) { return (x >= 0 ? '+' : '') + pct1(x) + 'pp'; }
    if (n < 30) {
      findings.push('Aún hay pocos partidos terminados (n=' + n + '). Los desvíos con n chico son ruido: esto se vuelve confiable con 100+. Sigue guardando resultados.');
    } else {
      buckets.forEach(function (b) {
        if (b.n >= 15 && Math.abs(b.diff) >= 0.05) {
          findings.push('En ' + b.range + ' (n=' + b.n + '): dices ' + pp(b.exp) + ' y aciertas ' + pp(b.hit) + ' (' + dp(b.diff) + '). ' +
            (b.diff < 0 ? 'Sobreestimas este rango: tus picks "seguros" fallan más de lo que crees.' : 'Subestimas este rango: aciertas más de lo que dices, hay valor escondido.'));
        }
      });
      var d = byPick.draw;
      if (d.n >= 15) findings.push('Picks de empate (X), n=' + d.n + ': dices ' + pp(d.exp) + ', aciertas ' + pp(d.hit) + ' (' + dp(d.diff) + '). ' +
        (d.diff < -0.05 ? 'El empate es tu punto más débil: el modelo lo sobrevalora.' : d.diff > 0.05 ? 'Lees bien los empates: mejor de lo que el modelo cree.' : 'Tus empates están bien calibrados.'));
      var fh = buckets[3], fh2 = buckets[4];
      var fn = fh.n + fh2.n, fe = (fh.exp * fh.n + fh2.exp * fh2.n) / (fn || 1), fa = (fh.hit * fh.n + fh2.hit * fh2.n) / (fn || 1);
      if (fn >= 15) findings.push('Favoritos claros (≥70%, n=' + fn + '): dices ' + pp(fe) + ', aciertas ' + pp(fa) + ' (' + dp(fa - fe) + '). ' +
        (fa - fe < -0.05 ? 'Cuidado con los favoritos: el mercado los suele tener mejor medidos.' : 'Tus favoritos rinden lo esperado.'));
      lgList.slice(0, 3).forEach(function (o) {
        if (Math.abs(o.diff) >= 0.08) findings.push('Liga ' + o.league + ' (n=' + o.n + '): dices ' + pp(o.exp) + ', aciertas ' + pp(o.hit) + ' (' + dp(o.diff) + '). ' +
          (o.diff < 0 ? 'En esta liga tu modelo es optimista.' : 'En esta liga tu modelo es conservador: posible edge.'));
      });
      if (src.model.n >= 20 && src.market.n >= 20) {
        var dm = Math.abs(src.model.hit - src.model.exp), dk = Math.abs(src.market.hit - src.market.exp);
        findings.push('Calibración: modelo puro se desvía ' + pp(dm) + ', mercado ' + pp(dk) + ', tu mezcla ' + pp(Math.abs(src.blend.hit - src.blend.exp)) + '. ' +
          (dm < dk ? 'Tu modelo calibra mejor que el mercado: el blend debería pesar más tu modelo.' : 'El mercado calibra mejor que tu modelo: el blend debería pesar más el mercado.'));
      }
      if (clvAvg != null) findings.push('CLV promedio: ' + (clvAvg >= 0 ? '+' : '') + clvAvg + '%. ' +
        (clvAvg > 0 ? 'Entras en promedio mejor que el cierre: señal de edge real.' : 'Entras peor que el cierre en promedio: revisa el timing de tus entradas.'));
      if (!findings.length) findings.push('Tu modelo está bien calibrado en todos los cortes con muestra suficiente (n=' + n + '). Nada que corregir por ahora.');
    }

    return res.status(200).json({
      ok: true, n: n,
      buckets: buckets.map(function (b) { return { range: b.range, n: b.n, dice: b.n ? pct1(b.exp) : null, acierta: b.n ? pct1(b.hit) : null, desvio: b.n ? +b.diff.toFixed(3) : null }; }),
      porPick: Object.keys(byPick).map(function (k) { var o = byPick[k]; return { pick: PLBL[k], n: o.n, dice: o.n ? pct1(o.exp) : null, acierta: o.n ? pct1(o.hit) : null }; }),
      ligas: lgList.slice(0, 8).map(function (o) { return { liga: o.league, n: o.n, dice: pct1(o.exp), acierta: pct1(o.hit), desvio: +o.diff.toFixed(3) }; }),
      fuentes: {
        mezcla: { n: src.blend.n, dice: pct1(src.blend.exp), acierta: pct1(src.blend.hit), brier: src.blend.brier },
        modelo: { n: src.model.n, dice: pct1(src.model.exp), acierta: pct1(src.model.hit), brier: src.model.brier },
        mercado: { n: src.market.n, dice: pct1(src.market.exp), acierta: pct1(src.market.hit), brier: src.market.brier }
      },
      clvPromedio: clvAvg,
      conclusiones: findings
    });
  } catch (e) {
    console.error('api/calibration', e);
    return res.status(500).json({ ok: false, error: 'error interno' });
  }
}

// ---- Calibración de picks de estadísticas (over/under por línea) ----
// Compara cada pick de stat logueado (preds.sp) con el valor real (preds.sp_actual).
async function statCalibration(res) {
  const NAMES = {};
  SPK.forEach(function (p) { NAMES[p[0]] = p[1]; });
  function pct(x) { return Math.round(x * 100); }
  try {
    const rows = await q('select league, sp, sp_actual from preds where sp is not null and sp_actual is not null limit 2000');
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
      return { k: k, name: NAMES[k] || k, n: s.n, dice: pct(s.exp / s.n), acierta: pct(s.hit / s.n), brier: +(s.brier / s.n).toFixed(3) };
    }).sort(function (a, b) { return b.n - a.n; });
    const findings = [];
    if (!n) {
      findings.push('Todavía no hay picks de stats resueltos. Se acumulan solos: cada vez que abras el modal de un partido próximo se guarda su pick, y cuando el partido termina se compara con el valor real.');
    } else {
      const exp = expTot / n, hit = hitTot / n, diff = hit - exp;
      if (n < 30) {
        findings.push('Muestra chica todavía (n=' + n + ' picks). Los desvíos son ruido por ahora; vuelve cuando haya más partidos resueltos.');
      } else if (diff >= 0.05) {
        findings.push('Tus picks de stats son conservadores: dices ' + pct(exp) + '% y aciertan ' + pct(hit) + '% (+' + pct(diff) + 'pp). Hay valor escondido en las líneas.');
      } else if (diff <= -0.05) {
        findings.push('Tus picks de stats son optimistas: dices ' + pct(exp) + '% y aciertan ' + pct(hit) + '% (' + pct(diff) + 'pp). Las líneas están exigentes.');
      } else {
        findings.push('Tus picks de stats calibran bien: dices ' + pct(exp) + '% y aciertan ' + pct(hit) + '%.');
      }
      findings.push('Brier de stats: ' + (brierTot / n).toFixed(3) + ' (azar = 0.25, menor es mejor).');
      stats.forEach(function (s) {
        if (s.n < 10) return;
        const d = s.acierta - s.dice;
        if (d >= 10) findings.push(s.name + ': dices ' + s.dice + '% y acierta ' + s.acierta + '% (n=' + s.n + '). Subestimas esta stat.');
        else if (d <= -10) findings.push(s.name + ': dices ' + s.dice + '% y acierta ' + s.acierta + '% (n=' + s.n + '). Sobreestimas esta stat.');
      });
    }
    return res.status(200).json({
      ok: true, mode: 'stats', n: n, matches: rows.length,
      overall: n ? { dice: pct(expTot / n), acierta: pct(hitTot / n), brier: +(brierTot / n).toFixed(3) } : null,
      byStat: stats,
      byBucket: buckets.filter(function (b) { return b.n > 0; }).map(function (b) {
        return { range: b.range, n: b.n, dice: pct(b.exp / b.n), acierta: pct(b.hit / b.n) };
      }),
      findings: findings
    });
  } catch (e) {
    console.error('api/calibration stats', e);
    return res.status(500).json({ ok: false, error: 'error interno' });
  }
}
