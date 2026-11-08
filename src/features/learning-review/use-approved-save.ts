import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { ApprovedLearning } from '@/domain'

import type { LearningStore, SaveResult } from './store'

// 承認済みの学びの「保存」の状態。承認（本人の判断）とは別の状態として扱う。
// - 承認しただけでは、保存済みにならない。保存は、利用者が押す明示的な操作で行う。
// - 保存済みかどうかは、保存に成功した時点の承認済みの内容と、いまの内容を比べて決める。
//   保存のあとに承認済みの内容が変われば、自動的に「未保存の変更あり」に戻る。

export type SaveStatus =
  | { kind: 'saving' }
  | { kind: 'saved'; count: number }
  | { kind: 'unsaved'; count: number }
  // 承認済みが0件で、保存した内容もない。
  | { kind: 'empty' }
  // savedIds は、失敗するまでに保存できた学びのうち、いまの承認済みに含まれるもの（保存先が返したときだけ）。
  // unknownIds は、保存できたかどうか分からない学びのうち、いまの承認済みに含まれるもの（保存先が返したときだけ）。
  // retryable が false のときは、同じ内容で保存し直しても結果が変わらない。
  | {
      kind: 'failed'
      message: string
      count: number
      savedIds?: readonly string[]
      unknownIds?: readonly string[]
      retryable: boolean
    }

type SavePhase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | {
      kind: 'failed'
      key: string
      message: string
      savedIds?: readonly string[]
      unknownIds?: readonly string[]
      retryable: boolean
    }

function sameApproved(a: ApprovedLearning, b: ApprovedLearning): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

const DEFAULT_FAILURE = '時間をおいて、もう一度お試しください。'
const EMPTY_NOTICE =
  '保存できる承認済みの学びがありません。学びの候補を承認してから、保存してください。'

interface Options {
  store: LearningStore | undefined
  approved: ApprovedLearning[]
  // 承認済みの内容を表す文字列（内容が同じなら同じ値）。
  approvedKey: string
  // 旅程と地域の組。変わったら、保存の状態を消し、進行中の保存を中止する。
  scopeKey: string
  canSave: boolean
  // 常設のライブリージョンへ通知する。
  announce: (text: string) => void
}

