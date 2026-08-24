import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { App } from "../App.js";

afterEach(() => {
  cleanup();
  window.localStorage.clear();
});

function renderApp(): ReturnType<typeof render> {
  window.localStorage.setItem("naqsh.onboarding.completed", "true");
  return render(
    <MemoryRouter>
      <App />
    </MemoryRouter>
  );
}

function textFile(name: string, content: string): File {
  return new File([content], name, { type: "text/plain" });
}

describe("file attachments", () => {
  it("attaching a text file shows a pending chip, and sending it shows the attachment plus any extracted requirements", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(fileInput, textFile("spec.txt", "The bracket must support 50 kg."));

    expect(await screen.findByText("spec.txt")).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Send" }));

    // Attachment chip on the sent message, and a real extracted requirement
    // pulled from the file's own text content.
    expect(await screen.findByText("Load capacity")).toBeInTheDocument();
    expect(screen.getAllByText("spec.txt").length).toBeGreaterThan(0);
  });

  it("a binary/unsupported file is attached honestly, without claiming it was analyzed", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: /New chat/ }));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const binary = new File([new Uint8Array([1, 2, 3])], "model.fcstd", { type: "application/octet-stream" });
    await user.upload(fileInput, binary);
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText(/can't inspect CAD\/binary file contents/)).toBeInTheDocument();
  });

  it("dropping a file onto the composer attaches it, the same as the attach button", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: /New chat/ }));

    const composer = screen.getByLabelText("Message Naqsh").closest("form") as HTMLFormElement;
    const file = textFile("drawing-notes.txt", "Notes on the drawing.");
    const dataTransfer = { types: ["Files"], files: [file] };

    fireEvent.dragEnter(composer, { dataTransfer });
    expect(composer.className).toContain("is-dragging-files");

    fireEvent.drop(composer, { dataTransfer });

    expect(await screen.findByText("drawing-notes.txt")).toBeInTheDocument();
    expect(composer.className).not.toContain("is-dragging-files");
  });

  it("a drag that isn't carrying files (e.g. dragging selected text) never arms the drop overlay", async () => {
    const user = userEvent.setup();
    renderApp();
    await user.click(screen.getByRole("button", { name: /New chat/ }));

    const composer = screen.getByLabelText("Message Naqsh").closest("form") as HTMLFormElement;
    fireEvent.dragEnter(composer, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(composer.className).not.toContain("is-dragging-files");
  });
});

describe("export", () => {
  it("exporting the conversation triggers a real file download", async () => {
    const user = userEvent.setup();
    renderApp();

    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const createObjectURLSpy = vi.spyOn(URL, "createObjectURL");

    await user.click(screen.getByRole("button", { name: "Export" }));
    await user.click(screen.getByRole("menuitem", { name: /Export conversation/ }));

    expect(createObjectURLSpy).toHaveBeenCalled();
    expect(clickSpy).toHaveBeenCalled();

    clickSpy.mockRestore();
    createObjectURLSpy.mockRestore();
  });
});

describe("AI style setting", () => {
  it("switching to Concise changes Naqsh's built-in acknowledgement phrasing", async () => {
    const user = userEvent.setup();
    renderApp();

    await user.click(screen.getByRole("button", { name: "Settings" }));
    await user.click(screen.getByRole("radio", { name: /Concise/ }));
    await user.click(screen.getByRole("button", { name: "Close settings" }));

    // The demo project thread has no guided script -- any message goes
    // through the free-form reply path immediately.
    const composer = screen.getByLabelText("Message Naqsh");
    await user.type(composer, "just checking in");
    await user.click(screen.getByRole("button", { name: "Send" }));

    expect(await screen.findByText("Noted.")).toBeInTheDocument();
  });
});
