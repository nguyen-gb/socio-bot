import { NextRequest, NextResponse } from 'next/server';
import { forwardAuthenticated } from '../../../../../lib/api-proxy';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ taskId: string; decision: string }> },
) {
  const { taskId, decision } = await context.params;
  if (decision !== 'approve' && decision !== 'reject') {
    return NextResponse.json({ message: 'Invalid decision' }, { status: 404 });
  }
  return forwardAuthenticated(
    request,
    `/api/tasks/${encodeURIComponent(taskId)}/${decision}`,
    { method: 'POST' },
  );
}
