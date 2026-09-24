import { NextRequest, NextResponse } from 'next/server';

export function proxy(request: NextRequest) {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
    const origin = request.headers.get('origin');
    if (!origin || origin !== publicRequestOrigin(request)) {
      return NextResponse.json({ message: 'Cross-site request rejected' }, { status: 403 });
    }
  }
  return NextResponse.next();
}

export const config = { matcher: '/api/:path*' };

function publicRequestOrigin(request: NextRequest): string {
  const protocol = firstForwardedValue(request.headers.get('x-forwarded-proto'));
  const host =
    firstForwardedValue(request.headers.get('x-forwarded-host')) ??
    request.headers.get('host');

  if ((protocol === 'http' || protocol === 'https') && host) {
    try {
      return new URL(`${protocol}://${host}`).origin;
    } catch {
      // Fall back to Next's normalized request URL for malformed proxy headers.
    }
  }
  return request.nextUrl.origin;
}

function firstForwardedValue(value: string | null): string | undefined {
  const first = value?.split(',', 1)[0]?.trim();
  return first || undefined;
}
