// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CountryFlag, FacetSelect } from "./ui";
import { Service } from "../mygo";
import type { Facet } from "../mygo";
import { messages as m } from "../locales";
import { useState } from "react";

vi.mock("../mygo", () => ({ Service: { countries: vi.fn() }, events: {} }));

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

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

it("queries a Chinese country prefix and selects its original code", async () => {
  vi.mocked(Service.countries).mockImplementation(async (prefix) => prefix === "中" ? [
    { value: "CN", label: "china", count: 7 },
    { value: "CF", label: "central african republic", count: 2 },
  ] : []);
  const onChange = vi.fn();
  render(<FacetSelect kind="country" label="Country" value="" onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "Country" });
  fireEvent.click(trigger);
  const search = screen.getByRole("textbox");
  expect(search.getAttribute("placeholder")).toBe(m.searchCountryPrefix());
  fireEvent.change(search, { target: { value: "中" } });
  const china = await screen.findByRole("button", { name: /china/ });
  expect(Service.countries).toHaveBeenLastCalledWith("中");
  expect(screen.queryByRole("button", { name: /central african republic/ })).not.toBeNull();
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toBe(china);
  fireEvent.click(china);
  expect(onChange).toHaveBeenCalledWith("CN", "china");
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it("localizes country options and the selection when the interface language changes", async () => {
  const runtime = { locale: "zh-CN" };
  vi.stubGlobal("mygo", runtime);
  vi.mocked(Service.countries).mockResolvedValue([
    { value: "CN", label: "china", labelZh: "中国", count: 7 },
    { value: "CF", label: "central african republic", labelZh: "中非共和国", count: 2 },
    { value: "QZ", label: "Unrecognized upstream name", count: 1 },
    { value: "ZZ", label: "", count: 1 },
  ]);
  const onChange = vi.fn();
  function CountryFilter() {
    const [selected, setSelected] = useState({ value: "", label: "" });
    return <FacetSelect kind="country" label={m.country()} value={selected.value} display={selected.label}
      onChange={(value, label) => { onChange(value, label); setSelected({ value, label }); }} />;
  }
  const { rerender } = render(<CountryFilter />);
  fireEvent.click(screen.getByRole("button", { name: "国家/地区" }));
  const china = await screen.findByRole("button", { name: /^中国 \(CN\)/ });
  expect(china.textContent).toContain("7");
  expect(screen.queryByRole("button", { name: /^中非共和国 \(CF\)/ })).not.toBeNull();
  expect(screen.queryByRole("button", { name: /Unrecognized upstream name/ })).not.toBeNull();
  expect(screen.queryByRole("button", { name: /^ZZ/ })).not.toBeNull();
  fireEvent.click(china);
  expect(onChange).toHaveBeenCalledWith("CN", "china");
  expect(screen.queryByRole("button", { name: "国家/地区: 中国 (CN)" })).not.toBeNull();

  runtime.locale = "en";
  rerender(<CountryFilter />);
  const trigger = screen.getByRole("button", { name: "Country: china" });
  fireEvent.click(trigger);
  const englishOption = await within(screen.getByRole("dialog")).findByRole("button", { name: /^china/ });
  englishOption.focus();
  runtime.locale = "zh-CN";
  rerender(<CountryFilter />);
  expect(within(screen.getByRole("dialog")).getByRole("button", { name: /^中国 \(CN\)/ })).toBe(englishOption);
  expect(document.activeElement).toBe(englishOption);
  expect(screen.queryByRole("button", { name: "国家/地区: 中国 (CN)" })).not.toBeNull();
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

it("removes the facet popup before restoring focus to its trigger", async () => {
  vi.mocked(Service.countries).mockResolvedValue([{ value: "DE", label: "Germany", count: 2 }]);
  render(<FacetSelect kind="country" label="Country" value="" onChange={() => {}} />);
  const trigger = screen.getByRole("button", { name: "Country" });
  fireEvent.click(trigger);
  const option = await screen.findByRole("button", { name: /Germany/ });
  option.focus();
  const focus = trigger.focus.bind(trigger);
  let popupRemoved = false;
  const spy = vi.spyOn(trigger, "focus").mockImplementation(() => {
    popupRemoved = screen.queryByRole("dialog") === null;
    focus();
  });
  fireEvent.click(option);
  expect(spy).toHaveBeenCalled();
  expect(popupRemoved).toBe(true);
  expect(document.activeElement).toBe(trigger);
  spy.mockRestore();
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

// The null-relatedTarget exemption only covers a press in flight; a real focus
// loss (window deactivation, tabbing out of the document) must still close.
it("closes a facet when focus leaves without a press inside it", async () => {
  vi.mocked(Service.countries).mockResolvedValue([]);
  render(<FacetSelect kind="country" label="Country" value="" onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Country" }));
  fireEvent.focusOut(screen.getByRole("textbox"), { relatedTarget: null });
  expect(screen.queryByRole("dialog")).toBeNull();
});

// Typing used to blank the list for the debounce window plus one round trip,
// so the first press after typing landed on the loading placeholder and only
// the second press hit a row that existed again.
it("keeps the previous options on screen while a new prefix loads", async () => {
  let resolvePrefix: (rows: Facet[]) => void = () => {};
  vi.mocked(Service.countries)
    .mockResolvedValueOnce([{ value: "DE", label: "Germany", count: 2 }])
    .mockImplementationOnce(() => new Promise<Facet[]>((resolve) => { resolvePrefix = resolve; }));

  render(<FacetSelect kind="country" label="Country" value="" onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Country" }));
  await screen.findByRole("button", { name: /Germany/ }, { timeout: 3000 });

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "gr" } });
  expect(screen.queryByRole("button", { name: /Germany/ })).not.toBeNull();

  await vi.waitFor(() => expect(Service.countries).toHaveBeenCalledTimes(2), { timeout: 3000 });
  resolvePrefix([{ value: "GR", label: "Greece", count: 4 }]);
  await screen.findByRole("button", { name: /Greece/ }, { timeout: 3000 });
  expect(screen.queryByRole("button", { name: /Germany/ })).toBeNull();
});

// A result that lands between press and release used to replace the pressed
// row, so the click was dispatched at nothing and the popup just stayed open.
it("holds the pressed option until its click is delivered", async () => {
  let resolveNext: (rows: Facet[]) => void = () => {};
  vi.mocked(Service.countries)
    .mockResolvedValueOnce([
      { value: "DE", label: "Germany", count: 2 },
      { value: "GR", label: "Greece", count: 4 },
    ])
    .mockImplementationOnce(() => new Promise<Facet[]>((resolve) => { resolveNext = resolve; }));

  const onChange = vi.fn();
  render(<FacetSelect kind="country" label="Country" value="" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Country" }));
  const germany = await screen.findByRole("button", { name: /Germany/ }, { timeout: 3000 });

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "gr" } });
  await vi.waitFor(() => expect(Service.countries).toHaveBeenCalledTimes(2), { timeout: 3000 });

  fireEvent.mouseDown(germany);
  resolveNext([{ value: "FR", label: "France", count: 1 }]);
  // Let the in-flight request settle while the button is still pressed.
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole("button", { name: /Germany/ })).not.toBeNull();
  expect(screen.queryByRole("button", { name: /France/ })).toBeNull();

  fireEvent.pointerUp(germany);
  fireEvent.click(germany);
  expect(onChange).toHaveBeenCalledWith("DE", "Germany");
});

// Dropping the focused option left activeElement on <body>, so the arrow keys
// and Enter stopped working until the popup was reopened.
it("returns focus to the search box when the focused option disappears", async () => {
  let resolveNext: (rows: Facet[]) => void = () => {};
  vi.mocked(Service.countries)
    .mockResolvedValueOnce([
      { value: "DE", label: "Germany", count: 2 },
      { value: "GR", label: "Greece", count: 4 },
    ])
    .mockImplementationOnce(() => new Promise<Facet[]>((resolve) => { resolveNext = resolve; }));

  render(<FacetSelect kind="country" label="Country" value="" onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Country" }));
  const search = screen.getByRole("textbox");
  const germany = await screen.findByRole("button", { name: /Germany/ }, { timeout: 3000 });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toBe(germany);

  fireEvent.change(search, { target: { value: "fr" } });
  await vi.waitFor(() => expect(Service.countries).toHaveBeenCalledTimes(2), { timeout: 3000 });
  resolveNext([{ value: "FR", label: "France", count: 1 }]);
  await screen.findByRole("button", { name: /France/ }, { timeout: 3000 });

  expect(document.activeElement).toBe(search);
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /France/ }));
});

