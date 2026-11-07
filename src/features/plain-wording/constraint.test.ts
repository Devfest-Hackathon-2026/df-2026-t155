import { describe, expect, it } from 'vitest'

import { describeApproval } from './approval'
import { describeConstraint, describeTravelModes } from './constraint'

const MATCH_PHRASE = '間に合う見込み'
const FIXED_PHRASE = '次の固定予定に間に合う見込み'
const AT = '2026-11-08T12:00:00+09:00'
const NOT_CONSIDERED = '臨時休業・渋滞・遅延は考慮していません。'

// 営業時間・前後の移動をすべて検証し、次が固定予定のとき。
const FULL = {
  checkedOpeningHours: true,
  hasPreviousSegment: true,
  hasNextSegment: true,
  nextStopIsFixed: true,
} as const

// 最後の予定（次の移動区間なし）。
const NO_NEXT = { hasPreviousSegment: true, hasNextSegment: false } as const

// 文脈なしの既定の文言（確認できていない条件を断定しない）。
const CONSTRAINT_TABLE = [
  ['satisfied', '確認した条件を満たす見込み', 'ok', true],
  ['violated', '条件に合いません', 'conflict', false],
  ['unknown', '条件を確認できません', 'unknown', false],
  ['not_checked', 'まだ検証していません', 'none', false],
] as const

// satisfied × 文脈。「次の固定予定に間に合う見込み」は、次が固定かつ次の区間を検証したときだけ。
const SATISFIED_TABLE = [
  ['文脈なし', {}, '確認した条件を満たす見込み', '確認した範囲での結果です。'],
  [
    '次が固定で次の区間あり',
    FULL,
    '次の固定予定に間に合う見込み',
    '営業時間、前の予定からの移動、次の予定への移動を検証した結果です。',
  ],
  [
    '次が固定でない',
    { ...FULL, nextStopIsFixed: false },
    '次の予定に間に合う見込み',
    '営業時間、前の予定からの移動、次の予定への移動を検証した結果です。',
  ],
  [
    '次が固定かは不明だが次の区間あり',
    { hasNextSegment: true },
    '次の予定に間に合う見込み',
    '次の予定への移動を検証した結果です。',
  ],
  [
    '次の区間なし（最後の予定）',
    { ...FULL, hasNextSegment: false },
    '営業時間などの確認した条件を満たす見込み',
    '営業時間、前の予定からの移動を検証した結果です。',
  ],
  [
    '次の区間なしで固定と渡されても、固定予定とは言わない',
    { ...FULL, hasNextSegment: false, nextStopIsFixed: true },
    '営業時間などの確認した条件を満たす見込み',
    '営業時間、前の予定からの移動を検証した結果です。',
  ],
  [
    '前の区間なし（最初の予定）',
    { ...FULL, hasPreviousSegment: false },
    '次の固定予定に間に合う見込み',
    '営業時間、次の予定への移動を検証した結果です。',
  ],
  [
    '前後とも区間なし',
    { ...FULL, hasPreviousSegment: false, hasNextSegment: false },
    '営業時間などの確認した条件を満たす見込み',
    '営業時間を検証した結果です。',
  ],
  [
    '営業時間を検証していない（前後とも区間なし）',
    { hasPreviousSegment: false, hasNextSegment: false },
    '確認した条件を満たす見込み',
    '確認した範囲での結果です。',
  ],
] as const

