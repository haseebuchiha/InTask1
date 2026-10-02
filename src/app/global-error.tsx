"use client"

import type { ErrorInfo } from "next/error"
import { Button } from "@/components/ui/button"
import "./globals.css"

const GlobalError = ({ retry }: ErrorInfo) => (
  <html lang="en" className="h-full antialiased">
    <body className="flex min-h-full flex-col">
      <title>Something went wrong · Ping Monitor</title>
      <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col items-start gap-4 px-4 py-8 sm:px-8">
        <h1 className="text-2xl font-semibold tracking-tight">Something went wrong</h1>
        <p className="text-muted-foreground">The ping monitor couldn’t load. Try again in a moment.</p>
        <Button onClick={retry}>Try again</Button>
      </main>
    </body>
  </html>
)

export default GlobalError
