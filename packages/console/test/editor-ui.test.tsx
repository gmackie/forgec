// @vitest-environment jsdom
import React from "react";
import { it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { Edit } from "../web/editor/document.js";
afterEach(cleanup);
it("Escape cancels a visual text edit instead of committing it on blur", () => {
  const commit = vi.fn();
  render(<Edit label="Name" value="Original" onCommit={commit} />);
  const input = screen.getByLabelText("Name");
  input.focus();
  fireEvent.change(input, { target: { value: "Changed" } });
  fireEvent.keyDown(input, { key: "Escape" });
  expect(commit).not.toHaveBeenCalled();
  expect((input as HTMLInputElement).value).toBe("Original");
});
