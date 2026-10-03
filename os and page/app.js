// WiFi Radar – front-end
// Polls /api/networks (served by wifi-analyzer/server.py) and draws the list + radar.

const POLL_MS = 2000;

const state = {
  networks: [],
  band: "all",
  sort: "signal_percent",
  hover: null,          // bssid currently hovered
  dots: new Map(),      // bssid -> { x, y } smoothed position (0..1 of radius, angle in rad)
  ringMax: 10,          // metres represented by the outer ring
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
};

/* ------------------------------------------------------------------ helpers */
const fmtSpeed = (m) => (m >= 1000 ? (m / 1000).toFixed(1) + " Gbps" : m + " Mbps");
const fmtDist = (m) => (m >= 100 ? Math.round(m) + " m" : m.toFixed(1) + " m");
const qualityClass = (p) => (p >= 55 ? "good" : p >= 35 ? "fair" : "weak");

function angleFor(bssid) {
  // stable pseudo-random angle per access point
  let h = 0;
  for (const c of bssid) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return (h % 3600) / 3600 * Math.PI * 2;
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

/* --------------------------------------------------------------------- list */
function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text; // textContent keeps odd SSIDs safe
  return node;
}

function renderRows() {
  const list = visibleNetworks();
  els.rows.replaceChildren();

  if (!list.length) {
    const tr = el("tr");
    const td = el("td", "empty", state.networks.length ? "No networks on this band." : "No networks found yet.");
    td.colSpan = 5;
    tr.appendChild(td);
    els.rows.appendChild(tr);
    return;
  }

  for (const n of list) {
    const tr = el("tr");
    if (n.connected) tr.classList.add("is-connected");
    if (n.bssid === state.hover) tr.classList.add("is-hover");
    tr.addEventListener("mouseenter", () => { state.hover = n.bssid; tr.classList.add("is-hover"); });
    tr.addEventListener("mouseleave", () => { state.hover = null; tr.classList.remove("is-hover"); });

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

    const tdSpeed = el("td", "num", fmtSpeed(n.speed_mbps));
    const tdDist = el("td", "num", "≈ " + fmtDist(n.distance_m));
    const tdRange = el("td", "num", "≈ " + fmtDist(n.range_m));

    tr.append(tdName, tdSig, tdSpeed, tdDist, tdRange);
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
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

function niceRing(maxDist) {
  for (const r of [5, 10, 20, 30, 50, 80, 120, 200]) if (maxDist <= r * 0.9) return r;
  return 300;
}

function drawRadar(t) {
  const W = els.canvas.width, H = els.canvas.height;
  const cx = W / 2, cy = H / 2, R = W / 2 - 34;
  ctx.clearRect(0, 0, W, H);

  const ink = css("--ink"), line = css("--line"), teal = css("--teal"), muted = css("--muted");

  // choose a scale that fits the farthest visible network
  const list = visibleNetworks();
  const farthest = list.reduce((m, n) => Math.max(m, n.distance_m), 0);
  const target = niceRing(farthest);
  state.ringMax += (target - state.ringMax) * 0.08;

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
  grad.addColorStop(0, "rgba(14,124,134,0)");
  grad.addColorStop(0.18, "rgba(14,124,134,0.22)");
  grad.addColorStop(0.1801, "rgba(14,124,134,0)");
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
    const target = { r: rr };
    let d = state.dots.get(n.bssid);
    if (!d) { d = { r: rr }; state.dots.set(n.bssid, d); }
    d.r += (target.r - d.r) * 0.12; // glide toward new distance

    const x = cx + Math.cos(ang) * d.r, y = cy + Math.sin(ang) * d.r;
    const color = colors[qualityClass(n.signal_percent)];

    // "ping" when the sweep passes over the dot
    let diff = (sweep - ang) % (Math.PI * 2);
    if (diff < 0) diff += Math.PI * 2;
    const glow = Math.max(0, 1 - diff / 1.6);

    // estimated range halo
    const isHover = n.bssid === state.hover;
    if (glow > 0 || isHover) {
      ctx.fillStyle = color;
      ctx.globalAlpha = isHover ? 0.25 : glow * 0.3;
      ctx.beginPath(); ctx.arc(x, y, 14 + glow * 14, 0, Math.PI * 2); ctx.fill();
      ctx.globalAlpha = 1;
    }

    ctx.fillStyle = color;
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 3;
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
    ctx.fillStyle = "#fff"; ctx.textAlign = "left";
    ctx.fillText(text, lx + 10, ly + 21);
  }

  requestAnimationFrame(drawRadar);
}

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

    renderRows();
    renderSummary();
  } catch (err) {
    els.status.classList.add("is-error");
    els.statusText.textContent = "Can't reach server";
    els.notice.hidden = false;
    els.notice.textContent = "Start the backend with: python3 wifi-analyzer/server.py";
  }
}

/* ------------------------------------------------------------------- events */
document.querySelectorAll(".chip").forEach((btn) =>
  btn.addEventListener("click", () => {
    document.querySelectorAll(".chip").forEach((b) => b.classList.remove("is-on"));
    btn.classList.add("is-on");
    state.band = btn.dataset.band;
    renderRows();
  })
);

els.sort.addEventListener("change", () => { state.sort = els.sort.value; renderRows(); });

poll();
setInterval(poll, POLL_MS);
requestAnimationFrame(drawRadar);