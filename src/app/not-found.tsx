import { ArrowLeftIcon } from "lucide-react"
import Link from "next/link"
import { buttonVariants } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const NotFound = () => (
  <div className="flex flex-col items-start gap-4">
    <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
    <p className="text-muted-foreground">
      There’s nothing at this address. It may have been deleted, or the link has a typo.
    </p>
    <Link href="/" className={cn(buttonVariants({ variant: "outline" }))}>
      <ArrowLeftIcon data-icon="inline-start" />
      Back to all pings
    </Link>
  </div>
)

export default NotFound
