// @effect-diagnostics nodeBuiltinImport:off - exercises the installed native bundle without loading React Native.
import * as NodeFS from "node:fs";
import * as NodeVM from "node:vm";
import { describe, expect, it } from "vite-plus/test";
import { THREAD_FEED_END_FOLLOW_THRESHOLD } from "../apps/mobile/src/features/threads/thread-feed-live-follow";

function createList(bundle: string, insetStart: number) {
  const source = NodeFS.readFileSync(
    new URL(`../apps/mobile/node_modules/@legendapp/list/${bundle}`, import.meta.url),
    "utf8",
  );
  const edgeCheck = source.slice(
    source.indexOf("function checkAtBottom("),
    source.indexOf("// src/utils/checkAtTop.ts"),
  );
  const maintainEnd = source.slice(
    source.indexOf("function doMaintainScrollAtEnd("),
    source.indexOf("// src/utils/requestAdjust.ts"),
  );
  const frames: Array<() => void> = [];
  const timers: Array<() => void> = [];
  const values = new Map<string, unknown>();
  let contentSize = 1_200;
  const state = {
    props: {
      data: ["message"],
      maintainScrollAtEnd: { animated: false } as false | { animated: boolean },
      maintainScrollAtEndThreshold: THREAD_FEED_END_FOLLOW_THRESHOLD,
      onEndReachedThreshold: 0.5,
    },
    didContainersLayout: true,
    queuedInitialLayout: true,
    isUserDragging: false,
    isMomentumScrolling: false,
    scrollLength: 800,
    scroll: 400,
    refScroller: {
      current: {
        scrollTo: ({ y }: { y: number }) => {
          state.scroll = y;
        },
        scrollToEnd: () => {
          state.scroll = contentSize - state.scrollLength;
        },
      },
    },
  };
  const ctx = { state };
  const maintain = NodeVM.runInNewContext(
    `${edgeCheck}\n${maintainEnd}\n(ctx) => { checkAtBottom(ctx); doMaintainScrollAtEnd(ctx); }`,
    {
      requestAnimationFrame: (callback: () => void) => frames.push(callback),
      setTimeout: (callback: () => void) => timers.push(callback),
      getContentSize: () => contentSize,
      getContentInsetEnd: () => 0,
      getContentInsetStartAdjustment: () => insetStart,
      getIsAtEnd: () => contentSize - state.scroll - state.scrollLength <= 1,
      hasActiveInitialScroll: () => true,
      resetSharedEdgeGateIfOutsideHysteresis: () => {},
      peek$: (_ctx: unknown, key: string) => values.get(key),
      set$: (_ctx: unknown, key: string, value: unknown) => values.set(key, value),
    },
  ) as (context: typeof ctx) => void;
  return {
    state,
    resize: (size: number) => {
      contentSize = size;
      maintain(ctx);
    },
    maintain: () => maintain(ctx),
    flush: () => {
      for (const frame of frames.splice(0)) frame();
      for (const timer of timers.splice(0)) timer();
    },
  };
}

describe.each(["react-native.js", "react-native.mjs"])("chat end following (%s)", (bundle) => {
  describe.each([0, 100])("with a %i-point header inset", (insetStart) => {
    it("keeps the end pinned when delayed measurements exceed the default threshold", () => {
      const list = createList(bundle, insetStart);
      list.resize(2_000);
      list.flush();
      expect(list.state.scroll).toBe(1_200);
      list.resize(2_400);
      list.flush();
      expect(list.state.scroll).toBe(1_600);
    });

    it("recovers a follower after native reattachment moves its offset", () => {
      const list = createList(bundle, insetStart);
      list.state.scroll = 100;
      list.maintain();
      list.flush();
      expect(list.state.scroll).toBe(400);
    });

    it("preserves a history reader through a reconnect and content resize", () => {
      const list = createList(bundle, insetStart);
      list.state.scroll = 100;
      list.state.props.maintainScrollAtEnd = false;
      list.resize(2_000);
      list.flush();
      expect(list.state.scroll).toBe(100);
    });

    it.each(["drag", "momentum", "disclosure"] as const)(
      "cancels a queued end correction when a %s takes over before the next frame",
      (interaction) => {
        const list = createList(bundle, insetStart);
        list.resize(2_000);
        // A drag reaches the list before React commits the follow-latch prop.
        if (interaction === "drag") list.state.isUserDragging = true;
        if (interaction === "momentum") list.state.isMomentumScrolling = true;
        if (interaction === "disclosure") list.state.props.maintainScrollAtEnd = false;
        list.state.scroll = 100;
        list.flush();
        expect(list.state.scroll).toBe(100);
      },
    );
  });
});
