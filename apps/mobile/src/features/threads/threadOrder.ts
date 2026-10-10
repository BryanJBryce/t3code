import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  generateSpreadPinOrderKeys,
  pinOrderKeyBetween,
  planPinnedReorder,
} from "@t3tools/client-runtime/state/thread-sort";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";

export type ThreadMoveDestination =
  | "up"
  | "down"
  | {
      readonly targetId: string | null;
      readonly section?: "pinned" | "active" | "settled";
      readonly placement: "before" | "after";
    };

/** Resolve against stable row identities, including rows hidden by a filter. */
export function threadOrderAfterMove(
  orderedIds: readonly string[],
  movedId: string,
  destination: ThreadMoveDestination,
): string[] | null {
  if (typeof destination === "object" && destination.section === "settled") return null;
  const from = orderedIds.indexOf(movedId);
  if (from < 0 && (typeof destination === "string" || destination.section === undefined))
    return null;
  const result = orderedIds.filter((id) => id !== movedId);
  let to: number;
  if (typeof destination === "string") {
    to = from + (destination === "up" ? -1 : 1);
    if (to < 0 || to >= orderedIds.length) return null;
  } else {
    if (destination.targetId === null) {
      if (destination.section === undefined) return null;
      to = destination.placement === "before" ? 0 : result.length;
    } else {
      const target = result.indexOf(destination.targetId);
      if (target < 0) return null;
      to = target + (destination.placement === "after" ? 1 : 0);
    }
  }
  if (to === from) return null;
  result.splice(to, 0, movedId);
  return result;
}

export type OrderRow = Pick<
  EnvironmentThreadShell,
  | "id"
  | "environmentId"
  | "pinOrderKey"
  | "activeOrderKey"
  | "createdAt"
  | "unsettledAt"
  | "pinnedAt"
>;

export interface PendingThreadOrder {
  readonly section: "pinned" | "active";
  readonly orderedIds: readonly string[];
  readonly before: ReadonlyMap<string, { readonly key: string | null; readonly anchor: string }>;
  readonly assignments: ReadonlyMap<string, string>;
  readonly confirmed: ReadonlySet<string>;
  readonly commandsComplete: boolean;
}

function rowId(row: OrderRow): string {
  return `${row.environmentId}:${row.id}`;
}

function rowOrder(row: OrderRow, section: PendingThreadOrder["section"]) {
  return {
    key: (section === "pinned" ? row.pinOrderKey : row.activeOrderKey) ?? null,
    anchor: section === "pinned" ? (row.pinnedAt ?? "") : (row.unsettledAt ?? row.createdAt),
  };
}

/** Keep every visible row as an anchor, but only offer plans whose key writes
 * are supported. Menu availability and execution use this same planner. */
export function createThreadMovePlanner(input: {
  readonly ordered: readonly OrderRow[];
  readonly allThreads?: readonly OrderRow[];
  readonly section: PendingThreadOrder["section"];
  readonly reorderableEnvironmentIds: ReadonlySet<EnvironmentId>;
}) {
  const orderedIds = input.ordered.map(rowId);
  const keysById = new Map(
    (input.allThreads ?? input.ordered).map((row) => [
      rowId(row),
      rowOrder(row, input.section).key,
    ]),
  );
  const writableIds = new Set(
    (input.allThreads ?? input.ordered)
      .filter((row) => input.reorderableEnvironmentIds.has(row.environmentId))
      .map(rowId),
  );
  return (movedId: string, direction: ThreadMoveDestination) => {
    if (!writableIds.has(movedId)) return null;
    const nextIds = threadOrderAfterMove(orderedIds, movedId, direction);
    if (nextIds === null) return null;
    const assignments = planPinnedReorder({ orderedIds: nextIds, keysById, movedId });
    return assignments === null ||
      assignments.length === 0 ||
      assignments.some((assignment) => !writableIds.has(assignment.id))
      ? null
      : assignments;
  };
}

