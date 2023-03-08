import type {WriteTransaction} from '@rocicorp/reflect';
import {COLOR_PALATE, ROOM_MAX_ACTORS} from './constants';
import {Env, OrchestratorActor} from './types';

const ROOM_ID_KEY = 'current-room-id';
const ROOM_COUNT_KEY = 'current-room-count';
const COLOR_INDEX_KEY = 'color-index';

let env = Env.CLIENT;
export const setEnv = (e: Env) => {
  env = e;
};

export const orchestratorMutators = {
  removeOchestratorActor: async (tx: WriteTransaction, actorId: string) => {
    const key = `actor/${actorId}`;
    const actor = (await tx.get(key)) as OrchestratorActor;
    // Dunno who that is
    if (!actor) {
      return;
    }
    // Delete the actor
    await tx.del(key);
    const currentRoom = (await tx.get(ROOM_ID_KEY)) as string;
    if (!currentRoom || actor.room !== currentRoom) {
      // The room that the actor was in doesn't exist, no need to do any more.
      return;
    }
    // Decrement the room count, so that as long as we don't hit the ceiling, we'll
    // always use the same room.
    const roomCount = (await tx.get(ROOM_COUNT_KEY)) as number;
    if (!roomCount || roomCount < 0) {
      throw new Error("Can't remove an actor from an empty room...");
    }
    await tx.put(ROOM_COUNT_KEY, roomCount - 1);
  },
  createOrchestratorActor: async (tx: WriteTransaction, fallbackId: string) => {
    // We can't create actors/rooms on the client, because otherwise we'll get a
    // local room ID which we'll create, then the server will tell us a different
    // one that we'll need to connect to instead.
    if (env === Env.CLIENT) {
      return;
    }
    const key = `actor/${tx.clientID}`;
    const hasActor = await tx.has(key);
    if (hasActor) {
      // already exists
      return;
    }
    // Find the room we're currently filling
    const roomCount = (await tx.get(ROOM_COUNT_KEY)) as number | undefined;
    const existingRoom = (await tx.get(ROOM_ID_KEY)) as string | undefined;
    let selectedRoomId: string;
    let roomActorNum: number;
    if (
      existingRoom === undefined ||
      (roomCount && roomCount >= ROOM_MAX_ACTORS)
    ) {
      // Make a new room for this user and start adding users to it
      selectedRoomId = fallbackId;
      await tx.put(ROOM_ID_KEY, selectedRoomId);
      await tx.put(ROOM_COUNT_KEY, 1);
      roomActorNum = 1;
    } else {
      selectedRoomId = (await tx.get(ROOM_ID_KEY)) as string;
      roomActorNum = (roomCount || 0) + 1;
      await tx.put(ROOM_COUNT_KEY, roomActorNum);
    }
    // NOTE: we just cycle through colors, so if COLOR_PALATE.length <
    // ROOM_MAX_ACTORS, we'll see cycling duplicates.
    // We do this independently of room count, because that way if someone enters
    // and leaves, each new user will still have a distinct color from the last N users.
    const nextColorNum = (((await tx.get(COLOR_INDEX_KEY)) as number) || 0) + 1;
    const colorIndex = nextColorNum % COLOR_PALATE.length;
    await tx.put(COLOR_INDEX_KEY, nextColorNum);
    const actor: OrchestratorActor = {
      id: tx.clientID,
      colorIndex,
      room: selectedRoomId,
    };
    await tx.put(key, actor);
  },
};
