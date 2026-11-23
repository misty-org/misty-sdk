import { describe, expect, it } from "vitest";
import { pickProtocol } from "./client.js";
import { MistyError } from "./errors.js";
import { live } from "./live.js";

describe("live", () => {
  it("starts on the first subscriber, keeps one snapshot per change and stops on the last", () => {
    const started: string[] = [];
    let push: ((value: number) => void) | undefined;
    const value = live<number>((set) => {
      started.push("start");
      push = set;
      return () => started.push("stop");
    });
    expect(value.get().status).toBe("waiting");
    const seen: unknown[] = [];
    const stopFirst = value.subscribe((state) => seen.push(state.status));
    const stopSecond = value.subscribe(() => {});
    push?.(3);
    const snapshot = value.get();
    expect(snapshot).toEqual({ status: "ready", value: 3, error: undefined });
    expect(value.get()).toBe(snapshot);
    stopFirst();
    expect(started).toEqual(["start"]);
    stopSecond();
    expect(started).toEqual(["start", "stop"]);
    expect(value.get().status).toBe("waiting");
    expect(seen).toEqual(["waiting", "ready"]);
  });

  it("says when it failed, keeping the last value", () => {
    let fail: ((error: MistyError) => void) | undefined;
    let set: ((value: string) => void) | undefined;
    const value = live<string>((onSet, onFail) => {
      set = onSet;
      fail = onFail;
      return () => {};
    });
    const stop = value.subscribe(() => {});
    set?.("a");
    fail?.(new MistyError("closed", "gone"));
    expect(value.get()).toMatchObject({ status: "failed", value: "a", error: { code: "closed" } });
    stop();
  });
});

describe("pickProtocol", () => {
  it("takes the highest version both sides speak, and a start message with only `version`", () => {
    expect(pickProtocol({ version: 1, versions: [1, 2, 3] })).toBe(1);
    expect(pickProtocol({ version: 1 })).toBe(1);
    expect(pickProtocol({ version: 9 })).toBeNull();
  });
});