export interface ThreadMoveAvailability {
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

/**
 * Batch form of "call `createThreadMovePlanner` once per card": one pass over
 * the section answers up/down availability for every ordered row, so list
 * construction stays linear instead of one full planner probe (array copies,
 * hidden-key rescans) per row on the minute-tick rebuild path. The mirror of
 * the planner's plan rules lives in the body below; the reference-parity test
 * pins them row-by-row, including adversarial keys and hidden reservations.
 */
export function computeThreadMoveAvailability<Row extends OrderRow>(input: {
  readonly ordered: readonly Row[];
  readonly allThreads?: readonly OrderRow[];
  readonly section: PendingThreadOrder["section"];
  readonly reorderableEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly pendingOrder?: PendingThreadOrder | null;
  /** While the list is grouped by project: each displayed row's group (see
      `resolveGroupedThreadMove`). Moves then step over same-group rows. */
  readonly groupOf?: ((row: Row) => string | undefined) | null;
}): Map<string, ThreadMoveAvailability> {
  const result = new Map<string, ThreadMoveAvailability>();
  // A reorder in flight locks the whole list until its receipt lands.
  if (input.pendingOrder != null) return result;
  const rows = input.ordered;
  // With no neighbor there is no up/down move, so skip the allThreads indexes.
  if (rows.length < 2) {
    for (const row of rows) result.set(rowId(row), { canMoveUp: false, canMoveDown: false });
    return result;
  }
  // Plain loops: this runs per section on every Home rebuild over all shells,
  // and the map/filter/spread chains it replaces dominated it with garbage.
  const orderedIds: string[] = [];
  const indexById = new Map<string, number>();
  for (const row of rows) {
    const id = rowId(row);
    indexById.set(id, orderedIds.length);
    orderedIds.push(id);
  }
  const keysById = new Map<string, string | null>();
  const writableIds = new Set<string>();
  for (const row of input.allThreads ?? input.ordered) {
    const id = rowId(row);
    keysById.set(id, rowOrder(row, input.section).key);
    if (input.reorderableEnvironmentIds.has(row.environmentId)) writableIds.add(id);
  }
  // Read after the loop so a duplicate id reserves only its final key.
  const reservedKeys = new Set<string>();
  keysById.forEach((key, id) => {
    if (key != null && !indexById.has(id)) reservedKeys.add(key);
  });
  // Mirror of `planPinnedReorder` for up/down moves, hoisted so every row is
  // answered in O(1) amortized instead of one planner probe per row:
  //
  // Fast path (both neighbors keyed): the fresh key between the landing
  // neighbors, walking forward while hidden reserved keys block it. The walk
  // depends only on the neighbor key pair - each adjacency is probed by at
  // most two rows (down of the left member, up of the right member) - so the
  // memo keeps even a fully adversarial reserved-key layout linear per build.
  //
  // Rewrite path (keyless/unusable neighbor, or key space exhausted): fresh
  // spread keys for every row; only positions whose current key differs get
  // written. A move only shifts the rows between its two ends, so tallies
  // computed once per section answer each row in constant time.
  const midpoints = new Map<string, string | null>();
  const fastPathKey = (beforeKey: string | null, afterKey: string | null): string | null => {
    const memoKey = `${beforeKey ?? ""}\u0000${afterKey ?? ""}`;
    const cached = midpoints.get(memoKey);
    if (cached !== undefined) return cached;
    let key = pinOrderKeyBetween(beforeKey, afterKey);
    while (key !== null && reservedKeys.has(key)) key = pinOrderKeyBetween(key, afterKey);
    midpoints.set(memoKey, key);
    return key;
  };
  const spreadKeys = generateSpreadPinOrderKeys(orderedIds.length + reservedKeys.size)
    .filter((key) => !reservedKeys.has(key))
    .slice(0, orderedIds.length);
  const currentKeys = orderedIds.map((id) => keysById.get(id) ?? null);
  const writableRow = orderedIds.map((id) => writableIds.has(id));
  let baselineWrites = 0;
  let baselineUnwritableWrites = 0;
  for (let position = 0; position < orderedIds.length; position += 1) {
    if (currentKeys[position] === spreadKeys[position]) continue;
    baselineWrites += 1;
    if (!writableRow[position]) baselineUnwritableWrites += 1;
  }
  // A move from `from` to `to` shifts every row between them by one place.
  // Prefix sums of the baseline mismatches and of the mismatches each row
  // would have one place up or down answer any range in O(1).
  const count = orderedIds.length;
  const prefix = () => Array.from({ length: count + 1 }, () => 0);
  const base = [prefix(), prefix()];
  const shiftedUp = [prefix(), prefix()];
  const shiftedDown = [prefix(), prefix()];
  const tally = (sums: number[][], at: number, source: number | null) => {
    const mismatch = source !== null && currentKeys[source] !== spreadKeys[at];
    sums[0]![at + 1] = sums[0]![at]! + (mismatch ? 1 : 0);
    sums[1]![at + 1] = sums[1]![at]! + (mismatch && !writableRow[source!] ? 1 : 0);
  };
  for (let position = 0; position < count; position += 1) {
    tally(base, position, position);
    // `shiftedUp[p]`: position p holding the row from p + 1; `shiftedDown[p]`:
    // position p holding the row from p - 1.
    tally(shiftedUp, position, position + 1 < count ? position + 1 : null);
    tally(shiftedDown, position, position > 0 ? position - 1 : null);
  }
  const range = (sums: number[][], kind: 0 | 1, start: number, end: number) =>
    end < start ? 0 : sums[kind]![end + 1]! - sums[kind]![start]!;
  const rewriteViable = (from: number, to: number): boolean => {
    const low = Math.min(from, to);
    const high = Math.max(from, to);
    const shifted = to > from ? shiftedUp : shiftedDown;
    const shiftStart = to > from ? from : to + 1;
    const shiftEnd = to > from ? to - 1 : from;
    const movedMismatch = currentKeys[from] !== spreadKeys[to];
    const writes =
      baselineWrites -
      range(base, 0, low, high) +
      range(shifted, 0, shiftStart, shiftEnd) +
      (movedMismatch ? 1 : 0);
    const unwritableWrites =
      baselineUnwritableWrites -
      range(base, 1, low, high) +
      range(shifted, 1, shiftStart, shiftEnd) +
      (movedMismatch && !writableRow[from] ? 1 : 0);
    return writes > 0 && unwritableWrites === 0;
  };
  // Grouped lists step to the nearest row of the same group, found in one
  // pass in each direction.
  const groupOf = input.groupOf ?? null;
  const groupTargets = (() => {
    if (groupOf === null) return null;
    const groups = rows.map((row) => groupOf(row));
    const previous = Array.from({ length: count }, (): number | null => null);
    const next = Array.from({ length: count }, (): number | null => null);
    const last = new Map<string, number>();
    for (let position = 0; position < count; position += 1) {
      const group = groups[position];
      if (group === undefined) continue;
      const before = last.get(group);
      if (before !== undefined) {
        previous[position] = before;
        next[before] = position;
      }
      last.set(group, position);
    }
    return { groups, previous, next };
  })();
  for (const row of rows) {
    const movedId = rowId(row);
    const denied = { canMoveUp: false, canMoveDown: false };
    if (!writableIds.has(movedId)) {
      result.set(movedId, denied);
      continue;
    }
    const index = indexById.get(movedId);
    if (index === undefined) {
      result.set(movedId, denied);
      continue;
    }
    const adjacentAvailable = (towardUp: boolean): boolean => {
      const target =
        groupTargets === null
          ? index + (towardUp ? -1 : 1)
          : ((groupTargets.groups[index] === undefined
              ? null
              : (towardUp ? groupTargets.previous : groupTargets.next)[index]) ?? null);
      if (target === null || target < 0 || target >= orderedIds.length) return false;
      // The moved row ends at `target`, placed before (up) or after (down) the
      // row there, so it lands between these rows of the OLD order: moving up
      // between old(target-1) and old(target), moving down between
      // old(target) and old(target+1).
      const beforeIndex = towardUp ? target - 1 : target;
      const afterIndex = towardUp ? target : target + 1;
      const beforeId = beforeIndex < 0 ? null : (orderedIds[beforeIndex] ?? null);
      const afterId = afterIndex >= orderedIds.length ? null : (orderedIds[afterIndex] ?? null);
      const beforeKey = beforeId === null ? null : (keysById.get(beforeId) ?? null);
      const afterKey = afterId === null ? null : (keysById.get(afterId) ?? null);
      if ((beforeId === null || beforeKey != null) && (afterId === null || afterKey != null)) {
        const key = fastPathKey(beforeKey, afterKey);
        // A fresh key is a single-write plan for the (writable) moved row.
        if (key !== null) return true;
      }
      // Keyless neighbor or exhausted key space: the section rewrite runs.
      return rewriteViable(index, target);
    };
    result.set(movedId, {
      canMoveUp: adjacentAvailable(true),
      canMoveDown: adjacentAvailable(false),
    });
  }
  return result;
}

/**
 * Up/down while the list is grouped by project: the explicit placement next to
 * the nearest row of the moved row's group in the flat section order. Rows of
 * other groups keep their places, so the order keys of every other project
 * keep their interleaving. `groupOf` returns undefined for rows the list does
 * not show. Null when no same-group row lies in that direction.
 */
export function resolveGroupedThreadMove<Row extends OrderRow>(input: {
  readonly ordered: readonly Row[];
  readonly movedId: string;
  readonly direction: "up" | "down";
  readonly groupOf: (row: Row) => string | undefined;
}): ThreadMoveDestination | null {
  const { ordered, direction, groupOf } = input;
  const from = ordered.findIndex((row) => rowId(row) === input.movedId);
  const moved = ordered[from];
  const group = moved === undefined ? undefined : groupOf(moved);
  if (group === undefined) return null;
  const step = direction === "up" ? -1 : 1;
  for (let index = from + step; index >= 0 && index < ordered.length; index += step) {
    const row = ordered[index]!;
    if (groupOf(row) === group) {
      return { targetId: rowId(row), placement: direction === "up" ? "before" : "after" };
    }
  }
  return null;
}

export function createPendingThreadOrder(input: {
  readonly section: PendingThreadOrder["section"];
  readonly ordered: readonly OrderRow[];
  readonly movedId: string;
  readonly direction: ThreadMoveDestination;
  readonly assignments: readonly { readonly id: string; readonly orderKey: string }[];
}): PendingThreadOrder {
  const orderedIds = threadOrderAfterMove(input.ordered.map(rowId), input.movedId, input.direction);
  if (orderedIds === null) throw new Error("Cannot begin an invalid thread move");
  return {
    section: input.section,
    orderedIds,
    before: new Map(input.ordered.map((row) => [rowId(row), rowOrder(row, input.section)])),
    assignments: new Map(input.assignments.map(({ id, orderKey }) => [id, orderKey])),
    confirmed: new Set(),
    commandsComplete: false,
  };
}

/** Receipts and shell updates arrive independently. Only our own key writes
 * may pass through the hold; membership and other arrangement changes win. */
export function reconcilePendingThreadOrder(
  pending: PendingThreadOrder,
  ordered: readonly OrderRow[],
): PendingThreadOrder | null {
  if (ordered.length !== pending.before.size) return null;
  const confirmed = new Set(pending.confirmed);
  for (const row of ordered) {
    const id = rowId(row);
    const before = pending.before.get(id);
    const current = rowOrder(row, pending.section);
    if (before === undefined || current.anchor !== before.anchor) return null;
    const assigned = pending.assignments.get(id);
    if (assigned !== undefined && current.key === assigned) confirmed.add(id);
    else if (current.key !== before.key || confirmed.has(id)) return null;
  }
  if (pending.commandsComplete && confirmed.size === pending.assignments.size) return null;
  return confirmed.size === pending.confirmed.size ? pending : { ...pending, confirmed };
}

/** Apply the full section's pending order after search/environment filtering. */
export function applyPendingThreadOrder<T extends OrderRow>(
  rows: readonly T[],
  section: PendingThreadOrder["section"],
  pending: PendingThreadOrder | null | undefined,
): T[] {
  if (pending == null || pending.section !== section) return [...rows];
  const rank = new Map(pending.orderedIds.map((id, index) => [id, index]));
  return [...rows].sort(
    (left, right) => (rank.get(rowId(left)) ?? Infinity) - (rank.get(rowId(right)) ?? Infinity),
  );
}

/** Match desktop re-entry: a pin wakes the thread on the server; Active clears
 * each underlying parked state before assigning its destination order key. */
export function threadDropLifecycle(
  thread: EnvironmentThreadShell,
  section: "pinned" | "active",
  now: string,
) {
  if (section === "pinned") return { pin: true, unpin: false, unsettle: false, unsnooze: false };
  return {
    pin: false,
    unpin: thread.pinnedAt != null,
    unsettle: thread.settledOverride === "settled",
    unsnooze: effectiveSnoozed(thread, { now }),
  };
}

export type ThreadDragSection = "pinned" | "active" | "snoozed" | "settled";

/** The action shown during hover describes the lifecycle change made on drop. */
export function threadDragAction(source: ThreadDragSection, destination: ThreadDragSection) {
  if (destination === "snoozed") return null;
  if (destination === "settled") return source === "settled" ? null : "Settle";
  if (source === destination) return "Reorder";
  if (destination === "pinned") return "Pin";
  if (source === "pinned") return "Unpin";
  if (source === "settled") return "Unsettle";
  return "Unsnooze";
}
