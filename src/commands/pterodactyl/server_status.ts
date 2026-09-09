import {
    EmbedBuilder,
    ChatInputCommandInteraction,
    ButtonInteraction,
    Message,
    StringSelectMenuInteraction,
} from 'discord.js';
import Database, { PterodactylServer as DbPterodactylServer } from '../../helpers/database.js';
import { buildError, Caller } from '@pookiesoft/bongbot-core';
import {
    fetchServers,
    fetchServerResources,
    fetchAllServerResources,
    sendServerCommand,
} from './shared/pterodactyl_api.js';
import { buildServerStatusEmbed } from './shared/server_status_embed.js';
import { buildServerControlComponents, disableAllComponents } from './shared/server_control_components.js';
import type { InteractionEditReplyOptions } from 'discord.js';
import type { Logger } from '@pookiesoft/bongbot-core';
const ACTION_POLL_INTERVAL_MS = 500;
const ACTION_TIMEOUT_MS = 60000;
const COLLECTOR_TIMEOUT_MS = 10 * 60 * 1000;
const COLLECTOR_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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
        const collector = message.createMessageComponentCollector({
            time: COLLECTOR_TIMEOUT_MS,
            idle: COLLECTOR_IDLE_TIMEOUT_MS,
        });

        const controller = new AbortController();
        let busy = false;
        let latestEmbed = message.embeds?.[0] ? EmbedBuilder.from(message.embeds[0]) : undefined;
        let latestComponents: Message['components'] = message.components;
        let pendingEdit: Promise<unknown> = Promise.resolve();
        const view: ManageView = {
            signal: controller.signal,
            edit: async (component, options) => {
                if (controller.signal.aborted) return;
                pendingEdit = component.editReply(options);
                try {
                    await pendingEdit;
                } catch (error) {
                    const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : 0;
                    if (!(status >= 500 && status <= 599)) throw error;
                    this._logger.error(error as Error, interaction);
                    if (controller.signal.aborted) return;
                    pendingEdit = component.editReply(options);
                    await pendingEdit;
                }
                if (options.embeds?.[0]) latestEmbed = EmbedBuilder.from(options.embeds[0]);
                if (options.components) {
                    latestComponents = options.components as Message['components'];
                }
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
                    content: controller.signal.aborted
                        ? 'This view has expired. Run /pterodactyl manage again.'
                        : 'An action is already in progress. Wait for it to finish.',
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
                    ...(latestEmbed ? { embeds: [EmbedBuilder.from(latestEmbed).setDescription(replyMessage)] } : {}),
                    components: disableAllComponents(latestComponents),
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
                    .catch((error) => this._logger.error(error as Error, interaction));

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
        // TODO: Limit bulk command concurrency and back off on rate limits; see BUGS.md section 2.4.
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
        const failures = results.filter((result) => !result.success);
        for (const { server } of failures) {
            this._logger.debug(
                `Failed to ${action} server: ${server.attributes.identifier} (${server.attributes.name})`
            );
        }
        const failedNames = failures.map(({ server }) => server.attributes.name);
        const identifiers = results
            .filter((result) => result.success)
            .map((result) => result.server.attributes.identifier);
        const failureMessage = buildFailureMessage(action, identifier, failedNames);
        if (failureMessage) await componentInteraction.followUp({ content: failureMessage, ephemeral: true });

        const targetIds = new Set(identifiers);
        const readResources = (server: (typeof servers)[number]) =>
            fetchServerResources(this.caller, server.attributes.identifier, dbServer.serverUrl, dbServer.apiKey);
        const isTarget = (server: (typeof servers)[number]) => targetIds.has(server.attributes.identifier);
        const baseline = await Promise.all(servers.map((server) => (isTarget(server) ? null : readResources(server))));
        const deadline = Date.now() + ACTION_TIMEOUT_MS;
        const restartTransitions = new Set<string>();
        let previousDisplay = '';
        while (!view.signal.aborted) {
            const resources = await Promise.all(
                servers.map((server, index) => (isTarget(server) ? readResources(server) : baseline[index]))
            );
            if (view.signal.aborted) return;
            const states = new Map(
                servers.map((server, index) => [
                    server.attributes.identifier,
                    resources[index]?.attributes.current_state,
                ])
            );
            for (const id of identifiers) {
                const state = states.get(id);
                if (state && state !== 'running') restartTransitions.add(id);
            }
            const complete = isActionComplete(states, identifiers, action, restartTransitions);
            const timedOut = Date.now() >= deadline;
            const pending = !complete && !timedOut;
            let status: string;
            if (pending) status = this.getActionMessage(action, identifier);
            else if (timedOut) status = '⚠️ Timed out waiting for the action. Completion could not be confirmed.';
            else status = identifiers.length ? 'Action completed.' : 'No server actions completed.';
            const description = [failureMessage, status].filter(Boolean).join('\n');
            const display = JSON.stringify([description, [...states.values()]]);
            if (display !== previousDisplay) {
                const components = buildServerControlComponents(servers, resources, dbServer.id);
                await view.edit(componentInteraction, {
                    embeds: [buildServerStatusEmbed(servers, resources, description)],
                    components: pending ? disableAllComponents(components) : components,
                });
                previousDisplay = display;
            }
            if (!pending) return;
            await waitForNextPoll(view.signal, deadline);
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

function buildFailureMessage(action: string, identifier: string, names: string[]): string {
    if (names.length === 0) return '';
    if (identifier === 'all') return `⚠️ Failed to ${action} ${names.length} server(s): ${names.join(', ')}`;
    return '❌ Failed to control server.';
}

function isActionComplete(
    states: Map<string, string | undefined>,
    identifiers: string[],
    action: string,
    restartTransitions: Set<string>
): boolean {
    const targetState = action === 'stop' ? 'offline' : 'running';
    if (!identifiers.every((id) => states.get(id) === targetState)) return false;
    return action !== 'restart' || identifiers.every((id) => restartTransitions.has(id));
}

function waitForNextPoll(signal: AbortSignal, deadline: number): Promise<void> {
    return new Promise((resolve) => {
        const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', finish);
            resolve();
        };
        const timer = setTimeout(finish, Math.min(ACTION_POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
        signal.addEventListener('abort', finish, { once: true });
        if (signal.aborted) finish();
    });
}

interface ManageView {
    signal: AbortSignal;
    edit: (
        interaction: ButtonInteraction | StringSelectMenuInteraction,
        options: InteractionEditReplyOptions
    ) => Promise<void>;
}
