import { NextRequest, NextResponse } from 'next/server';
import { forwardAuthenticated } from '../../../../../lib/api-proxy';

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ taskId: string; decision: string }> },
) {
  const { taskId, decision } = await context.params;
  if (!['approve', 'reject', 'retry', 'retry-action', 'cancel', 'pause', 'resume'].includes(decision)) {
    return NextResponse.json({ message: 'Invalid task operation' }, { status: 404 });
  }
  return forwardAuthenticated(
    request,
    `/api/tasks/${encodeURIComponent(taskId)}/${decision}`,
    { method: 'POST' },
  );
}
