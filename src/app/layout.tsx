import type { Metadata } from "next"
import { Geist, Geist_Mono } from "next/font/google"
import { NuqsAdapter } from "nuqs/adapters/next/app"
import { ChatWidget } from "@/components/chat-widget"
import { SiteNav } from "@/components/site-nav"
import "./globals.css"

export const metadata: Metadata = {
  title: "Ping Monitor",
  description: "Pings httpbin.org on a timer and shows each response on a live dashboard.",
}

const RootLayout = ({ children }: LayoutProps<"/">) => (
  <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
    <body className="flex min-h-full flex-col">
      <NuqsAdapter>
        <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-6 px-4 py-8 sm:px-8">
          <SiteNav />
          <main className="flex flex-1 flex-col">{children}</main>
        </div>
        <ChatWidget />
      </NuqsAdapter>
    </body>
  </html>
)

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
})

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
})

export default RootLayout
