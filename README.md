# ⚽ FutPredict Pro

App de predicciones de fútbol con datos reales y métricas medidas. Sin números inventados.

## Archivos
- `index.html` — Frontend (v19): tarjetas, dashboard con Brier/log-loss/CLV, historial, export CSV.
- `api/predictions.js` — Motor: fixtures football-data.org + ratings local/visita con decaimiento + Dixon-Coles + descanso + λ calibrado por totales del mercado + mezcla con cuotas The Odds API + value.
- `api/stats.js` — Stats reales de temporada (tiros, córners, faltas, amarillas, xG) desde FutPythonTrader, por liga, cacheado.
- `api/backtest.js` — Evaluación fuera de muestra (accuracy, Brier, log-loss) por liga.
- `api/envcheck.js`, `api/statsdebug.js` — Diagnósticos históricos (pueden borrarse).
- `manifest.webmanifest` — PWA instalable.

## Fuentes
- football-data.org (fixtures/resultados/forma) — plan gratis.
- The Odds API (cuotas h2h y totales) — plan gratis 500/mes.
- FutPythonTrader (stats históricas por temporada) — cuenta gratis.

## Variables de entorno (Vercel)
- FOOTBALL_DATA_TOKEN
- ODDS_API_KEY
- FUTPYTHON_API_KEY

## Principios
- Si un dato no existe en fuentes gratuitas, se muestra `n/d`, no se inventa.
- Toda métrica de calidad (precisión, Brier, log-loss, CLV) se mide sobre resultados reales.
- Las funciones opcionales nunca deben romper la ruta principal.
