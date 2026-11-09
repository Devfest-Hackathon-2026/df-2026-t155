// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

import { sampleRevision, sampleTrip } from '@/domain/samples'

import { CandidateComparison } from './candidate-comparison'

afterEach(cleanup)

it('候補のGoogle由来の根拠を本人報告や模擬情報と分けて帰属を表示する', () => {
  const original = sampleRevision.diff.after.evidence[0]
  const revision = {
    ...sampleRevision,
    diff: {
      ...sampleRevision.diff,
      after: {
        ...sampleRevision.diff.after,
        evidence: [
          {
            ...original,
            id: 'google-evidence',
            source: { kind: 'places' as const, label: 'Places' },
          },
          {
            ...original,
            id: 'demo-evidence',
            source: { kind: 'simulation' as const, label: '模擬情報' },
          },
        ],
      },
    },
  }
  render(<CandidateComparison trip={sampleTrip} revision={revision} label="候補A" />)
  const summary = screen.getByRole('group', { name: '候補のGoogle Maps照合' })
  expect(within(summary).getByRole('img', { name: 'Google Maps' })).toBeTruthy()
  expect(summary.textContent).not.toContain('模擬情報')
  const box = screen.getByRole('group', {
    name: 'Google Maps Platformで確認した内容',
    hidden: true,
  })
  expect(within(box).getByRole('img', { name: 'Google Maps', hidden: true })).toBeTruthy()
  expect(box.textContent).not.toContain('模擬情報')
})

it('Routesの所要時間をGoogle Mapsの帰属付きで表示する', () => {
  const leg = {
    presence: 'segment' as const,
    segment: {
      fromStopId: sampleTrip.stops[0].id,
      toStopId: sampleTrip.stops[1].id,
      status: 'known' as const,
      mode: 'walk' as const,
      durationMinutes: 10,
      source: { kind: 'routes' as const, label: 'Google Routes' },
      checkedAt: '2026-11-08T11:46:00+09:00',
      explanation: '徒歩で移動',
    },
  }
  const none = { presence: 'none' as const, reason: 'last_stop' as const }
  const comparison = {
    revisionId: sampleRevision.id,
    originalPlaceId: null,
    before: { fromPrevious: leg, toNext: none },
    after: { fromPrevious: leg, toNext: none },
  }
  render(
    <CandidateComparison
      trip={sampleTrip}
      revision={sampleRevision}
      label="候補A"
      comparison={comparison}
    />,
  )
  const boxes = screen.getAllByRole('group', { name: 'Google Mapsの移動時間' })
  expect(boxes.length).toBeGreaterThan(0)
  expect(within(boxes[0]).getByText('Google Maps')).toBeTruthy()
})
