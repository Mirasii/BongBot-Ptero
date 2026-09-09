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
const { Caller } = await import('@pookiesoft/bongbot-core');

// Create instance with mock dependencies
const caller = new Caller();
const serverStatusInstance = new ServerStatus(mockDb as any, caller as any, mockLogger);
const serverStatusExecute = serverStatusInstance.execute.bind(serverStatusInstance);
const setupCollector = serverStatusInstance.setupCollector.bind(serverStatusInstance);

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
                reply: jest.fn<() => Promise<void>>().mockResolvedValue(undefined),
                editReply: jest.fn<(options: any) => Promise<void>>().mockResolvedValue(undefined),
            };
        }

        function observeStates(states: string[]) {
            let index = 0;
            const originalGet = caller.get.bind(caller);
            jest.spyOn(caller, 'get').mockImplementation(async (...args) => {
                if (!args[1].endsWith('/resources')) return originalGet(...args);
                return {
                    attributes: {
                        current_state: states[Math.min(index++, states.length - 1)],
                        resources: { memory_bytes: 0, cpu_absolute: 0, disk_bytes: 0, uptime: 0 },
                    },
                };
            });
        }

        it.each([
            ['start', ['offline', 'starting', 'running']],
            ['stop', ['running', 'stopping', 'offline']],
            ['restart', ['running', 'stopping', 'offline', 'starting', 'running']],
        ])('renders observed %s transitions before enabling controls', async (action, states) => {
            observeStates(states);
            await setupCollector(mockInteraction, mockMessage);
            const component = actionInteraction(action);
            await finishAction(collectorCallbacks.collect(component));
            const updates = component.editReply.mock.calls
                .map(([options]) => options)
                .filter((options) => options.embeds);
            expect(
                updates.map((options) => options.embeds[0].data.fields[0].value.match(/Status:\*\* (\w+)/)[1])
            ).toEqual(states);
            for (const update of updates.slice(0, -1)) {
                expect(
                    update.components
                        .flatMap((row: any) => row.components)
                        .every((control: any) => control.data.disabled)
                ).toBe(true);
            }
            expect(updates.at(-1).embeds[0].data.description).toBe('Action completed.');
            expect(
                updates
                    .at(-1)
                    .components.flatMap((row: any) => row.components)
                    .every((control: any) => !control.data.disabled)
            ).toBe(true);
        });

        it('reports an unconfirmed restart and avoids duplicate pending edits', async () => {
            observeStates(['running']);
            await setupCollector(mockInteraction, mockMessage);
            const component = actionInteraction('restart');
            await finishAction(collectorCallbacks.collect(component));
            const updates = component.editReply.mock.calls
                .map(([options]) => options)
                .filter((options) => options.embeds);
            expect(updates).toHaveLength(2);
            expect(updates[1].embeds[0].data.description).toContain('Completion could not be confirmed');
            expect(jest.getTimerCount()).toBe(0);
        });

        it('rejects a second action and cancels pending polling when the collector ends', async () => {
            observeStates(['starting']);
            await setupCollector(mockInteraction, mockMessage);
            const component = actionInteraction('start');
            const pending = collectorCallbacks.collect(component);
            await jest.advanceTimersByTimeAsync(500);
            const second = actionInteraction('stop');
            await collectorCallbacks.collect(second);
            expect(second.reply).toHaveBeenCalledWith(
                expect.objectContaining({ content: expect.stringContaining('already in progress') })
            );
            expect(second.deferUpdate).not.toHaveBeenCalled();
            await collectorCallbacks.end();
            await pending;
            const edits = component.editReply.mock.calls.length;
            await jest.advanceTimersByTimeAsync(1000);
            expect(component.editReply).toHaveBeenCalledTimes(edits);
            expect(mockMessage.edit).toHaveBeenLastCalledWith({ components: [] });
            expect(jest.getTimerCount()).toBe(0);
        });

        it('awaits slow resource reads without overlap and discards their results after expiry', async () => {
            const originalGet = caller.get.bind(caller);
            let finishRead!: (value: unknown) => void;
            const resourceRead = jest.fn(
                () =>
                    new Promise((resolve) => {
                        finishRead = resolve;
                    })
            );
            jest.spyOn(caller, 'get').mockImplementation((...args) =>
                args[1].endsWith('/resources') ? resourceRead() : originalGet(...args)
            );
            await setupCollector(mockInteraction, mockMessage);
            const component = actionInteraction('start');
            let finished = false;
            const pending = collectorCallbacks.collect(component).then(() => {
                finished = true;
            });
            await jest.advanceTimersByTimeAsync(2000);
            expect(resourceRead).toHaveBeenCalledTimes(1);
            expect(finished).toBe(false);
            await collectorCallbacks.end();
            finishRead({ attributes: { current_state: 'running' } });
            await pending;
            expect(component.editReply).toHaveBeenCalledTimes(1);
            expect(mockMessage.edit).toHaveBeenLastCalledWith({ components: [] });
        });

        it('removes controls after an outstanding edit finishes on expiry', async () => {
            observeStates(['running']);
            await setupCollector(mockInteraction, mockMessage);
            const component = actionInteraction('start');
            let finishEdit!: () => void;
            component.editReply.mockImplementationOnce(
                () =>
                    new Promise<void>((resolve) => {
                        finishEdit = resolve;
                    })
            );
            const pending = collectorCallbacks.collect(component);
            await jest.advanceTimersByTimeAsync(0);
            const ending = collectorCallbacks.end();
            expect(mockMessage.edit).not.toHaveBeenCalled();
            finishEdit();
            await Promise.all([pending, ending]);
            expect(component.editReply).toHaveBeenCalledTimes(1);
            expect(mockMessage.edit).toHaveBeenLastCalledWith({ components: [] });
            expect(jest.getTimerCount()).toBe(0);
        });

        it('renders individual Stop All progress and preserves failed command details', async () => {
            const names = ['Fast', 'Slow', 'Failed'];
            const reads = [0, 0, 0];
            jest.spyOn(caller, 'get').mockImplementation(async (_url, path) => {
                if (path === '/api/client')
                    return {
                        data: names.map((name, index) => ({ attributes: { name, identifier: `server-${index}` } })),
                    };
                const index = Number(path.split('/')[4].slice(-1));
                const state = index === 0 || (index === 1 && reads[index]++ > 0) ? 'offline' : 'stopping';
                return { attributes: { current_state: state } };
            });
            jest.spyOn(caller, 'post').mockImplementation(async (_url, path) => {
                if (path.includes('server-2')) throw new Error('Command failed');
                return {};
            });
            await setupCollector(mockInteraction, mockMessage);
            const component = actionInteraction('stop');
            component.customId = 'server_control:1:all:stop';
            await finishAction(collectorCallbacks.collect(component));
            const updates = component.editReply.mock.calls
                .map(([options]) => options)
                .filter((options) => options.embeds);
            expect(updates).toHaveLength(2);
            expect(updates[0].embeds[0].data.fields.map((field: any) => field.value)).toEqual([
                expect.stringContaining('offline'),
                expect.stringContaining('stopping'),
                expect.stringContaining('stopping'),
            ]);
            expect(updates[1].embeds[0].data.description).toContain('Failed to stop 1 server(s): Failed');
            expect(updates[1].embeds[0].data.description).toContain('Action completed.');
            expect(jest.getTimerCount()).toBe(0);
        });

        it('should setup a collector with correct timeout', () => {
            setupCollector(mockInteraction, mockMessage);

            expect(mockMessage.createMessageComponentCollector).toHaveBeenCalledWith({
                time: 600000,
            });
        });

        it('should reject interactions from different users', async () => {
            setupCollector(mockInteraction, mockMessage);

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
            setupCollector(mockInteraction, mockMessage);

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
            setupCollector(mockInteraction, mockMessage);

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
            setupCollector(mockInteraction, mockMessage);

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
            setupCollector(mockInteraction, mockMessage);

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

            setupCollector(mockInteraction, mockMessage);

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

            setupCollector(mockInteraction, mockMessage);

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

            setupCollector(mockInteraction, mockMessage);

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

            setupCollector(mockInteraction, mockMessage);

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

            setupCollector(mockInteraction, mockMessage);

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
            setupCollector(mockInteraction, mockMessage);

            await collectorCallbacks['end']();

            expect(mockMessage.edit).toHaveBeenCalledWith({
                components: [],
            });
        });

        it('should handle message.edit rejection on collector end', async () => {
            const loggerSpy = jest.spyOn(mockLogger, 'error').mockImplementation(() => {});
            const editError = new Error('Failed to edit');
            mockMessage.edit = jest.fn<() => Promise<any>>().mockRejectedValue(editError);

            setupCollector(mockInteraction, mockMessage);

            await collectorCallbacks['end']();

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

            setupCollector(mockInteraction, testMockMessage);

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

            setupCollector(mockInteraction, testMockMessage);

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

            setupCollector(mockInteraction, testMockMessage);

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
            mockGetServerById
                .mockReturnValueOnce({
                    id: 1,
                    userId: 'test-user-123',
                    serverName: 'Test Server',
                    serverUrl: testServerUrl,
                    apiKey: 'test-api-key',
                })
                .mockReturnValueOnce(null);

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

            setupCollector(mockInteraction, testMockMessage);

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
                    content: expect.stringContaining('Failed to control server'),
                })
            );
        });

        it('should poll until state changes', async () => {
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

            setupCollector(mockInteraction, testMockMessage);

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

            await finishAction(collectPromise);

            expect(mockButtonInteraction.editReply).toHaveBeenCalled();
        });

        it('should handle poll timeout', async () => {
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

            setupCollector(mockInteraction, testMockMessage);

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

            await finishAction(collectPromise);

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

            setupCollector(mockInteraction, testMockMessage);

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

            await finishAction(collectPromise);

            expect(mockButtonInteraction.editReply).toHaveBeenCalled();
        });

        it('should handle refreshStatus error in catch block', async () => {
            mockGetServerById
                .mockReturnValueOnce({
                    id: 1,
                    userId: 'test-user-123',
                    serverName: 'Test Server',
                    serverUrl: testServerUrl,
                    apiKey: testApiKey,
                })
                .mockImplementation(() => {
                    throw new Error('Database connection failed');
                });

            server.use(
                http.post(`${testServerUrl}/api/client/servers/:identifier/power`, () => {
                    return HttpResponse.error();
                })
            );

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

            setupCollector(mockInteraction, testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:start',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest
                    .fn<() => Promise<undefined>>()
                    .mockResolvedValueOnce(undefined)
                    .mockRejectedValue(new Error('Edit failed')),
            };

            await finishAction(localCallbacks['collect'](mockButtonInteraction));

            expect(loggerSpy).toHaveBeenCalledWith(expect.any(Error));
            loggerSpy.mockRestore();
        });

        it('should handle unknown action in replyMessage lookup', async () => {
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
                                customId: 'server_control:1:server-123:unknown_action',
                            },
                        ],
                    },
                ],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            setupCollector(mockInteraction, testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:unknown_action',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            await finishAction(localCallbacks['collect'](mockButtonInteraction));

            expect(mockButtonInteraction.followUp).toHaveBeenCalledWith(
                expect.objectContaining({
                    content: 'Processing your request...',
                })
            );
        });

        it('should handle dbServer without id in component interaction', async () => {
            mockGetServerById.mockReturnValue({
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
                ],
                edit: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            } as unknown as Message;

            setupCollector(mockInteraction, testMockMessage);

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
                    content: '❌ Server configuration not found.',
                })
            );
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

            setupCollector(mockInteraction, testMockMessage);

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

            setupCollector(mockInteraction, testMockMessage);

            const mockSelectInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => true,
                values: [''],
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

            setupCollector(mockInteraction, testMockMessage);

            const mockButtonInteraction = {
                user: { id: 'test-user-123' },
                isStringSelectMenu: () => false,
                customId: 'server_control:1:server-123:restart',
                deferUpdate: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                followUp: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
                editReply: jest.fn<() => Promise<undefined>>().mockResolvedValue(undefined),
            };

            const collectPromise = localCallbacks['collect'](mockButtonInteraction);

            await jest.advanceTimersByTimeAsync(500);

            await finishAction(collectPromise);

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

            setupCollector(mockInteraction, testMockMessage);

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

            await finishAction(collectPromise);

            expect(mockButtonInteraction.editReply).toHaveBeenCalled();
        });
    });
});
