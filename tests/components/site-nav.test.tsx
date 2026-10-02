import { render, screen, within } from "@testing-library/react"
import { describe, expect, test, vi } from "vitest"
import { SiteNav } from "@/components/site-nav"

const { usePathname } = vi.hoisted(() => ({ usePathname: vi.fn<() => string>() }))

vi.mock("next/navigation", () => ({ usePathname }))

const renderAt = (pathname: string) => {
  usePathname.mockReturnValue(pathname)
  render(<SiteNav />)
}

const currentLinkNames = () =>
  screen
    .getAllByRole("link")
    .filter((link) => link.getAttribute("aria-current") === "page")
    .map((link) => link.textContent)

describe("SiteNav", () => {
  test("links to the dashboard and the incidents page, and not to a chat page", () => {
    renderAt("/")
    const navigation = screen.getByRole("navigation", { name: "Site" })
    expect(
      within(navigation)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["Dashboard", "/"],
      ["Incidents", "/incidents"],
    ])
  })

  test.each([
    ["/", "Dashboard"],
    ["/pings/12", "Dashboard"],
    ["/incidents", "Incidents"],
    ["/incidents/4", "Incidents"],
  ])("on %s marks only %s as the current page", (pathname, currentName) => {
    renderAt(pathname)
    expect(currentLinkNames()).toEqual([currentName])
  })

  test("marks no link on a page outside every section", () => {
    renderAt("/somewhere-else")
    expect(currentLinkNames()).toEqual([])
  })
})
