import 'server-only';
import { createHash } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

interface TokenPayload {
  accessToken: string;
  accessTokenExpiresAt: string;
  refreshToken: string;
  refreshTokenExpiresAt: string;
}

const refreshFlights = new Map<
  string,
  { promise: Promise<TokenPayload | undefined>; discardAt: number }
>();

export async function forwardAuthenticated(
  request: NextRequest,
  path: string,
  init: RequestInit = {},
): Promise<NextResponse> {
  const accessToken = request.cookies.get('socio_access')?.value;
  let response = await callApi(path, init, accessToken);
  let refreshed: TokenPayload | undefined;

  if (response.status === 401) {
    const refreshToken = request.cookies.get('socio_refresh')?.value;
    if (refreshToken) {
      refreshed = await refreshAccessToken(refreshToken);
      if (refreshed) {
        response = await callApi(path, init, refreshed.accessToken);
      }
    }
  }

  const outgoing = new NextResponse(await response.text(), {
    status: response.status,
    headers: {
      'content-type': response.headers.get('content-type') ?? 'application/json',
    },
  });
  if (refreshed) setAuthCookies(outgoing, refreshed);
  if (response.status === 401) clearAuthCookies(outgoing);
  return outgoing;
}

async function refreshAccessToken(refreshToken: string) {
  const key = createHash('sha256').update(refreshToken).digest('hex');
  const now = Date.now();
  for (const [candidate, flight] of refreshFlights) {
    if (flight.discardAt <= now) refreshFlights.delete(candidate);
  }
  const existing = refreshFlights.get(key);
  if (existing) return existing.promise;

  const promise = (async () => {
    const response = await callApi('/api/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      headers: { 'content-type': 'application/json' },
    });
    if (!response.ok) return undefined;
    return response.json() as Promise<TokenPayload>;
  })();
  refreshFlights.set(key, { promise, discardAt: now + 5_000 });
  return promise;
}

export async function callApi(
  path: string,
  init: RequestInit = {},
  accessToken?: string,
) {
  const apiUrl = process.env.API_INTERNAL_URL ?? 'http://localhost:3001';
  const headers = new Headers(init.headers);
  if (accessToken) headers.set('authorization', `Bearer ${accessToken}`);
  return fetch(`${apiUrl}${path}`, { ...init, headers, cache: 'no-store' });
}

export function setAuthCookies(response: NextResponse, tokens: TokenPayload) {
  const secure = process.env.NODE_ENV === 'production';
  response.cookies.set('socio_access', tokens.accessToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    expires: new Date(tokens.accessTokenExpiresAt),
  });
  response.cookies.set('socio_refresh', tokens.refreshToken, {
    httpOnly: true,
    secure,
    sameSite: 'strict',
    path: '/',
    expires: new Date(tokens.refreshTokenExpiresAt),
  });
}

export function clearAuthCookies(response: NextResponse) {
  response.cookies.set('socio_access', '', { httpOnly: true, maxAge: 0, path: '/' });
  response.cookies.set('socio_refresh', '', { httpOnly: true, maxAge: 0, path: '/' });
}
