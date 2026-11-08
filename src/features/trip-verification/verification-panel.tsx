import { useId, type ReactNode } from 'react'

import { evidenceStatusLabels } from '@/domain'
import { GoogleMapsSourceBox } from '@/features/legal/google-maps-attribution'
import { checkedAtFormat, StatusBadge } from '@/features/trip-map/evidence-badge'
import { evidenceSubjectLabels } from '@/features/trip-map/model'

import {
  failureStateNote,
  verificationFailureGuidance,
  verificationInterruptedGuidance,
} from './failure-messages'
import type { VerificationPhase } from './use-trip-verification'
import {
  verifiedSubjects,
  type VerificationSummary,
  type VerifiedSubject,
} from './verification-summary'

// 旅程の根拠の確認状態。通信の状態（確認中・失敗）と、旅程に対する結果を合わせて表示する。
// - unverified：まだ「根拠を確認する」で照合していない。部分修正の候補を確認したときの根拠が付いている場合は、その件数
//   （googleTotal）を持つ。旅程全体を照合した結果ではない。
// - verified：照合した（外部の情報源に1件も照会しなかった場合を含む。summary.google.total で見分ける）
// - partial：旅程の内容が変わり、変更の影響を受けた根拠を取り下げた。影響を受けない予定の根拠は、残っている
// - withdrawn：旅程の内容が変わり、照合の根拠がすべてなくなった
export type PanelStatus =
  | { kind: 'unverified'; googleTotal?: number }
  | { kind: 'withdrawn' }
  | { kind: 'verified'; summary: VerificationSummary }
  | { kind: 'partial'; summary: VerificationSummary }

interface VerificationPanelProps {
  status: PanelStatus
  phase: VerificationPhase
  // 確認の最中に旅程の内容が変わり、確認を中止した。次に確認を始めるまで、理由を出し続ける。
  interrupted: boolean
  onVerify: () => void
}

const subjectLabel: Record<VerifiedSubject, string> = {
  place_identity: `${evidenceSubjectLabels.place_identity}（名称と地域）`,
  opening_hours: `通常の${evidenceSubjectLabels.opening_hours}`,
  travel_time: '徒歩での移動',
}

const formatAt = (value: string) => checkedAtFormat.format(new Date(value))

// 外部の情報源（Places・Routes）の根拠がある状態の概要。以前の照合結果を表示しているかの判定にも使う。
const googleSummary = (status: PanelStatus) =>
  status.kind === 'verified' || status.kind === 'partial' ? status.summary.google : null

// 照合の対象にしていない範囲。照合した項目の有無にかかわらず、整合を正しさの保証と受け取らせない。
function NotCovered() {
  return (
    <p className="text-sm text-gt-muted">
      確認していないこと：臨時休業・混雑・公共交通。
      「情報源と整合」は、確認できた情報と一致したという意味で、現実の正しさや当日の営業を保証するものではありません。
    </p>
  )
}

const statusOrder = ['consistent', 'conflicting', 'unverifiable'] as const

// 結果の通知（role="status"）に載せる、状態の1文。件数や範囲の説明は含めず、毎回の読み上げを軽くする。
function StatusLine({
  status,
  verifying,
  failed,
}: {
  status: PanelStatus
  verifying: boolean
  failed: boolean
}) {
  if (verifying) {
    return <p className="text-sm font-semibold">根拠を確認しています。しばらくお待ちください。</p>
  }
  const google = googleSummary(status)
  // 今回の確認が失敗したが、以前の照合結果は表示している。
  if (failed && google && google.total > 0 && google.latestCheckedAt) {
    return (
      <p className="font-semibold">
        状態：以前の照合結果を表示中（{formatAt(google.latestCheckedAt)}時点）
      </p>
    )
  }
  if (status.kind === 'verified') {
    return google && google.total > 0 ? (
      <p className="font-semibold">状態：照合結果あり（根拠 {google.total}件）</p>
    ) : (
      <p className="font-semibold">状態：照合しましたが、外部の情報源に照会した項目はありません</p>
    )
  }
  if (status.kind === 'partial') {
    return (
      <p className="font-semibold">
        状態：変更後の一部は未確認（残っている根拠 {status.summary.google.total}件）
      </p>
    )
  }
  return (
    <p className="flex flex-wrap items-center gap-2 font-semibold">
      状態：
      <StatusBadge tone="unverified">
        {status.kind === 'withdrawn' ? '変更後は未確認' : '未確認'}
      </StatusBadge>
    </p>
  )
}