// The error branch used to bypass the deferred update: showing the error in
// place of the rows unmounted the button under the pointer.
it("shows the error when the very first facet query fails", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  vi.mocked(Service.countries).mockRejectedValueOnce(new Error("offline"));
  render(<FacetSelect kind="country" label="Country" value="" onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Country" }));
  await screen.findByText(m.loadFailed(), {}, { timeout: 3000 });
  expect(screen.getAllByText(m.loadFailed())).toHaveLength(1);
  errorLog.mockRestore();
});

it("keeps the pressed option when a prefix query fails", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  let rejectNext: (reason: Error) => void = () => {};
  vi.mocked(Service.countries)
    .mockResolvedValueOnce([
      { value: "DE", label: "Germany", count: 2 },
      { value: "FR", label: "France", count: 1 },
    ])
    .mockImplementationOnce(() => new Promise<Facet[]>((_resolve, reject) => { rejectNext = reject; }));

  const onChange = vi.fn();
  render(<FacetSelect kind="country" label="Country" value="" onChange={onChange} />);
  fireEvent.click(screen.getByRole("button", { name: "Country" }));
  const germany = await screen.findByRole("button", { name: /Germany/ }, { timeout: 3000 });

  fireEvent.change(screen.getByRole("textbox"), { target: { value: "ge" } });
  await vi.waitFor(() => expect(Service.countries).toHaveBeenCalledTimes(2), { timeout: 3000 });

  fireEvent.mouseDown(germany);
  rejectNext(new Error("offline"));
  await act(async () => { await Promise.resolve(); });
  expect(screen.queryByRole("button", { name: /Germany/ })).not.toBeNull();

  fireEvent.pointerUp(germany);
  fireEvent.click(germany);
  expect(onChange).toHaveBeenCalledWith("DE", "Germany");
  errorLog.mockRestore();
});

