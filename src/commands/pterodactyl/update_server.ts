import { ChatInputCommandInteraction } from 'discord.js';
import { buildError, Caller } from '@pookiesoft/bongbot-core';
import Database from '../../helpers/database.js';
import { fetchServers } from './shared/pterodactyl_api.js';

export default class UpdateServer {
    private db: Database;
    private caller: Caller;
    constructor(db: Database, caller: Caller) {
        this.db = db;
        this.caller = caller;
    }
    async execute(interaction: ChatInputCommandInteraction) {
        try {
            const serverName = interaction.options.getString('server_name', true).trim();
            let serverUrl = interaction.options.getString('server_url');
            const apiKey = interaction.options.getString('api_key');
            const userId = interaction.user.id;

            // TODO: Query by user and server name: https://github.com/PookieSoft/BongBot-Ptero/issues/70
            const existingServers = this.db.getServersByUserId(userId);
            const existingServer = existingServers.find((s) => s.serverName === serverName);

            if (!existingServer) {
                throw new Error(`Server "${serverName}" not found for this user.`);
            }

            const updates: { serverUrl?: string; apiKey?: string } = {};
            if (serverUrl) {
                serverUrl = serverUrl.trim();
                if (serverUrl.endsWith('/')) {
                    serverUrl = serverUrl.slice(0, -1);
                }
                updates.serverUrl = serverUrl;
            }
            if (apiKey) updates.apiKey = apiKey.trim();

            const finalUrl = updates.serverUrl || existingServer.serverUrl;
            const finalApiKey = updates.apiKey || existingServer.apiKey;
            try {
                await fetchServers(this.caller, finalUrl, finalApiKey);
            } catch (error) {
                throw new Error(
                    'Failed to connect to the Pterodactyl panel. Please check the URL and API key are valid.'
                );
            }

            this.db.updateServer(userId, serverName, updates);

            const updatedFields: string[] = [];
            if (updates.serverUrl) updatedFields.push('URL');
            if (updates.apiKey) updatedFields.push('API key');

            return {
                content: `Successfully updated **${serverName}**!\nUpdated: ${updatedFields.join(', ')}`,
                ephemeral: true,
            };
        } catch (error) {
            return await buildError(interaction, error);
        }
    }
}
