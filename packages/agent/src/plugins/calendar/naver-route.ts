const MAPS_ORIGIN = 'https://maps.apigw.ntruss.com';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;

class NaverRequestError extends Error {
  constructor(message: string, readonly reason: 'request' | 'cancelled' = 'request') {
    super(message);
    this.name = 'NaverRequestError';
  }
}

export interface NaverMapCredentials {
  clientId: string;
  clientSecret: string;
}

export interface NaverRoutePreview {
  car: { distanceM: number; durationMin: number } | null;
  links: { publicTransit: string; walk: string; car: string };
  notice: string;
}

interface Coordinate { latitude: number; longitude: number; }

/**
 * Performs a one-shot Maps lookup. Callers must not persist coordinates or any
 * route result: NAVER's Maps terms allow the response only for the live view.
 */
export async function previewNaverRoute(input: {
  startAddress: string;
  destinationAddress: string;
  credentials: NaverMapCredentials;
  signal?: AbortSignal;
}): Promise<NaverRoutePreview> {
  const startAddress = boundedText(input.startAddress, '출발지 주소', 300);
  const destinationAddress = boundedText(input.destinationAddress, '목적지 주소', 300);
  const credentials = validateCredentials(input.credentials);
  const start = await geocode(startAddress, credentials, input.signal);
  const destination = await geocode(destinationAddress, credentials, input.signal);
  let car: NaverRoutePreview['car'] = null;
  let drivingUnavailable = false;
  try {
    car = await driving(start, destination, credentials, input.signal);
  } catch (error) {
    // Directions is a separately enabled NAVER Maps API. Once both addresses
    // have been geocoded, its absence must not hide the useful app links. An
    // explicit caller cancellation is different: continuing would make a
    // cancelled RPC appear successful, so it is always propagated.
    if (input.signal?.aborted) throw new NaverRequestError('지도 조회를 취소했습니다.', 'cancelled');
    if (error instanceof NaverRequestError && error.reason === 'cancelled') throw error;
    drivingUnavailable = true;
  }
  return {
    car,
    links: {
      publicTransit: nmapRoute('public', start, destination),
      walk: nmapRoute('walk', start, destination),
      car: nmapRoute('car', start, destination),
    },
    notice: drivingUnavailable
      ? '주소는 이 조회를 위해서만 NAVER Maps에 전송되며, 좌표·거리·시간은 저장하지 않습니다. 자동차 거리·시간은 확인할 수 없어 지도 앱에서 확인해 주세요.'
      : '주소는 이 조회를 위해서만 NAVER Maps에 전송되며, 좌표·거리·시간은 저장하지 않습니다.',
  };
}

async function geocode(address: string, credentials: NaverMapCredentials, signal?: AbortSignal): Promise<Coordinate> {
  const url = new URL('/map-geocode/v2/geocode', MAPS_ORIGIN);
  url.searchParams.set('query', address);
  const body = await requestJson(url, credentials, signal) as {
    status?: string;
    addresses?: Array<{ x?: string; y?: string }>;
  };
  const match = body.status === 'OK' ? body.addresses?.[0] : undefined;
  const longitude = Number(match?.x);
  const latitude = Number(match?.y);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
    throw new Error('주소를 찾지 못했습니다. 도로명 또는 지번 주소를 확인해 주세요.');
  }
  return { latitude, longitude };
}

async function driving(start: Coordinate, destination: Coordinate, credentials: NaverMapCredentials, signal?: AbortSignal): Promise<{ distanceM: number; durationMin: number }> {
  const url = new URL('/map-direction/v1/driving', MAPS_ORIGIN);
  url.searchParams.set('start', `${start.longitude},${start.latitude}`);
  url.searchParams.set('goal', `${destination.longitude},${destination.latitude}`);
  url.searchParams.set('option', 'trafast');
  const body = await requestJson(url, credentials, signal) as {
    code?: number;
    route?: { trafast?: Array<{ summary?: { distance?: number; duration?: number } }> };
  };
  const summary = body.code === 0 ? body.route?.trafast?.[0]?.summary : undefined;
  const distanceM = Number(summary?.distance);
  const durationMs = Number(summary?.duration);
  if (!Number.isFinite(distanceM) || distanceM < 0 || !Number.isFinite(durationMs) || durationMs < 0) {
    throw new Error('자동차 경로를 찾지 못했습니다. 출발지와 목적지를 확인해 주세요.');
  }
  return { distanceM: Math.round(distanceM), durationMin: Math.max(1, Math.round(durationMs / 60_000)) };
}

