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

    attachState(server: PterodactylServer, resources: ServerResources | null): void {
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

    currentStates(servers: PterodactylServer[]): string[] {
        const states: string[] = [];
        servers.forEach((server) => states.push(this.states.get(server.attributes.identifier)?.getStatus() ?? ''));
        return states;
    }

    currentResources(): (ServerResources | null)[] {
        const states: (ServerResources | null)[] = [];
        this.states.forEach((state) => states.push(state.getResources()));
        return states;
    }

    trackState(identifier: string, action: ActionType): void {
        this.states.get(identifier)?.track(action);
    }

    clearActions(targets: PterodactylServer[]): void {
        targets.forEach((target) => this.states.get(target.attributes.identifier)?.clearAction());
    }

    observeAll(servers: PterodactylServer[], resources: (ServerResources | null)[]): void {
        servers.forEach((server, index) => this.states.get(server.attributes.identifier)?.observe(resources[index]));
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
    private resources: ServerResources | null;

    private startingStatus: string;
    private currentStatus: string;
    private restartDetected = false;

    private currentUptime: number;
    private actionType: ActionType | undefined;

    constructor(server: PterodactylServer, resources: ServerResources | null) {
        this.server = server;
        this.resources = resources;
        this.startingStatus = resources?.attributes.current_state ?? '';
        this.currentStatus = this.startingStatus;
        this.currentUptime = resources?.attributes.resources.uptime ?? 0;
    }

    getResources() {
        return this.resources;
    }

    getStatus() {
        return this.currentStatus;
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
        this.resources = resources;
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
