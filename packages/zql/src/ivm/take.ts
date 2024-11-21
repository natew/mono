import {assert, unreachable} from '../../../shared/src/asserts.js';
import {must} from '../../../shared/src/must.js';
import type {Row, Value} from '../../../zero-protocol/src/data.js';
import {assertOrderingIncludesPK} from '../builder/builder.js';
import {
  rowForChange,
  type Change,
  type EditChange,
  type RemoveChange,
} from './change.js';
import {normalizeUndefined, type Node} from './data.js';
import type {
  Constraint,
  FetchRequest,
  Input,
  Operator,
  Output,
  Storage,
} from './operator.js';
import type {SourceSchema} from './schema.js';
import {first, take, type Stream} from './stream.js';

const MAX_BOUND_KEY = 'maxBound';

type TakeState = {
  size: number;
  bound: Row | undefined;
};

interface TakeStorage {
  get(key: typeof MAX_BOUND_KEY): Row | undefined;
  get(key: string): TakeState | undefined;
  set(key: typeof MAX_BOUND_KEY, value: Row): void;
  set(key: string, value: TakeState): void;
  del(key: string): void;
}

/**
 * The Take operator is for implementing limit queries. It takes the first n
 * nodes of its input as determined by the input’s comparator. It then keeps
 * a *bound* of the last item it has accepted so that it can evaluate whether
 * new incoming pushes should be accepted or rejected.
 *
 * Take can count rows globally or by unique value of some field.
 */
export class Take implements Operator {
  readonly #input: Input;
  readonly #storage: TakeStorage;
  readonly #limit: number;
  readonly #partitionKey: string | undefined;

  #output: Output | null = null;

  constructor(
    input: Input,
    storage: Storage,
    limit: number,
    partitionKey?: string | undefined,
  ) {
    assert(limit >= 0);
    assertOrderingIncludesPK(
      input.getSchema().sort,
      input.getSchema().primaryKey,
    );
    assert(
      partitionKey === undefined || partitionKey !== '',
      'Invalid partition key',
    );
    input.setOutput(this);
    this.#input = input;
    this.#storage = storage as TakeStorage;
    this.#limit = limit;
    this.#partitionKey = partitionKey;
  }

  setOutput(output: Output): void {
    this.#output = output;
  }

  getSchema(): SourceSchema {
    return this.#input.getSchema();
  }

  *fetch(req: FetchRequest): Stream<Node> {
    if (!this.#partitionKey || req.constraint?.key === this.#partitionKey) {
      const takeStateKey = getTakeStateKeyFromConstraint(
        this.#partitionKey,
        req.constraint,
      );
      const takeState = this.#storage.get(takeStateKey);
      if (!takeState) {
        yield* this.#initialFetch(req);
        return;
      }
      if (takeState.bound === undefined) {
        return;
      }
      for (const inputNode of this.#input.fetch(req)) {
        if (this.getSchema().compareRows(takeState.bound, inputNode.row) < 0) {
          return;
        }
        yield inputNode;
      }
      return;
    }
    // There is a partition key, but the fetch is not constrained or constrained
    // on a different key.  Thus we don't have a single take state to bound by.
    // This currently only happens with nested sub-queries
    // e.g. issues include issuelabels include label.  We could remove this
    // case if we added a translation layer (powered by some state) in join.
    // Specifically we need joinKeyValue => parent constraint key
    const maxBound = this.#storage.get(MAX_BOUND_KEY);
    if (maxBound === undefined) {
      return;
    }
    for (const inputNode of this.#input.fetch(req)) {
      if (this.getSchema().compareRows(inputNode.row, maxBound) > 0) {
        return;
      }
      const takeStateKey = getTakeStateKeyFromRow(
        this.#partitionKey,
        inputNode.row,
      );
      const takeState = this.#storage.get(takeStateKey);
      if (
        takeState?.bound !== undefined &&
        this.getSchema().compareRows(takeState.bound, inputNode.row) >= 0
      ) {
        yield inputNode;
      }
    }
  }

