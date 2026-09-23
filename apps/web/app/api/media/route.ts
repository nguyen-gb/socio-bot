import { NextRequest } from 'next/server';
import { forwardAuthenticated } from '../../../lib/api-proxy';

export async function GET(request: NextRequest) {
  return forwardAuthenticated(request, '/api/media');
}

export async function POST(request: NextRequest) {
  const contentType = request.headers.get('content-type');
  return forwardAuthenticated(request, '/api/media', {
    method: 'POST',
    body: await request.arrayBuffer(),
    headers: contentType ? { 'content-type': contentType } : undefined,
  });
}
