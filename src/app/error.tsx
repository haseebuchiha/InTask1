"use client"

import type { ErrorInfo } from "next/error"
import { Button } from "@/components/ui/button"

const ErrorPage = ({ error, retry }: ErrorInfo) => {
  const digest = readDigest(error)
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
      <p className="text-muted-foreground">
        The pings couldn’t be loaded. The database may be unreachable for a moment. Try again, and if it keeps failing,
        check the server logs.
      </p>
      {digest && <p className="font-mono text-xs text-muted-foreground">Error reference: {digest}</p>}
      <Button onClick={retry}>Try again</Button>
    </div>
  )
}

const readDigest = (error: unknown) => (error instanceof Error && "digest" in error ? String(error.digest) : null)

export default ErrorPage
