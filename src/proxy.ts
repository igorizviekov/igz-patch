import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";

export function proxy(request: NextRequest) {
  const password = process.env.IGZPATCH_DASHBOARD_PASSWORD;
  if (!password) return new NextResponse("Dashboard authentication is not configured.", { status: 503 });

  const authorization = request.headers.get("authorization") ?? "";
  const expected = `Basic ${Buffer.from(`igzpatch:${password}`).toString("base64")}`;
  const providedBuffer = Buffer.from(authorization);
  const expectedBuffer = Buffer.from(expected);
  const authenticated = providedBuffer.length === expectedBuffer.length
    && timingSafeEqual(providedBuffer, expectedBuffer);
  if (!authenticated) {
    return new NextResponse("Authentication required.", {
      status: 401,
      headers: { "WWW-Authenticate": 'Basic realm="IgzPatch"' },
    });
  }
  return NextResponse.next();
}

export const config = { matcher: ["/"] };
