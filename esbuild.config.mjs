import esbuild from 'esbuild';
import { copyFileSync, cpSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

const nativeModulePlugin = {
    name: 'native-module-plugin',
    setup(build) {
        build.onLoad({ filter: /\.node$/ }, (args) => {
            return {
                contents: `
                    import { createRequire } from 'module';
                    const require = createRequire(import.meta.url);
                    module.exports = require(${JSON.stringify(args.path)});
                `,
                loader: 'js',
            };
        });
    },
};

const isWatch = process.argv.includes('--watch');
const minify = process.argv.includes('--minify');
const isLib = process.argv.includes('--lib');

const standaloneBuildOptions = {
    entryPoints: ['src/standalone.ts'],
    bundle: true,
    platform: 'node',
    target: 'esnext',
    format: 'esm',
    outdir: 'dist',
    external: ['node:*'],
    banner: {
        js: 'import { createRequire } from "module"; import { fileURLToPath } from "url"; import { dirname } from "path"; const require = createRequire(import.meta.url); const __filename = fileURLToPath(import.meta.url); const __dirname = dirname(__filename);',
    },
    plugins: [nativeModulePlugin],
    minify: true,
    sourcemap: true,
    keepNames: true,
    sourcesContent: true,
    loader: {
        '.node': 'copy',
    },
};

const libBuildOptions = {
    entryPoints: ['src/index.ts'],
    bundle: true,
    platform: 'node',
    target: 'esnext',
    format: 'esm',
    outdir: 'dist',
    external: ['node:*', 'discord.js', 'better-sqlite3'],
    plugins: [nativeModulePlugin],
    minify: false,
    sourcemap: true,
    keepNames: true,
};

const buildOptions = isLib ? libBuildOptions : standaloneBuildOptions;

// Copy better-sqlite3 native bindings after build. The destination is the path
// the bundled output probes at runtime — <bundle dir>/../build/Release — since
// better-sqlite3's loader resolves relative to its own __dirname, which esbuild
// collapses into the bundle's directory.
function copyNativeBindings() {
    const sqlitePath = findNativeBinding();
    const destDir = 'build/Release';

    if (!sqlitePath) {
        throw new Error(`Native binding not found for better-sqlite3 (${bindingTarget()})`);
    }

    try {
        if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
        }

        copyFileSync(sqlitePath, join(destDir, 'better_sqlite3.node'));
        console.log(`✓ Copied native SQLite binding from ${sqlitePath}`);
    } catch (error) {
        throw new Error(`Error copying native bindings: ${error.message}`);
    }
}

// better-sqlite3 v13 dropped prebuild-install and ships prebuilt binaries in the
// package itself; v12 and earlier downloaded or compiled build/Release at install
// time. Support both so the build works either side of the version bump.
function findNativeBinding() {
    return [
        `node_modules/better-sqlite3/prebuilds/${bindingTarget()}.node`,
        'node_modules/better-sqlite3/build/Release/better_sqlite3.node',
    ].find(existsSync);
}

function bindingTarget() {
    const isLinuxMusl = process.platform === 'linux' && !process.report.getReport().header.glibcVersionRuntime;

    return `${isLinuxMusl ? 'linuxmusl' : process.platform}-${process.arch}`;
}

// Copy bongbot-core response files to dist
function copyCoreResponses() {
    const coreResponsesDir = 'node_modules/@pookiesoft/bongbot-core/dist/responses';
    const destDir = 'dist/responses';

    if (!existsSync(coreResponsesDir)) {
        console.warn('⚠ bongbot-core responses not found, skipping copy');
        return;
    }

    try {
        if (!existsSync(destDir)) {
            mkdirSync(destDir, { recursive: true });
        }
        cpSync(coreResponsesDir, destDir, { recursive: true });
        console.log('✓ Copied core response files');
    } catch (error) {
        throw new Error(`Error copying core responses: ${error.message}`);
    }
}

if (isWatch) {
    const ctx = await esbuild.context(buildOptions);
    await ctx.watch();
    console.log('Watching for changes...');
} else {
    await esbuild.build(buildOptions);
    // The lib build keeps better-sqlite3 external, so consumers resolve the
    // binding from their own node_modules — nothing to copy.
    if (!isLib) {
        copyNativeBindings();
    }
    copyCoreResponses();
    console.log('Build complete!');
}
