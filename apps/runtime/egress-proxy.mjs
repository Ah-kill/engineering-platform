// Outbound filter for a workspace container in "restricted" network mode.
//
// The workspace container sits on an internal Docker network with no route out; this
// proxy is its only exit. It allows HTTPS (CONNECT) and plain HTTP to listed hosts on
// ports 443/80 (or host:port entries), and refuses anything that resolves to a private,
// loopback or link-local address, so an allowed name cannot be pointed at the developer's
// machine or LAN.
//
// Config: ALLOW_HOSTS="api.example.com,*.example.org,db.example.net:8443"  PORT=3128
import http from 'node:http';
import net from 'node:net';
import dns from 'node:dns/promises';
import { pathToFileURL } from 'node:url';

/** Parses ALLOW_HOSTS into rules: { host, wildcard, port } (port null = 80/443). */
export function parseRules(spec) {
  return String(spec ?? '')
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((entry) => {
      const m = /^(\*\.)?([a-z0-9.-]+?)(?::(\d{1,5}))?$/.exec(entry);
      if (!m) return null;
      return { wildcard: !!m[1], host: m[2], port: m[3] ? Number(m[3]) : null };
    })
    .filter(Boolean);
}

export function isAllowed(host, port, rules) {
  const h = String(host).toLowerCase().replace(/\.$/, '');
  return rules.some((r) => {
    const hostOk = r.wildcard ? h.endsWith(`.${r.host}`) : h === r.host;
    const portOk = r.port === null ? port === 443 || port === 80 : port === r.port;
    return hostOk && portOk;
  });
}

export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v6 = ip.toLowerCase();
  if (v6.startsWith('::ffff:')) return isPrivateAddress(v6.slice(7));
  return v6 === '::1' || v6 === '::' || v6.startsWith('fc') || v6.startsWith('fd') || v6.startsWith('fe8') ||
    v6.startsWith('fe9') || v6.startsWith('fea') || v6.startsWith('feb') || v6.startsWith('ff');
}

/** Resolves and checks the target; returns an address to connect to, or a reason to refuse. */
export async function resolveTarget(host, port, rules, lookup = dns.lookup) {
  if (!isAllowed(host, port, rules)) return { error: `${host}:${port} is not in this application's allowed hosts` };
  if (net.isIP(host)) return { error: 'IP addresses must be allowed by name' };
  const addrs = await lookup(host, { all: true }).catch(() => []);
  const pick = addrs.find((a) => !isPrivateAddress(a.address));
  if (!addrs.length) return { error: `${host} does not resolve` };
  if (!pick) return { error: `${host} resolves to a private address` };
  return { address: pick.address };
}

function log(msg) {
  process.stdout.write(`${new Date().toISOString()} ${msg}\n`);
}

export function startProxy({ port = 3128, rules }) {
  const server = http.createServer(async (req, res) => {
    req.on('error', () => res.destroy());
    res.on('error', () => undefined);
    // Plain HTTP via absolute-form URL.
    let url;
    try {
      url = new URL(req.url);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }
    const targetPort = Number(url.port || 80);
    const target = await resolveTarget(url.hostname, targetPort, rules);
    if (target.error) {
      log(`blocked ${url.hostname}:${targetPort} (${target.error})`);
      res.writeHead(403, { 'content-type': 'text/plain' }).end(`Blocked by workspace network policy: ${target.error}\n`);
      return;
    }
    const upstream = http.request(
      { host: target.address, port: targetPort, method: req.method, path: url.pathname + url.search, headers: { ...req.headers, host: url.host } },
      (up) => {
        res.writeHead(up.statusCode ?? 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', () => res.writeHead(502).end());
    req.pipe(upstream);
  });

  server.on('connect', async (req, client, head) => {
    // A refused or dropped client must never take the proxy down.
    client.on('error', () => client.destroy());
    const [host, portStr] = String(req.url).split(':');
    const targetPort = Number(portStr || 443);
    const target = await resolveTarget(host, targetPort, rules);
    if (target.error) {
      log(`blocked ${host}:${targetPort} (${target.error})`);
      client.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nBlocked by workspace network policy: ${target.error}\n`);
      return;
    }
    const upstream = net.connect(targetPort, target.address, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) upstream.write(head);
      upstream.pipe(client);
      client.pipe(upstream);
    });
    upstream.on('error', () => client.destroy());
    client.on('error', () => upstream.destroy());
  });

  server.on('clientError', (_err, socket) => socket.destroy());
  process.on('uncaughtException', (err) => log(`error ${err?.message ?? err}`));

  server.listen(port, '0.0.0.0', () => log(`egress proxy on ${port}; allowed: ${rules.map((r) => `${r.wildcard ? '*.' : ''}${r.host}${r.port ? `:${r.port}` : ''}`).join(', ')}`));
  return server;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startProxy({ port: Number(process.env.PORT ?? 3128), rules: parseRules(process.env.ALLOW_HOSTS) });
}
