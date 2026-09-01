const PATH_BY_MODE = Object.freeze({
  publicTransit: '/public',
  walk: '/walk',
  car: '/car',
});
const WEB_MODE_BY_MODE = Object.freeze({
  publicTransit: 'transit',
  walk: 'walk',
  car: 'car',
});
const QUERY_KEYS = Object.freeze(['slat', 'slng', 'sname', 'dlat', 'dlng', 'dname', 'appname']);
const QUERY_KEY_SET = new Set(QUERY_KEYS);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DECIMAL_COORDINATE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;
const NAVER_MAP_ORIGIN = 'https://map.naver.com';
const NAVER_MAP_ROUTE_PREFIX = '/p/directions/';
const WEB_MERCATOR_LIMIT = 20_037_508.342789244;
const WEB_MERCATOR_MAX_LATITUDE = 85.0511287798066;
const WEB_ROUTE_POINT_TYPE = 'SIMPLE_POI';
const GENERIC_START_NAME = '출발지';
const GENERIC_DESTINATION_NAME = '목적지';

/** Accept only links produced by the private calendar's NAVER route generator. */
export function trustedNmapRoute(value, mode) {
  const expectedPath = PATH_BY_MODE[mode];
  if (!expectedPath || typeof value !== 'string' || value.length === 0 || value.length > 2_048
    || CONTROL_CHARACTERS.test(value) || value.includes('#')
    || !value.startsWith(`nmap://route${expectedPath}?`)) return null;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'nmap:' || parsed.hostname !== 'route' || parsed.pathname !== expectedPath
      || parsed.username || parsed.password || parsed.port || parsed.hash || parsed.href.length > 2_048) return null;
    if (!hasExactQueryContract(parsed.searchParams)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/** Desktop's final navigation boundary accepts any one of the three reviewed modes. */
export function trustedNmapRouteForAnyMode(value) {
  for (const mode of Object.keys(PATH_BY_MODE)) {
    const trusted = trustedNmapRoute(value, mode);
    if (trusted) return trusted;
  }
  return null;
}

/**
 * Convert a reviewed nmap:// route to NAVER Map's HTTPS directions page.
 *
 * The web route receives only projected coordinates and fixed generic labels;
 * private workbook labels and addresses never enter the browser URL.
 */
export function naverMapHttpsFallbackFromNmap(value) {
  for (const mode of Object.keys(PATH_BY_MODE)) {
    const trusted = trustedNmapRoute(value, mode);
    if (!trusted) continue;

    const parsed = new URL(trusted);
    const start = webRoutePoint(parsed.searchParams.get('slat'), parsed.searchParams.get('slng'), GENERIC_START_NAME);
    const destination = webRoutePoint(parsed.searchParams.get('dlat'), parsed.searchParams.get('dlng'), GENERIC_DESTINATION_NAME);
    if (!start || !destination) return null;

    const candidate = `${NAVER_MAP_ORIGIN}${NAVER_MAP_ROUTE_PREFIX}${start}/${destination}/-/${WEB_MODE_BY_MODE[mode]}`;
    return trustedNaverMapHttpsRoute(candidate);
  }
  return null;
}

/** Accept only the HTTPS route shape produced above. */
export function trustedNaverMapHttpsRoute(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048
    || CONTROL_CHARACTERS.test(value) || value.includes('#')
    || !value.startsWith(`${NAVER_MAP_ORIGIN}${NAVER_MAP_ROUTE_PREFIX}`)) return null;

  try {
    const parsed = new URL(value);
    if (parsed.origin !== NAVER_MAP_ORIGIN || parsed.protocol !== 'https:' || parsed.hostname !== 'map.naver.com'
      || parsed.username || parsed.password || parsed.port || parsed.hash || parsed.search
      || parsed.href.length > 2_048) return null;

    const segments = parsed.pathname.split('/');
    if (segments.length !== 7 || segments[0] !== '' || segments[1] !== 'p' || segments[2] !== 'directions'
      || segments[5] !== '-' || !Object.values(WEB_MODE_BY_MODE).includes(segments[6])) return null;
    if (!validWebRoutePoint(segments[3], GENERIC_START_NAME)
      || !validWebRoutePoint(segments[4], GENERIC_DESTINATION_NAME)) return null;
    return parsed.href;
  } catch {
    return null;
  }
}

