import 'server-only'

type Diagnostic =
  | 'control_missing'
  | 'control_invalid'
  | 'period_mismatch'
  | 'reservation_deadline'
  | 'reservation_contention'
  | 'reservation_unknown'
  | 'store_unavailable'
  | 'write_revocation_unavailable'

const lastReported = new Map<Diagnostic, number>()

export function reportCostControlFailure(code: Diagnostic): void {
  const now = Date.now()
  const last = lastReported.get(code)
  if (last !== undefined && now - last < 60_000) return
  lastReported.set(code, now)
  console.warn('cost_control_failure', { code })
}
