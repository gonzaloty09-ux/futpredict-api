import { requireAuth, cors, noCache } from './core.js';
export default function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  noCache(res);
  // B7: no revelar configuración (antes exponía hasToken).
  res.status(200).json({ ok: true });
}
