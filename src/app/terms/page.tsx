import type { Metadata } from 'next'

import { LegalLinks } from '@/features/legal/legal-links'

export const metadata: Metadata = {
  title: '利用規約・プライバシー・Google Mapsについて | GroundTrip',
  description:
    'GroundTripの利用上の注意、Google Maps Platformの利用、入力内容の扱いについての説明です。',
}

// 一般公開の「利用規約・プライバシー・Google Mapsについて」ページ。
// 書くのは、この版のアプリが実際にしていること（事実）だけ。機能が増えたら、この文章も更新する。
// 保存期間・連絡先など、未確定の運用は書かない。
// ページ外側の配色（ダークモード）に左右されないよう、本文は白地・濃い文字の枠の中で完結させる。
export default function TermsPage() {
  return (
    <article className="rounded-md border border-[#D8D8D0] bg-white p-4 text-sm leading-relaxed text-[#1F1F1F]">
      <h1 className="text-xl font-semibold">利用規約・プライバシー・Google Mapsについて</h1>
      <p className="mt-2 text-[#5E5E5E]">
        この文章は、この版のアプリが実際に行うことを説明するものです。機能が増えたときは、あわせて更新します。
      </p>

      <section aria-labelledby="about" className="mt-6">
        <h2 id="about" className="text-base font-semibold">
          1. このアプリについて
        </h2>
        <p className="mt-2">
          GroundTripは、GDG DevFest Japan Hackathon
          2026向けの試作です。AIが作る旅程は「提案」です。外部の情報との照合は、現実の正しさや将来の営業を保証するものではありません。最終的な判断は、利用者ご自身で行ってください。
        </p>
      </section>

      <section aria-labelledby="google-maps" className="mt-6">
        <h2 id="google-maps" className="text-base font-semibold">
          2. Google Maps Platformの利用
        </h2>
        <p className="mt-2">
          照合の機能を有効にした環境では、このアプリは、旅程の地点や移動時間を外部の情報と照合し、Google
          Maps Platform（Places API、Routes API）の機能とコンテンツを利用します。
        </p>
        <p className="mt-2">
          Google
          Mapsの機能を利用するため、その利用には、次の文書が適用されます。いずれも、その時点の最新版が対象です。
        </p>
        <div className="mt-2">
          <LegalLinks includeSiteTerms={false} />
        </div>
        <p className="mt-2">
          Google由来の内容を表示する場合は、枠で他の内容と区別し、出典として「Google
          Maps」と表示します。
        </p>
      </section>

      <section aria-labelledby="privacy" className="mt-6">
        <h2 id="privacy" className="text-base font-semibold">
          3. プライバシー
        </h2>
        <ul className="mt-2 list-disc space-y-1.5 pl-5">
          <li>
            この版のアプリは、旅行先・日付・希望条件・固定予定・感想などの入力を、旅程や学びの候補の生成のために、AI（Google
            CloudのVertex
            AI上のGemini）へ送ります。また、照合の機能を有効にした環境では、旅程の地点名などを検索語として、Google
            Maps Platformへ送ります。
          </li>
          <li>この版のアプリは、位置情報を取得しません。常時の位置追跡もしません。</li>
          <li>
            この版のアプリは、Google由来の情報を保存しません。ただし、場所の識別子（Place
            ID）は除きます。
          </li>
          <li>この版のアプリは、入力内容を、利用者のアカウントに保存しません。</li>
          <li>Google由来の内容は、AIの学習には使いません。</li>
        </ul>
        <p className="mt-2">
          Googleが受け取った情報の扱いは、Googleプライバシーポリシーに従います。
        </p>
      </section>

      <section aria-labelledby="contact" className="mt-6">
        <h2 id="contact" className="text-base font-semibold">
          4. お問い合わせ・変更
        </h2>
        <p className="mt-2">
          提出版のため、連絡先は、提出資料を参照してください。この文章を変更したときは、このページを更新します。
        </p>
      </section>
    </article>
  )
}
