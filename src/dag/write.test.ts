import {expect} from '@esm-bundle/chai';
import {MemStore} from '../kv/mod';
import {defaultChunkHasher, createChunkWithHash} from './chunk';
import {chunkDataKey, chunkMetaKey, chunkRefCountKey, headKey} from './key';
import {Write} from './write';
import type * as kv from '../kv/mod';
import {Read} from './read';
import {
  assertNotTempHash,
  fakeHash,
  Hash,
  hashOf,
  initHasher,
  isTempHash,
  newTempHash,
} from '../hash';
import type {Value} from '../kv/store';
import {Store} from './store';
import {assert} from '../asserts';
import {TestStore} from './test-store';

setup(async () => {
  await initHasher();
});

test('put chunk', async () => {
  const t = async (data: Value, refs: Hash[]) => {
    const kv = new MemStore();
    await kv.withWrite(async kvw => {
      const w = new Write(kvw, defaultChunkHasher, assertNotTempHash);
      const c = w.createChunk(data, refs);
      await w.putChunk(c);

      const kd = chunkDataKey(c.hash);
      const km = chunkMetaKey(c.hash);

      // The chunk data should always be there.
      expect(await kvw.get(kd)).to.deep.equal(c.data);

      // The chunk meta should only be there if there were refs.
      if (refs.length === 0) {
        expect(await kvw.has(km)).to.be.false;
      } else {
        expect(await kvw.get(km)).to.deep.equal(c.meta);
      }
    });
  };

  await t(0, []);
  await t(42, []);
  await t(true, []);
  await t(false, []);
  await t('', []);
  await t('hello', []);
  await t([], []);
  await t([1], []);
  await t({}, []);
  await t({a: 42}, []);
});

async function assertRefCount(kvr: kv.Read, hash: Hash, count: number) {
  const value = await kvr.get(chunkRefCountKey(hash));
  if (count === 0) {
    expect(value).to.be.undefined;
  } else {
    if (value === undefined) {
      throw new Error('value is undefined');
    }
    expect(value).to.equal(count);
  }
}

test('set head', async () => {
  const t = async (kv: kv.Store, name: string, hash: Hash | undefined) => {
    await kv.withWrite(async kvw => {
      const w = new Write(kvw, defaultChunkHasher, assertNotTempHash);
      await (hash === undefined ? w.removeHead(name) : w.setHead(name, hash));
      if (hash !== undefined) {
        const h = await kvw.get(headKey(name));
        expect(h).to.equal(hash);
      } else {
        expect(await kvw.get(headKey(name))).to.be.undefined;
      }
      await w.commit();
    });
  };

  const kv = new MemStore();

  const h0 = hashOf('');
  await t(kv, '', h0);
  await kv.withRead(async kvr => {
    await assertRefCount(kvr, h0, 1);
  });

  const h1 = hashOf('h1');
  await t(kv, '', h1);
  await kv.withRead(async kvr => {
    await assertRefCount(kvr, h1, 1);
    await assertRefCount(kvr, h0, 0);
  });

  await t(kv, 'n1', h0);
  await kv.withRead(async kvr => {
    await assertRefCount(kvr, h0, 1);
  });

  await t(kv, 'n1', h1);
  await kv.withRead(async kvr => {
    await assertRefCount(kvr, h1, 2);
    await assertRefCount(kvr, h0, 0);
  });

  await t(kv, 'n1', h1);
  await kv.withRead(async kvr => {
    await assertRefCount(kvr, h1, 2);
    await assertRefCount(kvr, h0, 0);
  });

  await t(kv, 'n1', undefined);
  await kv.withRead(async kvr => {
    await assertRefCount(kvr, h1, 1);
    await assertRefCount(kvr, h0, 0);
  });

  await t(kv, '', undefined);
  await kv.withRead(async kvr => {
    await assertRefCount(kvr, h1, 0);
    await assertRefCount(kvr, h0, 0);
  });
});

