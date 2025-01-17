import type {LogContext} from '@rocicorp/logger';
import {assert} from '../../../shared/src/asserts.js';
import {deepEqual, type ReadonlyJSONValue} from '../../../shared/src/json.js';
import {diff} from '../btree/diff.js';
import {BTreeRead} from '../btree/read.js';
import {compareCookies, type Cookie} from '../cookies.js';
import type {Store} from '../dag/store.js';
import {
  assertSnapshotMetaDD31,
  baseSnapshotFromHash,
  Commit,
  commitChain,
  commitFromHash,
  commitIsLocalDD31,
  DEFAULT_HEAD_NAME,
  type LocalMeta,
  type LocalMetaSDD,
  localMutations as localMutations_1,
  type Meta,
  snapshotMetaParts,
} from '../db/commit.js';
import {
  newWriteSnapshotDD31,
  newWriteSnapshotSDD,
  readIndexesForWrite,
  updateIndexes,
} from '../db/write.js';
import {isErrorResponse} from '../error-responses.js';
import * as FormatVersion from '../format-version-enum.js';
import {deepFreeze, type FrozenJSONValue} from '../frozen-json.js';
import {
  assertPullerResultV0,
  assertPullerResultV1,
} from '../get-default-puller.js';
import {emptyHash, type Hash} from '../hash.js';
import type {HTTPRequestInfo} from '../http-request-info.js';
import type {
  Puller,
  PullerResult,
  PullerResultV0,
  PullerResultV1,
  PullResponseOKV0,
  PullResponseOKV1Internal,
  PullResponseV0,
  PullResponseV1,
} from '../puller.js';
import {ReportError} from '../replicache.js';
import {toError} from '../to-error.js';
import {withRead, withWriteNoImplicitCommit} from '../with-transactions.js';
import {
  addDiffsForIndexes,
  type DiffComputationConfig,
  DiffsMap,
} from './diff.js';
import * as HandlePullResponseResultType from './handle-pull-response-result-type-enum.js';
import type {ClientGroupID, ClientID} from './ids.js';
import * as patch from './patch.js';
import {PullError} from './pull-error.js';
import {SYNC_HEAD_NAME} from './sync-head-name.js';

export const PULL_VERSION_SDD = 0;
export const PULL_VERSION_DD31 = 1;

/**
 * The JSON value used as the body when doing a POST to the [pull
 * endpoint](/reference/server-pull).
 */
export type PullRequest = PullRequestV1 | PullRequestV0;

/**
 * The JSON value used as the body when doing a POST to the [pull
 * endpoint](/reference/server-pull). This is the legacy version (V0) and it is
 * still used when recovering mutations from old clients.
 */
export type PullRequestV0 = {
  pullVersion: 0;
  // schemaVersion can optionally be used by the customer's app
  // to indicate to the data layer what format of Client View the
  // app understands.
  schemaVersion: string;
  profileID: string;
  cookie: ReadonlyJSONValue;

  clientID: ClientID;
  lastMutationID: number;
};

/**
 * The JSON value used as the body when doing a POST to the [pull
 * endpoint](/reference/server-pull).
 */
export type PullRequestV1 = {
  pullVersion: 1;
  // schemaVersion can optionally be used by the customer's app
  // to indicate to the data layer what format of Client View the
  // app understands.
  schemaVersion: string;
  profileID: string;
  cookie: Cookie;

  clientGroupID: ClientGroupID;
};

export function isPullRequestV1(pr: PullRequest): pr is PullRequestV1 {
  return pr.pullVersion === PULL_VERSION_DD31;
}

export type BeginPullResponseV1 = {
  httpRequestInfo: HTTPRequestInfo;
  pullResponse?: PullResponseV1;
  syncHead: Hash;
};

export type BeginPullResponseV0 = {
  httpRequestInfo: HTTPRequestInfo;
  pullResponse?: PullResponseV0;
  syncHead: Hash;
};

