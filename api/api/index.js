const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const FOOTBALL_API = 'https://api.football-data.org/v4';
const API_TOKEN = process.env.FOOTBALL_DATA_TOKEN;

// Cache en memoria (Vercel lo mantiene caliente ~5 min)
const cache = { standings: null, fixtures: null, ts: 0 };

// Helpers del modelo (los mismos que tu HTML, pero con datos reales)
function cl(v, a, b) { return Math.max(a, Math.min(b, v)); }
function poisson(l, k) { return (Math.pow(l, k) * Math.exp(-l)) / factorial(k); }
function factorial(n) { let r = 1; for (let i = 2; i <= n; i++) r *= i; return r; }

function calcProbs(hL, aL) {
  const maxG = 7;
  let hW = 0, d = 0, aW = 0;
  for (let h = 0; h <= maxG; h++) {
    for (let a = 0; a <= maxG; a++) {
      const p = poisson(hL, h) * poisson(aL, a);
      if (h > a) hW += p;
      else if (h === a) d += p;
      else aW += p;
    }
  }
  const tot = hW + d + aW;
  return {
    home: Math.round((hW / tot) * 100),
    draw: Math.round((d / tot) * 100),
    away: Math.round((aW / tot) * 100)
  };
}

// Ajuste de ratings con datos reales (Dixon-Coles simplificado)
function buildRatings(matches, leagueAvg = 1.35) {
  const teams = {};
  matches.forEach(m => {
    if (!teams[m.homeTeam.name]) teams[m.homeTeam.name] = { att: 1, def: 1, matches: 0, gf: 0, ga: 0 };
    if (!teams[m.awayTeam.name]) teams[m.awayTeam.name] = { att: 1, def: 1, matches: 0, gf: 0, ga: 0 };
    teams[m.homeTeam.name].gf += m.score.fullTime.home || 0;
    teams[m.homeTeam.name].ga += m.score.fullTime.away || 0;
    teams[m.homeTeam.name].matches++;
    teams[m.awayTeam.name].gf += m.score.fullTime.away || 0;
    teams[m.awayTeam.name].ga += m.score.fullTime.home || 0;
    teams[m.awayTeam.name].matches++;
  });
  
  const ratings = {};
  Object.keys(teams).forEach(name => {
    const t = teams[name];
    if (t.matches < 3) return;
    const att = t.gf / t.matches / leagueAvg;
    const def = t.ga / t.matches / leagueAvg;
    ratings[name] = {
      att: cl(att, 0.5, 2.5),
      def: cl(def, 0.5, 2.5),
      elo: 1500 + Math.round((t.gf - t.ga) * 10)
    };
  });
  return ratings;
}

// Endpoint principal: predicciones de hoy
app.get('/api/predictions', async (req, res) => {
  try {
    if (!API_TOKEN) {
      return res.status(500).json({ error: 'API token no configurado' });
    }
    
    // Fetch fixtures de hoy (con cache de 10 min)
    const now = Date.now();
    if (!cache.fixtures || now - cache.ts > 10 * 60 * 1000) {
      const today = new Date().toISOString().split('T')[0];
      const fixturesRes = await axios.get(`${FOOTBALL_API}/matches`, {
        headers: { 'X-Auth-Token': API_TOKEN },
        params: { dateFrom: today, dateTo: today }
      });
      cache.fixtures = fixturesRes.data.matches;
      cache.ts = now;
    }
    
    // Para cada partido, calcular predicción
    const predictions = await Promise.all(cache.fixtures.map(async (match) => {
      const leagueId = match.competition.id;
      
      // Traer últimos 50 partidos de la liga para ajustar ratings
      const historyRes = await axios.get(`${FOOTBALL_API}/competitions/${leagueId}/matches`, {
        headers: { 'X-Auth-Token': API_TOKEN },
        params: { status: 'FINISHED', limit: 50 }
      }).catch(() => ({ data: { matches: [] } }));
      
      const ratings = buildRatings(historyRes.data.matches);
      const home = ratings[match.homeTeam.name] || { att: 1, def: 1, elo: 1500 };
      const away = ratings[match.awayTeam.name] || { att: 1, def: 1, elo: 1500 };
      
      // Lambdas Dixon-Coles
      const hL = cl(1.35 * home.att * away.def * 1.15, 0.3, 3.5);
      const aL = cl(1.35 * away.att * home.def, 0.2, 3.0);
      
      const probs = calcProbs(hL, aL);
      const main = probs.home >= probs.draw && probs.home >= probs.away ? 'home'
                 : probs.away >= probs.home && probs.away >= probs.draw ? 'away' : 'draw';
      
      return {
        id: match.id,
        home: match.homeTeam.name,
        away: match.awayTeam.name,
        league: match.competition.name,
        time: match.utcDate,
        probs,
        main,
        hL: hL.toFixed(2),
        aL: aL.toFixed(2),
        ratingHome: home,
        ratingAway: away
      };
    }));
    
    res.json({ ok: true, predictions, generated: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ ok: true, hasToken: !!API_TOKEN });
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`API running on ${port}`));