export function useApprovedSave({
  store,
  approved,
  approvedKey,
  scopeKey,
  canSave,
  announce,
}: Options) {
  const [phase, setPhase] = useState<SavePhase>({ kind: 'idle' })
  // 最後に保存に成功したときの、承認済みの内容。
  const [savedKey, setSavedKey] = useState<string | null>(null)
  // 承認済みが0件のまま保存を押されたときの案内。
  const [notice, setNotice] = useState('')
  const [unresolvedUnknowns, setUnresolvedUnknowns] = useState<ApprovedLearning[]>([])
  const [lastSession, setLastSession] = useState({ scopeKey, store })

  const controllerRef = useRef<AbortController | null>(null)
  const operationScopeRef = useRef({ scopeKey, store })
  // 二重送信の即時ロック（状態の更新は非同期のため、refで確実に止める）。
  const inFlightRef = useRef(false)
  // 最新の保存の応答だけを採用するための通し番号。
  const seqRef = useRef(0)
  const approvedKeyRef = useRef(approvedKey)
  useLayoutEffect(() => {
    approvedKeyRef.current = approvedKey
  })

  // 別の旅程・地域になったら、保存の状態を消す（描画中の状態調整）。
  if (scopeKey !== lastSession.scopeKey || store !== lastSession.store) {
    setLastSession({ scopeKey, store })
    setPhase({ kind: 'idle' })
    setSavedKey(null)
    setNotice('')
    setUnresolvedUnknowns([])
  }

  // 認証確認中は保存を中断するが、同じ旅程・保存先なら送信済みの結果を受け取る。
  // 旅程・保存先が変わった場合だけ、古い結果を破棄する（コミットと同時に行う）。
  useLayoutEffect(() => {
    const scopeChanged =
      scopeKey !== operationScopeRef.current.scopeKey || store !== operationScopeRef.current.store
    operationScopeRef.current = { scopeKey, store }
    if (canSave && !scopeChanged) return
    controllerRef.current?.abort()
    if (!scopeChanged) return
    controllerRef.current = null
    seqRef.current += 1
    inFlightRef.current = false
    setPhase((current) => (current.kind === 'saving' ? { kind: 'idle' } : current))
  }, [canSave, scopeKey, store])
  // 画面を閉じるときも、進行中の保存を中止する。
  useEffect(
    () => () => {
      controllerRef.current?.abort()
      seqRef.current += 1
    },
    [],
  )

  // 承認済みが増えたら、0件のときの案内は消す。
  if (notice && approved.length > 0) setNotice('')

  const status: SaveStatus = (() => {
    if (phase.kind === 'saving') return { kind: 'saving' }
    // 以前に保存した内容があるときは、0件になっても「未保存の変更あり」とする（保存した内容とは違うため）。
    if (approved.length === 0 && savedKey === null) return { kind: 'empty' }
    if (phase.kind === 'failed' && phase.key === approvedKey) {
      // 保存済みと示すのは、いまの承認済みに含まれる学びだけ（承認済みの内容は、失敗の時点から変わっていない）。
      const savedIds = phase.savedIds
        ? approved.map((item) => item.id).filter((id) => phase.savedIds?.includes(id))
        : undefined
      const unknownIds = phase.unknownIds
        ? approved.map((item) => item.id).filter((id) => phase.unknownIds?.includes(id))
        : undefined
      return {
        kind: 'failed',
        message: phase.message,
        count: approved.length,
        savedIds,
        unknownIds,
        retryable: phase.retryable,
      }
    }
    if (savedKey === approvedKey) return { kind: 'saved', count: approved.length }
    return { kind: 'unsaved', count: approved.length }
  })()

  // 保存済みだった内容が変わったら、その変化を通知する（見た目だけで伝えない）。
  const wasSavedRef = useRef(false)
  const statusKind = status.kind
  useEffect(() => {
    if (wasSavedRef.current && statusKind === 'unsaved') {
      announce('承認済みの内容が変わりました。未保存の変更があります。')
    }
    wasSavedRef.current = statusKind === 'saved'
  }, [statusKind, announce])

  const save = useCallback(async () => {
    if (!canSave || !store) return
    if (inFlightRef.current) return
    // ボタンは常に押せるようにし、保存するものが無いときは、理由を案内する。
    if (approved.length === 0) {
      setNotice(EMPTY_NOTICE)
      announce(EMPTY_NOTICE)
      return
    }
    setNotice('')

    inFlightRef.current = true
    const seq = (seqRef.current += 1)
    const controller = new AbortController()
    controllerRef.current = controller
    const submittedKey = approvedKey
    const count = approved.length
    setPhase({ kind: 'saving' })
    announce('承認した学びを保存しています。')

    let result: SaveResult
    try {
      result = await store.save(approved, { signal: controller.signal })
    } catch {
      result = { ok: false, message: '' }
    }

    // 別の旅程・保存先や、新しい保存の結果は混ぜない。
    // 同じ認証セッションでの一時中断は、送信済みの保存結果（結果不明を含む）を保持する。
    if (seq !== seqRef.current) return
    inFlightRef.current = false
    controllerRef.current = null

    if (result.ok === true) {
      setSavedKey(submittedKey)
      setPhase({ kind: 'idle' })
      setUnresolvedUnknowns((previous) =>
        previous.filter(
          (unknown) => !approved.some((submitted) => sameApproved(unknown, submitted)),
        ),
      )
      announce(
        approvedKeyRef.current === submittedKey
          ? `承認した学び${count}件を保存しました。`
          : '保存しましたが、保存の間に承認済みの内容が変わったため、未保存の変更があります。',
      )
      return
    }
    // 失敗しても、承認済みの内容と入力中の内容は残す。失敗は、再試行できる。
    // 失敗の通知は、role="alert"（画面側）が担うため、ライブリージョンには入れない。
    const reason = result.message || DEFAULT_FAILURE
    setUnresolvedUnknowns((previous) => {
      const confirmed = new Set(result.savedIds ?? [])
      const remaining = previous.filter(
        (unknown) =>
          !approved.some(
            (submitted) => confirmed.has(submitted.id) && sameApproved(unknown, submitted),
          ),
      )
      for (const learning of approved) {
        if (!result.unknownIds?.includes(learning.id)) continue
        if (!remaining.some((unknown) => sameApproved(unknown, learning))) remaining.push(learning)
      }
      return remaining
    })
    setPhase({
      kind: 'failed',
      key: submittedKey,
      message: reason,
      savedIds: result.savedIds,
      unknownIds: result.unknownIds,
      retryable: result.retryable !== false,
    })
  }, [store, approved, approvedKey, canSave, announce])

  return { status, notice, save, unresolvedUnknowns }
}
