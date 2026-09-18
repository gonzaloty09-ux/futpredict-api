export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).json({
    football: !!process.env.FOOTBALL_DATA_TOKEN,
    odds: !!process.env.ODDS_API_KEY
  });
}
