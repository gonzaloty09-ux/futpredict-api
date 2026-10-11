// Utilidades del modelo: DB, ratings Dixon-Coles, Poisson, mapeo de ligas, cuotas.
export const DECAY_D = 60;

export async function dbq(sql, params, ms) {
  const cs = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!cs) throw new Error('sin DATABASE_URL');
  const host = new URL(cs).hostname;
  // Neon suspende la base por inactividad: despertarla puede tardar >2.5s y antes
  // abortabamos y perdiamos historial/stats. Ahora 8s por intento + 1 reintento
  // (el 1er intento despierta la base, el 2do ya la encuentra tibia).
  const intento = async function () {
    const c = new AbortController(); const t = setTimeout(function () { c.abort(); }, ms || 8000);
    try {
      const r = await fetch('https://' + host + '/sql', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Neon-Connection-String': cs }, body: JSON.stringify({ query: sql, params: params || [] }), signal: c.signal });
      const j = await r.json();
      if (!r.ok) throw new Error(j.message || ('neon ' + r.status));
      return j.rows || [];
    } finally { clearTimeout(t); }
  };
  try { return await intento(); }
  catch (e) {
    const msg = String((e && e.message) || e);
    if (msg.indexOf('aborted') === -1 && msg.indexOf('timeout') === -1) throw e;
    return await intento();
  }
}