import { Machine, spawn, interpret } from '../src';
import {
  assign,
  send,
  sendParent,
  raise,
  doneInvoke,
  actionTypes
} from '../src/actions';
import { Actor } from '../src/Actor';
import { assert } from 'chai';
import { interval } from 'rxjs';
import { map } from 'rxjs/operators';

describe('spawning machines', () => {
  const todoMachine = Machine({
    id: 'todo',
    initial: 'incomplete',
    states: {
      incomplete: {
        on: { SET_COMPLETE: 'complete' }
      },
      complete: {
        onEntry: sendParent({ type: 'TODO_COMPLETED' })
      }
    }
  });

  const context = {
    todoRefs: {} as Record<string, Actor>
  };

  type TodoEvent =
    | {
        type: 'ADD';
        id: string;
      }
    | {
        type: 'SET_COMPLETE';
        id: string;
      }
    | {
        type: 'TODO_COMPLETED';
      };

  const todosMachine = Machine<typeof context, any, TodoEvent>({
    id: 'todos',
    context,
    initial: 'active',
    states: {
      active: {
        on: {
          TODO_COMPLETED: 'success'
        }
      },
      success: {
        type: 'final'
      }
    },
    on: {
      ADD: {
        actions: assign({
          todoRefs: (ctx, e) => ({
            ...ctx.todoRefs,
            [e.id as string]: spawn(todoMachine)
          })
        })
      },
      SET_COMPLETE: {
        actions: send('SET_COMPLETE', {
          to: (ctx, e) => {
            return ctx.todoRefs[e.id as string];
          }
        })
      }
    }
  });

  // Adaptation: https://github.com/p-org/P/wiki/PingPong-program
  type PingPongEvent =
    | { type: 'PING' }
    | { type: 'PONG' }
    | { type: 'SUCCESS' };

  const serverMachine = Machine({
    id: 'server',
    initial: 'waitPing',
    states: {
      waitPing: {
        on: {
          PING: 'sendPong'
        }
      },
      sendPong: {
        entry: [sendParent('PONG'), raise('SUCCESS')],
        on: {
          SUCCESS: 'waitPing'
        }
      }
    }
  });

  interface ClientContext {
    server?: Actor;
  }

  const clientMachine = Machine<ClientContext, any, PingPongEvent>({
    id: 'client',
    initial: 'init',
    context: {
      server: undefined
    },
    states: {
      init: {
        entry: [
          assign({
            server: () => spawn(serverMachine)
          }),
          raise('SUCCESS')
        ],
        on: {
          SUCCESS: 'sendPing'
        }
      },
      sendPing: {
        entry: [
          send('PING', { to: ctx => ctx.server as Actor }),
          raise('SUCCESS')
        ],
        on: {
          SUCCESS: 'waitPong'
        }
      },
      waitPong: {
        on: {
          PONG: 'complete'
        }
      },
      complete: {
        type: 'final'
      }
    }
  });

  it('should invoke actors', done => {
    const service = interpret(todosMachine)
      .onDone(() => {
        done();
      })
      .start();

    service.send('ADD', { id: 42 });
    service.send('SET_COMPLETE', { id: 42 });
  });

  it('should invoke a null actor if spawned outside of a service', () => {
    assert.ok(spawn(todoMachine));
  });

  it('should allow bidirectional communication between parent/child actors', done => {
    interpret(clientMachine)
      .onDone(() => {
        done();
      })
      .start();
  });
});

describe('spawning promises', () => {
  const promiseMachine = Machine<any>({
    id: 'promise',
    initial: 'idle',
    context: {
      promiseRef: undefined
    },
    states: {
      idle: {
        entry: assign({
          promiseRef: () => {
            const ref = spawn(
              new Promise(res => {
                res('response');
              }),
              'my-promise'
            );

            return ref;
          }
        }),
        on: {
          [doneInvoke('my-promise')]: {
            target: 'success',
            cond: (_, e) => e.data === 'response'
          }
        }
      },
      success: {
        type: 'final'
      }
    }
  });

  it('should be able to spawn a promise', done => {
    const promiseService = interpret(promiseMachine).onDone(() => {
      done();
    });

    promiseService.start();
  });
});

describe('spawning callbacks', () => {
  const callbackMachine = Machine<any>({
    id: 'callback',
    initial: 'idle',
    context: {
      callbackRef: undefined
    },
    states: {
      idle: {
        entry: assign({
          callbackRef: () =>
            spawn((cb, receive) => {
              receive(event => {
                if (event.type === 'START') {
                  setTimeout(() => {
                    cb('SEND_BACK');
                  }, 10);
                }
              });
            })
        }),
        on: {
          START_CB: { actions: send('START', { to: ctx => ctx.callbackRef }) },
          SEND_BACK: 'success'
        }
      },
      success: {
        type: 'final'
      }
    }
  });

  it('should be able to spawn an actor from a callback', done => {
    const callbackService = interpret(callbackMachine).onDone(() => {
      done();
    });

    callbackService.start();
    callbackService.send('START_CB');
  });
});

describe('spawning observables', () => {
  const observableMachine = Machine<any>({
    id: 'observable',
    initial: 'idle',
    context: {
      observableRef: undefined
    },
    states: {
      idle: {
        entry: assign({
          observableRef: () => {
            const ref = spawn(
              interval(10).pipe(
                map(n => ({
                  type: 'INT',
                  value: n
                }))
              )
            );

            return ref;
          }
        }),
        on: {
          INT: {
            target: 'success',
            cond: (_, e) => e.value === 5
          }
        }
      },
      success: {
        type: 'final'
      }
    }
  });

  it('should be able to spawn an observable', done => {
    const observableService = interpret(observableMachine).onDone(() => {
      done();
    });

    observableService.start();
  });
});

