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

// ─── Journal ─────────────────────────────────────────────
const JOURNAL_FILE = path.join(__dirname, 'journal.json');
function loadJournal() {
  try { return JSON.parse(fs.readFileSync(JOURNAL_FILE, 'utf8')); }
  catch(e) { return []; }
}
function saveJournal(journal) {
  try { fs.writeFileSync(JOURNAL_FILE, JSON.stringify(journal, null, 2)); } catch(e) {}
}

// ─── Etat du bot ─────────────────────────────────────────
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
      hostname: signed ? 'api.binance.com' : 'data-api.binance.vision',
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

// ─── Indicateurs ─────────────────────────────────────────
function calcEMA(prices, period) {
  if (prices.length < period) return prices[prices.length - 1];
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce(function(a, b) { return a + b; }, 0) / period;
  for (let i = period; i < prices.length; i++) ema = prices[i] * k + ema * (1 - k);
  return parseFloat(ema.toFixed(2));
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
  const macdLine = parseFloat((ema12 - ema26).toFixed(2));
  const signal = parseFloat((macdLine * 0.9).toFixed(2));
  return { macdLine, signal, histogram: parseFloat((macdLine - signal).toFixed(2)) };
}

function calcBollinger(prices, period) {
  if (!period) period = 20;
  if (prices.length < period) return { upper: 0, middle: 0, lower: 0 };
  const slice = prices.slice(-period);
  const middle = slice.reduce(function(a, b) { return a + b; }, 0) / period;
  const std = Math.sqrt(slice.reduce(function(s, p) { return s + Math.pow(p - middle, 2); }, 0) / period);
  return { upper: parseFloat((middle + 2*std).toFixed(2)), middle: parseFloat(middle.toFixed(2)), lower: parseFloat((middle - 2*std).toFixed(2)) };
}

function calcATR(highs, lows, closes, period) {
  if (!period) period = 14;
  if (closes.length < 2) return 0;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(highs[i]-lows[i], Math.abs(highs[i]-closes[i-1]), Math.abs(lows[i]-closes[i-1])));
  }
  const slice = trs.slice(-period);
  return parseFloat((slice.reduce(function(a,b){return a+b;},0)/slice.length).toFixed(2));
}

function calcVWAP(highs, lows, closes, volumes) {
  let tp = 0, vol = 0;
  for (let i = 0; i < closes.length; i++) { tp += ((highs[i]+lows[i]+closes[i])/3)*volumes[i]; vol += volumes[i]; }
  return parseFloat((tp/vol).toFixed(2));
}

function findSR(prices) {
  const recent = prices.slice(-20);
  return { support: parseFloat(Math.min.apply(null,recent).toFixed(2)), resistance: parseFloat(Math.max.apply(null,recent).toFixed(2)) };
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
  const opens   = klines.map(function(k){return parseFloat(k[1]);});
  const highs   = klines.map(function(k){return parseFloat(k[2]);});
  const lows    = klines.map(function(k){return parseFloat(k[3]);});
  const closes  = klines.map(function(k){return parseFloat(k[4]);});
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
  const sl=parseFloat((price-slDist).toFixed(2));
  const tp=parseFloat((price+slDist*3).toFixed(2));
  const rr=3;

  let signal=null;
  if(!highVolatility&&!flatMarket&&bull>=10&&bullPct>=65) {
    signal={action:'ACHETER',confidence:Math.min(95,Math.round(bullPct)),reasons,stopLoss:sl,takeProfit:tp,positionSize:posSize,riskReward:rr,riskAmount:parseFloat(riskAmt.toFixed(2))};
  } else if(!highVolatility&&!flatMarket&&bear>=10&&bullPct<=35) {
    signal={action:'VENDRE',confidence:Math.min(95,Math.round(100-bullPct)),reasons:['Tendance baissiere confirmee'],stopLoss:parseFloat((price+slDist).toFixed(2)),takeProfit:parseFloat((price-slDist*3).toFixed(2)),positionSize:posSize,riskReward:rr,riskAmount:parseFloat(riskAmt.toFixed(2))};
  }

  return {
    signal, price,
    indicators:{ema20,ema50,ema100,ema200,rsi,macd,bb,atr,vwap},
    analysis:{support:sr.support,resistance:sr.resistance,fibonacci:fib,orderBlock:ob,fvg,bullishScore:bull,bearishScore:bear,bullishPct:parseFloat(bullPct.toFixed(1)),highVolatility,flatMarket,volatility:parseFloat(volatility.toFixed(2))},
    trend:ema20>ema50&&ema50>ema200?'HAUSSIERE':ema20<ema50&&ema50<ema200?'BAISSIERE':'NEUTRE'
  };
}

