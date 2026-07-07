import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import { readAppVersion } from '../src/shared/scripts.js';

const execFileAsync = promisify(execFile);

const RELEASE_NAME = 'romrack';

const ROOT_DIR = process.cwd();
const RELEASE_ROOT = path.join(ROOT_DIR, 'release');
const LAUNCHER_DIR = path.join(ROOT_DIR, 'scripts', 'launcher');

type ReleaseMode = 'all' | 'stage' | 'zip';

type ReleaseTarget = {
    name: string;
    goos: string;
    goarch: string;
    launcherFileName: string;
};

const RELEASE_TARGETS: ReleaseTarget[] = [
    {
        name: 'windows-x64',
        goos: 'windows',
        goarch: 'amd64',
        launcherFileName: `${RELEASE_NAME}.exe`,
    },
    {
        name: 'windows-arm64',
        goos: 'windows',
        goarch: 'arm64',
        launcherFileName: `${RELEASE_NAME}.exe`,
    },
    {
        name: 'linux-x64',
        goos: 'linux',
        goarch: 'amd64',
        launcherFileName: RELEASE_NAME,
    },
    {
        name: 'linux-arm64',
        goos: 'linux',
        goarch: 'arm64',
        launcherFileName: RELEASE_NAME,
    },
    {
        name: 'macos-x64',
        goos: 'darwin',
        goarch: 'amd64',
        launcherFileName: RELEASE_NAME,
    },
    {
        name: 'macos-arm64',
        goos: 'darwin',
        goarch: 'arm64',
        launcherFileName: RELEASE_NAME,
    },
];

const ROOT_RELEASE_FILES = [
    'CHANGELOG.md',
    'CODE_OF_CONDUCT.md',
    'CONTRIBUTING.md',
    'README.md',
    'SECURITY.md',
];

function readReleaseMode(): ReleaseMode {
    const mode = process.argv[2] ?? 'all';

    if (mode === 'all' || mode === 'stage' || mode === 'zip') {
        return mode;
    }

    throw new Error(
        `Unknown release mode: ${mode}. Expected all, stage, or zip.`
    );
}

function getTargetOutputDir(target: ReleaseTarget): string {
    return path.join(RELEASE_ROOT, `${RELEASE_NAME}-${target.name}`);
}

function getTargetZipPath(version: string, target: ReleaseTarget): string {
    return path.join(
        RELEASE_ROOT,
        `${RELEASE_NAME}-${version}-${target.name}.zip`
    );
}

async function copyAppFiles(outputDir: string): Promise<void> {
    const appDir = path.join(outputDir, 'app');

    await fs.mkdir(appDir, { recursive: true });

    await fs.cp(path.join(ROOT_DIR, 'dist'), appDir, {
        recursive: true,
    });

    await fs.writeFile(
        path.join(appDir, 'package.json'),
        `${JSON.stringify({ type: 'module' }, null, 4)}\n`
    );
}

async function copyRootFiles(outputDir: string): Promise<void> {
    for (const fileName of ROOT_RELEASE_FILES) {
        await fs.cp(
            path.join(ROOT_DIR, fileName),
            path.join(outputDir, fileName)
        );
    }
}

async function buildLauncher(
    target: ReleaseTarget,
    outputDir: string
): Promise<void> {
    const outputPath = path.join(outputDir, target.launcherFileName);

    console.log(`[release] building ${target.name} launcher`);

    const { stdout, stderr } = await execFileAsync(
        'go',
        ['build', '-o', outputPath, '.'],
        {
            cwd: LAUNCHER_DIR,
            env: {
                ...process.env,
                GOOS: target.goos,
                GOARCH: target.goarch,
            },
        }
    );

    if (stdout) {
        process.stdout.write(stdout);
    }

    if (stderr) {
        process.stderr.write(stderr);
    }

    if (target.goos !== 'windows') {
        await fs.chmod(outputPath, 0o755);
    }
}

async function createReleaseZip(
    outputDir: string,
    zipPath: string
): Promise<void> {
    await fs.rm(zipPath, { force: true });

    const zip = new AdmZip();
    zip.addLocalFolder(outputDir);
    zip.writeZip(zipPath);

    console.log(`[release] wrote ${zipPath}`);
}

async function stageTargetRelease(target: ReleaseTarget): Promise<void> {
    const outputDir = getTargetOutputDir(target);

    await fs.rm(outputDir, { recursive: true, force: true });
    await fs.mkdir(outputDir, { recursive: true });
    await fs.mkdir(path.join(outputDir, 'runtime'), { recursive: true });

    await copyAppFiles(outputDir);
    await copyRootFiles(outputDir);
    await buildLauncher(target, outputDir);

    console.log(`[release] staged ${outputDir}`);
}

async function zipTargetRelease(
    version: string,
    target: ReleaseTarget
): Promise<void> {
    const outputDir = getTargetOutputDir(target);
    const zipPath = getTargetZipPath(version, target);

    const launcherPath = path.join(outputDir, target.launcherFileName);

    try {
        await fs.access(launcherPath);
    } catch {
        throw new Error(
            `Cannot zip ${target.name}. Missing staged launcher: ${launcherPath}`
        );
    }

    await createReleaseZip(outputDir, zipPath);
}

async function stageRelease(): Promise<void> {
    await fs.mkdir(RELEASE_ROOT, { recursive: true });

    for (const target of RELEASE_TARGETS) {
        await stageTargetRelease(target);
    }
}

async function zipRelease(version: string): Promise<void> {
    await fs.mkdir(RELEASE_ROOT, { recursive: true });

    for (const target of RELEASE_TARGETS) {
        await zipTargetRelease(version, target);
    }
}

async function main(): Promise<void> {
    const mode = readReleaseMode();
    const version = await readAppVersion(ROOT_DIR);

    if (mode === 'stage') {
        await stageRelease();
        return;
    }

    if (mode === 'zip') {
        await zipRelease(version);
        return;
    }

    await stageRelease();
    await zipRelease(version);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
