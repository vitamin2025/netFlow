#!/usr/bin/env python3
"""NetRoute — see which ISPs, networks (ASNs) and datacenters your packets cross.

Run:  python3 netroute.py        then open http://127.0.0.1:8765
No dependencies beyond the Python standard library. macOS / Linux.
"""
import ipaddress
import json
import os
import re
import shutil
import socket
import subprocess
import threading
import urllib.request
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

HOST, PORT = "127.0.0.1", int(os.environ.get("PORT", 8765))
HERE = os.path.dirname(os.path.abspath(__file__))

# ip-api.com: free, no key, 45 single / 15 batch requests per minute.
GEO_FIELDS = ("status,message,query,country,countryCode,regionName,city,lat,lon,"
              "isp,org,as,asname,hosting,mobile,proxy,reverse")
CGNAT = ipaddress.ip_network("100.64.0.0/10")
TARGET_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.\-:]{0,252}$")
IPV4_RE = re.compile(r"\b\d{1,3}(?:\.\d{1,3}){3}\b")
RTT_RE = re.compile(r"([\d.]+)\s*ms")
SILENT_STOP = 5  # give up after this many non-replying hops in a row

_cache = {}
_cache_lock = threading.Lock()


# ---------------------------------------------------------------- geo / ASN lookup

def _http_json(url, body=None):
    headers = {"Content-Type": "application/json"} if body is not None else {}
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=10) as r:
        return json.loads(r.read())


def _local_kind(ip):
    """Label addresses that never leave a private / ISP-internal network."""
    try:
        a = ipaddress.ip_address(ip)
    except ValueError:
        return None
    if a.is_loopback:
        return "Loopback"
    if a.version == 4 and a in CGNAT:
        return "Carrier-grade NAT (inside your ISP)"
    if a.is_private or a.is_link_local:
        return "Private / local network"
    return None


def _normalize(r):
    asn_full = r.get("as") or ""
    asn = asn_full.split(" ", 1)[0] if asn_full.startswith("AS") else ""
    if r.get("hosting"):
        kind = "datacenter"
    elif r.get("mobile"):
        kind = "mobile"
    else:
        kind = "isp"
    return {
        "ip": r.get("query"), "kind": kind, "label": None,
        "isp": r.get("isp") or "", "org": r.get("org") or "",
        "asn": asn, "asname": r.get("asname") or "",
        "city": r.get("city") or "", "region": r.get("regionName") or "",
        "country": r.get("country") or "", "cc": r.get("countryCode") or "",
        "lat": r.get("lat"), "lon": r.get("lon"),
        "host": r.get("reverse") or "", "proxy": bool(r.get("proxy")),
    }


def lookup_many(ips):
    """Return {ip: info} for every ip, using cache + ip-api batch endpoint."""
    result, todo = {}, []
    for ip in dict.fromkeys(ips):
        label = _local_kind(ip)
        if label:
            result[ip] = {"ip": ip, "kind": "local", "label": label, "isp": "", "org": "",
                          "asn": "", "asname": "", "city": "", "region": "", "country": "",
                          "cc": "", "lat": None, "lon": None, "host": "", "proxy": False}
            continue
        with _cache_lock:
            if ip in _cache:
                result[ip] = _cache[ip]
                continue
        todo.append(ip)

    for i in range(0, len(todo), 100):
        chunk = todo[i:i + 100]
        try:
            rows = _http_json(f"http://ip-api.com/batch?fields={GEO_FIELDS}", chunk)
        except Exception as e:  # network down, rate-limited, ...
            for ip in chunk:
                result[ip] = {"ip": ip, "kind": "unknown", "label": f"lookup failed: {e}"}
            continue
        for ip, row in zip(chunk, rows):
            if row.get("status") == "success":
                info = _normalize(row)
                with _cache_lock:
                    _cache[ip] = info
            else:
                info = {"ip": ip, "kind": "unknown", "label": row.get("message", "no data")}
            result[ip] = info
    return result


def lookup_self():
    try:
        return _normalize(_http_json(f"http://ip-api.com/json/?fields={GEO_FIELDS}"))
    except Exception as e:
        return {"error": str(e)}


# ---------------------------------------------------------------- traceroute

def _traceroute_lines(target_ip, max_hops):
    """Yield traceroute output lines as they appear (traceroute flushes per hop)."""
    exe = shutil.which("traceroute") or "/usr/sbin/traceroute"
    proc = subprocess.Popen(
        [exe, "-n", "-q", "1", "-w", "2", "-m", str(max_hops), target_ip],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, stdin=subprocess.DEVNULL,
        text=True, bufsize=1)
    try:
        for line in proc.stdout:
            yield line.rstrip()
        proc.wait(timeout=5)
        if proc.returncode != 0:
            err = proc.stderr.read().strip()
            raise RuntimeError(err or f"traceroute exited with {proc.returncode}")
    finally:
        if proc.poll() is None:
            proc.kill()


