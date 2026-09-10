import { jest } from '@jest/globals';
import { ChatInputCommandInteraction, Message } from 'discord.js';

// Mock @pookiesoft/bongbot-core
jest.unstable_mockModule('@pookiesoft/bongbot-core', () => ({
    Caller: jest.fn().mockImplementation(() => ({})),
    LOGGER: { default: { info: jest.fn(), debug: jest.fn(), error: jest.fn() } },
    buildError: jest.fn(),
}));

// Mock the database pool
const mockGetConnection = jest.fn().mockReturnValue({
    getServersByUserId: jest.fn(),
    getServerById: jest.fn(),
    addServer: jest.fn(),
    updateServer: jest.fn(),
    deleteServer: jest.fn(),
    close: jest.fn(),
});

jest.unstable_mockModule('../../../src/services/database_pool.js', () => ({
    default: {
        getInstance: jest.fn().mockReturnValue({
            getConnection: mockGetConnection,
        }),
    },
}));

// Mock the subcommand modules as classes
const mockRegisterExecute = jest.fn<() => Promise<any>>();
const mockListExecute = jest.fn<() => Promise<any>>();
const mockServerStatusExecute = jest.fn<() => Promise<any>>();
const mockUpdateExecute = jest.fn<() => Promise<any>>();
const mockRemoveExecute = jest.fn<() => Promise<any>>();
const mockSetupCollector = jest.fn<() => Promise<any>>();
const constructedWith: unknown[] = [];

jest.unstable_mockModule('../../../src/commands/pterodactyl/register_server.js', () => ({
    default: class MockRegisterServer {
        execute = mockRegisterExecute;
    },
}));

jest.unstable_mockModule('../../../src/commands/pterodactyl/list_servers.js', () => ({
    default: class MockListServers {
        execute = mockListExecute;
    },
}));

jest.unstable_mockModule('../../../src/commands/pterodactyl/server_status.js', () => ({
    default: class MockServerStatus {
        constructor(_db: unknown, _caller: unknown, _logger: unknown, stateManager: unknown) {
            constructedWith.push(stateManager);
        }
        execute = mockServerStatusExecute;
        setupCollector = mockSetupCollector;
    },
}));

jest.unstable_mockModule('../../../src/commands/pterodactyl/update_server.js', () => ({
    default: class MockUpdateServer {
        execute = mockUpdateExecute;
    },
}));

jest.unstable_mockModule('../../../src/commands/pterodactyl/remove_server.js', () => ({
    default: class MockRemoveServer {
        execute = mockRemoveExecute;
    },
}));

const masterModule = await import('../../../src/commands/pterodactyl/master.js');
const pterodactylCommand = masterModule.default;

