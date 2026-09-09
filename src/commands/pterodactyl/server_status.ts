import { ChatInputCommandInteraction, ButtonInteraction, Message, StringSelectMenuInteraction } from 'discord.js';
import Database, { StoredPterodactylServer } from '../../helpers/database.js';
import { buildError, Caller } from '@pookiesoft/bongbot-core';
import { fetchServers, fetchAllServerResources, sendServerCommand } from './shared/pterodactyl_api.js';
import { buildServerStatusEmbed } from './shared/server_status_embed.js';
import { buildServerControlComponents, disableAllComponents } from './shared/server_control_components.js';
import { StateManager, ActionType } from './shared/state_manager.js';
import type { Logger } from '@pookiesoft/bongbot-core';

const ACTION_POLL_INTERVAL_MS = 500;
const ACTION_TIMEOUT_MS = 60000;
const ACTION_TIMEOUT_MESSAGE = `⚠️ Stopped watching after ${ACTION_TIMEOUT_MS / 1000} seconds. Run \`/pterodactyl manage\` to check again.`;

export default class ServerStatus {
    private db: Database;
    private caller: Caller;
    private _logger: Logger;
    private stateManager: StateManager;

    private cancelled: boolean = false;

    constructor(db: Database, caller: Caller, _logger: Logger, stateManager: StateManager) {
        this.db = db;
        this.caller = caller;
        this._logger = _logger;
        this.stateManager = stateManager;
    }

    async execute(interaction: ChatInputCommandInteraction) {
        try {
            const userServers = this.db.getServersByUserId(interaction.user.id);

            if (!userServers || userServers.length === 0) {
                throw new Error('You have no registered servers. Use `/pterodactyl register` to add one.');
            }

            const serverName = interaction.options.getString('server_name');
            if (userServers.length > 1 && !serverName) {
                const serverList = userServers.map((s) => `• ${s.serverName}`).join('\n');
                throw new Error(
                    `You have multiple registered servers. Please specify which one to query using the \`server_name\` option. Your registered servers:\n\n${serverList}`
                );
            }

            const selectedServer =
                userServers.length === 1 ? userServers[0] : userServers.find((s) => s.serverName === serverName);

            if (!selectedServer) {
                const serverList = userServers.map((s) => `• ${s.serverName}`).join('\n');
                throw new Error(`No server found with name "${serverName}". Your registered servers:\n\n${serverList}`);
            }

            const servers = await fetchServers(this.caller, selectedServer.serverUrl, selectedServer.apiKey);
            const resources = await fetchAllServerResources(
                this.caller,
                servers,
                selectedServer.serverUrl,
                selectedServer.apiKey
            );

            servers.forEach((server, index) => this.stateManager.newState(server, resources[index]));

            const embed = buildServerStatusEmbed(servers, resources);
            const components = buildServerControlComponents(servers, resources, selectedServer.id);

            return {
                embeds: [embed],
                components: components,
            };
        } catch (error) {
            return await buildError(interaction, error);
        }
    }

    async setupCollector(interaction: ChatInputCommandInteraction, message: Message): Promise<void> {
        if (!('manage' === interaction.options.getSubcommand())) {
            return;
        }
        // TODO: [BUGS 4.2 / TECHNICAL_DEBT 3.1] Add idle timeout (e.g. idle: 300000) and extract 600000 to a named constant
        const collector = message.createMessageComponentCollector({ time: 600000 });

        collector.on('collect', async (componentInteraction: ButtonInteraction | StringSelectMenuInteraction) => {
            if (componentInteraction.user.id !== interaction.user.id) {
                await componentInteraction.reply({
                    content: '❌ You cannot control servers for another user.',
                    ephemeral: true,
                });
                return;
            }

            await componentInteraction.deferUpdate();

            const { dbServerId, identifier, action } = this.parseComponentInteraction(componentInteraction);

            await ephemeralFollowup(componentInteraction, this.getActionMessage(action, identifier));

            try {
                await componentInteraction.editReply({
                    components: disableAllComponents(message.components),
                });

                const dbServer = this.db.getServerById(parseInt(dbServerId));

                if (!dbServer) {
                    await ephemeralFollowup(componentInteraction, '❌ Server configuration not found.');
                    return;
                }

                await this.handleServerAction(componentInteraction, dbServer, identifier, action);
            } catch (error) {
                this._logger.error(error as Error, interaction);
                await ephemeralFollowup(componentInteraction, '❌ An error occurred processing your request.').catch(
                    () => {}
                ); // TODO: [BUGS 1.3] Log the error instead of silently swallowing

                if (dbServerId) {
                    await this.refreshStatus(componentInteraction, parseInt(dbServerId));
                }
            }
        });

        collector.on('end', () => {
            this.stateManager.flushState();
            message.edit({ components: [] }).catch((error) => {
                this._logger.error(error, interaction);
            });
            this.cancelled = true;
        });
    }

    // Ids are built by buildServerControlComponents, and Discord only sends back one it put on the
    // message, so the action is always one of the three.
    // TODO: [BUGS 3.2 / ARCHITECTURE 4.3] Validate split length before destructuring; consider a ComponentIdParser utility
    private parseComponentInteraction(componentInteraction: ButtonInteraction | StringSelectMenuInteraction): {
        dbServerId: string;
        identifier: string;
        action: ActionType;
    } {
        if (componentInteraction.isStringSelectMenu()) {
            const [dbServerId, identifier, action] = componentInteraction.values[0].split(':');
            return { dbServerId, identifier, action: action as ActionType };
        }
        const [, dbServerId, identifier, action] = componentInteraction.customId.split(':');
        return { dbServerId, identifier, action: action as ActionType };
    }

