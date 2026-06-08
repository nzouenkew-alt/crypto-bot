const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');
const path = require('path');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

// ─── Journal de trading ──────────────────────────────────
const JOURNAL_FILE = path.join(__dirname, 'journal.json');
function loadJournal() {
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')); }
  catch(e) { return []; }
}
function saveJournal(journal) {
  try { fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2)); } catch(e) {}
}

// ─── Binance Request ─────────────────────────────────────
function binanceRequest(method, endpoint, params, signed) {
  if (!params) params = {};
  if (!signed) signed = false;
  return new Promise(function(resolve, reject) {
    let query = Object.entries(params).map(function(e) { return e[0] + '=' + e[1]; }).join('&');
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

// ─── Indicateurs Techniques ──────────────────────────────

function calcEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return parseFloat(ema.toFixed(2));
}

function calcRSI(prices, period) {
  if (!period) period = 14;
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff;
    else losses += Math.abs(diff);
  }
  const rs = gains / (losses || 0.0001);
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

function calcMACD(prices) {
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macdLine = parseFloat((ema12 - ema26).toFixed(2));
  const signal = parseFloat((macdLine * 0.9).toFixed(2));
  const histogram = parseFloat((macdLine - signal).toFixed(2));
  return { macdLine, signal, histogram };
}

function calcBollinger(prices, period) {
  if (!period) period = 20;
  if (prices.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = prices.slice(-period);
  const middle = slice.reduce(function(a, b) { return a + b; }, 0) / period;
  const variance = slice.reduce(function(sum, p) { return sum + Math.pow(p - middle, 2); }, 0) / period;
  const std = Math.sqrt(variance);
  return {
    upper: parseFloat((middle + 2 * std).toFixed(2)),
    middle: parseFloat(middle.toFixed(2)),
    lower: parseFloat((middle - 2 * std).toFixed(2))
  };
}

function calcATR(highs, lows, closes, period) {
  if (!period) period = 14;
  if (closes.length < 2) return 0;
  const trueRanges = [];
  for (let i = 1; i < closes.length; i++) {
    const tr = Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    );
    trueRanges.push(tr);
  }
  const slice = trueRanges.slice(-period);
  return parseFloat((slice.reduce(function(a, b) { return a + b; }, 0) / slice.length).toFixed(2));
}

function calcVWAP(highs, lows, closes, volumes) {
  let totalVolume = 0, totalTP = 0;
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3;
    totalTP += tp * volumes[i];
    totalVolume += volumes[i];
  }
  return parseFloat((totalTP / totalVolume).toFixed(2));
}

function findSupportResistance(prices, lookback) {
  if (!lookback) lookback = 20;
  const recent = prices.slice(-lookback);
  const support = parseFloat(Math.min.apply(null, recent).toFixed(2));
  const resistance = parseFloat(Math.max.apply(null, recent).toFixed(2));
  return { support, resistance };
}

function calcFibonacci(high, low) {
  const diff = high - low;
  return {
    level0: parseFloat(high.toFixed(2)),
    level236: parseFloat((high - diff * 0.236).toFixed(2)),
    level382: parseFloat((high - diff * 0.382).toFixed(2)),
    level500: parseFloat((high - diff * 0.500).toFixed(2)),
    level618: parseFloat((high - diff * 0.618).toFixed(2)),
    level100: parseFloat(low.toFixed(2))
  };
}

function detectOrderBlock(opens, highs, lows, closes) {
  const len = closes.length;
  if (len < 5) return null;
  for (let i = len - 3; i >= len - 10 && i >= 0; i--) {
    const isBullishOB = closes[i] < opens[i] &&
      closes[i + 1] > opens[i + 1] &&
      closes[i + 2] > opens[i + 2];
    if (isBullishOB) {
      return { type: 'BULLISH', high: highs[i], low: lows[i], index: i };
    }
    const isBearishOB = closes[i] > opens[i] &&
      closes[i + 1] < opens[i + 1] &&
      closes[i + 2] < opens[i + 2];
    if (isBearishOB) {
      return { type: 'BEARISH', high: highs[i], low: lows[i], index: i };
    }
  }
  return null;
}

function detectFVG(highs, lows) {
  const len = highs.length;
  if (len < 3) return null;
  for (let i = len - 3; i >= len - 10 && i >= 0; i--) {
    if (lows[i + 2] > highs[i]) {
      return { type: 'BULLISH', high: lows[i + 2], low: highs[i] };
    }
    if (highs[i + 2] < lows[i]) {
      return { type: 'BEARISH', high: lows[i], low: highs[i + 2] };
    }
  }
  return null;
}

function detectBreakout(closes, resistance, support) {
  const current = closes[closes.length - 1];
  const prev = closes[closes.length - 2];
  if (current > resistance && prev <= resistance) return 'BULLISH_BREAKOUT';
  if (current < support && prev >= support) return 'BEARISH_BREAKOUT';
  return null;
}

function detectPullback(closes, ema20) {
  const current = closes[closes.length - 1];
  const prev = closes[closes.length - 3];
  if (prev > ema20 && current <= ema20 * 1.005 && current >= ema20 * 0.995) return 'PULLBACK_TO_EMA';
  return null;
}

function calcWinRate(journal) {
  if (!journal || journal.length === 0) return 0;
  const closed = journal.filter(function(t) { return t.pnl !== undefined; });
  if (closed.length === 0) return 0;
  const wins = closed.filter(function(t) { return t.pnl > 0; }).length;
  return parseFloat((wins / closed.length * 100).toFixed(1));
}

function calcProfitFactor(journal) {
  if (!journal || journal.length === 0) return 0;
  const closed = journal.filter(function(t) { return t.pnl !== undefined; });
  const grossProfit = closed.filter(function(t) { return t.pnl > 0; }).reduce(function(s, t) { return s + t.pnl; }, 0);
  const grossLoss = Math.abs(closed.filter(function(t) { return t.pnl < 0; }).reduce(function(s, t) { return s + t.pnl; }, 0));
  return grossLoss === 0 ? grossProfit : parseFloat((grossProfit / grossLoss).toFixed(2));
}

// ─── Analyse complète multi-indicateurs ──────────────────
function fullAnalysis(klines, capital) {
  const opens   = klines.map(function(k) { return parseFloat(k[1]); });
  const highs   = klines.map(function(k) { return parseFloat(k[2]); });
  const lows    = klines.map(function(k) { return parseFloat(k[3]); });
  const closes  = klines.map(function(k) { return parseFloat(k[4]); });
  const volumes = klines.map(function(k) { return parseFloat(k[5]); });

  const price = closes[closes.length - 1];

  const ema20  = calcEMA(closes, 20);
  const ema50  = calcEMA(closes, 50);
  const ema100 = calcEMA(closes, 100);
  const ema200 = calcEMA(closes, 200);
  const rsi    = calcRSI(closes);
  const macd   = calcMACD(closes);
  const bb     = calcBollinger(closes);
  const atr    = calcATR(highs, lows, closes);
  const vwap   = calcVWAP(highs, lows, closes, volumes);
  const sr     = findSupportResistance(closes);
  const fib    = calcFibonacci(Math.max.apply(null, highs.slice(-50)), Math.min.apply(null, lows.slice(-50)));
  const ob     = detectOrderBlock(opens, highs, lows, closes);
  const fvg    = detectFVG(highs, lows);
  const breakout = detectBreakout(closes, sr.resistance, sr.support);
  const pullback = detectPullback(closes, ema20);

  // Score de confirmation
  let bullishScore = 0;
  let bearishScore = 0;
  const reasons = [];

  // EMA trend
  if (price > ema200) { bullishScore += 2; reasons.push('Prix au-dessus EMA200'); }
  else { bearishScore += 2; }
  if (ema20 > ema50) { bullishScore += 1; reasons.push('EMA20 > EMA50'); }
  else { bearishScore += 1; }
  if (ema50 > ema100) { bullishScore += 1; }
  if (ema100 > ema200) { bullishScore += 1; }

  // RSI
  if (rsi < 45) { bullishScore += 2; reasons.push('RSI survendu (' + rsi + ')'); }
  else if (rsi > 60) { bearishScore += 2; }
  if (rsi > 80) { bearishScore += 2; }
  if (rsi < 25) { bullishScore += 2; }

  // MACD
  if (macd.histogram > 0) { bullishScore += 2; reasons.push('MACD haussier'); }
  else { bearishScore += 2; }

  // Bollinger
  if (price < bb.lower) { bullishScore += 2; reasons.push('Prix sous bande Bollinger basse'); }
  else if (price > bb.upper) { bearishScore += 2; }

  // VWAP
  if (price > vwap) { bullishScore += 1; reasons.push('Prix au-dessus VWAP'); }
  else { bearishScore += 1; }

  // Support/Resistance
  const distanceToSupport = ((price - sr.support) / price) * 100;
  if (distanceToSupport < 2) { bullishScore += 2; reasons.push('Prix proche du support'); }
  const distanceToResistance = ((sr.resistance - price) / price) * 100;
  if (distanceToResistance < 2) { bearishScore += 2; }

  // Order Block
  if (ob && ob.type === 'BULLISH' && price >= ob.low && price <= ob.high) {
    bullishScore += 3; reasons.push('Dans un Order Block haussier (SMC)');
  }
  if (ob && ob.type === 'BEARISH' && price >= ob.low && price <= ob.high) {
    bearishScore += 3;
  }

  // FVG
  if (fvg && fvg.type === 'BULLISH') { bullishScore += 2; reasons.push('Fair Value Gap haussier detecte'); }
  if (fvg && fvg.type === 'BEARISH') { bearishScore += 2; }

  // Breakout
  if (breakout === 'BULLISH_BREAKOUT') { bullishScore += 3; reasons.push('Breakout haussier confirme'); }
  if (breakout === 'BEARISH_BREAKOUT') { bearishScore += 3; }

  // Pullback
  if (pullback === 'PULLBACK_TO_EMA') { bullishScore += 2; reasons.push('Pullback sur EMA20 - point entree ideal'); }

  // Volatilite excessive (filtre)
  const volatility = (atr / price) * 100;
  const highVolatility = volatility > 3;

  // Marche plat (filtre)
  const flatMarket = Math.abs(ema20 - ema50) / price * 100 < 0.1;

  // Signal final
  let signal = null;
  const totalScore = bullishScore + bearishScore;
  const bullishPct = totalScore > 0 ? (bullishScore / totalScore) * 100 : 50;

  const CAPITAL = capital || 100;
  const RISK_PCT = 0.01; // 1% du capital
  const riskAmount = CAPITAL * RISK_PCT;
  const stopLossDistance = atr * 1.5;
  const positionSize = parseFloat((riskAmount / stopLossDistance).toFixed(6));
  const stopLoss = parseFloat((price - stopLossDistance).toFixed(2));
  const takeProfit1 = parseFloat((price + stopLossDistance * 2).toFixed(2)); // 1:2
  const takeProfit2 = parseFloat((price + stopLossDistance * 3).toFixed(2)); // 1:3
  const riskReward = parseFloat((stopLossDistance * 3 / stopLossDistance).toFixed(1));

  if (!highVolatility && !flatMarket && bullishScore >= 10 && bullishPct >= 65) {
    signal = {
      action: 'ACHETER',
      confidence: Math.min(95, Math.round(bullishPct)),
      reasons: reasons,
      stopLoss: stopLoss,
      takeProfit1: takeProfit1,
      takeProfit2: takeProfit2,
      positionSize: positionSize,
      riskReward: riskReward,
      riskAmount: parseFloat(riskAmount.toFixed(2))
    };
  } else if (!highVolatility && !flatMarket && bearishScore >= 10 && bullishPct <= 35) {
    signal = {
      action: 'VENDRE',
      confidence: Math.min(95, Math.round(100 - bullishPct)),
      reasons: ['Tendance baissiere confirmee par plusieurs indicateurs'],
      stopLoss: parseFloat((price + stopLossDistance).toFixed(2)),
      takeProfit1: parseFloat((price - stopLossDistance * 2).toFixed(2)),
      takeProfit2: parseFloat((price - stopLossDistance * 3).toFixed(2)),
      positionSize: positionSize,
      riskReward: riskReward,
      riskAmount: parseFloat(riskAmount.toFixed(2))
    };
  }

  return {
    signal,
    price,
    indicators: {
      ema20, ema50, ema100, ema200,
      rsi, macd, bb, atr, vwap
    },
    analysis: {
      support: sr.support,
      resistance: sr.resistance,
      fibonacci: fib,
      orderBlock: ob,
      fvg, breakout, pullback,
      bullishScore, bearishScore,
      bullishPct: parseFloat(bullishPct.toFixed(1)),
      highVolatility, flatMarket,
      volatility: parseFloat(volatility.toFixed(2))
    },
    trend: ema20 > ema50 && ema50 > ema200 ? 'HAUSSIERE' : ema20 < ema50 && ema50 < ema200 ? 'BAISSIERE' : 'NEUTRE'
  };
}

// ─── Routes API ──────────────────────────────────────────

app.get('/api/price/:symbol', function(req, res) {
  binanceRequest('GET', 'ticker/price', { symbol: req.params.symbol.toUpperCase() })
    .then(function(data) {
      const price = parseFloat(data.price);
      if (!price || isNaN(price)) return res.status(500).json({ error: 'Prix invalide' });
      res.json({ price });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/analyze/:symbol', function(req, res) {
  const interval = req.query.interval || '1h';
  const capital = parseFloat(req.query.capital) || 100;
  binanceRequest('GET', 'klines', {
    symbol: req.params.symbol.toUpperCase(),
    interval: interval,
    limit: 300
  })
    .then(function(data) {
      const result = fullAnalysis(data, capital);
      res.json(result);
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/multiframe/:symbol', function(req, res) {
  const symbol = req.params.symbol.toUpperCase();
  const capital = parseFloat(req.query.capital) || 100;
  const timeframes = ['5m', '15m', '1h', '4h', '1d'];

  Promise.all(timeframes.map(function(tf) {
    return binanceRequest('GET', 'klines', { symbol, interval: tf, limit: 200 })
      .then(function(data) { return { tf, result: fullAnalysis(data, capital) }; })
      .catch(function() { return { tf, result: null }; });
  }))
    .then(function(results) {
      const summary = {};
      let totalBull = 0, totalBear = 0, count = 0;
      results.forEach(function(r) {
        if (r.result) {
          summary[r.tf] = {
            trend: r.result.trend,
            signal: r.result.signal ? r.result.signal.action : 'NEUTRE',
            bullishPct: r.result.analysis.bullishPct,
            rsi: r.result.indicators.rsi
          };
          totalBull += r.result.analysis.bullishScore;
          totalBear += r.result.analysis.bearishScore;
          count++;
        }
      });
      const overallBullPct = count > 0 ? (totalBull / (totalBull + totalBear)) * 100 : 50;
      res.json({
        timeframes: summary,
        overall: {
          bullishPct: parseFloat(overallBullPct.toFixed(1)),
          consensus: overallBullPct > 65 ? 'HAUSSIER' : overallBullPct < 35 ? 'BAISSIER' : 'NEUTRE'
        }
      });
    });
});

app.get('/api/balance', function(req, res) {
  binanceRequest('GET', 'account', {}, true)
    .then(function(data) {
      const balances = data.balances
        .filter(function(b) { return parseFloat(b.free) > 0 || parseFloat(b.locked) > 0; })
        .map(function(b) { return { asset: b.asset, free: parseFloat(b.free), locked: parseFloat(b.locked) }; });
      res.json({ balances });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.post('/api/order', function(req, res) {
  const { symbol, side, quantity } = req.body;
  binanceRequest('POST', 'order', {
    symbol: symbol.toUpperCase(),
    side: side.toUpperCase(),
    type: 'MARKET',
    quantity: parseFloat(quantity).toFixed(6)
  }, true)
    .then(function(order) {
      res.json({ success: true, order });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/journal', function(req, res) {
  const journal = loadJournal();
  const stats = {
    totalTrades: journal.length,
    winRate: calcWinRate(journal),
    profitFactor: calcProfitFactor(journal),
    totalPnl: parseFloat(journal.reduce(function(s, t) { return s + (t.pnl || 0); }, 0).toFixed(2))
  };
  res.json({ journal, stats });
});

app.post('/api/journal', function(req, res) {
  const journal = loadJournal();
  const trade = Object.assign({ id: Date.now(), date: new Date().toISOString() }, req.body);
  journal.push(trade);
  saveJournal(journal);
  res.json({ success: true, trade });
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, function() {
  console.log('Bot Pro demarre sur le port ' + PORT);
});
