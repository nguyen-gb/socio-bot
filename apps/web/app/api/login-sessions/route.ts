import { NextRequest, NextResponse } from 'next/server';
import { forwardAuthenticated } from '../../../lib/api-proxy';

export async function GET(request: NextRequest) {
  return forwardAuthenticated(request, '/api/login-sessions');
}

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => null)) as
    | { accountId?: string; ttlSeconds?: number }
    | null;
  if (!payload?.accountId) {
    return NextResponse.json({ message: 'accountId is required' }, { status: 400 });
  }

  return forwardAuthenticated(
    request,
    `/api/accounts/${encodeURIComponent(payload.accountId)}/login-sessions`,
    {
      method: 'POST',
      body: JSON.stringify({ ttlSeconds: payload.ttlSeconds ?? 600 }),
      headers: { 'content-type': 'application/json' },
    },
  );
}
