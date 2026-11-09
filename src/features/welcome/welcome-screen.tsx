'use client'

import Image from 'next/image'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useRef, useState } from 'react'

import { completeWelcome } from './welcome-entry'

export function WelcomeScreen() {
  const router = useRouter()
  const starting = useRef(false)
  const [disabled, setDisabled] = useState(false)

  const start = () => {
    if (starting.current) return
    starting.current = true
    setDisabled(true)
    completeWelcome()
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion) {
      router.replace('/')
      return
    }
    window.setTimeout(() => router.replace('/'), 220)
  }

  return (
    <section
      className={`gt-welcome-screen fixed inset-0 z-50 isolate grid min-h-dvh place-items-center overflow-hidden bg-[#273e3d] text-white${disabled ? ' gt-welcome-exit' : ''}`}
      aria-labelledby="welcome-title"
      data-welcome-screen
    >
      <Image
        src="/images/nagoya/castle.webp"
        alt=""
        fill
        priority
        sizes="(max-aspect-ratio: 4/3) 134vh, 100vw"
        className="gt-welcome-image object-cover"
        style={{ objectPosition: 'center 42%' }}
      />
      <div
        aria-hidden="true"
        className="absolute inset-0 bg-gradient-to-b from-[#142b2b]/15 via-[#142b2b]/15 to-[#142b2b]/75"
      />

      <div className="relative z-10 flex min-h-dvh w-full max-w-3xl flex-col items-center justify-between px-5 pt-[max(1.5rem,env(safe-area-inset-top))] pb-[max(1.5rem,env(safe-area-inset-bottom))] text-center sm:px-8">
        <div className="self-end drop-shadow-[0_1px_5px_rgb(255_255_255/75%)]">
          <Image
            src="/brand/groundtrip-logo.png"
            alt="GroundTrip"
            width={150}
            height={119}
            priority
            className="h-[4.65rem] w-auto"
          />
        </div>

        <div className="my-auto flex w-full flex-col items-center pb-8 pt-10">
          <p className="mb-3 text-xs font-semibold tracking-[0.16em] text-white/90 sm:text-sm">
            旅を見つける、つくる、楽しむ
          </p>
          <h1
            id="welcome-title"
            className="text-4xl leading-[1.18] font-bold tracking-wide text-white [text-shadow:0_2px_18px_rgb(0_0_0/35%)] sm:text-5xl"
          >
            次の旅は、
            <br />
            名古屋から。
          </h1>
        </div>

        <div className="flex w-full flex-col items-center gap-3">
          <button
            type="button"
            className="min-h-12 w-full max-w-sm rounded-full bg-[#cf4c2f] px-6 py-3 text-base font-bold text-white shadow-lg transition-colors hover:bg-[#b63e27] focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-white disabled:opacity-70"
            disabled={disabled}
            onClick={start}
          >
            旅をはじめる
          </button>
          <p className="max-w-md text-xs leading-relaxed text-white/90">
            デモの旅程や学びは利用者間で共有されます。個人情報は入力しないでください。
          </p>
          <Link
            href="/terms"
            className="min-h-11 content-center px-3 text-xs text-white/90 underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-white"
          >
            利用条件・プライバシー
          </Link>
        </div>
      </div>
    </section>
  )
}
