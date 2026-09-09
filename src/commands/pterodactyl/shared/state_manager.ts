import { PterodactylServer, ServerResources } from './pterodactyl_api.js';

export enum STATES {
    offline = 'offline',
    starting = 'starting',
    running = 'running',
    stopping = 'stopping',
}

export type ActionType = 'start' | 'stop' | 'restart';

/**
 * Manage the state of servers and track updates
 * when using status controls.
 */
export class StateManager {
    private states = new Map<string, State>();

    newState(server: PterodactylServer, resources: ServerResources | null): void {
        this.states.set(server.attributes.identifier, new State(server, resources));
    }

    managedServers(): PterodactylServer[] {
        const servers: PterodactylServer[] = [];
        this.states.forEach((state) => servers.push(state.server));
        return servers;
    }

    targets(identifier: string): PterodactylServer[] {
        if (identifier === 'all') {
            return this.managedServers();
        }
        const state = this.states.get(identifier);
        return state ? [state.server] : [];
    }

    trackState(identifier: string, action: ActionType): void {
        this.states.get(identifier)?.track(action);
    }

    clearActions(targets: PterodactylServer[]): void {
        targets.forEach((target) => this.states.get(target.attributes.identifier)?.clearAction());
    }

    observeAll(resources: (ServerResources | null)[]): void {
        let index = 0;
        this.states.forEach((state) => state.observe(resources[index++]));
    }

    isComplete(identifier: string): boolean {
        return this.states.get(identifier)?.isComplete() ?? false;
    }

    isWatching(): boolean {
        return [...this.states.values()].some((state) => state.isWatched());
    }

    allComplete(): boolean {
        return [...this.states.values()].every((state) => !state.isWatched() || state.isComplete());
    }

    flushState(): void {
        this.states.clear();
    }
}

export class State {
    readonly server: PterodactylServer;

    readonly startingStatus: string;
    private currentStatus: string;
    private restartDetected = false;

    private currentUptime: number;
    private actionType: ActionType | undefined;

    constructor(server: PterodactylServer, resources: ServerResources | null) {
        this.server = server;
        this.startingStatus = resources?.attributes.current_state ?? '';
        this.currentStatus = this.startingStatus;
        this.currentUptime = resources?.attributes.resources.uptime ?? 0;
    }

    track(action: ActionType): void {
        this.actionType = action;
        this.restartDetected = false;
    }

    clearAction(): void {
        this.actionType = undefined;
    }

    isWatched(): boolean {
        return this.actionType !== undefined;
    }

    /** The uptime check catches a restart that began and finished between two polls. */
    observe(resources: ServerResources | null): void {
        if (!resources) {
            return;
        }
        const status = resources.attributes.current_state;
        const uptime = resources.attributes.resources.uptime;
        if (status !== this.startingStatus || uptime < this.currentUptime) {
            this.restartDetected = true;
        }
        this.currentStatus = status;
        this.currentUptime = uptime;
    }

    isComplete(): boolean {
        if (!this.actionType) {
            return false;
        }
        if (this.currentStatus !== (this.actionType === 'stop' ? STATES.offline : STATES.running)) {
            return false;
        }
        return this.actionType !== 'restart' || this.restartDetected;
    }
}
