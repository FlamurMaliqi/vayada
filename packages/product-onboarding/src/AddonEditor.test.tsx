import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";
import AddonsStep from "./AddonsStep";
import { AddonEditor, emptyAddonValues } from "./AddonEditor";

describe("shared add-on editor", () => {
  it("shows inline errors on submit and leaves the save button enabled", async () => {
    const save = vi.fn();
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        <AddonEditor
          initialValues={emptyAddonValues("EUR")}
          currency="EUR"
          editing={false}
          onSave={save}
          onCancel={() => {}}
        />,
      );
    });
    await act(async () => {
      await view!.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    expect(save).not.toHaveBeenCalled();
    expect(view!.root.findAllByProps({ role: "alert" })).toHaveLength(2);
    expect(view!.root.findByProps({ type: "submit" }).props.disabled).toBeUndefined();
    expect(view!.root.findAllByProps({ name: "addon-pricing-model" })).toHaveLength(4);
  });

  it("retains photo order, changes cover, removes photos, and inherits property currency", async () => {
    const save = vi.fn();
    const photos = Array.from({ length: 5 }, (_, i) => ({
      imageUrl: `https://media.test/${i}`,
      mediaObjectId: `media-${i}`,
      isCover: i === 0,
    }));
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        <AddonEditor
          initialValues={{ ...emptyAddonValues("USD"), name: "Breakfast", price: "15.00", photos }}
          currency="EUR"
          editing
          onSave={save}
          onCancel={() => {}}
        />,
      );
    });
    expect(view!.root.findAllByProps({ "aria-label": "Add photos" })).toHaveLength(0);
    await act(async () => {
      view!.root.findByProps({ "aria-label": "Set photo 3 as cover" }).props.onClick();
    });
    await act(async () => {
      view!.root.findByProps({ "aria-label": "Remove photo 2" }).props.onClick();
    });
    await act(async () => {
      view!.root.findAllByProps({ name: "addon-pricing-model" })[3].props.onChange();
    });
    await act(async () => {
      await view!.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    const saved = save.mock.calls[0][0];
    expect(saved.currency).toBe("EUR");
    expect(saved.perPerson && saved.perNight).toBe(true);
    expect(saved.photos.map((p: { mediaObjectId: string }) => p.mediaObjectId)).toEqual([
      "media-0",
      "media-2",
      "media-3",
      "media-4",
    ]);
    expect(saved.photos.filter((p: { isCover: boolean }) => p.isCover)).toEqual([
      { ...photos[2], isCover: true },
    ]);
    await act(async () => {
      view!.unmount();
    });
    await act(async () => {
      view = create(
        <AddonEditor
          initialValues={saved}
          currency="EUR"
          editing
          onSave={save}
          onCancel={() => {}}
        />,
      );
    });
    expect(
      view!.root.findByProps({ "aria-label": "Set photo 2 as cover" }).props["aria-pressed"],
    ).toBe(true);
  });
});

it("onboarding retains managed media references in the same editor model", async () => {
  const setAddons = vi.fn();
  const upload = vi
    .fn()
    .mockResolvedValue({ mediaObjectId: "managed-photo", publicUrl: "https://media.test/photo" });
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(
      <AddonsStep
        addons={[]}
        setAddons={setAddons}
        currency="EUR"
        error=""
        canProceed
        onBack={() => {}}
        onContinue={() => {}}
        stepIndicators={null}
        uploadImage={upload}
      />,
    );
  });
  await act(async () => {
    view!.root.findAllByType("button")[0].props.onClick();
  });
  const file = new File(["image"], "photo.png", { type: "image/png" });
  await act(async () => {
    await view!.root
      .findByType(AddonEditor)
      .props.onSave({
        ...emptyAddonValues("EUR"),
        name: "Breakfast",
        price: "15.00",
        photos: [{ file, imageUrl: "blob:preview", mediaObjectId: null, isCover: true }],
      });
  });
  expect(upload).toHaveBeenCalledWith(file);
  expect(setAddons.mock.calls[0][0][0]).toMatchObject({
    name: "Breakfast",
    price: "15.00",
    currency: "EUR",
    image: "https://media.test/photo",
    photos: [
      { imageUrl: "https://media.test/photo", mediaObjectId: "managed-photo", isCover: true },
    ],
  });
});
