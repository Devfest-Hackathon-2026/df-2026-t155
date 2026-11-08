// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { sampleApprovedLearning, sampleTrip } from '@/domain/samples'

import { LearningApplicationSummary } from './learning-application-summary'

afterEach(cleanup)

const application = sampleTrip.learningApplications[0]

describe('次回旅程への学びの適用記録', () => {
  it('生成結果の適用先と説明だけを表示し、因果効果を断定しない', () => {
    render(<LearningApplicationSummary trip={sampleTrip} learnings={[sampleApprovedLearning]} />)

    expect(screen.getByText(sampleApprovedLearning.content)).toBeTruthy()
    expect(screen.getByText('対象：昼食店A（架空）')).toBeTruthy()
    expect(screen.getByText(application.explanation)).toBeTruthy()
    expect(screen.getByText(/学びだけによるものだとは断定できません/)).toBeTruthy()
  })

  it('AIの説明は未検証と明示し、学びの内容は生成時点ではなく現在の内容だと示す', () => {
    render(<LearningApplicationSummary trip={sampleTrip} learnings={[sampleApprovedLearning]} />)

    const item = screen.getByRole('listitem')
    expect(within(item).getByText('AIによる説明（未検証）：')).toBeTruthy()
    expect(within(item).getByText('現在の内容：')).toBeTruthy()
    expect(screen.getByText(/生成した時点の内容とは限りません/)).toBeTruthy()
  })

  it('対応する学びが取得できなくても、適用記録を捨てず、記録が無いとは表示しない', () => {
    render(<LearningApplicationSummary trip={sampleTrip} learnings={[]} />)

    // 学びの内容は出さない。別の文で補わない。
    expect(screen.queryByText(sampleApprovedLearning.content)).toBeNull()
    expect(
      screen.getByText(/内容を取得できません（撤回または変更された可能性があります）/),
    ).toBeTruthy()
    // 学びID・対象の予定・AIの説明は、記録として残す。
    expect(screen.getByText(`学びID：${application.learningId}`)).toBeTruthy()
    expect(screen.getByText('対象：昼食店A（架空）')).toBeTruthy()
    expect(screen.getByText(application.explanation)).toBeTruthy()
    expect(screen.queryByText(/適用記録がありません/)).toBeNull()
  })

  it('別の学びだけが取得できた場合も、記録に対応しない内容を出さない', () => {
    const other = { ...sampleApprovedLearning, id: 'learning-other', content: '別の学びの文' }
    render(<LearningApplicationSummary trip={sampleTrip} learnings={[other]} />)

    expect(screen.queryByText('別の学びの文')).toBeNull()
    expect(screen.getByText(/内容を取得できません/)).toBeTruthy()
  })

  it('適用記録が本当に無い旅程だけ、記録が無いと表示する', () => {
    render(
      <LearningApplicationSummary
        trip={{ ...sampleTrip, learningApplications: [] }}
        learnings={[sampleApprovedLearning]}
      />,
    )

    expect(screen.getByText(/この旅程には、選んだ学びの適用記録がありません/)).toBeTruthy()
    expect(screen.queryAllByRole('listitem')).toHaveLength(0)
  })

  it('旅程に無い予定を指す記録は、予定を黙って省かず確認できないと示す。同じ学びの複数の記録も残す', () => {
    const trip = {
      ...sampleTrip,
      learningApplications: [
        { ...application, targetStopIds: ['stop-lunch', 'stop-removed'] },
        { ...application, explanation: '別の説明（架空）' },
      ],
    }
    render(<LearningApplicationSummary trip={trip} learnings={[sampleApprovedLearning]} />)

    expect(
      screen.getByText('対象：昼食店A（架空）、この旅程で確認できない予定（stop-removed）'),
    ).toBeTruthy()
    expect(screen.getAllByRole('listitem')).toHaveLength(2)
  })
})
