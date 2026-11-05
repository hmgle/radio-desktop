// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { FilterBar } from "./FilterBar";
import { useRadio } from "../store";

vi.mock("../player", () => ({ player: {} }));
vi.mock("../mygo", () => ({ Service: {}, events: {} }));
afterEach(cleanup);

it("clears only the query and restores search focus", () => {
  const setQuery = vi.fn();
  useRadio.setState({ query: "Berlin", country: "DE", setQuery });
  render(<FilterBar />);
  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  expect(setQuery).toHaveBeenCalledWith("");
  expect(useRadio.getState().country).toBe("DE");
  expect(document.activeElement).toBe(screen.getByRole("textbox"));
});
