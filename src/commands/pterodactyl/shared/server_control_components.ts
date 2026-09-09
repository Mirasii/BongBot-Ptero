import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ComponentType,
    APIActionRowComponent,
    APIComponentInMessageActionRow,
    MessageActionRowComponentBuilder,
} from 'discord.js';
import { PterodactylServer, ServerResources } from './pterodactyl_api.js';

export function buildServerControlComponents(
    servers: PterodactylServer[],
    resources: (ServerResources | null)[],
    dbServerId: number
): (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] {
    const rows: (ActionRowBuilder<StringSelectMenuBuilder> | ActionRowBuilder<ButtonBuilder>)[] = [];
    const allOptions: { label: string; description: string; value: string }[] = [];

    servers.forEach((server, index) => {
        const state = resources[index]?.attributes.current_state || 'unknown';
        // TODO: [TECHNICAL_DEBT 3.4] Extract 80/77 to named constants (Discord StringSelectMenu label limit)
        const serverName =
            server.attributes.name.length > 80
                ? server.attributes.name.substring(0, 77) + '...'
                : server.attributes.name;

        if (state === 'offline') {
            allOptions.push({
                label: `✅ Start ${serverName}`,
                description: 'Start the server',
                value: `${dbServerId}:${server.attributes.identifier}:start`,
            });
        }

        if (state === 'running') {
            allOptions.push({
                label: `🔄 Restart ${serverName}`,
                description: 'Restart the server',
                value: `${dbServerId}:${server.attributes.identifier}:restart`,
            });
            allOptions.push({
                label: `🟥 Stop ${serverName}`,
                description: 'Stop the server',
                value: `${dbServerId}:${server.attributes.identifier}:stop`,
            });
        }
    });

    // TODO: [TECHNICAL_DEBT 3.5] Extract 25 to a named constant (Discord StringSelectMenu hard limit)
    const maxRowsForSelects = 3;
    const optionsPerMenu = Math.ceil(
        allOptions.length / Math.min(maxRowsForSelects, Math.ceil(allOptions.length / 25))
    );

    for (let i = 0; i < allOptions.length; i += optionsPerMenu) {
        const menuOptions = allOptions.slice(i, i + optionsPerMenu);
        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`server_control:${dbServerId}:menu${i}`)
            .setPlaceholder('Server Actions')
            .addOptions(menuOptions);

        const row = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(selectMenu);
        rows.push(row);
    }

    const anyRunning = resources.some((r) => r?.attributes.current_state === 'running');
    if (anyRunning && rows.length < 5) {
        const stopRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
            new ButtonBuilder()
                .setCustomId(`server_control:${dbServerId}:all:stop`)
                .setLabel('🔲 Stop All Servers')
                .setStyle(ButtonStyle.Danger)
        );
        rows.push(stopRow);
    }

    return rows;
}

export type ControlRow = ActionRowBuilder<MessageActionRowComponentBuilder>;
type ApiControlRow = APIActionRowComponent<APIComponentInMessageActionRow>;

/** Disables buttons and string selects; empty or unsupported rows are returned untouched. */
export function disableAllComponents(components: ControlRow[]): ControlRow[];
export function disableAllComponents(components: (ControlRow | ApiControlRow)[]): (ControlRow | ApiControlRow)[];
export function disableAllComponents(components: (ControlRow | ApiControlRow)[]): (ControlRow | ApiControlRow)[] {
    return components.map((row) => {
        const data = row instanceof ActionRowBuilder ? row.toJSON() : row;
        const firstComponent = data.components[0];
        if (!firstComponent) return row;
        if (firstComponent.type === ComponentType.StringSelect) {
            return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
                StringSelectMenuBuilder.from(firstComponent).setDisabled(true)
            );
        }
        if (firstComponent.type === ComponentType.Button) {
            const newRow = new ActionRowBuilder<ButtonBuilder>();
            for (const component of data.components) {
                if (component.type !== ComponentType.Button) return row;
                newRow.addComponents(ButtonBuilder.from(component).setDisabled(true));
            }
            return newRow;
        }
        return row;
    });
}