export async function beginPullV0(
  profileID: string,
  clientID: ClientID,
  schemaVersion: string,
  puller: Puller,
  requestID: string,
  store: Store,
  formatVersion: FormatVersion.Type,
  lc: LogContext,
  createSyncBranch = true,
): Promise<BeginPullResponseV0> {
  const [lastMutationID, baseCookie] = await withRead(store, async dagRead => {
    const mainHeadHash = await dagRead.getHead(DEFAULT_HEAD_NAME);
    if (!mainHeadHash) {
      throw new Error('Internal no main head found');
    }
    const baseSnapshot = await baseSnapshotFromHash(mainHeadHash, dagRead);
    const baseSnapshotMeta = baseSnapshot.meta;
    const baseCookie = baseSnapshotMeta.cookieJSON;
    const lastMutationID = await baseSnapshot.getMutationID(clientID, dagRead);
    return [lastMutationID, baseCookie];
  });

  const pullReq: PullRequestV0 = {
    profileID,
    clientID,
    cookie: baseCookie,
    lastMutationID,
    pullVersion: PULL_VERSION_SDD,
    schemaVersion,
  };

  const {response, httpRequestInfo} = (await callPuller(
    lc,
    puller,
    pullReq,
    requestID,
  )) as PullerResultV0;

  // If Puller did not get a pull response we still want to return the HTTP
  // request info to the JS SDK.
  if (!response) {
    return {
      httpRequestInfo,
      syncHead: emptyHash,
    };
  }

  if (!createSyncBranch || isErrorResponse(response)) {
    return {
      httpRequestInfo,
      pullResponse: response,
      syncHead: emptyHash,
    };
  }

  const result = await handlePullResponseV0(
    lc,
    store,
    baseCookie,
    response,
    clientID,
    formatVersion,
  );
  if (result.type === HandlePullResponseResultType.CookieMismatch) {
    throw new Error('Overlapping sync');
  }
  return {
    httpRequestInfo,
    pullResponse: response,
    syncHead:
      result.type === HandlePullResponseResultType.Applied
        ? result.syncHead
        : emptyHash,
  };
}

export async function beginPullV1(
  profileID: string,
  clientID: ClientID,
  clientGroupID: ClientGroupID,
  schemaVersion: string,
  puller: Puller,
  requestID: string,
  store: Store,
  formatVersion: FormatVersion.Type,
  lc: LogContext,
  createSyncBranch = true,
): Promise<BeginPullResponseV1> {
  const baseCookie = await withRead(store, async dagRead => {
    const mainHeadHash = await dagRead.getHead(DEFAULT_HEAD_NAME);
    if (!mainHeadHash) {
      throw new Error('Internal no main head found');
    }
    const baseSnapshot = await baseSnapshotFromHash(mainHeadHash, dagRead);
    const baseSnapshotMeta = baseSnapshot.meta;
    assertSnapshotMetaDD31(baseSnapshotMeta);
    return baseSnapshotMeta.cookieJSON;
  });

  const pullReq: PullRequestV1 = {
    profileID,
    clientGroupID,
    cookie: baseCookie,
    pullVersion: PULL_VERSION_DD31,
    schemaVersion,
  };

  const {response, httpRequestInfo} = (await callPuller(
    lc,
    puller,
    pullReq,
    requestID,
  )) as PullerResultV1;

  // If Puller did not get a pull response we still want to return the HTTP
  // request info.
  if (!response) {
    return {
      httpRequestInfo,
      syncHead: emptyHash,
    };
  }

  if (!createSyncBranch || isErrorResponse(response)) {
    return {
      httpRequestInfo,
      pullResponse: response,
      syncHead: emptyHash,
    };
  }

  const result = await handlePullResponseV1(
    lc,
    store,
    baseCookie,
    response,
    clientID,
    formatVersion,
  );

  return {
    httpRequestInfo,
    pullResponse: response,
    syncHead:
      result.type === HandlePullResponseResultType.Applied
        ? result.syncHead
        : emptyHash,
  };
}

async function callPuller(
  lc: LogContext,
  puller: Puller,
  pullReq: PullRequest,
  requestID: string,
): Promise<PullerResult> {
  lc.debug?.('Starting pull...');
  const pullStart = Date.now();
  let pullerResult: PullerResult;
  try {
    pullerResult = await puller(pullReq, requestID);
    lc.debug?.(
      `...Pull ${pullerResult.response ? 'complete' : 'failed'} in `,
      Date.now() - pullStart,
      'ms',
    );
  } catch (e) {
    throw new PullError(toError(e));
  }
  try {
    if (isPullRequestV1(pullReq)) {
      assertPullerResultV1(pullerResult);
    } else {
      assertPullerResultV0(pullerResult);
    }
    return pullerResult;
  } catch (e) {
    throw new ReportError('Invalid puller result', toError(e));
  }
}

