import { describe, expect, test, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const state = vi.hoisted(() => ({ proUiEnabled: false }));
vi.mock("~/context/SubscriptionContext", () => ({
  useSubscription: () => ({ isPremium: true, loading: false, ...state, refresh: async () => {}, setIsPremium: () => {}, togglePremium: () => {} }),
}));

import { Journal } from "../Journal";

describe("Journal tab", () => {
  test("flag off (DEV preview only): sample entries, no live API UI", () => {
    state.proUiEnabled = false;
    const html = renderToStaticMarkup(<Journal />);
    expect(html).toContain('data-journal="sample"');
    expect(html).not.toContain('data-journal="live"');
  });
  test("flag on: live journal backed by /api/pro/journal", () => {
    state.proUiEnabled = true;
    const html = renderToStaticMarkup(<Journal />);
    expect(html).toContain('data-journal="live"');
    expect(html).toContain("Loading your journal");
    expect(html).not.toContain('data-journal="sample"');
  });
});