test('ref count invalid', async () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const t = async (v: any, expectError?: string) => {
    const kv = new MemStore();
    const h = hashOf('fakehash1');
    await kv.withWrite(async kvw => {
      await kvw.put(chunkRefCountKey(h), v);
      await kvw.commit();
    });
    await kv.withWrite(async kvw => {
      const w = new Write(kvw, defaultChunkHasher, assertNotTempHash);
      let err;
      try {
        await w.setHead('fakehead', h);
        await w.commit();
      } catch (e) {
        err = e;
      }
      if (expectError) {
        expect(err)
          .to.be.instanceof(Error)
          .with.property('message', expectError);
      } else {
        expect(err, 'No error expected').to.be.undefined;
      }
    });
  };

  await t(0);
  await t(1);
  await t(42);
  await t(0xffff);
  await t(-1, 'Invalid ref count -1. We expect the value to be a Uint16');
  await t(-1, 'Invalid ref count -1. We expect the value to be a Uint16');
  await t(1.5, 'Invalid ref count 1.5. We expect the value to be a Uint16');
  await t(NaN, 'Invalid ref count NaN. We expect the value to be a Uint16');
  await t(
    Infinity,
    'Invalid ref count Infinity. We expect the value to be a Uint16',
  );
  await t(
    -Infinity,
    'Invalid ref count -Infinity. We expect the value to be a Uint16',
  );
  await t(
    2 ** 16,
    'Invalid ref count 65536. We expect the value to be a Uint16',
  );
});

test('commit rollback', async () => {
  const t = async (commit: boolean, setHead: boolean) => {
    let key: string;
    const kv = new MemStore();
    await kv.withWrite(async kvw => {
      const w = new Write(kvw, defaultChunkHasher, assertNotTempHash);
      const c = w.createChunk([0, 1], []);
      await w.putChunk(c);

      key = chunkDataKey(c.hash);

      // The changes should be present inside the tx.
      expect(await kvw.has(key)).to.be.true;

      if (commit) {
        if (setHead) {
          await w.setHead('test', c.hash);
        }
        await w.commit();
      } else {
        // implicit rollback
      }
    });

    // The data should only persist if we set the head and commit.
    await kv.withRead(async kvr => {
      expect(setHead).to.be.equal(await kvr.has(key));
    });
  };
  await t(true, false);
  await t(false, false);
  await t(true, true);
});

test('roundtrip', async () => {
  const t = async (name: string, data: Value, refs: Hash[]) => {
    const kv = new MemStore();
    const hash = defaultChunkHasher(data);
    const c = createChunkWithHash(hash, data, refs);
    await kv.withWrite(async kvw => {
      const w = new Write(kvw, defaultChunkHasher, assertNotTempHash);
      await w.putChunk(c);
      await w.setHead(name, c.hash);

      // Read the changes inside the tx.
      const c2 = await w.getChunk(c.hash);
      const h = await w.getHead(name);
      expect(c2).to.deep.equal(c);
      expect(c.hash).to.equal(h);
      await w.commit();
    });

    // Read the changes outside the tx.
    await kv.withRead(async kvr => {
      const r = new Read(kvr, assertNotTempHash);
      const c2 = await r.getChunk(c.hash);
      const h = await r.getHead(name);
      expect(c2).to.deep.equal(c);
      expect(c.hash).to.equal(h);
    });
  };

  await t('', 0, []);
  await t('n1', 1, [hashOf('r1')]);
  await t('n2', 42, [hashOf('r1'), hashOf('r2')]);

  await t('', true, []);
  await t('', false, []);
  await t('', [], []);
  await t('', {}, []);
  await t('', null, []);
  await t('', [0], []);
  await t('', {a: true}, []);
});

