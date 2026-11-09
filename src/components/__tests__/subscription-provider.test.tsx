import { describe, expect, test } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SubscriptionProvider, useSubscription } from "~/context/SubscriptionContext";
import { PremiumGate } from "../PremiumGate";

function Probe() {
  const s = useSubscription();
  return <span>{`premium=${s.isPremium} loading=${s.loading} flag=${s.proUiEnabled}`}</span>;
}

describe("SubscriptionProvider (real entitlements, hidden by default)", () => {
  test("server render: Pro hidden, flag off by default, gate renders nothing", () => {
    const html = renderToStaticMarkup(
      <SubscriptionProvider>
        <Probe />
        <PremiumGate><p>pro-only</p></PremiumGate>
      </SubscriptionProvider>,
    );
    expect(html).toBe("<span>premium=false loading=true flag=false</span>");
  });

  test("useSubscription outside the provider throws", () => {
    expect(() => renderToStaticMarkup(<Probe />)).toThrow(/SubscriptionProvider/);
  });
});