// An error must not blank the list or strand keyboard focus on <body>; the
// hint is added alongside the rows that are still usable.
it("keeps rows and keyboard focus when a prefix query fails", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
  let rejectNext: (reason: Error) => void = () => {};
  vi.mocked(Service.countries)
    .mockResolvedValueOnce([
      { value: "DE", label: "Germany", count: 2 },
      { value: "FR", label: "France", count: 1 },
    ])
    .mockImplementationOnce(() => new Promise<Facet[]>((_resolve, reject) => { rejectNext = reject; }));

  render(<FacetSelect kind="country" label="Country" value="" onChange={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Country" }));
  const search = screen.getByRole("textbox");
  const germany = await screen.findByRole("button", { name: /Germany/ }, { timeout: 3000 });
  fireEvent.keyDown(search, { key: "ArrowDown" });
  expect(document.activeElement).toBe(germany);

  fireEvent.change(search, { target: { value: "ge" } });
  await vi.waitFor(() => expect(Service.countries).toHaveBeenCalledTimes(2), { timeout: 3000 });
  rejectNext(new Error("offline"));
  await screen.findByText(m.loadFailed(), {}, { timeout: 3000 });

  expect(screen.queryByRole("button", { name: /Germany/ })).not.toBeNull();
  expect(document.activeElement).toBe(germany);
  fireEvent.keyDown(germany, { key: "ArrowDown" });
  expect(document.activeElement).toBe(screen.getByRole("button", { name: /France/ }));
  errorLog.mockRestore();
});
