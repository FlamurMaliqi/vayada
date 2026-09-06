"use client";

import { useId, useRef, useState, type FormEvent } from "react";

export type SupportRequest = { kind: string; message: string; page: string; product: string };

export function SupportButton({
  translate,
  product,
  submit,
  placement = "floating",
}: {
  translate?: (key: string, params?: Record<string, string | number>) => string;
  product: string;
  submit: (request: SupportRequest) => Promise<{ status: string; reference: string }>;
  placement?: "floating" | "header";
}) {
  const t =
    translate ??
    ((key: string) => SupportButtonMessages[key as keyof typeof SupportButtonMessages]);
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const sending = useRef(false);
  const [kind, setKind] = useState("support");
  const [message, setMessage] = useState("");
  const [page, setPage] = useState("/");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [reference, setReference] = useState("");

  async function send(event: FormEvent) {
    event.preventDefault();
    if (sending.current) return;
    sending.current = true;
    setPending(true);
    setError("");
    try {
      const result = await submit({ kind, message: message.trim(), page, product });
      if (result?.status !== "accepted" || !result.reference) throw new Error("Missing receipt");
      setReference(result.reference);
      setMessage("");
    } catch {
      setError(t("support.weCouldNotConfirmYourRequestYourMessageIsStill"));
    } finally {
      sending.current = false;
      setPending(false);
    }
  }

  if (process.env.NEXT_PUBLIC_AUTHKIT_LOGIN_ENABLED === "false") return null;
  return (
    <>
      <button
        type="button"
        aria-label={t("support.helpReportABug")}
        className={`rounded-md border border-gray-300 bg-white text-xs font-medium text-gray-700 hover:bg-gray-50 ${
          placement === "header"
            ? "min-h-11 min-w-11 shrink-0 px-2"
            : "fixed bottom-4 right-4 z-40 px-3 py-2 shadow-sm"
        }`}
        onClick={() => {
          setPage(window.location.pathname);
          setReference("");
          setError("");
          dialog.current?.showModal();
        }}
      >
        {placement === "header" ? t("support.help") : t("support.helpReportABug")}
      </button>
      <dialog
        ref={dialog}
        aria-label={t("support.helpAndBugReports")}
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl bg-white p-6 text-gray-900 shadow-xl backdrop:bg-black/40"
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <h2 className="text-lg font-semibold">{t("support.helpReportABug")}</h2>
        {reference ? (
          <div role="status" className="my-4 space-y-2">
            <p>{t("support.yourRequestHasBeenReceivedWeCanFollowUpUsing")}</p>
            <p className="break-all text-xs text-gray-500">
              {t("support.reference")}
              {reference}
            </p>
          </div>
        ) : (
          <form onSubmit={send} className="mt-4 space-y-4">
            <p className="text-sm text-gray-600">
              {t("support.yourAccountIdentityAndCurrentPageAreIncludedSoWe")}
            </p>
            <div>
              <label htmlFor={`${id}-kind`} className="block text-sm font-medium">
                {t("support.whatDoYouNeed")}
              </label>
              <select
                id={`${id}-kind`}
                value={kind}
                onChange={(event) => setKind(event.target.value)}
                disabled={pending}
                className="mt-1 block w-full rounded-md border border-gray-300 p-2"
              >
                <option value="support">{t("support.askForHelpSupport")}</option>
                <option value="bug">{t("support.reportABug")}</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-message`} className="block text-sm font-medium">
                {t("support.message")}
              </label>
              <textarea
                id={`${id}-message`}
                required
                maxLength={4000}
                rows={5}
                value={message}
                disabled={pending}
                onChange={(event) => setMessage(event.target.value)}
                className="mt-1 block w-full rounded-md border border-gray-300 p-2"
              />
            </div>
            <p className="break-all text-xs text-gray-500">
              {t("support.page")}
              {product} · {page}
            </p>
            {error && (
              <p role="alert" className="text-sm text-red-700">
                {error}
              </p>
            )}
            <button
              type="submit"
              disabled={pending || !message.trim()}
              className="rounded-md bg-gray-900 px-4 py-2 text-sm text-white disabled:opacity-50"
            >
              {pending ? t("support.sending") : t("support.sendRequest")}
            </button>
          </form>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => dialog.current?.close()}
          className="mt-4 rounded-md border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
        >
          {t("support.close")}
        </button>
      </dialog>
    </>
  );
}

export const SupportButtonMessages = {
  "support.help": "Help",
  "support.weCouldNotConfirmYourRequestYourMessageIsStill":
    "We could not confirm your request. Your message is still here. Please try again.",
  "support.helpReportABug": "Help / Report a bug",
  "support.helpAndBugReports": "Help and bug reports",
  "support.yourRequestHasBeenReceivedWeCanFollowUpUsing":
    "Your request has been received. We can follow up using your account email.",
  "support.reference": "Reference:",
  "support.yourAccountIdentityAndCurrentPageAreIncludedSoWe":
    "Your account identity and current page are included so we can follow up.",
  "support.whatDoYouNeed": "What do you need?",
  "support.askForHelpSupport": "Ask for help / support",
  "support.reportABug": "Report a bug",
  "support.message": "Message",
  "support.page": "Page:",
  "support.sending": "Sending…",
  "support.sendRequest": "Send request",
  "support.close": "Close",
};
