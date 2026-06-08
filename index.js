const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || '';
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || '';

function sendTelegram(msg) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) return;
  const text = encodeURIComponent(msg);
  const options = {
    hostname: 'api.telegram.org',
    path: '/bot' + TELEGRAM_TOKEN + '/sendMessage?chat_id=' + TELEGRAM_CHAT_ID + '&text=' + text,
    method: 'GET'
  };
  const req = https.request(options, function() {});
  req.on('error', function() {});
  req.end();
}

function binanceRequest(method, endpoint, params, signed) {
  if (!params) params = {};
  if (!signed) signed = false;
  return new Promise(function(resolve, reject) {
    let query = Object.entries(params).map(function(e) {
      return e[0] + '=' + e[1];
    }).join('&');
    if (signed) {
      const timestamp = Date.now();
      query += (query ? '&' : '') + 'timestamp=' + timestamp;
      const signature = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
      query += '&signature=' + signature;
    }
    const options = {
      hostname: 'data-api.binance.vision',
      path: '/api/v3/' + endpoint + (query ? '?' + query : ''),
      method: method,
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json',
        'User-Agent': 'Mozilla/5.0'
      }
    };
    const req = https.request(options, function(res) {
      let data = '';
      res.on('data', function(chunk) { data += chunk; });
      res.on('end', function() {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: ' + data)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function calcRSI(prices, period) {
  if (!period) period = 14;
  if (prices.length < period + 1) return 50;
  let gains = 0;
  let losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const rs = gains / (losses || 0.0001);
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

function calcMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  const slice = prices.slice(-period);
  return parseFloat((slice.reduce(function(a, b) { return a + b; }, 0) / period).toFixed(2));
}

function analyzeSignal(closes) {
  const rsi = calcRSI(closes);
  const ma7 = calcMA(closes, 7);
  const ma25 = calcMA(closes, 25);
  const ma99 = calcMA(closes, 99);
  const trend = ma7 > ma25 ? 'HAUSSIERE' : 'BAISSIERE';
  let signal = null;
  if (rsi < 30 && ma7 > ma25) {
    signal = {
      action: 'ACHETER',
      confidence: Math.min(95, Math.round(75 + (30 - rsi))),
      reason: 'RSI survendu (' + rsi + ') tendance ' + trend,
      rsi: rsi, ma7: ma7, ma25: ma25, trend: trend
    };
  } else if (rsi > 70 && ma7 < ma25) {
    signal = {
      action: 'VENDRE',
      confidence: Math.min(95, Math.round(75 + (rsi - 70))),
      reason: 'RSI surachete (' + rsi + ') tendance ' + trend,
      rsi: rsi, ma7: ma7, ma25: ma25, trend: trend
    };
  }
  return { signal: signal, rsi: rsi, ma7: ma7, ma25: ma25, ma99: ma99, trend: trend };
}

app.get('/api/price/:symbol', function(req, res) {
  binanceRequest('GET', 'ticker/price', { symbol: req.params.symbol.toUpperCase() })
    .then(function(data) {
      const price = parseFloat(data.price);
      if (!price || isNaN(price)) return res.status(500).json({ error: 'Prix invalide' });
      res.json({ price: price });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/analyze/:symbol', function(req, res) {
  const interval = req.query.interval || '1h';
  binanceRequest('GET', 'klines', { symbol: req.params.symbol.toUpperCase(), interval: interval, limit: 150 })
    .then(function(data) {
      const closes = data.map(function(k) { return parseFloat(k[4]); });
      const result = analyzeSignal(closes);
      if (result.signal) {
        const price = closes[closes.length - 1].toFixed(2);
        const msg = 'SIGNAL: ' + result.signal.action +
          '\nPaire: ' + req.params.symbol.toUpperCase() +
          '\nPrix: $' + price +
          '\nRSI: ' + result.signal.rsi +
          '\nConfiance: ' + result.signal.confidence + '%' +
          '\n' + result.signal.reason +
          '\nOuvrez votre bot pour confirmer!';
        sendTelegram(msg);
      }
      res.json(result);
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/balance', function(req, res) {
  binanceRequest('GET', 'account', {}, true)
    .then(function(data) {
      const balances = data.balances
        .filter(function(b) { return parseFloat(b.free) > 0 || parseFloat(b.locked) > 0; })
        .map(function(b) { return { asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }; });
      res.json({ balances: balances });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.post('/api/order', function(req, res) {
  const symbol = req.body.symbol;
  const side = req.body.side;
  const quantity = req.body.quantity;
  binanceRequest('POST', 'order', {
    symbol: symbol.toUpperCase(),
    side: side.toUpperCase(),
    type: 'MARKET',
    quantity: parseFloat(quantity).toFixed(6)
  }, true)
    .then(function(order) {
      sendTelegram('ORDRE EXECUTE: ' + side + '\nPaire: ' + symbol + '\nQuantite: ' + quantity);
      res.json({ success: true, order: order });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
 {app.listen(PORT, () => { console.log('Bot demarre sur le port ' + PORT); https.get('https://api.telegram.org/bot' + TELEGRAM_TOKEN + '/sendMessage?chat_id=' + TELEGRAM_CHAT_ID + '&text=Bot%20demarre!', function(){}); });
  
  console.log('Bot demarre sur le port ' + PORT);
  sendTelegram('Bot Crypto demarre! Surveillance du marche en cours. Vous recevrez une alerte quand un signal sera detecte.');
});
