export const ORIGIN = 'https://simplifica.madeira.gov.pt';
export const SERVICE = `${ORIGIN}/services/78-82-259`;
const CATALOG = '/api/infoProcess/259/resources';
const TIMEOUT_MS = 12000;
const validatedTimezones = new Set();

export class ProxyError extends Error {
  constructor(code, message, status = 502, retryAfter) {
    super(message);
    Object.assign(this, { code, status, retryAfter });
  }
}
const schema = message => { throw new ProxyError('UPSTREAM_SCHEMA_CHANGED', message); };

export function validateQuery(url) {
  if ([...url.searchParams.keys()].some(k => !['resourceId', 'date'].includes(k)) ||
      ['resourceId', 'date'].some(k => url.searchParams.getAll(k).length !== 1)) {
    throw new ProxyError('INVALID_QUERY', 'Supply exactly resourceId and date.', 400);
  }
  const resourceId = url.searchParams.get('resourceId');
  const date = url.searchParams.get('date');
  if (!/^[1-9]\d{0,8}$/.test(resourceId)) {
    throw new ProxyError('INVALID_RESOURCE_ID', 'resourceId must be a positive integer of at most 9 digits.', 400);
  }
  if (!/^20\d{2}-\d{2}-\d{2}$/.test(date) ||
      !Number.isFinite(Date.parse(`${date}T00:00:00Z`)) ||
      new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date) {
    throw new ProxyError('INVALID_DATE', 'date must be a real calendar date in YYYY-MM-DD format (2000–2099).', 400);
  }
  const [year, month, day] = date.split('-').map(Number);
  return { resourceId, date, year, month, day };
}

