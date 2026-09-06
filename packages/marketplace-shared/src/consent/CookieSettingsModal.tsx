"use client";

import { useState, useEffect, useRef } from "react";
import { CookieConsent, necessaryConsent } from "./preferences";
import { XMarkIcon } from "@heroicons/react/24/outline";
import Link from "next/link";

interface CookieCategoryProps {
  title: string;
  description: string;
  enabled: boolean;
  onChange: (enabled: boolean) => void;
  disabled?: boolean;
  required?: boolean;
}

function CookieCategory({
  title,
  description,
  enabled,
  onChange,
  disabled = false,
  required = false,
}: CookieCategoryProps) {
  return (
    <div className="flex items-start justify-between py-4 border-b border-gray-200 last:border-b-0">
      <div className="flex-1 pr-4">
        <div className="flex items-center gap-2">
          <h3 className="text-sm font-medium text-gray-900">{title}</h3>
          {required && (
            <span className="text-xs text-gray-500 bg-gray-100 px-2 py-0.5 rounded">Required</span>
          )}
        </div>
        <p className="mt-1 text-sm text-gray-500">{description}</p>
      </div>
      <div className="flex-shrink-0">
        <button
          type="button"
          onClick={() => !disabled && onChange(!enabled)}
          disabled={disabled}
          className={`
            relative inline-flex h-6 w-11 flex-shrink-0 rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2
            ${enabled ? "bg-primary-600" : "bg-gray-200"}
            ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}
          `}
          role="switch"
          aria-checked={enabled}
          aria-label={title}
        >
          <span
            className={`
              pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out
              ${enabled ? "translate-x-5" : "translate-x-0"}
            `}
          />
        </button>
      </div>
    </div>
  );
}

export interface ConsentControls {
  consent: CookieConsent | null;
  showSettings: boolean;
  showBanner: boolean;
  isLoading: boolean;
  openSettings: () => void;
  closeSettings: () => void;
  updateConsent: (consent: Partial<CookieConsent>) => Promise<void>;
  acceptAll: () => Promise<void>;
  acceptNecessaryOnly: () => Promise<void>;
}

export function CookieSettingsModal(props: { controls: ConsentControls; privacyHref: string }) {
  return props.controls.showSettings ? <SettingsDialog {...props} /> : null;
}

function SettingsDialog({
  controls,
  privacyHref,
}: {
  controls: ConsentControls;
  privacyHref: string;
}) {
  const { consent, closeSettings, updateConsent, acceptAll, acceptNecessaryOnly } = controls;
  const [localConsent, setLocalConsent] = useState<CookieConsent>(consent ?? necessaryConsent);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    const opener = document.activeElement;
    element.showModal();
    return () => {
      element.close();
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
      else document.getElementById("cookie-settings-trigger")?.focus();
    };
  }, []);

  const handleSave = async () => {
    await updateConsent(localConsent);
  };

  return (
    <dialog
      ref={dialog}
      aria-labelledby="cookie-settings-title"
      onKeyDown={(event) => {
        if (event.key !== "Tab") return;
        const controls = event.currentTarget.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href]",
        );
        const first = controls[0],
          last = controls[controls.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        closeSettings();
      }}
      className="m-auto max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg overflow-y-auto rounded-lg bg-white p-0 shadow-xl backdrop:bg-black/50"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-gray-200 px-6 py-4">
        <h2 id="cookie-settings-title" className="text-lg font-semibold text-gray-900">
          Cookie Settings
        </h2>
        <button
          type="button"
          aria-label="Close cookie settings"
          onClick={closeSettings}
          className="text-gray-400 hover:text-gray-500"
        >
          <XMarkIcon className="h-6 w-6" />
        </button>
      </div>

      {/* Content */}
      <div className="px-6 py-4">
        <p className="text-sm text-gray-600 mb-4">
          We use cookies to improve your experience on our website. You can choose which categories
          of cookies you want to allow.{" "}
          <Link href={privacyHref} className="text-primary-600 hover:text-primary-700 underline">
            Learn more in our Privacy Policy
          </Link>
          .
        </p>

        <div className="space-y-1">
          <CookieCategory
            title="Necessary"
            description="Essential cookies required for basic website functionality. These cannot be disabled."
            enabled={true}
            onChange={() => {}}
            disabled={true}
            required={true}
          />

          <CookieCategory
            title="Functional"
            description="Cookies that enable enhanced features and personalization, such as remembering your preferences."
            enabled={localConsent.functional}
            onChange={(enabled) => setLocalConsent((prev) => ({ ...prev, functional: enabled }))}
          />

          <CookieCategory
            title="Analytics"
            description="Cookies that help us understand how visitors interact with our website, allowing us to improve our services."
            enabled={localConsent.analytics}
            onChange={(enabled) => setLocalConsent((prev) => ({ ...prev, analytics: enabled }))}
          />

          <CookieCategory
            title="Marketing"
            description="Cookies used to deliver personalized advertisements and measure the effectiveness of our marketing campaigns."
            enabled={localConsent.marketing}
            onChange={(enabled) => setLocalConsent((prev) => ({ ...prev, marketing: enabled }))}
          />
        </div>
      </div>

      {/* Footer */}
      <div className="flex flex-col sm:flex-row gap-2 border-t border-gray-200 px-6 py-4">
        <button
          onClick={acceptNecessaryOnly}
          className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Necessary Only
        </button>
        <button
          onClick={handleSave}
          className="flex-1 px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
        >
          Save Preferences
        </button>
        <button
          onClick={acceptAll}
          className="flex-1 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-lg hover:bg-primary-700 transition-colors"
        >
          Accept All
        </button>
      </div>
    </dialog>
  );
}

export default CookieSettingsModal;
