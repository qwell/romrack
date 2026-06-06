import { build } from 'vite';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readAppVersion } from '../src/shared/scripts.js';

const root = process.cwd();

async function copyFileIntoDist(relativePath: string) {
    const source = path.join(root, relativePath);
    if (!existsSync(source)) {
        return;
    }

    const destination = path.join(root, 'dist', relativePath);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(source, destination);
}

async function copyFiles() {
    await copyFileIntoDist('titles/titles.json');
    await copyFileIntoDist('titles/wiiutdb.json');
}

async function main() {
    await fs.mkdir(path.join(root, 'dist'), { recursive: true });
    const version = await readAppVersion(root);

    await Promise.all([
        // server
        build({
            configFile: false,
            mode: 'production',
            ssr: {
                noExternal: true,
            },
            build: {
                ssr: path.join(root, 'src/server/index.ts'),
                outDir: path.join(root, 'dist/server'),
                emptyOutDir: true,
                sourcemap: true,
            },
        }),

        // client
        build({
            configFile: false,
            mode: 'production',
            root: path.join(root, 'src/client'),
            publicDir: false,
            define: {
                __APP_VERSION__: JSON.stringify(version),
            },
            build: {
                outDir: path.join(root, 'dist/client'),
                emptyOutDir: true,
                sourcemap: true,
            },
        }),

        // other
        copyFiles(),
    ]);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
