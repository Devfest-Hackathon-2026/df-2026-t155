import {
  readManualReplay,
  type ManualRecoveryAction,
  type UnresolvedApply,
} from './unresolved-apply'

export function ManualApplyRecoveryActions({
  ownerUid,
  tripId,
  pending,
  busy,
  onRecover,
}: {
  ownerUid: string
  tripId: string
  pending: UnresolvedApply
  busy: boolean
  onRecover: (action: ManualRecoveryAction) => void
}) {
  return (
    <div className="grid gap-1">
      {readManualReplay(ownerUid, tripId, pending) && (
        <button
          type="button"
          className="min-h-11 text-left font-bold underline"
          disabled={busy}
          onClick={() => onRecover('retry')}
        >
          同じ承認内容で再送する
        </button>
      )}
      <button
        type="button"
        className="min-h-11 text-left font-bold underline"
        disabled={busy}
        onClick={() => onRecover('cancel')}
      >
        適用を確認し、未確定なら取り消す
      </button>
    </div>
  )
}
