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
    expect(screen.getByText('生成時の対象：昼食店A（架空）')).toBeTruthy()
    expect(screen.getByText(application.explanation)).toBeTruthy()
    expect(screen.getByText(/学びが予定を変えたかは確認できません/)).toBeTruthy()
  })

  it('AIの説明は未検証と明示する', () => {
    render(<LearningApplicationSummary trip={sampleTrip} learnings={[sampleApprovedLearning]} />)

    const item = screen.getByRole('listitem')
    expect(within(item).getByText('AIによる説明（未検証）：')).toBeTruthy()
  })

  it('対応する学びが取得できなくても、適用記録を捨てず、記録が無いとは表示しない', () => {
    render(<LearningApplicationSummary trip={sampleTrip} learnings={[]} />)

    // 学びの内容は出さない。別の文で補わない。
    expect(screen.queryByText(sampleApprovedLearning.content)).toBeNull()
    expect(
      screen.getByText(`選択時の内容を確認できません（${application.learningId}）`),
    ).toBeTruthy()
    expect(screen.getByText('生成時の対象：昼食店A（架空）')).toBeTruthy()
    expect(screen.getByText(application.explanation)).toBeTruthy()
    expect(screen.queryByText(/適用記録がありません/)).toBeNull()
  })

  it('反映先が報告されなかった学びを、適用記録のある学びと分けて示す', () => {
    const other = { ...sampleApprovedLearning, id: 'learning-other', content: '別の学びの文' }
    render(
      <LearningApplicationSummary trip={sampleTrip} learnings={[sampleApprovedLearning, other]} />,
    )

    const [recorded, unreported] = screen.getAllByRole('list')
    expect(within(recorded).getByText(sampleApprovedLearning.content)).toBeTruthy()
    expect(within(recorded).queryByText(other.content)).toBeNull()
    expect(within(unreported).getByText(other.content)).toBeTruthy()
    expect(within(unreported).queryByText(application.explanation)).toBeNull()
  })

  it('すべての反映先が未報告なら、選んだ内容と未報告の状態だけを示す', () => {
    render(
      <LearningApplicationSummary
        trip={{ ...sampleTrip, learningApplications: [] }}
        learnings={[sampleApprovedLearning]}
      />,
    )

    expect(screen.getByText(/AIから反映先の報告がなかった/)).toBeTruthy()
    expect(screen.getByRole('listitem').textContent).toBe(sampleApprovedLearning.content)
    expect(screen.queryByText(/AIによる説明/)).toBeNull()
    expect(screen.queryByText(/保存には対応していません/)).toBeNull()
  })

  it('旅程に無い予定を指す記録は、確認できないと示す', () => {
    const trip = {
      ...sampleTrip,
      learningApplications: [{ ...application, targetStopIds: ['stop-lunch', 'stop-removed'] }],
    }
    render(<LearningApplicationSummary trip={trip} learnings={[sampleApprovedLearning]} />)

    expect(
      screen.getByText('生成時の対象：昼食店A（架空）、この旅程で確認できない予定（stop-removed）'),
    ).toBeTruthy()
  })
})
