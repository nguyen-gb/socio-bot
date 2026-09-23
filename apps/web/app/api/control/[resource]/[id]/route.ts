import { NextRequest, NextResponse } from 'next/server';
import { forwardAuthenticated } from '../../../../../lib/api-proxy';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const RESOURCES = new Set(['accounts', 'proxies']);

async function forward(
  request: NextRequest,
  context: { params: Promise<{ resource: string; id: string }> },
  method: 'PATCH' | 'DELETE',
) {
  const { resource, id } = await context.params;
  if (!RESOURCES.has(resource) || !UUID.test(id)) {
    return NextResponse.json({ message: 'Resource not found' }, { status: 404 });
  }
  return forwardAuthenticated(request, `/api/${resource}/${id}`, {
    method,
    headers: method === 'PATCH' ? { 'content-type': 'application/json' } : undefined,
    body: method === 'PATCH' ? await request.text() : undefined,
  });
}

export const PATCH = (
  request: NextRequest,
  context: { params: Promise<{ resource: string; id: string }> },
) => forward(request, context, 'PATCH');

export const DELETE = (
  request: NextRequest,
  context: { params: Promise<{ resource: string; id: string }> },
) => forward(request, context, 'DELETE');
