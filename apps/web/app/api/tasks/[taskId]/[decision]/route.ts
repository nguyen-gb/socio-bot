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
  // Preserve the JSON confirmation for retry-action. The proxy may retry the
  // upstream request after refreshing auth, so read the body once and reuse it.
  const body = await request.text();
  return forwardAuthenticated(
    request,
    `/api/tasks/${encodeURIComponent(taskId)}/${decision}`,
    {
      method: 'POST',
      ...(body ? {
        body,
        headers: { 'content-type': request.headers.get('content-type') ?? 'application/json' },
      } : {}),
    },
  );
}
