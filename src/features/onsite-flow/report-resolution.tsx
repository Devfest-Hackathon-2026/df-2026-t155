'use client'
import { useEffect, useRef, useState } from 'react'
import type { scopedReportControl } from './onsite-persistence'

type Control = ReturnType<typeof scopedReportControl>
type Report = Awaited<ReturnType<Control['load']>>

function ReportResolutionInner({
  tripId,
  stopId,
  tripVersion,
  control,
  onResolved,
}: {
  tripId: string
  stopId: string
  tripVersion: number
  control: Control
  onResolved: () => void
}) {
  const [report, setReport] = useState<Report | null>(null)
  const [message, setMessage] = useState('')
  const busy = useRef<AbortController | null>(null)
  useEffect(() => () => busy.current?.abort(), [])
  const check = async () => {
    if (busy.current) return
    const controller = new AbortController()
    busy.current = controller
    setReport(null)
    try {
      const value = await control.load(tripId, stopId, controller.signal)
      if (!controller.signal.aborted && value.tripVersion !== tripVersion) {
        setMessage('旅程が更新されました。最新の旅程を開いて確認してください。')
        return
      }
      if (!controller.signal.aborted) {
        setReport(value)
        setMessage(
          value.blocked
            ? '本人報告による保留があります。内容を確認し、解消する場合だけ操作してください。'
            : '本人報告による保留はありません。',
        )
      }
    } catch {
      if (!controller.signal.aborted) setMessage('報告の状態を確認できませんでした。')
    } finally {
      if (busy.current === controller) busy.current = null
    }
  }
  const resolve = async () => {
    if (!report?.blocked || busy.current) return
    const controller = new AbortController()
    busy.current = controller
    setReport(null)
    try {
      const value = await control.resolve(
        tripId,
        stopId,
        report.tripVersion,
        report.reportVersion,
        controller.signal,
      )
      if (
        !controller.signal.aborted &&
        !value.blocked &&
        value.reportVersion > report.reportVersion &&
        value.tripVersion === report.tripVersion
      )
        onResolved()
      else if (!controller.signal.aborted)
        setMessage('解消を確認できませんでした。報告の状態を確認し直してください。')
    } catch {
      if (!controller.signal.aborted)
        setMessage('解消結果を確認できません。報告の状態を確認し直してください。')
    } finally {
      if (busy.current === controller) busy.current = null
    }
  }
  return (
    <div className="space-y-2 text-sm">
      <button
        className="min-h-11 font-semibold underline"
        type="button"
        onClick={() => void check()}
      >
        本人報告の状態を確認する
      </button>
      <p role="status">{message}</p>
      {report?.blocked && (
        <button
          className="min-h-11 font-semibold underline"
          type="button"
          onClick={() => void resolve()}
        >
          本人報告の保留を解消する
        </button>
      )}
    </div>
  )
}

export function ReportResolution(props: Parameters<typeof ReportResolutionInner>[0]) {
  return (
    <ReportResolutionInner
      key={JSON.stringify([props.tripId, props.tripVersion, props.stopId])}
      {...props}
    />
  )
}
