// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { AddStationDialog } from "./Dialogs";
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
