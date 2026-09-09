import { jest } from '@jest/globals';
import { pollServerAction, ACTION_TIMEOUT_MS } from '../../../../src/commands/pterodactyl/shared/poll_server_action.js';

describe('pollServerAction', () => {
    beforeEach(() => jest.useFakeTimers());
    afterEach(() => jest.useRealTimers());

    it('renders transitions and awaits completion', async () => {
        const readStates = jest
            .fn<() => Promise<Map<string, string>>>()
            .mockResolvedValueOnce(new Map([['server', 'starting']]))
            .mockResolvedValue(new Map([['server', 'running']]));
        const render = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
        let finished = false;
        const result = pollServerAction({
            action: 'start',
            identifiers: ['server'],
            signal: new AbortController().signal,
            readStates,
            render,
        }).then(() => {
            finished = true;
        });
        await jest.advanceTimersByTimeAsync(0);
        expect(render).toHaveBeenLastCalledWith('pending');
        expect(finished).toBe(false);
        await jest.advanceTimersByTimeAsync(500);
        await result;
        expect(render).toHaveBeenLastCalledWith('complete');
        expect(jest.getTimerCount()).toBe(0);
    });

    it('does not accept the original running state as restart completion', async () => {
        const readStates = jest
            .fn<() => Promise<Map<string, string>>>()
            .mockResolvedValueOnce(new Map([['server', 'running']]))
            .mockResolvedValueOnce(new Map([['server', 'stopping']]))
            .mockResolvedValue(new Map([['server', 'running']]));
        const render = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
        const result = pollServerAction({
            action: 'restart',
            identifiers: ['server'],
            signal: new AbortController().signal,
            readStates,
            render,
        });
        await jest.advanceTimersByTimeAsync(500);
        expect(render.mock.calls).toEqual([['pending'], ['pending']]);
        await jest.advanceTimersByTimeAsync(500);
        await result;
        expect(render).toHaveBeenLastCalledWith('complete');
    });

    it('reports timeout when restart completion cannot be confirmed', async () => {
        const render = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
        const result = pollServerAction({
            action: 'restart',
            identifiers: ['server'],
            signal: new AbortController().signal,
            readStates: async () => new Map([['server', 'running']]),
            render,
        });
        await jest.advanceTimersByTimeAsync(ACTION_TIMEOUT_MS);
        await result;
        expect(render).toHaveBeenLastCalledWith('timeout');
        expect(jest.getTimerCount()).toBe(0);
    });

    it('does not overlap slow reads or render results after cancellation', async () => {
        let resolveRead!: (states: Map<string, string>) => void;
        const readStates = jest.fn(
            () =>
                new Promise<Map<string, string>>((resolve) => {
                    resolveRead = resolve;
                })
        );
        const controller = new AbortController();
        const render = jest.fn<() => Promise<void>>();
        const result = pollServerAction({
            action: 'stop',
            identifiers: ['server'],
            signal: controller.signal,
            readStates,
            render,
        });
        await jest.advanceTimersByTimeAsync(2000);
        expect(readStates).toHaveBeenCalledTimes(1);
        controller.abort();
        resolveRead(new Map([['server', 'offline']]));
        await result;
        expect(render).not.toHaveBeenCalled();
        expect(jest.getTimerCount()).toBe(0);
    });
});
