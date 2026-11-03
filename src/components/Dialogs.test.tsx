// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AddStationDialog, Modal } from "./Dialogs";
vi.mock("../player", () => ({ player: {} }));
vi.mock("../mygo", () => ({ Service: {}, events: {} }));
afterEach(cleanup);

it("restores trigger focus after closing a dialog with autofocus", () => {
  function Harness() {
    const [open, setOpen] = useState(false);
    return <><button onClick={() => setOpen(true)}>Open</button>{open && <AddStationDialog onClose={() => setOpen(false)} />}</>;
  }
  render(<Harness />);
  const trigger = screen.getByRole("button", { name: "Open" });
  trigger.focus();
  fireEvent.click(trigger);
  expect(document.activeElement).toBe(screen.getByPlaceholderText("Station name"));
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(document.activeElement).toBe(trigger);
});

it("includes links in the modal focus trap while skipping negative tabindex links", () => {
  render(<Modal title="Help" onClose={() => {}}>
    <button>First</button><a href="https://example.com/help">Help link</a>
    <a href="https://example.com/skip" tabIndex={-1}>Skip</a>
  </Modal>);
  const first = screen.getByRole("button", { name: "First" });
  const link = screen.getByRole("link", { name: "Help link" });
  expect(document.activeElement).toBe(first);
  fireEvent.keyDown(first, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(link);
  fireEvent.keyDown(link, { key: "Tab" });
  expect(document.activeElement).toBe(first);
});
