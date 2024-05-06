import {describe, expect, test} from 'vitest';
import type {
  Downstream,
  PokeEndMessage,
  PokePartMessage,
  PokeStartMessage,
} from 'zero-protocol';
import {createSilentLogContext} from '../../test/logger.js';
import type {JSONObject} from '../../types/bigint-json.js';
import {Subscription} from '../../types/subscription.js';
import {ClientHandler, Patch, ensureSafeJSON} from './client-handler.js';

describe('view-syncer/client-handler', () => {
  test('poke handler', () => {
    const poke1Version = {stateVersion: '121'};
    const poke2Version = {stateVersion: '123'};

    const received: Downstream[][] = [[], [], []];
    // Subscriptions that dump unconsumed pokes to `received`
    const subscriptions = received.map(
      bucket =>
        new Subscription<Downstream>({
          cleanup: msgs => bucket.push(...msgs),
        }),
    );

    const lc = createSilentLogContext();
    const handlers = [
      // Client 1 is already caught up.
      new ClientHandler(lc, 'id1', '121', subscriptions[0]),
      // Client 2 is a bit behind.
      new ClientHandler(lc, 'id2', '120:01', subscriptions[1]),
      // Client 3 is more behind.
      new ClientHandler(lc, 'id3', '11z', subscriptions[2]),
    ];

    let pokers = handlers.map(client => client.startPoke(poke1Version));
    for (const poker of pokers) {
      poker.addPatch({
        toVersion: {stateVersion: '11z', minorVersion: 1},
        patch: {type: 'client', op: 'put', id: 'foo'},
      });
      poker.addPatch({
        toVersion: {stateVersion: '120', minorVersion: 1},
        patch: {type: 'client', op: 'put', id: 'bar'},
      });
      poker.addPatch({
        toVersion: {stateVersion: '121'},
        patch: {type: 'client', op: 'put', id: 'baz'},
      });

      poker.addPatch({
        toVersion: {stateVersion: '11z', minorVersion: 1},
        patch: {
          type: 'query',
          op: 'put',
          id: 'foohash',
          clientID: 'foo',
          ast: {table: 'issues'},
        },
      });
      poker.addPatch({
        toVersion: {stateVersion: '120'},
        patch: {
          type: 'row',
          op: 'put',
          id: {
            schema: 'zero',
            table: 'clients',
            rowKey: {clientID: 'bar'},
          },
          contents: {clientID: 'bar', lastMutationID: 321n},
        },
      });
      poker.addPatch({
        toVersion: {stateVersion: '120', minorVersion: 2},
        patch: {type: 'query', op: 'del', id: 'barhash', clientID: 'foo'},
      });
      poker.addPatch({
        toVersion: {stateVersion: '121'},
        patch: {
          type: 'query',
          op: 'put',
          id: 'bazhash',
          ast: {table: 'labels'},
        },
      });

      poker.addPatch({
        toVersion: {stateVersion: '120', minorVersion: 2},
        patch: {
          type: 'row',
          op: 'put',
          id: {schema: 'public', table: 'issues', rowKey: {id: 'bar'}},
          contents: {id: 'bar', name: 'hello', num: 123},
        },
      });
      poker.addPatch({
        toVersion: {stateVersion: '120'},
        patch: {
          type: 'row',
          op: 'put',
          id: {
            schema: 'zero',
            table: 'clients',
            rowKey: {clientID: 'foo'},
          },
          contents: {clientID: 'foo', lastMutationID: 123n},
        },
      });
      poker.addPatch({
        toVersion: {stateVersion: '11z', minorVersion: 1},
        patch: {
          type: 'row',
          op: 'del',
          id: {schema: 'public', table: 'issues', rowKey: {id: 'foo'}},
        },
      });
      poker.addPatch({
        toVersion: {stateVersion: '121'},
        patch: {
          type: 'row',
          op: 'merge',
          id: {schema: 'public', table: 'issues', rowKey: {id: 'boo'}},
          contents: {id: 'boo', name: 'world', num: 123456},
        },
      });
      poker.addPatch({
        toVersion: {stateVersion: '121'},
        patch: {
          type: 'row',
          op: 'constrain',
          id: {schema: 'public', table: 'issues', rowKey: {id: 'boo'}},
          columns: ['id', 'name', 'num'],
        },
      });
      poker.addPatch({
        toVersion: {stateVersion: '121'},
        patch: {
          type: 'row',
          op: 'merge',
          id: {
            schema: 'zero',
            table: 'clients',
            rowKey: {clientID: 'foo'},
          },
          contents: {clientID: 'foo', lastMutationID: 124n},
        },
      });

      poker.end();
    }

    // Now send another (empty) poke with everyone at the same baseCookie.
    pokers = handlers.map(client => client.startPoke(poke2Version));
    for (const poker of pokers) {
      poker.end();
    }

    // Cancel the subscriptions to collect the unconsumed messages.
    subscriptions.forEach(sub => sub.cancel());

    // Client 1 was already caught up. Only gets the second poke.
    expect(received[0]).toEqual([
      [
        'pokeStart',
        {pokeID: '123', baseCookie: '121', cookie: '123'},
      ] as PokeStartMessage,
      ['pokeEnd', {pokeID: '123'}] as PokeEndMessage,
    ]);

    // Client 2 is a bit behind.
    expect(received[1]).toEqual([
      [
        'pokeStart',
        {pokeID: '121', baseCookie: '120:01', cookie: '121'},
      ] satisfies PokeStartMessage,
      [
        'pokePart',
        {
          pokeID: '121',
          clientsPatch: [{clientID: 'baz', op: 'put'}],
          lastMutationIDChanges: {foo: 124},
          desiredQueriesPatches: {
            foo: [{op: 'del', hash: 'barhash'}],
          },
          gotQueriesPatch: [
            {op: 'put', hash: 'bazhash', ast: {table: 'labels'}},
          ],
          entitiesPatch: [
            {
              op: 'put',
              entityType: 'issues',
              entityID: {id: 'bar'},
              value: {id: 'bar', name: 'hello', num: 123},
            },
            {
              op: 'update',
              entityType: 'issues',
              entityID: {id: 'boo'},
              merge: {id: 'boo', name: 'world', num: 123456},
            },
            {
              op: 'update',
              entityType: 'issues',
              entityID: {id: 'boo'},
              constrain: ['id', 'name', 'num'],
            },
          ],
        },
      ] satisfies PokePartMessage,
      ['pokeEnd', {pokeID: '121'}] satisfies PokeEndMessage,

      // Second poke
      [
        'pokeStart',
        {pokeID: '123', baseCookie: '121', cookie: '123'},
      ] as PokeStartMessage,
      ['pokeEnd', {pokeID: '123'}] as PokeEndMessage,
    ]);

    // Client 3 is more behind.
    expect(received[2]).toEqual([
      [
        'pokeStart',
        {pokeID: '121', baseCookie: '11z', cookie: '121'},
      ] satisfies PokeStartMessage,
      [
        'pokePart',
        {
          pokeID: '121',
          clientsPatch: [
            {clientID: 'foo', op: 'put'},
            {clientID: 'bar', op: 'put'},
            {clientID: 'baz', op: 'put'},
          ],
          lastMutationIDChanges: {
            bar: 321,
            foo: 124,
          },
          desiredQueriesPatches: {
            foo: [
              {op: 'put', hash: 'foohash', ast: {table: 'issues'}},
              {op: 'del', hash: 'barhash'},
            ],
          },
          gotQueriesPatch: [
            {op: 'put', hash: 'bazhash', ast: {table: 'labels'}},
          ],
          entitiesPatch: [
            {
              op: 'put',
              entityType: 'issues',
              entityID: {id: 'bar'},
              value: {id: 'bar', name: 'hello', num: 123},
            },
            {op: 'del', entityType: 'issues', entityID: {id: 'foo'}},
            {
              op: 'update',
              entityType: 'issues',
              entityID: {id: 'boo'},
              merge: {id: 'boo', name: 'world', num: 123456},
            },
            {
              op: 'update',
              entityType: 'issues',
              entityID: {id: 'boo'},
              constrain: ['id', 'name', 'num'],
            },
          ],
        },
      ] satisfies PokePartMessage,
      ['pokeEnd', {pokeID: '121'}] satisfies PokeEndMessage,

      // Second poke
      [
        'pokeStart',
        {pokeID: '123', baseCookie: '121', cookie: '123'},
      ] as PokeStartMessage,
      ['pokeEnd', {pokeID: '123'}] as PokeEndMessage,
    ]);
  });

  test('error on unsafe integer', () => {
    const handler = new ClientHandler(
      createSilentLogContext(),
      'id1',
      '121',
      new Subscription(),
    );
    const poker = handler.startPoke({stateVersion: '123'});

    for (const patch of [
      {
        type: 'row',
        op: 'merge',
        id: {schema: 'public', table: 'issues', rowKey: {id: 'boo'}},
        contents: {id: 'boo', name: 'world', big: 12345231234123414n},
      },
      {
        type: 'row',
        op: 'put',
        id: {schema: 'public', table: 'issues', rowKey: {id: 'boo'}},
        contents: {id: 'boo', name: 'world', big: 983712341234123412348n},
      },
      {
        type: 'row',
        op: 'put',
        id: {schema: 'zero', table: 'clients', rowKey: {clientID: 'boo'}},
        contents: {clientID: 'boo', lastMutationID: 98371234123423412341238n},
      },
    ] satisfies Patch[]) {
      let err;
      try {
        poker.addPatch({toVersion: {stateVersion: '123'}, patch});
      } catch (e) {
        err = e;
      }
      expect(err).not.toBeUndefined();
    }
  });

  test('ensureSafeJSON', () => {
    for (const {input, expected} of [
      {
        input: {foo: 1, bar: 2n},
        expected: {foo: 1, bar: 2},
      },
      {
        input: {foo: '1', bar: 234n},
        expected: {foo: '1', bar: 234},
      },
      {
        input: {foo: 123n, bar: {baz: 23423423}},
        expected: {foo: 123, bar: {baz: 23423423}},
      },
      {
        input: {foo: '1', bar: 23423423434923874239487n},
      },
      {
        input: {foo: '1', bar: {baz: 23423423434923874239487n}},
      },
    ] satisfies {input: JSONObject; expected?: JSONObject}[]) {
      let result;
      try {
        result = ensureSafeJSON(input);
      } catch (e) {
        // expected === undefined
      }
      expect(result).toEqual(expected);
    }
  });
});
