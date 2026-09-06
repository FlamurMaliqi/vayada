"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowPathIcon,
  CheckCircleIcon,
  ChevronDownIcon,
  MagnifyingGlassIcon,
  PowerIcon,
  SparklesIcon,
  XMarkIcon,
} from "@heroicons/react/24/outline";

import {
  activeModuleCount,
  activeNavModules,
  CORE_NAV_ITEMS,
  FEATURE_CATEGORIES,
  FEATURE_MODULE_NAV_INDEX,
  modulesForProduct,
} from "./registry";
import type {
  FeatureActivationClient,
  FeatureCategory,
  FeatureModule,
  FeatureProduct,
} from "./types";
import { useFeatureModuleActivations } from "./useFeatureModuleActivations";

type Translate = (key: string, params?: Record<string, string | number>) => string;

interface FeatureHubPageProps {
  translate?: Translate;
  /**
   * Prefer a module-scoped or memoized client. The hook stores the latest value
   * in a ref so refresh callbacks stay stable across renders.
   */
  activationClient: FeatureActivationClient;
  initialProduct?: FeatureProduct;
  products?: FeatureProduct[];
}

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

const PRODUCT_LABELS: Record<FeatureProduct, string> = {
  pms: "PMS Modules",
  booking_engine: "Booking Engine Modules",
};

const PRODUCT_PREVIEW_LABELS: Record<FeatureProduct, string> = {
  pms: "PMS navigation",
  booking_engine: "Booking Engine navigation",
};

const ALL_PRODUCTS = Object.keys(PRODUCT_LABELS) as FeatureProduct[];