// ─── Execution automatique ────────────────────────────────
async function autoExecute(signal, symbol) {
  if (!botState.autoMode) return false;
  if (botState.consecutiveLosses >= botState.maxConsecutiveLosses) {
    console.log('Bot arrete: 3 pertes consecutives');
    botState.autoMode = false;
    return false;
  }
  const now = Date.now();
  if (now - botState.lastSignalTime < 60000) return false;
  botState.lastSignalTime = now;

  try {
    const side = signal.action === 'ACHETER' ? 'BUY' : 'SELL';
    const order = await binanceRequest('POST', 'order', {
      symbol: symbol.toUpperCase(),
      side: side,
      type: 'MARKET',
      quantity: signal.positionSize.toFixed(6)
    }, true);

    if (side === 'BUY') {
      botState.inPosition = true;
      botState.entryPrice = signal.price || 0;
      botState.quantity = signal.positionSize;
      botState.stopLoss = signal.stopLoss;
      botState.takeProfit = signal.takeProfit;
      botState.symbol = symbol;
    } else {
      const pnl = (signal.price - botState.entryPrice) * botState.quantity;
      if (pnl < 0) botState.consecutiveLosses++;
      else botState.consecutiveLosses = 0;
      botState.inPosition = false;
    }

    const journal = loadJournal();
    journal.push({
      id: Date.now(), date: new Date().toISOString(),
      symbol, side: signal.action, price: signal.price || 0,
      quantity: signal.positionSize, stopLoss: signal.stopLoss,
      takeProfit: signal.takeProfit, mode: 'AUTO',
      orderId: order.orderId
    });
    saveJournal(journal);
    return true;
  } catch(e) {
    console.log('Erreur auto execute: ' + e.message);
    return false;
  }
}

