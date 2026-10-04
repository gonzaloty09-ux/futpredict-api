// Fuente extra gratuita: ESPN site API (sin API key).
// Ligas y copas que football-data.org no cubre en el plan gratis. ESPN en fútbol solo acepta fecha única (no rangos):
// los partidos próximos y en vivo salen del scoreboard sin fechas; el historial se llena con "sondas" por día
// (presupuesto fijo por request, estado persistido en KV), así el primer llenado lleva unos minutos.
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
  { code: 'conmebol.libertadores', name: 'COMMEBOL Libertadores' },
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
  const c = new AbortController!�'.abort(); }, 4000);
