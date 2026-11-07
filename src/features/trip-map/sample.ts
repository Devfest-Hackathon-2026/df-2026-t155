import { sampleTrip } from '@/domain/samples'

import type { RouteMeta } from './model'

// 画面確認用のサンプル旅程（架空）。共通契約のサンプルを、そのまま使う。
// 種別・価格・移動区間は契約に無いため、ここで補う。数値はすべて架空で、実際の情報ではない。
export const sampleRouteTrip = sampleTrip

export const sampleRouteMeta: RouteMeta = {
  'stop-morning': { kind: 'sight' },
  'stop-lunch': {
    kind: 'meal',
    price: '1,500円前後（モック）',
    segmentFromPrevious: { status: 'known', minutes: 10, mode: 'walk' },
  },
  'stop-exhibition': {
    kind: 'reserved',
    segmentFromPrevious: { status: 'unknown', reason: '移動時間をまだ取得していません' },
  },
}
