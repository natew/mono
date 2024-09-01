import {
  ChildProcess,
  fork,
  ForkOptions,
  SendHandle,
  Serializable,
} from 'child_process';
import EventEmitter from 'events';
import path from 'path';

/**
 * Central registry of message type names, which are used to identify
 * the payload in {@link Message} objects sent between processes. The
 * payloads themselves are implementation specific and defined in each
 * component; only the type name is reserved here to avoid collisions.
 *
 * Receiving logic can call {@link getMessage()} with the name of
 * the message of interest to filter messages to those of interest.
 */
export const MESSAGE_TYPES = {
  handoff: 'handoff',
  status: 'status',
  subscribe: 'subscribe',
  notify: 'notify',
  ready: 'ready',
} as const;

export type Message<Payload> = [keyof typeof MESSAGE_TYPES, Payload];

function getMessage<M extends Message<unknown>>(
  type: M[0],
  data: unknown,
): M[1] | null {
  if (Array.isArray(data) && data.length === 2 && data[0] === type) {
    return data[1] as M[1];
  }
  return null;
}

function onMessageType<M extends Message<unknown>>(
  e: EventEmitter,
  type: M[0],
  handler: (msg: M[1], sendHandle?: SendHandle) => void,
) {
  return e.on('message', (data, sendHandle) => {
    const msg = getMessage(type, data);
    if (msg) {
      handler(msg, sendHandle);
    }
  });
}

function onceMessageType<M extends Message<unknown>>(
  e: EventEmitter,
  type: M[0],
  handler: (msg: M[1], sendHandle?: SendHandle) => void,
) {
  const listener = (data: unknown, sendHandle: SendHandle) => {
    const msg = getMessage(type, data);
    if (msg) {
      e.off('message', listener);
      handler(msg, sendHandle);
    }
  };
  return e.on('message', listener);
}

export interface Receiver {
  send<M extends Message<unknown>>(
    message: M,
    sendHandle?: SendHandle,
    callback?: (error: Error | null) => void,
  ): boolean;
}

export interface Sender extends EventEmitter {
  /**
   * The receiving side of {@link Receiver.send()} that is a wrapper around
   * {@link on}('message', ...) that invokes the `handler` for messages of
   * the specified `type`.
   */
  onMessageType<M extends Message<unknown>>(
    type: M[0],
    handler: (msg: M[1], sendHandle?: SendHandle) => void,
  ): this;

  /**
   * The receiving side of {@link Receiver.send()} that behaves like
   * {@link once}('message', ...) that invokes the `handler` for the next
   * message of the specified `type` and then unsubscribes.
   */
  onceMessageType<M extends Message<unknown>>(
    type: M[0],
    handler: (msg: M[1], sendHandle?: SendHandle) => void,
  ): this;
}

export interface Worker extends Sender, Receiver {}

/**
 * Adds the {@link Sender.onMessageType()} and {@link Sender.onceMessageType()}
 * methods to convert the given `EventEmitter` to a `Sender`.
 */
function wrap<P extends EventEmitter>(proc: P): P & Sender {
  return new Proxy(proc, {
    get(target: P, prop: string | symbol, receiver: unknown) {
      switch (prop) {
        case 'onMessageType':
          return (
            type: keyof typeof MESSAGE_TYPES,
            handler: (msg: unknown, sendHandle?: SendHandle) => void,
          ) => {
            onMessageType(target, type, handler);
            return receiver; // this
          };
        case 'onceMessageType':
          return (
            type: keyof typeof MESSAGE_TYPES,
            handler: (msg: unknown, sendHandle?: SendHandle) => void,
          ) => {
            onceMessageType(target, type, handler);
            return receiver; // this
          };
      }
      return Reflect.get(target, prop, receiver);
    },
  }) as P & Sender;
}

type Proc = Pick<ChildProcess, 'send'> & EventEmitter;

/**
 * The parentWorker for forked processes, or `null` if the process was not forked.
 * (Analogous to the `parentPort: MessagePort | null` of the `"workers"` library).
 */
export const parentWorker: Worker | null = process.send
  ? wrap(process as Proc)
  : null;

const SINGLE_PROCESS = 'SINGLE_PROCESS';

export function singleProcessMode(): boolean {
  return (process.env[SINGLE_PROCESS] ?? '0') !== '0';
}

export function childWorker(module: string, options?: ForkOptions): Worker {
  if (singleProcessMode()) {
    const [parent, child] = inProcChannel();
    void import(path.join('../../', module))
      .then(({default: runWorker}) => runWorker(parent))
      .catch(err => child.emit('error', err));
    return child;
  }
  // Note: It is okay to cast a Processor or ChildProcess as a Worker.
  // The {@link send} method simply restricts the message type for clarity.
  return wrap(fork(module, {...options, serialization: 'advanced'}));
}

/**
 * Creates two connected `Worker` instances such that messages sent to one
 * via the {@link Worker.send()} method are received by the other's
 * `on('message', ...)` handler.
 *
 * This is analogous to the two `MessagePort`s of a `MessageChannel`, and
 * is useful for executing code written for inter-process communication
 * in a single process.
 */
export function inProcChannel(): [Worker, Worker] {
  const worker1 = new EventEmitter();
  const worker2 = new EventEmitter();

  const sendTo =
    (dest: EventEmitter) =>
    (
      message: Serializable,
      sendHandle?: SendHandle,
      callback?: (error: Error | null) => void,
    ) => {
      dest.emit('message', message, sendHandle);
      if (callback) {
        callback(null);
      }
      return true;
    };

  return [
    wrap(Object.assign(worker1, {send: sendTo(worker2)})),
    wrap(Object.assign(worker2, {send: sendTo(worker1)})),
  ];
}
