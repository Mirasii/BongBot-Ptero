# BongBot-Ptero

![Build Status](https://img.shields.io/github/actions/workflow/status/PookieSoft/BongBot-Ptero/deploy.yml?label=Production%20Deploy&logo=github)
![Coverage](https://codecov.io/gh/PookieSoft/BongBot-Ptero/branch/main/graph/badge.svg)
![License](https://img.shields.io/github/license/PookieSoft/BongBot-Ptero?v=2)
![Node Version](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen?logo=node.js)

Welcome to BongBot-Ptero! 🤖

BongBot-Ptero is a microservice in the BongBot ecosystem, providing Pterodactyl server management features via a Discord bot. It leverages slash commands with interactive buttons for managing game servers through the Pterodactyl panel.

## Features

- **Pterodactyl Server Management**: Register and control game servers via Pterodactyl panel with interactive buttons

## Quick Start with Docker

### Prerequisites

- [Docker](https://www.docker.com/get-started) installed on your system
- A Discord Bot Token (see [Discord Developer Portal](https://discord.com/developers/applications))

### Running the Bot

1. **Clone the repository**:

    ```bash
    git clone https://github.com/PookieSoft/BongBot-Ptero.git
    cd BongBot-Ptero
    ```

2. **Configure environment variables**:
   Copy the example environment file and update it with your credentials:

    ```bash
    cp .env.example .env
    ```

    Edit `.env` and add your Discord bot token and other API keys:

    ```env
    DISCORD_API_KEY=your_discord_bot_token_here
    DISCORD_CHANNEL_ID=your_channel_id_here
    # Add other API keys as needed
    ```

3. **Run with Docker**:

    ```bash
    # Build and run the container
    docker build --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN -t bongbot-ptero .
    docker run --env-file .env --volume ./data:/app/data --volume ./logs:/app/logs bongbot-ptero
    ```

    Or use the pre-built image:

    ```bash
    # Dev Build
    docker run --env-file .env --volume ./data:/app/data --volume ./logs:/app/logs mirasi/bongbot-ptero-develop:latest
    ```

    ```bash
    # Release Build
    docker run --env-file .env --volume ./data:/app/data --volume ./logs:/app/logs mirasi/bongbot-ptero:latest
    ```

    **It is recommended you use docker for local development.**

## Environment Configuration

| Variable             | Required | Description                                                          |
| -------------------- | -------- | -------------------------------------------------------------------- |
| `DISCORD_API_KEY`    | ✅       | Your Discord bot token                                               |
| `DISCORD_CHANNEL_ID` | ❌       | Default channel ID for info card on bot launch                       |
| `SERVER_DATABASE`    | ✅       | Pterodactyl database file name (default: pterodactyl.db)             |
| `ENCRYPTION_KEY`     | ✅       | Hex-encoded encryption key for storing Pterodactyl API keys securely |

## Available Commands

- `/pterodactyl` - Manage Pterodactyl panel servers with subcommands:
    - `register` - Register a new server with URL and API key
    - `list` - List all registered servers
    - `manage` - View server status with interactive start/stop/restart controls
    - `update` - Update server configuration
    - `remove` - Remove a registered server

## Local Development Setup

This project uses `@pookiesoft/bongbot-core` from GitHub Packages (private). You'll need a GitHub Personal Access Token to install dependencies.

1. **Create a GitHub Classic PAT**:
    - Go to **GitHub Settings > Developer settings > Personal access tokens > Tokens (classic)**
    - Generate a new token with the `read:packages` scope
    - Ensure the token is authorized for the **PookieSoft** organization

2. **Set the token in your environment**:

    ```bash
    echo 'export NODE_AUTH_TOKEN=ghp_yourTokenHere' >> ~/.bashrc
    source ~/.bashrc
    ```

3. **Install dependencies**:

    ```bash
    npm install
    ```

4. **Build and run locally with Docker**:
    ```bash
    docker build --secret id=NODE_AUTH_TOKEN,env=NODE_AUTH_TOKEN -t bongbot-ptero .
    docker run --env-file .env --volume ./data:/app/data --volume ./logs:/app/logs bongbot-ptero
    ```

## Issues

Track bugs and follow-up work in [GitHub Issues](https://github.com/PookieSoft/BongBot-Ptero/issues).

## Contributing

1. Create a feature branch: `git checkout -b feature-name`
2. Make your changes and add tests
3. Run tests: `npm test`
4. Commit your changes: `git commit -am 'Add feature'`
5. Push to the branch: `git push origin feature-name`
6. Submit a pull request

If you used AI to write any part of it, read [AI Contributions](CONTRIBUTING.md#ai-contributions) before opening the pull request.

## Testing

The bot includes comprehensive test coverage using Jest:

```bash
# Run all tests
npm test

# Run tests with coverage report
npm test -- --coverage

# Run specific test file
npm test -- tests/commands/pterodactyl/register_server.test.ts
```

## License

This project is open source and available under the [MIT License](LICENSE).
