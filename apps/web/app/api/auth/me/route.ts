import { NextRequest } from 'next/server';
import { forwardAuthenticated } from '../../../../lib/api-proxy';

export async function GET(request: NextRequest) {
  return forwardAuthenticated(request, '/api/auth/me');
}
