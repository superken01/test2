const MAX_POINTS = 100;
const WS_URL = 'wss://stream.binance.com:9443/ws/btcusdt@bookTicker';

const labels = [];
const bidData = [];
const askData = [];

const ctx = document.getElementById('priceChart').getContext('2d');

const chart = new Chart(ctx, {
  type: 'line',
  data: {
    labels,
    datasets: [
      {
        label: 'Best Bid',
        data: bidData,
        borderColor: '#3fb950',
        backgroundColor: 'rgba(63,185,80,0.08)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
        fill: false,
      },
      {
        label: 'Best Ask',
        data: askData,
        borderColor: '#f85149',
        backgroundColor: 'rgba(248,81,73,0.08)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.3,
        fill: false,
      },
    ],
  },
  options: {
    responsive: true,
    animation: false,
    interaction: {
      mode: 'index',
      intersect: false,
    },
    plugins: {
      legend: {
        labels: { color: '#8b949e', font: { size: 13 } },
      },
      tooltip: {
        backgroundColor: '#161b22',
        borderColor: '#30363d',
        borderWidth: 1,
        titleColor: '#8b949e',
        bodyColor: '#e6edf3',
        callbacks: {
          label: (ctx) => ` ${ctx.dataset.label}: ${Number(ctx.parsed.y).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`,
        },
      },
    },
    scales: {
      x: {
        ticks: { color: '#8b949e', maxTicksLimit: 8, maxRotation: 0 },
        grid: { color: '#21262d' },
      },
      y: {
        ticks: {
          color: '#8b949e',
          callback: (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2 }),
        },
        grid: { color: '#21262d' },
      },
    },
  },
});

const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const bidEl = document.getElementById('bid-price');
const askEl = document.getElementById('ask-price');
const spreadEl = document.getElementById('spread');

function setStatus(state) {
  statusDot.className = 'dot ' + state;
  statusText.textContent = state === 'connected' ? '已連線' : state === 'error' ? '連線失敗' : '連線中...';
}

function addPoint(bid, ask) {
  const now = new Date();
  const timeLabel = now.toLocaleTimeString('zh-TW', { hour12: false });

  labels.push(timeLabel);
  bidData.push(bid);
  askData.push(ask);

  if (labels.length > MAX_POINTS) {
    labels.shift();
    bidData.shift();
    askData.shift();
  }

  chart.update('none');
}

function connect() {
  setStatus('');
  const ws = new WebSocket(WS_URL);

  ws.onopen = () => setStatus('connected');

  ws.onmessage = (event) => {
    const data = JSON.parse(event.data);
    const bid = parseFloat(data.b);
    const ask = parseFloat(data.a);
    const spread = (ask - bid).toFixed(2);

    bidEl.textContent = bid.toLocaleString('en-US', { minimumFractionDigits: 2 });
    askEl.textContent = ask.toLocaleString('en-US', { minimumFractionDigits: 2 });
    spreadEl.textContent = spread;

    addPoint(bid, ask);
  };

  ws.onerror = () => setStatus('error');

  ws.onclose = () => {
    setStatus('error');
    setTimeout(connect, 3000);
  };
}

connect();
