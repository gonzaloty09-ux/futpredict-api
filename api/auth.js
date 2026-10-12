import { cors, sitePassword, isAuthed, setAuthCookie, clearAuthCookie } from './core.js';

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, authed: isAuthed(req), protected: !!sitePassword() });
  }
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    if (body && body.logout) { clearAuthCookie(res); return res.status(200).json({ ok: true }); }
    const pw = sitePassword();
    if (!pw) return res.status(500).json({ ok: false, error: 'SITE_PASSWORD no configurada en el servidor' });
    if (body && typeof body.password === 'string' && body.password === pw) {
      setAuthCookie(res);
      return res.status(200).json({ ok: true });
    }
    await new Promise(function (r) { setTimeout(r, 800); });
    return res.status(401).json({ ok: false, error: 'contrasena incorrecta' });
  }
  return res.status(405).json({ ok: false, error: 'method' });
}