// ─── Routes ──────────────────────────────────────────────
app.get('/api/price/:symbol', function(req, res) {
  binanceRequest('GET', 'ticker/price', { symbol: req.params.symbol.toUpperCase() })
    .then(function(data) {
      const price = parseFloat(data.price);
      if (!price || isNaN(price)) return res.status(500).json({ error: 'Prix invalide' });

      // Verification SL/TP en mode auto
      if (botState.autoMode && botState.inPosition) {
        if (price <= botState.stopLoss) {
          binanceRequest('POST', 'order', { symbol: botState.symbol, side: 'SELL', type: 'MARKET', quantity: botState.quantity.toFixed(6) }, true)
            .then(function() {
              botState.consecutiveLosses++;
              botState.inPosition = false;
              console.log('STOP LOSS declenche automatiquement a ' + price);
            }).catch(function(){});
        } else if (price >= botState.takeProfit) {
          binanceRequest('POST', 'order', { symbol: botState.symbol, side: 'SELL', type: 'MARKET', quantity: botState.quantity.toFixed(6) }, true)
            .then(function() {
              botState.consecutiveLosses = 0;
              botState.inPosition = false;
              console.log('TAKE PROFIT atteint automatiquement a ' + price);
            }).catch(function(){});
        }
      }
      res.json({ price });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/analyze/:symbol', function(req, res) {
  const interval = req.query.interval || '1h';
  const capital = parseFloat(req.query.capital) || 100;
  binanceRequest('GET', 'klines', { symbol: req.params.symbol.toUpperCase(), interval, limit: 300 })
    .then(async function(data) {
      const result = fullAnalysis(data, capital);

      // Mode automatique
      if (result.signal && botState.autoMode && !botState.inPosition) {
        const executed = await autoExecute(result.signal, req.params.symbol);
        result.autoExecuted = executed;
      }

      // Verification pertes consecutives
      if (botState.consecutiveLosses >= botState.maxConsecutiveLosses) {
        result.autoStopped = true;
        botState.autoMode = false;
      }

      result.botState = {
        autoMode: botState.autoMode,
        consecutiveLosses: botState.consecutiveLosses,
        inPosition: botState.inPosition
      };
      res.json(result);
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/multiframe/:symbol', function(req, res) {
  const symbol = req.params.symbol.toUpperCase();
  const capital = parseFloat(req.query.capital) || 100;
  const timeframes = ['5m','15m','1h','4h','1d'];
  Promise.all(timeframes.map(function(tf) {
    return binanceRequest('GET', 'klines', { symbol, interval: tf, limit: 200 })
      .then(function(data) { return { tf, result: fullAnalysis(data, capital) }; })
      .catch(function() { return { tf, result: null }; });
  })).then(function(results) {
    const summary = {};
    let tb=0, tr=0, count=0;
    results.forEach(function(r) {
      if (r.result) {
        summary[r.tf] = { trend: r.result.trend, signal: r.result.signal ? r.result.signal.action : 'NEUTRE', bullishPct: r.result.analysis.bullishPct, rsi: r.result.indicators.rsi };
        tb += r.result.analysis.bullishScore;
        tr += r.result.analysis.bearishScore;
        count++;
      }
    });
    const pct = count>0?(tb/(tb+tr))*100:50;
    res.json({ timeframes: summary, overall: { bullishPct: parseFloat(pct.toFixed(1)), consensus: pct>65?'HAUSSIER':pct<35?'BAISSIER':'NEUTRE' } });
  });
});

app.get('/api/balance', function(req, res) {
  binanceRequest('GET', 'account', {}, true)
    .then(function(data) {
      if (!data.balances) return res.status(500).json({ error: 'Reponse Binance invalide: ' + JSON.stringify(data) });
const balances = data.balances
  .filter(function(b){return parseFloat(b.free)>0||parseFloat(b.locked)>0;})
  .map(function(b){return{asset:b.asset,free:parseFloat(b.free),locked:parseFloat(b.locked)};});
res.json({ balances });
      res.json({ balances });
    })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.post('/api/order', function(req, res) {
  const { symbol, side, quantity } = req.body;
  binanceRequest('POST', 'order', { symbol: symbol.toUpperCase(), side: side.toUpperCase(), type: 'MARKET', quantity: parseFloat(quantity).toFixed(6) }, true)
    .then(function(order) { res.json({ success: true, order }); })
    .catch(function(e) { res.status(500).json({ error: e.message }); });
});

app.get('/api/automode', function(req, res) {
  res.json({ autoMode: botState.autoMode, consecutiveLosses: botState.consecutiveLosses, inPosition: botState.inPosition });
});

app.post('/api/automode', function(req, res) {
  botState.autoMode = req.body.enabled;
  if (botState.autoMode) botState.consecutiveLosses = 0;
  console.log('Mode auto: ' + (botState.autoMode ? 'ACTIVE' : 'DESACTIVE'));
  res.json({ autoMode: botState.autoMode });
});

app.get('/api/journal', function(req, res) {
  const journal = loadJournal();
  const closed = journal.filter(function(t){return t.pnl!==undefined;});
  const wins = closed.filter(function(t){return t.pnl>0;}).length;
  const gp = closed.filter(function(t){return t.pnl>0;}).reduce(function(s,t){return s+t.pnl;},0);
  const gl = Math.abs(closed.filter(function(t){return t.pnl<0;}).reduce(function(s,t){return s+t.pnl;},0));
  res.json({
    journal,
    stats: {
      totalTrades: journal.length,
      winRate: closed.length>0?parseFloat((wins/closed.length*100).toFixed(1)):0,
      profitFactor: gl>0?parseFloat((gp/gl).toFixed(2)):0,
      totalPnl: parseFloat(journal.reduce(function(s,t){return s+(t.pnl||0);},0).toFixed(2))
    }
  });
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
