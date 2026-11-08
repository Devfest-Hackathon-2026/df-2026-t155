import { describe, expect, it } from 'vitest'

import { RevisionSchema, TripSchema, type Evidence, type Stop } from '@/domain'
import { sampleRevision, sampleTrip } from '@/domain/samples'
import {
  NOTE_SEPARATOR,
  REPORT_PRESETS,
  buildSubmission,
} from '@/features/onsite-report/report-model'
import type { RevisionProposal, RevisionRequest } from '@/features/revision-review/api-client'

import { classifyReport, guardOnSiteProposal, onSiteApprovalBlock } from './onsite-approval-guard'

// 昼食店A（Place IDあり）を対象にした現地報告。候補の施設・営業時間は、情報源と整合している。
const lunch: Stop = { ...sampleTrip.stops[1], placeId: 'place-lunch-a' }
const trip = TripSchema.parse({ ...sampleTrip, stops: sampleTrip.stops.with(1, lunch) })

const evidence = (
  subject: Evidence['subject'],
  status: Evidence['status'] = 'consistent',
  kind: Evidence['source']['kind'] = 'places',
): Evidence => ({
  id: `test-${kind}-${subject}-${status}`,
  subject,
  claim: '候補の根拠',
  applicability: '2026-11-08 12:00 Asia/Tokyo',
  source: { kind, label: kind === 'user_report' ? '本人の現地報告' : 'Google Places' },
  checkedAt: '2026-11-08T11:46:00+09:00',
  status,
  explanation: '候補の根拠の説明',
})

const consistentEvidence = [evidence('place_identity'), evidence('opening_hours')]

const candidateStop = (patch: Partial<Stop> = {}): Stop => ({
  ...lunch,
  name: '昼食店B（架空候補）',
  placeId: 'place-lunch-b',
  evidence: consistentEvidence,
  ...patch,
})

type Status = 'satisfied' | 'unknown' | 'not_checked' | 'violated'
const ORIGINAL_EXPLANATION = 'もとの判定の説明'
const ORIGINAL_IMPACT = 'もとの影響の説明（間に合う見込み）'

const revisionOf = (status: Status, after: Stop = candidateStop()) =>
  RevisionSchema.parse({
    ...sampleRevision,
    baseTripVersion: trip.version,
    diff: { before: lunch, after },
    impactSummary: ORIGINAL_IMPACT,
    constraintCheck: { status, explanation: ORIGINAL_EXPLANATION },
  })

const reportOf = (presetId: (typeof REPORT_PRESETS)[number]['id'], note = '') => {
  const built = buildSubmission(trip, {
    targetStopId: lunch.id,
    preset: presetId,
    // 「その他」は補足が必須。
    note: presetId === 'other' && note === '' ? '詳細' : note,
    kind: 'actual',
  })
  if (!built.ok) throw new Error('テストデータが不正')
  return built.submission
}

const requestOf = (
  presetId: (typeof REPORT_PRESETS)[number]['id'],
  note = '',
  kind: 'actual' | 'simulated' = 'actual',
): RevisionRequest => {
  const submission = reportOf(presetId, note)
  return {
    trip,
    targetStopId: lunch.id,
    reason: submission.reason,
    context: {
      phase: 'on_site',
      report: { kind, description: submission.context.report.description },
    },
  }
}

const proposalOf = (...revisions: ReturnType<typeof revisionOf>[]): RevisionProposal => ({
  status: 'proposed',
  revisions,
})

const guardOne = (status: Status, after: Stop, presetId: (typeof REPORT_PRESETS)[number]['id']) =>
  guardOnSiteProposal(proposalOf(revisionOf(status, after)), requestOf(presetId)).revisions[0]

const SEVERITY: Record<Status, number> = { satisfied: 0, unknown: 1, not_checked: 1, violated: 2 }

describe('報告の種類の読み取り', () => {
  it('フォームが作る説明文（補足の有無）から、選んだ種類を読み取る', () => {
    for (const preset of REPORT_PRESETS) {
      for (const note of ['', '貼り紙があった']) {
        const built = buildSubmission(trip, {
          targetStopId: lunch.id,
          preset: preset.id,
          note: preset.id === 'other' && note === '' ? '詳細' : note,
          kind: 'actual',
        })
        expect(built.ok).toBe(true)
        if (!built.ok) continue
        expect(classifyReport(built.submission.context.report.description)).toBe(preset.id)
      }
    }
  })

  it('補足に別の種類の文言があっても、選んだ種類のまま読む（補足の自由記述で種類を取り違えない）', () => {
    expect(classifyReport(`その他${NOTE_SEPARATOR}遅れていて、次の予定に間に合わない`)).toBe(
      'other',
    )
    expect(
      classifyReport(`閉店・臨時休業だった${NOTE_SEPARATOR}遅れていて、次の予定に間に合わない`),
    ).toBe('closed')
  })

  it('読み取れない説明文は種類なし（先頭が一致しないものを推測しない）', () => {
    expect(classifyReport('昼食店Aの臨時休業（模擬報告）')).toBeNull()
    expect(classifyReport('')).toBeNull()
    expect(classifyReport('補足：閉店・臨時休業だった')).toBeNull()
    // 文言の続きが区切りでない場合は、同じ文言から始まっていても別の説明として扱う。
    expect(classifyReport('閉店・臨時休業だったらしい')).toBeNull()
  })
})