describe('describeConstraint', () => {
  it.each(CONSTRAINT_TABLE)(
    '文脈なし：%s → %s（%s、canApprove=%s）',
    (status, label, tone, canApprove) => {
      const result = describeConstraint({ status, explanation: '理由の文' })
      expect(result.label).toBe(label)
      expect(result.tone).toBe(tone)
      expect(result.canApprove).toBe(canApprove)
    },
  )

  it.each(SATISFIED_TABLE)('satisfied：%s', (_name, context, label, scope) => {
    const result = describeConstraint({ status: 'satisfied', explanation: '検証済み' }, context)
    expect(result.label).toBe(label)
    expect(result.detail).toBe(`${scope}${NOT_CONSIDERED}`)
    expect(result.tone).toBe('ok')
    expect(result.canApprove).toBe(true)
  })

  it('「次の固定予定に間に合う見込み」は、次が固定かつ次の区間を検証したときだけ出る', () => {
    const flags = [undefined, true, false] as const
    for (const hasNextSegment of flags) {
      for (const nextStopIsFixed of flags) {
        const result = describeConstraint(
          { status: 'satisfied', explanation: '説明' },
          { ...FULL, hasNextSegment, nextStopIsFixed },
        )
        const expected = hasNextSegment === true && nextStopIsFixed === true
        expect(result.label === FIXED_PHRASE, `${hasNextSegment}/${nextStopIsFixed}`).toBe(expected)
        expect(result.detail).not.toContain('固定')
      }
    }
  })

  it('検証していない項目（存在しない区間の移動）は、補足に出ない', () => {
    const noPrev = describeConstraint(
      { status: 'satisfied', explanation: '' },
      { ...FULL, hasPreviousSegment: false },
    )
    expect(noPrev.detail).not.toContain('前の予定')
    const noNext = describeConstraint(
      { status: 'satisfied', explanation: '' },
      { ...FULL, hasNextSegment: false },
    )
    expect(noNext.detail).not.toContain('次の予定')
    expect(noNext.label).not.toContain('次の')
    const none = describeConstraint(
      { status: 'satisfied', explanation: '' },
      { checkedOpeningHours: true, hasPreviousSegment: false, hasNextSegment: false },
    )
    expect(none.detail).not.toContain('移動')
    expect(none.label).not.toContain('移動')
  })

  it('文脈なしでは、「固定予定」「前後の移動」「営業時間」を断定しない', () => {
    const { label, detail } = describeConstraint({ status: 'satisfied', explanation: '検証済み' })
    for (const text of [label, detail]) {
      expect(text).not.toContain('固定')
      expect(text).not.toContain('前後')
      expect(text).not.toContain('営業時間')
      expect(text).not.toContain('移動')
      expect(text).not.toContain(MATCH_PHRASE)
    }
  })

  it('satisfied：臨時休業・渋滞・遅延を考慮していないことは、常に書く', () => {
    for (const [, context] of SATISFIED_TABLE) {
      const { detail } = describeConstraint({ status: 'satisfied', explanation: '' }, context)
      expect(detail).toContain('臨時休業・渋滞・遅延は考慮していません')
    }
  })

  it('satisfied：移動手段は、渡されたときだけ書く', () => {
    const withMode = describeConstraint(
      { status: 'satisfied', explanation: '検証済み' },
      { ...FULL, travelModes: ['walk'] },
    )
    expect(withMode.detail).toContain('移動の手段：徒歩のみ')
    const without = describeConstraint({ status: 'satisfied', explanation: '' }, FULL)
    expect(without.detail).not.toContain('手段')
    const empty = describeConstraint(
      { status: 'satisfied', explanation: '' },
      { ...FULL, travelModes: [] },
    )
    expect(empty.detail).not.toContain('手段')
  })

  it('canApproveは、文脈によらずsatisfiedのときだけtrue', () => {
    const contexts = [{}, FULL, NO_NEXT, { hasPreviousSegment: false }]
    for (const context of contexts) {
      const results = CONSTRAINT_TABLE.map(
        ([status]) => describeConstraint({ status, explanation: '説明' }, context).canApprove,
      )
      expect(results).toEqual([true, false, false, false])
    }
  })

  it('「間に合う見込み」は、satisfiedのときだけ出る（見出し・補足とも）', () => {
    for (const [status] of CONSTRAINT_TABLE) {
      const result = describeConstraint({ status, explanation: '説明' }, FULL)
      const shown = result.label.includes(MATCH_PHRASE) || result.detail.includes(MATCH_PHRASE)
      expect(shown, status).toBe(status === 'satisfied')
    }
  })

  it('violated：理由と次の操作を示す', () => {
    const { detail } = describeConstraint({ status: 'violated', explanation: '閉店時刻を過ぎる' })
    expect(detail).toContain('理由：閉店時刻を過ぎる')
    expect(detail).toContain('別の案を選ぶか')
  })

  it('unknown：判断できない理由を示し、承認できる案として扱わない', () => {
    const result = describeConstraint({ status: 'unknown', explanation: '営業時間を取得できない' })
    expect(result.detail).toContain('理由：営業時間を取得できない')
    expect(result.detail).toContain('承認できる案としては扱いません')
    expect(result.detail).not.toContain('移動時間')
  })

  it.each([
    ['文脈なし', {}, '条件を確認できません'],
    ['次の区間あり', { hasNextSegment: true }, '間に合うか確認できません'],
    ['次の区間なし（最後の予定）', NO_NEXT, '移動の条件を確認できません'],
    [
      '前後とも区間なし',
      { hasPreviousSegment: false, hasNextSegment: false },
      '条件を確認できません',
    ],
  ] as const)('unknown：%s → %s', (_name, context, label) => {
    const result = describeConstraint({ status: 'unknown', explanation: '説明' }, context)
    expect(result.label).toBe(label)
    expect(result.canApprove).toBe(false)
  })

  it('violated・not_checkedの文言は、文脈によらず断定しない', () => {
    for (const status of ['violated', 'not_checked'] as const) {
      const bare = describeConstraint({ status, explanation: '説明' })
      expect(describeConstraint({ status, explanation: '説明' }, FULL)).toEqual(bare)
      expect(bare.label).not.toContain('間に合う')
      expect(bare.label).not.toContain('固定')
    }
  })

  it('satisfied以外の見出しは、説明文（explanation）に左右されない', () => {
    for (const [status, label] of CONSTRAINT_TABLE) {
      const result = describeConstraint({ status, explanation: '間に合う見込み 999分' })
      expect(result.label).toBe(label)
    }
  })
})

