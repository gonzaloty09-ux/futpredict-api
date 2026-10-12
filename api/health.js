import { requireAuth } from './core.js';
export default function handler(req, res) {
  if (!requireAuth(req, res)) return;
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({ ok: true, hasToken: !!process.env.FOOTBALL_DATA_TOKEN });
}