describe('(a) 同じ施設（Place ID）は名称が違っても代わりの候補にしない', () => {
  it('休業の報告の対象と同じPlace IDの候補は、ほかの根拠が整合していても承認できない', () => {
    const result = guardOne('satisfied', candidateStop({ placeId: lunch.placeId }), 'closed')
    expect(result.constraintCheck.status).toBe('violated')
    expect(result.constraintCheck.explanation).toContain('休業と報告された')
    expect(result.constraintCheck.explanation).toContain('同じPlace ID')
    expect(result.constraintCheck.explanation).toContain(lunch.name)
    // 承認できる前提の影響の説明は使わない。
    expect(result.impactSummary).not.toBe(ORIGINAL_IMPACT)
  })

  it('休業以外の報告でも、同じ施設は代わりの候補にならない', () => {
    for (const presetId of ['crowded', 'delayed', 'other'] as const) {
      const result = guardOne('satisfied', candidateStop({ placeId: lunch.placeId }), presetId)
      expect(result.constraintCheck.status).toBe('violated')
      expect(result.constraintCheck.explanation).not.toContain('休業と報告された')
    }
  })

  it('Place IDが違う候補はそのまま返す。未同定（null）どうしは同じ施設としない', () => {
    const proposal = proposalOf(revisionOf('satisfied'))
    expect(guardOnSiteProposal(proposal, requestOf('closed'))).toBe(proposal)
    expect(
      onSiteApprovalBlock(
        revisionOf('satisfied', candidateStop({ placeId: null })),
        { ...lunch, placeId: null },
        '閉店・臨時休業だった',
      ),
    ).toBeNull()
  })
})

describe('(b) 本人の現地報告と矛盾する根拠が残る候補は承認しない', () => {
  const conflicting = [
    ...consistentEvidence,
    evidence('opening_hours', 'conflicting', 'user_report'),
  ]

  it('施設・営業時間が整合していても、user_report の矛盾が残っていれば承認できない', () => {
    const result = guardOne('satisfied', candidateStop({ evidence: conflicting }), 'closed')
    expect(result.constraintCheck.status).toBe('violated')
    expect(result.constraintCheck.explanation).toContain('現地報告と矛盾する根拠')
  })

  it('矛盾でない現地報告の根拠（整合・確認できない）は、承認可否に影響しない', () => {
    for (const status of ['consistent', 'unverifiable'] as const) {
      const proposal = proposalOf(
        revisionOf(
          'satisfied',
          candidateStop({
            evidence: [...consistentEvidence, evidence('other', status, 'user_report')],
          }),
        ),
      )
      expect(guardOnSiteProposal(proposal, requestOf('closed'))).toBe(proposal)
    }
  })
})

describe('(c) 遅れの報告後は、元の時刻表だけを根拠に間に合うとは言わない', () => {
  it('遅れの報告では、成立（satisfied）と判定された候補も未確認にして、理由を示す', () => {
    const result = guardOne('satisfied', candidateStop(), 'delayed')
    expect(result.constraintCheck.status).toBe('unknown')
    expect(result.constraintCheck.explanation).toContain('遅れの報告')
    expect(result.constraintCheck.explanation).toContain('間に合う見込み')
    expect(result.impactSummary).not.toBe(ORIGINAL_IMPACT)
  })

  it('補足つきの遅れの報告でも同じ。遅れ以外の報告は影響を受けない', () => {
    const delayedWithNote = guardOnSiteProposal(
      proposalOf(revisionOf('satisfied')),
      requestOf('delayed', '電車が止まっている'),
    ).revisions[0]
    expect(delayedWithNote.constraintCheck.status).toBe('unknown')

    for (const presetId of ['closed', 'crowded', 'other'] as const) {
      const proposal = proposalOf(revisionOf('satisfied'))
      expect(guardOnSiteProposal(proposal, requestOf(presetId, '詳細'))).toBe(proposal)
    }
  })
})

