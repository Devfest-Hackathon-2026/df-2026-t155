import { z } from 'zod'

export const demoAccessTicket = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
export const demoAccessExchangePath = '/api/access/exchange'
export const demoAccessTokenResponse = z.strictObject({
  customToken: z
    .string()
    .max(8192)
    .regex(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/),
})
