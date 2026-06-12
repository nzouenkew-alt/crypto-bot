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

const KC_KEY = process.env.KUCOIN_API_KEY || '';
const KC_SECRET = process.env.KUCOIN_API_SECRET || '';
const KC_PASS = process.env.KUCOIN_PASSPHRASE || '';

// ─── Journal ─────────────────────────────────────────────
const JOURNAL_FILE = path.join(__dirname, 'journal.json');
function loadJournal() {
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')); }
  catch(e) { return []; }
}
function saveJournal(j) {
  try { fs.writeFileSync(JOURNAL_FILE, JSON.stringify(j, null, 2)); } catch(e) {}
}

// ─── Bot State ────────────────────────────────────────────
let botState = {
  autoMode: false,
  consecutiveLosses: 0,
  maxConsecutiveLosses: 3,
  inPosition: false,
  entryPrice: 0,
  quantity: 0,
  stopLoss: 0,
  takeProfit: 0,
  symbol: '',
  lastSignalTime: 0
};

// ─── KuCoin Request ───────────────────────────────────────
function kuCoinRequest(method, endpoint, body, signed) {
  return new Promise(function(resolve, reject) {
    const timestamp = Date.now().toString();
    const bodyStr = body ? JSON.stringify(body) : '';
    let headers = { 'Content-Type': 'application/json' };

    if (signed) {
      const strToSign = timestamp + method.toUpperCase() + endpoint + bodyStr;
      const signature = crypto.createHmac('sha256', KC_SECRET).update(strToSign).digest('base64');
      const passphrase = crypto.createHmac('sha256', KC_SECRET).update(KC_PASS).digest('base64');
      headers['KC-API-KEY'] = KC_KEY;
      headers['KC-API-SIGN'] = signature;
      headers['KC-API-TIMESTAMP'] = timestamp;
      headers['KC-API-PASSPHRASE'] = passphrase;
      headers['KC-API-KEY-VERSION'] = '2';
    }

    const options = {
      hostname: 'api.kucoin.com',
      path: endpoint,
      method: method,
      headers: headers
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
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// ─── Prix KuCoin ─────────────────────────────────────────
function getPrice(symbol) {
  return kuCoinRequest('GET', '/api/v1/market/orderbook/level1?symbol=' + symbol, null, false)
    .then(function(data) {
      if (data.data && data.data.price) return parseFloat(data.data.price);
      throw new Error('Prix invalide');
    });
}

// ─── Chandeliers KuCoin ───────────────────────────────────
function getKlines(symbol, interval, limit) {
  const intervalMap = { '5m': '5min', '15m': '15min', '1h': '1hour', '4h': '4hour', '1d': '1day' };
  const kcInterval = intervalMap[interval] || '1hour';
  return kuCoinRequest('GET', '/api/v1/market/candles?type=' + kcInterval + '&symbol=' + symbol, null, false)
    .then(function(data) {
      if (!data.data || data.data.length === 0) throw new Error('Pas de donnees: ' + JSON.stringify(data));
      return data.data.reverse();
    });
}

// ─── Indicateurs ─────────────────────────────────────────
function calcEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(4));
}

function calcRSI(prices, period) {
  if (!period) period = 14;
  if (prices.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = prices.length - period; i < prices.length; i++) {
    const diff = prices[i] - prices[i - 1];
    if (diff > 0) gains += diff; else losses += Math.abs(diff);
  }
  const rs = gains / (losses || 0.0001);
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2));
}

function calcMACD(prices) {
  const ema12 = calcEMA(prices, 12);
  const ema26 = calcEMA(prices, 26);
  const macdLine = parseFloat((ema12 - ema26).toFixed(4));
  const signal = parseFloat((macdLine * 0.9).toFixed(4));
  return { macdLine, signal, histogram: parseFloat((macdLine - signal).toFixed(4)) };
}

