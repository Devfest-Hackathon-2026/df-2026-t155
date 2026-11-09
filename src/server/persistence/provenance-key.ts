import 'server-only'

import { timingSafeEqual } from 'node:crypto'

export function getProvenanceSigningKey() {
  const value = process.env.REVISION_PROPOSAL_SIGNING_KEY
  if (!value || !/^[A-Za-z0-9_-]{43}$/.test(value)) return
  const key = Buffer.from(value, 'base64url')
  if (key.toString('base64url') === value) return key
}

export function matchesMac(encoded: string, expected: Buffer) {
  const presented = Buffer.from(encoded, 'base64url')
  return (
    presented.length === expected.length &&
    presented.toString('base64url') === encoded &&
    timingSafeEqual(presented, expected)
  )
}