async function upstream(fetcher, path, init = {}) {
  let response;
  try {
    response = await fetcher(new URL(path, ORIGIN).href, {
      ...init, redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    const timeout = ['TimeoutError', 'AbortError'].includes(error.name);
    throw new ProxyError(timeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      timeout ? 'SIMplifica timed out.' : 'Could not reach SIMplifica.', timeout ? 504 : 502);
  }
  if (response.status === 429) {
    const raw = response.headers.get('retry-after');
    const seconds = /^\d+$/.test(raw || '') ? Number(raw) : Math.ceil((Date.parse(raw) - Date.now()) / 1000);
    throw new ProxyError('UPSTREAM_RATE_LIMITED', 'SIMplifica rate limited this request. Try again later.', 429,
      Number.isFinite(seconds) ? Math.max(1, Math.min(86400, seconds)) : 60);
  }
  if (response.status === 419) return response;
  if (!response.ok) throw new ProxyError('UPSTREAM_HTTP_ERROR', `SIMplifica returned HTTP ${response.status}.`);
  return response;
}

async function jsonBody(response) {
  let body;
  try { body = await response.json(); }
  catch { schema('SIMplifica returned invalid JSON.'); }
  if (body?.status === false) throw new ProxyError('UPSTREAM_REJECTED', 'SIMplifica rejected the availability query.');
  if (body?.status !== true || !Array.isArray(body.data)) schema('Expected status:true and a data array.');
  return body.data;
}

export async function getTrails(fetcher = fetch) {
  const data = await jsonBody(await upstream(fetcher, CATALOG, { headers: { Accept: 'application/json' } }));
  if (!data.length) schema('The trail catalog is unexpectedly empty.');
  const seen = new Set();
  return data.map(item => {
    if (!Number.isSafeInteger(item?.id) || item.id <= 0 || typeof item.name !== 'string' || !item.name.trim() || seen.has(item.id)) {
      schema('Invalid or duplicated trail catalog entry.');
    }
    seen.add(item.id);
    return { resourceId: String(item.id), name: item.name.trim() };
  });
}

async function newSession(fetcher) {
  const response = await upstream(fetcher, SERVICE);
  if (response.status === 419) throw new ProxyError('UPSTREAM_SESSION_FAILED', 'SIMplifica could not establish a session.');
  // Only anonymous cookie headers are needed. Release the unused HTML body.
  await response.body?.cancel();
  // getSetCookie is available in Workers and current Node. Never split on commas:
  // Set-Cookie expiry attributes contain commas.
  const values = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie() : response.headers.getAll?.('Set-Cookie');
  const jar = new Map();
  for (const value of values || []) {
    const pair = value.split(';', 1)[0];
    const i = pair.indexOf('=');
    if (i > 0) jar.set(pair.slice(0, i).trim(), pair.slice(i + 1));
  }
  if (!jar.get('XSRF-TOKEN') || !jar.get('laravel_session')) {
    throw new ProxyError('UPSTREAM_SESSION_FAILED', 'SIMplifica did not issue the required anonymous session cookies.');
  }
  let token;
  try { token = decodeURIComponent(jar.get('XSRF-TOKEN')); }
  catch { schema('SIMplifica issued an invalid XSRF cookie.'); }
  return {
    Accept: 'application/json', 'Content-Type': 'application/json',
    Origin: ORIGIN, Referer: SERVICE, 'X-Requested-With': 'XMLHttpRequest',
    Cookie: ['XSRF-TOKEN', 'laravel_session'].map(name => `${name}=${jar.get(name)}`).join('; '),
    'X-XSRF-TOKEN': token,
  };
}

export async function fetchIntervals(query, fetcher = fetch) {
  // A 419 gets exactly one retry, always using a fresh anonymous session.
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = await newSession(fetcher);
    const { resourceId, year, month, day } = query;
    const response = await upstream(fetcher, '/api/resources/intervals', {
      method: 'POST', headers, body: JSON.stringify({ resourceId, year, month, day }),
    });
    if (response.status === 419) continue;
    return jsonBody(response);
  }
  throw new ProxyError('UPSTREAM_SESSION_FAILED', 'SIMplifica rejected two fresh anonymous sessions.');
}

function timestamp(value) {
  if (typeof value?.date !== 'string' ||
      !/^20\d{2}-\d{2}-\d{2} (?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,6})?$/.test(value.date) ||
      typeof value.timezone !== 'string') schema('Invalid slot timestamp or missing timezone.');
  const date = value.date.slice(0, 10);
  if (!Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) schema('Invalid slot calendar date.');
  if (!validatedTimezones.has(value.timezone)) {
    try { new Intl.DateTimeFormat('en', { timeZone: value.timezone }); }
    catch { schema('Unrecognized upstream timezone.'); }
    validatedTimezones.add(value.timezone);
  }
  // Keep wall-clock time and its IANA zone together; never interpret it in the
  // server's timezone or append Z to a timezone-less timestamp.
  return { local: value.date, timezone: value.timezone };
}

export function normalizeSlots(data, date) {
  if (!Array.isArray(data)) schema('Expected an interval array.');
  const seen = new Set();
  return data.map(item => {
    if (typeof item?.slotTitle !== 'string') schema('A slot has no slotTitle.');
    const title = item.slotTitle.normalize('NFC').replace(/\u00a0/g, ' ');
    const matches = [...title.matchAll(/(?:^|[\s:•])((?:\d+)(?:[.,]\d+)?)\s*%\s*Não\s+residentes(?=\s|[•<]|$)/giu)];
    if (matches.length !== 1) schema('Expected exactly one Não residentes percentage in each slotTitle.');
    const nonResident = Number(matches[0][1].replace(',', '.'));
    if (!Number.isFinite(nonResident) || nonResident < 0 || nonResident > 100) schema('Non-resident percentage is outside 0–100.');
    const begin = timestamp(item.begin), end = timestamp(item.end);
    if (begin.local.slice(0, 10) !== date || end.local <= begin.local || begin.timezone !== end.timezone) {
      schema('Slot dates, ordering, or timezones changed.');
    }
    const key = `${begin.local}|${begin.timezone}`;
    if (seen.has(key)) schema('Duplicate slot start.');
    seen.add(key);
    return { time: begin.local.slice(11, 16), endTime: end.local.slice(11, 16), begin, end, nonResident };
  }).sort((a, b) => a.begin.local.localeCompare(b.begin.local));
}
