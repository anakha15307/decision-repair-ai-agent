import { NextResponse, type NextRequest } from "next/server";

// Exposes the current path to server components (used to return to the same page after switching role).
export function middleware(req: NextRequest) {
  const headers = new Headers(req.headers);
  headers.set("x-dr-path", req.nextUrl.pathname + req.nextUrl.search.replace(/([?&])(ok|err)=[^&]*/g, "$1").replace(/[?&]+$/, ""));
  return NextResponse.next({ request: { headers } });
}

export const config = { matcher: ["/((?!_next|api|favicon).*)"] };
