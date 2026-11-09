/**
 * The three-card Past · Present · Future spread is free for everyone
 * (owner decision, Oct 16). In a production build with no Pro status it must
 * render, while Pro-only UI (Journal tab, dev toggle, upgrade) stays hidden.
 */
import type { ReactElement } from "react";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { prerender } from "react-dom/static";

vi.mock("~/components/auth-indicator", () => ({ AuthIndicator: () => null }));

let html = "";

beforeAll(async () => {
  vi.stubEnv("DEV", false);
  vi.stubEnv("PROD", true);
  vi.stubEnv("MODE", "production");
  vi.resetModules();
  const { SubscriptionProvider } = await import("~/context/SubscriptionContext");
  const { PremiumDevToggle } = await import("~/components/PremiumDevToggle");
  const { Route } = await import("~/routes/index");
  const Home = (Route.options as unknown as { component: () => ReactElement }).component;
  // prerender waits for any Suspense boundaries (lazy chunks) to resolve.
  const { prelude } = await prerender(
    <SubscriptionProvider>
      <Home />
      <PremiumDevToggle />
    </SubscriptionProvider>,
  );
  html = await new Response(prelude).text();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("three-card spread in production without Pro", () => {
  test("running as a production build", () => {
    expect(import.meta.env.DEV).toBe(false);
  });

  test("the #reading three-card section renders", () => {
    expect(html).toContain('id="reading"');
    expect(html).toContain("Past · Present · Future");
  });

  test("the hero draw control renders", () => {
    expect(html).toContain("Draw your cards");
    expect(html).toContain("What&#x27;s on your mind? (optional)");
  });

  test("free and paid links stay in the hero", () => {
    expect(html).toContain('href="#daily-card"');
    expect(html).toContain('href="#paid-readings"');
  });

  test("Pro UI stays hidden: no Journal tab, no dev toggle, no upgrade", () => {
    expect(html).not.toMatch(/>Journal</);
    expect(html).not.toContain("Pro: ");
    expect(html).not.toMatch(/upgrade|subscribe|\$5\s*\/\s*mo/i);
    expect(html).not.toMatch(/Celtic Cross|Vector score/);
  });
});