/**
 * Open the app URL first and safely fall back to NAVER's HTTPS map when the OS
 * has no nmap:// protocol handler. This function resolves false instead of
 * leaking either openExternal rejection as an unhandled promise.
 */
export async function openTrustedNmapRouteWithHttpsFallback(value, openExternal) {
  const trustedNmap = trustedNmapRouteForAnyMode(value);
  if (!trustedNmap || typeof openExternal !== 'function') return false;

  try {
    await openExternal(trustedNmap);
    return true;
  } catch {
    const fallback = naverMapHttpsFallbackFromNmap(trustedNmap);
    if (!fallback) return false;
    try {
      await openExternal(fallback);
      return true;
    } catch {
      return false;
    }
  }
}

function hasExactQueryContract(params) {
  const keys = [];
  params.forEach((_value, key) => keys.push(key));
  if (keys.length !== QUERY_KEYS.length || keys.some((key) => !QUERY_KEY_SET.has(key))) return false;
  if (QUERY_KEYS.some((key) => params.getAll(key).length !== 1)) return false;
  return validCoordinate(params.get('slat'), -90, 90)
    && validCoordinate(params.get('slng'), -180, 180)
    && validCoordinate(params.get('dlat'), -90, 90)
    && validCoordinate(params.get('dlng'), -180, 180)
    && validName(params.get('sname'), '출발지')
    && validName(params.get('dname'), '목적지')
    && params.get('appname') === 'com.mrrobot.mobile';
}

function validCoordinate(value, minimum, maximum) {
  if (value === null || !DECIMAL_COORDINATE.test(value) || CONTROL_CHARACTERS.test(value)) return false;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum;
}

function validName(value, expected) {
  return value !== null && value.length >= 1 && value.length <= 80
    && value.trim() === value && !CONTROL_CHARACTERS.test(value) && value === expected;
}

function webRoutePoint(latitudeValue, longitudeValue, name) {
  const latitude = Number(latitudeValue);
  const longitude = Number(longitudeValue);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)
    || latitude < -WEB_MERCATOR_MAX_LATITUDE || latitude > WEB_MERCATOR_MAX_LATITUDE
    || longitude < -180 || longitude > 180) return null;

  const x = longitude * WEB_MERCATOR_LIMIT / 180;
  const y = Math.log(Math.tan((90 + latitude) * Math.PI / 360)) * WEB_MERCATOR_LIMIT / Math.PI;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return `${formatProjectedCoordinate(x)},${formatProjectedCoordinate(y)},${encodeURIComponent(name)},,${WEB_ROUTE_POINT_TYPE}`;
}

function formatProjectedCoordinate(value) {
  const normalized = Math.abs(value) < 0.00000005 ? 0 : value;
  return normalized.toFixed(7).replace(/(?:\.0+|(?<=[0-9])0+)$/, '').replace(/\.$/, '');
}

function validWebRoutePoint(value, expectedName) {
  const parts = value.split(',');
  return parts.length === 5
    && validProjectedCoordinate(parts[0])
    && validProjectedCoordinate(parts[1])
    && parts[2] === encodeURIComponent(expectedName)
    && parts[3] === ''
    && parts[4] === WEB_ROUTE_POINT_TYPE;
}

function validProjectedCoordinate(value) {
  if (!DECIMAL_COORDINATE.test(value) || CONTROL_CHARACTERS.test(value)) return false;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= -WEB_MERCATOR_LIMIT && coordinate <= WEB_MERCATOR_LIMIT;
}
