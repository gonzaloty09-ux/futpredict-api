// Fuente extra gratuita: ESPN site API (sin API key).
// Ligas y copas que football-data.org no cubre en el plan gratis. ESPN en fútbol solo acepta fecha única (no rangos):
// los partidos próximos y en vivo salen del scoreboard sin fechas; el historial se llena con "sondas" por día
// (presupuesto fiio por request, estado persistido en KV), así el primer llenado lleva unos minutos.
export const ESPN_LEAGUES = [
  { code: 'eng.2', name: 'Championship' },
  { code: 'esp.2', name: 'LaLiga 2' },
  { code: 'ger.2', name: 'Bundesliga 2' },
  { code: 'ita.2', name: 'Serie B' },
  { code: 'fra.2', name: 'Ligue 2' },
  { code: 'ned.1', name: 'Eredivisie' },
  { code: 'por.1', name: 'Primeira Liga' },
  { code: 'bra.1', name: 'Campeonato Brasileiro Série A' },
  { code: 'bra.2', name: 'Brasileirão Série B' },
  { code: 'mex.1', name: 'Liga MX' },
  { code: 'usa.1', name: 'Major League Soccer' },
  { code: 'arg.1', name: 'Liga Profesional Argentina' },
  { code: 'tur.1', name: 'Süper Lig' },
  { code: 'bel.1', name: 'Pro League Bélgica' },
  { code: 'sco.1', name: 'Scottish Premiership' },
  { code: 'uefa.champions', name: 'UEFA Champions League' },
  { code: 'uefa.europa', name: 'UEFA Europa League' },
  { code: 'uefa.europa.conf', name: 'UEFA Conference League' },
  { code: 'conmebol.libertadores', name: 'CONMEBOL Libertadores' },
  { code: 'conmebol.sudamericana', name: 'CONMEBOL Sudamericana' },
  { code: 'eng.fa', name: 'FA Cup' },
  { code: 'eng.league_cup', name: 'EFL Cup' },
  { code: 'esp.copa_del_rey', name: 'Copa del Rey' },
  { code: 'ger.dfb_pokal', name: 'DFB Pokal' },
  { code: 'ita.coppa_italia', name: 'Coppa Italia' },
  { code: 'fra.coupe_de_france', name: 'Coupe de France' },
  { code: 'uefa.nations', name: 'Nations League' }
];
const ESPN_BY_CODE = {};
ESPN_LEAGUES.forEach(function (L) { ESPN_BY_CODE[L.code] = L; });
const ESP = {};        // por código: { up: [], fin: [], probed: { aaaammdd: ts }, ts }
const ESP_TOUCH = {};
let SB_TS = 0;         // último refresh de scoreboard (por instancia)
let PROBE_TS = 0;      // último lote de sondas históricas

