export const ACTION_POLL_INTERVAL_MS = 500;
export const ACTION_TIMEOUT_MS = 60000;

type PollOutcome = 'pending' | 'complete' | 'timeout';

interface ActionPolling {
    action: string;
    identifiers: string[];
    signal: AbortSignal;
    readStates: () => Promise<Map<string, string | undefined>>;
    render: (outcome: PollOutcome) => Promise<void>;
}

export async function pollServerAction(polling: ActionPolling): Promise<void> {
    const deadline = Date.now() + ACTION_TIMEOUT_MS;
    const transitioned = new Set<string>();
    const expectedState = polling.action === 'stop' ? 'offline' : 'running';

    while (!polling.signal.aborted) {
        const states = await polling.readStates();
        if (polling.signal.aborted) return;

        const complete = polling.identifiers.every((identifier) => {
            const state = states.get(identifier);
            if (state && state !== 'running' && state !== 'unknown') transitioned.add(identifier);
            return state === expectedState && (polling.action !== 'restart' || transitioned.has(identifier));
        });
        const outcome = complete ? 'complete' : Date.now() >= deadline ? 'timeout' : 'pending';
        await polling.render(outcome);
        if (outcome !== 'pending' || polling.signal.aborted) return;
        await waitForPoll(Math.min(ACTION_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())), polling.signal);
    }
}

function waitForPoll(delay: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, delay);
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
    });
}
