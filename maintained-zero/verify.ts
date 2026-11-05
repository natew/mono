import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';

const base = process.argv[2];
const load = (path: string) =>
  import(pathToFileURL(`${base}/out/${path}.js`).href);
const {ReplicacheImpl} = await load('replicache/src/replicache-impl');
const {getClient, setClient} = await load('replicache/src/persist/clients');
const {getClientGroup} = await load('replicache/src/persist/client-groups');
const {withRead, withWrite} = await load('replicache/src/with-transactions');
const {MemStore, dropMemStore} = await load('replicache/src/kv/mem-store');
const {IDBDatabasesStore} = await load(
  'replicache/src/persist/idb-databases-store',
);
const {initCollectIDBDatabases, dropAllDatabases} = await load(
  'replicache/src/persist/collect-idb-databases',
);
const {createLogContext} = await load('replicache/src/log-options');

const handles = new Set();
class TrackedStore extends MemStore {
  closes = 0;
  constructor(name: string) {
    super(name);
    handles.add(this);
  }
  close() {
    this.closes++;
    return super.close();
  }
}
const provider = {
  create: (name: string) => new TrackedStore(name),
  drop: dropMemStore,
};
const implOptions = {
  enableMutationRecovery: false,
  enableScheduledPersist: false,
  enableScheduledRefresh: false,
  enablePullAndPushInOpen: false,
};
const instances = [];
let cookie = 1;
const options = {
  name: 'maintained-zero-close',
  kvStore: provider,
  logLevel: 'error',
  pullInterval: null,
  mutators: {
    addData: async (tx, entries) => {
      for (const [key, value] of Object.entries(entries))
        await tx.set(key, value);
    },
  },
  puller: async () => ({
    response: {
      cookie,
      lastMutationIDChanges: {},
      patch: [
        {
          op: 'put',
          key: 'remote',
          value: cookie === 1 ? 'old snapshot' : 'new snapshot',
        },
      ],
    },
    httpRequestInfo: {httpStatusCode: 200, errorMessage: ''},
  }),
};
function construct(opts = options) {
  const rep = new ReplicacheImpl(opts, implOptions);
  instances.push(rep);
  return rep;
}
try {
  const first = construct();
  await first.query(() => {});
  await first.pull();
  await first.persist();
  const old = await withRead(first.perdag, read =>
    getClient(first.clientID, read),
  );
  assert(old.persistHash);
  const oldSnapshot = old.persistHash;
  const second = construct();
  await second.query(() => {});
  cookie = 2;
  await second.pull();
  await second.persist();
  await first.mutate.addData({pending: 'unsent mutation'});
  await first.persist();
  await second.refresh();
  const groupID = await first.clientGroupID;
  const before = structuredClone(
    await withRead(second.perdag, read => getClientGroup(groupID, read)),
  );
  assert.equal(before.mutationIDs[first.clientID], 1);
  assert.equal(before.lastServerAckdMutationIDs[first.clientID] ?? 0, 0);
  assert.equal(
    await withRead(second.perdag, read => read.hasChunk(oldSnapshot)),
    true,
  );
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const reading = first.query(async tx => {
    started.resolve();
    await release.promise;
    return tx.get('remote');
  });
  await started.promise;
  const closing = first.close();
  release.resolve();
  assert.equal(await reading, 'old snapshot');
  await closing;
  assert.equal(
    await withRead(second.perdag, read => read.hasChunk(oldSnapshot)),
    false,
    'closed client must release old snapshot',
  );
  const closedClient = await withRead(second.perdag, read =>
    getClient(first.clientID, read),
  );
  assert.deepEqual(closedClient.refreshHashes, []);
  assert.equal(closedClient.persistHash, null);
  assert.deepEqual(
    await withRead(second.perdag, read => getClientGroup(groupID, read)),
    before,
  );
  await second.refresh();
  assert.equal(await second.query(tx => tx.get('remote')), 'new snapshot');
  assert.equal(await second.query(tx => tx.get('pending')), 'unsent mutation');
  await second.close();
  const reopened = construct();
  assert.equal(await reopened.query(tx => tx.get('remote')), 'new snapshot');
  assert.equal(
    await reopened.query(tx => tx.get('pending')),
    'unsent mutation',
  );
  console.log(
    'PASS snapshot cleanup, in-flight query, pending mutation, other client and reopen',
  );

  const stale = construct({...options, name: 'maintained-zero-stale'});
  await stale.query(() => {});
  await withWrite(stale.perdag, async write => {
    const client = await getClient(stale.clientID, write);
    await setClient(
      stale.clientID,
      {...client, heartbeatTimestampMs: 0},
      write,
    );
  });
  await stale.close();
  const registry = new IDBDatabasesStore(provider.create);
  const existing = new Set(handles);
  const completed = Promise.withResolvers();
  const controller = new AbortController();
  initCollectIDBDatabases(
    registry,
    provider,
    3600000,
    0,
    1000,
    true,
    () => completed.resolve(),
    createLogContext('error', []),
    controller.signal,
  );
  const timeout = setTimeout(
    () => completed.reject(new Error('collector did not complete')),
    5000,
  );
  try {
    await completed.promise;
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
  const temporary = [...handles].filter(store => !existing.has(store));
  assert(
    temporary.length >= 3,
    'inspection and propagation must open independent stores',
  );
  assert(
    temporary.every(store => store.closed && store.closes === 1),
    'every collector store must close once',
  );
  assert.equal(registry.closed, undefined);
  assert.equal(
    await reopened.query(tx => tx.get('pending')),
    'unsent mutation',
  );
  await registry.getDatabases();
  await registry.close();
  await reopened.close();
  const handlesBeforeDrop = new Set(handles);
  const dropped = await dropAllDatabases({kvStore: provider});
  assert.deepEqual(dropped.errors, []);
  assert(
    [...handles]
      .filter(store => !handlesBeforeDrop.has(store))
      .every(store => store.closed && store.closes === 1),
  );
  assert(
    [...handles].every(store => store.closed && store.closes === 1),
    'no owned handle remains open or double closed',
  );
  console.log(
    'PASS collector inspection, propagation and registry lifetimes; no handle leaks',
  );
} finally {
  await Promise.allSettled(
    instances.filter(rep => !rep.closed).map(rep => rep.close()),
  );
}
