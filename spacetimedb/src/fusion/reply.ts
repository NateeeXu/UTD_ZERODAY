/**
 * A reply that only asks for a call-back: the parser was unsure and found no concrete need (a coverage
 * question, or a parser outage). Customer care follows up, but it says nothing about danger, so it must
 * not move the estimates or a cell's priority.
 */
export function isCallbackOnly(r: { safety: string; lifeSafety: boolean; needs: readonly string[] | string }): boolean {
  return r.safety === 'needs_help' && !r.lifeSafety && r.needs.length === 0;
}
