import { PterodactylServer, ServerResources } from './pterodactyl_api.js';

export enum STATES {
    offline = 'offline',
    starting = 'starting',
    running = 'running',
    stopping = 'stopping',
}

export type ActionType = 'start' | 'stop' | 'restart';

/**
 * Tracks what each server was doing when an action was invoked, so a later observation can be judged
 * against it. Restarts are the reason this exists: a restarted server ends where it began, so
 * "current state equals the target" is not evidence on its own.
 */
export class StateManager {
    private states = new Map<string, State>();

    /** Records where a server started, before its power command is sent. */
    newState(server: PterodactylServer, resources: ServerResources | null, actionType: ActionType): void {
        this.states.set(server.attributes.identifier, new State(resources, actionType));
    }

    /** Feeds one poll's observation in. Unknown identifiers and failed reads are ignored. */
    observe(identifier: string, resources: ServerResources | null): void {
        this.states.get(identifier)?.observe(resources);
    }

    getState(identifier: string): State | undefined {
        return this.states.get(identifier);
    }

    isComplete(identifier: string): boolean {
        return this.states.get(identifier)?.isComplete() ?? false;
    }

    /** Clears the given servers, or every tracked server when no identifiers are supplied. */
    flushState(identifiers?: string[]): void {
        if (!identifiers) {
            this.states.clear();
            return;
        }
        for (const identifier of identifiers) {
            this.states.delete(identifier);
        }
    }
}

export class State {
    readonly actionType: ActionType;
    readonly startingStatus: string;
    readonly startingUptime: number;
    readonly endingStatus: string;
    currentStatus: string;
    restartDetect = false;
    private leftStartingStatus = false;
    private uptimeReset = false;

    constructor(resources: ServerResources | null, actionType: ActionType) {
        this.actionType = actionType;
        this.startingStatus = resources?.attributes.current_state ?? '';
        this.startingUptime = resources?.attributes.resources.uptime ?? 0;
        this.currentStatus = this.startingStatus;
        this.endingStatus = actionType === 'stop' ? STATES.offline : STATES.running;
    }

    /**
     * A restart is detected two ways, because either can be the only one visible:
     * the state left the status it started in, or the uptime counter went backwards.
     * The second catches a restart that completed between two polls.
     */
    observe(resources: ServerResources | null): void {
        if (!resources) {
            return;
        }
        this.currentStatus = resources.attributes.current_state;
        if (this.currentStatus !== this.startingStatus) {
            this.leftStartingStatus = true;
        }
        if (resources.attributes.resources.uptime < this.startingUptime) {
            this.uptimeReset = true;
        }
        this.restartDetect = this.leftStartingStatus || this.uptimeReset;
    }

    isComplete(): boolean {
        if (this.currentStatus !== this.endingStatus) {
            return false;
        }
        return this.actionType !== 'restart' || this.restartDetect;
    }
}
