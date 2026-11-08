import { describe, expect, it } from 'vitest'

import type { Evidence, Stop, Trip } from '@/domain'

import {
  generated,
  generated4,
  hoursEvidence,
  identityEvidence,
  revisedStop,
  serverVerified,
  travelEvidence,
  userReport,
} from './test-fixtures'
import { withdrawStaleVerification } from './withdraw-verification'

// 4件の旅程（朝・昼食・散策・喫茶店）を照合した結果。各予定に、施設・営業時間・前の予定からの移動の根拠が付く。
const verified4: Trip = serverVerified(generated4)

const ids = (stop: Stop) => stop.evidence.map((item) => item.id)
const stopOf = (trip: Trip, id: string) => trip.stops.find((stop) => stop.id === id)!
const edit = (trip: Trip, id: string, change: Partial<Stop>): Trip => ({
  ...trip,
  version: trip.version + 1,
  stops: trip.stops.map((stop) => (stop.id === id ? { ...stop, ...change } : stop)),
})

describe('withdrawStaleVerification: 予定の内容が変わったとき', () => {
  it('名称を変えた予定は、施設・営業時間・前からの移動の根拠とPlace IDを取り下げる。名称・時刻・固定は変えない', () => {
    const changed = edit(verified4, 'stop-lunch', { name: '別の昼食店' })

    const { trip, withdrawn } = withdrawStaleVerification(verified4, changed)

    expect(withdrawn).toBe(true)
    const lunch = stopOf(trip, 'stop-lunch')
    expect(lunch.evidence).toEqual([])
    expect(lunch.placeId).toBeNull()
    expect(lunch.name).toBe('別の昼食店')
    expect(trip.version).toBe(changed.version)
    expect(trip.stops.map((stop) => [stop.id, stop.isFixed])).toEqual(
      changed.stops.map((stop) => [stop.id, stop.isFixed]),
    )
  })

  it('隣の予定の根拠は、その予定自身と、変わっていない側の区間の分だけ残す', () => {
    const changed = edit(verified4, 'stop-lunch', { name: '別の昼食店' })

    const { trip } = withdrawStaleVerification(verified4, changed)

    // 散策：昼食（前の予定）が変わったので、前からの移動の根拠は取り下げる。施設・営業時間は残る。
    expect(ids(stopOf(trip, 'stop-walk'))).toEqual([
      'evidence-stop-walk-place',
      'evidence-stop-walk-hours',
    ])
    expect(stopOf(trip, 'stop-walk').placeId).toBe('place-stop-walk')
    // 朝：昼食の「前」にあるだけ。移動の根拠（朝は最初の予定で、前からの移動は無い）も含めて、そのまま。
    expect(stopOf(trip, 'stop-morning').evidence).toEqual(
      stopOf(verified4, 'stop-morning').evidence,
    )
    // 喫茶店：前の予定（散策）は変わっていないので、前からの移動の根拠も残る。
    expect(stopOf(trip, 'stop-cafe').evidence).toEqual(stopOf(verified4, 'stop-cafe').evidence)
  })

  it.each([
    ['開始時刻', { plannedStartTime: '12:15' }],
    ['滞在時間', { durationMinutes: 90 }],
    ['種別', { kind: 'meal' as const }],
  ])('%sを変えた予定の根拠は取り下げる（照合した時の内容と違うため）', (_label, change) => {
    const { trip } = withdrawStaleVerification(verified4, edit(verified4, 'stop-lunch', change))

    expect(stopOf(trip, 'stop-lunch').evidence).toEqual([])
    expect(stopOf(trip, 'stop-lunch').placeId).toBeNull()
    expect(ids(stopOf(trip, 'stop-walk'))).not.toContain('evidence-stop-walk-travel')
  })

  it('固定・版だけが変わったときは、何も取り下げない（同じ旅程を返す）', () => {
    const changed = edit(verified4, 'stop-lunch', { isFixed: true })

    const result = withdrawStaleVerification(verified4, changed)

    expect(result.withdrawn).toBe(false)
    expect(result.trip).toBe(changed)
  })

  it('日付・地域・タイムゾーンが変わったときは、照合由来の根拠をすべて取り下げる', () => {
    for (const change of [{ date: '2026-11-09' }, { region: '大阪' }, { timeZone: 'UTC' }]) {
      const { trip } = withdrawStaleVerification(verified4, { ...verified4, ...change })
      expect(trip.stops.every((stop) => stop.evidence.length === 0 && stop.placeId === null)).toBe(
        true,
      )
    }
  })

  it('予定の並びが入れ替わったときは、前後の関係が変わるので、移動の根拠を取り下げる', () => {
    const swapped: Trip = {
      ...verified4,
      stops: [verified4.stops[0], verified4.stops[2], verified4.stops[1], verified4.stops[3]],
    }

    const { trip } = withdrawStaleVerification(verified4, swapped)

    for (const stop of trip.stops) {
      expect(ids(stop).filter((id) => id.endsWith('-travel'))).toEqual([])
      // 自身の内容は同じなので、施設・営業時間は残る。
      expect(ids(stop)).toContain(`evidence-${stop.id}-place`)
    }
  })

  it('予定が挿入されたときは、その次の予定の前からの移動の根拠を取り下げる', () => {
    const inserted: Trip = {
      ...verified4,
      stops: [
        verified4.stops[0],
        { ...generated4.stops[2], id: 'stop-new', name: '新しい予定', placeId: null, evidence: [] },
        ...verified4.stops.slice(1),
      ],
    }

    const { trip } = withdrawStaleVerification(verified4, inserted)

    expect(ids(stopOf(trip, 'stop-lunch'))).not.toContain('evidence-stop-lunch-travel')
    expect(ids(stopOf(trip, 'stop-lunch'))).toContain('evidence-stop-lunch-place')
  })
})

