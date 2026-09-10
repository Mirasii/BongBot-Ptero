import { jest } from '@jest/globals';
import { createMockInteraction } from '../../utils/command_test_utils.js';

// Set allowed hosts for SSRF bypass
process.env.PTERODACTYL_ALLOWED_HOSTS = 'panel.example.com';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { Message } from 'discord.js';

const testServerUrl = 'https://panel.example.com';
const testApiKey = 'test-api-key';

const mockLogger = {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
} as any;

const handlers = [
    http.get(`${testServerUrl}/api/client`, () => {
        return HttpResponse.json({
            data: [
                {
                    attributes: {
                        identifier: 'server-123',
                        name: 'Test Server 1',
                        description: 'Test description',
                    },
                },
            ],
        });
    }),
    http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
        return HttpResponse.json({
            attributes: {
                current_state: 'running',
                resources: {
                    memory_bytes: 1073741824,
                    cpu_absolute: 50.5,
                    disk_bytes: 2147483648,
                    uptime: 3600000,
                },
            },
        });
    }),
    http.post(`${testServerUrl}/api/client/servers/:identifier/power`, () => {
        return HttpResponse.json({ success: true });
    }),
];

const server = setupServer(...handlers);

// Mock Database
const mockGetServersByUserId = jest.fn();
const mockGetServerById = jest.fn();
const mockDbClose = jest.fn();

const mockDb = {
    getServersByUserId: mockGetServersByUserId,
    getServerById: mockGetServerById,
    close: mockDbClose,
    addServer: jest.fn(),
};

// Mock @pookiesoft/bongbot-core
const mockBuildError = jest.fn<() => Promise<any>>();

jest.unstable_mockModule('@pookiesoft/bongbot-core', () => ({
    buildError: mockBuildError,
    Caller: class MockCaller {
        constructor(public allowedHosts: string[] = []) {}
        async validateServerSSRF(_url: string): Promise<void> {}
        async get(baseUrl: string, path: string, _?: null, headers?: Record<string, string>): Promise<any> {
            const response = await fetch(`${baseUrl}${path}`, { headers });
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        }
        async post(baseUrl: string, path: string, headers?: Record<string, string>, body?: any): Promise<any> {
            const response = await fetch(`${baseUrl}${path}`, { method: 'POST', headers, body: JSON.stringify(body) });
            if (!response.ok) throw new Error('Network response was not ok');
            return response.json();
        }
    },
}));

// Import after mocking and MSW setup
const { default: ServerStatus } = await import('../../../src/commands/pterodactyl/server_status.js');
const { StateManager } = await import('../../../src/commands/pterodactyl/shared/state_manager.js');
const { Caller } = await import('@pookiesoft/bongbot-core');

// Create instance with mock dependencies
const caller = new Caller();
let serverStatusExecute: ServerStatus['execute'];
let setupCollector: ServerStatus['setupCollector'];

// The action now resolves only when polling finishes, so tests must run the clock past the deadline.
async function finishAction(action: Promise<void>): Promise<void> {
    await jest.advanceTimersByTimeAsync(61000);
    await action;
}

