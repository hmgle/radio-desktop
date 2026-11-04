// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CountryFlag, FacetSelect } from "./ui";
import { Service } from "../mygo";

vi.mock("../mygo", () => ({ Service: { countries: vi.fn() }, events: {} }));

afterEach(cleanup);

it.each(["CN", "DE", "UG", "TH", "ZA", "NP", "CH", "HK", "TW"])("bundles local artwork for %s", (code) => {
  const { container } = render(<CountryFlag code={code} />);
  const img = container.querySelector("img");
  expect(img).not.toBeNull();
  expect(img!.getAttribute("src")).toMatch(/^\/(?!\/).*\.svg/);
  expect(img!.alt).toBe("");
  expect(container.innerHTML).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u);
});

it("accepts lowercase and padded codes", () => {
  const { container, rerender } = render(<CountryFlag code=" de " />);
  const src = container.querySelector("img")!.src;
  rerender(<CountryFlag code="DE" />);
  expect(container.querySelector("img")!.src).toBe(src);
});

it("falls back to the ISO letters for a country without artwork", () => {
  const { container } = render(<CountryFlag code="zz" />);
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("ZZ");
});

it("falls back after an image error and loads artwork when the country changes", () => {
  const { container, rerender } = render(<CountryFlag code="DE" />);
  fireEvent.error(container.querySelector("img")!);
  expect(container.querySelector("img")).toBeNull();
  expect(container.textContent).toBe("DE");
  rerender(<CountryFlag code="CN" />);
  expect(container.querySelector("img")).not.toBeNull();
  expect(container.textContent).toBe("");
});

it("renders nothing for a missing or malformed code", () => {
  expect(render(<CountryFlag />).container.innerHTML).toBe("");
  expect(render(<CountryFlag code="" />).container.innerHTML).toBe("");
  expect(render(<CountryFlag code="chn" />).container.innerHTML).toBe("");
  expect(render(<CountryFlag code="C1" />).container.innerHTML).toBe("");
});

it("renders nothing for the unknown-country placeholder code", () => {
  expect(render(<CountryFlag code="XX" />).container.innerHTML).toBe("");
  expect(render(<CountryFlag code="xx" />).container.innerHTML).toBe("");
});

it("keeps the country label and selection accessible in a facet with a decorative flag", async () => {
  const label = "A country with a very long descriptive name";
  vi.mocked(Service.countries).mockResolvedValue([{ value: "UG", label, count: 12 }]);
  const onChange = vi.fn();
  render(<FacetSelect kind="country" label="国家/地区" value="" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "国家/地区" }));
  const option = await screen.findByRole("button", { name: new RegExp(label) });
  expect(option.querySelector("img")).not.toBeNull();
  fireEvent.click(option);
  expect(onChange).toHaveBeenCalledWith("UG", label);
});

// Keyboard selection used to leave focus in the removed popup.
it("navigates facet options with arrows and returns focus on selection or Escape", async () => {
  vi.mocked(Service.countries).mockResolvedValue([
    { value: "DE", label: "Germany", count: 2 },
    { value: "UG", label: "Uganda", count: 1 },
  ]);
  const onChange = vi.fn();
  render(<FacetSelect kind="country" label="Country" value="" onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "Country" });
  trigger.focus();
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const first = await screen.findByRole("button", { name: /Germany/ });
  const search = screen.getByRole("textbox");
  expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "ArrowDown" });
  const second = screen.getByRole("button", { name: /Uganda/ });
  expect(document.activeElement).toBe(second);
  fireEvent.click(second);
  expect(onChange).toHaveBeenCalledWith("UG", "Uganda");
  expect(document.activeElement).toBe(trigger);
  expect(screen.queryByRole("dialog")).toBeNull();
  fireEvent.click(trigger);
  fireEvent.keyDown(screen.getByRole("textbox"), { key: "Escape" });
  expect(document.activeElement).toBe(trigger);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
});

it("closes a facet when focus tabs out without pulling focus back", async () => {
  vi.mocked(Service.countries).mockResolvedValue([]);
  render(<><FacetSelect kind="country" label="Country" value="" onChange={() => {}} /><button>Next</button></>);
  fireEvent.click(screen.getByRole("button", { name: "Country" }));
  const next = screen.getByRole("button", { name: "Next" });
  next.focus();
  expect(document.activeElement).toBe(next);
  await vi.waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
});

// macOS WebKit gives no focus to a clicked <button> (webkit.org/b/229895), so
// pressing an option blurs the search box with relatedTarget === null. Closing
// on that blur unmounted the option before its click was dispatched, which made
// every option look unresponsive on macOS only.
it("selects an option when the platform drops focus on mousedown", async () => {
  vi.mocked(Service.countries).mockResolvedValue([
    { value: "DE", label: "Germany", count: 2 },
    { value: "CN", label: "China", count: 7 },
  ]);
  const onChange = vi.fn();
  render(<FacetSelect kind="country" label="Country" value="" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Country" }));
  const search = screen.getByRole("textbox");
  const option = await screen.findByRole("button", { name: /Germany/ });
  expect(document.activeElement).toBe(search);

  fireEvent.mouseDown(option);
  fireEvent.focusOut(search, { relatedTarget: null });
  expect(screen.queryByRole("dialog")).not.toBeNull();

  fireEvent.click(option);
  expect(onChange).toHaveBeenCalledWith("DE", "Germany");
  expect(onChange).toHaveBeenCalledTimes(1);
});

it("still closes a facet when the pointer presses outside it", async () => {
  vi.mocked(Service.countries).mockResolvedValue([]);
  render(<FacetSelect kind="country" label="Country" value="" onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Country" }));
  expect(screen.queryByRole("dialog")).not.toBeNull();
  fireEvent.mouseDown(document.body);
  expect(screen.queryByRole("dialog")).toBeNull();
});
