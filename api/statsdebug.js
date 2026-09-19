export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const key = process.env.FUTPYTHON_API_KEY;
  if (!key) return res.status(200).json({ ok: false, error: 'falta FUTPYTHON_API_KEY' });
  const url = 'https://futpythontrader.com.br/api/download/spain/laliga/2026-2027?api_key=' + key;
  try {
    const r = await fetch(url);
    const text = await r.text();
    const lines = text.trim().split(/\r?\n/);
    const head = lines[0].split(',');
    const idx = {}; head.forEach(function (h, i) { idx[h.trim().toLowerCase()] = i; });
    function findCol(test) { for (const k in idx) { if (test(k)) return idx[k]; } return -1; }
    const cols = {
      home: idx['home'], away: idx['away'],
      tirosLocal: findCol(function (k) { return k.indexOf('shots') !== -1 && k.indexOf('home') !== -1 && k.indexOf('target') === -1 && k.indexOf('off') === -1; }),
      apuertaLocal: findCol(function (k) { return k.indexOf('home') !== -1 && (k.indexOf('on_target') !== -1 || (k.indexOf('target') !== -1 && k.indexOf('off') === -1)); }),
      cornersLocal: findCol(function (k) { return k.indexOf('corner') !== -1 && k.indexOf('home') !== -1; }),
      faltasLocal: findCol(function (k) { return k.indexOf('foul') !== -1 && k.indexOf('home') !== -1; }),
      xgLocal: findCol(function (k) { return k.indexOf('xg') !== -1 && k.indexOf('home') !== -1; })
    };
    const agg = {};
    for (let i = 1; i < lines.length; i++) {
      const col = lines[i].split(',');
      const hn = (col[cols.home] || '').trim();
      if (!hn) continue;
      const sh = cols.tirosLocal >= 0 ? parseFloat(col[cols.tirosLocal]) : NaN;
      const a = agg[hn] = agg[hn] || { n: 0, tiros: 0 };
      a.n++;
      if (isFinite(sh)) a.tiros += sh;
    }
    const keys = Object.keys(agg);
    res.status(200).json({
      ok: true, status: r.status, lineas: lines.length,
      columnas: cols, equipos: keys.length,
      muestra: keys.slice(0, 3).map(function (k) { return { equipo: k, partidos: agg[k].n, tirosProm: +(agg[k].tiros / agg[k].n).toFixed(1) }; })
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String(e.message || e) });
  }
}