describe('承認できる方向へは動かさない', () => {
  const scenarios = [
    ['同じ施設', candidateStop({ placeId: lunch.placeId }), 'closed'],
    [
      '矛盾する現地報告',
      candidateStop({
        evidence: [...consistentEvidence, evidence('other', 'conflicting', 'user_report')],
      }),
      'crowded',
    ],
    ['遅れ', candidateStop(), 'delayed'],
    [
      '複数',
      candidateStop({
        placeId: lunch.placeId,
        evidence: [...consistentEvidence, evidence('other', 'conflicting', 'user_report')],
      }),
      'delayed',
    ],
  ] as const

  it('もとの判定が承認できない候補は、どのガードでも成立（satisfied）にならず、順位も上がらない', () => {
    for (const [, after, presetId] of scenarios) {
      for (const status of ['unknown', 'not_checked', 'violated'] as const) {
        const result = guardOne(status, after, presetId)
        expect(result.constraintCheck.status).not.toBe('satisfied')
        expect(SEVERITY[result.constraintCheck.status]).toBeGreaterThanOrEqual(SEVERITY[status])
        // もとの説明は残し、ガードの理由を足す。
        expect(result.constraintCheck.explanation).toContain(ORIGINAL_EXPLANATION)
        expect(result.impactSummary).toBe(ORIGINAL_IMPACT)
      }
    }
  })

  it('遅れの報告だけなら、もとが violated の候補を未確認へ戻さず、unknown を矛盾へ上げもしない', () => {
    expect(guardOne('violated', candidateStop(), 'delayed').constraintCheck.status).toBe('violated')
    expect(guardOne('unknown', candidateStop(), 'delayed').constraintCheck.status).toBe('unknown')
    expect(guardOne('not_checked', candidateStop(), 'delayed').constraintCheck.status).toBe(
      'not_checked',
    )
  })

  it('成立と判定された候補は、ガードに当たれば必ず承認できなくなる', () => {
    for (const [, after, presetId] of scenarios) {
      expect(guardOne('satisfied', after, presetId).constraintCheck.status).not.toBe('satisfied')
    }
  })

  it('複数のガードに当たれば、より厳しい判定と、すべての理由を示す', () => {
    const [, after, presetId] = scenarios[3]
    const result = guardOne('satisfied', after, presetId)
    expect(result.constraintCheck.status).toBe('violated')
    expect(result.constraintCheck.explanation).toContain('同じPlace ID')
    expect(result.constraintCheck.explanation).toContain('現地報告と矛盾する根拠')
    expect(result.constraintCheck.explanation).toContain('遅れの報告')
  })
})

describe('対象外の入力は変えない', () => {
  it('旅行前（planning）の依頼には働かない', () => {
    const proposal = proposalOf(revisionOf('satisfied', candidateStop({ placeId: lunch.placeId })))
    expect(
      guardOnSiteProposal(proposal, { ...requestOf('closed'), context: { phase: 'planning' } }),
    ).toBe(proposal)
  })

  it('形が不正な候補や、対象が旅程に無い依頼は触らない（受け取る側の検証が退ける）', () => {
    const broken = { ...revisionOf('satisfied'), diff: undefined } as unknown as ReturnType<
      typeof revisionOf
    >
    const proposal = proposalOf(broken)
    expect(guardOnSiteProposal(proposal, requestOf('closed'))).toBe(proposal)

    const good = proposalOf(revisionOf('satisfied', candidateStop({ placeId: lunch.placeId })))
    expect(
      guardOnSiteProposal(good, { ...requestOf('closed'), targetStopId: 'no-such-stop' }),
    ).toBe(good)
    const notArray = { status: 'proposed', revisions: null } as unknown as RevisionProposal
    expect(guardOnSiteProposal(notArray, requestOf('closed'))).toBe(notArray)
  })

  it('模擬報告も実際の報告と同じ基準で下げる（種類で緩めない）', () => {
    const result = guardOnSiteProposal(
      proposalOf(revisionOf('satisfied', candidateStop({ placeId: lunch.placeId }))),
      requestOf('closed', '', 'simulated'),
    ).revisions[0]
    expect(result.constraintCheck.status).toBe('violated')
  })

  it('ガードに当たらない候補だけが混ざるときは、当たった候補だけ変える', () => {
    const blocked = revisionOf('satisfied', candidateStop({ placeId: lunch.placeId }))
    const clean = { ...revisionOf('satisfied'), id: 'revision-clean' }
    const result = guardOnSiteProposal(proposalOf(blocked, clean), requestOf('closed'))
    expect(result.revisions[0].constraintCheck.status).toBe('violated')
    expect(result.revisions[1]).toBe(clean)
  })
})
