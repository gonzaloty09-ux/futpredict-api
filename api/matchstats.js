// Stats reales de un partido (tiros, posesión, córners, faltas, amarillas) + últimos 5 de cada equipo.
// Fuente: ESPN summary, gratis y sin key. Solo ligas ESPN (la UI manda league=<código> y event=<id>).
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Cache-Control': 'public, max-age=120'
};

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    Object.keys(CORS).forEach(function (k) { res.setHeader(k, CORS[k]); });
    return res.status(204).end();
  }
  if (req.method !== 'GET') return res.status(405).json({ ok: false, error: 'method' });

  const league = String(req.query.league || '');
  const event = String(req.query.event || '');
  if (!/^[a-z0-9.]+$/i.test(league) || league.length > 40 || !/^\d+$/.test(event) || event.length > 20) {
    return res.status(400).json({ ok: false, error: 'params' });
  }

  try {
    const c = new AbortController();
    const t = setTimeout(function () { c.abort(); }, 8000);
    let s;
    try {
      const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/soccer/' + league + '/summary?event=' + event, { signal: c.signal });
      if (!r.ok) throw new Error('espn ' + r.status);
      s = await r.json();
    } finally { clearTimeout(t); }

    const stat = function (team, name) {
      const st = (team.statistics || []).find(function (x) { return x.name === name; });
      return st ? st.displayValue : null;
    };
    const mapTeam = function (t) {
      return {
        sh: stat(t, 'totalShots'), sot: stat(t, 'shotsOnTarget'), pos: stat(t, 'possessionPct'),
        cor: stat(t, 'wonCorners'), fou: stat(t, 'foulsCommitted'), yc: stat(t, 'yellowCards'),
        rc: stat(t, 'redCards'), sav: stat(t, 'saves'), off: stat(t, 'offsides'),
        blo: stat(t, 'blockedShots'), pas: stat(t, 'totalPasses'), cru: stat(t, 'totalCrosses'),
        lon: stat(t, 'totalLongBalls'), tac: stat(t, 'totalTackles'), int: stat(t, 'interceptions'),
        cle: stat(t, 'totalClearance')
      };
    };
    const teams = (s.boxscore && s.boxscore.teams) || [];
    const home = teams.find(function (x) { return x.homeAway === 'home'; });
    const away = teams.find(function (x) { return x.homeAway === 'away'; });

    const header = s.header && s.header.competitions && s.header.competitions[0];
    const state = header && header.status && header.status.type && header.status.type.state;
    const started = state === 'in' || state === 'post';

    const l5 = (s.lastFiveGames || []).map(function (e) {
      return {
        team: e.team ? (e.team.displayName || e.team.name) : null,
        events: (e.events || []).slice(0, 5).map(function (ev) {
          // El score de ESPN es local-visitante y atVs no siempre es fiable:
          // reconstruir el marcador desde el punto de vista del equipo.
          const th = e.team && ev.homeTeamId != null ? String(e.team.id) === String(ev.homeTeamId) : ev.atVs !== '@';
          const gf = th ? ev.homeTeamScore : ev.awayTeamScore;
          const ga = th ? ev.awayTeamScore : ev.homeTeamScore;
          const r = gf != null && ga != null ? (Number(gf) > Number(ga) ? 'W' : (Number(gf) === Number(ga) ? 'D' : 'L')) : (ev.gameResult || '');
          return { d: (ev.gameDate || '').slice(5, 10), r: r, s: gf != null && ga != null ? (gf + '-' + ga) : (ev.score || ''), o: ev.opponent ? ev.opponent.displayName : '', at: !th };
        })
      };
    }).filter(function (x) { return x.team; });

    Object.keys(CORS).forEach(function (k) { res.setHeader(k, CORS[k]); });
    return res.status(200).json({
      ok: true, started: started,
      home: home ? mapTeam(home) : null,
      away: away ? mapTeam(away) : null,
      l5: l5
    });
  } catch (e) {
    Object.keys(CORS).forEach(function (k) { res.setHeader(k, CORS[k]); });
    return res.status(200).json({ ok: false, error: 'upstream' });
  }
}
