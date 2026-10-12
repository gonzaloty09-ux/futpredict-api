import { requireAuth, cors, noCache, dbq } from './core.js';
let ready = false;

// M11: dbq y cors centralizados en core.js (antes había copias locales aquí).
const q = function (sql, params) { return dbq(sql, params, 7000); };

async function ensure() {
  if (ready) return;
  await q('create table if not exists preds (id text primary key, home text, away text, league text, pred text, score_pred text, pr jsonb, pm jsonb, pk jsonb, odds_open jsonb, odds_last jsonb, estado text default \'pend\', rs text, clv double precision, created_at timestamptz default now(), updated_at timestamptz default now())');
  // A5: columnas para no perder sn/oddsClose al sincronizar (tablas ya creadas).
  await q('alter table preds add column if not exists sn double precision');
  await q('alter table preds add column if not exists odds_close jsonb');
  ready = true;
}

function js(x) { return x == null ? null : JSON.stringify(x); }
function pj(x) { if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return null; } } return x; }

// Validación/sanitización: el endpoint es público, no confiamos en el input.
function cleanTxt(x, max) {
  if (x == null) return null;
  return String(x).replace(/[<>]/g, '').slice(0, max || 80);
}
function isScore(x) { return x == null || /^\d{1,2}-\d{1,2}$/.test(String(x)); }
function isTri(x) { return x == null || (Array.isArray(x) && x.length === 3 && x.every(function (n) { return typeof n === 'number' && isFinite(n); })); }
function isOdds(x) {
  if (x == null) return true;
  if (!x || typeof x !== 'object' || Array.isArray(x)) return false;
  return ['h', 'd', 'a'].every(function (k) { return x[k] == null || (typeof x[k] === 'number' && isFinite(x[k])); });
}
function validPred(p) {
  if (!p || typeof p.id !== 'string' || !p.id || p.id.length > 64) return false;
  if (p.home != null && typeof p.home !== 'string') return false;
  if (p.away != null && typeof p.away !== 'string') return false;
  if (p.league != null && typeof p.league !== 'string') return false;
  if (typeof p.pred !== 'string' || ['home', 'draw', 'away'].indexOf(p.pred) === -1) return false;
  if (!isScore(p.score) || !isScore(p.rs)) return false;
  if (['pend', 'win', 'loss'].indexOf(p.estado || 'pend') === -1) return false;
  if (!isTri(p.pr) || !isTri(p.pm) || !isTri(p.pk)) return false;
  if (!isOdds(p.oddsOpen) || !isOdds(p.oddsLast) || !isOdds(p.oddsClose)) return false;
  if (p.clv != null && (typeof p.clv !== 'number' || !isFinite(p.clv))) return false;
  if (p.sn != null && (typeof p.sn !== 'number' || !isFinite(p.sn))) return false;
  return true;
}

async function save(list) {
  const seen = {}; const rows = [];
  list.slice(0, 200).forEach(function (p) {
    if (!validPred(p)) return;
    if (seen[p.id]) return;
    seen[p.id] = 1;
    rows.push({
      id: p.id, home: cleanTxt(p.home), away: cleanTxt(p.away), league: cleanTxt(p.league),
      pred: p.pred, score: p.score || null, pr: p.pr, pm: p.pm, pk: p.pk,
      oddsOpen: p.oddsOpen, oddsLast: p.oddsLast, oddsClose: p.oddsClose || null,
      estado: p.estado || 'pend', rs: p.rs || null, clv: p.clv, sn: p.sn
    });
  });
  const chunks = [];
  for (let i = 0; i < rows.length; i += 40) chunks.push(rows.slice(i, i + 40));
  await Promise.all(chunks.map(function (ch) {
    const params = []; const vals = [];
    ch.forEach(function (p, i) {
      const b = i * 16;
      vals.push('($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ',$' + (b + 5) + ',$' + (b + 6) + ',$' + (b + 7) + '::jsonb,$' + (b + 8) + '::jsonb,$' + (b + 9) + '::jsonb,$' + (b + 10) + '::jsonb,$' + (b + 11) + '::jsonb,$' + (b + 12) + '::jsonb,$' + (b + 13) + ',$' + (b + 14) + ',$' + (b + 15) + '::float8,$' + (b + 16) + '::float8)');
      params.push(String(p.id), p.home || null, p.away || null, p.league || null, p.pred || null, p.score || null, js(p.pr), js(p.pm), js(p.pk), js(p.oddsOpen), js(p.oddsLast), js(p.oddsClose), p.estado || 'pend', p.rs || null, p.clv == null ? null : p.clv, p.sn == null ? null : p.sn);
    });
    const sql = 'insert into preds (id,home,away,league,pred,score_pred,pr,pm,pk,odds_open,odds_last,odds_close,estado,rs,clv,sn) values ' + vals.join(',') +
      ' on conflict (id) do update set odds_last=coalesce(excluded.odds_last,preds.odds_last), odds_close=coalesce(excluded.odds_close,preds.odds_close), sn=coalesce(excluded.sn,preds.sn), pk=coalesce(preds.pk,excluded.pk), estado=case when excluded.estado=\'pend\' then preds.estado else excluded.estado end, rs=coalesce(excluded.rs,preds.rs), clv=coalesce(excluded.clv,preds.clv), updated_at=now()';
    return q(sql, params);
  }));
  return rows.length;
}

export default async function handler(req, res) {
  cors(res, 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!requireAuth(req, res)) return;
  noCache(res);
  try {
    await ensure();
    const action = (req.query && req.query.action) || 'list';
    if (action === 'save' && req.method === 'POST') {
      let body = req.body;
      // B5: JSON inválido → 400, no 500.
      if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { return res.status(400).json({ ok: false, error: 'json inválido' }); } }
      const n = await save((body && body.preds) || []);
      return res.status(200).json({ ok: true, saved: n });
    }
    // M10: desc para que lo nuevo no desaparezca al superar 5000 registros.
    const rows = await q('select id,home,away,league,pred,score_pred,pr,pm,pk,odds_open,odds_last,odds_close,estado,rs,clv,sn from preds order by created_at desc limit 5000');
    const preds = rows.map(function (r) {
      const o = { id: r.id, home: r.home, away: r.away, league: r.league, pred: r.pred, score: r.score_pred, pr: pj(r.pr), pm: pj(r.pm), pk: pj(r.pk), oddsOpen: pj(r.odds_open), oddsLast: pj(r.odds_last), oddsClose: pj(r.odds_close), estado: r.estado, rs: r.rs };
      if (r.clv != null) o.clv = Number(r.clv);
      if (r.sn != null) o.sn = Number(r.sn);
      return o;
    });
    return res.status(200).json({ ok: true, count: preds.length, preds: preds });
  } catch (e) {
    // M6: no exponer mensajes internos ('sin DATABASE_URL', 'neon 401'...).
    console.error('api/log', e);
    return res.status(500).json({ ok: false, error: 'error interno' });
  }
}
