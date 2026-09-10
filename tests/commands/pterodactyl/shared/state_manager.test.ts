import { StateManager, State, STATES } from '../../../../src/commands/pterodactyl/shared/state_manager.js';
import type {
    PterodactylServer,
    ServerResources,
} from '../../../../src/commands/pterodactyl/shared/pterodactyl_api.js';

const server: PterodactylServer = {
    attributes: { identifier: 'server-123', name: 'Test Server', description: '' },
};

const other: PterodactylServer = {
    attributes: { identifier: 'other', name: 'Other', description: '' },
};

const gone: PterodactylServer = {
    attributes: { identifier: 'gone', name: 'Gone', description: '' },
};

function resources(current_state: string, uptime = 0): ServerResources {
    return {
        attributes: {
            current_state,
            resources: { memory_bytes: 0, cpu_absolute: 0, disk_bytes: 0, uptime },
        },
    };
}

describe('State', () => {
    describe('the baseline reading', () => {
        it('starts from the reading it was built with', () => {
            const state = new State(server, resources(STATES.running, 1000));

            expect(state.server).toBe(server);
            expect(state.getStatus()).toBe(STATES.running);
            expect(state.getResources()).toEqual(resources(STATES.running, 1000));
        });

        it('treats a missing baseline read as an empty status', () => {
            const state = new State(server, null);

            expect(state.getStatus()).toBe('');
            expect(state.getResources()).toBeNull();
        });

        it('reads any status as a change when the baseline read was missing', () => {
            const state = new State(server, null);
            state.track('restart');

            state.observe(resources(STATES.running, 800));

            expect(state.isComplete()).toBe(true);
        });
    });

    describe('start and stop', () => {
        it('completes a start when the server reports running', () => {
            const state = new State(server, resources(STATES.offline));
            state.track('start');

            state.observe(resources(STATES.starting));
            expect(state.isComplete()).toBe(false);

            state.observe(resources(STATES.running, 1000));
            expect(state.isComplete()).toBe(true);
        });

        it('completes a stop when the server reports offline', () => {
            const state = new State(server, resources(STATES.running, 500000));
            state.track('stop');

            state.observe(resources(STATES.stopping));
            expect(state.isComplete()).toBe(false);

            state.observe(resources(STATES.offline));
            expect(state.isComplete()).toBe(true);
        });

        it('does not treat the starting status as completion for a start', () => {
            const state = new State(server, resources(STATES.offline));
            state.track('start');

            state.observe(resources(STATES.offline));

            expect(state.isComplete()).toBe(false);
        });
    });

    describe('restart detection', () => {
        it('detects a restart from a state change away from the starting status', () => {
            const state = new State(server, resources(STATES.running, 500000));
            state.track('restart');

            // Uptime keeps climbing throughout, so only the state change is evidence.
            state.observe(resources(STATES.running, 500500));
            expect(state.isComplete()).toBe(false);

            state.observe(resources(STATES.stopping, 501000));
            state.observe(resources(STATES.running, 502000));

            expect(state.isComplete()).toBe(true);
        });

        it('detects a restart from an uptime reset when the transition was never observed', () => {
            const state = new State(server, resources(STATES.running, 500000));
            state.track('restart');

            // The server went down and came back between two polls: the status never changed.
            state.observe(resources(STATES.running, 1200));

            expect(state.isComplete()).toBe(true);
        });

        it('stays incomplete while neither the status nor the uptime shows a restart', () => {
            const state = new State(server, resources(STATES.running, 500000));
            state.track('restart');

            state.observe(resources(STATES.running, 500500));
            state.observe(resources(STATES.running, 501000));

            expect(state.isComplete()).toBe(false);
        });

        it('requires the server back at running, not merely evidence of a restart', () => {
            const state = new State(server, resources(STATES.running, 500000));
            state.track('restart');

            state.observe(resources(STATES.offline));
            expect(state.isComplete()).toBe(false);

            // The reading that proved the restart still counts once the server is back.
            state.observe(resources(STATES.running, 800));
            expect(state.isComplete()).toBe(true);
        });

        it('detects a restart of a server that was offline when the action was invoked', () => {
            const state = new State(server, resources(STATES.offline));
            state.track('restart');

            state.observe(resources(STATES.starting));
            state.observe(resources(STATES.running, 800));

            expect(state.isComplete()).toBe(true);
        });

        it('does not let a previous restart complete the next one', () => {
            const state = new State(server, resources(STATES.running, 500000));
            state.track('restart');
            state.observe(resources(STATES.stopping, 0));
            state.observe(resources(STATES.running, 2000));
            state.clearAction();

            state.track('restart');

            // The first restart's evidence is spent; this one must prove itself.
            state.observe(resources(STATES.running, 2500));
            expect(state.isComplete()).toBe(false);

            state.observe(resources(STATES.stopping, 0));
            state.observe(resources(STATES.running, 1000));
            expect(state.isComplete()).toBe(true);
        });
    });

    describe('observation handling', () => {
        it('ignores a failed read and keeps the last known status', () => {
            const state = new State(server, resources(STATES.offline));
            state.track('start');
            state.observe(resources(STATES.running, 1000));

            state.observe(null);

            expect(state.getStatus()).toBe(STATES.running);
            expect(state.getResources()).toBeNull();
            expect(state.isComplete()).toBe(true);
        });
    });

    describe('watching', () => {
        it('is neither watched nor complete before an action is tracked', () => {
            const state = new State(server, resources(STATES.running, 1000));

            expect(state.isWatched()).toBe(false);
            expect(state.isComplete()).toBe(false);
        });

        it('stops watching once the action is cleared', () => {
            const state = new State(server, resources(STATES.offline));
            state.track('start');
            state.observe(resources(STATES.running, 1000));
            expect(state.isWatched()).toBe(true);

            state.clearAction();

            expect(state.isWatched()).toBe(false);
            expect(state.isComplete()).toBe(false);
        });
    });
});

