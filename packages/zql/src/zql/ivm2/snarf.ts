import type {Input, Output} from './operator.js';
import type {Change} from './change.js';
import type {Node} from './data.js';

/**
 * A simple output that consumes and stores all pushed changes.
 */
export class Snarf implements Output {
  readonly changes: unknown[] = [];

  push(change: Change, _source: Input) {
    this.changes.push(expandChange(change));
  }

  reset() {
    this.changes.length = 0;
  }
}

function expandChange(change: Change): Change {
  if (change.type === 'child') {
    return {
      ...change,
      child: {
        ...change.child,
        change: expandChange(change.child.change),
      },
    };
  }
  return {
    ...change,
    node: expandNode(change.node),
  };
}

export function expandNode(node: Node): Node {
  return {
    ...node,
    relationships: Object.fromEntries(
      Object.entries(node.relationships).map(([k, v]) => [
        k,
        [...v].map(expandNode),
      ]),
    ),
  };
}
