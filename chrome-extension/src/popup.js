const SERVER = "http://127.0.0.1:8765";
const KIND_LABEL = { local: "Local", isp: "ISP", datacenter: "Datacenter", mobile: "Mobile", unknown: "Unknown", timeout: "No reply", pending: "Looking up" };
const KIND_VAR = { local: "--local", isp: "--isp", datacenter: "--dc", mobile: "--mobile", unknown: "--unknown", timeout: "--unknown", pending: "--unknown" };

const $ = s => document.querySelector(s);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const badge = k => `<span class="badge k-${k}">${KIND_LABEL[k] || k}</span>`;
const place = i => [i.city, i.region !== i.city ? i.region : "", i.country].filter(Boolean).join(", ");
const netName = i => i.label || (i.isp && i.org && i.org !== i.isp ? `${i.isp} · ${i.org}` : (i.isp || i.org || i.asname || ""));
const flag = cc => cc && cc.length === 2 ? String.fromCodePoint(...[...cc.toUpperCase()].map(c => 127397 + c.charCodeAt(0))) : "";

// Rough "same site" check: compare the last two labels (three for co.uk-style suffixes).
function siteOf(host) {
  const p = (host || "").split(".");
  const n = p.length > 2 && p[p.length - 2].length <= 3 && p[p.length - 1].length === 2 ? 3 : 2;
  return p.slice(-n).join(".");
}

// popup.html?tab=<id> inspects a specific tab (handy for testing or opening the popup as a page).
const forcedTab = Number(new URLSearchParams(location.search).get("tab"));
const tab = forcedTab ? await chrome.tabs.get(forcedTab) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
let state = null;

/* ---------------------------------------------------------------- site + hosts */

async function refresh() {
  if (!tab || !/^https?:/.test(tab.url || "")) {
    $("#site").innerHTML = `<div class="muted">Open a website to see which network and datacenter serves it.</div>`;
    return false;
  }
  state = await chrome.runtime.sendMessage({ type: "tab", tabId: tab.id });
  renderSite();
  renderHosts();
  return true;
}

function renderSite() {
  const host = new URL(tab.url).hostname;
  if (!state || !state.mainIp) {
    $("#site").innerHTML = `
      <div class="site-host">${esc(host)}</div>
      <p class="muted small">This page loaded before NetRoute was running, so it hasn't seen which server it came from.</p>
      <button id="reload" class="btn ghost">Reload page</button>`;
    $("#reload").onclick = () => { chrome.tabs.reload(tab.id); setTimeout(refresh, 1500); };
    $("#trace-card").hidden = true;
    return;
  }
  const i = state.infos[state.mainIp];
  const kind = i ? i.kind : "pending";
  $("#site").innerHTML = `
    <div class="site-host">${esc(state.pageHost)}</div>
    <div class="site-net">${i ? esc(netName(i)) || "Unknown network" : "Looking up…"} ${badge(kind)}</div>
    ${i && kind !== "local" ? `<div class="site-sub">${flag(i.cc)} ${esc(place(i))}</div>` : ""}
    <dl class="kv">
      <dt>Server IP</dt><dd class="mono">${esc(state.mainIp)}</dd>
      ${i?.asn ? `<dt>Network</dt><dd>${esc(i.asn)} ${esc(i.asname)}</dd>` : ""}
      ${i?.host ? `<dt>Hostname</dt><dd class="mono">${esc(i.host)}</dd>` : ""}
    </dl>`;
  $("#trace-card").hidden = false;
  traceTarget = traceTarget || defaultTarget();
}

function defaultTarget() {
  // Trace the exact IP the browser connected to; traceroute here is IPv4-only, so fall back to the hostname.
  return state.mainIp.includes(":") ? state.pageHost : state.mainIp;
}

