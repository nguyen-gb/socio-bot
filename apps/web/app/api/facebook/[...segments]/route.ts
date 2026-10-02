import { NextRequest, NextResponse } from 'next/server';
import { forwardAuthenticated } from '../../../../lib/api-proxy';

async function forward(request: NextRequest, context: { params: Promise<{ segments: string[] }> }) {
  const { segments } = await context.params;
  const path = segments.join('/');
  const collectionPath = /^group-collections\/[0-9a-f-]{36}$/i.test(path);
  const recipientPath = /^opt-in-recipients\/[0-9a-f-]{36}$/i.test(path);
  const allowed = request.method === 'GET'
    ? ['groups', 'campaigns', 'group-collections', 'opt-in-recipients'].includes(path)
    : request.method === 'POST'
      ? ['group-collections', 'opt-in-recipients'].includes(path) || /^(groups\/(sync|join|post|message|comment-posts)|posts\/(scan-comments|reply-comments|message-reactors)|campaigns\/[0-9a-f-]{36}\/(approve|cancel|pause|resume|retry)|opt-in-recipients\/[0-9a-f-]{36}\/reactivate)$/i.test(path)
      : request.method === 'PATCH' ? collectionPath || recipientPath
        : request.method === 'DELETE' ? collectionPath || recipientPath : false;
  if (!allowed) return NextResponse.json({ message: 'Action not found' }, { status: 404 });
  return forwardAuthenticated(request, `/api/facebook/${path}`, {
    method: request.method,
    ...(['POST', 'PATCH'].includes(request.method) ? { headers: { 'content-type': 'application/json' }, body: await request.text() } : {}),
  });
}
export const GET = forward;
export const POST = forward;
export const PATCH = forward;
export const DELETE = forward;
