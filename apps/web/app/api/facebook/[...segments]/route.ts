import { NextRequest, NextResponse } from 'next/server';
import { forwardAuthenticated } from '../../../../lib/api-proxy';

async function forward(request: NextRequest, context: { params: Promise<{ segments: string[] }> }) {
  const { segments } = await context.params;
  const path = segments.join('/');
  const allowed = request.method === 'GET'
    ? ['groups', 'campaigns'].includes(path)
    : /^(groups\/(sync|join|post)|campaigns\/[0-9a-f-]{36}\/(approve|cancel|pause|resume|retry))$/i.test(path);
  if (!allowed) return NextResponse.json({ message: 'Action not found' }, { status: 404 });
  return forwardAuthenticated(request, `/api/facebook/${path}`, {
    method: request.method,
    ...(request.method === 'POST' ? { headers: { 'content-type': 'application/json' }, body: await request.text() } : {}),
  });
}
export const GET = forward;
export const POST = forward;