function renderHosts() {
  const hosts = Object.entries(state?.hosts || {});
  if (!hosts.length) { $("#hosts-card").hidden = true; return; }
  const groups = new Map();
  for (const [name, h] of hosts) {
    const i = state.infos[h.ip];
    const key = !i ? "pending" : i.kind === "local" ? "local:" + i.label : (i.asn || i.isp || i.ip);
    const g = groups.get(key) || { info: i, kind: i ? i.kind : "pending", hosts: [], count: 0 };
    g.hosts.push({ name, ...h });
    g.count += h.count;
    groups.set(key, g);
  }
  const list = [...groups.values()].sort((a, b) => b.count - a.count);
  const total = hosts.reduce((n, [, h]) => n + h.count, 0);
  const pageSite = siteOf(state.pageHost);
  $("#hosts-title").textContent = `${hosts.length} host${hosts.length === 1 ? "" : "s"} · ${list.length} network${list.length === 1 ? "" : "s"} · ${total} requests`;
  $("#hosts").innerHTML = list.map(g => {
    const i = g.info;
    const name = !i ? "Looking up…" : i.kind === "local" ? i.label : (i.isp || i.org || i.asname || i.ip);
    const sub = i && i.kind !== "local" ? [i.asn, i.org && i.org !== i.isp ? i.org : "", `${flag(i.cc)} ${place(i)}`.trim()].filter(Boolean).join(" · ") : "";
    g.hosts.sort((a, b) => b.count - a.count);
    return `<div class="group">
      <div class="group-head"><span class="group-name">${esc(name)}</span>${badge(g.kind)}<span class="group-count">${g.count}</span></div>
      ${sub ? `<div class="group-sub">${esc(sub)}</div>` : ""}
      <div class="host-list">${g.hosts.map(h => `<span class="host ${siteOf(h.name) === pageSite ? "first" : ""}" data-ip="${esc(h.ip)}" data-name="${esc(h.name)}" title="${esc(h.name)} → ${esc(h.ip)} · ${h.count} request${h.count === 1 ? "" : "s"} · click to trace">${esc(h.name)}${h.count > 1 ? ` <span class="muted">×${h.count}</span>` : ""}</span>`).join("")}</div>
    </div>`;
  }).join("");
  document.querySelectorAll(".host").forEach(el => el.onclick = () => {
    const ip = el.dataset.ip;
    startTrace(ip.includes(":") ? el.dataset.name : ip, el.dataset.name);
  });
  $("#hosts-card").hidden = false;
}

/* ---------------------------------------------------------------- NetRoute app (local server) */

let serverUp = null;
async function checkServer() {
  try {
    const r = await fetch(`${SERVER}/api/health`, { signal: AbortSignal.timeout(1200) });
    serverUp = r.ok && (await r.json()).app === "netroute";
  } catch {
    serverUp = false;
  }
  const dot = $("#server-dot");
  dot.className = "dot-status " + (serverUp ? "on" : "off");
  dot.title = serverUp ? "NetRoute app is running — route tracing available" : "NetRoute app is not running — start it to trace routes";
  return serverUp;
}

$("#copy-cmd").onclick = async () => {
  await navigator.clipboard.writeText("python3 netroute.py");
  $("#copy-cmd").textContent = "Copied";
};
$("#open-full").onclick = e => {
  e.preventDefault();
  chrome.tabs.create({ url: `${SERVER}/?target=${encodeURIComponent(traceTarget || state?.pageHost || "")}` });
};
$("#trace-btn").onclick = () => startTrace(defaultTarget(), state.pageHost);

/* ---------------------------------------------------------------- trace (streams Server-Sent Events from the app) */

let traceTarget = null, traceAbort = null, hops = [], dest = null;

async function startTrace(target, label) {
  traceTarget = target;
  traceAbort?.abort();
  traceAbort = new AbortController();
  hops = []; dest = null;
  $("#hops").innerHTML = ""; $("#chain").innerHTML = "";
  $("#server-help").hidden = true;
  $("#trace-card").hidden = false;
  $("#trace-btn").disabled = true;
  setTraceStatus(`Tracing ${label && label !== target ? `${label} (${target})` : target}…`);

  if (!(await checkServer())) {
    $("#server-help").hidden = false;
    $("#trace-btn").disabled = false;
    setTraceStatus("");
    return;
  }
  try {
    const res = await fetch(`${SERVER}/api/trace?target=${encodeURIComponent(target)}`, { signal: traceAbort.signal });
    const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
    let buf = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += value;
      let cut;
      while ((cut = buf.indexOf("\n\n")) >= 0) {
        const line = buf.slice(0, cut).split("\n").find(l => l.startsWith("data: "));
        buf = buf.slice(cut + 2);
        if (line) onTraceEvent(JSON.parse(line.slice(6)));
      }
    }
  } catch (e) {
    if (e.name !== "AbortError") setTraceStatus("Trace failed: " + e.message);
  }
  $("#trace-btn").disabled = false;
}

