import { NextRequest, NextResponse } from 'next/server';
import { forwardAuthenticated } from '../../../../lib/api-proxy';

type RouteContext = { params: Promise<{ sessionId: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  return forwardAuthenticated(
    request,
    `/api/login-sessions/${encodeURIComponent(sessionId)}`,
  );
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const { sessionId } = await context.params;
  return forwardAuthenticated(
    request,
    `/api/login-sessions/${encodeURIComponent(sessionId)}${request.nextUrl.searchParams.get('force') === 'true' ? '?force=true' : ''}`,
    { method: 'DELETE' },
  );
}
