// NetRoute service worker: records which server IP every request in a tab went to,
// looks up who owns it (ISP / ASN / datacenter / location) and badges the toolbar icon.

const FIELDS = "status,message,query,country,countryCode,regionName,city,lat,lon,isp,org,as,asname,hosting,mobile,proxy,reverse";
const CACHE_TTL = 24 * 3600e3;
const CACHE_MAX = 5000;
const HOSTS_PER_TAB = 300;
const BADGE_COLORS = { datacenter: "#ea580c", isp: "#2563eb", mobile: "#7c3aed", local: "#6b7280", unknown: "#71717a" };

const tabs = new Map();      // tabId -> { pageUrl, pageHost, mainIp, hosts: {hostname: {ip, count, types}}, since }
let ipCache = {};            // ip -> { t, info }
let me = null;               // { t, info } for the user's own public IP

const ready = (async () => {
  const [{ tabsState = {} }, { ipCache: saved = {} }] = await Promise.all([
    chrome.storage.session.get("tabsState"),
    chrome.storage.local.get("ipCache"),
  ]);
  for (const [id, s] of Object.entries(tabsState)) tabs.set(Number(id), s);
  const now = Date.now();
  for (const [ip, e] of Object.entries(saved)) if (now - e.t < CACHE_TTL) ipCache[ip] = e;
})();

// ---------------------------------------------------------------- IP classification

function localLabel(ip) {
  if (ip.includes(":")) {
    const x = ip.toLowerCase();
    if (x.startsWith("::ffff:")) return localLabel(x.slice(7));
    if (x === "::1") return "Loopback";
    if (/^f[cd]/.test(x)) return "Private / local network";
    if (/^fe[89ab]/.test(x)) return "Link-local";
    return null;
  }
  const [a, b] = ip.split(".").map(Number);
  if (a === 127) return "Loopback";
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return "Private / local network";
  if (a === 169 && b === 254) return "Link-local";
  if (a === 100 && b >= 64 && b <= 127) return "Carrier-grade NAT (inside your ISP)";
  return null;
}

function normalize(r) {
  const as = r.as || "";
  return {
    ip: r.query, kind: r.hosting ? "datacenter" : r.mobile ? "mobile" : "isp", label: null,
    isp: r.isp || "", org: r.org || "", asn: as.startsWith("AS") ? as.split(" ")[0] : "", asname: r.asname || "",
    city: r.city || "", region: r.regionName || "", country: r.country || "", cc: r.countryCode || "",
    lat: r.lat ?? null, lon: r.lon ?? null, host: r.reverse || "", proxy: !!r.proxy,
  };
}

function info(ip) {
  const label = localLabel(ip);
  if (label) return { ip, kind: "local", label, isp: "", org: "", asn: "", asname: "", city: "", region: "", country: "", cc: "", host: "" };
  return ipCache[ip]?.info || null;
}

// ---------------------------------------------------------------- batched lookups (ip-api.com: 15 batches/min)

const pending = new Set();
let flushTimer = null;
let backoffUntil = 0;

function queueLookup(ip) {
  if (!ip || ipCache[ip] || localLabel(ip)) return;
  pending.add(ip);
  if (!flushTimer) flushTimer = setTimeout(flush, 600);
}

async function flush() {
  flushTimer = null;
  const wait = backoffUntil - Date.now();
  if (wait > 0) { flushTimer = setTimeout(flush, wait); return; }
  const batch = [...pending].slice(0, 100);
  if (!batch.length) return;
  batch.forEach(ip => pending.delete(ip));
  try {
    const r = await fetch(`http://ip-api.com/batch?fields=${FIELDS}`, { method: "POST", body: JSON.stringify(batch) });
    if (r.status === 429) throw Object.assign(new Error("rate limited"), { retry: 60e3 });
    const rows = await r.json();
    const now = Date.now();
    rows.forEach((row, i) => {
      ipCache[batch[i]] = { t: now, info: row.status === "success" ? normalize(row) : { ip: batch[i], kind: "unknown", label: row.message || "no data" } };
    });
    const left = r.headers.get("X-Rl"), ttl = r.headers.get("X-Ttl");
    if (left !== null && Number(left) === 0) backoffUntil = Date.now() + (Number(ttl) + 1) * 1000;
    saveCacheSoon();
    refreshBadges();
  } catch (e) {
    batch.forEach(ip => pending.add(ip));
    backoffUntil = Date.now() + (e.retry || 10e3);
  }
  if (pending.size) flushTimer = setTimeout(flush, 4100); // stay under 15 batches/minute
}

