import { POLICY } from "../policy/config";

/**
 * Threshold the server actually applies for a trained router. The dev-chosen threshold (spec 6) is kept when it is
 * stricter than the policy floor; it never goes below POLICY.routerThreshold, because dev data contains no garbage
 * or off-topic input and a dev threshold of 0 would mean "never clarify". A threshold of 0.95 or more means no
 * threshold met the dev misroute target and the router would clarify almost everything, so the policy floor is used.
 */
export function deployedThreshold(devThreshold: number | undefined): number | undefined {
  if (devThreshold === undefined || !Number.isFinite(devThreshold)) return undefined;
  if (devThreshold >= 0.95) return POLICY.routerThreshold;
  return Math.max(devThreshold, POLICY.routerThreshold);
}
