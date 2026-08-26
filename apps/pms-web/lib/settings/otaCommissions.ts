const PERCENTAGE = /^(?:0|[1-9]\d?)(?:\.\d{1,4})?$|^100(?:\.0{1,4})?$/;
const LOCAL_DATE_TIME =
  /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d$/;

export function canonicalEffectiveFrom(value: string): string | null {
  if (!LOCAL_DATE_TIME.test(value)) return null;
  const parsed = new Date(value);
  return parsed.getFullYear() === Number(value.slice(0, 4)) &&
    parsed.getMonth() + 1 === Number(value.slice(5, 7)) &&
    parsed.getDate() === Number(value.slice(8, 10)) &&
    parsed.getHours() === Number(value.slice(11, 13)) &&
    parsed.getMinutes() === Number(value.slice(14, 16))
    ? parsed.toISOString()
    : null;
}
export function otaCommissionFormErrors(percentageRate: string, effectiveFrom: string) {
  return {
    percentageRate: PERCENTAGE.test(percentageRate.trim())
      ? ""
      : "Enter a percentage from 0 to 100 with up to four decimal places.",
    effectiveFrom: canonicalEffectiveFrom(effectiveFrom)
      ? ""
      : "Choose a valid effective date and time.",
  };
}
export function displayPercentage(value: string): string {
  return value.replace(/\.0+$/, "").replace(/(\.\d*?)0+$/, "$1");
}
