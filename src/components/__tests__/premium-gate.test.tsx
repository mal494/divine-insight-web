import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({ isPremium: false, loading: true }));

vi.mock("~/context/SubscriptionContext", () => ({
  useSubscription: () => ({
    ...state,
    proUiEnabled: false,
    refresh: async () => {},
    setIsPremium: () => {},
    togglePremium: () => {},
  }),
}));

import { PremiumGate, shouldRenderPremium } from "../PremiumGate";

const render = () => renderToStaticMarkup(<PremiumGate><p>pro-only</p></PremiumGate>);

describe("PremiumGate", () => {
  test("hidden while the status check is loading", () => {
    Object.assign(state, { isPremium: true, loading: true });
    expect(render()).toBe("");
  });

  test("hidden for a non-Pro visitor", () => {
    Object.assign(state, { isPremium: false, loading: false });
    expect(render()).toBe("");
  });

  test("renders for a Pro visitor once resolved", () => {
    Object.assign(state, { isPremium: true, loading: false });
    expect(render()).toBe("<p>pro-only</p>");
  });

  test("shouldRenderPremium truth table", () => {
    expect(shouldRenderPremium({ isPremium: false, loading: false })).toBe(false);
    expect(shouldRenderPremium({ isPremium: true, loading: true })).toBe(false);
    expect(shouldRenderPremium({ isPremium: false, loading: true })).toBe(false);
    expect(shouldRenderPremium({ isPremium: true, loading: false })).toBe(true);
  });
});
