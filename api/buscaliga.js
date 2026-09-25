export default async function handler(req, res) {
  const key = process.env.APIFOOTBALL_KEY;
  if (!key) return res.status(500).json({ error: 'Falta APIFOOTBALL_KEY' });
  const q = req.query.q || 'Nations League';
  try {
    const r = await fetch('https://v3.football.api-sports.io/leagues?search=' + encodeURIComponent(q), {
      headers: { 'x-apisports-key': key }
    });
    const j = await r.json();
    const simple = (j.response || []).map(function (x) {
      return { id: x.league.id, name: x.league.name, type: x.league.type, country: x.country.name };
    });
    res.status(200).json({ query: q, httpStatus: r.status, apiErrors: j.errors, rawResults: j.results, count: simple.length, results: simple });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e) });
  }
}
