# netFlow — NetRoute

See every ISP, network (ASN) and datacenter your packets pass through, on a map, live.

- **Route tracer** — enter a domain or IP; each traceroute hop streams in with its ISP, ASN, datacenter/hosting flag, location and latency. Hops are grouped into the chain of networks your traffic crosses, and big latency jumps (long-haul / undersea links) are highlighted.
- **Live connections** — every app on your Mac with an open network connection, which company or datacenter it is talking to, top networks and top apps, with a one-click trace for any endpoint.

## Run

```bash
python3 netroute.py
```

Opens <http://127.0.0.1:8765>. Python 3 standard library only — nothing to install. Works on macOS (and Linux with `traceroute` and `lsof` installed).

Options (environment variables): `PORT=9000` to change the port, `NO_BROWSER=1` to not open a browser tab.

## How it works

| Piece | Source |
|---|---|
| Hops | system `traceroute -n` (IPv4), streamed to the page over Server-Sent Events |
| ISP / ASN / location / datacenter flag | [ip-api.com](https://ip-api.com) (free, no key; each hop IP is sent there) |
| Live connections | `lsof -nP -i` (your user's processes; run with `sudo` to see all) |
| Map | Leaflet + OpenStreetMap tiles |

## Caveats

- Routers that don't answer traceroute show as **No reply** — traffic still passes through them. After 5 silent hops in a row the trace stops and shows the destination's network instead of waiting.
- The ISP/ASN of each hop is reliable; the **city often isn't**, especially for backbone routers and anycast services (Cloudflare, Google DNS).
- "Datacenter" comes from ip-api's hosting flag, so some CDNs show up as ISP.
- ip-api's free tier allows ~45 single / 15 batch lookups per minute; results are cached per run.
