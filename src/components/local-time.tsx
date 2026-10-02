"use client"

import { useSyncExternalStore } from "react"

export const LocalTime = ({ isoTime }: { isoTime: string }) => {
  const isHydrated = useSyncExternalStore(subscribeToHydration, readHydratedInBrowser, readHydratedOnServer)
  return <time dateTime={isoTime}>{isHydrated ? formatLocalTime(isoTime) : formatUtcTime(isoTime)}</time>
}

const formatLocalTime = (isoTime: string) => localTimeFormat.format(new Date(isoTime))

const formatUtcTime = (isoTime: string) => `${utcTimeFormat.format(new Date(isoTime))} UTC`

const subscribeToHydration = () => stopNothing

const stopNothing = () => undefined

const readHydratedInBrowser = () => true

const readHydratedOnServer = () => false

const localTimeFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "medium" })

const utcTimeFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" })
