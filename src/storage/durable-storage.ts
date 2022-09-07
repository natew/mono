import type { JSONValue } from "replicache";
import type * as z from "superstruct";
import { delEntry, getEntry, putEntry, listEntries } from "../db/data.js";
import type { Storage } from "./storage.js";

// DurableObjects has a lot of clever optimisations we can take advantage of,
// but they require some thought as to whether they fit with what we are doing.
// These settings make DO behave more like a basic kv store and thus work
// better with our existing code.
// TODO: Evaluate these options and perhaps simplify our code by taking advantage.
const baseOptions = {
  // We already control currency with locks at a higher level in the game loop.
  allowConcurrency: true,
};

/**
 * Implements the Storage interface in terms of the database.
 */
export class DurableStorage implements Storage {
  private _durable: DurableObjectStorage;
  private _allowUnconfirmed: boolean;

  constructor(durable: DurableObjectStorage, allowUnconfirmed = true) {
    this._durable = durable;
    this._allowUnconfirmed = allowUnconfirmed;
  }

  put<T extends JSONValue>(key: string, value: T): Promise<void> {
    return putEntry(this._durable, key, value, {
      ...baseOptions,
      allowUnconfirmed: this._allowUnconfirmed,
    });
  }

  del(key: string): Promise<void> {
    return delEntry(this._durable, key, {
      ...baseOptions,
      allowUnconfirmed: this._allowUnconfirmed,
    });
  }

  get<T extends JSONValue>(
    key: string,
    schema: z.Struct<T>
  ): Promise<T | undefined> {
    return getEntry(this._durable, key, schema, baseOptions);
  }

  async list<T extends JSONValue>(
    prefix: string,
    schema: z.Struct<T>
  ): Promise<Map<string, T>> {
    return await listEntries(this._durable, prefix, schema, baseOptions);
  }
}
