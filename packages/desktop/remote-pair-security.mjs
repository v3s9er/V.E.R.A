import { lookup as dnsLookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { BlockList, isIP } from 'node:net';

const blockedIpv4 = new BlockList();
const blockedIpv6 = new BlockList();
const tailscaleIpv6 = new BlockList();
tailscaleIpv6.addSubnet('fd7a:115c:a1e0::', 48, 'ipv6');
for (const [address, prefix] of [
  ['0.0.0.0', 8],
  ['10.0.0.0', 8],
  ['100.64.0.0', 10],
  ['127.0.0.0', 8],
  ['169.254.0.0', 16],
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24],
  ['192.88.99.0', 24],
  ['192.168.0.0', 16],
  ['198.18.0.0', 15],
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4],
  ['240.0.0.0', 4],
]) blockedIpv4.addSubnet(address, prefix, 'ipv4');

for (const [address, prefix] of [
  ['::', 8],
  ['64:ff9b:1::', 48],
  ['100::', 64],
  ['2001::', 23],
  ['2001:db8::', 32],
  ['2002::', 16],
  ['3fff::', 20],
  ['5f00::', 16],
  ['fc00::', 7],
  ['fe80::', 10],
  ['ff00::', 8],
]) blockedIpv6.addSubnet(address, prefix, 'ipv6');

function isCgnatV4(address) {
  const parts = String(address).split('.').map(Number);
  return parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

function isTailscaleServeHostname(hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, '');
  return host.endsWith('.ts.net') && host.length > '.ts.net'.length;
}

export function normalizeRemotePairOrigin(value) {
  const parsed = new URL(String(value ?? ''));
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password
    || !['', '/'].includes(parsed.pathname) || parsed.search || parsed.hash) {
    throw new Error('원격 PC 연결은 경로가 없는 HTTPS origin만 허용됩니다.');
  }
  if (Number(parsed.port || 443) !== 443) throw new Error('원격 PC 연결은 검증된 HTTPS 443 포트만 허용됩니다.');
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
  if (!hostname || hostname.length > 253 || hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local')) {
    throw new Error('원격 PC 호스트가 안전하지 않습니다.');
  }
  return `https://${hostname.includes(':') ? `[${hostname}]` : hostname}`;
}

export function isAllowedRemotePairAddress(address, hostname) {
  const family = isIP(address);
  if (!family) return false;
  if (isTailscaleServeHostname(hostname)) {
    return (family === 4 && isCgnatV4(address))
      || (family === 6 && tailscaleIpv6.check(address, 'ipv6'));
  }
  return family === 4
    ? !blockedIpv4.check(address, 'ipv4')
    : !blockedIpv6.check(address, 'ipv6');
}

export async function resolvePinnedRemotePairTarget(origin, lookup = dnsLookup) {
  const normalizedOrigin = normalizeRemotePairOrigin(origin);
  const parsed = new URL(normalizedOrigin);
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const answers = literalFamily
    ? [{ address: hostname, family: literalFamily }]
    : await lookup(hostname, { all: true, verbatim: true });
  if (!Array.isArray(answers) || answers.length === 0) throw new Error('원격 PC 호스트의 DNS 주소를 찾지 못했습니다.');
  const normalizedAnswers = answers.map((answer) => ({ address: String(answer.address), family: Number(answer.family) }));
  if (normalizedAnswers.some((answer) => !isAllowedRemotePairAddress(answer.address, hostname))) {
    throw new Error('원격 PC 호스트가 사설·로컬·예약 주소로 해석되어 연결을 차단했습니다.');
  }
  const selected = normalizedAnswers.find((answer) => answer.family === 4) ?? normalizedAnswers[0];
  return { origin: normalizedOrigin, hostname, address: selected.address, family: selected.family };
}

/**
 * POST a small JSON body while pinning the previously validated address.
 * A fresh, non-pooled TLS connection plus SNI/hostname verification prevents
 * a second DNS lookup (and therefore a DNS-rebinding hop) inside the request.
 */
export async function postPinnedRemotePairJson(origin, body, headers = {}, options = {}) {
  const timeoutMs = Math.max(1_000, Math.min(15_000, Number(options.timeoutMs) || 10_000));
  const maxResponseBytes = Math.max(1_024, Math.min(128 * 1024, Number(options.maxResponseBytes) || 64 * 1024));
  let dnsTimer;
  const target = await Promise.race([
    resolvePinnedRemotePairTarget(origin, options.lookup),
    new Promise((_, rejectPromise) => {
      dnsTimer = setTimeout(() => rejectPromise(new Error('원격 PC DNS 확인 시간이 초과되었습니다.')), Math.min(timeoutMs, 5_000));
    }),
  ]).finally(() => clearTimeout(dnsTimer));
  const payload = Buffer.from(JSON.stringify(body), 'utf8');
  if (payload.length > 16 * 1024) throw new Error('PC 연결 요청이 너무 큽니다.');
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let absoluteTimer;
    const settle = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(absoluteTimer);
      if (error) rejectPromise(error);
      else resolvePromise(value);
    };
    const request = (options.request ?? httpsRequest)({
      protocol: 'https:',
      hostname: target.hostname,
      port: 443,
      method: 'POST',
      path: '/api/pair',
      servername: isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: true,
      agent: false,
      family: target.family,
      lookup: (_hostname, _lookupOptions, callback) => callback(null, target.address, target.family),
      headers: {
        ...headers,
        accept: 'application/json',
        'content-type': 'application/json',
        'content-length': String(payload.length),
      },
    }, (response) => {
      const chunks = [];
      let received = 0;
      const advertised = Number(response.headers['content-length'] ?? 0);
      if (Number.isFinite(advertised) && advertised > maxResponseBytes) {
        response.destroy(new Error('PC 연결 응답이 너무 큽니다.'));
        return;
      }
      response.on('data', (chunk) => {
        received += chunk.length;
        if (received > maxResponseBytes) {
          response.destroy(new Error('PC 연결 응답이 너무 큽니다.'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.on('end', () => settle(null, {
        statusCode: Number(response.statusCode || 0),
        headers: response.headers,
        bodyText: Buffer.concat(chunks, received).toString('utf8'),
      }));
      response.on('error', (error) => settle(error));
    });
    absoluteTimer = setTimeout(() => request.destroy(new Error('PC 연결 시간이 초과되었습니다.')), timeoutMs);
    request.setTimeout(timeoutMs, () => request.destroy(new Error('PC 연결 시간이 초과되었습니다.')));
    request.on('error', (error) => settle(error));
    request.end(payload);
  });
}
