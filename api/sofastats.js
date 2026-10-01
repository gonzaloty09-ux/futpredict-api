// Fuente opcional (no oficial). Si falla o cambia de formato, este endpoint responde ok:false
// y el frontend sigue mostrando n/d para este dato, sin afectar al resto de la app.
const SOFA = 'https://api.sofascore.com/api/v1';
const dayCache = {};   // { 'YYYY-MM-DD': { events: [...], ts } }
const statCache = {};  // { eventId: { data, ts } }

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}
function normName(s) {
  return String(s).toLowerCase()
    .replace(/[áàäâéèëêíìïîóòöôúùüûñç]/g, function (c) {
      return { á: 'a', à: 'a', ä: 'a', â: 'a', é: 'e', è: 'e', ë: 'e', ê: 'e', í: 'i', ì: 'i', ï: 'i', î: 'i', ó: 'o', ò: 'o', ö: 'o', ô: 'o', ú: 'u', ù: 'u', ü: 'u', û: 'u', ñ: 'n', ç: 'c' }[c] || c;
    })
    .replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
}
async function getJson(url, ms) {
  const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, ms || 6000);
  try {
    const r = await fetch(url, { signal: c.signal, headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' } });
    if (!r.ok) throw new Error('sofa ' + r.status);
    return await r.json();
  } finally { clearTimeout(t); }
}
async function dbq(sql, params, ms) {
  const cs = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!cs) throw new Error('sin DATABASE_URL');
  const host = new URL(cs).hostname;
  const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, ms || 2500);
  try {
    const r = await fetch('https://' + host + '/sql', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': cs }, body: JSON.stringify({ query: sql, params: params || [] }), signal: c.signal });
    const j = await r.json();
    if (!r.ok) throw new Error(j.message || ('neon ' + r.status));
    return j.rows || [];
  } finally { clearTimeout(t); }
}
async function kvGet(k) {
  try {
    const rows = await dbq('select v, (extract(epoch from ts) * 1000)::float8 as ms from kv where k = $1', [k], 2500);
    if (!rows.length) return null;
    let v = rows[0].v; if (typeof v === 'string') { try { v = JSON.parse(v); } catch (e) { return null; } }
    return { v: v, ms: Number(rows[0].ms) };
  } catch (e) { return null; }
}
async function kvSet(k, v) {
  try { await dbq('create table if not exists kv (k text primary key, v jsonb, ts timestamptz default now())', [], 2500); } catch (e) { /* puede ya existir */ }
  try { await dbq('insert into kv (k, v, ts) values ($1, $2::jsonb, now()) on conflict (k) do update set v = excluded.v, ts = now()', [k, JSON.stringify(v)], 2500); } catch (e) { /* no rompe la respuesta si falla */ }
}

async function eventsForDate(date) {
  const now = Date.now();
  const mem = dayCache[date];
  if (mem && now - mem.ts < 10 * 60 * 1000) return mem.events;
  try {
    const d = await getJson(SOFA + '/sport/football/scheduled-events/' + date, 6000);
    const events = (d.events || []).map(function (e) {
      return { id: e.id, home: e.homeTeam && e.homeTeam.name, away: e.awayTeam && e.awayTeam.name, status: (e.status && e.status.type) || '' };
    });
    dayCache[date] = { events: events, ts: now };
    kvSet('sofa:day:' + date, { events: events }); // best-effort, no se espera
    return events;
  } catch (e) {
    const kv = await kvGet('sofa:day:' + date);
    if (kv) { dayCache[date] = { events: kv.v.events, ts: kv.ms }; return kv.v.events; }
    throw e;
  }
}
function findEvent(events, home, away) {
  const fh = normName(home), fa = normName(away);
  for (let i = 0; i < events.length; i++) {
    const e = events[i]; if (!e.home || !e.away) continue;
    const eh = normName(e.home), ea = normName(e.away);
    const mh = eh.indexOf(fh) !== -1 || fh.indexOf(eh) !== -1;
    const ma = ea.indexOf(fa) !== -1 || fa.indexOf(ea) !== -1;
    if (mh && ma) return e;
  }
  return null;
}
function pickNum(items, keys) {
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const k = String((it.name || '') + ' ' + (it.key || '')).toLowerCase();
    for (let j = 0; j < keys.length; j++) {
      if (k.indexOf(keys[j]) !== -1) {
        const h = it.homeValue != null ? it.homeValue : it.home;
        const a = it.awayValue != null ? it.awayValue : it.away;
        if (h != null && a != null) return { home: h, away: a };
      }
    }
  }
  return null;
}
function parseStats(d) {
  const all = ((d.statistics || []).find(function (p) { return p.period === 'ALL'; })) || (d.statistics || [])[0];
  if (!all) return null;
  const items = [];
  (all.groups || []).forEach(function (g) { (g.statisticsItems || []).forEach(function (it) { items.push(it); }); });
  const get = function (keys) { return pickNum(items, keys) || { home: null, away: null }; };
  const sh = get(['total shots', 'tiros totales']);
  const sot = get(['shots on target', 'tiros a puerta']);
  const cor = get(['corner']);
  const fou = get(['foul']);
  const yc = get(['yellow card']);
  const xg = get(['expected goals', 'xg']);
  return {
    home: { sh: sh.home, sot: sot.home, cor: cor.home, fou: fou.home, yc: yc.home, xg: xg.home },
    away: { sh: sh.away, sot: sot.away, cor: cor.away, fou: fou.away, yc: yc.away, xg: xg.away }
  };
}
async function statsForEvent(id) {
  const now = Date.now();
  const mem = statCache[id];
  if (mem && now - mem.ts < 6 * 60 * 60 * 1000) return mem.data;
  try {
    const d = await getJson(SOFA + '/event/' + id + '/statistics', 6000);
    const parsed = parseStats(d);
    if (parsed) { statCache[id] = { data: parsed, ts: now }; kvSet('sofa:stat:' + id, parsed); }
    return parsed;
  } catch (e) {
    const kv = await kvGet('sofa:stat:' + id);
    if (kv) { statCache[id] = { data: kv.v, ts: kv.ms }; return kv.v; }
    throw e;
  }
}

export default async function handler(req, res) {
  cors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  const home = req.query.home, away = req.query.away, date = req.query.date;
  if (!home || !away || !date) return res.status(200).json({ ok: false, error: 'faltan home/away/date' });
  try {
    const events = await eventsForDate(date);
    const ev = findEvent(events, home, away);
    if (!ev) return res.status(200).json({ ok: false, error: 'no encontrado en Sofascore (puede no ser hoy aún o nombre distinto)' });
    if (ev.status !== 'finished' && ev.status !== 'inprogress') return res.status(200).json({ ok: false, error: 'partido aún no empezó, sin stats todavía' });
    const stats = await statsForEvent(ev.id);
    if (!stats) return res.status(200).json({ ok: false, error: 'Sofascore no devolvió estadísticas para este partido' });
    return res.status(200).json({ ok: true, source: 'sofascore', eventId: ev.id, finished: ev.status === 'finished', home: stats.home, away: stats.away });
  } catch (e) {
    return res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
}