// Returns new sync head, or null if response did not apply due to mismatched cookie.
export function handlePullResponseV0(
  lc: LogContext,
  store: Store,
  expectedBaseCookie: ReadonlyJSONValue,
  response: PullResponseOKV0,
  clientID: ClientID,
  formatVersion: FormatVersion.Type,
): Promise<HandlePullResponseResult> {
  // It is possible that another sync completed while we were pulling. Ensure
  // that is not the case by re-checking the base snapshot.
  return withWriteNoImplicitCommit(store, async dagWrite => {
    assert(formatVersion <= FormatVersion.SDD);
    const dagRead = dagWrite;
    const mainHead = await dagRead.getHead(DEFAULT_HEAD_NAME);

    if (mainHead === undefined) {
      throw new Error('Main head disappeared');
    }
    const baseSnapshot = await baseSnapshotFromHash(mainHead, dagRead);
    const [baseLastMutationID, baseCookie] = snapshotMetaParts(
      baseSnapshot,
      clientID,
    );

    // TODO(MP) Here we are using whether the cookie has changes as a proxy for whether
    // the base snapshot changed, which is the check we used to do. I don't think this
    // is quite right. We need to firm up under what conditions we will/not accept an
    // update from the server: https://github.com/rocicorp/replicache/issues/713.
    if (!deepEqual(expectedBaseCookie, baseCookie)) {
      return {
        type: HandlePullResponseResultType.CookieMismatch,
      };
    }

    // If other entities (eg, other clients) are modifying the client view
    // the client view can change but the lastMutationID stays the same.
    // So be careful here to reject only a lesser lastMutationID.
    if (response.lastMutationID < baseLastMutationID) {
      throw new Error(
        badOrderMessage(
          `lastMutationID`,
          String(response.lastMutationID),
          String(baseLastMutationID),
        ),
      );
    }

    const frozenCookie = deepFreeze(response.cookie ?? null);

    // If the cookie didn't change, it's a nop.
    // Otherwise, we will write a new commit, including for the case of just
    // a cookie change.
    if (deepEqual(frozenCookie, baseCookie)) {
      if (response.patch.length > 0) {
        lc.error?.(
          `handlePullResponse: cookie ${JSON.stringify(
            baseCookie,
          )} did not change, but patch is not empty`,
        );
      }
      if (response.lastMutationID !== baseLastMutationID) {
        lc.error?.(
          `handlePullResponse: cookie ${JSON.stringify(
            baseCookie,
          )} did not change, but lastMutationID did change`,
        );
      }
      return {
        type: HandlePullResponseResultType.NoOp,
      };
    }

    // We are going to need to adjust the indexes. Imagine we have just pulled:
    //
    // S1 - M1 - main
    //    \ S2 - sync
    //
    // Let's say S2 says that it contains up to M1. Are we safe at this moment
    // to set main to S2?
    //
    // No, because the Replicache protocol does not require a snapshot
    // containing M1 to have the same data as the client computed for M1!
    //
    // We must diff the main map in M1 against the main map in S2 and see if it
    // contains any changes. Whatever changes it contains must be applied to
    // all indexes.
    //
    // We start with the index definitions in the last commit that was
    // integrated into the new snapshot.
    const chain = await commitChain(mainHead, dagRead);
    let lastIntegrated: Commit<Meta> | undefined;
    for (const commit of chain) {
      if (
        (await commit.getMutationID(clientID, dagRead)) <=
        response.lastMutationID
      ) {
        lastIntegrated = commit;
        break;
      }
    }

    if (!lastIntegrated) {
      throw new Error('Internal invalid chain');
    }

    const dbWrite = await newWriteSnapshotSDD(
      baseSnapshot.chunk.hash,
      response.lastMutationID,
      frozenCookie,
      dagWrite,
      readIndexesForWrite(lastIntegrated, dagWrite, formatVersion),
      clientID,
      formatVersion,
    );

    await patch.apply(lc, dbWrite, response.patch);

    const lastIntegratedMap = new BTreeRead(
      dagRead,
      formatVersion,
      lastIntegrated.valueHash,
    );

    for await (const change of dbWrite.map.diff(lastIntegratedMap)) {
      await updateIndexes(
        lc,
        dbWrite.indexes,
        change.key,
        () =>
          Promise.resolve((change as {oldValue?: FrozenJSONValue}).oldValue),
        (change as {newValue?: FrozenJSONValue}).newValue,
      );
    }

    return {
      type: HandlePullResponseResultType.Applied,
      syncHead: await dbWrite.commit(SYNC_HEAD_NAME),
    };
  });
}

type HandlePullResponseResult =
  | {
      type: HandlePullResponseResultType.Applied;
      syncHead: Hash;
    }
  | {
      type:
        | HandlePullResponseResultType.NoOp
        | HandlePullResponseResultType.CookieMismatch;
    };