describe('withdrawStaleVerification: 変更前の「照合前の状態」へは戻さない', () => {
  it('変更前のPlace IDと「整合」を、変更後に復活させない（再照合で同定できなかった結果を保つ）', () => {
    // 部分修正で得た候補の根拠（整合・Place IDあり）→ 再照合で同定不可（Place IDなし）。
    const afterRevision = revisedStop(
      verified4,
      'stop-lunch',
      '昼食店B',
      '2026-11-08T11:00:00+09:00',
    )
    const reverified = serverVerified(afterRevision, { unidentified: ['stop-lunch'] })

    // 別の予定を変えた。
    const { trip } = withdrawStaleVerification(
      reverified,
      edit(reverified, 'stop-morning', { name: '別の朝' }),
    )

    const lunch = stopOf(trip, 'stop-lunch')
    expect(lunch.placeId).toBeNull()
    expect(lunch.evidence.map((item) => item.status)).toEqual(['unverifiable', 'unverifiable'])
    expect(lunch.evidence.every((item) => item.status !== 'consistent')).toBe(true)
  })

  it.each([
    ['別のPlace IDに変わった場合', 'place-new-id'],
    ['Place IDがnullになった場合', null],
  ] as const)('%sは、以前の施設・営業時間根拠を取り下げる', (_label, placeId) => {
    const before = verified4
    const after = edit(before, 'stop-lunch', { placeId })

    const { trip } = withdrawStaleVerification(before, after)

    const lunch = stopOf(trip, 'stop-lunch')
    expect(lunch.placeId).toBe(placeId)
    expect(lunch.evidence).toEqual([])
  })

  it('Place ID変更後に新しく取得した施設・営業時間根拠と本人報告は残す', () => {
    const before = verified4
    const lunch = stopOf(before, 'stop-lunch')
    const checkedAt = '2026-11-08T10:05:00+09:00'
    const newIdentity = identityEvidence(lunch, 'consistent', checkedAt)
    const newHours = hoursEvidence(lunch, 'consistent', checkedAt)
    const report = userReport()
    const after = edit(before, 'stop-lunch', {
      placeId: 'place-new-id',
      evidence: [...lunch.evidence, newIdentity, newHours, report],
    })

    const { trip } = withdrawStaleVerification(before, after)

    const updated = stopOf(trip, 'stop-lunch')
    expect(updated.placeId).toBe('place-new-id')
    expect(updated.evidence).toEqual([newIdentity, newHours, report])
  })

  it('Place IDが変わった予定との間の移動の根拠は、取り下げる（Routesは両端のPlace IDで測っているため）', () => {
    const after = edit(verified4, 'stop-lunch', { placeId: 'place-new-id' })

    const { trip } = withdrawStaleVerification(verified4, after)

    // 昼食自身の前からの移動、散策の前（昼食から）からの移動は、端のPlace IDが変わったので取り下げ。
    expect(ids(stopOf(trip, 'stop-lunch'))).not.toContain('evidence-stop-lunch-travel')
    expect(ids(stopOf(trip, 'stop-walk'))).not.toContain('evidence-stop-walk-travel')
    // 昼食自身の施設・営業時間も、Place IDの対象が変わったので取り下げる。
    expect(ids(stopOf(trip, 'stop-lunch'))).not.toContain('evidence-stop-lunch-place')
    expect(ids(stopOf(trip, 'stop-lunch'))).not.toContain('evidence-stop-lunch-hours')
  })

  it('根拠の配列が一部だけ増減しても、有効性は内容で決める（配列の一致・不一致に頼らない）', () => {
    const lunch = stopOf(verified4, 'stop-lunch')
    // 名称を変え、根拠を1件足した（本人の報告）。
    const added = edit(verified4, 'stop-lunch', {
      name: '別の昼食店',
      evidence: [...lunch.evidence, userReport()],
    })
    // 名称を変え、根拠を1件消した。
    const removed = edit(verified4, 'stop-lunch', {
      name: '別の昼食店',
      evidence: lunch.evidence.filter((item) => !item.id.endsWith('-hours')),
    })
    // 名称は同じで、根拠を1件消した（残りは有効なまま残る）。
    const removedOnly = edit(verified4, 'stop-lunch', {
      evidence: lunch.evidence.filter((item) => !item.id.endsWith('-hours')),
    })

    expect(ids(stopOf(withdrawStaleVerification(verified4, added).trip, 'stop-lunch'))).toEqual([
      'evidence-user-report',
    ])
    expect(ids(stopOf(withdrawStaleVerification(verified4, removed).trip, 'stop-lunch'))).toEqual(
      [],
    )
    expect(
      ids(stopOf(withdrawStaleVerification(verified4, removedOnly).trip, 'stop-lunch')),
    ).toEqual(['evidence-stop-lunch-place', 'evidence-stop-lunch-travel'])
  })
})

