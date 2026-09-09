import { StateManager, State, STATES } from '../../../../src/commands/pterodactyl/shared/state_manager.js';
import type {
    PterodactylServer,
    ServerResources,
} from '../../../../src/commands/pterodactyl/shared/pterodactyl_api.js';

const server: PterodactylServer = {
    attributes: { identifier: 'server-123', name: 'Test Server', description: '' },
};

function resources(current_state: string, uptime = 0): ServerResources {
    return {
        attributes: {
            current_state,
            resources: { memory_bytes: 0, cpu_absolute: 0, disk_bytes: 0, uptime },
        },
    };
}

describe('StateManager', () => {
    let manager: StateManager;

    beforeEach(() => {
        manager = new StateManager();
    });

    describe('start and stop', () => {
        it('completes a start when the server reports running', () => {
            manager.newState(server, resources(STATES.offline), 'start');

            manager.observe('server-123', resources(STATES.starting));
            expect(manager.isComplete('server-123')).toBe(false);

            manager.observe('server-123', resources(STATES.running, 1000));
            expect(manager.isComplete('server-123')).toBe(true);
        });

        it('completes a stop when the server reports offline', () => {
            manager.newState(server, resources(STATES.running, 500000), 'stop');

            manager.observe('server-123', resources(STATES.stopping));
            expect(manager.isComplete('server-123')).toBe(false);

            manager.observe('server-123', resources(STATES.offline));
            expect(manager.isComplete('server-123')).toBe(true);
        });

        it('does not treat the starting status as completion for a start', () => {
            manager.newState(server, resources(STATES.offline), 'start');

            manager.observe('server-123', resources(STATES.offline));

            expect(manager.isComplete('server-123')).toBe(false);
        });
    });

    describe('restart detection', () => {
        it('detects a restart from a state change away from the starting status', () => {
            manager.newState(server, resources(STATES.running, 500000), 'restart');

            // Uptime keeps climbing throughout, so only the state change is evidence.
            manager.observe('server-123', resources(STATES.running, 500500));
            expect(manager.isComplete('server-123')).toBe(false);

            manager.observe('server-123', resources(STATES.stopping, 501000));
            manager.observe('server-123', resources(STATES.running, 502000));

            expect(manager.getState('server-123')?.restartDetect).toBe(true);
            expect(manager.isComplete('server-123')).toBe(true);
        });

        it('detects a restart from an uptime reset when the transition was never observed', () => {
            manager.newState(server, resources(STATES.running, 500000), 'restart');

            // The server went down and came back between two polls: the status never changed.
            manager.observe('server-123', resources(STATES.running, 1200));

            expect(manager.getState('server-123')?.restartDetect).toBe(true);
            expect(manager.isComplete('server-123')).toBe(true);
        });

        it('stays incomplete while neither the status nor the uptime shows a restart', () => {
            manager.newState(server, resources(STATES.running, 500000), 'restart');

            manager.observe('server-123', resources(STATES.running, 500500));
            manager.observe('server-123', resources(STATES.running, 501000));

            expect(manager.getState('server-123')?.restartDetect).toBe(false);
            expect(manager.isComplete('server-123')).toBe(false);
        });

        it('requires the server back at running, not merely evidence of a restart', () => {
            manager.newState(server, resources(STATES.running, 500000), 'restart');

            manager.observe('server-123', resources(STATES.offline));

            expect(manager.getState('server-123')?.restartDetect).toBe(true);
            expect(manager.isComplete('server-123')).toBe(false);
        });

        it('detects a restart of a server that was offline when the action was invoked', () => {
            manager.newState(server, resources(STATES.offline), 'restart');

            manager.observe('server-123', resources(STATES.starting));
            manager.observe('server-123', resources(STATES.running, 800));

            expect(manager.isComplete('server-123')).toBe(true);
        });
    });

    describe('observation handling', () => {
        it('ignores a failed read and keeps the last known status', () => {
            manager.newState(server, resources(STATES.offline), 'start');
            manager.observe('server-123', resources(STATES.running, 1000));

            manager.observe('server-123', null);

            expect(manager.getState('server-123')?.currentStatus).toBe(STATES.running);
            expect(manager.isComplete('server-123')).toBe(true);
        });

        it('ignores observations for servers it is not tracking', () => {
            expect(() => manager.observe('unknown', resources(STATES.running))).not.toThrow();
            expect(manager.isComplete('unknown')).toBe(false);
            expect(manager.getState('unknown')).toBeUndefined();
        });

        it('treats a missing baseline read as an empty starting status', () => {
            manager.newState(server, null, 'start');

            const state = manager.getState('server-123') as State;
            expect(state.startingStatus).toBe('');
            expect(state.startingUptime).toBe(0);

            manager.observe('server-123', resources(STATES.running, 1000));
            expect(manager.isComplete('server-123')).toBe(true);
        });
    });

    describe('flushState', () => {
        it('clears only the identifiers it is given', () => {
            const other: PterodactylServer = { attributes: { identifier: 'other', name: 'Other', description: '' } };
            manager.newState(server, resources(STATES.offline), 'start');
            manager.newState(other, resources(STATES.offline), 'start');

            manager.flushState(['server-123']);

            expect(manager.getState('server-123')).toBeUndefined();
            expect(manager.getState('other')).toBeDefined();
        });

        it('clears every tracked server when given no identifiers', () => {
            manager.newState(server, resources(STATES.offline), 'start');

            manager.flushState();

            expect(manager.getState('server-123')).toBeUndefined();
        });
    });
});
