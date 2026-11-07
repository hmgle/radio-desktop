// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { Service } from "../mygo";
import { defaultSettings, useSettings } from "../settings";

vi.mock("../player", () => ({ player: {} }));
vi.mock("../mygo", () => ({ Service: { updateSettings: vi.fn() }, events: {} }));
beforeEach(() => {
  vi.clearAllMocks();
  useSettings.setState({ value: defaultSettings, ready: true, error: "", saving: false });
});
afterEach(cleanup);

it("saves the mode and address together, only after applying the form", async () => {
  vi.mocked(Service.updateSettings).mockResolvedValue({ ...defaultSettings, proxyMode: "manual", proxyURL: "socks5://127.0.0.1:1080" });
  render(<SettingsPage />);
  expect((screen.getByRole("combobox", { name: "Proxy mode" }) as HTMLSelectElement).value).toBe("auto");
  fireEvent.change(screen.getByRole("combobox", { name: "Proxy mode" }), { target: { value: "manual" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Proxy address" }), { target: { value: "socks5://127.0.0.1:1080" } });
  expect(Service.updateSettings).not.toHaveBeenCalled();
  fireEvent.submit(screen.getByRole("form", { name: "Network proxy" }));
  await waitFor(() => expect(Service.updateSettings).toHaveBeenCalledWith({ proxyMode: "manual", proxyURL: "socks5://127.0.0.1:1080" }));
  expect(screen.getByText("Fully quit and reopen the app after applying changes.")).toBeTruthy();
});

it("keeps the draft and previous saved settings after a failed save", async () => {
  vi.mocked(Service.updateSettings).mockRejectedValue(new Error("disk full"));
  render(<SettingsPage />);
  fireEvent.change(screen.getByRole("combobox", { name: "Proxy mode" }), { target: { value: "manual" } });
  fireEvent.change(screen.getByRole("textbox", { name: "Proxy address" }), { target: { value: "http://proxy.example:8080" } });
  fireEvent.submit(screen.getByRole("form", { name: "Network proxy" }));
  await screen.findByRole("alert");
  expect(useSettings.getState().value.proxyMode).toBe("auto");
  expect((screen.getByRole("textbox", { name: "Proxy address" }) as HTMLInputElement).value).toBe("http://proxy.example:8080");
});

it.each(["auto", "direct"])("saves %s without an obsolete manual address", async (mode) => {
  useSettings.setState({ value: { ...defaultSettings, proxyMode: "manual", proxyURL: "http://proxy.example:8080" } });
  vi.mocked(Service.updateSettings).mockResolvedValue({ ...defaultSettings, proxyMode: mode });
  render(<SettingsPage />);
  fireEvent.change(screen.getByRole("combobox", { name: "Proxy mode" }), { target: { value: mode } });
  expect(screen.queryByRole("textbox", { name: "Proxy address" })).toBeNull();
  fireEvent.submit(screen.getByRole("form", { name: "Network proxy" }));
  await waitFor(() => expect(Service.updateSettings).toHaveBeenCalledWith({ proxyMode: mode, proxyURL: "" }));
});
