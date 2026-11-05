// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ClearHistoryRow } from "./ClearHistoryRow";
import { Service } from "../mygo";
import { useRadio } from "../store";
vi.mock("../player", () => ({ player: {} }));
vi.mock("../mygo", () => ({ Service: { clearHistory: vi.fn() }, events: {} }));
afterEach(cleanup);

it("requires confirmation and keeps the confirmation open on failure", async () => {
  const refresh = vi.fn().mockResolvedValue(undefined);
  useRadio.setState({ source: "history", refresh });
  vi.mocked(Service.clearHistory).mockRejectedValueOnce(new Error("disk full")).mockResolvedValueOnce(undefined);
  render(<ClearHistoryRow />);
  const trigger = screen.getByRole("button", { name: "Clear" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(Service.clearHistory).not.toHaveBeenCalled();
  const dialog = screen.getByRole("dialog");
  const confirm = within(dialog).getByRole("button", { name: "Clear" });
  fireEvent.click(confirm);
  const alert = await screen.findByRole("alert");
  expect(within(alert).getByText("Could not clear history. Please retry.")).toBeTruthy();
  const details = alert.querySelector("details")!;
  expect(details.open).toBe(false);
  const summary = within(alert).getByText("Error details");
  // Error details appear dynamically in this modal and must stay in its
  // keyboard cycle alongside the cancel and retry buttons.
  confirm.focus();
  fireEvent.keyDown(confirm, { key: "Tab" });
  expect(document.activeElement).toBe(summary);
  fireEvent.click(summary);
  expect(details.open).toBe(true);
  expect(within(details).getByText("Error: disk full")).toBeTruthy();
  expect(refresh).not.toHaveBeenCalled();
  fireEvent.click(confirm);
  expect(await screen.findByText("Listening history cleared.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
  expect(refresh).toHaveBeenCalledOnce();
  await waitFor(() => expect(document.activeElement).toBe(trigger));
});

it("cancels without touching history and traps keyboard focus", () => {
  vi.mocked(Service.clearHistory).mockClear();
  render(<ClearHistoryRow />);
  fireEvent.click(screen.getByRole("button", { name: "Clear" }));
  const dialog = screen.getByRole("dialog");
  const cancel = within(dialog).getByRole("button", { name: "Cancel" });
  expect(document.activeElement).toBe(cancel);
  fireEvent.keyDown(cancel, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Clear" }));
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(Service.clearHistory).not.toHaveBeenCalled();
});
