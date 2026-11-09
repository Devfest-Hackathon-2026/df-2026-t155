import 'server-only'

import { z } from 'zod'

import { MapsCallError } from './errors'
import { postJson, type MapsTransportDeps } from './transport'

// Places API (New) の施設検索（searchText）のアダプター。
// 生のレスポンスは外へ出さず、共通の形に正規化して返す。名称の一致判定や営業時間の照合は、
// 呼び出し側（照合処理）の責務で、ここでは取得した事実を、そのまま・欠けは欠けとして返す。
//
// 保存・表示の条件（Google Maps Platform）：
// - 保存してよいのはPlace IDだけ。名称・住所・座標・営業時間などは、このアダプターの戻り値を
//   リクエストの処理中に使い、DBやキャッシュへ保存しない。
// - Places由来の情報をGoogleマップ以外の画面に表示するときは、Googleの帰属表示が必要。

export const PLACES_SEARCH_TEXT_URL = 'https://places.googleapis.com/v1/places:searchText'

// 請求は、複数のSKUのフィールドを指定した場合、最も高いSKUで決まる（公式のUsage and Billing）。
// Text Searchでの区分（公式のデータフィールド一覧、2026-11-07 確認）：
// id はEssentials（IDs Only）、displayName・businessStatus・formattedAddress・locationはPro。
// したがって、このFieldMaskの既定（営業時間なし）は、Text Search Proで課金される。
const BASE_FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.location',
  'places.businessStatus',
]
// regularOpeningHoursはEnterprise。要求するとリクエスト全体がEnterpriseになるため、営業時間が必要なときだけ要求する（既定は要求しない）。
const OPENING_HOURS_FIELD = 'places.regularOpeningHours.periods'

const TimeOfWeekSchema = z.object({
  day: z.int().min(0).max(6), // 0=日曜
  hour: z.int().min(0).max(23),
  minute: z.int().min(0).max(59).optional(),
})

const RawOpeningHoursSchema = z.object({
  periods: z
    .array(z.object({ open: TimeOfWeekSchema, close: TimeOfWeekSchema.optional() }))
    .optional(),
})

const RawPlaceSchema = z.object({
  id: z.string().min(1),
  displayName: z.object({ text: z.string() }).optional(),
  formattedAddress: z.string().optional(),
  // 範囲外の座標は、正常な結果として受け入れず、応答全体を不正（invalid_response）とする。
  location: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
    })
    .optional(),
  businessStatus: z.string().optional(),
  regularOpeningHours: z.unknown().optional(),
})

const RawResponseSchema = z.object({ places: z.array(RawPlaceSchema).optional() })

export type OpeningPeriod = {
  open: { day: number; hour: number; minute: number }
  // closeが無い期間は、24時間営業など。
  close?: { day: number; hour: number; minute: number }
}

// 営業時間の取得状態。「要求していない」「データが無い（欠落）」「取得できた」を区別する。
// 欠落（regularOpeningHoursまたはperiodsが無い）と、空配列（periods: []）は、意味が異なる。
// 空配列は欠落にせず、`available`の空の配列として保持する。その意味の解釈は照合側の責務で、
// アダプターは「営業している」とも「休み」とも解釈しない。欠落は照合側が「確認できない」にする。
export type OpeningHours =
  | { status: 'not_requested' }
  | { status: 'unavailable' }
  | { status: 'invalid' }
  | { status: 'available'; periods: OpeningPeriod[] }

export interface PlaceCandidate {
  placeId: string
  // Places由来の一時データ。照合に使い、Stop.nameへ転記しない。
  // 取得できなければ空文字。名称の一致判定の対象にならず、「確認できない」にすること。
  name: string
  address?: string
  location?: { latitude: number; longitude: number }
  businessStatus?: string
  openingHours: OpeningHours
}

// 候補なし（HTTP 200で空）と、呼び出しの失敗（MapsCallErrorを投げる）を区別する。
// 候補が複数ある場合（同名の施設など）は、そのまま全件返す。選別は照合側が行う。
export type PlaceSearchResult =
  { status: 'found'; candidates: PlaceCandidate[] } | { status: 'no_candidates' }

export interface SearchTextOptions {
  query: string
  languageCode?: string
  // 1〜5。費用と誤紐付けの両方を抑えるため、少なく保つ。
  maxResultCount?: number
  locationBias?: { latitude: number; longitude: number; radiusMeters: number }
  includeOpeningHours?: boolean
}

const OptionsSchema = z.object({
  query: z.string().trim().min(1).max(300),
  languageCode: z
    .string()
    .regex(/^[a-z]{2}(-[A-Z]{2})?$/)
    .default('ja'),
  maxResultCount: z.int().min(1).max(5).default(3),
  locationBias: z
    .object({
      latitude: z.number().min(-90).max(90),
      longitude: z.number().min(-180).max(180),
      radiusMeters: z.number().positive().max(50_000),
    })
    .optional(),
  includeOpeningHours: z.boolean().default(false),
})

export async function searchPlaces(
  deps: MapsTransportDeps,
  options: SearchTextOptions,
  signal?: AbortSignal,
): Promise<PlaceSearchResult> {
  const parsedOptions = OptionsSchema.safeParse(options)
  if (!parsedOptions.success) {
    // クエリ等の値は含めない。
    throw new MapsCallError('invalid_request', 'Places検索の指定が正しくありません')
  }
  const { query, languageCode, maxResultCount, locationBias, includeOpeningHours } =
    parsedOptions.data

  const json = await postJson(deps, {
    signal,
    url: PLACES_SEARCH_TEXT_URL,
    fieldMask: (includeOpeningHours
      ? [...BASE_FIELD_MASK, OPENING_HOURS_FIELD]
      : BASE_FIELD_MASK
    ).join(','),
    body: {
      textQuery: query,
      languageCode,
      maxResultCount,
      ...(locationBias && {
        locationBias: {
          circle: {
            center: { latitude: locationBias.latitude, longitude: locationBias.longitude },
            radius: locationBias.radiusMeters,
          },
        },
      }),
    },
  })

  const parsed = RawResponseSchema.safeParse(json)
  if (!parsed.success) {
    throw new MapsCallError('invalid_response', 'Placesの応答の形式が想定と異なります')
  }
  const places = parsed.data.places ?? []
  if (places.length === 0) return { status: 'no_candidates' }

  return {
    status: 'found',
    candidates: places.map((place): PlaceCandidate => {
      const hours = RawOpeningHoursSchema.safeParse(place.regularOpeningHours)
      const periods = hours.success ? hours.data.periods : undefined
      return {
        placeId: place.id,
        name: place.displayName?.text ?? '',
        address: place.formattedAddress,
        location: place.location,
        businessStatus: place.businessStatus,
        openingHours: !includeOpeningHours
          ? { status: 'not_requested' }
          : periods !== undefined
            ? {
                status: 'available',
                periods: periods.map((period) => ({
                  open: { ...period.open, minute: period.open.minute ?? 0 },
                  close: period.close && { ...period.close, minute: period.close.minute ?? 0 },
                })),
              }
            : place.regularOpeningHours === undefined || hours.success
              ? { status: 'unavailable' }
              : { status: 'invalid' },
      }
    }),
  }
}