function setTraceStatus(s) { $("#trace-status").textContent = s; }

function onTraceEvent(ev) {
  if (ev.type === "start") dest = ev.dest;
  else if (ev.type === "hop") { hops.push(ev); renderHop(ev); renderChain(false); }
  else if (ev.type === "error") setTraceStatus(ev.message);
  else if (ev.type === "done") {
    const nets = renderChain(true).filter(n => n.kind !== "local").length;
    setTraceStatus(`${hops.length} hops · ${nets} public network${nets === 1 ? "" : "s"}${ev.silent ? " · last routers hidden" : ""}`);
  }
}

function renderHop(ev) {
  const i = ev.info;
  const kind = i ? i.kind : "timeout";
  const last = $("#hops").lastElementChild;
  if (!i && last?.dataset.silentFrom) {
    // Fold consecutive silent routers into one row: "8–12 * no reply".
    last.querySelector(".n").textContent = `${last.dataset.silentFrom}–${ev.hop}`;
    return;
  }
  const prev = hops.slice(0, -1).reverse().find(h => h.rtt != null);
  const jump = prev && ev.rtt != null && ev.rtt - prev.rtt > 40;
  const li = document.createElement("li");
  if (!i) li.dataset.silentFrom = ev.hop;
  li.title = i ? [i.ip, i.host, i.asn && `${i.asn} ${i.asname}`, place(i)].filter(Boolean).join("\n") : "Router didn't reply (traffic still passes through)";
  li.innerHTML = `<span class="n">${ev.hop}</span><span class="c" style="background:var(${KIND_VAR[kind]})"></span>
    <span class="who">${i ? `${esc(netName(i)) || esc(i.ip)} <span class="muted">${esc(i.asn)} ${i.cc ? flag(i.cc) + " " + esc(i.city || i.country) : ""}</span>` : '<span class="muted">* no reply</span>'}</span>
    <span class="rtt ${jump ? "jump" : ""}">${ev.rtt != null ? ev.rtt.toFixed(0) + " ms" : ""}</span>`;
  $("#hops").appendChild(li);
  li.scrollIntoView({ block: "nearest" });
}

function networks() {
  const out = [];
  for (const h of hops) {
    if (!h.info) continue;
    const i = h.info;
    const key = i.kind === "local" ? "local" : (i.asn || i.isp || i.ip);
    if (out.length && out[out.length - 1].key === key) continue;
    out.push({ key, kind: i.kind, name: i.kind === "local" ? "Local" : (i.isp || i.org || i.asname || i.ip), asn: i.asn });
  }
  return out;
}

function renderChain(done) {
  const nets = networks();
  if (done && dest && dest.kind !== "unknown" && !hops.some(h => h.info?.ip === dest.ip)) {
    const last = nets[nets.length - 1];
    if (!(last && dest.asn && last.asn === dest.asn)) {
      nets.push({ kind: dest.kind, name: (dest.isp || dest.org || dest.asname) + " 🎯", asn: dest.asn });
    }
  }
  $("#chain").innerHTML = nets.map(n =>
    `<span class="net" title="${esc(n.asn || "")}"><i style="background:var(${KIND_VAR[n.kind]})"></i>${esc(n.name)}</span>`
  ).join('<span class="arrow">→</span>');
  return nets;
}

/* ---------------------------------------------------------------- boot */

chrome.runtime.sendMessage({ type: "me" }).then(i => {
  $("#me").innerHTML = i ? `You: <b>${esc(i.isp)}</b> ${esc(i.asn)} · ${flag(i.cc)} ${esc(place(i))} · <span class="mono">${esc(i.ip)}</span>` : "Couldn't detect your ISP.";
});
checkServer();
if (await refresh()) {
  // Keep filling in lookups and late requests while the popup is open.
  setInterval(refresh, 1500);
}