// Google Maps Platform（Places・Routes）で照合した内容。枠で囲み、枠の下に帰属を付ける。
function GoogleResult({ google }: { google: VerificationSummary['google'] }) {
  const latest = google.latestCheckedAt && formatAt(google.latestCheckedAt)
  const earliest = google.earliestCheckedAt && formatAt(google.earliestCheckedAt)
  return (
    <GoogleMapsSourceBox caption="確認に使った情報源">
      <div className="space-y-1">
        <p className="text-sm">
          根拠 {google.total}件の内訳：
          {statusOrder.map((key, index) => (
            <span key={key}>
              {index > 0 && '／'}
              {evidenceStatusLabels[key]} {google.counts[key]}件
            </span>
          ))}
          {latest && `（${latest}時点`}
          {latest && earliest && earliest !== latest && `。最も古い根拠は${earliest}の照合`}
          {latest && '）'}
        </p>
        <ul className="list-disc space-y-0.5 pl-5 text-sm">
          {verifiedSubjects.map((subject) => (
            <li key={subject}>
              {subjectLabel[subject]}：
              {google.bySubject[subject] > 0
                ? `${google.bySubject[subject]}件`
                : '照合していません（未確認）'}
            </li>
          ))}
        </ul>
        <p className="text-sm">
          件数は、施設の存在・営業時間・移動の確認項目ごとの根拠の数です（予定の数ではありません）。
          各予定の詳細で、確認項目ごとの内訳・情報源・照合日時・理由を見られます。
        </p>
      </div>
    </GoogleMapsSourceBox>
  )
}

function VerifiedDetails({ summary, partial }: { summary: VerificationSummary; partial: boolean }) {
  const { google, otherTotal } = summary
  return (
    <div className="space-y-2">
      {partial && (
        <p className="text-sm">
          旅程の内容を変更したため、変更の影響を受けた予定の根拠は取り下げ、未確認に戻しました。影響を受けていない予定の根拠は、照合日時つきで残しています。変更後の旅程全体を確認するには、もう一度確認してください。
        </p>
      )}
      {google.total === 0 ? (
        <p className="text-sm">
          外部の情報源（Google Maps
          Platform）への照会は行われませんでした（乗車・乗換だけの旅程など）。
          施設の存在・営業時間・徒歩での移動は、いずれも照合していません（未確認）。
        </p>
      ) : (
        <GoogleResult google={google} />
      )}
      {otherTotal > 0 && (
        <p className="text-sm">
          ほかに、公式情報・本人の報告・模擬データ由来の根拠が{otherTotal}
          件あります。これらは、Google Mapsでの照合の結果ではありません。
        </p>
      )}
      <NotCovered />
    </div>
  )
}

function UnverifiedDetails({
  withdrawn,
  googleTotal,
}: {
  withdrawn: boolean
  googleTotal: number
}) {
  return (
    <div className="space-y-2">
      <p className="text-sm">
        {withdrawn
          ? '旅程の内容を変更したため、前回の照合結果は取り下げました。変更後の旅程は、施設の存在・営業時間・移動をまだ外部の情報源と照合していません。'
          : '施設の存在・営業時間・移動を、まだ外部の情報源と照合していません。AIが作った提案のままです。'}
      </p>
      {googleTotal > 0 && (
        <p className="text-sm">
          一部の予定には、部分修正の候補を確認したときの根拠（Google由来 {googleTotal}
          件）が付いています。旅程全体は、まだ照合していません。
        </p>
      )}
    </div>
  )
}

