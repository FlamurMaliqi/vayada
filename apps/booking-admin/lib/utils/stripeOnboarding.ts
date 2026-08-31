export async function continueStripeAfterSavingSettings<TResult>(input: {
  saveSettings: () => Promise<string | null>;
  continueStripe: (propertyId: string) => Promise<TResult>;
}): Promise<TResult | null> {
  const propertyId = await input.saveSettings();
  return propertyId ? input.continueStripe(propertyId) : null;
}
