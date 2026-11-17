import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { loadAuthConfig } from "@/modules/identity-access/domain/auth-config";
import {
  isSessionExpired,
  readSessionStartValue,
  SESSION_START_COOKIE,
} from "@/modules/identity-access/domain/session-policy";

// Runs before every page: refreshes the Supabase session cookies, sends signed-out visitors to the
// sign-in screen, and enforces the per-user-type absolute session lifetime (company phones: long,
// office users: short; both configurable). Authorisation proper is NOT decided here — that is
// has_permission()/RLS and the server guards in requireSession().

const PUBLIC_PATHS = new Set(["/sign-in", "/staff/sign-in"]);

export async function proxy(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return NextResponse.next({ request });

  let response = NextResponse.next({ request });
  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list)
          response.cookies.set(name, value, options);
      },
    },
  });

  const { data } = await supabase.auth.getUser();
  const path = request.nextUrl.pathname;

  const redirectTo = (target: string, clearSessionCookie = false) => {
    const res = NextResponse.redirect(new URL(target, request.url));
    // keep any refreshed/cleared auth cookies on the redirect
    for (const c of response.cookies.getAll()) res.cookies.set(c);
    if (clearSessionCookie) res.cookies.delete(SESSION_START_COOKIE);
    return res;
  };

  if (!data.user) {
    return PUBLIC_PATHS.has(path) ? response : redirectTo("/sign-in");
  }

  const secret = process.env.AUTH_SERVER_SECRET;
  const start = secret
    ? readSessionStartValue(
        secret,
        data.user.id,
        request.cookies.get(SESSION_START_COOKIE)?.value,
      )
    : null;
  if (!start || isSessionExpired(start, new Date(), loadAuthConfig().session)) {
    await supabase.auth.signOut();
    return redirectTo("/sign-in?reason=expired", true);
  }
  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)",
  ],
};
