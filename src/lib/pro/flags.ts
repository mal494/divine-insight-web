/**
 * Pro UI visibility flag.
 *
 * Production hides Divine Insight Pro on purpose (owner decision). The Pro UI
 * (Journal tab, Pro-gated sections, any upgrade affordance) only renders when
 * BOTH are true:
 *   1. the client build was made with VITE_PRO_UI_ENABLED=true, and
 *   2. GET /api/pro/status says the signed-in user has Pro.
 *
 * Default: off. Unset, empty, or anything other than the exact string "true"
 * keeps Pro hidden and the status endpoint is never called. Vite inlines
 * VITE_* at build time, so turning it on requires a rebuild/redeploy.
 *
 * This flag is UI only. Server routes enforce Pro with requirePro()
 * regardless of the flag.
 */
export type FlagEnv = Record<string, string | boolean | undefined>;

export function isProUiEnabled(env: FlagEnv = import.meta.env as FlagEnv): boolean {
  return env.VITE_PRO_UI_ENABLED === "true";
}