def trace_events(target, max_hops=30):
    try:
        target_ip = socket.getaddrinfo(target, None, socket.AF_INET)[0][4][0]
    except socket.gaierror as e:
        yield {"type": "error", "message": f"Could not resolve {target}: {e}"}
        return
    dest = lookup_many([target_ip])[target_ip]
    yield {"type": "start", "target": target, "ip": target_ip, "dest": dest}
    silent = 0
    lines = _traceroute_lines(target_ip, max_hops)
    try:
        for line in lines:
            m = re.match(r"^\s*(\d+)\s+(.*)$", line)
            if not m:
                continue
            hop, rest = int(m.group(1)), m.group(2)
            ips = IPV4_RE.findall(rest)
            rtts = [float(x) for x in RTT_RE.findall(rest)]
            ev = {"type": "hop", "hop": hop, "rtt": rtts[0] if rtts else None}
            if ips:
                ev["info"] = lookup_many([ips[0]])[ips[0]]
                silent = 0
            else:
                ev["info"] = None  # router didn't answer (* * *)
                silent += 1
            yield ev
            if silent >= SILENT_STOP:
                # The destination network filters traceroute; waiting longer won't reveal more.
                yield {"type": "done", "reached": False, "silent": True}
                return
    except RuntimeError as e:
        yield {"type": "error", "message": str(e)}
        return
    finally:
        lines.close()
    yield {"type": "done", "reached": True}


# ---------------------------------------------------------------- live connections

def connections():
    try:
        out = subprocess.run(["lsof", "+c", "0", "-nP", "-i"], capture_output=True,
                             text=True, timeout=20).stdout
    except Exception as e:
        return {"error": str(e), "items": []}
    groups = {}
    for line in out.splitlines()[1:]:
        if "->" not in line:
            continue
        parts = line.split()
        if len(parts) < 9:
            continue
        cmd = parts[0].replace("\\x20", " ")
        proto = parts[7]
        name = parts[8]
        state = parts[9].strip("()") if len(parts) > 9 else ""
        remote = name.split("->", 1)[1]
        if ":" not in remote:
            continue
        host, port = remote.rsplit(":", 1)
        host = host.strip("[]")
        try:
            if ipaddress.ip_address(host).is_loopback:
                continue
        except ValueError:
            continue
        g = groups.setdefault((cmd, host), {"process": cmd, "ip": host, "proto": proto,
                                            "ports": set(), "count": 0, "states": set()})
        g["ports"].add(port)
        g["count"] += 1
        if state:
            g["states"].add(state)
    infos = lookup_many([g["ip"] for g in groups.values()])
    items = []
    for g in groups.values():
        g["ports"] = sorted(g["ports"], key=lambda p: (not p.isdigit(), int(p) if p.isdigit() else p))
        g["states"] = sorted(g["states"])
        g["info"] = infos.get(g["ip"])
        items.append(g)
    items.sort(key=lambda g: (g["process"].lower(), g["ip"]))
    return {"items": items}


# ---------------------------------------------------------------- HTTP server

class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass

    def _json(self, obj, code=200):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        url = urlparse(self.path)
        q = parse_qs(url.query)
        if url.path in ("/", "/index.html"):
            with open(os.path.join(HERE, "index.html"), "rb") as f:
                body = f.read()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        elif url.path == "/api/health":
            self._json({"ok": True, "app": "netroute"})
        elif url.path == "/api/me":
            self._json(lookup_self())
        elif url.path == "/api/connections":
            self._json(connections())
        elif url.path == "/api/trace":
            target = (q.get("target") or [""])[0].strip()
            if not TARGET_RE.match(target):
                return self._json({"error": "invalid target"}, 400)
            max_hops = max(1, min(64, int((q.get("max") or ["30"])[0] or 30)))
            self._stream(trace_events(target, max_hops))
        else:
            self._json({"error": "not found"}, 404)

    def _stream(self, events):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        try:
            for ev in events:
                self.wfile.write(f"data: {json.dumps(ev)}\n\n".encode())
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            events.close()  # kills traceroute if the browser went away


def main():
    server = ThreadingHTTPServer((HOST, PORT), Handler)
    url = f"http://{HOST}:{PORT}"
    print(f"NetRoute running at {url}  (Ctrl+C to stop)")
    if not os.environ.get("NO_BROWSER"):
        threading.Timer(0.5, lambda: webbrowser.open(url)).start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
