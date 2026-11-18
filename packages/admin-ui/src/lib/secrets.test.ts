import { describe, expect, it, vi } from "vitest";
import { detectSecretStore, MANAGEMENT_TOKEN_KEY } from "./secrets";

describe("detectSecretStore", () => {
  it("returns null when not running inside Tauri (Web 路径零变化)", () => {
    expect(detectSecretStore(undefined)).toBeNull();
    expect(detectSecretStore(null)).toBeNull();
    expect(detectSecretStore({} as never)).toBeNull();
  });

  it("delegates get/set/delete to the Tauri invoke commands", async () => {
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "secret_get") return args?.key === MANAGEMENT_TOKEN_KEY ? "lgm_tok" : null;
      return undefined;
    });
    const store = detectSecretStore({ invoke });
    expect(store).not.toBeNull();

    expect(await store!.get(MANAGEMENT_TOKEN_KEY)).toBe("lgm_tok");
    await store!.set(MANAGEMENT_TOKEN_KEY, "lgm_next");
    await store!.delete(MANAGEMENT_TOKEN_KEY);

    expect(invoke).toHaveBeenNthCalledWith(1, "secret_get", { key: MANAGEMENT_TOKEN_KEY });
    expect(invoke).toHaveBeenNthCalledWith(2, "secret_set", { key: MANAGEMENT_TOKEN_KEY, value: "lgm_next" });
    expect(invoke).toHaveBeenNthCalledWith(3, "secret_delete", { key: MANAGEMENT_TOKEN_KEY });
  });
});
