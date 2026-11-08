import type { CostlyOperation } from '../costly-api'
import type { GeminiJsonClient } from '../gemini/client'
import type { MapsClient } from '../maps'

export function meteredGemini(
  operation: CostlyOperation,
  client: GeminiJsonClient,
): GeminiJsonClient {
  return {
    generateJson: (request) =>
      operation.call('gemini', () => client.generateJson(request, operation.signal)),
  }
}

export function meteredMaps(operation: CostlyOperation, maps: MapsClient): MapsClient {
  return {
    searchPlaces: (options) =>
      operation.call('places', () => maps.searchPlaces(options, operation.signal)),
    computeRoute: (options) =>
      operation.call('routes', () => maps.computeRoute(options, operation.signal)),
  }
}
