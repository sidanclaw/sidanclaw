// Next.js Route Handler — GET /api/auth/local-session
//
// The OSS single-player front door. Calls the backend `/auth/local-session`
// (mounted only on a local, oss-edition API — see
// packages/api/src/routes/local-session.ts), installs the returned token pair
// as the standard auth cookies, and bounces to the app root as the local
// owner. From there the session is indistinguishable from a real login.
//
// This is NOT `dev-login`: that route signs you in as a throwaway "Local Dev"
// user for debugging the hosted edition locally. This one is the product — a
// neutral owner identity, no email surfaced.
//
// Triple-dead outside a local oss run: 404s when `NODE_ENV === "production"`,
// when `primaryAuthUrl()` resolves (a sub-app deploy where the primary owns
// auth), or when the build is not the oss edition. The backend route is itself
// gated on local + oss, so a token can never be minted in the cloud.
//
// Component-map tag: [COMP:app-web/local-session-route].

import { NextResponse } from "next/server";
import {
  accessTokenCookie,
  refreshTokenCookie,
  userCookie,
  appendLegacyHostOnlyClears,
} from "@/lib/auth-cookies";
import { primaryAuthUrl } from "@/lib/primary-auth";
import { isOssEdition } from "@/lib/edition";

// Same resolution as the app-web OAuth callback + refresh bridges:
// server-side `API_URL`, defaulting to the local dev API.
const API_URL = process.env.API_URL ?? "http://localhost:4000";

export async function GET(request: Request) {
  if (
    process.env.NODE_ENV === "production" ||
    primaryAuthUrl() !== null ||
    !isOssEdition()
  ) {
    return new NextResponse("Not found", { status: 404 });
  }

  try {
    const backendRes = await fetch(new URL(`${API_URL}/auth/local-session`), {
      method: "POST",
    });
    if (!backendRes.ok) {
      console.error("[/api/auth/local-session] backend rejected:", backendRes.status);
      return NextResponse.redirect(
        new URL("/login?error=local_session_failed", request.url),
      );
    }

    const data = (await backendRes.json()) as {
      accessToken: string;
      refreshToken: string;
      user: {
        id: string;
        email: string | null;
        name: string | null;
      };
    };

    // Land on the app root, which resolves into the single-workspace redirect
    // in src/app/page.tsx — the same destination the OAuth callback uses.
    const response = NextResponse.redirect(new URL("/", request.url));
    response.cookies.set(accessTokenCookie(data.accessToken));
    response.cookies.set(refreshTokenCookie(data.refreshToken));
    response.cookies.set(
      userCookie(
        JSON.stringify({
          id: data.user.id,
          name: data.user.name,
          email: data.user.email,
        }),
      ),
    );
    appendLegacyHostOnlyClears(response);

    return response;
  } catch (err) {
    console.error("[/api/auth/local-session] error:", err);
    return NextResponse.redirect(
      new URL("/login?error=local_session_failed", request.url),
    );
  }
}