function badOrderMessage(
  name: string,
  receivedValue: string,
  lastSnapshotValue: string,
) {
  return `Received ${name} ${receivedValue} is < than last snapshot ${name} ${lastSnapshotValue}; ignoring client view`;
}

export function handlePullResponseV1(
  lc: LogContext,
  store: Store,
  expectedBaseCookie: FrozenJSONValue,
  response: PullResponseOKV1Internal,
  clientID: ClientID,
  formatVersion: FormatVersion.Type,
): Promise<HandlePullResponseResult> {
  // It is possible that another sync completed while we were pulling. Ensure
  // that is not the case by re-checking the base snapshot.
  return withWriteNoImplicitCommit(store, async dagWrite => {
    const dagRead = dagWrite;
    const mainHead = await dagRead.getHead(DEFAULT_HEAD_NAME);
    if (mainHead === undefined) {
      throw new Error('Main head disappeared');
    }
    const baseSnapshot = await baseSnapshotFromHash(mainHead, dagRead);
    const baseSnapshotMeta = baseSnapshot.meta;
    assertSnapshotMetaDD31(baseSnapshotMeta);
    const baseCookie = baseSnapshotMeta.cookieJSON;

    // TODO(MP) Here we are using whether the cookie has changed as a proxy for whether
    // the base snapshot changed, which is the check we used to do. I don't think this
    // is quite right. We need to firm up under what conditions we will/not accept an
    // update from the server: https://github.com/rocicorp/replicache/issues/713.
    // In DD31 this is expected to happen if a refresh occurs during a pull.
    if (!deepEqual(expectedBaseCookie, baseCookie)) {
      lc.debug?.(
        'handlePullResponse: cookie mismatch, response is not applicable',
      );
      return {
        type: HandlePullResponseResultType.CookieMismatch,
      };
    }

    // Check that the lastMutationIDs are not going backwards.
    for (const [clientID, lmidChange] of Object.entries(
      response.lastMutationIDChanges,
    )) {
      const lastMutationID = baseSnapshotMeta.lastMutationIDs[clientID];
      if (lastMutationID !== undefined && lmidChange < lastMutationID) {
        throw new Error(
          badOrderMessage(
            `${clientID} lastMutationID`,
            String(lmidChange),
            String(lastMutationID),
          ),
        );
      }
    }

    const frozenResponseCookie = deepFreeze(response.cookie);
    if (compareCookies(frozenResponseCookie, baseCookie) < 0) {
      throw new Error(
        badOrderMessage(
          'cookie',
          JSON.stringify(frozenResponseCookie),
          JSON.stringify(baseCookie),
        ),
      );
    }

    if (deepEqual(frozenResponseCookie, baseCookie)) {
      if (response.patch.length > 0) {
        lc.error?.(
          `handlePullResponse: cookie ${JSON.stringify(
            baseCookie,
          )} did not change, but patch is not empty`,
        );
      }
      if (Object.keys(response.lastMutationIDChanges).length > 0) {
        console.log(response.lastMutationIDChanges);
        lc.error?.(
          `handlePullResponse: cookie ${JSON.stringify(
            baseCookie,
          )} did not change, but lastMutationIDChanges is not empty`,
        );
      }
      // If the cookie doesn't change, it's a nop.
      return {
        type: HandlePullResponseResultType.NoOp,
      };
    }

    const dbWrite = await newWriteSnapshotDD31(
      baseSnapshot.chunk.hash,
      {...baseSnapshotMeta.lastMutationIDs, ...response.lastMutationIDChanges},
      frozenResponseCookie,
      dagWrite,
      clientID,
      formatVersion,
    );

    await patch.apply(lc, dbWrite, response.patch);

    return {
      type: HandlePullResponseResultType.Applied,
      syncHead: await dbWrite.commit(SYNC_HEAD_NAME),
    };
  });
}

type MaybeEndPullResultBase<M extends Meta> = {
  replayMutations?: Commit<M>[];
  syncHead: Hash;
  diffs: DiffsMap;
};

export type MaybeEndPullResultV0 = MaybeEndPullResultBase<LocalMetaSDD>;

