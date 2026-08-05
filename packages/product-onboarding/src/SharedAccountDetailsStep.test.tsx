import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { describe, expect, it, vi } from "vitest";

import SharedAccountDetailsStep from "./SharedAccountDetailsStep";

describe("SharedAccountDetailsStep personal media boundary", () => {
  it("submits hotel-manager details with initials and never uploads personal media", async () => {
    const upload = vi.fn();
    const submit = vi.fn().mockResolvedValue(undefined);
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <SharedAccountDetailsStep
          accountType="hotel"
          email="manager@alpenrose.example"
          initialName="Flamur Maliqi"
          initialPhone="+49 89 123456"
          onUploadProfileImage={upload}
          onSubmit={submit}
        />,
      );
    });

    expect(
      renderer!.root.findAll((node) => node.type === "input" && node.props.type === "file"),
    ).toHaveLength(0);
    expect(renderer!.root.findByProps({ role: "img" }).props["aria-label"]).toBe(
      "Manager initials: FM",
    );

    await act(async () => {
      await renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => undefined });
    });

    expect(upload).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledWith({
      firstName: "Flamur",
      lastName: "Maliqi",
      phone: "+49 89 123456",
    });
  });

  it("keeps creator personal media required before upload or submit", async () => {
    const upload = vi.fn();
    const submit = vi.fn();
    let renderer: ReactTestRenderer;

    await act(async () => {
      renderer = create(
        <SharedAccountDetailsStep
          accountType="creator"
          email="creator@example.com"
          initialName="Maya Creator"
          initialPhone="+49 89 654321"
          onUploadProfileImage={upload}
          onSubmit={submit}
        />,
      );
    });

    expect(
      renderer!.root.findAll(
        (node) => node.type === "input" && node.props.type === "file" && node.props.required,
      ),
    ).toHaveLength(1);

    await act(async () => {
      await renderer!.root.findByType("form").props.onSubmit({ preventDefault: () => undefined });
    });

    expect(upload).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(renderer!.root.findAllByProps({ children: "Profile photo is required." })).toHaveLength(
      1,
    );
  });
});