describe('withdrawStaleVerification: 照合由来でない根拠と、新しく付いた根拠', () => {
  const official: Evidence = {
    ...userReport('evidence-official'),
    source: { kind: 'official', label: '公式サイト' },
  }
  const simulation: Evidence = {
    ...userReport('evidence-sim'),
    source: { kind: 'simulation', label: '模擬データ' },
  }

  it('本人の報告・公式情報・模擬データの根拠は、予定が変わっても残す', () => {
    const own = edit(verified4, 'stop-lunch', {
      evidence: [...stopOf(verified4, 'stop-lunch').evidence, userReport(), official, simulation],
    })
    const renamed = edit(own, 'stop-lunch', { name: '別の昼食店' })

    const { trip } = withdrawStaleVerification(own, renamed)

    expect(ids(stopOf(trip, 'stop-lunch'))).toEqual([
      'evidence-user-report',
      'evidence-official',
      'evidence-sim',
    ])
  })

  it('部分修正で新しく付いた候補の根拠は、取り下げない。引き継がれた周囲の古い根拠は、取り下げる', () => {
    const after = revisedStop(verified4, 'stop-lunch', '昼食店B', '2026-11-08T11:00:00+09:00')

    const { trip, withdrawn } = withdrawStaleVerification(verified4, after)

    expect(withdrawn).toBe(true)
    const lunch = stopOf(trip, 'stop-lunch')
    expect(ids(lunch)).toEqual([
      'evidence-stop-lunch-place',
      'evidence-stop-lunch-hours',
      'evidence-stop-lunch-travel',
      'evidence-stop-lunch-travel-next',
    ])
    expect(lunch.placeId).toBe('place-stop-lunch-昼食店B')
    // 散策：昼食（前の予定）が差し替わったので、前からの移動の根拠は、古い（差し替え前の）ものを取り下げる。
    expect(ids(stopOf(trip, 'stop-walk'))).not.toContain('evidence-stop-walk-travel')
    expect(ids(stopOf(trip, 'stop-walk'))).toContain('evidence-stop-walk-place')
  })

  it('隣接する2件を続けて差し替えると、1件目の「次の予定への移動」の根拠は取り下げる（方向と両端を見る）', () => {
    const first = revisedStop(verified4, 'stop-lunch', '昼食店B', '2026-11-08T11:00:00+09:00')
    const afterFirst = withdrawStaleVerification(verified4, first).trip
    const second = revisedStop(afterFirst, 'stop-walk', '散策B', '2026-11-08T11:05:00+09:00')

    const { trip } = withdrawStaleVerification(afterFirst, second)

    const lunch = stopOf(trip, 'stop-lunch')
    // 昼食店B → 元の散策 への根拠は、散策が差し替わったので成り立たない。
    expect(ids(lunch)).not.toContain('evidence-stop-lunch-travel-next')
    // 昼食店B自身（施設・営業時間）と、朝 → 昼食店B の移動は、今も有効。
    expect(ids(lunch)).toEqual([
      'evidence-stop-lunch-place',
      'evidence-stop-lunch-hours',
      'evidence-stop-lunch-travel',
    ])
    // 昼食店B → 散策B の根拠は、散策Bの前からの移動として、新しく付いている。
    expect(ids(stopOf(trip, 'stop-walk'))).toContain('evidence-stop-walk-travel')
    // 喫茶店：前の予定（散策）が差し替わったので、前からの移動の根拠は取り下げる。
    expect(ids(stopOf(trip, 'stop-cafe'))).not.toContain('evidence-stop-cafe-travel')
  })

  it('方向：次の予定への移動の根拠は、前の予定が変わっても残る。前からの移動の根拠は、次の予定が変わっても残る', () => {
    const revised = revisedStop(verified4, 'stop-walk', '散策B', '2026-11-08T11:00:00+09:00')
    const base = withdrawStaleVerification(verified4, revised).trip

    // 散策B（前：昼食、次：喫茶店）。前の予定（昼食）だけ変える。
    const previousChanged = withdrawStaleVerification(
      base,
      edit(base, 'stop-lunch', { name: '別の昼食店' }),
    ).trip
    expect(ids(stopOf(previousChanged, 'stop-walk'))).toContain('evidence-stop-walk-travel-next')
    expect(ids(stopOf(previousChanged, 'stop-walk'))).not.toContain('evidence-stop-walk-travel')

    // 次の予定（喫茶店）だけ変える。
    const nextChanged = withdrawStaleVerification(
      base,
      edit(base, 'stop-cafe', { name: '別の喫茶店' }),
    ).trip
    expect(ids(stopOf(nextChanged, 'stop-walk'))).toContain('evidence-stop-walk-travel')
    expect(ids(stopOf(nextChanged, 'stop-walk'))).not.toContain('evidence-stop-walk-travel-next')
  })

  it('区間を特定できない移動の根拠（idが規約に合わない）は、自身か前後の予定が変わったら取り下げる', () => {
    const unknownTravel: Evidence = {
      ...travelEvidence(generated.stops[1], generated.stops[0]),
      id: 'evidence-unclear',
    }
    const before: Trip = edit(verified4, 'stop-lunch', {
      evidence: [...stopOf(verified4, 'stop-lunch').evidence, unknownTravel],
    })

    const same = withdrawStaleVerification(before, edit(before, 'stop-lunch', { isFixed: true }))
    expect(ids(stopOf(same.trip, 'stop-lunch'))).toContain('evidence-unclear')

    for (const id of ['stop-morning', 'stop-lunch', 'stop-walk']) {
      const { trip } = withdrawStaleVerification(before, edit(before, id, { name: '変更後' }))
      expect(ids(stopOf(trip, 'stop-lunch'))).not.toContain('evidence-unclear')
    }
  })

  it('入力の旅程を書き換えない', () => {
    const changed = edit(verified4, 'stop-lunch', { name: '別の昼食店' })
    const snapshot = JSON.stringify([verified4, changed])

    withdrawStaleVerification(verified4, changed)

    expect(JSON.stringify([verified4, changed])).toBe(snapshot)
  })
})

describe('withdrawStaleVerification: 取り下げがないとき', () => {
  it('変更がなければ、同じ旅程を返し、取り下げなかったことを伝える', () => {
    const result = withdrawStaleVerification(verified4, verified4)
    expect(result.trip).toBe(verified4)
    expect(result.withdrawn).toBe(false)
  })

  it('根拠の無い旅程では、名称を変えても取り下げるものがない', () => {
    const changed = edit(generated, 'stop-lunch', { name: '別の昼食店' })
    const result = withdrawStaleVerification(generated, changed)
    expect(result.withdrawn).toBe(false)
    expect(result.trip).toBe(changed)
  })

  it('名称を変えた予定に、変更前と全項目が同値の根拠が付いていても、引き継がれたものとして取り下げる', () => {
    const lunch = stopOf(verified4, 'stop-lunch')
    const changed = edit(verified4, 'stop-lunch', {
      name: '別の昼食店',
      evidence: [identityEvidence(lunch), hoursEvidence(lunch)],
    })

    const { trip } = withdrawStaleVerification(verified4, changed)

    expect(stopOf(trip, 'stop-lunch').evidence).toEqual([])
  })
})
