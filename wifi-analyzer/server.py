#!/usr/bin/env python3
"""
WiFi Radar – backend
--------------------
Scans nearby WiFi networks with NetworkManager (nmcli) and serves them as JSON,
together with the web page in "../os and page".

No third-party packages needed (Python 3.8+ standard library only).

Run:
    python3 server.py            # real scan (Linux + NetworkManager)
    python3 server.py --demo     # simulated networks (any OS, for testing the UI)

Then open http://localhost:8000
"""

import argparse
import json
import math
import random
import re
import shutil
import subprocess
import threading
import time
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

WEB_DIR = (Path(__file__).resolve().parent.parent / "os and page")
SCAN_INTERVAL = 4  # seconds between scans

_state = {"networks": [], "updated": 0, "mode": "starting", "error": None}
_lock = threading.Lock()


# ---------------------------------------------------------------- calculations
def band_of(freq_mhz: int) -> str:
    if freq_mhz >= 5925:
        return "6 GHz"
    if freq_mhz >= 4900:
        return "5 GHz"
    return "2.4 GHz"


def percent_to_dbm(percent: int) -> int:
    """nmcli reports signal as 0-100 %. Common approximation: dBm = %/2 - 100."""
    return int(round(percent / 2 - 100))


def estimate_distance_m(rssi_dbm: float, freq_mhz: int) -> float:
    """
    Log-distance path-loss model:  d = 10 ^ ((RSSI@1m - RSSI) / (10 * n))
    RSSI@1m depends on band, n ~ 2.8 for typical indoor environments.
    This is an ESTIMATE – walls, antennas and interference change the result.
    """
    rssi_1m = {"2.4 GHz": -40, "5 GHz": -47, "6 GHz": -50}[band_of(freq_mhz)]
    n = 2.8
    return round(10 ** ((rssi_1m - rssi_dbm) / (10 * n)), 1)


def estimate_range_m(freq_mhz: int) -> float:
    """Approx. distance at which the signal falls to -85 dBm (barely usable)."""
    rssi_1m = {"2.4 GHz": -40, "5 GHz": -47, "6 GHz": -50}[band_of(freq_mhz)]
    return round(10 ** ((rssi_1m + 85) / (10 * 2.8)), 1)


def quality_label(percent: int) -> str:
    if percent >= 75:
        return "Excellent"
    if percent >= 55:
        return "Good"
    if percent >= 35:
        return "Fair"
    return "Weak"


def build_network(ssid, bssid, channel, freq_mhz, rate_mbps, percent, security, in_use):
    dbm = percent_to_dbm(percent)
    return {
        "ssid": ssid or "(hidden network)",
        "bssid": bssid,
        "channel": channel,
        "frequency_mhz": freq_mhz,
        "band": band_of(freq_mhz),
        "speed_mbps": rate_mbps,          # max link rate advertised by the access point
        "signal_percent": percent,
        "signal_dbm": dbm,
        "quality": quality_label(percent),
        "distance_m": estimate_distance_m(dbm, freq_mhz),
        "range_m": estimate_range_m(freq_mhz),
        "security": security or "Open",
        "connected": in_use,
    }


# -------------------------------------------------------------------- scanning
def _split_terse(line: str):
    """nmcli -t escapes ':' inside values as '\\:' – split only on unescaped ones."""
    return [p.replace("\\:", ":").replace("\\\\", "\\") for p in re.split(r"(?<!\\):", line)]


def _num(text: str) -> int:
    m = re.search(r"\d+", text or "")
    return int(m.group()) if m else 0


def scan_nmcli():
    fields = "IN-USE,SSID,BSSID,CHAN,FREQ,RATE,SIGNAL,SECURITY"
    base = ["nmcli", "-t", "-f", fields, "dev", "wifi", "list"]
    try:
        out = subprocess.run(base + ["--rescan", "yes"], capture_output=True, text=True, timeout=20)
        if out.returncode != 0:  # rescans are rate-limited by NM – fall back to cached list
            out = subprocess.run(base, capture_output=True, text=True, timeout=10)
    except subprocess.TimeoutExpired:
        raise RuntimeError("nmcli timed out")
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip() or "nmcli failed")

    networks = []
    for line in out.stdout.splitlines():
        parts = _split_terse(line)
        if len(parts) < 8:
            continue
        in_use, ssid, bssid, chan, freq, rate, signal, security = parts[:8]
        networks.append(build_network(
            ssid, bssid, _num(chan), _num(freq), _num(rate), _num(signal),
            security.strip(), in_use.strip() == "*",
        ))
    networks.sort(key=lambda n: -n["signal_percent"])
    return networks


# ------------------------------------------------------------------- demo mode
_DEMO = [
    ("HomeNet-5G",       "A4:2B:B0:11:22:01", 36, 5180, 866, 82, "WPA2", True),
    ("HomeNet",          "A4:2B:B0:11:22:02",  6, 2437, 144, 88, "WPA2", False),
    ("Neighbour_WiFi",   "D8:07:B6:33:44:05",  1, 2412,  72, 58, "WPA2", False),
    ("CafeGuest",        "F0:9F:C2:55:66:07", 11, 2462,  54, 44, "Open",  False),
    ("Office-AX",        "3C:84:6A:77:88:09", 149, 5745, 1200, 64, "WPA3", False),
    ("Tenda_A1B2",       "C8:3A:35:99:AA:0B",  3, 2422, 300, 31, "WPA2", False),
    ("Fiber-Lite-6E",    "70:4F:57:BB:CC:0D", 37, 6135, 2400, 38, "WPA3", False),
    ("",                 "00:11:22:DD:EE:0F",  9, 2452,  65, 22, "WPA2", False),
]


def scan_demo():
    nets = []
    for ssid, bssid, chan, freq, rate, pct, sec, in_use in _DEMO:
        jitter = random.randint(-4, 4)
        nets.append(build_network(ssid, bssid, chan, freq, rate, max(5, min(99, pct + jitter)), sec, in_use))
    nets.sort(key=lambda n: -n["signal_percent"])
    return nets


# ----------------------------------------------------------------- scan thread
def scan_loop(demo: bool):
    use_demo = demo
    if not use_demo and shutil.which("nmcli") is None:
        use_demo = True
        with _lock:
            _state["error"] = "nmcli not found – showing simulated networks. Install NetworkManager for real scans."
    while True:
        try:
            nets = scan_demo() if use_demo else scan_nmcli()
            with _lock:
                _state.update(networks=nets, updated=time.time(),
                              mode="demo" if use_demo else "live",
                              error=_state["error"] if use_demo else None)
        except Exception as exc:  # keep running, show message in the UI
            with _lock:
                _state.update(error=str(exc), mode="error")
        time.sleep(SCAN_INTERVAL)


# ------------------------------------------------------------------ web server
class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    def do_GET(self):
        if self.path.split("?")[0] == "/api/networks":
            with _lock:
                body = json.dumps(_state).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Cache-Control", "no-store")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        super().do_GET()

    def log_message(self, *args):  # quiet console
        pass


def main():
    ap = argparse.ArgumentParser(description="WiFi Radar server")
    ap.add_argument("--demo", action="store_true", help="use simulated networks")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--host", default="127.0.0.1")
    args = ap.parse_args()

    if not WEB_DIR.exists():
        raise SystemExit(f"Web folder not found: {WEB_DIR}")

    threading.Thread(target=scan_loop, args=(args.demo,), daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"WiFi Radar running at http://{args.host}:{args.port}  (Ctrl+C to stop)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")


if __name__ == "__main__":
    main()