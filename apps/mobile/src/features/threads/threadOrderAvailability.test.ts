import { describe, expect, it } from "vite-plus/test";
import {
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
} from "@t3tools/client-runtime/state/thread-sort";
import type { EnvironmentId } from "@t3tools/contracts";

import {
  computeThreadMoveAvailability,
  createThreadMovePlanner,
  resolveGroupedThreadMove,
  threadOrderAfterMove,
  type OrderRow,
} from "./threadOrder";

// The batch availability computation must answer exactly what the reference
// per-move planner answers; these tests randomize sections that stress every
// branch (keyless rows, hidden keys, non-writable rows, adversarial keys).

function makeRow(id: string, environmentId: string, key: string | null, pinned: boolean): OrderRow {
  return {
    id: id as OrderRow["id"],
    environmentId: environmentId as OrderRow["environmentId"],
    pinOrderKey: pinned ? key : null,
    activeOrderKey: pinned ? null : key,
    createdAt: "2026-01-01T00:00:00.000Z",
    unsettledAt: "2026-01-01T00:00:00.000Z",
    pinnedAt: pinned ? "2026-01-01T00:00:00.000Z" : null,
  };
}

function makeRng(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

const KEY_POOL = [
  "a",
  "b",
  "ba",
  "bb",
  "c",
  "d",
  "ca",
  "cb",
  "da",
  "db",
  "e",
  "f",
  "g",
  "h",
  "i",
  "j",
  "k",
  "l",
  "m",
  "n",
  "o",
  "p",
  "q",
  "r",
  "s",
  "t",
  "u",
  "v",
  "w",
  "x",
  "y",
  "z",
  null,
];

function referenceAvailability(
  ordered: readonly OrderRow[],
  allThreads: readonly OrderRow[],
  writable: ReadonlySet<EnvironmentId>,
) {
  const planner = createThreadMovePlanner({
    ordered,
    allThreads,
    section: "pinned",
    reorderableEnvironmentIds: writable,
  });
  const answers = new Map<string, { canMoveUp: boolean; canMoveDown: boolean }>();
  for (const row of ordered) {
    const movedId = `${row.environmentId}:${row.id}`;
    answers.set(movedId, {
      canMoveUp: planner(movedId, "up") !== null,
      canMoveDown: planner(movedId, "down") !== null,
    });
  }
  return answers;
}

function randomCase(rng: () => number) {
  const rowCount = 1 + Math.floor(rng() * 9);
  // Two environments; "writable" env vs. one lacking the reorder capability.
  const rows: OrderRow[] = [];
  for (let index = 0; index < rowCount; index += 1) {
    const environment = rng() < 0.75 ? "env-w" : "env-x";
    const key = KEY_POOL[Math.floor(rng() * KEY_POOL.length)] ?? null;
    // Ids with colons: a `${environmentId}:${id}` string is not splittable
    // back into its parts, so batch and planner must agree even here.
    const id = rng() < 0.4 ? `t:${index}` : `t${index}`;
    rows.push(makeRow(id, environment, key, true));
  }
  // Hidden rows (in allThreads, not in the visible ordered section) may hold
  // keys that collide with fast-path midpoints.
  const hidden: OrderRow[] = [];
  const hiddenCount = Math.floor(rng() * 4);
  for (let index = 0; index < hiddenCount; index += 1) {
    const key = KEY_POOL[Math.floor(rng() * KEY_POOL.length)] ?? null;
    const id = rng() < 0.4 ? `h:${index}` : `h${index}`;
    hidden.push(makeRow(id, rng() < 0.75 ? "env-w" : "env-x", key, true));
  }
  return { ordered: rows, allThreads: [...rows, ...hidden] };
}

const WRITABLE = new Set<EnvironmentId>(["env-w" as EnvironmentId]);

describe("computeThreadMoveAvailability matches the reference planner", () => {
  it("agrees across randomized sections (keys, holes, non-writable rows, hidden keys)", () => {
    for (let seed = 1; seed <= 4_000; seed += 1) {
      const rng = makeRng(seed);
      const { ordered, allThreads } = randomCase(rng);
      const batch = computeThreadMoveAvailability({
        ordered,
        allThreads,
        section: "pinned",
        reorderableEnvironmentIds: WRITABLE,
      });
      const reference = referenceAvailability(ordered, allThreads, WRITABLE);
      for (const [id, answer] of reference) {
        expect(
          batch.get(id) ?? { canMoveUp: false, canMoveDown: false },
          `seed ${seed} row ${id} ordered=${ordered
            .map((row) => `${row.id}:${row.pinOrderKey ?? "-"}:${row.environmentId}`)
            .join(",")}`,
        ).toEqual(answer);
      }
    }
  });

  it("locks every row while a pending reorder is in flight", () => {
    const rows = [makeRow("t0", "env-w", "a", true), makeRow("t1", "env-w", "c", true)];
    const pending = {
      section: "pinned" as const,
      orderedIds: ["env-w:t1", "env-w:t0"],
      before: new Map(),
      assignments: new Map(),
      confirmed: new Set<string>(),
      commandsComplete: false,
    };
    const batch = computeThreadMoveAvailability({
      ordered: rows,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
      pendingOrder: pending,
    });
    expect(batch.size).toBe(0);
  });

  it("allows the fast-path walk past reserved keys and rewrites that skip matching keys (auditor cases)", () => {
    // Reported parity case: keys ["f","gn",null], middle row NOT writable.
    // The rewrite assigns the middle row the key it already holds, so the
    // diff never writes it and the first row's down-move stays available.
    const rows = [makeRow("t0", "env-w", "f", true), makeRow("t1", "env-x", "gn", true)];
    const withThird = [...rows, makeRow("t2", "env-w", null, true)];
    const batch = computeThreadMoveAvailability({
      ordered: withThird,
      allThreads: withThird,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
    });
    const reference = referenceAvailability(withThird, withThird, WRITABLE);
    expect(Object.fromEntries(batch)).toEqual(Object.fromEntries(reference));
    expect(batch.get("env-w:t0")).toEqual({ canMoveUp: false, canMoveDown: true });
  });

  it("keeps moves available for ids containing colons (composite-id parsing)", () => {
    // The reported case: environment `env`, ids `thread:1`/`thread:2`. Splitting
    // the composite id at the last colon yields `env:thread` and falsely locks
    // both rows; writability must come from the row's own environmentId.
    const rows = [makeRow("thread:1", "env", "a", true), makeRow("thread:2", "env", "c", true)];
    const batch = computeThreadMoveAvailability({
      ordered: rows,
      section: "pinned",
      reorderableEnvironmentIds: new Set<EnvironmentId>(["env" as EnvironmentId]),
    });
    const reference = referenceAvailability(
      rows,
      rows,
      new Set<EnvironmentId>(["env" as EnvironmentId]),
    );
    expect(Object.fromEntries(batch)).toEqual(Object.fromEntries(reference));
    expect(batch.get("env:thread:1")).toEqual({ canMoveUp: false, canMoveDown: true });
    expect(batch.get("env:thread:2")).toEqual({ canMoveUp: true, canMoveDown: false });
  });

  it("denies single-row sections on both directions", () => {
    const rows = [makeRow("t0", "env-w", "a", true)];
    const batch = computeThreadMoveAvailability({
      ordered: rows,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
    });
    expect(batch.get("env-w:t0")).toEqual({ canMoveUp: false, canMoveDown: false });
  });

  it("answers empty and single-row sections without consulting hidden rows", () => {
    const hidden = [makeRow("h0", "env-w", "b", true), makeRow("h1", "env-x", null, true)];
    expect(
      computeThreadMoveAvailability({
        ordered: [],
        allThreads: hidden,
        section: "pinned",
        reorderableEnvironmentIds: WRITABLE,
      }).size,
    ).toBe(0);
    for (const environment of ["env-w", "env-x"]) {
      const ordered = [makeRow("t0", environment, "a", true)];
      const allThreads = [...ordered, ...hidden];
      const batch = computeThreadMoveAvailability({
        ordered,
        allThreads,
        section: "pinned",
        reorderableEnvironmentIds: WRITABLE,
      });
      expect(Object.fromEntries(batch)).toEqual({
        [`${environment}:t0`]: { canMoveUp: false, canMoveDown: false },
      });
      expect(Object.fromEntries(batch)).toEqual(
        Object.fromEntries(referenceAvailability(ordered, allThreads, WRITABLE)),
      );
    }
  });

  it("denies rows whose section has non-writable neighbours when the fast path fails", () => {
    // Keyless neighbors force the section-rewrite fallback; a non-writable
    // neighbor makes the rewrite illegal for every row in the section.
    const rows = [
      makeRow("t0", "env-w", null, true),
      makeRow("t1", "env-x", "c", true),
      makeRow("t2", "env-w", "d", true),
    ];
    const batch = computeThreadMoveAvailability({
      ordered: rows,
      allThreads: rows,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
    });
    const reference = referenceAvailability(rows, rows, WRITABLE);
    expect(Object.fromEntries(batch)).toEqual(Object.fromEntries(reference));
    // Sanity: the middle (non-writable) row is denied on both sides.
    expect(batch.get("env-x:t1")).toEqual({ canMoveUp: false, canMoveDown: false });
  });

  it("agrees on a section where every adjacency midpoint is a hidden reserved key", () => {
    // The worst case for reserved-key collisions: one hidden row holds the
    // exact midpoint key of every adjacent visible pair, so every probe walks.
    const visibleKeys = generateSpreadPinOrderKeys(24);
    const hiddenKeys = visibleKeys
      .slice(0, -1)
      .map((key, index) => pinOrderKeyBetween(key, visibleKeys[index + 1]!))
      .filter((key): key is string => key != null);
    const ordered = visibleKeys.map((key, index) => makeRow(`v${index}`, "env-w", key, true));
    const hidden = hiddenKeys.map((key, index) => makeRow(`h${index}`, "env-w", key, true));
    const allThreads = [...ordered, ...hidden];
    const batch = computeThreadMoveAvailability({
      ordered,
      allThreads,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
    });
    const reference = referenceAvailability(ordered, allThreads, WRITABLE);
    expect(Object.fromEntries(batch)).toEqual(Object.fromEntries(reference));
  });

  it("agrees on an adversarial section of consecutive single-char keys", () => {
    // Every midpoint between consecutive one-char keys is unrepresentable, so
    // no row may claim a fast-path plan.
    const rows = ["a", "b", "c", "d"].map((key, index) => makeRow(`t${index}`, "env-w", key, true));
    const batch = computeThreadMoveAvailability({
      ordered: rows,
      allThreads: rows,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
    });
    const reference = referenceAvailability(rows, rows, WRITABLE);
    expect(Object.fromEntries(batch)).toEqual(Object.fromEntries(reference));
  });
});

describe("grouped up/down", () => {
  const rowKey = (row: OrderRow) => `${row.environmentId}:${row.id}`;
  const planGrouped = (
    ordered: readonly OrderRow[],
    allThreads: readonly OrderRow[],
    groupOf: (row: OrderRow) => string | undefined,
    movedId: string,
    direction: "up" | "down",
  ) => {
    const destination = resolveGroupedThreadMove({ ordered, movedId, direction, groupOf });
    if (destination === null) return null;
    const planner = createThreadMovePlanner({
      ordered,
      allThreads,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
    });
    const assignments = planner(movedId, destination);
    return assignments === null
      ? null
      : {
          order: threadOrderAfterMove(ordered.map(rowKey), movedId, destination),
          assignments,
        };
  };

  it("matches the reference planner across randomized grouped sections", () => {
    const GROUPS = ["a", "b", undefined] as const;
    for (let seed = 1; seed <= 3_000; seed += 1) {
      const rng = makeRng(seed);
      const { ordered, allThreads } = randomCase(rng);
      const groupById = new Map(
        ordered.map((row) => [rowKey(row), GROUPS[Math.floor(rng() * GROUPS.length)]]),
      );
      const groupOf = (row: OrderRow) => groupById.get(rowKey(row));
      const batch = computeThreadMoveAvailability({
        ordered,
        allThreads,
        section: "pinned",
        reorderableEnvironmentIds: WRITABLE,
        groupOf,
      });
      for (const row of ordered) {
        const id = rowKey(row);
        expect(
          batch.get(id) ?? { canMoveUp: false, canMoveDown: false },
          `seed ${seed} ${id}`,
        ).toEqual({
          canMoveUp: planGrouped(ordered, allThreads, groupOf, id, "up") !== null,
          canMoveDown: planGrouped(ordered, allThreads, groupOf, id, "down") !== null,
        });
      }
    }
  });

  // Flat a1, b1, a2 renders grouped as a1, a2 | b1.
  const interleaved = [
    makeRow("a1", "env-w", "c", true),
    makeRow("b1", "env-w", "g", true),
    makeRow("a2", "env-w", "m", true),
  ];
  const physical = (row: OrderRow) => (row.id.startsWith("a") ? "project-a" : "project-b");

  it("steps over other projects and writes only the moved row's key", () => {
    const down = planGrouped(interleaved, interleaved, physical, "env-w:a1", "down")!;
    expect(down.order).toEqual(["env-w:b1", "env-w:a2", "env-w:a1"]);
    expect(down.assignments).toHaveLength(1);
    expect(down.assignments[0]!.id).toBe("env-w:a1");
    expect(down.assignments[0]!.orderKey > "m").toBe(true);

    const up = planGrouped(interleaved, interleaved, physical, "env-w:a2", "up")!;
    expect(up.order).toEqual(["env-w:a2", "env-w:a1", "env-w:b1"]);
    expect(up.assignments).toEqual([{ id: "env-w:a2", orderKey: expect.any(String) }]);
    expect(up.assignments[0]!.orderKey < "c").toBe(true);
  });

  it("stops at the edges of each project run", () => {
    const batch = computeThreadMoveAvailability({
      ordered: interleaved,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
      groupOf: physical,
    });
    expect(batch.get("env-w:a1")).toEqual({ canMoveUp: false, canMoveDown: true });
    expect(batch.get("env-w:a2")).toEqual({ canMoveUp: true, canMoveDown: false });
    // b1 is alone in its project even though rows sit on both sides of it.
    expect(batch.get("env-w:b1")).toEqual({ canMoveUp: false, canMoveDown: false });
    expect(
      resolveGroupedThreadMove({
        ordered: interleaved,
        movedId: "env-w:b1",
        direction: "up",
        groupOf: physical,
      }),
    ).toBeNull();
  });

  it("treats one repository across environments as one run", () => {
    const rows = [
      makeRow("r1", "env-w", "c", true),
      makeRow("other", "env-w", "g", true),
      makeRow("r2", "env-w2", "m", true),
    ];
    const writable = new Set<EnvironmentId>(["env-w", "env-w2"] as EnvironmentId[]);
    const repository = (row: OrderRow) => (row.id === "other" ? "other" : "repo");
    const batch = computeThreadMoveAvailability({
      ordered: rows,
      section: "pinned",
      reorderableEnvironmentIds: writable,
      groupOf: repository,
    });
    expect(batch.get("env-w:r1")).toEqual({ canMoveUp: false, canMoveDown: true });
    expect(batch.get("env-w2:r2")).toEqual({ canMoveUp: true, canMoveDown: false });
    expect(
      resolveGroupedThreadMove({
        ordered: rows,
        movedId: "env-w:r1",
        direction: "down",
        groupOf: repository,
      }),
    ).toEqual({ targetId: "env-w2:r2", placement: "after" });
  });

  it("ignores rows the list hides", () => {
    // An environment filter hides b1; a1 and a2 are still neighbors.
    const shown = (row: OrderRow) => (row.id === "b1" ? undefined : physical(row));
    expect(
      resolveGroupedThreadMove({
        ordered: interleaved,
        movedId: "env-w:a1",
        direction: "down",
        groupOf: shown,
      }),
    ).toEqual({ targetId: "env-w:a2", placement: "after" });
  });

  it("keeps flat neighbors while grouping is off", () => {
    const batch = computeThreadMoveAvailability({
      ordered: interleaved,
      section: "pinned",
      reorderableEnvironmentIds: WRITABLE,
      groupOf: null,
    });
    expect(batch.get("env-w:b1")).toEqual({ canMoveUp: true, canMoveDown: true });
  });
});