async function lookupSelf() {
  if (me && Date.now() - me.t < 600e3) return me.info;
  try {
    const r = await fetch(`http://ip-api.com/json/?fields=${FIELDS}`);
    me = { t: Date.now(), info: normalize(await r.json()) };
    return me.info;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- persistence (service workers get killed when idle)

let saveTabsTimer = null, saveCacheTimer = null;
function saveTabsSoon() {
  clearTimeout(saveTabsTimer);
  saveTabsTimer = setTimeout(() => chrome.storage.session.set({ tabsState: Object.fromEntries(tabs) }), 800);
}
function saveCacheSoon() {
  clearTimeout(saveCacheTimer);
  saveCacheTimer = setTimeout(() => {
    const entries = Object.entries(ipCache);
    if (entries.length > CACHE_MAX) {
      entries.sort((a, b) => b[1].t - a[1].t);
      ipCache = Object.fromEntries(entries.slice(0, CACHE_MAX));
    }
    chrome.storage.local.set({ ipCache });
  }, 2000);
}

// ---------------------------------------------------------------- badge

function place(i) { return [i.city, i.country].filter(Boolean).join(", "); }

async function updateBadge(tabId) {
  const s = tabs.get(tabId);
  if (!s?.mainIp) return;
  const i = info(s.mainIp);
  const text = !i ? "…" : i.kind === "local" ? "LAN" : (i.cc || "?");
  const who = i ? (i.label || i.isp || i.org) : "looking up…";
  try {
    await chrome.action.setBadgeText({ tabId, text });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLORS[i?.kind] || BADGE_COLORS.unknown });
    await chrome.action.setBadgeTextColor({ tabId, color: "#ffffff" });
    await chrome.action.setTitle({ tabId, title: `NetRoute — ${s.pageHost} is served by ${who}${i && place(i) ? ` (${place(i)})` : ""}` });
  } catch { /* tab closed */ }
}

function refreshBadges() { for (const id of tabs.keys()) updateBadge(id); }

// ---------------------------------------------------------------- request tracking

chrome.webRequest.onCompleted.addListener(async d => {
  if (d.tabId < 0 || !d.ip) return;
  let url;
  try { url = new URL(d.url); } catch { return; }
  if (!/^(https?|wss?):$/.test(url.protocol)) return;
  await ready;

  let s = tabs.get(d.tabId);
  if (d.type === "main_frame") {
    s = { pageUrl: d.url, pageHost: url.hostname, mainIp: d.ip, hosts: {}, since: Date.now() };
    tabs.set(d.tabId, s);
  } else if (!s) {
    // Page loaded before the extension was running; we only see its later requests.
    s = { pageUrl: null, pageHost: null, mainIp: null, hosts: {}, since: Date.now() };
    tabs.set(d.tabId, s);
  }
  const h = s.hosts[url.hostname];
  if (h) {
    h.ip = d.ip;
    h.count++;
    if (!h.types.includes(d.type)) h.types.push(d.type);
  } else if (Object.keys(s.hosts).length < HOSTS_PER_TAB) {
    s.hosts[url.hostname] = { ip: d.ip, count: 1, types: [d.type] };
  }
  queueLookup(d.ip);
  if (d.type === "main_frame") updateBadge(d.tabId);
  saveTabsSoon();
}, { urls: ["<all_urls>"] });

chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === "complete") ready.then(() => updateBadge(tabId));
});

chrome.tabs.onRemoved.addListener(tabId => {
  ready.then(() => { tabs.delete(tabId); saveTabsSoon(); });
});

// ---------------------------------------------------------------- popup API

chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    await ready;
    if (msg.type === "tab") {
      const s = tabs.get(msg.tabId);
      if (!s) return null;
      const ips = [s.mainIp, ...Object.values(s.hosts).map(h => h.ip)].filter(Boolean);
      ips.forEach(queueLookup);
      const infos = Object.fromEntries(ips.map(ip => [ip, info(ip)]));
      return { ...s, infos, pending: pending.size };
    }
    if (msg.type === "me") return lookupSelf();
    return null;
  })().then(reply, () => reply(null));
  return true; // async reply
});
