import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import ErrorPage from "@/app/error"

const serverError = Object.assign(new Error("An error occurred in the Server Components render."), {
  digest: "1234567890",
})

describe("ErrorPage", () => {
  test("explains that the pings could not load and shows the error reference", () => {
    render(<ErrorPage error={serverError} retry={vi.fn()} reset={vi.fn()} />)
    expect(screen.getByRole("heading", { name: "Something went wrong" })).toBeDefined()
    expect(screen.getByText(/database may be unreachable/)).toBeDefined()
    expect(screen.getByText("Error reference: 1234567890")).toBeDefined()
  })

  test("leaves out the reference when the error has no digest", () => {
    render(<ErrorPage error={new Error("Network down")} retry={vi.fn()} reset={vi.fn()} />)
    expect(screen.queryByText(/Error reference/)).toBeNull()
  })

  test("Try again calls retry so Next re-fetches and re-renders the page", () => {
    const retry = vi.fn()
    const reset = vi.fn()
    render(<ErrorPage error={serverError} retry={retry} reset={reset} />)
    fireEvent.click(screen.getByRole("button", { name: "Try again" }))
    expect(retry).toHaveBeenCalledOnce()
    expect(reset).not.toHaveBeenCalled()
  })
})
