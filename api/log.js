let ready = false;

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

async function q(sql, params) {
  const cs = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!cs) throw new Error('Falta DATABASE_URL');
  const host = new URL(cs).hostname;
  const c = new AbortController();
  const t = setTimeout(function () { c.abort(); }, 7000);
  try {
    const r = await fetch('https://' + host + '/sql', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': cs },
      body: JSON.stringify({ query: sql, params: params || [] }),
      signal: c.signal
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || ('neon ' + r.status));
    return j.rows || [];
  } finally { clearTimeout(t); }
}

async function ensure() {
  if (ready) return;
  await q('create table if not exists preds (id text primary key, home text, away text, league text, pred text, score_pred text, pr jsonb, pm jsonb, pk jsonb, odds_open jsonb, odds_last jsonb, estado text default \'pend\', rs text, clv double precision, created_at timestamptz default now(), updated_at timestamptz default now())');
  ready = true;
}

function js(x) { return x == null ? null : JSON.stringify(x); }
function pj(x) { if (typeof x === 'string') { try { return JSON.parse(x); } catch (e) { return null; } } return x; }

async function save(list) {
  const seen = {}; const rows = [];
  list.slice(0, 200).forEach(function (p) {
    if (!p || !p.id || seen[p.id]) return;
    seen[p.id] = 1; rows.push(p);
  });
  const chunks = [];
  for (let i = 0; i < rows.length; i += 40) chunks.push(rows.slice(i, i + 40));
  await Promise.all(chunks.map(function (ch) {
    const params = []; const vals = [];
    ch.forEach(function (p, i) {
      const b = i * 14;
      vals.push('($' + (b + 1) + ',$' + (b + 2) + ',$' + (b + 3) + ',$' + (b + 4) + ',$' + (b + 5) + ',$' + (b + 6) + ',$' + (b + 7) + '::jsonb,$' + (b + 8) + '::jsonb,$' + (b + 9) + '::jsonb,$' + (b + 10) + '::jsonb,$' + (b + 11) + '::jsonb,$' + (b + 12) + ',$' + (b + 13) + ',$' + (b + 14) + '::float8)');
      params.push(String(p.id), p.home || null, p.away || null, p.league || null, p.pred || null, p.score || null, js(p.pr), js(p.pm), js(p.pk), js(p.oddsOpen), js(p.oddsLast), p.estado || 'pend', p.rs || null, p.clv == null ? null : p.clv);
    });
    const sql = 'insert into preds (id,home,away,league,pred,score_pred,pr,pm,pk,odds_open,odds_last,estado,rs,clv) values ' + vals.join(',') +
      ' on conflict (id) do update set odds_last=coalesce(excluded.odds_last,preds.odds_last), pk=coalesce(preds.pk,excluded.pk), estado=case when excluded.estado=\'pend\' then preds.estado else excluded.estado end, rs=coalesce(excluded.rs,preds.rs), clv=coalesce(excluded.clv,preds.clv), updated_at=now()';
    return q(sql, params);
  }));
  return rows.length;
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  try {
    await ensure();
    const action = (req.query && req.query.action) || 'list';
    if (action === 'save' && req.method === 'POST') {
      let body = req.body;
      if (typeof body === 'string') body = JSON.parse(body);
      const n = await save((body && body.preds) || []);
      return res.status(200).json({ ok: true, saved: n });
    }
    const rows = await q('select id,home,away,league,pred,score_pred,pr,pm,pk,odds_open,odds_last,estado,rs,clv from preds order by created_at asc limit 5000');
    const preds = rows.map(function (r) {
      const o = { id: r.id, home: r.home, away: r.away, league: r.league, pred: r.pred, score: r.score_pred, pr: pj(r.pr), pm: pj(r.pm), pk: pj(r.pk), oddsOpen: pj(r.odds_open), oddsLast: pj(r.odds_last), estado: r.estado, rs: r.rs };
      if (r.clv != null) o.clv = Number(r.clv);
      return o;
    });
    return res.status(200).json({ ok: true, count: preds.length, preds: preds });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
}