test('that we check if the hash is good when committing', async () => {
  const t = async (
    chunkHasher: (v: Value) => Hash,
    assertValidHash: (h: Hash) => void,
  ) => {
    const store = new Store(new MemStore(), chunkHasher, assertValidHash);

    const data = [true, 42];

    await store.withWrite(async dagWrite => {
      const c = dagWrite.createChunk(data, []);
      await dagWrite.putChunk(c);
      await dagWrite.setHead('test', c.hash);
      await dagWrite.commit();
    });

    await store.withRead(async dagRead => {
      const h = await dagRead.getHead('test');
      assert(h);
      const c = await dagRead.getChunk(h);
      assert(c);
      expect(c.hash).to.equal(h);
      expect(c.data).to.deep.equal(data);
    });
  };

  {
    let counter = 0;
    const prefix = 'testhash';
    const hasher = () =>
      (counter++).toString().padStart(32, 'testhash') as unknown as Hash;
    const testHash = (hash: Hash) => {
      assert(hash.toString().startsWith(prefix));
    };

    await t(hasher, testHash);
    await t(defaultChunkHasher, assertNotTempHash);
    await t(newTempHash, (h: Hash) => {
      assert(isTempHash(h));
    });

    let err;
    try {
      await t(newTempHash, assertNotTempHash);
    } catch (e) {
      err = e;
    }
    expect(err)
      .to.be.instanceof(Error)
      .with.property('message', 'Unexpected temp hash');
  }
});

test('that changeRefCount does not write stale value with a dimamond pattern', async () => {
  const dagStore = new TestStore();

  // If we have a diamond structure we update the refcount for C twice.
  //
  //   R
  //  / \
  //  A  B
  //  \ /
  //   C

  const c = await dagStore.withWrite(async dagWrite => {
    const c = createChunkWithHash(fakeHash('c'), 'c', []);
    const a = createChunkWithHash(fakeHash('a'), 'a', [c.hash]);
    const b = createChunkWithHash(fakeHash('b'), 'b', [c.hash]);
    const r = createChunkWithHash(fakeHash('r'), 'r', [a.hash, b.hash]);
    await Promise.all([
      dagWrite.setHead('test', r.hash),
      dagWrite.putChunk(a),
      dagWrite.putChunk(b),
      dagWrite.putChunk(c),
      dagWrite.putChunk(r),
    ]);
    await dagWrite.commit();

    return c;
  });

  await dagStore.kvStore.withRead(async kvRead => {
    expect(await kvRead.get(chunkRefCountKey(c.hash))).to.equal(2);
  });

  await dagStore.withWrite(async dagWrite => {
    const e = createChunkWithHash(fakeHash('e'), 'e', []);
    await Promise.all([dagWrite.setHead('test', e.hash), dagWrite.putChunk(e)]);
    await dagWrite.commit();
  });

  await dagStore.kvStore.withRead(async kvRead => {
    expect(await kvRead.has(chunkRefCountKey(c.hash))).to.equal(false);
  });
});

test('that changeRefCount does not write stale value with a diamond pattern and a child', async () => {
  const dagStore = new TestStore();

  // If we have a diamond structure we update the refcount for C twice.
  //
  //   R
  //  / \
  //  A  B
  //  \ /
  //   C
  //   |
  //   D

  const [a, d] = await dagStore.withWrite(async dagWrite => {
    const d = createChunkWithHash(fakeHash('d'), 'd', []);
    const c = createChunkWithHash(fakeHash('c'), 'c', [d.hash]);
    const a = createChunkWithHash(fakeHash('a'), 'a', [c.hash]);
    const b = createChunkWithHash(fakeHash('b'), 'b', [c.hash]);
    const r = createChunkWithHash(fakeHash('r'), 'r', [a.hash, b.hash]);
    await Promise.all([
      dagWrite.setHead('test', r.hash),
      dagWrite.putChunk(a),
      dagWrite.putChunk(b),
      dagWrite.putChunk(c),
      dagWrite.putChunk(r),
    ]);
    await dagWrite.commit();

    return [a, d];
  });

  await dagStore.kvStore.withRead(async kvRead => {
    expect(await kvRead.get(chunkRefCountKey(d.hash))).to.equal(1);
  });

  //  A
  //  \
  //   C
  //   |
  //   D
  await dagStore.withWrite(async dagWrite => {
    await dagWrite.setHead('test', a.hash);
    await dagWrite.commit();
  });

  await dagStore.kvStore.withRead(async kvRead => {
    expect(await kvRead.get(chunkRefCountKey(a.hash))).to.equal(1);
    expect(await kvRead.get(chunkRefCountKey(d.hash))).to.equal(1);
  });
});

