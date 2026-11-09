/**
 * Paid checkout is paused by default (no live fulfilment in production yet).
 * Every paid entry point shows "Purchases are paused" instead of a buy button
 * unless VITE_PAID_CHECKOUT_ENABLED === "true". Tips are unaffected, and a
 * customer who already holds credits can still draw.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const ent = vi.hoisted(() => ({
  status: "locked" as string,
  startCheckout: vi.fn(async () => {}),
}));

vi.mock("~/lib/entitlement", () => ({
  useEntitlement: () => ({
    status: ent.status,
    credits: ent.status === "unlocked" ? 1 : 0,
    startCheckout: ent.startCheckout,
    recordReading: async () => {},
    busy: false,
  }),
}));

import { ExtendedReading } from "../extended-reading";
import { GiftReading } from "../gift-reading";
import { Pricing } from "../pricing";
import { SingleInsight } from "../single-insight";
import { TipJar } from "../tip-jar";
import { TIP_LINKS } from "~/lib/payments";
import { paidCheckoutEnabled, PURCHASES_PAUSED_COPY } from "~/lib/paid-checkout";

const PAID = [
  ["Pricing", Pricing, /Gift a reading · \$5\.00/],
  ["SingleInsight", SingleInsight, /Draw yours · \$2\.99/],
  ["GiftReading", GiftReading, /Send a reading · \$5\.00/],
  ["ExtendedReading", ExtendedReading, /Unlock · \$9\.99/],
] as const;

const pausedCount = (html: string) => html.split('data-testid="purchases-paused"').length - 1;

beforeEach(() => {
  ent.status = "locked";
});
afterEach(() => vi.unstubAllEnvs());

describe("paidCheckoutEnabled (build-time flag)", () => {
  test("off unless exactly 'true'", () => {
    for (const v of ["", "1", "TRUE", "yes", "false"]) {
      vi.stubEnv("VITE_PAID_CHECKOUT_ENABLED", v);
      expect(paidCheckoutEnabled()).toBe(false);
    }
    vi.stubEnv("VITE_PAID_CHECKOUT_ENABLED", "true");
    expect(paidCheckoutEnabled()).toBe(true);
  });
});

describe.each(PAID)("%s", (_name, Component, cta) => {
  test("paused by default: no buy button, shows the paused note", () => {
    const html = renderToStaticMarkup(<Component />);
    expect(html).not.toMatch(cta);
    expect(html).not.toContain("Opening Stripe");
    expect(html).not.toContain("buy.stripe.com");
    expect(pausedCount(html)).toBeGreaterThan(0);
    expect(html).toContain(PURCHASES_PAUSED_COPY);
  });

  test("VITE_PAID_CHECKOUT_ENABLED=true restores the buy button", () => {
    vi.stubEnv("VITE_PAID_CHECKOUT_ENABLED", "true");
    const html = renderToStaticMarkup(<Component />);
    expect(html).toMatch(cta);
    expect(pausedCount(html)).toBe(0);
  });
});

describe("pause does not take away what people already have", () => {
  test("Pricing shows one paused note per tier (4)", () => {
    expect(pausedCount(renderToStaticMarkup(<Pricing />))).toBe(4);
  });

  test("Extended Reading bundle link is hidden too", () => {
    expect(renderToStaticMarkup(<ExtendedReading />)).not.toMatch(/three Extended Readings for/);
  });

  test.each([
    ["SingleInsight", SingleInsight, /Draw your card/],
    ["ExtendedReading", ExtendedReading, /Draw/],
  ] as const)("%s: a customer with an unlocked order can still draw", (_n, Component, draw) => {
    ent.status = "unlocked";
    const html = renderToStaticMarkup(<Component />);
    expect(pausedCount(html)).toBe(0);
    expect(html).toMatch(draw);
  });

  test("TipJar is unaffected: all three tip links render while paused", () => {
    const html = renderToStaticMarkup(<TipJar />);
    for (const href of Object.values(TIP_LINKS)) expect(html).toContain(href);
    expect(pausedCount(html)).toBe(0);
  });
});