describe('server_status command', () => {
    let mockInteraction: any;

    beforeAll(() => {
        server.listen({ onUnhandledRequest: 'bypass' });
        jest.useFakeTimers();
    });

    afterAll(() => {
        server.close();
        jest.useRealTimers();
    });

    afterEach(() => {
        server.resetHandlers(...handlers);
        jest.clearAllTimers();
        jest.restoreAllMocks();
    });

    beforeEach(() => {
        jest.clearAllMocks();

        // One manager per test, so no test inherits another's servers.
        const instance = new ServerStatus(mockDb as any, caller as any, mockLogger, new StateManager());
        serverStatusExecute = instance.execute.bind(instance);
        setupCollector = instance.setupCollector.bind(instance);

        jest.spyOn(console, 'error').mockImplementation(() => {});
        jest.spyOn(console, 'warn').mockImplementation(() => {});
        jest.spyOn(console, 'log').mockImplementation(() => {});

        const baseInteraction = createMockInteraction({
            commandName: 'server_status',
        });

        mockInteraction = {
            ...baseInteraction,
            user: {
                ...baseInteraction.user,
                id: 'test-user-123',
            },
            options: {
                getString: jest.fn((_key: string) => null),
                getSubcommand: jest.fn(() => 'manage'),
            },
        };

        mockGetServersByUserId.mockReturnValue([
            {
                id: 1,
                userId: 'test-user-123',
                serverName: 'My Server',
                serverUrl: testServerUrl,
                apiKey: testApiKey,
            },
        ]);

        mockGetServerById.mockReturnValue({
            id: 1,
            userId: 'test-user-123',
            serverName: 'My Server',
            serverUrl: testServerUrl,
            apiKey: testApiKey,
        });

        mockBuildError.mockResolvedValue({
            embeds: [],
            files: [],
            flags: 64,
            isError: true,
        });
    });

    // A panel attaches its servers when built, so collector tests open one first.
    async function openPanel(message: any): Promise<void> {
        await serverStatusExecute(mockInteraction);
        await setupCollector(mockInteraction, message);
    }

    describe('command methods', () => {
        it('should have a setupCollector method', () => {
            expect(setupCollector).toBeInstanceOf(Function);
        });
    });

    describe('execute method - single server users', () => {
        it('should return error if user has no registered servers', async () => {
            mockGetServersByUserId.mockReturnValue([]);

            await serverStatusExecute(mockInteraction);

            expect(mockGetServersByUserId).toHaveBeenCalledWith('test-user-123');
            expect(mockBuildError).toHaveBeenCalledWith(
                mockInteraction,
                expect.objectContaining({
                    message: expect.stringContaining('no registered servers'),
                })
            );
        });

        it('should return error if servers is null', async () => {
            mockGetServersByUserId.mockReturnValue(null);

            await serverStatusExecute(mockInteraction);

            expect(mockBuildError).toHaveBeenCalledWith(
                mockInteraction,
                expect.objectContaining({
                    message: expect.stringContaining('no registered servers'),
                })
            );
        });

        it('should fetch and display server status for single server user', async () => {
            const result: any = await serverStatusExecute(mockInteraction);

            expect(mockGetServersByUserId).toHaveBeenCalledWith('test-user-123');
            expect(result.embeds).toBeDefined();
            expect(result.embeds.length).toBe(1);

            const embed = result.embeds[0];
            expect(embed.data.title).toBe('🎮 Game Server Status');
            expect(embed.data.fields).toBeDefined();
            expect(embed.data.fields.length).toBeGreaterThan(0);
        });

        it('should include control components in response', async () => {
            const result: any = await serverStatusExecute(mockInteraction);

            expect(result.components).toBeDefined();
            expect(result.components.length).toBeGreaterThan(0);
        });
    });

    describe('execute method - multiple server users', () => {
        beforeEach(() => {
            mockGetServersByUserId.mockReturnValue([
                {
                    id: 1,
                    userId: 'test-user-123',
                    serverName: 'Server 1',
                    serverUrl: testServerUrl,
                    apiKey: testApiKey,
                },
                {
                    id: 2,
                    userId: 'test-user-123',
                    serverName: 'Server 2',
                    serverUrl: testServerUrl,
                    apiKey: testApiKey,
                },
            ]);
        });

        it('should require server_name parameter when user has multiple servers', async () => {
            mockInteraction.options.getString.mockReturnValue(null);

            await serverStatusExecute(mockInteraction);

            expect(mockBuildError).toHaveBeenCalledWith(
                mockInteraction,
                expect.objectContaining({
                    message: expect.stringMatching(/multiple.*servers/),
                })
            );
        });

        it('should work with server_name parameter', async () => {
            mockInteraction.options.getString.mockReturnValue('Server 1');

            const result: any = await serverStatusExecute(mockInteraction);

            expect(result.embeds).toBeDefined();
            expect(result.embeds[0].data.fields.length).toBeGreaterThan(0);
        });

        it('should return error for invalid server_name', async () => {
            mockInteraction.options.getString.mockReturnValue('Invalid Server');

            await serverStatusExecute(mockInteraction);

            expect(mockBuildError).toHaveBeenCalledWith(
                mockInteraction,
                expect.objectContaining({
                    message: expect.stringContaining('No server found'),
                })
            );
        });
    });

    describe('server state display', () => {
        it('should display running server with resource info', async () => {
            const result: any = await serverStatusExecute(mockInteraction);

            const fieldValue = result.embeds[0].data.fields[0].value;
            expect(fieldValue).toContain('running');
            expect(fieldValue).toContain('Memory');
            expect(fieldValue).toContain('CPU');
            expect(fieldValue).toContain('Uptime');
        });

        it('should display offline server without resource info', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    return HttpResponse.json({
                        attributes: {
                            current_state: 'offline',
                            resources: {
                                memory_bytes: 0,
                                cpu_absolute: 0,
                                disk_bytes: 0,
                                uptime: 0,
                            },
                        },
                    });
                })
            );

            const result: any = await serverStatusExecute(mockInteraction);

            const fieldValue = result.embeds[0].data.fields[0].value;
            expect(fieldValue).toContain('offline');
            expect(fieldValue).not.toContain('Memory');
        });

        it('should handle unknown server state', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    return HttpResponse.error();
                })
            );

            const result: any = await serverStatusExecute(mockInteraction);

            const fieldValue = result.embeds[0].data.fields[0].value;
            expect(fieldValue).toContain('unknown');
        });
    });

    describe('error handling', () => {
        it('should handle database error', async () => {
            mockGetServersByUserId.mockImplementation(() => {
                throw new Error('Database error');
            });

            await serverStatusExecute(mockInteraction);

            expect(mockBuildError).toHaveBeenCalled();
        });

        it('should handle network errors', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client`, () => {
                    return HttpResponse.error();
                })
            );

            await serverStatusExecute(mockInteraction);

            expect(mockBuildError).toHaveBeenCalled();
        });

        it('should handle empty server list', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client`, () => {
                    return HttpResponse.json({ data: [] });
                })
            );

            const result: any = await serverStatusExecute(mockInteraction);

            expect(result.embeds).toBeDefined();
            const fields = result.embeds[0].data.fields;
            expect(fields === undefined || fields.length === 0).toBe(true);
        });
    });

    describe('helper functions - formatting', () => {
        it('should format bytes correctly', async () => {
            const result: any = await serverStatusExecute(mockInteraction);

            const fieldValue = result.embeds[0].data.fields[0].value;
            expect(fieldValue).toContain('1024');
        });

        it('should format CPU percentage correctly', async () => {
            const result: any = await serverStatusExecute(mockInteraction);

            const fieldValue = result.embeds[0].data.fields[0].value;
            expect(fieldValue).toContain('50.5');
        });

        it('should format uptime in hours and minutes', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    return HttpResponse.json({
                        attributes: {
                            current_state: 'running',
                            resources: {
                                memory_bytes: 1073741824,
                                cpu_absolute: 50.5,
                                disk_bytes: 2147483648,
                                uptime: 7260000,
                            },
                        },
                    });
                })
            );

            const result: any = await serverStatusExecute(mockInteraction);

            const fieldValue = result.embeds[0].data.fields[0].value;
            expect(fieldValue).toMatch(/2h.*1m/);
        });
    });

    describe('status emojis', () => {
        it('should show green circle for running state', async () => {
            const result: any = await serverStatusExecute(mockInteraction);
            expect(result.embeds[0].data.fields[0].value).toContain('🟢');
        });

        it('should show red circle for offline state', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    return HttpResponse.json({
                        attributes: {
                            current_state: 'offline',
                            resources: {
                                memory_bytes: 0,
                                cpu_absolute: 0,
                                disk_bytes: 0,
                                uptime: 0,
                            },
                        },
                    });
                })
            );

            const result: any = await serverStatusExecute(mockInteraction);
            expect(result.embeds[0].data.fields[0].value).toContain('🔴');
        });

        it('should show yellow circle for starting state', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    return HttpResponse.json({
                        attributes: {
                            current_state: 'starting',
                            resources: {
                                memory_bytes: 0,
                                cpu_absolute: 0,
                                disk_bytes: 0,
                                uptime: 0,
                            },
                        },
                    });
                })
            );

            const result: any = await serverStatusExecute(mockInteraction);
            expect(result.embeds[0].data.fields[0].value).toContain('🟡');
        });
    });

    describe('setupCollector method', () => {
        let mockMessage: any;
        let collectorCallbacks: any;

        beforeEach(() => {
            collectorCallbacks = {};
            mockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        collectorCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 2,
                                customId: 'server_control:1:server-123:stop',
                            },
                        ],
                    },
                ],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };
        });

        function actionInteraction(action: string) {
            return {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: `server_control:1:server-123:${action}`,
                deferUpdate: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
                editReply: jest.fn<(options: any) => Promise<void>>().mockResolvedValue(undefined),
            };
        }

        // Stubbed at the caller, not MSW, which runs a resolver more than once per request.
        // Observations are consumed in order, one per polled server per poll.
        function serveObservations(observations: { state: string | null; uptime?: number }[]) {
            let index = 0;
            const originalGet = caller.get.bind(caller);
            jest.spyOn(caller, 'get').mockImplementation(async (...args: any[]) => {
                if (!String(args[1]).endsWith('/resources')) return originalGet(...(args as [any, any, any, any]));
                const observation = observations[Math.min(index++, observations.length - 1)];
                if (observation.state === null) throw new Error('Panel unavailable');
                return {
                    attributes: {
                        current_state: observation.state,
                        resources: {
                            memory_bytes: 0,
                            cpu_absolute: 0,
                            disk_bytes: 0,
                            uptime: observation.uptime ?? 0,
                        },
                    },
                };
            });
        }

        function renderedStates(component: ReturnType<typeof actionInteraction>) {
            return component.editReply.mock.calls
                .map(([options]: any[]) => options)
                .filter((options: any) => options.embeds)
                .map((options: any) => ({
                    state: options.embeds[0].data.fields[0].value.match(/Status:\*\* (\w+)/)[1],
                    description: options.embeds[0].data.description,
                }));
        }

        it('renders each observed transition while a start is in progress', async () => {
            // The first reading builds the panel, the second re-baselines the target just
            // before the power command, and the rest are polled.
            serveObservations([
                { state: 'offline' },
                { state: 'offline' },
                { state: 'offline' },
                { state: 'starting' },
                { state: 'running', uptime: 1000 },
            ]);
            await openPanel(mockMessage);
            const component = actionInteraction('start');

            await finishAction(collectorCallbacks['collect'](component));

            const renders = renderedStates(component);
            expect(renders.map((render) => render.state)).toEqual(['offline', 'starting', 'running']);
            expect(renders.at(-1)?.description).toBe('✅ Action complete.');
        });

        it('rebuilds the panel when it is holding no servers for the action', async () => {
            // A collector set up without the panel that built it: the action has to fetch the
            // servers back before it can command anything.
            serveObservations([
                { state: 'offline' },
                { state: 'offline' },
                { state: 'starting' },
                { state: 'running', uptime: 1000 },
            ]);
            await setupCollector(mockInteraction, mockMessage);
            const component = actionInteraction('start');

            await finishAction(collectorCallbacks['collect'](component));

            const renders = renderedStates(component);
            expect(renders.map((render) => render.state)).toEqual(['offline', 'starting', 'running']);
            expect(renders.at(-1)?.description).toBe('✅ Action complete.');
        });

        it('completes a restart detected by the state leaving running', async () => {
            // Uptime climbs throughout, so only the observed transition proves the restart.
            serveObservations([
                { state: 'running', uptime: 500000 },
                { state: 'running', uptime: 500250 },
                { state: 'running', uptime: 500500 },
                { state: 'stopping', uptime: 501000 },
                { state: 'running', uptime: 502000 },
            ]);
            await openPanel(mockMessage);
            const component = actionInteraction('restart');

            await finishAction(collectorCallbacks['collect'](component));

            const renders = renderedStates(component);
            expect(renders.map((render) => render.state)).toEqual(['running', 'stopping', 'running']);
            expect(renders.at(-1)?.description).toBe('✅ Action complete.');
        });

        it('completes a restart detected by the uptime resetting', async () => {
            // The server went down and came back between polls, so the status never changes.
            serveObservations([
                { state: 'running', uptime: 500000 },
                { state: 'running', uptime: 500500 },
                { state: 'running', uptime: 1200 },
            ]);
            await openPanel(mockMessage);
            const component = actionInteraction('restart');

            await finishAction(collectorCallbacks['collect'](component));

            expect(renderedStates(component).at(-1)?.description).toBe('✅ Action complete.');
        });

        it('does not let a previous restart complete the next one', async () => {
            // The second restart re-baselines against the low uptime the first one left behind, so
            // the first restart's evidence cannot carry the second.
            serveObservations([
                { state: 'running', uptime: 500000 },
                { state: 'running', uptime: 500500 },
                { state: 'stopping', uptime: 0 },
                { state: 'running', uptime: 2000 },
                { state: 'running', uptime: 2500 },
                { state: 'running', uptime: 3000 },
                { state: 'stopping', uptime: 0 },
                { state: 'running', uptime: 1000 },
            ]);
            await openPanel(mockMessage);

            const first = actionInteraction('restart');
            await finishAction(collectorCallbacks['collect'](first));
            expect(renderedStates(first).at(-1)?.description).toBe('✅ Action complete.');

            const second = actionInteraction('restart');
            await finishAction(collectorCallbacks['collect'](second));

            const renders = renderedStates(second);
            expect(renders[0].description).toContain('Restarting');
            expect(renders.map((render) => render.state)).toEqual(['running', 'stopping', 'running']);
            expect(renders.at(-1)?.description).toBe('✅ Action complete.');
        });

        it('stops watching after the deadline when no restart can be confirmed', async () => {
            serveObservations([
                { state: 'running', uptime: 500000 },
                { state: 'running', uptime: 500500 },
            ]);
            await openPanel(mockMessage);
            const component = actionInteraction('restart');

            await finishAction(collectorCallbacks['collect'](component));

            expect(renderedStates(component).at(-1)?.description).toContain('Stopped watching after 60 seconds');
            expect(jest.getTimerCount()).toBe(0);
        });

        it('re-enables controls only once the action is finished', async () => {
            serveObservations([
                { state: 'offline' },
                { state: 'offline' },
                { state: 'starting' },
                { state: 'running', uptime: 1000 },
            ]);
            await openPanel(mockMessage);
            const component = actionInteraction('start');

            await finishAction(collectorCallbacks['collect'](component));

            const updates = component.editReply.mock.calls
                .map(([options]: any[]) => options)
                .filter((options: any) => options.embeds);
            const disabledFlags = updates.map((options: any) =>
                options.components
                    .flatMap((row: any) => row.components)
                    .every((control: any) => control.data.disabled === true)
            );
            expect(disabledFlags.slice(0, -1).every(Boolean)).toBe(true);
            expect(disabledFlags.at(-1)).toBe(false);
        });

        it('restores the live status when an action fails part way through', async () => {
            mockGetServerById.mockImplementationOnce(() => {
                throw new Error('Database unavailable');
            });
            await openPanel(mockMessage);
            const component = actionInteraction('start');

            await finishAction(collectorCallbacks['collect'](component));

            expect(component.followUp).toHaveBeenCalledWith(
                expect.objectContaining({ content: '❌ An error occurred processing your request.' })
            );
            const recovery = component.editReply.mock.calls.at(-1)?.[0] as any;
            expect(recovery.embeds[0].data.description).toContain('Last updated');
            expect(
                recovery.components
                    .flatMap((row: any) => row.components)
                    .every((control: any) => control.data.disabled === true)
            ).toBe(false);
        });

        it('keeps polling through a failed resource read', async () => {
            serveObservations([
                { state: 'offline' },
                { state: 'offline' },
                { state: null },
                { state: 'running', uptime: 1000 },
            ]);
            await openPanel(mockMessage);
            const component = actionInteraction('start');

            await finishAction(collectorCallbacks['collect'](component));

            const renders = renderedStates(component);
            expect(renders.map((render) => render.state)).toEqual(['unknown', 'running']);
            expect(renders.at(-1)?.description).toBe('✅ Action complete.');
        });

        it('should setup a collector with correct timeout', async () => {
            await openPanel(mockMessage);

            expect(mockMessage.createMessageComponentCollector).toHaveBeenCalledWith({
                time: 600000,
            });
        });

        it('should reject interactions from different users', async () => {
            await openPanel(mockMessage);

            const mockComponentInteraction = {
                user: { id: 'different-user' },
                reply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(collectorCallbacks['collect'](mockComponentInteraction));

            expect(mockComponentInteraction.reply).toHaveBeenCalledWith({
                content: '❌ You cannot control servers for another user.',
                ephemeral: true,
            });
        });

        it('should handle button interaction with stop action', async () => {
            await openPanel(mockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:stop',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(collectorCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.deferUpdate).toHaveBeenCalled();
            expect(mockButtonInteraction.followUp).toHaveBeenCalled();
        });

        it('should handle select menu interaction with start action', async () => {
            await openPanel(mockMessage);

            const mockSelectInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => true,
                values: ['1:server-123:start'],
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(collectorCallbacks['collect'](mockSelectInteraction));

            expect(mockSelectInteraction.deferUpdate).toHaveBeenCalled();
            expect(mockSelectInteraction.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Starting'),
                })
            );
        });

        it('should handle restart action', async () => {
            await openPanel(mockMessage);

            const mockInteraction2 = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:restart',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(collectorCallbacks['collect'](mockInteraction2));

            expect(mockInteraction2.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Restarting'),
                })
            );
        });

        it('should handle stop all action', async () => {
            await openPanel(mockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:all:stop',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(collectorCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Stopping all servers'),
                })
            );
        });

        it('should handle stop all with partial failures', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client`, () => {
                    return HttpResponse.json({
                        data: [
                            { attributes: { identifier: 'server-1', name: 'Server 1', description: '' } },
                            { attributes: { identifier: 'server-2', name: 'Server 2', description: '' } },
                            { attributes: { identifier: 'server-3', name: 'Server 3', description: '' } },
                        ],
                    });
                })
            );

            let callCount = 0;
            server.use(
                http.post(`${testServerUrl}/api/client/servers/:identifier/power`, () => {
                    callCount++;
                    if (callCount === 2) {
                        return new HttpResponse(null, { status: 500 });
                    }
                    return HttpResponse.json({ success: true });
                })
            );

            await openPanel(mockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:all:stop',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(collectorCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Failed to stop'),
                    ephemeral: true,
                })
            );
        });

        it('should handle stop all when all servers fail', async () => {
            server.use(
                http.post(`${testServerUrl}/api/client/servers/:identifier/power`, () => {
                    return new HttpResponse(null, { status: 500 });
                })
            );

            await openPanel(mockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:all:stop',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(collectorCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Failed to stop 1 server'),
                    ephemeral: true,
                })
            );
        });

        it('should handle server command failure', async () => {
            server.use(
                http.post(`${testServerUrl}/api/client/servers/:identifier/power`, () => {
                    return new HttpResponse(null, { status: 500 });
                })
            );

            await openPanel(mockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:start',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(collectorCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Failed to control server'),
                })
            );
        });

        it('should handle database server not found', async () => {
            mockGetServerById.mockReturnValue(null);

            await openPanel(mockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:999:server-123:start',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(collectorCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: '❌ Server configuration not found.',
                })
            );
        });

        it('should handle collector error gracefully', async () => {
            mockGetServerById.mockImplementation(() => {
                throw new Error('Database error');
            });

            await openPanel(mockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:start',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(collectorCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('error occurred'),
                })
            );
        });

        it('should clear components when collector ends', async () => {
            await openPanel(mockMessage);

            collectorCallbacks['end']();

            expect(mockMessage.edit).toHaveBeenCalledWith({
                components: [],
            });
        });

        it('should handle message.edit rejection on collector end', async () => {
            const loggerSpy = jest.spyOn(mockLogger, 'error').mockImplementation(() => {});
            const editError = new Error('Failed to edit');
            mockMessage.edit = jest.fn<() => Promise<any>>().mockRejectedValue(editError);

            await openPanel(mockMessage);

            collectorCallbacks['end']();

            await jest.runAllTimersAsync();

            expect(loggerSpy).toHaveBeenCalledWith(editError, mockInteraction);
            loggerSpy.mockRestore();
        });

        it('should handle unknown component type when disabling components', async () => {
            mockGetServerById.mockReturnValue({
                id: 1,
                userId: 'test-user-123',
                serverName: 'Test Server',
                serverUrl: testServerUrl,
                apiKey: testApiKey,
            });

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 2,
                                customId: 'server_control:1:server-123:stop',
                            },
                        ],
                    },
                    {
                        components: [
                            {
                                type: 99,
                                customId: 'unknown_component',
                            },
                        ],
                    },
                ],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            await openPanel(testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:stop',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(localCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.editReply).toHaveBeenCalled();
        });
    });

    describe('dependency injection', () => {
        it('should use the injected database', async () => {
            await serverStatusExecute(mockInteraction);

            expect(mockGetServersByUserId).toHaveBeenCalledWith('test-user-123');
        });
    });

    describe('edge cases and error paths', () => {
        it('should handle fetchServers error when response not ok', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client`, () => {
                    return new HttpResponse(null, { status: 500, statusText: 'Internal Server Error' });
                })
            );

            await serverStatusExecute(mockInteraction);

            expect(mockBuildError).toHaveBeenCalledWith(
                mockInteraction,
                expect.objectContaining({
                    message: expect.stringContaining('Network response was not ok'),
                })
            );
        });

        it('should handle fetchServerResources returning null when response not ok', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    return new HttpResponse(null, { status: 404 });
                })
            );

            const result: any = await serverStatusExecute(mockInteraction);

            expect(result.embeds).toBeDefined();
            expect(result.embeds[0].data.fields[0].value).toContain('unknown');
        });

        it('should handle sendServerCommand catch block', async () => {
            server.use(
                http.post(`${testServerUrl}/api/client/servers/:identifier/power`, () => {
                    return HttpResponse.error();
                })
            );

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 2,
                                customId: 'server_control:1:server-123:stop',
                            },
                        ],
                    },
                ],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            await openPanel(testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:start',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(localCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('Failed to control server'),
                })
            );
        });

        it('should handle uptime less than 1 hour', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    return HttpResponse.json({
                        attributes: {
                            current_state: 'running',
                            resources: {
                                memory_bytes: 1024000000,
                                cpu_absolute: 45.5,
                                disk_bytes: 5000000000,
                                uptime: 1800000,
                            },
                        },
                    });
                })
            );

            const result: any = await serverStatusExecute(mockInteraction);

            const fieldValue = result.embeds[0].data.fields[0].value;
            expect(fieldValue).toContain('30m');
            expect(fieldValue).not.toContain('h');
        });

        it('should show stopping emoji for stopping state', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    return HttpResponse.json({
                        attributes: {
                            current_state: 'stopping',
                            resources: {
                                memory_bytes: 512000000,
                                cpu_absolute: 10.0,
                                disk_bytes: 1000000000,
                                uptime: 600000,
                            },
                        },
                    });
                })
            );

            const result: any = await serverStatusExecute(mockInteraction);
            expect(result.embeds[0].data.fields[0].value).toContain('🟠');
        });

        it('should handle StringSelectMenu when disabling components', async () => {
            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 3,
                                customId: 'server_control:1:menu0',
                            },
                        ],
                    },
                ],
            } as unknown as Message;

            await openPanel(testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:stop',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(localCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.editReply).toHaveBeenCalled();
        });

        it('should handle refreshStatus when dbServer is null', async () => {
            // The action fails, so recovery runs and finds the server no longer registered.
            mockGetServerById.mockImplementationOnce(() => {
                throw new Error('Database unavailable');
            });
            mockGetServerById.mockReturnValue(null);

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 2,
                                customId: 'server_control:1:server-123:stop',
                            },
                        ],
                    },
                ],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            await openPanel(testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:stop',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(localCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.deferUpdate).toHaveBeenCalled();
            expect(mockButtonInteraction.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('An error occurred'),
                })
            );
            // Recovery found no server row, so it returned without editing the message again.
            expect(mockButtonInteraction.editReply).toHaveBeenCalledTimes(1);
        });

        it('should poll until state changes with setInterval', async () => {
            let callCount = 0;
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    callCount++;
                    if (callCount < 3) {
                        return HttpResponse.json({
                            attributes: {
                                current_state: 'starting',
                                resources: {
                                    memory_bytes: 512000000,
                                    cpu_absolute: 10.0,
                                    disk_bytes: 1000000000,
                                    uptime: 0,
                                },
                            },
                        });
                    }
                    return HttpResponse.json({
                        attributes: {
                            current_state: 'running',
                            resources: {
                                memory_bytes: 512000000,
                                cpu_absolute: 10.0,
                                disk_bytes: 1000000000,
                                uptime: 600000,
                            },
                        },
                    });
                })
            );

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 2,
                                customId: 'server_control:1:server-123:stop',
                            },
                        ],
                    },
                ],
            } as unknown as Message;

            await openPanel(testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:start',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            const collectPromise = localCallbacks['collect'](mockButtonInteraction);

            await jest.advanceTimersByTimeAsync(500);
            await jest.advanceTimersByTimeAsync(500);
            await jest.advanceTimersByTimeAsync(500);

            await collectPromise;

            expect(mockButtonInteraction.editReply).toHaveBeenCalled();
        });

        it('should handle poll timeout (max attempts reached)', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    return HttpResponse.json({
                        attributes: {
                            current_state: 'starting',
                            resources: {
                                memory_bytes: 512000000,
                                cpu_absolute: 10.0,
                                disk_bytes: 1000000000,
                                uptime: 0,
                            },
                        },
                    });
                })
            );

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 2,
                                customId: 'server_control:1:server-123:stop',
                            },
                        ],
                    },
                ],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            await openPanel(testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:start',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            const collectPromise = localCallbacks['collect'](mockButtonInteraction);

            for (let i = 0; i < 125; i++) {
                await jest.advanceTimersByTimeAsync(500);
            }

            await collectPromise;

            expect(mockButtonInteraction.editReply).toHaveBeenCalled();
        });

        it('should handle poll with null resource response', async () => {
            let fetchCount = 0;
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    fetchCount++;
                    if (fetchCount < 3) {
                        return HttpResponse.error();
                    }
                    return HttpResponse.json({
                        attributes: {
                            current_state: 'running',
                            resources: {
                                memory_bytes: 512000000,
                                cpu_absolute: 10.0,
                                disk_bytes: 1000000000,
                                uptime: 600000,
                            },
                        },
                    });
                })
            );

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 2,
                                customId: 'server_control:1:server-123:stop',
                            },
                        ],
                    },
                ],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            await openPanel(testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:start',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            const collectPromise = localCallbacks['collect'](mockButtonInteraction);

            await jest.advanceTimersByTimeAsync(500);
            await jest.advanceTimersByTimeAsync(500);
            await jest.advanceTimersByTimeAsync(500);

            await collectPromise;

            expect(mockButtonInteraction.editReply).toHaveBeenCalled();
        });

        it('should handle refreshStatus error in catch block', async () => {
            const loggerSpy = jest.spyOn(mockLogger, 'error').mockImplementation(() => {});

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 2,
                                customId: 'server_control:1:server-123:stop',
                            },
                        ],
                    },
                ],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            await openPanel(testMockMessage);

            // The action fails, and by the time recovery runs the panel is unreachable too.
            mockGetServerById.mockImplementationOnce(() => {
                throw new Error('Database unavailable');
            });
            server.use(
                http.get(`${testServerUrl}/api/client`, () => {
                    return HttpResponse.error();
                })
            );

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:start',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(localCallbacks['collect'](mockButtonInteraction));

            expect(loggerSpy).toHaveBeenCalledWith(expect.any(Error));
            loggerSpy.mockRestore();
        });

        it('should return early from setupCollector if subcommand is not manage', () => {
            const nonManageInteraction = {
                ...mockInteraction,
                options: {
                    getString: jest.fn((_key: string) => null),
                    getSubcommand: jest.fn(() => 'list'),
                },
            };

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            setupCollector(nonManageInteraction, testMockMessage);

            expect(testMockMessage.createMessageComponentCollector).not.toHaveBeenCalled();
        });

        it('should handle followUp error in catch block silently', async () => {
            mockGetServerById.mockImplementation(() => {
                throw new Error('Database error');
            });

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 2,
                                customId: 'server_control:1:server-123:stop',
                            },
                        ],
                    },
                ],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            await openPanel(testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:start',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest
                    .fn<() => Promise<any>>()
                    .mockResolvedValueOnce(undefined)
                    .mockRejectedValueOnce(new Error('followUp failed')),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await expect(finishAction(localCallbacks['collect'](mockButtonInteraction))).resolves.not.toThrow();
        });

        it('should handle error with undefined dbServerId (no refreshStatus call)', async () => {
            mockGetServerById.mockImplementation(() => {
                throw new Error('DB error before id set');
            });

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            await openPanel(testMockMessage);

            const mockSelectInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => true,
                values: [':server-123:stop'],
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(localCallbacks['collect'](mockSelectInteraction));

            expect(mockSelectInteraction.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: expect.stringContaining('error occurred'),
                })
            );
        });

        it('should handle refreshStatus with running server and resource state', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    return HttpResponse.json({
                        attributes: {
                            current_state: 'running',
                            resources: {
                                memory_bytes: 512000000,
                                cpu_absolute: 25.0,
                                disk_bytes: 1000000000,
                                uptime: 3600000,
                            },
                        },
                    });
                })
            );

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 2,
                                customId: 'server_control:1:server-123:restart',
                            },
                        ],
                    },
                ],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            await openPanel(testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:restart',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(localCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.editReply).toHaveBeenCalled();
        });

        it('should handle refreshStatus with non-running server state', async () => {
            server.use(
                http.get(`${testServerUrl}/api/client/servers/:identifier/resources`, () => {
                    return HttpResponse.json({
                        attributes: {
                            current_state: 'offline',
                            resources: {
                                memory_bytes: 0,
                                cpu_absolute: 0,
                                disk_bytes: 0,
                                uptime: 0,
                            },
                        },
                    });
                })
            );

            const localCallbacks: any = {};
            const testMockMessage = {
                createMessageComponentCollector: jest.fn().mockReturnValue({
                    on: jest.fn((event: string, callback: any) => {
                        localCallbacks[event] = callback;
                    }),
                }),
                components: [
                    {
                        components: [
                            {
                                type: 2,
                                customId: 'server_control:1:server-123:stop',
                            },
                        ],
                    },
                ],
                edit: jest
                    .fn<() => Promise<Message<boolean>>>()
                    .mockResolvedValue(undefined as unknown as Message<boolean>),
            } as unknown as Message;

            await openPanel(testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:stop',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            const collectPromise = localCallbacks['collect'](mockButtonInteraction);

            await jest.advanceTimersByTimeAsync(500);

            await collectPromise;

            expect(mockButtonInteraction.editReply).toHaveBeenCalled();
        });
    });
});