describe('pterodactyl master command', () => {
    it('should export a command object', () => {
        expect(pterodactylCommand).toBeDefined();
        expect(typeof pterodactylCommand).toBe('object');
    });

    it('should have data property with SlashCommandBuilder', () => {
        expect(pterodactylCommand.data).toBeDefined();
        expect(pterodactylCommand.data.constructor.name).toBe('SlashCommandBuilder');
    });

    it('should have command name "pterodactyl"', () => {
        expect(pterodactylCommand.data.name).toBe('pterodactyl');
    });

    it('should have a description', () => {
        expect(pterodactylCommand.data.description).toBeTruthy();
        expect(pterodactylCommand.data.description).toContain('Pterodactyl');
    });

    it('should have execute method', () => {
        expect(pterodactylCommand.execute).toBeInstanceOf(Function);
    });

    it('should have setupCollector method', () => {
        expect(typeof pterodactylCommand.setupCollector).toBe('function');
    });

    it('should call setupCollector and delegate to ServerStatus', () => {
        const mockInteraction = {
            options: {
                getSubcommand: jest.fn(),
            },
        } as unknown as ChatInputCommandInteraction;
        const mockMessage = {
            createMessageComponentCollector: jest.fn().mockReturnValue({
                on: jest.fn(),
            }),
        } as unknown as Message;

        pterodactylCommand.setupCollector(mockInteraction, mockMessage);

        expect(mockSetupCollector).toHaveBeenCalledWith(mockInteraction, mockMessage);
    });

    it('gives a panel one state manager across execute and setupCollector', async () => {
        constructedWith.length = 0;
        const panel = {
            options: { getSubcommand: jest.fn(() => 'manage') },
        } as unknown as ChatInputCommandInteraction;
        const mockMessage = {
            createMessageComponentCollector: jest.fn().mockReturnValue({ on: jest.fn() }),
        } as unknown as Message;

        await pterodactylCommand.execute(panel);
        pterodactylCommand.setupCollector(panel, mockMessage);

        expect(constructedWith[0]).toBe(constructedWith[1]);

        const otherPanel = {
            options: { getSubcommand: jest.fn(() => 'manage') },
        } as unknown as ChatInputCommandInteraction;
        await pterodactylCommand.execute(otherPanel);

        expect(constructedWith[2]).not.toBe(constructedWith[0]);
    });

    it('should have fullDesc property', () => {
        expect(pterodactylCommand.fullDesc).toBeDefined();
        expect(pterodactylCommand.fullDesc.description).toBeTruthy();
        expect(pterodactylCommand.fullDesc.options).toBeDefined();
    });

    it('should have 5 subcommands', () => {
        const commandData = pterodactylCommand.data.toJSON();
        expect(commandData.options).toBeDefined();
        expect(commandData.options?.length).toBe(5);
    });

    it('should have register subcommand', () => {
        const commandData = pterodactylCommand.data.toJSON();
        const registerCmd = commandData.options?.find((opt: any) => opt.name === 'register');
        expect(registerCmd).toBeDefined();
        expect(registerCmd?.type).toBe(1);
    });

    it('should have list subcommand', () => {
        const commandData = pterodactylCommand.data.toJSON();
        const listCmd = commandData.options?.find((opt: any) => opt.name === 'list');
        expect(listCmd).toBeDefined();
        expect(listCmd?.type).toBe(1);
    });

    it('should have manage subcommand', () => {
        const commandData = pterodactylCommand.data.toJSON();
        const manageCmd = commandData.options?.find((opt: any) => opt.name === 'manage');
        expect(manageCmd).toBeDefined();
        expect(manageCmd?.type).toBe(1);
    });

    it('should have update subcommand', () => {
        const commandData = pterodactylCommand.data.toJSON();
        const updateCmd = commandData.options?.find((opt: any) => opt.name === 'update');
        expect(updateCmd).toBeDefined();
        expect(updateCmd?.type).toBe(1);
    });

    it('should have remove subcommand', () => {
        const commandData = pterodactylCommand.data.toJSON();
        const removeCmd = commandData.options?.find((opt: any) => opt.name === 'remove');
        expect(removeCmd).toBeDefined();
        expect(removeCmd?.type).toBe(1);
    });

    it('register subcommand should have required options', () => {
        const commandData = pterodactylCommand.data.toJSON();
        const registerCmd = commandData.options?.find((opt: any) => opt.name === 'register');
        if (!('options' in registerCmd!)) {
            fail('Expected register subcommand to have options');
        }
        expect(registerCmd.options!.length).toBe(3);

        const optionNames = registerCmd?.options?.map((opt: any) => opt.name);
        expect(optionNames).toContain('server_name');
        expect(optionNames).toContain('server_url');
        expect(optionNames).toContain('api_key');
    });

    it('update subcommand should have optional url and api_key options', () => {
        const commandData = pterodactylCommand.data.toJSON();
        const updateCmd = commandData.options?.find((opt: any) => opt.name === 'update');
        if (!('options' in updateCmd!)) {
            fail('Expected update subcommand to have options');
        }
        expect(updateCmd?.options).toBeDefined();
        expect(updateCmd?.options?.length).toBe(3);

        const serverNameOption = updateCmd?.options?.find((opt: any) => opt.name === 'server_name');
        expect(serverNameOption?.required).toBe(true);

        const serverUrlOption = updateCmd?.options?.find((opt: any) => opt.name === 'server_url');
        expect(serverUrlOption?.required).toBe(false);

        const apiKeyOption = updateCmd?.options?.find((opt: any) => opt.name === 'api_key');
        expect(apiKeyOption?.required).toBe(false);
    });

    describe('execute method', () => {
        let mockInteraction: any;

        beforeEach(() => {
            jest.clearAllMocks();
            mockInteraction = {
                options: {
                    getSubcommand: jest.fn(),
                },
            };
        });

        it('should call register_server execute for register subcommand', async () => {
            mockInteraction.options.getSubcommand.mockReturnValue('register');
            mockRegisterExecute.mockResolvedValue({ content: 'registered' });

            const result = await pterodactylCommand.execute(mockInteraction);

            expect(mockRegisterExecute).toHaveBeenCalledWith(mockInteraction);
            expect(result).toEqual({ content: 'registered' });
        });

        it('should call list_servers execute for list subcommand', async () => {
            mockInteraction.options.getSubcommand.mockReturnValue('list');
            mockListExecute.mockResolvedValue({ content: 'listed' });

            const result = await pterodactylCommand.execute(mockInteraction);

            expect(mockListExecute).toHaveBeenCalledWith(mockInteraction);
            expect(result).toEqual({ content: 'listed' });
        });

        it('should call server_status execute for manage subcommand', async () => {
            mockInteraction.options.getSubcommand.mockReturnValue('manage');
            mockServerStatusExecute.mockResolvedValue({ content: 'managed' });

            const result = await pterodactylCommand.execute(mockInteraction);

            expect(mockServerStatusExecute).toHaveBeenCalledWith(mockInteraction);
            expect(result).toEqual({ content: 'managed' });
        });

        it('should call update_server execute for update subcommand', async () => {
            mockInteraction.options.getSubcommand.mockReturnValue('update');
            mockUpdateExecute.mockResolvedValue({ content: 'updated' });

            const result = await pterodactylCommand.execute(mockInteraction);

            expect(mockUpdateExecute).toHaveBeenCalledWith(mockInteraction);
            expect(result).toEqual({ content: 'updated' });
        });

        it('should call remove_server execute for remove subcommand', async () => {
            mockInteraction.options.getSubcommand.mockReturnValue('remove');
            mockRemoveExecute.mockResolvedValue({ content: 'removed' });

            const result = await pterodactylCommand.execute(mockInteraction);

            expect(mockRemoveExecute).toHaveBeenCalledWith(mockInteraction);
            expect(result).toEqual({ content: 'removed' });
        });

        it('should return unknown subcommand message for invalid subcommand', async () => {
            mockInteraction.options.getSubcommand.mockReturnValue('invalid');

            const result = await pterodactylCommand.execute(mockInteraction);

            expect(result).toEqual({
                content: 'Unknown subcommand',
                ephemeral: true,
            });
        });
    });
});