test('that we changeRefCount does not write stale value with a 3 incoming refs', async () => {
  const dagStore = new TestStore();

  // If we have a diamond structure we update the refcount for D three times.
  //
  //    R
  //  / | \
  //  A B C
  //  \ | /
  //    D

  const d = await dagStore.withWrite(async dagWrite => {
    const d = createChunkWithHash(fakeHash('d'), 'd', []);
    const a = createChunkWithHash(fakeHash('a'), 'a', [d.hash]);
    const b = createChunkWithHash(fakeHash('b'), 'b', [d.hash]);
    const c = createChunkWithHash(fakeHash('c'), 'c', [d.hash]);
    const r = createChunkWithHash(fakeHash('r'), 'r', [a.hash, b.hash, c.hash]);
    await Promise.all([
      dagWrite.setHead('test', r.hash),
      dagWrite.putChunk(a),
      dagWrite.putChunk(b),
      dagWrite.putChunk(c),
      dagWrite.putChunk(d),
      dagWrite.putChunk(r),
    ]);
    await dagWrite.commit();

    return d;
  });

  await dagStore.kvStore.withRead(async kvRead => {
    expect(await kvRead.get(chunkRefCountKey(d.hash))).to.equal(3);
  });

  await dagStore.withWrite(async dagWrite => {
    const e = createChunkWithHash(fakeHash('e'), 'e', []);
    await Promise.all([dagWrite.setHead('test', e.hash), dagWrite.putChunk(e)]);
    await dagWrite.commit();
  });

  await dagStore.kvStore.withRead(async kvRead => {
    expect(await kvRead.has(chunkRefCountKey(d.hash))).to.equal(false);
  });
});

test('that we changeRefCount does not write stale value with a 3 incoming refs bypassing one level', async () => {
  const dagStore = new TestStore();

  // If we have a diamond structure we update the refcount for D three times.
  //
  //    R
  //  / | \
  //  A B  |
  //  \ | /
  //    D

  const d = await dagStore.withWrite(async dagWrite => {
    const d = createChunkWithHash(fakeHash('d'), 'd', []);
    const a = createChunkWithHash(fakeHash('a'), 'a', [d.hash]);
    const b = createChunkWithHash(fakeHash('b'), 'b', [d.hash]);
    const r = createChunkWithHash(fakeHash('r'), 'r', [a.hash, b.hash, d.hash]);
    await Promise.all([
      dagWrite.setHead('test', r.hash),
      dagWrite.putChunk(a),
      dagWrite.putChunk(b),
      dagWrite.putChunk(d),
      dagWrite.putChunk(r),
    ]);
    await dagWrite.commit();

    return d;
  });

  await dagStore.kvStore.withRead(async kvRead => {
    expect(await kvRead.get(chunkRefCountKey(d.hash))).to.equal(3);
  });

  await dagStore.withWrite(async dagWrite => {
    const e = createChunkWithHash(fakeHash('e'), 'e', []);
    await Promise.all([dagWrite.setHead('test', e.hash), dagWrite.putChunk(e)]);
    await dagWrite.commit();
  });

  await dagStore.kvStore.withRead(async kvRead => {
    expect(await kvRead.has(chunkRefCountKey(d.hash))).to.equal(false);
  });
});
