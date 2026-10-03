// WiFi Radar – front-end
// Polls /api/networks (served by wifi-analyzer/server.py) and draws:
//   • the network list with signal sparklines
//   • the radar
//   • the channel congestion chart + best-channel suggestion
//   • light / dark theme

const POLL_MS = 2000;
const HISTORY_MAX = 60;     // readings kept per network (~4 minutes)
const HISTORY_GRACE = 8;    // scans a network may be missing before its history is dropped
const SVG_NS = "http://www.w3.org/2000/svg";

const state = {
  networks: [],
  band: "all",
  sort: "signal_percent",
  hover: null,            // bssid currently hovered
  dots: new Map(),        // bssid -> smoothed radar position
  ringMax: 10,            // metres represented by the outer radar ring
  history: new Map(),     // bssid -> { vals: number[], miss: number }
  lastUpdated: null,
  chBand: "2.4 GHz",      // band shown in the channel chart
};

const els = {
  rows: document.getElementById("rows"),
  status: document.getElementById("status"),
  statusText: document.getElementById("statusText"),
  notice: document.getElementById("notice"),
  sumCount: document.getElementById("sumCount"),
  sumNearest: document.getElementById("sumNearest"),
  sumFastest: document.getElementById("sumFastest"),
  sort: document.getElementById("sort"),
  canvas: document.getElementById("radar"),
  channels: document.getElementById("channels"),
  best: document.getElementById("best"),
  themeBtn: document.getElementById("themeBtn"),
};

