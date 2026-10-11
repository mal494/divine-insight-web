import { HeadContent, Outlet, Scripts, createRootRoute } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { Analytics } from "~/components/analytics";
import { PremiumDevToggle } from "~/components/PremiumDevToggle";
import { SubscriptionProvider } from "~/context/SubscriptionContext";
import appCss from "~/styles/app.css?url";
import site from "../../site.json";

/**
 * The single canonical origin for og:url / og:image / canonical links.
 *
 * Resolution order:
 *   1. `SITE_URL` env var (set at deploy time — the real production domain).
 *   2. `VERCEL_PROJECT_PRODUCTION_URL` (Vercel injects this on its builds).
 *   3. A relative fallback so the tags are never invalid (crawlers that need an
 *      absolute URL will get whatever host serves the page).
 *
 * Never hardcode a sandbox/preview domain here — they rotate and go stale.
 */
const SITE_URL: string | undefined =
  process.env.SITE_URL ??
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : undefined);

const withOrigin = (path: string) =>
  SITE_URL ? new URL(path, ensureTrailingSlash(SITE_URL)).toString() : path;

const ensureTrailingSlash = (u: string) => (u.endsWith("/") ? u : `${u}/`);

const PAGE_URL = withOrigin("/");
const OG_IMAGE = withOrigin("/hero/hero-main.webp");

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1" },
      {
        title: "Divine Insight — A moment of clarity, drawn just for you",
      },
      {
        name: "description",
        content:
          "Divine Insight offers three-card tarot readings from the full 78-card deck — a moment of reflection and personal guidance, drawn just for you.",
      },
      { property: "og:title", content: "Divine Insight — A moment of clarity, drawn just for you" },
      {
        property: "og:description",
        content:
          "A three-card tarot reading from the full 78-card deck. Draw your cards — past, present, future — and receive a reading woven just for you.",
      },
      { property: "og:type", content: "website" },
      { property: "og:url", content: PAGE_URL },
      { property: "og:image", content: OG_IMAGE },
      { property: "og:image:width", content: "1536" },
      { property: "og:image:height", content: "1024" },
      { name: "twitter:card", content: "summary_large_image" },
      { property: "og:site_name", content: site.businessName },
      { property: "og:locale", content: "en_US" },
    ],
    links: [
      { rel: "canonical", href: PAGE_URL },
      { rel: "icon", type: "image/svg+xml", href: "/favicon.svg" },
      { rel: "stylesheet", href: appCss },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      {
        rel: "preconnect",
        href: "https://fonts.gstatic.com",
        crossOrigin: "anonymous",
      },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,400;1,500&display=swap",
      },
    ],
  }),
  notFoundComponent: () => <div>Page not found</div>,
  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <SubscriptionProvider>
        <Outlet />
        <PremiumDevToggle />
      </SubscriptionProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Analytics />
        <Scripts />
      </body>
    </html>
  );
}