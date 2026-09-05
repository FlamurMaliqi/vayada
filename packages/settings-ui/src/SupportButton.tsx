"use client";

import { useId, useRef, useState, type FormEvent } from "react";

export type SupportRequest = { kind: string; message: string; page: string; product: string };

export function SupportButton({
  product,
  submit,
}: {
  product: string;
  submit: (request: SupportRequest) => Promise<{ status: string; reference: string }>;
}) {
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
      setError("We could not confirm your request. Your message is still here. Please try again.");
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
        className="fixed bottom-4 right-4 z-40 rounded-md border border-gray-300 bg-white px-3 py-2 text-xs font-medium text-gray-700 shadow-sm hover:bg-gray-50"
        onClick={() => {
          setPage(window.location.pathname);
          setReference("");
          setError("");
          dialog.current?.showModal();
        }}
      >
        Help / Report a bug
      </button>
      <dialog
        ref={dialog}
        aria-label="Help and bug reports"
        className="m-auto w-[calc(100%-2rem)] max-w-md rounded-xl bg-white p-6 text-gray-900 shadow-xl backdrop:bg-black/40"
        onCancel={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <h2 className="text-lg font-semibold">Help / Report a bug</h2>
        {reference ? (
          <div role="status" className="my-4 space-y-2">
            <p>Your request has been received. We can follow up using your account email.</p>
            <p className="break-all text-xs text-gray-500">Reference: {reference}</p>
          </div>
        ) : (
          <form onSubmit={send} className="mt-4 space-y-4">
            <p className="text-sm text-gray-600">
              Your account identity and current page are included so we can follow up.
            </p>
            <div>
              <label htmlFor={`${id}-kind`} className="block text-sm font-medium">
                What do you need?
              </label>
              <select
                id={`${id}-kind`}
                value={kind}
                onChange={(event) => setKind(event.target.value)}
                disabled={pending}
                className="mt-1 block w-full rounded-md border border-gray-300 p-2"
              >
                <option value="support">Ask for help / support</option>
                <option value="bug">Report a bug</option>
              </select>
            </div>
            <div>
              <label htmlFor={`${id}-message`} className="block text-sm font-medium">
                Message
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
              Page: {product} · {page}
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
              {pending ? "Sending…" : "Send request"}
            </button>
          </form>
        )}
        <button
          type="button"
          disabled={pending}
          onClick={() => dialog.current?.close()}
          className="mt-4 rounded-md border border-gray-300 px-4 py-2 text-sm disabled:opacity-50"
        >
          Close
        </button>
      </dialog>
    </>
  );
}
