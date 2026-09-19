const FPT = 'https://futpythontrader.com.br/api/download';

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}
// Parser CSV que respeta campos entre comillas (evita el desastre de las comas internas)
function parseLine(line) {
  const out = [];
  let cur = '', inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === ',' && !inQ) { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}
function normName(s) {
  return String(s).toLowerCase()
    .replace(/[áàäâéèëêíìïîóòöôúùüûñç]/g, function (c) {
      return { á: 'a', à: 'a', ä: 'a', â: 'a', é: 'e', è: 'e', ë: 'e', ê: 'e', í: 'i', ì: 'i', ï: 'i', î: 'i', ó: 'o', ò: 'o', ö: 'o', ô: 'o', ú: 'u', ù: 'u', ü: 'u', û: 'u', ñ: 'n', ç: 'c' }[c] || c;
    })
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
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
async function fetchStats(cfg, key) {
  for (const season of cfg.s) {
    try {
      const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, 7000);
      const r = await fetch(FPT + '/' + cfg.c + '/' + cfg.l + '/' + season + '?api_key=' + key, { signal: c.signal });
      clearTimeout(t);
      if (!r.ok) continue;
      const text = await r.text();
      const lines = text.trim().split(/\r?\n/);
      if (lines.length < 2) continue;
      const head = parseLine(lines[0]);
      const idx = {}; head.forEach(function (h, i) { idx[h.trim().toLowerCase()] = i; });
      function findCol(test) { for (const k in idx) { if (test(k)) return idx[k]; } return -1; }
      function pref(test) {
        const ft = findCol(function (k) { return test(k) && k.indexOf('_ft') !== -1; });
        if (ft !== -1) return ft;
        return findCol(test);
      }
      const cHome = idx['home'], cAway = idx['away'];
      if (cHome === undefined || cAway === undefined) continue;
      const cShH = pref(function (k) { return k.indexOf('shots') !== -1 && k.indexOf('home') !== -1 && k.indexOf('target') === -1 && k.indexOf('off') === -1; });
      const cShA = pref(function (k) { return k.indexOf('shots') !== -1 && k.indexOf('away') !== -1 && k.indexOf('target') === -1 && k.indexOf('off') === -1; });
      const cSoH = pref(function (k) { return k.indexOf('home') !== -1 && (k.indexOf('on_target') !== -1 || (k.indexOf('target') !== -1 && k.indexOf('off') === -1)); });
      const cSoA = pref(function (k) { return k.indexOf('away') !== -1 && (k.indexOf('on_target') !== -1 || (k.indexOf('target') !== -1 && k.indexOf('off') === -1)); });
      const cCoH = pref(function (k) { return k.indexOf('corner') !== -1 && k.indexOf('home') !== -1; });
      const cCoA = pref(function (k) { return k.indexOf('corner') !== -1 && k.indexOf('away') !== -1; });
      const cFoH = pref(function (k) { return k.indexOf('foul') !== -1 && k.indexOf('home') !== -1; });
      const cFoA = pref(function (k) { return k.indexOf('foul') !== -1 && k.indexOf('away') !== -1; });
      const cYcH = pref(function (k) { return k.indexOf('yellow') !== -1 && k.indexOf('home') !== -1; });
      const cYcA = pref(function (k) { return k.indexOf('yellow') !== -1 && k.indexOf('away') !== -1; });
      const cXgH = pref(function (k) { return k.indexOf('xg') !== -1 && k.indexOf('home') !== -1; });
      const cXgA = pref(function (k) { return k.indexOf('xg') !== -1 && k.indexOf('away') !== -1; });
      if (cShH === -1 && cXgH === -1) continue;
      const agg = {};
      for (let i = 1; i < lines.length; i++) {
        const col = parseLine(lines[i]);
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
        if (a.n < 2) continue;
        out[normName(k)] = {
          sh: +Math.min(a.sh / a.n, 35).toFixed(1),
          sot: +Math.min(a.sot / a.n, 15).toFixed(1),
          cor: +Math.min(a.cor / a.n, 15).toFixed(1),
          fou: +Math.min(a.fou / a.n, 30).toFixed(1),
          yc: +Math.min(a.yc / a.n, 6).toFixed(1),
          xg: +Math.min(a.xg / a.n, 4.5).toFixed(2),
          n: a.n
        };
      }
      if (Object.keys(out).length) return out;
    } catch (e) { /* siguiente temporada */ }
  }
  return null;
}

export default async function handler(req, res) {
  cors(res);
  res.setHeader('Cache-Control', 's-maxage=300');
  if (req.method === 'OPTIONS') return res.status(200).end();
  const key = process.env.FUTPYTHON_API_KEY;
  if (!key) return res.status(200).json({ ok: false, error: 'falta FUTPYTHON_API_KEY' });
  const league = String(req.query.league || '');
  if (!league) return res.status(200).json({ ok: false, error: 'falta league' });
  const cfg = statsSource(league);
  if (!cfg) return res.status(200).json({ ok: false, error: 'liga no mapeada' });
  const agg = await fetchStats(cfg, key);
  if (!agg) return res.status(200).json({ ok: false, error: 'sin datos para esta liga' });
  res.status(200).json({ ok: true, league: league, teams: agg });
    }
