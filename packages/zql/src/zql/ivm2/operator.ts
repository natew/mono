// An input to an operator.
// Inputs "vend" (chosen to avoid confusion with "output") data in some order.

import type {Change} from './change.js';
import type {Node, Row} from './data.js';
import type {Stream} from './stream.js';

/**
 * Input to an operator. Typically another Operator but can also be a Source.
 */
export interface Input {
  // The schema of the data this input returns.
  schema(): Schema;

  // Request initial result from this operator and initialize its state.
  // Returns nodes sorted in order of schema().comparator.
  hydrate(req: HydrateRequest, output: Output): Stream<Node>;

  // Fetch data previously returned by hydrate or push.
  // Does not modify current state.
  // Returns nodes sorted in order of schema().comparator.
  fetch(req: FetchRequest, output: Output): Stream<Node>;
}

// Information about the nodes output by an operator.
export type Schema = {
  // if ever needed ... none of current operators need.
  // idKeys: string[];
  // columns: Record<string, ValueType>;
  // relationships: Map<string, Schema>;
  // Compares two rows in the output of an operator.
  compareRows: (r1: Row, r2: Row) => number;
};

// TODO: add optional filters
export type HydrateRequest = {
  constraint: Constraint;
};

export type Constraint = {
  key: string;
  value: string;
};

export type FetchRequest = HydrateRequest & {
  start?:
    | {
        row: Row;
        basis: 'before' | 'at' | 'after';
      }
    | undefined;
};

/**
 * An output for an operator. Typically another Operator but can also be
 * the code running the pipeline.
 */
export interface Output {
  // Push incremental changes to data previously received with hydrate().
  // Consumers must apply all pushed changes or incremental result will
  // be incorrect.
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
 * A source is an input that serves as the root data source of the pipeline.
 * Sources can have multiple outputs.
 */
export interface Source extends Input {
  addOutput(output: Output): void;
}

/**
 * Operators get access to storage that they can store their internal
 * state in.
 */
export interface Storage<T> {
  put(key: string, value: T): void;
  get(key: string, def: T | undefined): T | undefined;
}
