const API = 'https://api.football-data.org/v4';
async function one(path, token) {
  const c = new AbortController();
  const t = setTimeout(function () { c.abort(); }, 6000);
  try {
    const r = await fetch(API + path, { headers: { 'X-Auth-Token': token }, signal: c.signal });
    const j = await r.json().catch(function () { return null; });
    return { consulta: path, status: r.status, partidos: j && j.matches ? j.matches.length : null };
  } catch (e) {
    return { consulta: path, error: String(e.message || e) };
  } finally { clearTimeout(t); }
}
export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const token = process.env.FOOTBALL_DATA_TOKEN;
  if (!token) return res.status(200).json({ ok: false, error: 'falta token' });
  const now = new Date();
  const to = new Date(now.getTime() + 6 * 86400000).toISOString().split('T')[0];
  const f10 = new Date(now.getTime() - 10 * 86400000).toISOString().split('T')[0];
  const f3 = new Date(now.getTime() - 3 * 86400000).toISOString().split('T')[0];
  const out = await Promise.all([
    one('/matches?dateFrom=' + f10 + '&dateTo=' + to, token),
    one('/matches?dateFrom=' + f3 + '&dateTo=' + to, token),
    one('/competitions/PL/matches?status=FINISHED&limit=5', token)
  ]);
  res.status(200).json({ ok: true, out: out });
}
