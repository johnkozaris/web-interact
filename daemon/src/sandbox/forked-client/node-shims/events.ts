// Stand-in for node:events in the QuickJS sandbox bundle. The client only reads
// EventEmitter.defaultMaxListeners; its own EventEmitter lives in src/client/eventEmitter.ts.

export class EventEmitter {
  static defaultMaxListeners = 10;
}

export default { EventEmitter };
