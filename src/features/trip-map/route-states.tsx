// 旅程一覧の「生成中」「失敗・情報不足」の表示。完了応答とは別の、画面だけの状態。
// 読み上げ（live region）は呼び出し側の領域で行う。

export function RouteLoading() {
  return (
    <div className="rounded-2xl bg-gt-bg p-4 text-gt-ink">
      <p className="mb-4 text-sm font-bold">旅程を生成しています。しばらくお待ちください。</p>
      <ol aria-hidden="true" className="m-0 list-none p-0">
        {[0, 1, 2].map((item) => (
          <li key={item} className="relative flex">
            <div className="relative w-[68px] flex-none">
              <span className="absolute left-[30px] top-0 bottom-0 w-2 rounded-sm bg-gt-rule" />
              <span className="absolute left-5 top-5 size-7 rounded-full border-[5px] border-gt-rule bg-gt-paper" />
            </div>
            <div className="flex-1 pb-6 pr-5 pt-2">
              <div className="h-3 w-24 animate-pulse rounded bg-gt-rule motion-reduce:animate-none" />
              <div className="mt-2 h-6 w-48 animate-pulse rounded bg-gt-rule motion-reduce:animate-none" />
            </div>
          </li>
        ))}
      </ol>
    </div>
  )
}

export function RouteFailure({
  title,
  message,
  action,
  note,
}: {
  title: string
  message: string
  action?: string
  // 保持されているものがあれば、実際に保証できる範囲だけを書く（呼び出し側が責任を持つ）。
  note?: string
}) {
  return (
    <div role="alert" className="gt-notice" data-tone="error">
      <p className="flex items-center gap-2 font-black text-gt-warn">
        <span
          aria-hidden="true"
          className="inline-flex size-5 items-center justify-center rounded-[4px] bg-gt-warn text-xs text-white"
        >
          !
        </span>
        エラー：{title}
      </p>
      {action && <p className="mt-1 text-sm">{action}</p>}
      <p className="mt-1 text-sm">詳細：{message}</p>
      {note && <p className="mt-2 text-xs text-gt-muted">{note}</p>}
    </div>
  )
}
