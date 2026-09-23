import { NextRequest, NextResponse } from 'next/server';
import { callApi, setAuthCookies } from '../../../../lib/api-proxy';

export async function POST(request: NextRequest) {
  const body = await request.text();
  const upstream = await callApi('/api/auth/login', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
  });
  const payload = (await upstream.json().catch(() => ({}))) as Record<string, unknown> & {
    accessToken?: string;
    accessTokenExpiresAt?: string;
    refreshToken?: string;
    refreshTokenExpiresAt?: string;
  };
  if (!upstream.ok || !payload.accessToken || !payload.refreshToken || !payload.accessTokenExpiresAt || !payload.refreshTokenExpiresAt) {
    return NextResponse.json(payload, { status: upstream.status });
  }
  const { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, ...safePayload } = payload;
  const response = NextResponse.json(safePayload);
  setAuthCookies(response, { accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt });
  return response;
}