/* ------------------------------------------------------------------ helpers */
const fmtSpeed = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " Gbps" : m + " Mbps");
const fmtDist = (m) => (m >= 100 ? Math.round(m) + " m" : m.toFixed(1) + " m");
const qualityClass = (p) => (p >= 55 ? "good" : p >= 35 ? "fair" : "weak");
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function hexToRgba(hex, a) {
  const h = hex.replace("#", "");
  const n = parseInt(h.length === 3 ? h.replace(/./g, "$&$&") : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

function hashOf(text) {
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h;
}

function angleFor(bssid) {
  return ((hashOf(bssid) % 3600) / 3600) * Math.PI * 2; // stable pseudo-random angle
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text; // textContent keeps odd SSIDs safe
  return node;
}

function visibleNetworks() {
  const list = state.networks.filter((n) => state.band === "all" || n.band === state.band);
  const key = state.sort;
  list.sort((a, b) => {
    if (key === "ssid") return a.ssid.localeCompare(b.ssid);
    if (key === "distance_m") return a.distance_m - b.distance_m;
    return b[key] - a[key]; // signal, speed, range: biggest first
  });
  return list;
}

/* ---------------------------------------------------------- signal history */
function updateHistory(data) {
  if (data.updated === state.lastUpdated) return; // same scan as last poll
  state.lastUpdated = data.updated;

  const seen = new Set();
  for (const n of state.networks) {
    seen.add(n.bssid);
    let h = state.history.get(n.bssid);
    if (!h) { h = { vals: [], miss: 0 }; state.history.set(n.bssid, h); }
    h.miss = 0;
    h.vals.push(n.signal_percent);
    if (h.vals.length > HISTORY_MAX) h.vals.shift();
  }
  for (const [id, h] of state.history) {
    if (!seen.has(id) && ++h.miss > HISTORY_GRACE) state.history.delete(id);
  }
}

function sparkline(vals, quality) {
  const w = 92, h = 28, pad = 3;
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.setAttribute("class", "spark " + quality);
  svg.setAttribute("role", "img");
  svg.setAttribute("aria-label", `Signal over the last ${vals.length} scans`);

  if (vals.length < 2) {
    const base = document.createElementNS(SVG_NS, "line");
    base.setAttribute("class", "base");
    base.setAttribute("x1", pad); base.setAttribute("x2", w - pad);
    base.setAttribute("y1", h / 2); base.setAttribute("y2", h / 2);
    svg.appendChild(base);
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("cx", w - pad); dot.setAttribute("cy", h / 2); dot.setAttribute("r", 2.8);
    svg.appendChild(dot);
    return svg;
  }

  // Scale to the data, but never zoom in tighter than a 16-point window,
  // so tiny fluctuations don't look like dramatic swings.
  const lo = Math.min(...vals), hi = Math.max(...vals);
  const span = Math.max(hi - lo, 16);
  const min = (hi + lo) / 2 - span / 2;
  const pts = vals.map((v, i) => [
    pad + (i * (w - 2 * pad)) / (vals.length - 1),
    h - pad - ((v - min) / span) * (h - 2 * pad),
  ]);

  const line = document.createElementNS(SVG_NS, "polyline");
  line.setAttribute("points", pts.map((p) => p.map((x) => x.toFixed(1)).join(",")).join(" "));
  svg.appendChild(line);

  const last = pts[pts.length - 1];
  const dot = document.createElementNS(SVG_NS, "circle");
  dot.setAttribute("cx", last[0].toFixed(1)); dot.setAttribute("cy", last[1].toFixed(1)); dot.setAttribute("r", 2.8);
  svg.appendChild(dot);
  return svg;
}

/* --------------------------------------------------------------------- list */
function renderRows() {
  const list = visibleNetworks();
  els.rows.replaceChildren();

  if (!list.length) {
    const tr = el("tr");
    const td = el("td", "empty", state.networks.length ? "No networks on this band." : "No networks found yet.");
    td.colSpan = 6;
    tr.appendChild(td);
    els.rows.appendChild(tr);
    return;
  }

  for (const n of list) {
    const tr = el("tr");
    if (n.connected) tr.classList.add("is-connected");
    if (n.bssid === state.hover) tr.classList.add("is-hover");
    tr.addEventListener("mouseenter", () => { state.hover = n.bssid; tr.classList.add("is-hover"); drawChannels(); });
    tr.addEventListener("mouseleave", () => { state.hover = null; tr.classList.remove("is-hover"); drawChannels(); });

    // network
    const tdName = el("td");
    const name = el("div", "name");
    name.appendChild(el("span", "", n.ssid));
    if (n.connected) name.appendChild(el("span", "tag", "Connected"));
    name.appendChild(el("span", "tag band", n.band));
    tdName.appendChild(name);
    tdName.appendChild(el("div", "meta", `Channel ${n.channel} · ${n.security}`));

    // signal
    const tdSig = el("td");
    const sig = el("div", "sig");
    const bars = el("span", "bars " + qualityClass(n.signal_percent));
    const lit = Math.max(1, Math.ceil(n.signal_percent / 25));
    for (let i = 1; i <= 4; i++) bars.appendChild(el("i", i <= lit ? "on" : ""));
    const txt = el("div", "sig-text", `${n.signal_percent}%`);
    txt.appendChild(el("small", "", `${n.signal_dbm} dBm · ${n.quality}`));
    sig.append(bars, txt);
    tdSig.appendChild(sig);

    // trend
    const tdTrend = el("td");
    const hist = state.history.get(n.bssid);
    tdTrend.appendChild(sparkline(hist ? hist.vals : [n.signal_percent], qualityClass(n.signal_percent)));

    const tdSpeed = el("td", "num", fmtSpeed(n.speed_mbps));
    const tdDist = el("td", "num", "≈ " + fmtDist(n.distance_m));
    const tdRange = el("td", "num", "≈ " + fmtDist(n.range_m));

    tr.append(tdName, tdSig, tdTrend, tdSpeed, tdDist, tdRange);
    els.rows.appendChild(tr);
  }
}

function renderSummary() {
  const list = state.networks;
  els.sumCount.textContent = list.length;
  if (!list.length) {
    els.sumNearest.textContent = els.sumFastest.textContent = "–";
    return;
  }
  const nearest = list.reduce((a, b) => (b.distance_m < a.distance_m ? b : a));
  const fastest = list.reduce((a, b) => (b.speed_mbps > a.speed_mbps ? b : a));
  els.sumNearest.textContent = "≈ " + fmtDist(nearest.distance_m);
  els.sumFastest.textContent = fmtSpeed(fastest.speed_mbps);
}

/* ------------------------------------------------------------------- radar */
const ctx = els.canvas.getContext("2d");

function niceRing(maxDist) {
  for (const r of [5, 10, 20, 30, 50, 80, 120, 200]) if (maxDist <= r * 0.9) return r;
  return 300;
}

function drawRadar(t) {
  const W = els.canvas.width, H = els.canvas.height;
  const cx = W / 2, cy = H / 2, R = W / 2 - 34;
  ctx.clearRect(0, 0, W, H);

  const ink = css("--ink"), onInk = css("--on-ink"), line = css("--line");
  const teal = css("--teal"), muted = css("--muted"), panel = css("--panel");

  // choose a scale that fits the farthest visible network
  const list = visibleNetworks();
  const farthest = list.reduce((m, n) => Math.max(m, n.distance_m), 0);
  state.ringMax += (niceRing(farthest) - state.ringMax) * 0.08;

  // rings + cross hairs
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = line;
  ctx.fillStyle = muted;
  ctx.font = "500 18px 'Instrument Sans', sans-serif";
  ctx.textAlign = "left";
  for (let i = 1; i <= 4; i++) {
    const r = (R * i) / 4;
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.fillText(Math.round((state.ringMax * i) / 4) + " m", cx + 6, cy - r + 20);
  }
  ctx.beginPath();
  ctx.moveTo(cx - R, cy); ctx.lineTo(cx + R, cy);
  ctx.moveTo(cx, cy - R); ctx.lineTo(cx, cy + R);
  ctx.stroke();

  // sweep
  const sweep = ((t / 4000) % 1) * Math.PI * 2;
  const grad = ctx.createConicGradient(sweep - Math.PI / 2.2, cx, cy);
  grad.addColorStop(0, hexToRgba(teal, 0));
  grad.addColorStop(0.18, hexToRgba(teal, 0.25));
  grad.addColorStop(0.1801, hexToRgba(teal, 0));
  ctx.fillStyle = grad;
  ctx.beginPath(); ctx.arc(cx, cy, R, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = teal; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.moveTo(cx, cy);
  ctx.lineTo(cx + Math.cos(sweep) * R, cy + Math.sin(sweep) * R); ctx.stroke();

  // you
  ctx.fillStyle = ink;
  ctx.beginPath(); ctx.arc(cx, cy, 7, 0, Math.PI * 2); ctx.fill();

  // networks
  const colors = { good: css("--good"), fair: css("--fair"), weak: css("--weak") };
  let hovered = null;

  for (const n of list) {
    const ang = angleFor(n.bssid);
    const rr = Math.min(n.distance_m / state.ringMax, 1) * R;
    let d = state.dots.get(n.bssid);
    if (!d) { d = { r: rr }; state.dots.set(n.bssid, d); }
    d.r += (rr - d.r) * 0.12; // glide toward new distance

    const x = cx + Math.cos(ang) * d.r, y = cy + Math.sin(ang) * d.r;
    const color = colors[qualityClass(n.signal_percent)];

    // "ping" when the sweep passes over the dot
    let diff = (sweep - ang) % (Math.PI * 2);
    if (diff < 0) diff += Math.PI * 2;
    const glow = Math.max(0, 1 - diff / 1.6);

    const isHover = n.bssid === state.hover;
    if (glow > 0 || isHover) {
      ctx.fillStyle = color;
      ctx.globalAlpha = isHover ? 0.25 : glow * 0.3;
      ctx.beginPath(); ctx.arc(x, y, 14 + glow * 14, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = color;
    ctx.strokeStyle = panel; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.arc(x, y, n.connected ? 11 : 8, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    if (n.connected) {
      ctx.strokeStyle = ink; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.arc(x, y, 15, 0, Math.PI * 2); ctx.stroke();
    }

    if (isHover || n.connected) hovered = { n, x, y };
  }

  // label for hovered / connected network
  if (hovered) {
    const text = `${hovered.n.ssid} · ${fmtDist(hovered.n.distance_m)}`;
    ctx.font = "600 19px 'Instrument Sans', sans-serif";
    const w = ctx.measureText(text).width + 20;
    let lx = hovered.x + 14; if (lx + w > W - 4) lx = hovered.x - w - 14;
    const ly = hovered.y - 34;
    ctx.fillStyle = ink;
    ctx.beginPath(); ctx.roundRect(lx, ly, w, 30, 6); ctx.fill();
    ctx.fillStyle = onInk; ctx.textAlign = "left";
    ctx.fillText(text, lx + 10, ly + 21);
  }

  requestAnimationFrame(drawRadar);
}

/* ------------------------------------------------------- channel congestion */
// freqOf: channel number -> centre frequency (MHz)
// halfMHz: half the width a 20 MHz signal occupies
// overlap(a, b): how much a network on channel b disturbs channel a (0..1)
const PSC_6GHZ = [5, 21, 37, 53, 69, 85, 101, 117, 133, 149, 165, 181, 197, 213, 229];
const range = (from, to, step) => { const out = []; for (let c = from; c <= to; c += step) out.push(c); return out; };

const BANDS = {
  "2.4 GHz": {
    freqOf: (c) => 2407 + 5 * c,
    halfMHz: 11,
    channels: range(1, 13, 1),
    candidates: [1, 6, 11],
    overlap: (a, b) => Math.max(0, 1 - Math.abs(a - b) / 5),
    fixedAxis: [2397, 2487],
  },
  "5 GHz": {
    freqOf: (c) => 5000 + 5 * c,
    halfMHz: 10,
    channels: [...range(36, 64, 4), ...range(100, 144, 4), ...range(149, 165, 4)],
    candidates: [36, 40, 44, 48, 149, 153, 157, 161],
    overlap: (a, b) => (a === b ? 1 : Math.abs(a - b) === 4 ? 0.25 : 0),
    defaultAxis: [5170, 5330],
  },
  "6 GHz": {
    freqOf: (c) => 5950 + 5 * c,
    halfMHz: 10,
    channels: range(1, 233, 4),
    candidates: PSC_6GHZ,
    overlap: (a, b) => (a === b ? 1 : Math.abs(a - b) === 4 ? 0.25 : 0),
    defaultAxis: [5945, 6105],
  },
};

function axisRange(band, nets) {
  const cfg = BANDS[band];
  if (cfg.fixedAxis) return cfg.fixedAxis;
  if (!nets.length) return cfg.defaultAxis;
  const f = nets.map((n) => n.frequency_mhz);
  let lo = Math.min(...f) - 50, hi = Math.max(...f) + 50;
  if (hi - lo < 160) { const m = (hi + lo) / 2; lo = m - 80; hi = m + 80; }
  return [lo, hi];
}

function netColor(n, dark) {
  if (n.connected) return css("--teal");
  const hue = hashOf(n.ssid + n.bssid) % 360;
  return `hsl(${hue}, 62%, ${dark ? 66 : 40}%)`;
}

function withAlpha(color, a) {
  if (color.startsWith("hsl(")) return color.replace("hsl(", "hsla(").replace(")", `, ${a})`);
  return hexToRgba(color, a);
}

const chCtx = els.channels.getContext("2d");

function drawChannels() {
  const cv = els.channels;
  const cssW = cv.clientWidth, cssH = cv.clientHeight;
  if (!cssW || !cssH) return;
  const dpr = window.devicePixelRatio || 1;
  if (cv.width !== Math.round(cssW * dpr) || cv.height !== Math.round(cssH * dpr)) {
    cv.width = Math.round(cssW * dpr);
    cv.height = Math.round(cssH * dpr);
  }
  const c = chCtx;
  c.setTransform(dpr, 0, 0, dpr, 0, 0);
  c.clearRect(0, 0, cssW, cssH);

  const dark = document.documentElement.dataset.theme === "dark";
  const ink = css("--ink"), muted = css("--muted"), line = css("--line"), panel = css("--panel");
  const cfg = BANDS[state.chBand];
  const nets = state.networks.filter((n) => n.band === state.chBand);
  const [lo, hi] = axisRange(state.chBand, nets);

  const L = 42, Rm = 14, T = 14, B = 34;
  const pw = cssW - L - Rm, ph = cssH - T - B;
  const xOf = (f) => L + ((f - lo) / (hi - lo)) * pw;
  const yOf = (p) => T + (1 - p / 100) * ph;
  const pxPerMHz = pw / (hi - lo);

  c.font = "500 12px 'Instrument Sans', sans-serif";
  c.lineWidth = 1;

  // horizontal grid + signal labels
  c.textAlign = "right";
  c.textBaseline = "middle";
  for (const p of [0, 25, 50, 75, 100]) {
    c.strokeStyle = line;
    c.beginPath(); c.moveTo(L, yOf(p)); c.lineTo(L + pw, yOf(p)); c.stroke();
    c.fillStyle = muted;
    c.fillText(p + "%", L - 8, yOf(p));
  }

  // channel ticks (label only as many as fit)
  const inView = cfg.channels.filter((ch) => cfg.freqOf(ch) >= lo && cfg.freqOf(ch) <= hi);
  const spacing = inView.length > 1 ? (cfg.freqOf(inView[1]) - cfg.freqOf(inView[0])) * pxPerMHz : 100;
  const every = Math.max(1, Math.ceil(46 / spacing));
  c.textAlign = "center";
  c.textBaseline = "top";
  inView.forEach((ch, i) => {
    const x = xOf(cfg.freqOf(ch));
    c.strokeStyle = line;
    c.beginPath(); c.moveTo(x, T + ph); c.lineTo(x, T + ph + 5); c.stroke();
    if (i % every === 0) { c.fillStyle = muted; c.fillText(ch, x, T + ph + 9); }
  });

  if (!nets.length) {
    c.fillStyle = muted;
    c.textAlign = "center"; c.textBaseline = "middle";
    c.font = "500 15px 'Instrument Sans', sans-serif";
    c.fillText(`No ${state.chBand} networks in range`, L + pw / 2, T + ph / 2);
    return;
  }

  // curves: weakest first so the strongest sit on top
  const hoverOn = state.hover && nets.some((n) => n.bssid === state.hover);
  const ordered = [...nets].sort((a, b) => a.signal_percent - b.signal_percent);
  const eh = Math.max(cfg.halfMHz, 16 / pxPerMHz); // keep narrow 5/6 GHz curves visible

  for (const n of ordered) {
    const color = netColor(n, dark);
    const isHover = n.bssid === state.hover;
    const dim = hoverOn && !isHover;
    const f = n.frequency_mhz;

    c.beginPath();
    c.moveTo(xOf(f - eh), yOf(0));
    for (let i = 0; i <= 48; i++) {
      const t = -1 + (2 * i) / 48;
      const p = n.signal_percent * Math.pow(Math.cos((Math.PI / 2) * t), 2);
      c.lineTo(xOf(f + t * eh), yOf(p));
    }
    c.closePath();
    c.fillStyle = withAlpha(color, dim ? 0.06 : isHover ? 0.38 : n.connected ? 0.28 : 0.16);
    c.fill();
    c.strokeStyle = withAlpha(color, dim ? 0.35 : 1);
    c.lineWidth = isHover || n.connected ? 3 : 2;
    c.stroke();
  }

  // labels, nudged upward when they would collide
  const placed = [];
  c.font = "600 12.5px 'Instrument Sans', sans-serif";
  c.textAlign = "center";
  c.textBaseline = "alphabetic";
  for (const n of [...ordered].reverse()) {
    const x = xOf(n.frequency_mhz);
    let y = yOf(n.signal_percent) - 8;
    const w = c.measureText(n.ssid).width + 6;
    for (let tries = 0; tries < 5; tries++) {
      const clash = placed.some((r) => Math.abs(r.x - x) < (r.w + w) / 2 && Math.abs(r.y - y) < 15);
      if (!clash) break;
      y -= 15;
    }
    y = Math.max(y, T + 10);
    placed.push({ x, y, w });
    const dim = hoverOn && n.bssid !== state.hover;
    c.globalAlpha = dim ? 0.4 : 1;
    c.lineWidth = 4;
    c.strokeStyle = panel;
    c.strokeText(n.ssid, x, y);
    c.fillStyle = ink;
    c.fillText(n.ssid, x, y);
    c.globalAlpha = 1;
  }
}

/* ------------------------------------------------- best channel suggestion */
function channelScore(cfg, channel, others) {
  // Adds up the signal strength of every network that overlaps this channel.
  return others.reduce((sum, n) => sum + (n.signal_percent / 100) * cfg.overlap(channel, n.channel), 0);
}

function renderBest() {
  const cfg = BANDS[state.chBand];
  const nets = state.networks.filter((n) => n.band === state.chBand);
  const mine = state.networks.find((n) => n.connected);
  const myHere = mine && mine.band === state.chBand ? mine : null;
  els.best.replaceChildren();

  if (!nets.length) {
    els.best.append(
      el("p", "best-label", "Quietest channel"),
      el("p", "best-text", `No ${state.chBand} networks are in range, so every channel is free.`)
    );
    return;
  }

  // Don't count your own router against the channel it is already using.
  const others = nets.filter((n) => !(mine && n.ssid === mine.ssid));

  const rows = cfg.candidates.map((ch) => ({ ch, score: channelScore(cfg, ch, others), mine: myHere && myHere.channel === ch }));
  if (myHere && !rows.some((r) => r.mine)) {
    rows.push({ ch: myHere.channel, score: channelScore(cfg, myHere.channel, others), mine: true });
  }
  rows.sort((a, b) => a.score - b.score || (b.mine ? 1 : 0) - (a.mine ? 1 : 0));

  const best = rows[0];
  const mineRow = rows.find((r) => r.mine);

  let advice;
  if (!myHere) {
    advice = `Fewest overlapping networks of the usual ${state.chBand} choices.`;
  } else if (best.mine) {
    advice = `Your router is on channel ${myHere.channel}, which is already the quietest.`;
  } else if (mineRow.score - best.score >= 0.3) {
    advice = `Your router is on channel ${myHere.channel}. Switching to channel ${best.ch} could reduce interference.`;
  } else {
    advice = `Your router is on channel ${myHere.channel}, which is about as quiet as the best option.`;
  }

  const list = el("ul", "score-list");
  for (const r of rows.slice(0, 5)) {
    const level = r.score < 0.3 ? "quiet" : r.score < 1 ? "moderate" : "busy";
    const li = el("li", level + (r.mine ? " is-mine" : ""));
    li.appendChild(el("span", "ch", `Ch ${r.ch}${r.mine ? " (you)" : ""}`));
    const bar = el("span", "bar");
    const fill = el("span");
    fill.style.width = Math.max(6, Math.min(r.score / 2, 1) * 100) + "%";
    bar.appendChild(fill);
    li.append(bar, el("span", "verdict", level === "quiet" ? "Quiet" : level === "moderate" ? "Moderate" : "Busy"));
    list.appendChild(li);
  }

  els.best.append(
    el("p", "best-label", "Quietest channel"),
    el("p", "best-channel", "Channel " + best.ch),
    el("p", "best-text", advice),
    list,
    el("p", "best-foot", "Each score adds up the signal strength of nearby networks that overlap that channel. Lower is quieter.")
  );
}

/* -------------------------------------------------------------------- theme */
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  els.themeBtn.textContent = theme === "dark" ? "Light mode" : "Dark mode";
  drawChannels();
}

els.themeBtn.addEventListener("click", () => {
  const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  try { localStorage.setItem("wifi-radar-theme", next); } catch (e) { /* private mode */ }
  applyTheme(next);
});

/* ------------------------------------------------------------------ polling */
async function poll() {
  try {
    const res = await fetch("/api/networks", { cache: "no-store" });
    if (!res.ok) throw new Error("Server returned " + res.status);
    const data = await res.json();
    state.networks = data.networks || [];

    els.status.classList.toggle("is-error", data.mode === "error");
    els.status.classList.toggle("is-demo", data.mode === "demo");

    const time = data.updated ? new Date(data.updated * 1000).toLocaleTimeString() : "waiting for first scan";
    els.statusText.textContent =
      data.mode === "demo" ? `Demo data · ${time}` :
      data.mode === "error" ? "Scan failed" :
      `Live · updated ${time}`;

    els.notice.hidden = !data.error;
    els.notice.textContent = data.error || "";

    updateHistory(data);
    renderRows();
    renderSummary();
    drawChannels();
    renderBest();
  } catch (err) {
    els.status.classList.add("is-error");
    els.statusText.textContent = "Can't reach server";
    els.notice.hidden = false;
    els.notice.textContent = "Start the backend with: python3 wifi-analyzer/server.py";
  }
}

/* ------------------------------------------------------------------- events */
document.querySelectorAll("[data-band]").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-band]").forEach((b) => b.classList.remove("is-on"));
    btn.classList.add("is-on");
    state.band = btn.dataset.band;
    renderRows();
  })
);

document.querySelectorAll("[data-chband]").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll("[data-chband]").forEach((b) => b.classList.remove("is-on"));
    btn.classList.add("is-on");
    state.chBand = btn.dataset.chband;
    drawChannels();
    renderBest();
  })
);

els.sort.addEventListener("change", () => { state.sort = els.sort.value; renderRows(); });

let resizeQueued = false;
window.addEventListener("resize", () => {
  if (resizeQueued) return;
  resizeQueued = true;
  requestAnimationFrame(() => { resizeQueued = false; drawChannels(); });
});

applyTheme(document.documentElement.dataset.theme || "light");
poll();
setInterval(poll, POLL_MS);
requestAnimationFrame(drawRadar);