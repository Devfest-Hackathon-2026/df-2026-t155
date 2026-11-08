// 同じ種類の取得が重なったとき、最新の要求の結果だけを画面に採用するための札。
//
// - begin() は新しい要求の札を返す。後から begin() された要求があれば、先の札は isCurrent() が false になる
//   （遅れて届いた古い応答で、新しい結果を上書きしない。先の通信は中止しない）。
// - cancel() は、進行中のすべての要求を中止し、結果を採用しない（セッションの切り替え・画面の破棄）。
//   cancel() の後に begin() した要求は、新しい中止信号を使う。
export type RequestTicket = Readonly<{
  // cancel() で中止される信号。通信に渡す。
  signal: AbortSignal
  // この要求の結果を、いま採用してよいか。
  isCurrent: () => boolean
}>

export type RequestGate = Readonly<{
  begin: () => RequestTicket
  cancel: () => void
}>

export function createRequestGate(): RequestGate {
  let latest = 0
  let controller = new AbortController()
  return {
    begin() {
      const mine = ++latest
      const { signal } = controller
      return { signal, isCurrent: () => mine === latest }
    },
    cancel() {
      latest += 1
      controller.abort()
      controller = new AbortController()
    },
  }
}
