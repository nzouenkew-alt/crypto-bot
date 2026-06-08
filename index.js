const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY    = process.env.BINANCE_API_KEY    || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

function binanceRequest(method, endpoint, params = {}, signed = false) {
  return new Promise((resolve, reject) => {
    let query = Object.entries(params).map(([k, v]) => `${k}=${v}`).join('&');
    if (signed) {
      const timestamp = Date.now();
      query += (query ? '&' : '') + `timestamp=${timestamp}`;
      const signature = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
      query += `&signature=${signature}`;
    }
    const options = {
      hostname: 'data-api.binance.vision',
      path: `/api/v3/${endpoint}${query ? '?' + query : ''}`,
      method,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('Parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function calcRSI(prices, period = 14) {
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const rs = gains / (losses || 0.0001);
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

function calcMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  const slice = prices.slice(-period);
  return parseFloat((slice.reduce((a, b) => a + b, 0) / period).toFixed(2));
}

function analyzeSignal(closes) {
  const rsi  = calcRSI(closes);
  const ma7  = calcMA(closes, 7);
  const ma25 = calcMA(closes, 25);
  const ma99 = calcMA(closes, 99);
  const trend = ma7 > ma25 ? 'HAUSSIÈRE' : 'BAISSIÈRE';
  let signal = null;
  if (rsi < 30 && ma7 > ma25) {
    signal = { action: 'ACHETER', confidence: Math.min(95, Math.round(75 + (30 - rsi))), reason: `RSI survendu (${rsi}) + tendance ${trend}. Bon point d'entrée.`, rsi, ma7, ma25, trend };
  } else if (rsi > 70 && ma7 < ma25) {
    signal = { action: 'VENDRE', confidence: Math.min(95, Math.round(75 + (rsi - 70))), reason: `RSI suracheté (${rsi}) + tendance ${trend}. Moment de prendre les profits.`, rsi, ma7, ma25, trend };
  }
  return { signal, rsi, ma7, ma25, ma99, trend };
}

app.get('/api/price/:symbol', async (req, res) => {
  try {
    const data = await binanceRequest('GET', 'ticker/price', { symbol: req.params.symbol.toUpperCase() });
    const price = parseFloat(data.price);
    if (!price || isNaN(price)) return res.status(500).json({ error: 'Prix invalide' });
    res.json({ price });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analyze/:symbol', async (req, res) => {
  try {
    const interval = req.query.interval || '1h';
    const data = await binanceRequest('GET', 'klines', { symbol: req.params.symbol.toUpperCase(), interval, limit: 150 });
    const closes = data.map(k => parseFloat(k[4]));
    res.json(analyzeSignal(closes));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/balance', async (req, res) => {
  try {
    const data = await binanceRequest('GET', 'account', {}, true);
    const balances = data.balances
      .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map(b => ({ asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }));
    res.json({ balances });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/order', async (req, res) => {
  try {
    const { symbol, side, quantity } = req.body;
    const order = await binanceRequest('POST', 'order', {
      symbol: symbol.toUpperCase(), side: side.toUpperCase(), type: 'MARKET', quantity: parseFloat(quantity).toFixed(6),
    }, true);
    res.json({ success: true, order });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Bot démarré sur le port ${PORT}`));
