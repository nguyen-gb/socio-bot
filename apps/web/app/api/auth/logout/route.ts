import { NextRequest, NextResponse } from 'next/server';
import { callApi, clearAuthCookies } from '../../../../lib/api-proxy';

export async function POST(request: NextRequest) {
  const refreshToken = request.cookies.get('socio_refresh')?.value;
  if (refreshToken) {
    await callApi('/api/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
      headers: { 'content-type': 'application/json' },
    }).catch(() => undefined);
  }
  const response = NextResponse.json({ ok: true });
  clearAuthCookies(response);
  return response;
}
