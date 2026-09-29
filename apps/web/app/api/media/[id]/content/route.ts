import { NextRequest, NextResponse } from 'next/server';
import { forwardAuthenticated } from '../../../../../lib/api-proxy';

export async function GET(request: NextRequest, context: { params: Promise<{ id: string }> }) {
  const { id } = await context.params;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return NextResponse.json({ message: 'Invalid media ID' }, { status: 400 });
  return forwardAuthenticated(request, `/api/media/${id}/content`);
}
