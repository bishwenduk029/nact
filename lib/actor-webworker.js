'use strict';
const { Worker } = require('webworker-threads');

const createActorWebworker = () => new Worker(
    function () {
        // Helper functions for type introspection
        const isType = (self, t) => { return !!self && t.name === Object.getPrototypeOf(self).constructor.name };


        const serializeErr = err => JSON.stringify(err, Object.getOwnPropertyNames(err));

        class Deferred {
            constructor() {
                this.promise = new Promise((resolve, reject) => {
                    this.reject = reject;
                    this.resolve = resolve;
                });
                this.promise.then(() => { this.done = true }).catch(() => { this.done = true });
            }
        }

        class Queue {

            constructor() {
                this.head = undefined;
                this.tail = undefined;
            }

            static empty() { return new Queue(); }

            enqueue(item) {
                let nextTail = { item };
                if (this.isEmpty()) {
                    this.head = nextTail;
                    this.tail = nextTail;
                } else {
                    let prevTail = this.tail;
                    prevTail.next = nextTail;
                    this.tail = nextTail;
                }
            }

            isEmpty() {
                return !this.head;
            }

            peek() { return this.isEmpty() ? undefined : this.head.item; }

            dequeue() {
                if (!this.isEmpty()) {
                    const item = this.head.item;
                    this.head = this.head.next;
                    return item;
                } else {
                    throw new Error('Attempted illegal operation: Empty queue cannot be popped');
                }
            }
        }

        class RingBuffer {
            constructor(size) {
                this.size = size;
                this.arr = new Array(size);
                this.count = 0;
            };

            get(index) {
                return this.arr[index];
            }

            set(index, value) {
                this.arr[index] = value;
            }

            add(value) {
                let i = this.count;
                let prev = this.arr[i];
                this.arr[i] = value;
                ++this.count;
                this.count = this.count >= this.size ? 0 : this.count;
                return [i, prev];
            }
        }

        let busy = false;
        let outstandingEffects = new RingBuffer(4048);
        let mailbox = Queue.empty();
        let f = undefined;

        name = undefined;
        path = undefined;
        sender = undefined;
        parent = undefined;
        children = undefined;
        stopped = false;

        const processNext = (next) => {
            if (typeof (next) === 'function') {
                f = next;
                if (!mailbox.isEmpty()) {
                    let nextMessage = mailbox.dequeue();
                    handleMessage(nextMessage);
                } else {
                    busy = false;
                }
            } else if (!next) {
                stop();
            } else {
                throw new TypeError('Unsupported Type');
            }
        };

        const handleMessage = (msg) => {
            busy = true;
            let next = undefined;
            if (!!f) {
                try {
                    const _name = '' + name;
                    const _path = Object.freeze(path);
                    const _parent = Object.freeze(parent);
                    const _children = new Map(children.entries());
                    sender = Object.freeze(msg.payload.sender);
                    next = f.call({}, msg.payload.message);
                    name = _name;
                    path = _path;
                    parent = _parent;
                    children = _children;
                    if (next && next.then && next.catch) {
                        next.then((result) => processNext(result));
                    } else {
                        processNext(next);
                    }
                } catch (e) {
                    signalFault(e);
                    return;
                }
            }
        };

        const dispatchAsync = ((action, args) => {
            try {
                args = args.map(x => (typeof (x) === 'function') ? x + '' : x);
                let deferred = new Deferred();
                let [index, prev] = outstandingEffects.add(deferred);
                if (prev != undefined && !prev.done) {
                    prev.reject('Promise timed out');
                }
                thread.nextTick(() => {
                    self.postMessage(JSON.stringify({ action, args, sender: path, index }));
                });
                return deferred.promise;
            }
            catch (e) {
                signalFault(e);
            }
        });

        const dispatch = (action, args) =>            
            self.postMessage(JSON.stringify({ action, args, sender: path }));


        const signalFault = (e) => {
            let error = serializeErr(e);
            console.error(error);
            self.postMessage(JSON.stringify({ action: 'faulted', payload: { sender: path, payload: { error } }, sender: path }));
            self.close();
        };

        const stop = () => {
            stopped = true;
            dispatch('stop');
        }

        const bindEffects = (effects) => {

            let mapFold = (name, length, async) => {
                let f = async
                    ? (...args) => dispatchAsync(name, args)
                    : (...args) => dispatch(name, args);

                return (effect, part, index) => {
                    let next = index + 1 === length
                        ? f
                        : (effect[part] || {});

                    effect[part] = next;
                    return next;
                };
            };

            effects
                .map(e => ({ parts: e.effect.split('.'), name: e.effect, async: e.async }))
                .map(e => e.parts.reduce(mapFold(e.name, e.parts.length, e.async), global));
        };


        self.onmessage = (evt) => {
            try {

                let message = JSON.parse(evt.data);
                let payload = message.payload;

                switch (message.action) {
                    case 'initialize': {
                        try {
                            f = eval(payload.f)();
                            name = payload.name;
                            path = payload.path;
                            parent = payload.parent;
                            children = new Map();
                            bindEffects(payload.effects);
                        } catch (e) {
                            console.log(serializeErr(e));
                            signalFault(e);
                        }
                        break;
                    }
                    case 'childSpawned': {
                        children.set(payload.name, payload.child);
                    }
                    case 'childStopped': {
                        children.delete(payload.child);
                        break;
                    }
                    case 'effectApplied': {
                        let index = payload.index;
                        let effect = outstandingEffects.get(index);
                        outstandingEffects.set(index, undefined);
                        if (effect) {
                            effect.resolve(payload.value);
                        }
                        break;
                    }
                    case 'effectFailed': {
                        let index = payload.index;
                        let effect = outstandingEffects.get(index);
                        if (effect) {
                            effect.reject(payload.value);
                        }
                        break;
                    }
                    case 'tell': {
                        if (!stopped) {
                            if (!busy) {
                                handleMessage(message);
                            } else {
                                mailbox.enqueue(message);
                            }
                        }
                        break;
                    }
                    case 'stop': {
                        stopped = true;
                        self.close();
                        break;
                    }
                }
            } catch (e) {
                signalFault(e);
            }
        };
    });

module.exports = { createActorWebworker };