describe('actors', () => {
  it('should only spawn actors defined on initial state once', () => {
    let count = 0;

    const startMachine = Machine<any>({
      id: 'start',
      initial: 'start',
      context: {
        items: [0, 1, 2, 3],
        refs: []
      },
      states: {
        start: {
          entry: assign({
            refs: ctx => {
              count++;
              const c = ctx.items.map(item =>
                spawn(new Promise(res => res(item)))
              );

              return c;
            }
          })
        }
      }
    });

    interpret(startMachine)
      .onTransition(() => {
        assert.equal(count, 1);
      })
      .start();
  });

  it('should spawn null actors if not used within a service', () => {
    const nullActorMachine = Machine<{ ref: undefined | Actor }>({
      initial: 'foo',
      context: { ref: undefined },
      states: {
        foo: {
          entry: assign<any>({
            ref: () => spawn(Promise.resolve(42))
          })
        }
      }
    });

    const { initialState } = nullActorMachine;

    // assert.equal(initialState.context.ref!.id, 'null'); // TODO: identify null actors
    assert.isDefined(initialState.context.ref!.send);
  });

  describe('autoForward option', () => {
    const pongActorMachine = Machine({
      id: 'server',
      initial: 'waitPing',
      states: {
        waitPing: {
          on: {
            PING: 'sendPong'
          }
        },
        sendPong: {
          entry: [sendParent('PONG'), raise('SUCCESS')],
          on: {
            SUCCESS: 'waitPing'
          }
        }
      }
    })

    it('should not forward events to a spawned actor by default', () => {
      let pongCounter = 0;

      const machine = Machine<any>({
        id: 'client',
        context: { counter: 0, serverRef: undefined },
        initial: 'initial',
        states: {
          initial: {
            entry: assign(() => ({
              serverRef: spawn(pongActorMachine)
            })),
            on: {
              PONG: {
                actions: () => ++pongCounter
              }
            }
          }
        }
      });
      const service = interpret(machine);
      service.start();
      service.send('PING')
      service.send('PING')
      assert.equal(pongCounter, 0);
    })

    it('should not forward events to a spawned actor when { autoForward: false }', () => {
      let pongCounter = 0;

      const machine = Machine<any>({
        id: 'client',
        context: { counter: 0, serverRef: undefined },
        initial: 'initial',
        states: {
          initial: {
            entry: assign(() => ({
              serverRef: spawn(pongActorMachine, { autoForward: false })
            })),
            on: {
              PONG: {
                actions: () => ++pongCounter
              }
            }
          }
        }
      });
      const service = interpret(machine);
      service.start();
      service.send('PING');
      service.send('PING');
      assert.equal(pongCounter, 0);
    });

    it('should forward events to a spawned actor when { autoForward: true }', () => {
      let pongCounter = 0;

      const machine = Machine<any>({
        id: 'client',
        context: { counter: 0, serverRef: undefined },
        initial: 'initial',
        states: {
          initial: {
            entry: assign(() => ({
              serverRef: spawn(pongActorMachine, { autoForward: true })
            })),
            on: {
              PONG: {
                actions: () => ++pongCounter
              }
            }
          }
        }
      });
      const service = interpret(machine);
      service.start();
      service.send('PING');
      service.send('PING');
      assert.equal(pongCounter, 2);
    });
  });

  describe('sync option', () => {
    const childMachine = Machine({
      id: 'child',
      context: { value: 0 },
      initial: 'active',
      states: {
        active: {
          after: {
            10: { actions: assign({ value: 42 }) }
          }
        }
      }
    });

    const parentMachine = Machine<{
      ref: any;
      refNoSync: any;
      refNoSyncDefault: any;
    }>({
      id: 'parent',
      context: {
        ref: undefined,
        refNoSync: undefined,
        refNoSyncDefault: undefined
      },
      initial: 'foo',
      states: {
        foo: {
          entry: assign({
            ref: () => spawn(childMachine, { sync: true }),
            refNoSync: () => spawn(childMachine, { sync: false }),
            refNoSyncDefault: () => spawn(childMachine)
          }),
          on: {
            '': {
              target: 'success',
              cond: ctx => {
                assert.isDefined(ctx.ref.state);
                return ctx.ref.state.context.value === 42;
              }
            },
            CHECK_NO_SYNC: {
              target: 'success',
              cond: ctx => {
                assert.isUndefined(ctx.refNoSync.state);
                return !ctx.refNoSync.state;
              }
            },
            CHECK_NO_SYNC_DEFAULT: {
              target: 'success',
              cond: ctx => {
                assert.isUndefined(ctx.refNoSyncDefault.state);
                return !ctx.refNoSyncDefault.state;
              }
            }
          }
        },
        success: {
          type: 'final'
        }
      },
      on: {
        [actionTypes.update]: {
          actions: assign({})
        }
      }
    });

    it('should sync spawned actor state when { sync: true }', done => {
      const service = interpret(parentMachine, { id: 'a-service' }).onDone(() =>
        done()
      );
      service.start();
    });

    it('should not sync spawned actor state when { sync: false }', done => {
      const service = interpret(parentMachine, { id: 'b-service' }).onDone(
        () => {
          assert.isUndefined(service.state.context.refNoSync.state);
          done();
        }
      );
      service.start();
      service.send('CHECK_NO_SYNC');
    });

    it('should not sync spawned actor state (default)', done => {
      const service = interpret(parentMachine, { id: 'c-service' }).onDone(
        () => {
          assert.isUndefined(service.state.context.refNoSyncDefault.state);
          done();
        }
      );
      service.start();
      service.send('CHECK_NO_SYNC_DEFAULT');
    });
  });
});