    private getActionMessage(action: ActionType, identifier: string): string {
        if (action === 'stop') {
            return identifier === 'all'
                ? '⏹️ Stopping all servers... Status will update automatically.'
                : '⏹️ Stopping server... Status will update automatically.';
        }
        const actionText = action === 'start' ? '▶️ Starting' : '🔄 Restarting';
        return `${actionText} server... Status will update automatically.`;
    }

    private async handleServerAction(
        componentInteraction: ButtonInteraction | StringSelectMenuInteraction,
        dbServer: StoredPterodactylServer,
        identifier: string,
        action: ActionType
    ): Promise<void> {
        const servers = this.stateManager.targets(identifier);
        const refreshedResources = await fetchAllServerResources(
            this.caller,
            servers,
            dbServer.serverUrl,
            dbServer.apiKey
        );

        servers.forEach((server, index) => {
            this.stateManager.newState(server, refreshedResources[index]);
        });
        // TODO: [BUGS 2.4] Add concurrency limiting (e.g. p-limit) and backoff on 429 responses
        const results = await Promise.all(
            this.stateManager.targets(identifier).map(async (server) => ({
                server,
                success: await sendServerCommand(
                    this.caller,
                    server.attributes.identifier,
                    action,
                    dbServer.serverUrl,
                    dbServer.apiKey
                ),
            }))
        );

        // Tracked after the send, so the baseline is the reading from before the command. A server
        // whose command failed keeps its place on the panel, untracked.
        const failed: string[] = [];
        for (const { server, success } of results) {
            if (success) {
                this.stateManager.trackState(server.attributes.identifier, action);
                continue;
            }
            failed.push(server.attributes.name);
            this._logger.debug(
                `Failed to ${action} server: ${server.attributes.identifier} (${server.attributes.name})`
            );
        }

        const failureMessage = buildFailureMessage(action, identifier, failed);
        if (failureMessage) {
            await ephemeralFollowup(componentInteraction, failureMessage);
        }

        if (!results.some((result) => result.success)) {
            await this.refreshStatus(componentInteraction, dbServer.id);
            return;
        }

        try {
            await this.pollUntilComplete(componentInteraction, dbServer, { action, identifier, failureMessage });
        } finally {
            this.stateManager.clearActions(this.stateManager.targets(identifier));
        }
    }

    /** Renders every change it sees, until each commanded server completes or the deadline passes. */
    private async pollUntilComplete(
        componentInteraction: ButtonInteraction | StringSelectMenuInteraction,
        dbServer: StoredPterodactylServer,
        context: { action: ActionType; identifier: string; failureMessage: string }
    ): Promise<void> {
        const deadline = Date.now() + ACTION_TIMEOUT_MS;
        let lastRender = '';

        while (!this.cancelled) {
            const servers = this.stateManager.targets(context.identifier);
            const resources = await fetchAllServerResources(this.caller, servers, dbServer.serverUrl, dbServer.apiKey);
            this.stateManager.observeAll(servers, resources);

            const complete = this.stateManager.allComplete();
            const pending = !complete && Date.now() < deadline;

            let status: string;
            if (pending) {
                status = this.getActionMessage(context.action, context.identifier);
            } else if (complete) {
                status = '✅ Action complete.';
            } else {
                status = ACTION_TIMEOUT_MESSAGE;
            }

            const managed = this.stateManager.managedServers();
            const currentResources = this.stateManager.currentResources();
            const description = [context.failureMessage, status].filter(Boolean).join('\n');
            const render = [description, ...currentResources.map((r) => r?.attributes.current_state)].join('|');
            if (render !== lastRender) {
                await componentInteraction.editReply({
                    embeds: [buildServerStatusEmbed(managed, currentResources, description)],
                    components: buildServerControlComponents(managed, currentResources, dbServer.id, pending),
                });
                lastRender = render;
            }

            if (!pending) return;
            await delay(ACTION_POLL_INTERVAL_MS);
        }
    }

    private async refreshStatus(
        componentInteraction: ButtonInteraction | StringSelectMenuInteraction,
        dbServerId: number
    ): Promise<void> {
        try {
            const dbServer = this.db.getServerById(dbServerId);

            if (!dbServer) {
                return;
            }

            const servers = await fetchServers(this.caller, dbServer.serverUrl, dbServer.apiKey);
            const resources = await fetchAllServerResources(this.caller, servers, dbServer.serverUrl, dbServer.apiKey);

            const embed = buildServerStatusEmbed(
                servers,
                resources,
                '*Last updated: ' + new Date().toLocaleTimeString() + '*'
            );
            const components = buildServerControlComponents(servers, resources, dbServer.id);

            await componentInteraction.editReply({
                embeds: [embed],
                components: components,
            });
        } catch (error) {
            this._logger.error(error as Error); // TODO: [EXTRAS 4.5] Pass interaction for request correlation
        }
    }
}

function buildFailureMessage(action: ActionType, identifier: string, names: string[]): string {
    if (names.length === 0) return '';
    if (identifier === 'all') return `⚠️ Failed to ${action} ${names.length} server(s): ${names.join(', ')}`;
    return '❌ Failed to control server.';
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ephemeralFollowup(
    componentInteraction: ButtonInteraction | StringSelectMenuInteraction,
    content: string
) {
    await componentInteraction.followUp({
        content: content,
        ephemeral: true,
    });
}