export function maybeEndPull<M extends LocalMeta>(
  store: Store,
  lc: LogContext,
  expectedSyncHead: Hash,
  clientID: ClientID,
  diffConfig: DiffComputationConfig,
  formatVersion: FormatVersion.Type,
): Promise<{
  syncHead: Hash;
  replayMutations: Commit<M>[];
  diffs: DiffsMap;
}> {
  return withWriteNoImplicitCommit(store, async dagWrite => {
    const dagRead = dagWrite;
    // Ensure sync head is what the caller thinks it is.
    const syncHeadHash = await dagRead.getHead(SYNC_HEAD_NAME);
    if (syncHeadHash === undefined) {
      throw new Error('Missing sync head');
    }
    if (syncHeadHash !== expectedSyncHead) {
      lc.error?.(
        'maybeEndPull, Wrong sync head. Expecting:',
        expectedSyncHead,
        'got:',
        syncHeadHash,
      );
      throw new Error('Wrong sync head');
    }

    // Ensure another sync has not landed a new snapshot on the main chain.
    // TODO: In DD31, it is expected that a newer snapshot might have appeared
    // on the main chain. In that case, we just abort this pull.
    const syncSnapshot = await baseSnapshotFromHash(syncHeadHash, dagRead);
    const mainHeadHash = await dagRead.getHead(DEFAULT_HEAD_NAME);
    if (mainHeadHash === undefined) {
      throw new Error('Missing main head');
    }
    const mainSnapshot = await baseSnapshotFromHash(mainHeadHash, dagRead);

    const {meta} = syncSnapshot;
    const syncSnapshotBasis = meta.basisHash;
    if (syncSnapshot === null) {
      throw new Error('Sync snapshot with no basis');
    }
    if (syncSnapshotBasis !== mainSnapshot.chunk.hash) {
      throw new Error('Overlapping syncs');
    }

    // Collect pending commits from the main chain and determine which
    // of them if any need to be replayed.
    const syncHead = await commitFromHash(syncHeadHash, dagRead);
    const pending: Commit<M>[] = [];
    const localMutations = await localMutations_1(mainHeadHash, dagRead);
    for (const commit of localMutations) {
      let cid = clientID;
      if (commitIsLocalDD31(commit)) {
        cid = commit.meta.clientID;
      }
      if (
        (await commit.getMutationID(cid, dagRead)) >
        (await syncHead.getMutationID(cid, dagRead))
      ) {
        // We know that the dag can only contain either LocalMetaSDD or LocalMetaDD31
        pending.push(commit as Commit<M>);
      }
    }
    // pending() gave us the pending mutations in sync-head-first order whereas
    // caller wants them in the order to replay (lower mutation ids first).
    pending.reverse();

    // We return the keys that changed due to this pull. This is used by
    // subscriptions in the JS API when there are no more pending mutations.
    const diffsMap = new DiffsMap();

    // Return replay commits if any.
    if (pending.length > 0) {
      return {
        syncHead: syncHeadHash,
        replayMutations: pending,
        // The changed keys are not reported when further replays are
        // needed. The diffs will be reported at the end when there
        // are no more mutations to be replay and then it will be reported
        // relative to DEFAULT_HEAD_NAME.
        diffs: diffsMap,
      };
    }

    // TODO check invariants

    // Compute diffs (changed keys) for value map and index maps.
    const mainHead = await commitFromHash(mainHeadHash, dagRead);
    if (diffConfig.shouldComputeDiffs()) {
      const mainHeadMap = new BTreeRead(
        dagRead,
        formatVersion,
        mainHead.valueHash,
      );
      const syncHeadMap = new BTreeRead(
        dagRead,
        formatVersion,
        syncHead.valueHash,
      );
      const valueDiff = await diff(mainHeadMap, syncHeadMap);
      diffsMap.set('', valueDiff);
      await addDiffsForIndexes(
        mainHead,
        syncHead,
        dagRead,
        diffsMap,
        diffConfig,
        formatVersion,
      );
    }

    // No mutations to replay so set the main head to the sync head and sync complete!
    await Promise.all([
      dagWrite.setHead(DEFAULT_HEAD_NAME, syncHeadHash),
      dagWrite.removeHead(SYNC_HEAD_NAME),
    ]);
    await dagWrite.commit();

    if (lc.debug) {
      const [oldLastMutationID, oldCookie] = snapshotMetaParts(
        mainSnapshot,
        clientID,
      );
      const [newLastMutationID, newCookie] = snapshotMetaParts(
        syncSnapshot,
        clientID,
      );
      lc.debug(
        `Successfully pulled new snapshot with lastMutationID:`,
        newLastMutationID,
        `(prev:`,
        oldLastMutationID,
        `), cookie: `,
        newCookie,
        `(prev:`,
        oldCookie,
        `), sync head hash:`,
        syncHeadHash,
        ', main head hash:',
        mainHeadHash,
        `, valueHash:`,
        syncHead.valueHash,
        `(prev:`,
        mainSnapshot.valueHash,
      );
    }

    return {
      syncHead: syncHeadHash,
      replayMutations: [],
      diffs: diffsMap,
    };
  });
}
