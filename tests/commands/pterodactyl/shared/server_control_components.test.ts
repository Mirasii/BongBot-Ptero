import { jest } from '@jest/globals';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType } from 'discord.js';
import {
    buildServerControlComponents,
    disableAllComponents,
} from '../../../../src/commands/pterodactyl/shared/server_control_components.js';
import type {
    PterodactylServer,
    ServerResources,
} from '../../../../src/commands/pterodactyl/shared/pterodactyl_api.js';

describe('serverControlComponents', () => {
    describe('buildServerControlComponents', () => {
        const createServer = (index: number): PterodactylServer => ({
            attributes: {
                identifier: `server-${index}`,
                name: `Test Server ${index}`,
                description: `Description ${index}`,
            },
        });

        const createResources = (state: string): ServerResources => ({
            attributes: {
                current_state: state,
                resources: {
                    memory_bytes: 1024 * 1024 * 512,
                    cpu_absolute: 50,
                    disk_bytes: 1024 * 1024 * 1024,
                    uptime: 3600000,
                },
            },
        });

        it('should build start option for offline servers', () => {
            const servers = [createServer(1)];
            const resources = [createResources('offline')];
            const dbServerId = 1;

            const rows = buildServerControlComponents(servers, resources, dbServerId);

            expect(rows.length).toBeGreaterThan(0);
            const selectMenu = rows[0].components[0];
            if (!('custom_id' in selectMenu.data)) {
                fail('Expected custom_id in component data');
            }
            expect(selectMenu.data.custom_id).toContain('server_control:1:menu');
        });

        it('should build restart and stop options for running servers', () => {
            const servers = [createServer(1)];
            const resources = [createResources('running')];
            const dbServerId = 1;

            const rows = buildServerControlComponents(servers, resources, dbServerId);

            expect(rows.length).toBeGreaterThanOrEqual(2);
        });

        it('should add stop all button when any server is running', () => {
            const servers = [createServer(1), createServer(2)];
            const resources = [createResources('running'), createResources('offline')];
            const dbServerId = 1;

            const rows = buildServerControlComponents(servers, resources, dbServerId);

            const lastRow = rows[rows.length - 1];
            const button = lastRow.components[0];
            if (!('custom_id' in button.data)) {
                fail('Expected custom_id in component data');
            }
            expect(button.data.custom_id).toBe('server_control:1:all:stop');
        });

        it('should not add stop all button when no servers are running', () => {
            const servers = [createServer(1), createServer(2)];
            const resources = [createResources('offline'), createResources('offline')];
            const dbServerId = 1;

            const rows = buildServerControlComponents(servers, resources, dbServerId);

            rows.forEach((row) => {
                const component = row.components[0];
                if (!('custom_id' in component.data)) {
                    fail('Expected custom_id in component data');
                }
                expect(component.data.custom_id).toContain('menu');
            });
        });

        it('should handle unknown server state', () => {
            const servers = [createServer(1)];
            const resources = [createResources('starting')];
            const dbServerId = 1;

            const rows = buildServerControlComponents(servers, resources, dbServerId);

            expect(rows).toBeDefined();
        });

        it('should handle null resources', () => {
            const servers = [createServer(1)];
            const resources: (ServerResources | null)[] = [null];
            const dbServerId = 1;

            const rows = buildServerControlComponents(servers, resources, dbServerId);

            expect(rows).toBeDefined();
        });

        it('should truncate long server names', () => {
            const server = createServer(1);
            server.attributes.name = 'A'.repeat(100);
            const servers = [server];
            const resources = [createResources('offline')];
            const dbServerId = 1;

            const rows = buildServerControlComponents(servers, resources, dbServerId);

            expect(rows.length).toBeGreaterThan(0);
        });

        it('should create multiple menu rows when many servers exist', () => {
            const serverCount = 15;
            const servers: PterodactylServer[] = [];
            const resources: ServerResources[] = [];

            for (let i = 0; i < serverCount; i++) {
                servers.push({
                    attributes: {
                        identifier: `srv${i.toString().padStart(3, '0')}`,
                        name: `Server ${i + 1}`,
                        description: `Desc ${i}`,
                    },
                });
                resources.push(createResources('running'));
            }

            const dbServerId = 1;
            const rows = buildServerControlComponents(servers, resources, dbServerId);

            expect(rows.length).toBeGreaterThanOrEqual(2);
        });

        it('should handle empty servers array', () => {
            const rows = buildServerControlComponents([], [], 1);

            expect(rows).toBeDefined();
        });

        it('should handle mixed server states', () => {
            const servers = [createServer(1), createServer(2), createServer(3)];
            const resources = [createResources('running'), createResources('offline'), createResources('stopping')];
            const dbServerId = 1;

            const rows = buildServerControlComponents(servers, resources, dbServerId);

            expect(rows).toBeDefined();
            expect(rows.length).toBeGreaterThan(0);
        });
    });

    describe('disableAllComponents', () => {
        it('disables builder rows as well as API component rows', () => {
            const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('test-button').setLabel('Test').setStyle(ButtonStyle.Primary)
            );

            const [disabledRow] = disableAllComponents([row]);

            expect(disabledRow.components[0].data.disabled).toBe(true);
        });

        it('should disable StringSelect components', () => {
            const mockSelectComponent = {
                type: ComponentType.StringSelect,
                data: {
                    custom_id: 'test-select',
                    options: [{ label: 'Option 1', value: 'opt1' }],
                },
                toJSON: () => ({
                    type: ComponentType.StringSelect,
                    custom_id: 'test-select',
                    options: [{ label: 'Option 1', value: 'opt1' }],
                }),
            };

            const mockRow = {
                components: [mockSelectComponent],
            };

            const result = disableAllComponents([mockRow]);

            expect(result.length).toBe(1);
        });

        it('should disable Button components', () => {
            const mockButtonComponent = {
                type: ComponentType.Button,
                data: {
                    custom_id: 'test-button',
                    label: 'Test Button',
                    style: 4,
                },
                toJSON: () => ({
                    type: ComponentType.Button,
                    custom_id: 'test-button',
                    label: 'Test Button',
                    style: 4,
                }),
            };

            const mockRow = {
                components: [mockButtonComponent],
            };

            const result = disableAllComponents([mockRow]);

            expect(result.length).toBe(1);
        });

        it('should handle multiple buttons in a row', () => {
            const createButton = (id: string) => ({
                type: ComponentType.Button,
                data: {
                    custom_id: id,
                    label: `Button ${id}`,
                    style: 4,
                },
                toJSON: () => ({
                    type: ComponentType.Button,
                    custom_id: id,
                    label: `Button ${id}`,
                    style: 4,
                }),
            });

            const mockRow = {
                components: [createButton('btn1'), createButton('btn2'), createButton('btn3')],
            };

            const result = disableAllComponents([mockRow]);

            expect(result.length).toBe(1);
        });

        it('should return row as-is for unknown component types', () => {
            const mockUnknownComponent = {
                type: 999,
                data: {
                    custom_id: 'test-unknown',
                },
            };

            const mockRow = {
                components: [mockUnknownComponent],
            };

            const result = disableAllComponents([mockRow]);

            expect(result.length).toBe(1);
            expect(result[0]).toBe(mockRow);
        });

        it('should handle empty components array', () => {
            const result = disableAllComponents([]);

            expect(result).toEqual([]);
        });

        it('should handle mixed component types across rows', () => {
            const mockSelectRow = {
                components: [
                    {
                        type: ComponentType.StringSelect,
                        data: { custom_id: 'select-1' },
                        toJSON: () => ({ type: ComponentType.StringSelect, custom_id: 'select-1' }),
                    },
                ],
            };

            const mockButtonRow = {
                components: [
                    {
                        type: ComponentType.Button,
                        data: { custom_id: 'button-1', style: 4 },
                        toJSON: () => ({ type: ComponentType.Button, custom_id: 'button-1', style: 4 }),
                    },
                ],
            };

            const result = disableAllComponents([mockSelectRow, mockButtonRow]);

            expect(result.length).toBe(2);
        });
    });
});
