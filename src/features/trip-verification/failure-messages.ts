import type { VerificationFailureKind } from './api-client'

// 確認の最中に旅程の内容が変わり、確認を中止した（結果を反映しなかった）ときの案内。
// 通信の失敗ではないので、失敗の種類（VerificationFailureKind）とは分けて持つ。
export const verificationInterruptedGuidance = {
  title: '確認を中止しました：照合中に旅程の内容が変わりました',
  action:
    'この確認の結果は反映していません。最新の内容で照合し直してください。「根拠を確認する」を押すと、変更後の旅程を確認します。',
} as const

// 根拠の確認が失敗したときの見出しと、次にとれる行動の案内。
// 失敗しても旅程は変わらない。その点を、すべての案内で伝える。
// 表示中の根拠が「未確認」なのか「以前の照合結果」なのかは、失敗の種類では決まらないので、ここには書かない
// （failureStateNote で、表示中の状態に合わせて付ける）。
export const verificationFailureGuidance: Record<
  VerificationFailureKind,
  { title: string; action: string }
> = {
  external_service_error: {
    title: '外部の情報源に接続できず、根拠を確認できませんでした',
    action: '旅程はそのままです。時間をおいて、もう一度お試しください。',
  },
  invalid_request: {
    title: 'この旅程の内容では、根拠を確認できませんでした',
    action:
      '旅程はそのままです。予定の時刻が重なっていないかなどを見直すか、もう一度お試しください。',
  },
  payload_too_large: {
    title: '旅程のデータが大きすぎて、根拠を確認できませんでした',
    action: '旅程はそのままです。予定の数を減らして作り直すと、確認できる場合があります。',
  },
  service_unavailable: {
    title: '根拠の確認は現在利用できません',
    action: 'このサービスでは、根拠の確認を一時的に停止しています。旅程はそのまま使えます。',
  },
  unauthorized: {
    title: '認証、招待、またはアプリの検証が通らず、根拠を確認できませんでした',
    action:
      '認証の有効期限が切れているか、このアカウントでは利用できない可能性があります。旅程はそのままです。認証の状態を確認してから、もう一度お試しください。',
  },
  rate_limited: {
    title: '利用の回数が上限に達したため、根拠を確認できませんでした',
    action:
      '旅程はそのままです。しばらく時間をおいてから、もう一度お試しください。繰り返し押しても、上限は戻りません。',
  },
  auth_required: {
    title: '認証情報を取得できず、根拠の確認を送信しませんでした',
    action:
      '外部の情報源には問い合わせていません。旅程はそのままです。認証の状態を確認してから、もう一度お試しください。',
  },
  app_check_unavailable: {
    title: 'アプリの検証（App Check）を用意できず、根拠の確認を送信しませんでした',
    action:
      '外部の情報源には問い合わせていません。旅程はそのままです。設定の不足や、reCAPTCHAの失敗が考えられます。時間をおいてもう一度お試しください。',
  },
  interrupted: {
    title: '通信が中断されました',
    action: '旅程はそのままです。接続を確認して、もう一度お試しください。',
  },
  unexpected: {
    title: '予期しない応答があり、確認結果を採用しませんでした',
    action: '旅程はそのままです。時間をおいて、もう一度お試しください。',
  },
}

// 失敗したとき、いま表示している根拠がどういう状態かの1文。
// - 以前の照合結果が表示されている：その結果であること（と照合日時）、今回の確認は反映していないこと。
// - 表示している根拠がない：根拠は未確認のままであること。
// 「未確認のまま」と「以前の照合結果」を、同時には言わない。
export function failureStateNote(previousCheckedAt: string | null): string {
  return previousCheckedAt === null
    ? '根拠は未確認のままです。'
    : `表示中の根拠は、以前の照合結果です（${previousCheckedAt}時点）。今回の確認は反映していません。`
}