// 失敗・中止の通知。結果の通知（role="status"）とは別に、見逃さないよう role="alert" で伝える。
function Alert({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div role="alert" className="gt-notice" data-tone="error">
      <p className="flex items-center gap-2 font-black text-gt-warn">
        <span
          aria-hidden="true"
          className="inline-flex size-5 shrink-0 items-center justify-center rounded-[4px] bg-gt-warn text-xs text-white"
        >
          !
        </span>
        {title}
      </p>
      {children}
    </div>
  )
}

export function VerificationPanel({
  status,
  phase,
  interrupted,
  onVerify,
}: VerificationPanelProps) {
  const headingId = useId()
  const verifying = phase.phase === 'verifying'
  const failure = phase.phase === 'failed' ? phase.failure : null
  const failureGuidance = failure && verificationFailureGuidance[failure.kind]
  const google = googleSummary(status)
  // 以前の照合結果（Places・Routes）を表示しているときの、その照合日時。無ければ、根拠は未確認のまま。
  const previousCheckedAt =
    google && google.total > 0 && google.latestCheckedAt ? formatAt(google.latestCheckedAt) : null

  const label = verifying
    ? '確認しています…'
    : status.kind === 'verified' || status.kind === 'partial' || failure
      ? 'もう一度確認する'
      : '根拠を確認する'

  return (
    <section
      aria-labelledby={headingId}
      className="space-y-3 rounded-2xl border border-gt-rule bg-gt-paper p-4"
    >
      <h3 id={headingId} className="text-base font-semibold">
        根拠の確認
      </h3>
      {/* 結果の通知。読み上げるのは状態の1文だけにして、件数・範囲の説明は下に置く（毎回は読み上げない）。 */}
      <div role="status" aria-live="polite" aria-atomic="true">
        <StatusLine status={status} verifying={verifying} failed={failure !== null} />
      </div>
      {verifying ? (
        <p className="text-sm">確認中も、旅程を見たり、予定を固定したりできます。</p>
      ) : status.kind === 'verified' || status.kind === 'partial' ? (
        <VerifiedDetails summary={status.summary} partial={status.kind === 'partial'} />
      ) : (
        <UnverifiedDetails
          withdrawn={status.kind === 'withdrawn'}
          googleTotal={status.kind === 'unverified' ? (status.googleTotal ?? 0) : 0}
        />
      )}
      {!verifying && interrupted && (
        <Alert title={verificationInterruptedGuidance.title}>
          <p className="mt-1 text-sm">{verificationInterruptedGuidance.action}</p>
        </Alert>
      )}
      {!verifying && failure && failureGuidance && (
        <Alert title={`エラー：${failureGuidance.title}`}>
          <p className="mt-1 text-sm">{failureGuidance.action}</p>
          <p className="mt-1 text-sm">{failureStateNote(previousCheckedAt)}</p>
          <p className="mt-1 text-sm">詳細：{failure.message}</p>
        </Alert>
      )}
      <div className="space-y-1">
        {/* 実行中も同じ位置に残し（フォーカスを失わない）、押下は受け付けない。 */}
        <button
          type="button"
          aria-disabled={verifying}
          onClick={() => {
            if (!verifying) onVerify()
          }}
          className="min-h-12 w-full rounded-xl bg-gt-ink px-4 py-3 text-base font-semibold text-white aria-disabled:cursor-progress aria-disabled:opacity-60"
        >
          {label}
        </button>
        <p className="text-xs text-gt-muted">
          押すと、このアプリのサーバーへ、照合を1回依頼します。サーバーは、予定の数に応じて、外部の情報源（Google
          Maps Platform の Places・Routes）へ複数回問い合わせます。自動では行いません。
        </p>
        <p className="text-xs text-gt-muted">
          この操作は、旅程を確定・予約・保存するものではありません。旅程も変わりません。
        </p>
      </div>
    </section>
  )
}
