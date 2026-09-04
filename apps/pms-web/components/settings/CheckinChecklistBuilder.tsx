"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowLeftIcon,
  ArrowPathIcon,
  Bars3Icon,
  CheckCircleIcon,
  EyeIcon,
  PlusIcon,
  TrashIcon,
} from "@heroicons/react/24/outline";
import {
  CheckinChecklistStep,
  CheckinChecklistStepType,
  settingsService,
} from "@/services/settings";
import { useTranslation } from "@/lib/i18n";
import {
  defaultCheckinChecklistSteps,
  localizeBuiltInCheckinStep,
} from "@/lib/settings/checklistCopy";

const DRAFT_STORAGE_KEY = "vayada:pms:checkin-checklist-preview";

function newStep(position: number): CheckinChecklistStep {
  const id =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `step-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return { id, label: "", prompt: "", type: "checkbox", required: false, system: false, position };
}

function typeLabel(type: CheckinChecklistStepType, t: (key: string) => string) {
  if (type === "text") return `✎ ${t("settings.checklist.typeText")}`;
  if (type === "amount") return `$ ${t("settings.checklist.typeAmount")}`;
  return `☑ ${t("settings.checklist.typeCheckbox")}`;
}

export function CheckinChecklistPreview({ steps }: { steps: CheckinChecklistStep[] }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
      <div className="border-b border-gray-100 px-4 py-3">
        <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
          {t("settings.checklist.previewTitle")}
        </p>
      </div>
      <div className="max-h-[520px] space-y-2 overflow-y-auto p-4">
        {steps.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
            {t("settings.checklist.previewEmpty")}
          </div>
        )}
        {steps.map((step) => (
          <div key={step.id} className="rounded-lg border border-gray-200 bg-white p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="break-words text-sm font-semibold text-gray-950">
                  {step.label.trim() || t("settings.checklist.unnamed")}
                </p>
                {step.prompt && <p className="mt-0.5 text-xs text-gray-500">{step.prompt}</p>}
              </div>
              <span className="shrink-0 rounded-full bg-white px-2 py-0.5 text-xs text-gray-500">
                {step.required ? t("common.required") : t("settings.checklist.optional")}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-1.5">
              <span className="rounded-full bg-gray-100 px-2 py-0.5 text-xs font-medium text-gray-700">
                {typeLabel(step.type, t)}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

export function CheckinChecklistBuilder() {
  const { t } = useTranslation();
  const [steps, setSteps] = useState<CheckinChecklistStep[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const nextFocusId = useRef<string | null>(null);

  useEffect(() => {
    settingsService
      .getCheckinChecklist()
      .then((template) =>
        setSteps((template.steps || []).map((step) => localizeBuiltInCheckinStep(step, t))),
      )
      .catch((err) => setError(err.message || t("settings.checklist.loadError")))
      .finally(() => setLoading(false));
  }, [t]);

  useEffect(() => {
    if (!nextFocusId.current) return;
    document.querySelector<HTMLInputElement>(`[data-step-label="${nextFocusId.current}"]`)?.focus();
    nextFocusId.current = null;
  }, [steps.length]);

  const normalizedSteps = useMemo(
    () => steps.map((step, index) => ({ ...step, position: index, system: false })),
    [steps],
  );

  const updateStep = (id: string, patch: Partial<CheckinChecklistStep>) => {
    setSuccess("");
    setErrors((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSteps((prev) => prev.map((step) => (step.id === id ? { ...step, ...patch } : step)));
  };

  const addStep = () => {
    const step = newStep(steps.length);
    nextFocusId.current = step.id;
    setSteps((prev) => [...prev, step]);
  };

  const restoreDefaultSteps = () => {
    setSuccess("");
    setError("");
    setErrors({});
    const restored = defaultCheckinChecklistSteps(t);
    nextFocusId.current = restored[0]?.id ?? null;
    setSteps(restored);
  };

  const removeStep = (id: string) => {
    setSuccess("");
    setSteps((prev) => prev.filter((step) => step.id !== id));
  };

  const moveStep = (fromId: string, toId: string) => {
    setSteps((prev) => {
      const from = prev.findIndex((step) => step.id === fromId);
      const to = prev.findIndex((step) => step.id === toId);
      if (from < 0 || to < 0 || from === to) return prev;
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  const save = async () => {
    const nextErrors: Record<string, string> = {};
    normalizedSteps.forEach((step) => {
      if (!step.label.trim()) nextErrors[step.id] = t("settings.checklist.labelRequired");
    });
    setErrors(nextErrors);
    setError("");
    setSuccess("");
    if (Object.keys(nextErrors).length > 0) return;

    setSaving(true);
    try {
      const saved = await settingsService.updateCheckinChecklist(normalizedSteps);
      setSteps(saved.steps || []);
      setSuccess(t("settings.checklist.saved"));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("settings.checklist.saveError"));
    } finally {
      setSaving(false);
    }
  };

  const openPreview = () => {
    sessionStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify(normalizedSteps));
  };

  if (loading) {
    return <div className="p-4 text-sm text-gray-500">{t("settings.checklist.loading")}</div>;
  }

  return (
    <main className="min-h-[100dvh] bg-gray-50 p-4 md:p-6">
      <div className="mx-auto max-w-6xl space-y-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm text-gray-500">
              {t("settings.title")} / {t("settings.navigation.checkinChecklist")}
            </p>
            <h1 className="mt-1 text-2xl font-semibold text-gray-950">
              {t("settings.navigation.checkinChecklist")}
            </h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-600">
              {t("settings.checklist.description")}
            </p>
          </div>
          <Link
            href="/settings"
            className="inline-flex items-center gap-2 rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
          >
            <ArrowLeftIcon className="h-4 w-4" />
            {t("settings.title")}
          </Link>
        </header>

        {error && (
          <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">
            {error}
          </p>
        )}
        {success && (
          <p className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-700">
            {success}
          </p>
        )}

        <section className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_340px]">
          <div className="rounded-xl border border-gray-200 bg-white shadow-sm">
            <div className="border-b border-gray-100 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                {t("settings.checklist.stepsTitle")}
              </p>
              <p className="mt-1 text-xs text-gray-500">
                {t("settings.checklist.stepsDescription")}
              </p>
            </div>
            <div className="space-y-3 p-4">
              {normalizedSteps.length === 0 && (
                <div className="rounded-lg border border-dashed border-gray-300 p-4 text-sm text-gray-500">
                  {t("settings.checklist.empty")}
                </div>
              )}

              {normalizedSteps.map((step, index) => {
                const previousStep = normalizedSteps[index - 1];
                const nextStep = normalizedSteps[index + 1];

                return (
                  <div
                    key={step.id}
                    draggable
                    onDragStart={() => setDraggingId(step.id)}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={() => {
                      if (draggingId) moveStep(draggingId, step.id);
                      setDraggingId(null);
                    }}
                    className="rounded-lg border border-gray-200 bg-white p-3 shadow-sm"
                  >
                    <div className="grid gap-3 md:grid-cols-[88px_minmax(0,1fr)_140px_40px] md:items-start">
                      <div className="flex items-center gap-1">
                        <button
                          type="button"
                          className="flex h-9 w-9 cursor-grab items-center justify-center rounded-lg text-gray-400 hover:bg-gray-50"
                          aria-label={t("settings.checklist.drag")}
                        >
                          <Bars3Icon className="h-5 w-5" />
                        </button>
                        <div className="flex flex-col">
                          <button
                            type="button"
                            onClick={() => previousStep && moveStep(step.id, previousStep.id)}
                            disabled={!previousStep}
                            className="flex h-4 w-7 items-center justify-center rounded text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-30"
                            aria-label={t("settings.checklist.moveUp")}
                          >
                            ↑
                          </button>
                          <button
                            type="button"
                            onClick={() => nextStep && moveStep(step.id, nextStep.id)}
                            disabled={!nextStep}
                            className="flex h-4 w-7 items-center justify-center rounded text-xs text-gray-500 hover:bg-gray-50 disabled:opacity-30"
                            aria-label={t("settings.checklist.moveDown")}
                          >
                            ↓
                          </button>
                        </div>
                      </div>
                      <div className="space-y-2">
                        <Field
                          value={step.label}
                          placeholder={t("settings.checklist.labelPlaceholder")}
                          maxLength={120}
                          error={errors[step.id]}
                          dataStepLabel={step.id}
                          onChange={(value) => updateStep(step.id, { label: value })}
                        />
                        <TextAreaField
                          value={step.prompt ?? ""}
                          placeholder={t("settings.checklist.helpPlaceholder")}
                          maxLength={200}
                          onChange={(value) => updateStep(step.id, { prompt: value })}
                        />
                      </div>
                      <select
                        value={step.type}
                        onChange={(event) => {
                          const newType = event.target.value as CheckinChecklistStepType;
                          updateStep(step.id, { type: newType });
                        }}
                        className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm"
                      >
                        <option value="checkbox">{t("settings.checklist.typeCheckbox")}</option>
                        <option value="text">{t("settings.checklist.typeText")}</option>
                        <option value="amount">{t("settings.checklist.typeAmount")}</option>
                      </select>
                      <button
                        type="button"
                        onClick={() => removeStep(step.id)}
                        className="flex h-9 w-9 items-center justify-center rounded-lg text-gray-400 hover:bg-red-50 hover:text-red-600"
                        aria-label={t("settings.checklist.delete")}
                      >
                        <TrashIcon className="h-4 w-4" />
                      </button>
                    </div>
                    <label className="mt-3 inline-flex items-center gap-2 text-sm font-medium text-gray-700">
                      <input
                        type="checkbox"
                        checked={step.required}
                        onChange={(event) =>
                          updateStep(step.id, { required: event.target.checked })
                        }
                        className="h-4 w-4 rounded border-gray-300"
                      />
                      {t("common.required")}
                    </label>
                  </div>
                );
              })}

              <button
                type="button"
                onClick={addStep}
                className="inline-flex items-center gap-2 rounded-lg border border-dashed border-gray-300 px-3 py-2 text-sm font-semibold text-gray-600 hover:border-gray-400 hover:text-gray-900"
              >
                <PlusIcon className="h-4 w-4" />
                {t("settings.checklist.add")}
              </button>
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2 border-t border-gray-100 px-4 py-3">
              <div className="flex flex-wrap items-center gap-2">
                <Link
                  href="/settings/checkin-checklist/preview"
                  onClick={openPreview}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                  <EyeIcon className="h-4 w-4" />
                  {t("settings.checklist.preview")}
                </Link>
                <button
                  type="button"
                  onClick={restoreDefaultSteps}
                  className="inline-flex items-center gap-2 rounded-lg border border-gray-200 px-3 py-2 text-sm font-semibold text-gray-700 hover:bg-gray-50"
                >
                  <ArrowPathIcon className="h-4 w-4" />
                  {t("settings.checklist.restoreDefaults")}
                </button>
              </div>
              <button
                type="button"
                onClick={save}
                disabled={saving}
                className="inline-flex items-center gap-2 rounded-lg bg-primary-600 px-4 py-2 text-sm font-semibold text-white hover:bg-primary-700 disabled:opacity-60"
              >
                <CheckCircleIcon className="h-4 w-4" />
                {saving ? t("common.saving") : t("common.save")}
              </button>
            </div>
          </div>

          <CheckinChecklistPreview steps={normalizedSteps} />
        </section>
      </div>
    </main>
  );
}

function Field({
  value,
  placeholder,
  error,
  dataStepLabel,
  maxLength = 160,
  onChange,
}: {
  value: string;
  placeholder: string;
  error?: string;
  dataStepLabel?: string;
  maxLength?: number;
  onChange: (value: string) => void;
}) {
  return (
    <div>
      <input
        data-step-label={dataStepLabel}
        value={value}
        maxLength={maxLength}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className={`w-full rounded-lg border px-3 py-2 text-sm outline-none focus:border-gray-400 ${
          error ? "border-red-300 bg-red-50" : "border-gray-200"
        }`}
      />
      {error && <p className="mt-1 text-xs text-red-600">{error}</p>}
    </div>
  );
}

function TextAreaField({
  value,
  placeholder,
  maxLength = 200,
  onChange,
}: {
  value: string;
  placeholder: string;
  maxLength?: number;
  onChange: (value: string) => void;
}) {
  return (
    <textarea
      value={value}
      maxLength={maxLength}
      rows={2}
      onChange={(event) => onChange(event.target.value)}
      placeholder={placeholder}
      className="w-full resize-none rounded-lg border border-gray-200 px-3 py-2 text-sm outline-none focus:border-gray-400"
    />
  );
}

export function readChecklistPreviewDraft(): CheckinChecklistStep[] | null {
  if (typeof sessionStorage === "undefined") return null;
  const raw = sessionStorage.getItem(DRAFT_STORAGE_KEY);
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    const isStep = (value: unknown): value is CheckinChecklistStep => {
      if (!value || typeof value !== "object") return false;
      const candidate = value as Record<string, unknown>;
      return (
        typeof candidate.id === "string" &&
        typeof candidate.label === "string" &&
        (candidate.type === "checkbox" ||
          candidate.type === "text" ||
          candidate.type === "amount") &&
        typeof candidate.required === "boolean" &&
        typeof candidate.position === "number"
      );
    };
    return parsed.every(isStep) ? parsed : null;
  } catch {
    return null;
  }
}
