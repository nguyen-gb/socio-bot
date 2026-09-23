import { NextRequest } from 'next/server';
import { forwardAuthenticated } from '../../../lib/api-proxy';

export async function POST(request: NextRequest) {
  return forwardAuthenticated(request, '/api/tasks', {
    method: 'POST',
    body: await request.text(),
    headers: { 'content-type': 'application/json' },
  });
}