describe('describeTravelModes', () => {
  it.each([
    [undefined, '手段は未指定'],
    [[], '手段は未指定'],
    [['walk'], '徒歩のみ'],
    [['drive'], '車のみ'],
    [['walk', 'walk'], '徒歩のみ'],
    [['walk', 'drive'], '徒歩・車'],
  ] as const)('%j → %s', (modes, expected) => {
    expect(describeTravelModes(modes)).toBe(expected)
  })
})

describe('describeApproval', () => {
  it('pending：まだ旅程には反映されていない', () => {
    const result = describeApproval({ status: 'pending' })
    expect(result.label).toBe('まだ旅程には反映されていません')
    expect(result.tone).toBe('pending')
  })

  it('approved：承認済み（判断日時つき）', () => {
    const result = describeApproval({ status: 'approved', decidedAt: AT })
    expect(result.label).toBe('承認済み')
    expect(result.tone).toBe('approved')
    expect(result.detail).toContain('2026年11月8日 12:00（UTC+09:00）')
  })

  it('rejected：見送りました（旅程に反映されていない）', () => {
    const result = describeApproval({ status: 'rejected', decidedAt: AT })
    expect(result.label).toBe('見送りました')
    expect(result.tone).toBe('rejected')
    expect(result.detail).toContain('旅程には反映されていません')
  })

  it('承認の言葉は、根拠・制約の見込みの言葉と混ざらない', () => {
    for (const approval of [
      { status: 'pending' },
      { status: 'approved', decidedAt: AT },
      { status: 'rejected', decidedAt: AT },
    ] as const) {
      const result = describeApproval(approval)
      expect(result.label).not.toContain('見込み')
      expect(result.label).not.toContain('確認')
    }
  })
})
