import { NationalitySelect as SharedNationalitySelect } from "@vayada/locale-ui/NationalitySelect";

export function NationalitySelect({
  label = "Nationality",
  value,
  onChange,
  disabled = false,
}: {
  label?: string;
  value: string;
  onChange: (code: string) => void;
  disabled?: boolean;
}) {
  return (
    <SharedNationalitySelect
      label={label}
      value={value}
      onChange={onChange}
      disabled={disabled}
      containerClassName="block"
      labelClassName="mb-1 block text-xs font-medium text-gray-600"
      inputClassName="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-base text-gray-900 placeholder-gray-400 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-gray-900 disabled:cursor-not-allowed disabled:bg-gray-100 disabled:text-gray-500"
      reviewClassName="mt-1 text-xs font-medium text-amber-700"
    />
  );
}