  *#initialFetch(req: FetchRequest): Stream<Node> {
    assert(req.start === undefined);
    assert(
      !this.#partitionKey ||
        (req.constraint && req.constraint.key === this.#partitionKey),
    );

    if (this.#limit === 0) {
      return;
    }

    const takeStateKey = getTakeStateKeyFromConstraint(
      this.#partitionKey,
      req.constraint,
    );
    assert(this.#storage.get(takeStateKey) === undefined);

    let size = 0;
    let bound: Row | undefined;
    let downstreamEarlyReturn = true;
    try {
      for (const inputNode of this.#input.fetch(req)) {
        yield inputNode;
        bound = inputNode.row;
        size++;
        if (size === this.#limit) {
          break;
        }
      }
      downstreamEarlyReturn = false;
    } finally {
      this.#setTakeState(
        takeStateKey,
        size,
        bound,
        this.#storage.get(MAX_BOUND_KEY),
      );
      // If it becomes necessary to support downstream early return, this
      // assert should be removed, and replaced with code that consumes
      // the input stream until limit is reached or the input stream is
      // exhausted so that takeState is properly hydrated.
      assert(
        !downstreamEarlyReturn,
        'Unexpected early return prevented full hydration',
      );
    }
  }

  *cleanup(req: FetchRequest): Stream<Node> {
    assert(req.start === undefined);
    assert(
      !this.#partitionKey ||
        (req.constraint && req.constraint.key === this.#partitionKey),
    );

    let takeState: TakeState | undefined;
    if (this.#limit > 0) {
      const takeStateKey = getTakeStateKeyFromConstraint(
        this.#partitionKey,
        req.constraint,
      );
      takeState = this.#storage.get(takeStateKey);
      assert(takeState !== undefined);
      this.#storage.del(takeStateKey);
    }
    for (const inputNode of this.#input.cleanup(req)) {
      if (
        takeState?.bound === undefined ||
        this.getSchema().compareRows(takeState.bound, inputNode.row) < 0
      ) {
        return;
      }
      yield inputNode;
    }
  }

  #getStateAndConstraint(row: Row) {
    const takeStateKey = getTakeStateKeyFromRow(this.#partitionKey, row);
    const takeState = this.#storage.get(takeStateKey);
    let maxBound: Row | undefined;
    let constraint: Constraint | undefined;
    // The partition key was never fetched, so this push can be discarded.
    if (takeState) {
      maxBound = this.#storage.get(MAX_BOUND_KEY);
      constraint = this.#partitionKey
        ? {
            key: this.#partitionKey,
            value: row[this.#partitionKey],
          }
        : undefined;
    }

    return {takeState, takeStateKey, maxBound, constraint} as
      | {
          takeState: undefined;
          takeStateKey: string;
          maxBound: undefined;
          constraint: undefined;
        }
      | {
          takeState: TakeState;
          takeStateKey: string;
          maxBound: Row | undefined;
          constraint: Constraint | undefined;
        };
  }

  push(change: Change): void {
    if (change.type === 'edit') {
      this.#pushEditChange(change);
      return;
    }

    assert(this.#output, 'Output not set');

    const {takeState, takeStateKey, maxBound, constraint} =
      this.#getStateAndConstraint(rowForChange(change));
    if (!takeState) {
      return;
    }

    const {compareRows} = this.getSchema();

    if (change.type === 'add') {
      if (takeState.size < this.#limit) {
        this.#setTakeState(
          takeStateKey,
          takeState.size + 1,
          takeState.bound === undefined ||
            compareRows(takeState.bound, change.node.row) < 0
            ? change.node.row
            : takeState.bound,
          maxBound,
        );
        this.#output.push(change);
        return;
      }
      // size === limit
      if (
        takeState.bound === undefined ||
        compareRows(change.node.row, takeState.bound) >= 0
      ) {
        return;
      }
      // added row < bound
      let beforeBoundNode: Node | undefined;
      let boundNode: Node;
      if (this.#limit === 1) {
        boundNode = must(
          first(
            this.#input.fetch({
              start: {
                row: takeState.bound,
                basis: 'at',
              },
              constraint,
            }),
          ),
        );
      } else {
        [beforeBoundNode, boundNode] = take(
          this.#input.fetch({
            start: {
              row: takeState.bound,
              basis: 'before',
            },
            constraint,
          }),
          2,
        );
      }
      const removeChange: RemoveChange = {
        type: 'remove',
        node: boundNode,
      };
      this.#setTakeState(
        takeStateKey,
        takeState.size,
        beforeBoundNode === undefined ||
          compareRows(change.node.row, beforeBoundNode.row) > 0
          ? change.node.row
          : beforeBoundNode.row,
        maxBound,
      );
      this.#output.push(removeChange);
      this.#output.push(change);
    } else if (change.type === 'remove') {
      if (takeState.bound === undefined) {
        // change is after bound
        return;
      }
      const compToBound = compareRows(change.node.row, takeState.bound);
      if (compToBound > 0) {
        // change is after bound
        return;
      }
      let newBound: {node: Node; push: boolean} | undefined;
      for (const node of this.#input.fetch({
        start: {
          row: takeState.bound,
          basis: 'before',
        },
        constraint,
      })) {
        const push = compareRows(node.row, takeState.bound) > 0;
        newBound = {
          node,
          push,
        };
        if (push) {
          break;
        }
      }

      if (newBound?.push) {
        this.#setTakeState(
          takeStateKey,
          takeState.size,
          newBound.node.row,
          maxBound,
        );
        this.#output.push(change);
        this.#output.push({
          type: 'add',
          node: newBound.node,
        });
        return;
      }
      this.#setTakeState(
        takeStateKey,
        takeState.size - 1,
        newBound?.node.row,
        maxBound,
      );
      this.#output.push(change);
    } else if (change.type === 'child') {
      // A 'child' change should be pushed to output if its row
      // is <= bound.
      if (takeState.bound && compareRows(change.row, takeState.bound) <= 0) {
        this.#output.push(change);
      }
    }
  }

  #pushEditChange(change: EditChange): void {
    assert(this.#output, 'Output not set');

    if (
      this.#partitionKey &&
      change.oldNode.row[this.#partitionKey] !==
        change.node.row[this.#partitionKey]
    ) {
      // different partition key so fall back to remove/add.

      // TODO: So in some cases these don't need to be transformed into a remove
      // + add.
      //
      // If the oldRow was <= the bound of the old partition value, and the
      // newRow is <= the bound of the new partition value, this can be sent as
      // an edit, as the row is present in the output of this operator before
      // and after applying this push.

      this.push({
        type: 'remove',
        node: change.oldNode,
      });
      this.push({
        type: 'add',
        node: change.node,
      });
      return;
    }

    const {takeState, takeStateKey, maxBound, constraint} =
      this.#getStateAndConstraint(change.oldNode.row);
    if (!takeState) {
      return;
    }

    assert(takeState.bound, 'Bound should be set');
    const {compareRows} = this.getSchema();
    const oldCmp = compareRows(change.oldNode.row, takeState.bound);
    const newCmp = compareRows(change.node.row, takeState.bound);

    const replaceBoundAndForwardChange = () => {
      this.#setTakeState(
        takeStateKey,
        takeState.size,
        change.node.row,
        maxBound,
      );
      this.#output!.push(change);
    };

    // The bounds row was changed.
    if (oldCmp === 0) {
      // The new row is the new bound.
      if (newCmp === 0) {
        // no need to update the state since we are keeping the bounds
        this.#output.push(change);
        return;
      }

      if (newCmp < 0) {
        if (this.#limit === 1) {
          replaceBoundAndForwardChange();
          return;
        }

        // New row will be in the result but it might not be the bounds any
        // more. We need to find the row before the bounds to determine the new
        // bounds.

        const beforeBoundNode = must(
          first(
            this.#input.fetch({
              start: {
                row: takeState.bound,
                basis: 'before',
              },
              constraint,
            }),
          ),
        );

        this.#setTakeState(
          takeStateKey,
          takeState.size,
          beforeBoundNode.row,
          maxBound,
        );
        this.#output.push(change);
        return;
      }

      assert(newCmp > 0);
      // Find the first item at the old bounds. This will be the new bounds.
      const newBoundNode = must(
        first(
          this.#input.fetch({
            start: {
              row: takeState.bound,
              basis: 'at',
            },
            constraint,
          }),
        ),
      );

      // The next row is the new row. We can replace the bounds and keep the
      // edit change.
      if (compareRows(newBoundNode.row, change.node.row) === 0) {
        replaceBoundAndForwardChange();
        return;
      }

      // The new row is now outside the bounds, so we need to remove the old
      // row and add the new bounds row.
      this.#setTakeState(
        takeStateKey,
        takeState.size,
        newBoundNode.row,
        maxBound,
      );
      this.#output.push({
        type: 'remove',
        node: change.oldNode,
      });
      this.#output.push({
        type: 'add',
        node: newBoundNode,
      });
      return;
    }

    if (oldCmp > 0) {
      assert(newCmp !== 0, 'Invalid state. Row has duplicate primary key');

      // Both old and new outside of bounds
      if (newCmp > 0) {
        return;
      }

      // old was outside, new is inside. Pushing out the old bounds
      assert(newCmp < 0);

      const [newBoundNode, oldBoundNode] = take(
        this.#input.fetch({
          start: {
            row: takeState.bound,
            basis: 'before',
          },
          constraint,
        }),
        2,
      );

      this.#setTakeState(
        takeStateKey,
        takeState.size,
        newBoundNode.row,
        maxBound,
      );

      this.#output.push({
        type: 'remove',
        node: oldBoundNode,
      });

      this.#output.push({
        type: 'add',
        node: change.node,
      });

      return;
    }

    if (oldCmp < 0) {
      assert(newCmp !== 0, 'Invalid state. Row has duplicate primary key');

      // Both old and new inside of bounds
      if (newCmp < 0) {
        this.#output.push(change);
        return;
      }

      // old was inside, new is larger than old bound

      assert(newCmp > 0);

      // at this point we need to find the row after the bound and use that or
      // the newRow as the new bound.
      const afterBoundNode = must(
        first(
          this.#input.fetch({
            start: {
              row: takeState.bound,
              basis: 'after',
            },
            constraint,
          }),
        ),
      );

      // The new row is the new bound. Use an edit change.
      if (compareRows(afterBoundNode.row, change.node.row) === 0) {
        replaceBoundAndForwardChange();
        return;
      }

      this.#setTakeState(
        takeStateKey,
        takeState.size,
        afterBoundNode.row,
        maxBound,
      );

      this.#output.push({
        type: 'remove',
        node: change.oldNode,
      });
      this.#output.push({
        type: 'add',
        node: afterBoundNode,
      });
      return;
    }

    unreachable();
  }

  #setTakeState(
    takeStateKey: string,
    size: number,
    bound: Row | undefined,
    maxBound: Row | undefined,
  ) {
    this.#storage.set(takeStateKey, {
      size,
      bound,
    });
    if (
      bound !== undefined &&
      (maxBound === undefined ||
        this.getSchema().compareRows(bound, maxBound) > 0)
    ) {
      this.#storage.set(MAX_BOUND_KEY, bound);
    }
  }

  destroy(): void {
    this.#input.destroy();
  }
}

function getTakeStateKey(partitionValue: Value): string {
  return JSON.stringify(['take', normalizeUndefined(partitionValue)]);
}

function getTakeStateKeyFromRow(
  partitionKey: string | undefined,
  row: Row,
): string {
  return getTakeStateKey(partitionKey && row[partitionKey]);
}

function getTakeStateKeyFromConstraint(
  partitionKey: string | undefined,
  constraint: Constraint | undefined,
): string {
  return getTakeStateKey(partitionKey && constraint?.value);
}
