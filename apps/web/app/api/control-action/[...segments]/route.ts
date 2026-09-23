import { NextRequest, NextResponse } from 'next/server';
import { forwardAuthenticated } from '../../../../lib/api-proxy';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function allowed(segments: string[], method: 'GET' | 'POST' | 'DELETE'): boolean {
  if (method === 'GET') {
    return segments.length === 3 &&
      ['accounts', 'proxies'].includes(segments[0] ?? '') &&
      UUID.test(segments[1] ?? '') &&
      segments[2] === 'credentials';
  }
  if (method === 'DELETE') {
    return segments.length === 2 && segments[0] === 'schedules' && UUID.test(segments[1] ?? '');
  }
  if (segments.length !== 3 || !UUID.test(segments[1] ?? '')) return false;
  if (segments[0] === 'proxies') return ['test', 'assign', 'release'].includes(segments[2] ?? '');
  if (segments[0] === 'schedules') return ['enable', 'disable', 'trigger'].includes(segments[2] ?? '');
  return false;
}

async function forward(
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
  method: 'GET' | 'POST' | 'DELETE',
) {
  const { segments } = await context.params;
  if (!allowed(segments, method)) {
    return NextResponse.json({ message: 'Action not found' }, { status: 404 });
  }
  return forwardAuthenticated(request, `/api/${segments.join('/')}`, {
    method,
    headers: method === 'GET' ? undefined : { 'content-type': 'application/json' },
    body: method === 'POST' ? await request.text() : undefined,
  });
}

export const POST = (
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
) => forward(request, context, 'POST');

export const DELETE = (
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
) => forward(request, context, 'DELETE');

export const GET = (
  request: NextRequest,
  context: { params: Promise<{ segments: string[] }> },
) => forward(request, context, 'GET');
