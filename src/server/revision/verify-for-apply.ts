import 'server-only'

import { isDeepStrictEqual } from 'node:util'

import type { MapsClient } from '@/server/maps'
import { toStopDto } from '@/server/persistence/dto'
import { PersistenceError } from '@/server/persistence/errors'
import type { VerifyRevision } from '@/server/persistence/revision-apply'
import { hasTimeConflict } from '@/server/verification/travel'

import { checkRevisionConstraints } from './revise-trip'

export function createRevisionVerifier(maps: MapsClient): VerifyRevision {
  return async (trip, revision, travelModes, expectedEndpoints) => {
    const { before, after } = revision.diff
    if (hasTimeConflict(trip.stops)) {
      throw new PersistenceError('revision_not_applicable')
    }
    if (!after.placeId || after.placeId === before.placeId) {
      throw new PersistenceError('revision_place_mismatch')
    }

    const index = trip.stops.findIndex(({ id }) => id === revision.targetStopId)
    const previous = trip.stops[index - 1]
    const next = trip.stops[index + 1]
    let serviceFailed = false
    let placeMismatch = false
    // 共通判定はRoutesや隣接施設の取得失敗を未確認にまとめる。適用APIでは通信失敗を分けて返す。
    const observe = async <T>(call: () => Promise<T>): Promise<T> => {
      try {
        return await call()
      } catch (error) {
        serviceFailed = true
        throw error
      }
    }
    const result = await checkRevisionConstraints(trip, revision, {
      travelModes,
      expectedEndpoints,
      maps: {
        searchPlaces: (options) => observe(() => maps.searchPlaces(options)),
        computeRoute: async (options) => {
          const { originPlaceId, destinationPlaceId } = options
          const matchesPrevious =
            previous &&
            destinationPlaceId === after.placeId &&
            (previous.placeId === null || originPlaceId === previous.placeId)
          const matchesNext =
            next &&
            originPlaceId === after.placeId &&
            (next.placeId === null || destinationPlaceId === next.placeId)
          // 保存先と違う施設に対する移動時間では適用できない。該当するRoutes照会も行わない。
          if (originPlaceId === destinationPlaceId || (!matchesPrevious && !matchesNext)) {
            placeMismatch = true
            return { status: 'no_route' }
          }
          return observe(() => maps.computeRoute(options))
        },
      },
    })
    if (serviceFailed || result.status === 'external_service_error') {
      throw new PersistenceError('external_service_error')
    }
    if (result.status === 'endpoints_changed')
      throw new PersistenceError('revision_endpoints_changed')
    if (placeMismatch) throw new PersistenceError('revision_place_mismatch')
    if (result.status === 'not_possible' || result.constraintCheck.status === 'violated') {
      throw new PersistenceError('revision_not_applicable')
    }
    if (
      result.constraintCheck.status !== 'satisfied' ||
      result.after.evidence.length === 0 ||
      result.after.evidence.some(({ status }) => status !== 'consistent')
    ) {
      throw new PersistenceError('revision_unverified')
    }
    if (!isDeepStrictEqual(toStopDto(result.after), toStopDto(after))) {
      throw new PersistenceError('revision_place_mismatch')
    }
    return result.after
  }
}
