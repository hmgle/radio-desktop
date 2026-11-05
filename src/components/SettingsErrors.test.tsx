// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SettingsPage } from "./SettingsPage";
import { SleepTimerControl } from "./SleepTimerControl";
import { defaultSettings, useSettings } from "../settings";
import { useRadio } from "../store";

vi.mock("../player", () => ({ player: {} }));
vi.mock("../mygo", () => ({ Service: {}, events: {} }));
afterEach(cleanup);

it("keeps the save failure summary and exposes backend diagnostics on demand", () => {
  useSettings.setState({ value: defaultSettings, ready: true, error: "Error: database or disk is full", saving: false });
  render(<SettingsPage />);
  const alert = screen.getByRole("alert");
  expect(within(alert).getByText("Could not save. Your settings were kept. Please retry.")).toBeTruthy();
  const details = alert.querySelector("details")!;
  expect(details.open).toBe(false);
  fireEvent.click(within(alert).getByText("Error details"));
  expect(details.open).toBe(true);
  expect(within(details).getByText("Error: database or disk is full")).toBeTruthy();
});

it("translates stable sleep timer errors in expandable diagnostics", () => {
  useRadio.setState({ sleepTimer: { deadline: 0, generation: 0, expired: false }, sleepError: "Error: radio:invalidSettings" });
  render(<SleepTimerControl />);
  const alert = screen.getByRole("alert");
  expect(within(alert).getByText("Could not update the sleep timer. Please retry.")).toBeTruthy();
  fireEvent.click(within(alert).getByText("Error details"));
  expect(within(alert).getByText("Invalid setting value.")).toBeTruthy();
});
