import { NextRequest, NextResponse } from 'next/server';
import { forwardAuthenticated } from '../../../../lib/api-proxy';

const ALLOWED_RESOURCES = new Set([
  'accounts',
  'tasks',
  'proxies',
  'audit',
  'schedules',
]);

export async function GET(
  request: NextRequest,
  context: { params: Promise<{ resource: string }> },
) {
  const { resource } = await context.params;
  if (!ALLOWED_RESOURCES.has(resource)) {
    return NextResponse.json({ message: 'Resource not found' }, { status: 404 });
  }

  return forwardAuthenticated(request, `/api/${resource}`);
}

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ resource: string }> },
) {
  const { resource } = await context.params;
  if (!ALLOWED_RESOURCES.has(resource)) {
    return NextResponse.json({ message: 'Resource not found' }, { status: 404 });
  }
  return forwardAuthenticated(request, `/api/${resource}`, {
    method: 'POST',
    headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
    body: await request.text(),
  });
}