// Palabras genéricas para comparar nombres de equipos entre fuentes ("CA Mineiro" vs "Atlético Mineiro").
const GENERIC = { fc: 1, sc: 1, ca: 1, cd: 1, ec: 1, rb: 1, cf: 1, ac: 1, as: 1, afc: 1, club: 1, clube: 1, de: 1, do: 1, da: 1 };
function normName(s) {
  return String(s).toLowerCase()
    .replace(/[áàäâãåéèëêíìïîóòöôõúùüûñç]/g, function (c) {
      return { á: 'a', à: 'a', ä: 'a', â: 'a', ã: 'a', å: 'a', é: 'e', è: 'e', ë: 'e', ê: 'e', í: 'i', ì: 'i', ï: 'i', î: 'i', ó: 'o', ò: 'o', ö: 'o', ô: 'o', õ: 'o', ú: 'u', ù: 'u', ü: 'u', û: 'u', ñ: 'n', ç: 'c' }[c] || c;
    })
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
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

async function espnScoreboard(code, day) {
  const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, 4000);
  try {
    const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + code + '/scoreboard' + (day ? '?dates=' + day : ''), { signal: c.signal });
    if (!r.ok) throw new Error('espn ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
function espnParse(ev, L) {
  try {
    const comp = ev.competitions && ev.competitions[0];
    if (!comp || !comp.competitors || comp.competitors.length < 2) return null;
    let h = null, a = null;
    comp.competitors.forEach(function (c) {
      const score = (c.score == null || Array.isArray(c.score)) ? NaN : parseInt(c.score, 10);
      const rec = {
        name: (c.team && (c.team.displayName || c.team.shortDisplayName || c.team.name)) || null,
        score: isFinite(score) ? score : null,
        form: (typeof c.form === 'string' && c.form.length === 5) ? c.form.split('') : null
      };
      if (!rec.name) return;
      if (c.homeAway === 'home') h = rec; else a = rec;
    });
    if (!h || !a) return null;
    const st = ev.status && ev.status.type ? ev.status.type : {};
    let status = 'SCHEDULED';
    if (st.state === 'in') status = 'IN_PLAY';
    else if (st.state === 'post') status = st.completed ? 'FINISHED' : 'POSTPONED';
    const gotScore = status === 'FINISHED' && h.score != null && a.score != null;
    const m = { id: 'espn:' + ev.id, utcDate: ev.date, homeTeam: { name: h.name }, awayTeam: { name: a.name }, status: status, competition: { id: 'espn:' + L.code, name: L.name }, score: { fullTime: { home: gotScore ? h.score : null, away: gotScore ? a.score : null } } };
    if (h.form) m.formHome = h.form;
    if (a.form) m.formAway = a.form;
    return m;
  } catch (e) { return null; }
}
function espnAbsorb(code, ms, now) {
  if (!ms.length && !ESP[code]) return;
  const E = ESP[code] = ESP[code] || { up: [], fin: [], probed: {}, ts: 0 };
  let ch = false;
  ms.forEach(function (m) {
    const tgt = m.status === 'FINISHED' ? E.fin : E.up;
    const i = tgt.findIndex(function (x) { return x.id === m.id; });
    if (i === -1) { tgt.push(m); ch = true; }
    else if (JSON.stringify(tgt[i]) !== JSON.stringify(m)) { tgt[i] = m; ch = true; }
    if (m.status === 'FINISHED') {
      const j = E.up.findIndex(function (x) { return x.id === m.id; });
      if (j !== -1) { E.up.splice(j, 1); ch = true; }
    }
  });
  if (E.fin.length > 400) E.fin = E.fin.slice(-400);
  if (E.up.length > 100) E.up = E.up.slice(-100);
  if (ch) { E.ts = now; ESP_TOUCH[code] = 1; }
}
function espnPlanProbes(now, budget) {
  const list = [];
  // Primero las ligas con menos historial; dentro de cada una, los días más recientes (pesan más por el decaimiento).
  const codes = ESPN_LEAGUES.map(function (L) { return L.code; }).sort(function (a, b) {
    const ea = ESP[a] ? ESP[a].fin.length : 0, eb = ESP[b] ? ESP[b].fin.length : 0;
    return ea - eb;
  });
  for (let d = 1; d <= 30 && budget > 0; d++) {
    for (let i = 0; i < codes.length && budget > 0; i++) {
      const code = codes[i];
      const day = new Date(now - d * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
      const E = ESP[code];
      const last = E && E.probed ? E.probed[day] : null;
      const ok = d <= 4 ? (now - (last || 0) > 3 * 3600000) : !last;
      if (!ok) continue;
      list.push({ code: code, day: day }); budget--;
    }
  }
  return list;
}

// Restaurar estado desde KV (al arranque de una instancia fría).
export function espnRestore(code, data, ms) {
  if (!data || !data.fin) return;
  if (!ESP[code] || ESP[code].ts < ms) ESP[code] = { up: data.up || [], fin: data.fin, probed: data.probed || {}, ts: ms };
}

// Refresca scoreboards + sondas históricas y persiste lo cambiado. kvSave: async (k, v).
export async function espnRefresh(now, kvSave) {
  if (now - SB_TS > 90000) {
    SB_TS = now;
    try {
      const esRes = await Promise.all(ESPN_LEAGUES.map(function (L) {
        return espnScoreboard(L.code).then(function (d) {
          return ((d && d.events) || []).map(function (ev) { return espnParse(ev, L); }).filter(Boolean);
        }).catch(function () { return []; });
      }));
      esRes.forEach(function (arr, i) { espnAbsorb(ESPN_LEAGUES[i].code, arr, now); });
    } catch (e) { /* ESPN caído: sigue con football-data */ }
  }
  const probes = (now - PROBE_TS > 45000) ? espnPlanProbes(now, 12) : [];
  if (probes.length) {
    PROBE_TS = now;
    try {
      const prRes = await Promise.all(probes.map(function (pb) {
        return espnScoreboard(pb.code, pb.day).then(function (d) {
          return { pb: pb, ms: ((d && d.events) || []).map(function (ev) { return espnParse(ev, ESPN_BY_CODE[pb.code]); }).filter(Boolean) };
        }).catch(function () { return null; });
      }));
      prRes.forEach(function (r) {
        if (!r) return;
        espnAbsorb(r.pb.code, r.ms, now);
        const E = ESP[r.pb.code]; if (E) E.probed[r.pb.day] = now;
        ESP_TOUCH[r.pb.code] = 1;
      });
    } catch (e) { /* idem */ }
  }
  const tcodes = Object.keys(ESP_TOUCH);
  if (tcodes.length) await Promise.all(tcodes.map(function (c) { return kvSave('e:espn:' + c, ESP[c]); }));
}

export function espnMatches() {
  const out = [];
  ESPN_LEAGUES.forEach(function (L) {
    const E = ESP[L.code]; if (!E) return;
    E.up.forEach(function (m) { out.push(m); });
    E.fin.forEach(function (m) { out.push(m); });
  });
  return out;
}
export function sameFixture(a, b) {
  if (!a || !b || !a.homeTeam || !b.homeTeam || !a.awayTeam || !b.awayTeam) return false;
  return (a.utcDate || '').slice(0, 10) === (b.utcDate || '').slice(0, 10)
    && sameTeam(normName(a.homeTeam.name), normName(b.homeTeam.name))
    && sameTeam(normName(a.awayTeam.name), normName(b.awayTeam.name));
}
// Feeds de historial para construir ratings por liga: [{ cid, fin }].
export function espnHistFeeds() {
  const out = [];
  ESPN_LEAGUES.forEach(function (L) {
    const E = ESP[L.code];
    if (E && E.fin && E.fin.length >= 6) out.push({ cid: 'espn:' + L.code, fin: E.fin });
  });
  return out;
}
export function espnInfo() {
  let n = 0;
  ESPN_LEAGUES.forEach(function (L) { const E = ESP[L.code]; if (E) n += E.up.length + E.fin.length; });
  return { ligas: ESPN_LEAGUES.length, partidos: n };
}
