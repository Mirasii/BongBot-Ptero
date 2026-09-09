import {
    EmbedBuilder,
    ChatInputCommandInteraction,
    ButtonInteraction,
    Message,
    StringSelectMenuInteraction,
} from 'discord.js';
import Database, { PterodactylServer as DbPterodactylServer } from '../../helpers/database.js';
import { buildError, Caller } from '@pookiesoft/bongbot-core';
import { fetchServers, fetchAllServerResources, sendServerCommand } from './shared/pterodactyl_api.js';
import { buildServerStatusEmbed } from './shared/server_status_embed.js';
import { buildServerControlComponents, disableAllComponents } from './shared/server_control_components.js';
import type { InteractionEditReplyOptions } from 'discord.js';
import type { Logger } from '@pookiesoft/bongbot-core';
const ACTION_POLL_INTERVAL_MS = 500;
const ACTION_TIMEOUT_MS = 60000;

export default class ServerStatus {
    private db: Database;
    private caller: Caller;
    private _logger: Logger;

    constructor(db: Database, caller: Caller, _logger: Logger) {
        this.db = db;
        this.caller = caller;
        this._logger = _logger;
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

            const embed = buildServerStatusEmbed(servers, resources);
            const components = buildServerControlComponents(servers, resources, selectedServer.id!);

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

        const controller = new AbortController();
        let busy = false;
        let pendingEdit: Promise<unknown> = Promise.resolve();
        const view: ManageView = {
            signal: controller.signal,
            edit: async (component, options) => {
                if (controller.signal.aborted) return;
                pendingEdit = component.editReply(options);
                await pendingEdit;
            },
        };

        collector.on('collect', async (componentInteraction: ButtonInteraction | StringSelectMenuInteraction) => {
            if (componentInteraction.user.id !== interaction.user.id) {
                await componentInteraction.reply({
                    content: '❌ You cannot control servers for another user.',
                    ephemeral: true,
                });
                return;
            }

            if (busy || controller.signal.aborted) {
                await componentInteraction.reply({
                    content: 'An action is already in progress or this view has expired.',
                    ephemeral: true,
                });
                return;
            }
            busy = true;
            let dbServerId = '';
            try {
                await componentInteraction.deferUpdate();

                const parsed = this.parseComponentInteraction(componentInteraction);
                dbServerId = parsed.dbServerId;
                const { identifier, action } = parsed;
                const replyMessage = this.getActionMessage(action, identifier);

                await componentInteraction.followUp({ content: replyMessage, ephemeral: true });

                await view.edit(componentInteraction, {
                    ...(message.embeds?.[0]
                        ? { embeds: [EmbedBuilder.from(message.embeds[0]).setDescription(replyMessage)] }
                        : {}),
                    components: disableAllComponents(message.components),
                });

                const dbServer = this.db.getServerById(parseInt(dbServerId));

                if (!dbServer || !dbServer.id) {
                    await componentInteraction.followUp({
                        content: '❌ Server configuration not found.',
                        ephemeral: true,
                    });
                    return;
                }

                if (view.signal.aborted) return;
                await this.handleServerAction(
                    componentInteraction,
                    dbServer as ValidatedDbServer,
                    identifier,
                    action,
                    view
                );
            } catch (error) {
                this._logger.error(error as Error, interaction);
                await componentInteraction
                    .followUp({
                        content: '❌ An error occurred processing your request.',
                        ephemeral: true,
                    })
                    .catch(() => {}); // TODO: [BUGS 1.3] Log the error instead of silently swallowing

                if (dbServerId) {
                    await this.refreshStatus(componentInteraction, parseInt(dbServerId), view);
                }
            } finally {
                busy = false;
            }
        });

        collector.on('end', async () => {
            controller.abort();
            await pendingEdit.catch(() => {});
            await message.edit({ components: [] }).catch((error) => {
                this._logger.error(error, interaction);
            });
        });
    }

    // TODO: [BUGS 3.2 / ARCHITECTURE 4.3] Validate split length before destructuring; consider a ComponentIdParser utility
    private parseComponentInteraction(componentInteraction: ButtonInteraction | StringSelectMenuInteraction): {
        dbServerId: string;
        identifier: string;
        action: string;
    } {
        if (componentInteraction.isStringSelectMenu()) {
            const [dbServerId, identifier, action] = componentInteraction.values[0].split(':');
            return { dbServerId, identifier, action };
        }
        const [, dbServerId, identifier, action] = componentInteraction.customId.split(':');
        return { dbServerId, identifier, action };
    }

