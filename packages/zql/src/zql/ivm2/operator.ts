// An input to an operator.
// Inputs "vend" (chosen to avoid confusion with "output") data in some order.

import type {JSONValue} from 'replicache';
import type {Change} from './change.js';
import type {Node, Row, Value} from './data.js';
import type {Stream} from './stream.js';

/**
 * Input to an operator. Typically another Operator but can also be a Source.
 */
export interface Input {
  // The schema of the data this input returns.
  get schema(): Schema;

  // Request initial result from this operator and initialize its state.
  // Returns nodes sorted in order of schema().comparator.
  hydrate(req: HydrateRequest, output: Output): Stream<Node>;

  // Fetch data previously returned by hydrate or push.
  // Does not modify current state.
  // Returns nodes sorted in order of schema().comparator.
  fetch(req: FetchRequest, output: Output): Stream<Node>;

  // Dehydrate the operator. This is called when `output` will no longer
  // need the data returned by hydrate(). The receiving operator should
  // clean up any resources it has allocated.
  dehydrate(req: HydrateRequest, output: Output): Stream<Node>;
}

// Information about the nodes output by an operator.
export type Schema = {
  // if ever needed ... none of current operators need.
  // idKeys: string[];
  // columns: Record<string, ValueType>;
  // relationships: Record<string, Schema>;
  // Compares two rows in the output of an operator.
  compareRows: (r1: Row, r2: Row) => number;
};

export type HydrateRequest = {
  constraint?: Constraint | undefined;
};

export type Constraint = {
  key: string;
  value: Value;
};

export type FetchRequest = HydrateRequest & {
  // If supplied, `start.row` must have previously been output.
  start?: Start | undefined;
};

export type Start = {
  row: Row;
  basis: 'before' | 'at' | 'after';
};

/**
 * An output for an operator. Typically another Operator but can also be
 * the code running the pipeline.
 */
export interface Output {
  // Push incremental changes to data previously received with hydrate().
  // Consumers must apply all pushed changes or incremental result will
  // be incorrect.
  // Callers must maintain some invariants for correct operation:
  // - Only add rows which do not already exist (by deep equality).
  // - Only remove rows which do exist (by deep equality).
  push(change: Change, input: Input): void;
}

/**
 * Operators are arranged into pipelines.
 * They are stateful.
 * Each operator is an input to the next operator in the chain and an output
 * to the previous.
 */
export interface Operator extends Input, Output {}

/**
 * Operators get access to storage that they can store their internal
 * state in.
 */
export interface Storage {
  set(key: Value[], value: JSONValue): void;
  get(key: Value[], def?: JSONValue): JSONValue | undefined;
  del(key: Value[]): void;
}
