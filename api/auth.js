import { timingSafeEqual } from 'node:crypto';
import { cors, noCache, sitePassword, isAuthed, setAuthCookie, clearAuthCookie, rateLimitKV, rateLimitReset, clientIp } from './core.js';

// A1: 10 intentos de login cada 10 min por IP, con bloqueo creciente (persistente en kv).
const AUTH_MAX = 10, AUTH_WINDOW = 10 * 60 * 1000;

function pwOk(given, expected) {
  // B1: comparación timing-safe en vez de === (que cortocircuita al primer carácter distinto).
  const a = Buffer.from(String(given), 'utf8'), b = Buffer.from(String(expected), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export default async function handler(req, res) {
  cors(res, 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  noCache(res);
  if (req.method === 'GET') {
    // B2: no revelar si hay contraseña configurada (oráculo de configuración).
    return res.status(200).json({ ok: true, authed: isAuthed(req) });
  }
  if (req.method === 'POST') {
    let body = req.body;
    if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
    if (body && body.logout) { clearAuthCookie(res); return res.status(200).json({ ok: true }); }
    const pw = sitePassword();
    if (!pw) return res.status(500).json({ ok: false, error: 'SITE_PASSWORD no configurada en el servidor' });
    const rlKey = 'rl:auth:' + clientIp(req);
    const rl = await rateLimitKV(rlKey, AUTH_MAX, AUTH_WINDOW);
    if (!rl.allowed) {
      res.setHeader('Retry-After', String(rl.retryAfter));
      return res.status(429).json({ ok: false, error: 'demasiados intentos, esperá unos minutos' });
    }
    if (body && typeof body.password === 'string' && pwOk(body.password, pw)) {
      await rateLimitReset(rlKey); // el login correcto limpia el contador
      setAuthCookie(res);
      return res.status(200).json({ ok: true });
    }
    await new Promise(function (r) { setTimeout(r, 800); });
    return res.status(401).json({ ok: false, error: 'contrasena incorrecta' });
  }
  return res.status(405).json({ ok: false, error: 'method' });
}
