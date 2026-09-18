export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  const key = process.env.FUTPYTHON_API_KEY;
  if (!key) return res.status(200).json({ ok: false, error: 'falta FUTPYTHON_API_KEY' });
  const tries = [
    ['spain', 'laliga', '2026-2027'],
    ['spain', 'la-liga', '2026-2027'],
    ['england', 'premier-league', '2026-2027'],
    ['england', 'premierleague', '2026-2027'],
    ['europe', 'champions-league', '2026-2027']
  ];
  const out = [];
  for (const t of tries) {
    const url = 'https://futpythontrader.com.br/api/download/' + t[0] + '/' + t[1] + '/' + t[2] + '?api_key=' + key;
    try {
      const r = await fetch(url);
      const text = await r.text();
      out.push({ intento: t.join('/'), status: r.status, caracteres: text.length, inicio: text.slice(0, 100) });
    } catch (e) {
      out.push({ intento: t.join('/'), error: String(e.message || e) });
    }
  }
  res.status(200).json({ ok: true, out });
}