export function FeatureHubPage({
  translate: t = defaultTranslate,
  activationClient,
  initialProduct = "pms",
  products,
}: FeatureHubPageProps) {
  const [product, setProduct] = useState<FeatureProduct>(initialProduct);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<"All" | FeatureCategory>("All");
  const [selectedModule, setSelectedModule] = useState<FeatureModule | null>(null);
  const [notice, setNotice] = useState("");
  const [updateError, setUpdateError] = useState("");
  const [savingModuleId, setSavingModuleId] = useState<string | null>(null);
  const {
    activeModuleIds,
    activeModuleSet,
    supportedModuleIds,
    canManage,
    loading,
    error,
    setModuleActive,
  } = useFeatureModuleActivations(activationClient);
  const supportedModuleSet = useMemo(() => new Set(supportedModuleIds), [supportedModuleIds]);

  const availableProducts = useMemo(() => {
    const requested = products?.length ? products : ALL_PRODUCTS;
    const ordered = requested.includes(initialProduct) ? requested : [initialProduct, ...requested];
    return ordered.filter((key) =>
      modulesForProduct(key).some((module) => supportedModuleSet.has(module.id)),
    );
  }, [initialProduct, products, supportedModuleSet]);
  const displayedProduct = availableProducts.includes(product)
    ? product
    : (availableProducts[0] ?? product);
  const waitingForInventory = loading && availableProducts.length === 0;
  const inventoryFailed = Boolean(error) && availableProducts.length === 0;

  useEffect(() => {
    if (availableProducts.length > 0 && !availableProducts.includes(product)) {
      setProduct(availableProducts[0]);
    }
  }, [availableProducts, product]);

  useEffect(() => {
    if (!notice) return;
    const id = window.setTimeout(() => setNotice(""), 3800);
    return () => window.clearTimeout(id);
  }, [notice]);

  const productActiveCount = useMemo(
    () => activeModuleCount(displayedProduct, activeModuleIds),
    [displayedProduct, activeModuleIds],
  );

  const filteredModules = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return modulesForProduct(displayedProduct).filter((module) => {
      if (!supportedModuleSet.has(module.id)) return false;
      const matchesCategory = category === "All" || module.category === category;
      const matchesSearch =
        !normalized ||
        [
          t(`featureHub.module.${module.id}.name`),
          t(`featureHub.module.${module.id}.description`),
          t(`featureHub.category.${module.category}`),
        ]
          .join(" ")
          .toLowerCase()
          .includes(normalized);
      return matchesCategory && matchesSearch;
    });
  }, [category, displayedProduct, query, supportedModuleSet, t]);

  const toggleModule = async (module: FeatureModule, isActive: boolean) => {
    if (savingModuleId) return;
    setNotice("");
    setUpdateError("");
    setSavingModuleId(module.id);
    try {
      await setModuleActive(module.id, isActive);
      setNotice(
        isActive && module.settingsNote
          ? t("admin.activatedNote", { note: module.settingsNote ?? "" })
          : t(isActive ? "featureHub.activated" : "featureHub.deactivated", {
              name: t(`featureHub.module.${module.id}.name`),
            }),
      );
    } catch (error) {
      setUpdateError(
        t === defaultTranslate && error instanceof Error
          ? error.message
          : "featureHub.copy.couldNotUpdateModuleActivation",
      );
    } finally {
      setSavingModuleId(null);
    }
  };

  const clearSearch = () => setQuery("");

  return (
    <div className="min-h-full bg-gray-50 p-4 text-gray-950 md:p-6">
      <div className="pb-4">
        <header className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div className="min-w-0">
            <h1 className="text-xl font-semibold text-gray-900 md:text-2xl">
              {t("featureHub.copy.featureHub")}
            </h1>
            <p className="mt-1 max-w-2xl text-[13px] text-gray-500">
              {t("featureHub.copy.activatePropertyModulesAndKeepNavigationFocusedOnTheTools")}
            </p>
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-gray-50 px-2 py-1 text-xs font-medium text-gray-700">
                <CheckCircleIcon className="h-3.5 w-3.5 text-primary-600" />
                {productActiveCount} {t("featureHub.copy.active")}
              </span>
              {loading && (
                <span className="inline-flex items-center gap-1 rounded-md border border-gray-200 bg-white px-2 py-1 text-xs font-medium text-gray-500">
                  <ArrowPathIcon className="h-3.5 w-3.5 animate-spin" />
                  {t("featureHub.copy.syncing")}
                </span>
              )}
            </div>
          </div>
          {availableProducts.length > 1 && (
            <div className="flex flex-col gap-2 sm:flex-row">
              {availableProducts.map((key) => {
                const count = activeModuleCount(key, activeModuleIds);
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => setProduct(key)}
                    className={cx(
                      "inline-flex min-h-9 items-center justify-center rounded-md border px-3 text-[13px] font-medium transition-colors",
                      displayedProduct === key
                        ? "border-primary-600 bg-primary-600 text-white"
                        : "border-gray-200 bg-white text-gray-700 hover:border-gray-400",
                    )}
                  >
                    {t(`featureHub.product.${key}`)}{" "}
                    <span className="ml-1 text-xs opacity-75">
                      · {count} {t("featureHub.copy.active")}
                    </span>
                  </button>
                );
              })}
            </div>
          )}
        </header>
      </div>

      <div>
        <div className="max-w-5xl">
          {(error || (updateError && !selectedModule)) && (
            <div
              role="alert"
              className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800"
            >
              {updateError
                ? t(updateError) || updateError
                : t("featureHub.copy.couldNotLoadModules")}
            </div>
          )}
          {notice && (
            <div className="mb-4 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-sm font-medium text-green-700">
              {notice}
            </div>
          )}

          <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px] xl:grid-cols-[minmax(0,1fr)_300px]">
            <main className="min-w-0">
              <div className="mb-4 rounded-lg border border-gray-200 bg-white">
                <div className="space-y-3 px-4 py-4 md:px-5">
                  <label className="relative block">
                    <MagnifyingGlassIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                    <input
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                      placeholder={t("featureHub.copy.searchModules")}
                      className="h-10 w-full rounded-md border border-gray-200 bg-white pl-9 pr-9 text-sm outline-none transition focus:border-primary-500 focus:ring-2 focus:ring-primary-100"
                    />
                    {query && (
                      <button
                        type="button"
                        onClick={clearSearch}
                        aria-label={t("featureHub.copy.clearSearch")}
                        title={t("featureHub.copy.clearSearch")}
                        className="absolute right-2 top-1/2 inline-flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900"
                      >
                        <XMarkIcon className="h-4 w-4" />
                      </button>
                    )}
                  </label>
                  <div className="flex gap-2 overflow-x-auto pb-1">
                    {FEATURE_CATEGORIES.map((item) => (
                      <button
                        key={item}
                        type="button"
                        onClick={() => setCategory(item)}
                        className={cx(
                          "h-8 shrink-0 rounded-full px-3 text-[12px] font-medium transition-colors",
                          category === item
                            ? "bg-primary-600 text-white"
                            : "bg-gray-100 text-gray-600 hover:bg-gray-200 hover:text-gray-900",
                        )}
                      >
                        {item}
                      </button>
                    ))}
                  </div>
                </div>
              </div>

              {waitingForInventory ? (
                <div
                  role="status"
                  className="flex items-center justify-center gap-2 rounded-lg border border-gray-200 bg-white px-5 py-12 text-sm text-gray-500"
                >
                  <ArrowPathIcon className="h-4 w-4 animate-spin" />
                  {t("featureHub.copy.loadingModules")}
                </div>
              ) : inventoryFailed ? null : filteredModules.length === 0 ? (
                <div className="rounded-lg border border-dashed border-gray-300 bg-white px-5 py-12 text-center">
                  <SparklesIcon className="mx-auto h-8 w-8 text-gray-400" />
                  <p className="mt-3 text-sm font-semibold text-gray-900">
                    {query
                      ? t("featureHub.noSearchResults", { query })
                      : t("featureHub.copy.noModulesInThisCategory")}
                  </p>
                  {query && (
                    <button
                      type="button"
                      onClick={clearSearch}
                      className="mt-3 inline-flex items-center gap-1.5 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:border-gray-400"
                    >
                      <XMarkIcon className="h-4 w-4" />
                      {t("featureHub.copy.clearSearch")}
                    </button>
                  )}
                </div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-gray-200 bg-white">
                  <div className="divide-y divide-gray-100">
                    {filteredModules.map((module) => (
                      <ModuleCard
                        t={t}
                        key={module.id}
                        module={module}
                        isActive={activeModuleSet.has(module.id)}
                        disabled={loading || !canManage || savingModuleId !== null}
                        saving={savingModuleId === module.id}
                        onOpen={() => setSelectedModule(module)}
                        onToggle={(isActive) => toggleModule(module, isActive)}
                      />
                    ))}
                  </div>
                </div>
              )}
            </main>

            {!waitingForInventory && !inventoryFailed && (
              <aside className="lg:sticky lg:top-4 lg:self-start">
                <NavigationPreview
                  t={t}
                  product={displayedProduct}
                  activeModuleIds={activeModuleIds}
                />
              </aside>
            )}
          </div>
        </div>
      </div>

      {selectedModule && (
        <DetailModal
          t={t}
          module={selectedModule}
          isActive={activeModuleSet.has(selectedModule.id)}
          disabled={loading || !canManage || savingModuleId !== null}
          saving={savingModuleId === selectedModule.id}
          error={updateError ? t(updateError) || updateError : ""}
          onClose={() => setSelectedModule(null)}
          onToggle={(isActive) => toggleModule(selectedModule, isActive)}
        />
      )}
    </div>
  );
}