    private getActionMessage(action: string, identifier: string): string {
        const verbs: Record<string, string> = { start: '▶️ Starting', stop: '⏹️ Stopping', restart: '🔄 Restarting' };
        const verb = verbs[action];
        if (!verb) return 'Processing your request...';
        return `${verb} ${identifier === 'all' ? 'all servers' : 'server'}... Status will update automatically.`;
    }

    private async handleServerAction(
        componentInteraction: ButtonInteraction | StringSelectMenuInteraction,
        dbServer: ValidatedDbServer,
        identifier: string,
        action: string,
        view: ManageView
    ): Promise<void> {
        const servers = await fetchServers(this.caller, dbServer.serverUrl, dbServer.apiKey);
        if (view.signal.aborted) return;
        const targets =
            identifier === 'all' ? servers : servers.filter((server) => server.attributes.identifier === identifier);
        const results = await Promise.all(
            targets.map(async (server) => ({
                server,
                success: await sendServerCommand(
                    this.caller,
                    server.attributes.identifier,
                    action as 'start' | 'stop' | 'restart',
                    dbServer.serverUrl,
                    dbServer.apiKey
                ),
            }))
        );
        const failedNames = results.filter((result) => !result.success).map((result) => result.server.attributes.name);
        const identifiers = results
            .filter((result) => result.success)
            .map((result) => result.server.attributes.identifier);
        const failureMessage = failedNames.length
            ? identifier === 'all'
                ? `⚠️ Failed to stop ${failedNames.length} server(s): ${failedNames.join(', ')}`
                : '❌ Failed to control server.'
            : '';
        if (failureMessage) await componentInteraction.followUp({ content: failureMessage, ephemeral: true });

        const deadline = Date.now() + ACTION_TIMEOUT_MS;
        let restartTransitionObserved = false;
        let previousDisplay = '';
        while (!view.signal.aborted) {
            const resources = await fetchAllServerResources(this.caller, servers, dbServer.serverUrl, dbServer.apiKey);
            if (view.signal.aborted) return;
            const states = new Map(
                servers.map((server, index) => [
                    server.attributes.identifier,
                    resources[index]?.attributes.current_state,
                ])
            );
            const restartState = states.get(identifier);
            if (restartState && restartState !== 'running' && restartState !== 'unknown')
                restartTransitionObserved = true;
            const complete =
                identifiers.every((id) => states.get(id) === (action === 'stop' ? 'offline' : 'running')) &&
                (action !== 'restart' || identifiers.length === 0 || restartTransitionObserved);
            const timedOut = Date.now() >= deadline;
            const pending = !complete && !timedOut;
            let status = identifiers.length ? 'Action completed.' : 'No server actions completed.';
            if (pending) status = this.getActionMessage(action, identifier);
            else if (!complete) status = '⚠️ Timed out waiting for the action. Completion could not be confirmed.';
            const description = [failureMessage, status].filter(Boolean).join('\n');
            const display = JSON.stringify([description, [...states.values()]]);
            if (display !== previousDisplay) {
                const components = buildServerControlComponents(servers, resources, dbServer.id);
                await view.edit(componentInteraction, {
                    embeds: [buildServerStatusEmbed(servers, resources, description)],
                    components: pending ? disableAllComponents(components.map((row) => row.toJSON())) : components,
                });
                previousDisplay = display;
            }
            if (!pending) return;
            await new Promise<void>((resolve) => {
                const finish = () => {
                    clearTimeout(timer);
                    view.signal.removeEventListener('abort', finish);
                    resolve();
                };
                const timer = setTimeout(finish, Math.min(ACTION_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
                view.signal.addEventListener('abort', finish, { once: true });
                if (view.signal.aborted) finish();
            });
        }
    }

    private async refreshStatus(
        componentInteraction: ButtonInteraction | StringSelectMenuInteraction,
        dbServerId: number,
        view: ManageView
    ): Promise<void> {
        try {
            if (view.signal.aborted) return;
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
            const components = buildServerControlComponents(servers, resources, dbServer.id!);

            await view.edit(componentInteraction, {
                embeds: [embed],
                components: components,
            });
        } catch (error) {
            this._logger.error(error as Error); // TODO: [EXTRAS 4.5] Pass interaction for request correlation
        }
    }
}

type ValidatedDbServer = DbPterodactylServer & { id: number };

interface ManageView {
    signal: AbortSignal;
    edit: (
        interaction: ButtonInteraction | StringSelectMenuInteraction,
        options: InteractionEditReplyOptions
    ) => Promise<void>;
}
