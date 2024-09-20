import {useLayoutEffect, useState} from 'react';
import type {Schema} from 'zql/src/zql/query/schema.js';
import type {Query, QueryType, Smash} from 'zql/src/zql/query/query.js';
import {TypedView} from 'zql/src/zql/query/typed-view.js';
import {deepClone} from 'shared/src/deep-clone.js';
import {QueryImpl} from 'zql/src/zql/query/query-impl.js';
import {assert} from 'shared/src/asserts.js';

export function useQuery<TSchema extends Schema, TReturn extends QueryType>(
  q: Query<TSchema, TReturn> | undefined | false,
): Smash<TReturn> {
  const queryImpl = q as QueryImpl<TSchema, TReturn>;
  assert(!queryImpl.singular, 'singular queries not supported yet');

  const [snapshot, setSnapshot] = useState<Smash<TReturn>>(
    (queryImpl.singular ? undefined : []) as unknown as Smash<TReturn>,
  );
  const [, setView] = useState<TypedView<Smash<TReturn>> | undefined>(
    undefined,
  );

  useLayoutEffect(() => {
    if (q) {
      const view = q.materialize();
      setView(view);
      const unsubscribe = view.addListener(snapshot => {
        setSnapshot(deepClone(snapshot) as Smash<TReturn>);
      });
      view.hydrate();
      return () => {
        unsubscribe();
        view.destroy();
      };
    }
    return () => {
      //
    };
  }, [JSON.stringify(q ? (q as QueryImpl<never, never>).ast : null)]);

  return snapshot;
}
