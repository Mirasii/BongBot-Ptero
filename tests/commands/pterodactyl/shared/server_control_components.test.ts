import { jest } from '@jest/globals';
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, ComponentType, StringSelectMenuBuilder } from 'discord.js';
import type { APIActionRowComponent, APIComponentInMessageActionRow } from 'discord.js';
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
        function buttonRow() {
            return new ActionRowBuilder<ButtonBuilder>().addComponents(
                new ButtonBuilder().setCustomId('first').setLabel('First').setStyle(ButtonStyle.Primary),
                new ButtonBuilder().setCustomId('second').setLabel('Second').setStyle(ButtonStyle.Danger)
            );
        }

        function selectRow() {
            return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                new StringSelectMenuBuilder().setCustomId('select').addOptions({ label: 'Option', value: 'option' })
            );
        }

        it('disables builder controls without mutating the originals', () => {
            const rows = [buttonRow(), selectRow()];
            const original = rows.map((row) => row.toJSON());
            const disabled = disableAllComponents(rows);
            expect(disabled.map((row) => row.toJSON())).toEqual(
                original.map((row) => ({
                    ...row,
                    components: row.components.map((component) => ({ ...component, disabled: true })),
                }))
            );
            expect(rows.map((row) => row.toJSON())).toEqual(original);
        });

        it('disables API controls without mutating the originals', () => {
            const rows = [buttonRow().toJSON(), selectRow().toJSON()];
            const original = structuredClone(rows);
            const disabled = disableAllComponents(rows);
            expect(disabled.map((row) => (row instanceof ActionRowBuilder ? row.toJSON() : row))).toEqual(
                original.map((row) => ({
                    ...row,
                    components: row.components.map((component) => ({ ...component, disabled: true })),
                }))
            );
            expect(rows).toEqual(original);
        });

        it('preserves empty API rows', () => {
            const row = { type: ComponentType.ActionRow as const, components: [] };
            expect(disableAllComponents([row])[0]).toBe(row);
        });

        it('preserves unsupported rows received at runtime', () => {
            const row = {
                type: ComponentType.ActionRow,
                components: [{ type: 999 }],
            } as unknown as APIActionRowComponent<APIComponentInMessageActionRow>;
            expect(disableAllComponents([row])[0]).toBe(row);
        });

        it('preserves malformed mixed rows received at runtime', () => {
            const row = {
                type: ComponentType.ActionRow as const,
                components: [buttonRow().toJSON().components[0], selectRow().toJSON().components[0]],
            };
            expect(disableAllComponents([row])[0]).toBe(row);
        });

        it('handles no rows', () => {
            expect(disableAllComponents([])).toEqual([]);
        });
    });
});
