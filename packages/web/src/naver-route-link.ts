export type NmapRouteMode = 'publicTransit' | 'walk' | 'car';

const PATH_BY_MODE: Record<NmapRouteMode, string> = {
  publicTransit: '/public',
  walk: '/walk',
  car: '/car',
};
const QUERY_KEYS = ['slat', 'slng', 'sname', 'dlat', 'dlng', 'dname', 'appname'] as const;
const QUERY_KEY_SET = new Set<string>(QUERY_KEYS);
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
const DECIMAL_COORDINATE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

/** Accept only links produced by the private calendar's NAVER route generator. */
export function trustedNmapRoute(value: unknown, mode: NmapRouteMode): string | null {
  const expectedPath = PATH_BY_MODE[mode];
  if (typeof value !== 'string' || value.length === 0 || value.length > 2_048
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

function hasExactQueryContract(params: URLSearchParams): boolean {
  const keys: string[] = [];
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

function validCoordinate(value: string | null, minimum: number, maximum: number): boolean {
  if (value === null || !DECIMAL_COORDINATE.test(value) || CONTROL_CHARACTERS.test(value)) return false;
  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= minimum && coordinate <= maximum;
}

function validName(value: string | null, expected: string): boolean {
  return value !== null && value.length >= 1 && value.length <= 80
    && value.trim() === value && !CONTROL_CHARACTERS.test(value) && value === expected;
}