function calcBollinger(prices, period) {
  if (!period) period = 20;
  if (prices.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = prices.slice(-period);
  const middle = slice.reduce(function(a, b) { return a + b; }, 0) / period;
  const std = Math.sqrt(slice.reduce(function(s, p) { return s + Math.pow(p - middle, 2); }, 0) / period);
  return { upper: parseFloat((middle + 2*std).toFixed(4)), middle: parseFloat(middle.toFixed(4)), lower: parseFloat((middle - 2*std).toFixed(4)) };
}

function calcATR(highs, lows, closes, period) {
  if (!period) period = 14;
  if (closes.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  const slice = trs.slice(-period);
  return parseFloat((slice.reduce(function(a,b){return a+b;},0)/slice.length).toFixed(4));
}

function calcVWAP(highs, lows, closes, volumes) {
  let tp = 0, vol = 0;
  for (let i = 0; i < closes.length; i++) { tp += ((highs[i]+lows[i]+closes[i])/3)*volumes[i]; vol += volumes[i]; }
  return parseFloat((tp/vol).toFixed(4));
}

function findSR(prices) {
  const recent = prices.slice(-20);
  return { support: parseFloat(Math.min.apply(null,recent).toFixed(4)), resistance: parseFloat(Math.max.apply(null,recent).toFixed(4)) };
}

function calcFib(high, low) {
  const d = high - low;
  return { l0: high, l236: parseFloat((high-d*0.236).toFixed(2)), l382: parseFloat((high-d*0.382).toFixed(2)), l500: parseFloat((high-d*0.5).toFixed(2)), l618: parseFloat((high-d*0.618).toFixed(2)), l100: low };
}

function detectOB(opens, highs, lows, closes) {
  const len = closes.length;
  if (len < 5) return null;
  for (let i = len-3; i >= len-10 && i >= 0; i--) {
    if (closes[i]<opens[i] && closes[i+1]>opens[i+1] && closes[i+2]>opens[i+2]) return { type:'BULLISH', high:highs[i], low:lows[i] };
    if (closes[i]>opens[i] && closes[i+1]<opens[i+1] && closes[i+2]<opens[i+2]) return { type:'BEARISH', high:highs[i], low:lows[i] };
  }
  return null;
}

function detectFVG(highs, lows) {
  const len = highs.length;
  if (len < 3) return null;
  for (let i = len-3; i >= len-10 && i >= 0; i--) {
    if (lows[i+2] > highs[i]) return { type:'BULLISH', high:lows[i+2], low:highs[i] };
    if (highs[i+2] < lows[i]) return { type:'BEARISH', high:lows[i], low:highs[i+2] };
  }
  return null;
}

function fullAnalysis(klines, capital) {
  // KuCoin format: [time, open, close, high, low, volume, turnover]
  const opens   = klines.map(function(k){return parseFloat(k[1]);});
  const closes  = klines.map(function(k){return parseFloat(k[2]);});
  const highs   = klines.map(function(k){return parseFloat(k[3]);});
  const lows    = klines.map(function(k){return parseFloat(k[4]);});
  const volumes = klines.map(function(k){return parseFloat(k[5]);});
  const price   = closes[closes.length-1];

  const ema20=calcEMA(closes,20), ema50=calcEMA(closes,50), ema100=calcEMA(closes,100), ema200=calcEMA(closes,200);
  const rsi=calcRSI(closes), macd=calcMACD(closes), bb=calcBollinger(closes);
  const atr=calcATR(highs,lows,closes), vwap=calcVWAP(highs,lows,closes,volumes);
  const sr=findSR(closes), fib=calcFib(Math.max.apply(null,highs.slice(-50)),Math.min.apply(null,lows.slice(-50)));
  const ob=detectOB(opens,highs,lows,closes), fvg=detectFVG(highs,lows);

  let bull=0, bear=0;
  const reasons=[];

  if(price>ema200){bull+=2;reasons.push('Prix au-dessus EMA200');}else bear+=2;
  if(ema20>ema50){bull+=1;reasons.push('EMA20 > EMA50');}else bear+=1;
  if(ema50>ema100)bull+=1;else bear+=1;
  if(ema100>ema200)bull+=1;else bear+=1;
  if(rsi<45){bull+=2;reasons.push('RSI survendu ('+rsi+')');}else if(rsi>60)bear+=2;
  if(rsi>80)bear+=2; if(rsi<25)bull+=2;
  if(macd.histogram>0){bull+=2;reasons.push('MACD haussier');}else bear+=2;
  if(price<bb.lower){bull+=2;reasons.push('Prix sous Bollinger basse');}else if(price>bb.upper)bear+=2;
  if(price>vwap){bull+=1;reasons.push('Prix au-dessus VWAP');}else bear+=1;
  if(((price-sr.support)/price)*100<2){bull+=2;reasons.push('Prix proche du support');}
  if(((sr.resistance-price)/price)*100<2)bear+=2;
  if(ob&&ob.type==='BULLISH'&&price>=ob.low&&price<=ob.high){bull+=3;reasons.push('Order Block haussier (SMC)');}
  if(ob&&ob.type==='BEARISH'&&price>=ob.low&&price<=ob.high)bear+=3;
  if(fvg&&fvg.type==='BULLISH'){bull+=2;reasons.push('Fair Value Gap haussier');}
  if(fvg&&fvg.type==='BEARISH')bear+=2;

  const volatility=(atr/price)*100;
  const flatMarket=Math.abs(ema20-ema50)/price*100<0.1;
  const highVolatility=volatility>3;
  const total=bull+bear;
  const bullPct=total>0?(bull/total)*100:50;

  const CAPITAL=capital||100;
  const riskAmt=CAPITAL*0.01;
  const slDist=atr*1.5;
  const posSize=parseFloat((riskAmt/slDist).toFixed(6));
  const sl=parseFloat((price-slDist).toFixed(4));
  const tp=parseFloat((price+slDist*3).toFixed(4));

  let signal=null;
  if(!highVolatility&&!flatMarket&&bull>=10&&bullPct>=65) {
    signal={action:'ACHETER',confidence:Math.min(95,Math.round(bullPct)),reasons,stopLoss:sl,takeProfit:tp,positionSize:posSize,riskReward:3,riskAmount:parseFloat(riskAmt.toFixed(2))};
  } else if(!highVolatility&&!flatMarket&&bear>=10&&bullPct<=35) {
    signal={action:'VENDRE',confidence:Math.min(95,Math.round(100-bullPct)),reasons:['Tendance baissiere confirmee'],stopLoss:parseFloat((price+slDist).toFixed(4)),takeProfit:parseFloat((price-slDist*3).toFixed(4)),positionSize:posSize,riskReward:3,riskAmount:parseFloat(riskAmt.toFixed(2))};
  }

  return {
    signal, price,
    indicators:{ema20,ema50,ema100,ema200,rsi,macd,bb,atr,vwap},
    analysis:{support:sr.support,resistance:sr.resistance,fibonacci:fib,orderBlock:ob,fvg,bullishScore:bull,bearishScore:bear,bullishPct:parseFloat(bullPct.toFixed(1)),highVolatility,flatMarket,volatility:parseFloat(volatility.toFixed(2))},
    trend:ema20>ema50&&ema50>ema200?'HAUSSIERE':ema20<ema50&&ema50<ema200?'BAISSIERE':'NEUTRE'
  };
}

// ─── Routes ──────────────────────────────────────────────
app.get('/api/price/:symbol', async function(req, res) {
  try {
    const symbol = req.params.symbol.replace('USDT', '-USDT');
    const price = await getPrice(symbol);
    if (botState.autoMode && botState.inPosition) {
      if (price <= botState.stopLoss) {
        kuCoinRequest('POST', '/api/v1/orders', { clientOid: Date.now().toString(), side: 'sell', symbol: botState.symbol, type: 'market', size: botState.quantity.toString() }, true)
          .then(function() { botState.consecutiveLosses++; botState.inPosition = false; console.log('STOP LOSS: ' + price); }).catch(function(){});
      } else if (price >= botState.takeProfit) {
        kuCoinRequest('POST', '/api/v1/orders', { clientOid: Date.now().toString(), side: 'sell', symbol: botState.symbol, type: 'market', size: botState.quantity.toString() }, true)
          .then(function() { botState.consecutiveLosses = 0; botState.inPosition = false; console.log('TAKE PROFIT: ' + price); }).catch(function(){});
      }
    }
    res.json({ price });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/analyze/:symbol', async function(req, res) {
  try {
    const symbol = req.params.symbol.replace('USDT', '-USDT');
    const interval = req.query.interval || '1h';
    const capital = parseFloat(req.query.capital) || 100;
    const klines = await getKlines(symbol, interval, 300);
    const result = fullAnalysis(klines, capital);

    if (result.signal && botState.autoMode && !botState.inPosition) {
      const now = Date.now();
      if (now - botState.lastSignalTime > 60000) {
        botState.lastSignalTime = now;
        const side = result.signal.action === 'ACHETER' ? 'buy' : 'sell';
        kuCoinRequest('POST', '/api/v1/orders', { clientOid: now.toString(), side, symbol, type: 'market', funds: result.signal.riskAmount.toString() }, true)
          .then(function(order) {
            if (order.code === '200000') {
              if (side === 'buy') { botState.inPosition = true; botState.entryPrice = result.price; botState.stopLoss = result.signal.stopLoss; botState.takeProfit = result.signal.takeProfit; botState.symbol = symbol; }
              result.autoExecuted = true;
              const journal = loadJournal();
              journal.push({ id: now, date: new Date().toISOString(), symbol: req.params.symbol, side: result.signal.action, price: result.price, quantity: result.signal.positionSize, stopLoss: result.signal.stopLoss, takeProfit: result.signal.takeProfit, mode: 'AUTO' });
              saveJournal(journal);
            }
          }).catch(function(){});
      }
    }

    if (botState.consecutiveLosses >= botState.maxConsecutiveLosses) { result.autoStopped = true; botState.autoMode = false; }
    result.botState = { autoMode: botState.autoMode, consecutiveLosses: botState.consecutiveLosses, inPosition: botState.inPosition };
    res.json(result);
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/multiframe/:symbol', async function(req, res) {
  try {
    const symbol = req.params.symbol.replace('USDT', '-USDT');
    const capital = parseFloat(req.query.capital) || 100;
    const timeframes = ['5m','15m','1h','4h','1d'];
    const results = await Promise.all(timeframes.map(async function(tf) {
      try {
        const klines = await getKlines(symbol, tf, 200);
        return { tf, result: fullAnalysis(klines, capital) };
      } catch(e) { return { tf, result: null }; }
    }));
    const summary = {};
    let tb=0, tr=0, count=0;
    results.forEach(function(r) {
      if (r.result) {
        summary[r.tf] = { trend: r.result.trend, signal: r.result.signal ? r.result.signal.action : 'NEUTRE', bullishPct: r.result.analysis.bullishPct, rsi: r.result.indicators.rsi };
        tb += r.result.analysis.bullishScore; tr += r.result.analysis.bearishScore; count++;
      }
    });
    const pct = count>0?(tb/(tb+tr))*100:50;
    res.json({ timeframes: summary, overall: { bullishPct: parseFloat(pct.toFixed(1)), consensus: pct>65?'HAUSSIER':pct<35?'BAISSIER':'NEUTRE' } });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/balance', async function(req, res) {
  try {
    const data = await kuCoinRequest('GET', '/api/v1/accounts?type=trade', null, true);
    if (!data.data) return res.status(500).json({ error: 'Erreur KuCoin: ' + JSON.stringify(data) });
    const balances = data.data.filter(function(b) { return parseFloat(b.available) > 0; })
      .map(function(b) { return { asset: b.currency, free: parseFloat(b.available), locked: parseFloat(b.holds) }; });
    res.json({ balances });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/order', async function(req, res) {
  try {
    const { symbol, side, quantity } = req.body;
    const kcSymbol = symbol.replace('USDT', '-USDT');
    const order = await kuCoinRequest('POST', '/api/v1/orders', {
      clientOid: Date.now().toString(),
      side: side === 'BUY' ? 'buy' : 'sell',
      symbol: kcSymbol,
      type: 'market',
      size: quantity.toString()
    }, true);
    if (order.code === '200000') res.json({ success: true, order: { orderId: order.data.orderId } });
    else res.status(500).json({ error: order.msg });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/automode', function(req, res) {
  res.json({ autoMode: botState.autoMode, consecutiveLosses: botState.consecutiveLosses, inPosition: botState.inPosition });
});

app.post('/api/automode', function(req, res) {
  botState.autoMode = req.body.enabled;
  if (botState.autoMode) botState.consecutiveLosses = 0;
  res.json({ autoMode: botState.autoMode });
});

app.get('/api/journal', function(req, res) {
  const journal = loadJournal();
  const closed = journal.filter(function(t){return t.pnl!==undefined;});
  const wins = closed.filter(function(t){return t.pnl>0;}).length;
  const gp = closed.filter(function(t){return t.pnl>0;}).reduce(function(s,t){return s+t.pnl;},0);
  const gl = Math.abs(closed.filter(function(t){return t.pnl<0;}).reduce(function(s,t){return s+t.pnl;},0));
  res.json({ journal, stats: { totalTrades: journal.length, winRate: closed.length>0?parseFloat((wins/closed.length*100).toFixed(1)):0, profitFactor: gl>0?parseFloat((gp/gl).toFixed(2)):0, totalPnl: parseFloat(journal.reduce(function(s,t){return s+(t.pnl||0);},0).toFixed(2)) } });
});

app.post('/api/journal', function(req, res) {
  const journal = loadJournal();
  journal.push(Object.assign({ id: Date.now(), date: new Date().toISOString() }, req.body));
  saveJournal(journal);
  res.json({ success: true });
});

app.get('*', function(req, res) {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, function() { console.log('Bot KuCoin demarre sur le port ' + PORT); });
