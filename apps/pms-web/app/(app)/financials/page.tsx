import { BanknotesIcon } from "@heroicons/react/24/outline";

export default function FinancialsPage() {
  return (
    <div className="p-4 md:p-6">
      <div className="max-w-3xl">
        <h1 className="text-xl font-bold text-gray-900">Financials</h1>
        <p className="mt-1 text-sm text-gray-500">
          Review property payments, invoices, and revenue.
        </p>

        <div className="mt-6 rounded-xl border border-gray-200 bg-white p-6 text-center md:p-8">
          <div className="mx-auto flex h-11 w-11 items-center justify-center rounded-lg bg-gray-100 text-gray-500">
            <BanknotesIcon className="h-5 w-5" />
          </div>
          <h2 className="mt-4 text-base font-semibold text-gray-900">Not available yet</h2>
          <p className="mx-auto mt-2 max-w-md text-sm leading-6 text-gray-500">
            Financial reporting is still being connected to the new hotel platform. No payment or
            invoice data is available on this page yet.
          </p>
        </div>
      </div>
    </div>
  );
}