async function requestJson(url: URL, credentials: NaverMapCredentials, outerSignal?: AbortSignal): Promise<unknown> {
  if (url.origin !== MAPS_ORIGIN) throw new NaverRequestError('허용되지 않은 지도 API 주소입니다.');
  if (outerSignal?.aborted) throw new NaverRequestError('지도 조회를 취소했습니다.', 'cancelled');
  const controller = new AbortController();
  let responseTooLarge = false;
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abort = () => controller.abort();
  outerSignal?.addEventListener('abort', abort, { once: true });
  try {
    const response = await fetch(url, {
      method: 'GET',
      redirect: 'error',
      headers: {
        accept: 'application/json',
        'x-ncp-apigw-api-key-id': credentials.clientId,
        'x-ncp-apigw-api-key': credentials.clientSecret,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new NaverRequestError(response.status === 401 || response.status === 403
      ? 'NAVER Maps 인증 정보를 확인해 주세요.'
      : 'NAVER Maps가 요청을 처리하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    const length = Number(response.headers.get('content-length'));
    if (Number.isFinite(length) && length > MAX_RESPONSE_BYTES) {
      responseTooLarge = true;
      controller.abort();
      throw new NaverRequestError('지도 응답 크기가 제한을 넘었습니다.');
    }
    const text = await readBoundedResponseText(response, () => {
      responseTooLarge = true;
      controller.abort();
    });
    try { return JSON.parse(text); } catch { throw new NaverRequestError('NAVER Maps 응답 형식을 확인할 수 없습니다.'); }
  } catch (error) {
    if (responseTooLarge) throw new NaverRequestError('지도 응답 크기가 제한을 넘었습니다.');
    if (controller.signal.aborted) {
      if (outerSignal?.aborted) throw new NaverRequestError('지도 조회를 취소했습니다.', 'cancelled');
      throw new NaverRequestError('지도 조회 시간이 초과되었습니다.');
    }
    if (error instanceof NaverRequestError) throw error;
    // Undici/network errors may embed the requested URL. Geocoding URLs contain
    // a private address, so never pass an unreviewed transport message to RPC.
    throw new NaverRequestError('NAVER Maps에 안전하게 연결하지 못했습니다. 네트워크 상태를 확인해 주세요.');
  } finally {
    clearTimeout(timeout);
    outerSignal?.removeEventListener('abort', abort);
  }
}

async function readBoundedResponseText(response: Response, abort: () => void): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        abort();
        try { await reader.cancel(); } catch { /* best-effort upstream cancellation */ }
        throw new NaverRequestError('지도 응답 크기가 제한을 넘었습니다.');
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* already released or cancelled */ }
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString('utf8');
}

function nmapRoute(mode: 'public' | 'walk' | 'car', start: Coordinate, destination: Coordinate): string {
  const query = new URLSearchParams({
    slat: String(start.latitude), slng: String(start.longitude), sname: '출발지',
    dlat: String(destination.latitude), dlng: String(destination.longitude), dname: '목적지',
    appname: 'com.mrrobot.mobile',
  });
  return `nmap://route/${mode}?${query.toString()}`;
}

function validateCredentials(value: NaverMapCredentials): NaverMapCredentials {
  const clientId = boundedText(value.clientId, 'NAVER Maps Client ID', 200);
  const clientSecret = boundedText(value.clientSecret, 'NAVER Maps Client Secret', 500);
  if (/\s/.test(clientId) || /[\r\n]/.test(clientSecret)) throw new Error('NAVER Maps 인증 정보 형식이 올바르지 않습니다.');
  return { clientId, clientSecret };
}

function boundedText(value: string, label: string, maximum: number): string {
  const result = String(value ?? '').trim();
  if (!result || result.length > maximum || /[\u0000-\u001f\u007f]/.test(result)) throw new Error(`${label} 형식이 올바르지 않습니다.`);
  return result;
}