function ModuleCard({
  t,
  module,
  isActive,
  disabled,
  saving,
  onOpen,
  onToggle,
}: {
  t: Translate;
  module: FeatureModule;
  isActive: boolean;
  disabled: boolean;
  saving: boolean;
  onOpen: () => void;
  onToggle: (isActive: boolean) => void;
}) {
  return (
    <article
      className={cx(
        "flex flex-col gap-4 px-4 py-4 transition sm:flex-row sm:items-center sm:justify-between md:px-5",
        isActive ? "bg-primary-50/40" : "bg-white hover:bg-gray-50/70",
      )}
    >
      <div className="flex min-w-0 items-start gap-3">
        <ModuleIcon module={module} active={isActive} />
        <div className="min-w-0">
          <div className="flex min-h-6 flex-wrap items-center gap-2">
            <h2 className="text-[14px] font-semibold text-gray-900">
              {t(`featureHub.module.${module.id}.name`)}
            </h2>
            {module.isNew && (
              <span className="shrink-0 rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                {t("featureHub.copy.new")}
              </span>
            )}
            <span
              className={cx(
                "rounded-md px-2 py-0.5 text-[11px] font-medium",
                isActive ? "bg-primary-100 text-primary-700" : "bg-gray-100 text-gray-600",
              )}
            >
              {isActive ? t("featureHub.copy.active") : t("featureHub.copy.inactive")}
            </span>
          </div>
          <p className="mt-1 text-[13px] leading-5 text-gray-500">
            {t(`featureHub.module.${module.id}.description`)}
          </p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <span className="rounded-md bg-gray-100 px-2 py-1 text-[11px] font-medium text-gray-600">
              {t(`featureHub.category.${module.category}`)}
            </span>
            {module.type === "external" && (
              <span className="rounded-md bg-primary-50 px-2 py-1 text-[11px] font-medium text-primary-700">
                {t("featureHub.copy.external")}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex shrink-0 items-center justify-between gap-3 sm:justify-end">
        <button
          type="button"
          onClick={onOpen}
          className="inline-flex h-9 items-center justify-center rounded-md border border-gray-200 bg-white px-3 text-[13px] font-medium text-gray-700 hover:border-gray-400 hover:text-gray-900"
        >
          {t("featureHub.copy.details")}
        </button>
        <ToggleSwitch
          checked={isActive}
          disabled={disabled || saving}
          ariaLabel={t("admin.actionName", {
            action: isActive ? t("featureHub.copy.deactivate") : t("admin.activate"),
            name: t(`featureHub.module.${module.id}.name`),
          })}
          onChange={(checked) => onToggle(checked)}
        />
      </div>
    </article>
  );
}

function ToggleSwitch({
  checked,
  disabled,
  ariaLabel,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cx(
        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-primary-600" : "bg-gray-300",
      )}
    >
      <span
        className={cx(
          "inline-block h-5 w-5 transform rounded-full bg-white shadow transition-transform",
          checked ? "translate-x-5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function ModuleIcon({ module, active }: { module: FeatureModule; active: boolean }) {
  if (module.type === "external") {
    return (
      <div
        className={cx(
          "flex h-11 w-11 items-center justify-center rounded-md border text-sm font-black",
          active
            ? "border-primary-200 bg-primary-50 text-primary-700"
            : "border-gray-200 bg-gray-50 text-gray-700",
        )}
      >
        <BrandMark id={module.icon} />
      </div>
    );
  }
  const icons = {
    chart: ChartGlyph,
    chat: ChatGlyph,
    users: UsersGlyph,
  };
  const Icon = icons[module.icon as keyof typeof icons] || ChatGlyph;
  return (
    <div
      className={cx(
        "flex h-11 w-11 items-center justify-center rounded-md border",
        active
          ? "border-primary-200 bg-primary-50 text-primary-700"
          : "border-gray-200 bg-gray-50 text-gray-600",
      )}
    >
      <Icon className="h-5 w-5" />
    </div>
  );
}

function BrandMark({ id }: { id: string }) {
  if (id === "stripe") return <span className="text-[15px] tracking-normal">S</span>;
  if (id === "paypal") return <span className="text-[15px] tracking-normal">P</span>;
  if (id === "xendit") return <span className="text-[12px] tracking-normal">XDT</span>;
  if (id === "lodgify") return <span className="text-[12px] tracking-normal">LDG</span>;
  return <span className="text-[12px] tracking-normal">{id.slice(0, 3).toUpperCase()}</span>;
}

function NavigationPreview({
  t,
  product,
  activeModuleIds,
}: {
  t: Translate;
  product: FeatureProduct;
  activeModuleIds: string[];
}) {
  const navModules = activeNavModules(product, activeModuleIds);
  const active = new Set(activeModuleIds);
  const nonNavActive = modulesForProduct(product).filter(
    (module) => active.has(module.id) && !module.navItem && module.settingsNote,
  );
  const coreNavItems = CORE_NAV_ITEMS[product];
  const moduleNavIndex = FEATURE_MODULE_NAV_INDEX[product];
  const previewItems = [
    ...coreNavItems.slice(0, moduleNavIndex).map((item) => ({
      key: `core:${item.href}`,
      label: item.label,
      isModule: false,
    })),
    ...navModules.map((module) => ({
      key: `module:${module.id}`,
      label: module.navItem!.label,
      isModule: true,
    })),
    ...coreNavItems.slice(moduleNavIndex).map((item) => ({
      key: `core:${item.href}`,
      label: item.label,
      isModule: false,
    })),
  ];

  return (
    <section className="rounded-lg border border-gray-200 bg-white">
      <button
        type="button"
        className="flex w-full items-center justify-between border-b border-gray-100 px-4 py-3 text-left lg:pointer-events-none"
      >
        <div>
          <h2 className="text-[14px] font-semibold text-gray-900">
            {t(`featureHub.navigation.${product}`)}
          </h2>
          <p className="mt-0.5 text-xs text-gray-500">{t("admin.livePreview2")}</p>
        </div>
        <ChevronDownIcon className="h-4 w-4 text-gray-400 lg:hidden" />
      </button>
      <div className="p-3">
        <ol className="space-y-1.5">
          {previewItems.map((item) => (
            <li
              key={item.key}
              className={cx(
                "flex h-9 items-center gap-2 rounded-md px-2 text-[13px]",
                item.isModule ? "bg-primary-50 font-semibold text-primary-700" : "text-gray-500",
              )}
            >
              <span
                className={cx(
                  "rounded-full",
                  item.isModule ? "h-2 w-2 bg-primary-500" : "h-1.5 w-1.5 bg-gray-300",
                )}
              />
              <span className="truncate">{t(`featureHub.navigationItem.${item.label}`)}</span>
            </li>
          ))}
        </ol>
        {nonNavActive.length > 0 && (
          <div className="mt-4 space-y-2 border-t border-gray-100 pt-3">
            {nonNavActive.map((module) => (
              <div
                key={module.id}
                className="rounded-md bg-primary-50 px-3 py-2 text-xs text-primary-700"
              >
                <span className="font-semibold">{t(`featureHub.module.${module.id}.name`)}</span>:{" "}
                {module.settingsNote}
              </div>
            ))}
          </div>
        )}
        <div className="mt-4 flex items-center justify-between border-t border-gray-100 pt-3 text-xs font-medium text-gray-500">
          <span>
            {previewItems.length} {t("featureHub.copy.items")}
          </span>
          <span>
            {navModules.length} {t("featureHub.copy.moduleItems")}
          </span>
        </div>
      </div>
    </section>
  );
}

function DetailModal({
  t,
  error,
  module,
  isActive,
  disabled,
  saving,
  onClose,
  onToggle,
}: {
  t: Translate;
  module: FeatureModule;
  isActive: boolean;
  disabled: boolean;
  saving: boolean;
  error: string;
  onClose: () => void;
  onToggle: (isActive: boolean) => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = `feature-hub-detail-${module.id}`;

  useEffect(() => {
    const previousActiveElement =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onClose();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = Array.from(
        dialogRef.current?.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ) || [],
      ).filter(
        (element) => !element.hasAttribute("disabled") && !element.getAttribute("aria-hidden"),
      );

      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    closeButtonRef.current?.focus();
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      previousActiveElement?.focus();
    };
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/35 backdrop-blur-sm sm:items-center sm:p-4"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="flex max-h-[100dvh] w-full flex-col overflow-hidden rounded-t-lg bg-white shadow-2xl sm:max-h-[92vh] sm:max-w-3xl sm:rounded-lg"
      >
        {error && (
          <div role="alert" className="bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {error}
          </div>
        )}
        <div className="flex items-start gap-3 border-b border-gray-100 px-4 py-4 sm:px-5">
          <ModuleIcon module={module} active={isActive} />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={titleId} className="text-xl font-semibold text-gray-950">
                {t(`featureHub.module.${module.id}.name`)}
              </h2>
              {module.isNew && (
                <span className="rounded-md bg-amber-100 px-1.5 py-0.5 text-[10px] font-bold text-amber-700">
                  {t("featureHub.copy.new")}
                </span>
              )}
            </div>
            <div className="mt-1 flex flex-wrap gap-1.5">
              <span className="rounded-md bg-gray-100 px-2 py-1 text-xs font-medium text-gray-600">
                {t(`featureHub.category.${module.category}`)}
              </span>
              {module.type === "external" && (
                <span className="rounded-md bg-primary-50 px-2 py-1 text-xs font-medium text-primary-700">
                  {t("featureHub.copy.externalIntegration")}
                </span>
              )}
            </div>
          </div>
          <button
            ref={closeButtonRef}
            type="button"
            onClick={onClose}
            aria-label={t("featureHub.copy.close")}
            title={t("featureHub.copy.close")}
            className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-gray-500 hover:bg-gray-100 hover:text-gray-900"
          >
            <XMarkIcon className="h-5 w-5" />
          </button>
        </div>

        <div className="overflow-y-auto px-4 py-4 sm:px-5">
          <p className="text-base font-medium leading-7 text-gray-900">
            {t(`featureHub.module.${module.id}.headline`)}
          </p>
          <div className="mt-4 overflow-hidden rounded-md border border-gray-200 bg-gray-50">
            <ModuleVisual type={module.detail.visualType} t={t} />
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2">
            {module.detail.features.map((feature, index) => (
              <div
                key={t(`featureHub.module.${module.id}.feature.${index}`)}
                className="flex min-h-14 items-start gap-2 rounded-md border border-gray-200 bg-white p-3"
              >
                <feature.icon className="mt-0.5 h-4 w-4 shrink-0 text-primary-600" />
                <p className="text-sm leading-5 text-gray-700">
                  {t(`featureHub.module.${module.id}.feature.${index}`)}
                </p>
              </div>
            ))}
          </div>
          {isActive && (
            <p className="mt-4 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {t("featureHub.copy.deactivatingHidesThisModuleFromNavigationOrSettingsYourData")}
            </p>
          )}
        </div>

        <div className="flex flex-col gap-3 border-t border-gray-100 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <div className="flex items-center gap-3">
            <ToggleSwitch
              checked={isActive}
              disabled={disabled || saving}
              ariaLabel={t("admin.actionName", {
                action: isActive ? t("featureHub.copy.deactivate") : t("admin.activate"),
                name: t(`featureHub.module.${module.id}.name`),
              })}
              onChange={onToggle}
            />
            <span className="text-sm font-semibold text-gray-700">
              {isActive ? t("featureHub.copy.active") : t("featureHub.copy.inactive")}
            </span>
          </div>
          <button
            type="button"
            disabled={disabled || saving}
            onClick={() => onToggle(!isActive)}
            className={cx(
              "inline-flex h-10 items-center justify-center gap-2 rounded-md px-4 text-sm font-semibold transition disabled:cursor-not-allowed disabled:opacity-60",
              isActive
                ? "border border-gray-200 bg-white text-gray-700 hover:border-gray-400"
                : "bg-primary-600 text-white hover:bg-primary-700",
            )}
          >
            <PowerIcon className="h-4 w-4" />
            {isActive ? t("featureHub.copy.deactivate") : t("featureHub.copy.activateModule")}
          </button>
        </div>
      </div>
    </div>
  );
}

function ModuleVisual({ type, t }: { type: FeatureModule["detail"]["visualType"]; t: Translate }) {
  if (type === "financials") return <FinancialsVisual />;
  if (type === "affiliates") return <AffiliatesVisual t={t} />;
  if (type === "stripe") return <StripeVisual />;
  if (type === "paypal") return <PayPalVisual />;
  if (type === "xendit") return <XenditVisual />;
  if (type === "lodgify") return <LodgifyVisual />;
  return <InboxVisual />;
}

function InboxVisual() {
  const rows = [
    ["Booking.com", "Marta Silva", "Can we arrive at 21:30?", "08:42"],
    ["Airbnb", "Jon Keller", "Thanks, parking looks good.", "09:18"],
    ["Email", "Ari Putra", "Do you offer airport pickup?", "10:04"],
  ];
  return (
    <svg viewBox="0 0 760 300" className="h-auto w-full" role="img" aria-label="Inbox preview">
      <rect width="760" height="300" fill="#f8faf8" />
      <rect x="34" y="34" width="692" height="232" rx="10" fill="#fff" stroke="#d6d3d1" />
      <rect x="56" y="58" width="156" height="180" rx="8" fill="#f0fdf4" />
      <rect x="72" y="78" width="88" height="12" rx="6" fill="#16a34a" />
      <rect x="72" y="112" width="126" height="8" rx="4" fill="#bbf7d0" />
      <rect x="72" y="136" width="104" height="8" rx="4" fill="#bbf7d0" />
      {rows.map((row, index) => {
        const y = 62 + index * 64;
        return (
          <g key={row[1]}>
            <rect
              x="236"
              y={y}
              width="454"
              height="48"
              rx="8"
              fill={index === 0 ? "#ecfdf5" : "#fff"}
              stroke="#e7e5e4"
            />
            <circle cx="258" cy={y + 24} r="8" fill={index === 0 ? "#10b981" : "#a8a29e"} />
            <text x="278" y={y + 20} fontSize="12" fontWeight="700" fill="#111827">
              {row[1]}
            </text>
            <text x="278" y={y + 36} fontSize="10" fill="#78716c">
              {row[2]}
            </text>
            <rect x="560" y={y + 13} width="76" height="18" rx="9" fill="#e0f2fe" />
            <text x="574" y={y + 26} fontSize="9" fontWeight="700" fill="#0369a1">
              {row[0]}
            </text>
            <text x="650" y={y + 26} fontSize="10" fill="#78716c">
              {row[3]}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

function FinancialsVisual() {
  const bars = [64, 92, 74, 128, 104, 148, 118, 168, 134, 184, 158, 204];
  return (
    <svg viewBox="0 0 760 300" className="h-auto w-full" role="img" aria-label="Financials preview">
      <rect width="760" height="300" fill="#f8faf8" />
      {["RevPAR", "ADR", "Occupancy", "Revenue"].map((label, index) => (
        <g key={label}>
          <rect
            x={34 + index * 178}
            y="34"
            width="154"
            height="74"
            rx="9"
            fill="#fff"
            stroke="#d6d3d1"
          />
          <text x={50 + index * 178} y="62" fontSize="11" fill="#78716c">
            {label}
          </text>
          <text x={50 + index * 178} y="88" fontSize="23" fontWeight="700" fill="#111827">
            {index === 2 ? "79%" : index === 3 ? "42k" : `${110 + index * 24}`}
          </text>
          <text x={125 + index * 178} y="88" fontSize="11" fontWeight="700" fill="#16a34a">
            +{index + 3}%
          </text>
        </g>
      ))}
      <rect x="34" y="132" width="692" height="230" rx="10" fill="#fff" stroke="#d6d3d1" />
      {bars.map((height, index) => (
        <rect
          key={index}
          x={62 + index * 54}
          y={260 - height}
          width="28"
          height={height}
          rx="5"
          fill={index > 8 ? "#10b981" : "#a7f3d0"}
        />
      ))}
      <path
        d="M56 220 C160 192 214 210 300 172 C390 132 446 164 520 118 C590 76 646 110 702 64"
        fill="none"
        stroke="#0369a1"
        strokeWidth="4"
        strokeLinecap="round"
      />
    </svg>
  );
}

function AffiliatesVisual({ t = defaultTranslate }: { t?: Translate }) {
  const rows = [
    ["Bali Stay Guide", "1,248", "36", "EUR 9,420", "EUR 471"],
    ["Surf School Co", "642", "18", "EUR 4,820", "EUR 241"],
    ["Villa Concierge", "388", "11", "EUR 3,104", "EUR 155"],
  ];
  return (
    <svg
      viewBox="0 0 760 300"
      className="h-auto w-full"
      role="img"
      aria-label={t("featureHub.copy.affiliatesPreview")}
    >
      <rect width="760" height="300" fill="#f8faf8" />
      <rect x="38" y="40" width="684" height="220" rx="10" fill="#fff" stroke="#d6d3d1" />
      <rect x="60" y="66" width="640" height="34" rx="6" fill="#f5f5f4" />
      {[
        t("featureHub.copy.partner"),
        t("featureHub.copy.clicks"),
        t("featureHub.copy.bookings"),
        t("featureHub.copy.revenue"),
        t("featureHub.copy.commission"),
      ].map((label, index) => (
        <text
          key={label}
          x={[78, 286, 388, 504, 620][index]}
          y="88"
          fontSize="11"
          fontWeight="700"
          fill="#57534e"
        >
          {label}
        </text>
      ))}
      {rows.map((row, index) => {
        const y = 122 + index * 48;
        return (
          <g key={row[0]}>
            <rect
              x="60"
              y={y - 22}
              width="640"
              height="44"
              rx="6"
              fill={index === 0 ? "#ecfdf5" : "#fff"}
              stroke="#e7e5e4"
            />
            {row.map((value, column) => (
              <text
                key={value}
                x={[78, 286, 388, 504, 620][column]}
                y={y + 5}
                fontSize="12"
                fontWeight={column === 0 ? "700" : "500"}
                fill={column === 4 ? "#047857" : "#111827"}
              >
                {value}
              </text>
            ))}
          </g>
        );
      })}
    </svg>
  );
}

function StripeVisual() {
  return (
    <PaymentVisual brand="Stripe" accent="#635bff" labels={["Visa", "MC", "Amex", "Apple Pay"]} />
  );
}

function PayPalVisual() {
  return (
    <PaymentVisual
      brand="PayPal"
      accent="#0070ba"
      labels={["PayPal", "Balance", "Card", "Buyer"]}
    />
  );
}

function XenditVisual() {
  return <PaymentVisual brand="Xendit" accent="#7c3aed" labels={["BCA", "BNI", "BRI", "OVO"]} />;
}

function PaymentVisual({
  brand,
  accent,
  labels,
}: {
  brand: string;
  accent: string;
  labels: string[];
}) {
  return (
    <svg
      viewBox="0 0 760 300"
      className="h-auto w-full"
      role="img"
      aria-label={`${brand} payment preview`}
    >
      <rect width="760" height="300" fill="#f8faf8" />
      <rect x="48" y="52" width="220" height="178" rx="12" fill="#fff" stroke="#d6d3d1" />
      <text x="72" y="92" fontSize="27" fontWeight="800" fill={accent}>
        {brand}
      </text>
      <rect x="72" y="122" width="148" height="34" rx="17" fill={accent} opacity="0.92" />
      <text x="104" y="145" fontSize="12" fontWeight="700" fill="#fff">
        Pay now
      </text>
      <text x="72" y="188" fontSize="12" fill="#78716c">
        Settlement profile
      </text>
      <rect x="72" y="202" width="128" height="8" rx="4" fill="#d6d3d1" />
      <rect x="310" y="52" width="404" height="178" rx="12" fill="#fff" stroke="#d6d3d1" />
      <path
        d="M342 144 H442 L486 96 H588 L636 144 H682"
        fill="none"
        stroke={accent}
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {labels.map((label, index) => (
        <g key={label}>
          <rect
            x={342 + index * 84}
            y="170"
            width="66"
            height="34"
            rx="7"
            fill="#f5f5f4"
            stroke="#e7e5e4"
          />
          <text x={360 + index * 84} y="192" fontSize="11" fontWeight="700" fill="#44403c">
            {label}
          </text>
        </g>
      ))}
      <text x="342" y="82" fontSize="12" fontWeight="700" fill="#111827">
        Payment flow
      </text>
      <text x="342" y="238" fontSize="11" fill="#78716c">
        Fees and availability are configured after activation.
      </text>
    </svg>
  );
}

function LodgifyVisual() {
  return (
    <svg
      viewBox="0 0 760 300"
      className="h-auto w-full"
      role="img"
      aria-label="Lodgify sync preview"
    >
      <rect width="760" height="300" fill="#f8faf8" />
      <rect x="62" y="86" width="210" height="124" rx="12" fill="#fff" stroke="#d6d3d1" />
      <text x="96" y="132" fontSize="26" fontWeight="800" fill="#0f766e">
        Lodgify
      </text>
      <rect x="98" y="154" width="124" height="10" rx="5" fill="#ccfbf1" />
      <rect x="98" y="176" width="92" height="10" rx="5" fill="#ccfbf1" />
      <rect x="488" y="86" width="210" height="124" rx="12" fill="#fff" stroke="#d6d3d1" />
      <text x="540" y="132" fontSize="26" fontWeight="800" fill="#047857">
        Vayada
      </text>
      <rect x="528" y="154" width="124" height="10" rx="5" fill="#bbf7d0" />
      <rect x="528" y="176" width="92" height="10" rx="5" fill="#bbf7d0" />
      <path
        d="M292 126 C354 78 432 78 468 126"
        fill="none"
        stroke="#0f766e"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <path
        d="M468 174 C404 222 338 222 292 174"
        fill="none"
        stroke="#10b981"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <polygon points="462,118 482,126 462,136" fill="#0f766e" />
      <polygon points="298,166 278,174 298,184" fill="#10b981" />
      <text x="338" y="144" fontSize="12" fontWeight="700" fill="#44403c">
        Rooms, rates, availability
      </text>
      <text x="348" y="168" fontSize="12" fontWeight="700" fill="#44403c">
        Bookings and updates
      </text>
    </svg>
  );
}

function ChatGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 5h16v11H8l-4 4V5Z" />
      <path d="M8 9h8M8 12h5" />
    </svg>
  );
}

function ChartGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M4 19V5M4 19h16" />
      <path d="M8 16v-5M12 16V8M16 16v-9" />
    </svg>
  );
}

function UsersGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
    >
      <path d="M9 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM3 21a6 6 0 0 1 12 0" />
      <path d="M16 8a3 3 0 1 1 0 6M17 17a5 5 0 0 1 4 4" />
    </svg>
  );
}

export const featureHubMessages = {
  "featureHub.noSearchResults": "No modules match “{query}”",
  "featureHub.activated": "{name} activated.",
  "featureHub.deactivated": "{name} deactivated.",
  "featureHub.copy.couldNotLoadModules": "Could not load modules. Please retry.",
  "featureHub.copy.deactivate": "Deactivate",
  "admin.activate": "Activate",
  "manageProperties.activeBadge": "Active",
  "bookingFlow.promoCodes.inactive": "Inactive",
  "admin.actionName": "{action} {name}",
  "admin.activatedNote": "Activated. {note}",
  "admin.nameStatus": "{name}: {status}",
  "admin.livePreview2": "Live preview",
  "featureHub.module.affiliates.name": "Affiliates",
  "featureHub.module.affiliates.description":
    "Let partners earn commission on the bookings they refer to you.",
  "featureHub.module.affiliates.headline":
    "Open a partner channel without adding manual commission tracking.",
  "featureHub.category.All": "All",
  "featureHub.category.Distribution": "Distribution",
  "featureHub.product.pms": "PMS Modules",
  "featureHub.product.booking_engine": "Booking Engine Modules",
  "featureHub.navigation.pms": "PMS navigation",
  "featureHub.navigation.booking_engine": "Booking Engine navigation",
  "featureHub.module.affiliates.feature.0": "Invite partners and track their referral activity.",
  "featureHub.module.affiliates.feature.1": "See clicks, bookings, revenue, and commission earned.",
  "featureHub.module.affiliates.feature.2": "Issue partner links tied to your booking engine.",
  "featureHub.module.affiliates.feature.3": "Prepare payout-ready commission records.",
  "featureHub.navigationItem.Dashboard": "Dashboard",
  "featureHub.navigationItem.Calendar": "Calendar",
  "featureHub.navigationItem.Reservations": "Reservations",
  "featureHub.navigationItem.Reviews": "Reviews",
  "featureHub.navigationItem.Rooms & Rates": "Rooms & Rates",
  "featureHub.navigationItem.Channel Manager": "Channel Manager",
  "featureHub.navigationItem.Settings": "Settings",
  "featureHub.navigationItem.Design Studio": "Design Studio",
  "featureHub.navigationItem.Booking Flow": "Booking Flow",
  "featureHub.navigationItem.Promo Codes": "Promo Codes",
  "featureHub.navigationItem.Affiliates": "Affiliates",
  "featureHub.copy.couldNotUpdateModuleActivation": "Could not update module activation.",
  "featureHub.copy.featureHub": "Feature Hub",
  "featureHub.copy.activatePropertyModulesAndKeepNavigationFocusedOnTheTools":
    "Activate property modules and keep navigation focused on the tools your team uses.",
  "featureHub.copy.active": "Active",
  "featureHub.copy.syncing": "Syncing",
  "featureHub.copy.searchModules": "Search modules...",
  "featureHub.copy.clearSearch": "Clear search",
  "featureHub.copy.loadingModules": "Loading modules...",
  "featureHub.copy.noModulesInThisCategory": "No modules in this category.",
  "featureHub.copy.new": "NEW",
  "featureHub.copy.inactive": "Inactive",
  "featureHub.copy.external": "External",
  "featureHub.copy.details": "Details",
  "featureHub.copy.items": "items",
  "featureHub.copy.moduleItems": "module items",
  "featureHub.copy.externalIntegration": "External integration",
  "featureHub.copy.close": "Close",
  "featureHub.copy.deactivatingHidesThisModuleFromNavigationOrSettingsYourData":
    "Deactivating hides this module from navigation or settings. Your data is preserved and will be available if you reactivate.",
  "featureHub.copy.activateModule": "Activate Module",
  "featureHub.copy.affiliatesPreview": "Affiliates preview",
  "featureHub.copy.partner": "Partner",
  "featureHub.copy.clicks": "Clicks",
  "featureHub.copy.bookings": "Bookings",
  "featureHub.copy.revenue": "Revenue",
  "featureHub.copy.commission": "Commission",
};

function defaultTranslate(key: string, params?: Record<string, string | number>): string {
  let text = featureHubMessages[key as keyof typeof featureHubMessages] ?? key;
  for (const [name, value] of Object.entries(params ?? {}))
    text = text.split(`{${name}}`).join(String(value));
  return text;
}