describe('StateManager', () => {
    let manager: StateManager;

    beforeEach(() => {
        manager = new StateManager();
    });

    describe('attaching servers', () => {
        it('lists every server the panel is showing', () => {
            manager.attachState(server, resources(STATES.running, 1000));
            manager.attachState(other, resources(STATES.offline));

            expect(manager.managedServers()).toEqual([server, other]);
        });

        it('replaces the reading when a server is attached again', () => {
            manager.attachState(server, resources(STATES.offline));

            manager.attachState(server, resources(STATES.running, 1000));

            expect(manager.managedServers()).toEqual([server]);
            expect(manager.currentStates([server])).toEqual([STATES.running]);
        });

        it("names one server or all of them as an action's targets", () => {
            manager.attachState(server, resources(STATES.running, 1000));
            manager.attachState(other, resources(STATES.offline));

            expect(manager.targets('all')).toEqual([server, other]);
            expect(manager.targets('other')).toEqual([other]);
            expect(manager.targets('gone')).toEqual([]);
        });

        it('hands back the last reading for every server it holds', () => {
            manager.attachState(server, resources(STATES.running, 1000));
            manager.attachState(other, null);

            expect(manager.currentResources()).toEqual([resources(STATES.running, 1000), null]);
        });

        it('reads an empty status for a server it does not hold', () => {
            manager.attachState(server, resources(STATES.running, 1000));

            expect(manager.currentStates([server, gone])).toEqual([STATES.running, '']);
        });
    });

    describe('observing a poll', () => {
        it('pairs each reading with the server it was taken for', () => {
            manager.attachState(server, resources(STATES.offline));
            manager.attachState(other, resources(STATES.offline));

            // Given in the opposite order to the panel, so only the identifiers can pair them up.
            manager.observeAll([other, server], [resources(STATES.running, 100), resources(STATES.starting)]);

            expect(manager.currentStates([server, other])).toEqual([STATES.starting, STATES.running]);
        });

        it('leaves a server that was not polled holding its last reading', () => {
            manager.attachState(server, resources(STATES.offline));
            manager.attachState(other, resources(STATES.running, 1000));

            manager.observeAll([server], [resources(STATES.starting)]);

            expect(manager.currentResources()).toEqual([resources(STATES.starting), resources(STATES.running, 1000)]);
        });

        it('ignores a reading for a server it does not hold', () => {
            expect(() => manager.observeAll([gone], [resources(STATES.running, 100)])).not.toThrow();
            expect(manager.managedServers()).toEqual([]);
        });
    });

    describe('tracking an action', () => {
        it('is complete while no action is being watched', () => {
            manager.attachState(server, resources(STATES.running, 1000));

            expect(manager.allComplete()).toBe(true);
        });

        it('waits on every watched server before it reports the action finished', () => {
            manager.attachState(server, resources(STATES.offline));
            manager.attachState(other, resources(STATES.offline));
            manager.trackState('server-123', 'start');
            manager.trackState('other', 'start');

            manager.observeAll([server, other], [resources(STATES.running, 100), resources(STATES.starting)]);
            expect(manager.allComplete()).toBe(false);

            manager.observeAll([other], [resources(STATES.running, 200)]);
            expect(manager.allComplete()).toBe(true);
        });

        it('ignores an action tracked against a server it does not hold', () => {
            expect(() => manager.trackState('unknown', 'start')).not.toThrow();
            expect(manager.allComplete()).toBe(true);
        });
    });

    describe('ending an action', () => {
        it('clears only the servers it is given, and keeps them on the panel', () => {
            manager.attachState(server, resources(STATES.offline));
            manager.attachState(other, resources(STATES.offline));
            manager.trackState('server-123', 'start');
            manager.trackState('other', 'start');
            manager.observeAll([server, other], [resources(STATES.running, 100), resources(STATES.offline)]);
            expect(manager.allComplete()).toBe(false);

            manager.clearActions([other]);

            // `other` is no longer watched, and `server` is still tracked and finished.
            expect(manager.allComplete()).toBe(true);
            expect(manager.managedServers()).toEqual([server, other]);
        });

        it('ignores a server it does not hold', () => {
            expect(() => manager.clearActions([gone])).not.toThrow();
        });

        it('clears every tracked server when the panel is discarded', () => {
            manager.attachState(server, resources(STATES.offline));

            manager.flushState();

            expect(manager.managedServers()).toEqual([]);
            expect(manager.currentResources()).toEqual([]);
        });
    });
});
