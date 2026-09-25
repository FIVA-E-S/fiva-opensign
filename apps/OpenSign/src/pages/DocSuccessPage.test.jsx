import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import DocSuccessPage from "./DocSuccessPage";
const mocks = vi.hoisted(() => ({ pdf: vi.fn(), assign: vi.fn() }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key) => key }) }));
vi.mock("react-confetti", () => ({ default: () => null }));
vi.mock("../constant/Utils", () => ({ getBase64FromUrl: mocks.pdf, handleDownloadCertificate: vi.fn(), handleDownloadPdf: vi.fn(), handleToPrint: vi.fn() }));
vi.mock("../primitives/DownloadPdfZip", () => ({ default: () => null }));
vi.mock("../primitives/ModalUi", () => ({ default: () => null }));
vi.mock("../primitives/Loader", () => ({ default: () => null }));
vi.mock("../primitives/CheckCircle", () => ({ default: () => null }));
function show(redirect, extra = "&completed=true") {
  const search = `?docid=qa&docurl=/qa.pdf${extra}${redirect ? `&redirect_url=${encodeURIComponent(redirect)}` : ""}`;
  vi.stubGlobal("location", { search, assign: mocks.assign });
  return render(<DocSuccessPage />);
}
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.pdf.mockResolvedValue(""); });
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals(); });
it("returns automatically after three seconds and offers a manual fallback", async () => {
  show("http://127.0.0.1:5198/onboarding/start");
  expect(screen.getByText("Redirigiendo en 3 segundos...")).toBeTruthy();
  expect(screen.getByRole("link").href).toBe("http://127.0.0.1:5198/onboarding/start");
  await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
  expect(mocks.assign).not.toHaveBeenCalled();
  await act(async () => { await vi.advanceTimersByTimeAsync(1000); });
  expect(mocks.assign).toHaveBeenCalledExactlyOnceWith("http://127.0.0.1:5198/onboarding/start");
});
it.each([null, "javascript:alert(1)", "data:text/html,test", "not a url", "https://user:password@example.test/"])("stays usable without a safe destination: %s", async (destination) => {
  show(destination);
  expect(screen.queryByRole("link")).toBeNull();
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(mocks.assign).not.toHaveBeenCalled();
});
it("does not wait for PDF retrieval before returning", async () => {
  mocks.pdf.mockRejectedValue(new Error("PDF unavailable"));
  show("https://crm.example.test/onboarding/start");
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
  expect(mocks.assign).toHaveBeenCalledWith("https://crm.example.test/onboarding/start");
});
it("clears the redirect when the screen unmounts", async () => {
  const view = show("https://crm.example.test/onboarding/start");
  view.unmount();
  await act(async () => { await vi.advanceTimersByTimeAsync(4000); });
  expect(mocks.assign).not.toHaveBeenCalled();
});
it("does not interpret completed=false as all signers finished", async () => {
  show(null, "&completed=false");
  expect(screen.getByText("document-has-been-signed-by-you")).toBeTruthy();
  expect(screen.queryByText("document-has-been-signed")).toBeNull();
  await act(async () => {});
});
