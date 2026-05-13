import type { Fat32Volume } from './types.js';

function normalizePathGlyphs(value: string): string {
    return value.replaceAll('\uf03a', ':').replaceAll('\uf05c', '\\');
}

export function normalizePath(value: string | null): string | null {
    if (value === null) {
        return null;
    }

    return normalizePathGlyphs(value)
        .trim()
        .replace(/[\\/]+$/, '');
}

function getPathSeparator(value: string): '/' | '\\' {
    return /^[A-Z]:/i.test(value) || value.includes('\\') ? '\\' : '/';
}

function appendStorageDestination(root: string, destination: string): string {
    const normalizedRoot = normalizePath(root) ?? root;
    const normalizedDestination = normalizePathGlyphs(destination).replace(
        /^[\\/]+|[\\/]+$/g,
        ''
    );
    if (!normalizedDestination) {
        return normalizedRoot;
    }

    const separator = getPathSeparator(normalizedRoot);
    return `${normalizedRoot}${separator}${normalizedDestination.replaceAll(
        separator === '\\' ? '/' : '\\',
        separator
    )}`;
}

function containsStorageDestination(
    root: string | null,
    destination: string
): boolean {
    const normalizedRoot = normalizePath(root)?.toLowerCase() ?? null;
    const normalizedDestination = normalizePath(destination)?.toLowerCase();
    if (!normalizedRoot || !normalizedDestination) {
        return false;
    }

    if (normalizedDestination === normalizedRoot) {
        return true;
    }

    return (
        normalizedDestination.startsWith(`${normalizedRoot}/`) ||
        normalizedDestination.startsWith(`${normalizedRoot}\\`)
    );
}

function getContainedStorageDestination(
    root: string,
    destination: string
): string {
    const normalizedRoot = normalizePath(root) ?? root;
    const normalizedDestination = normalizePath(destination) ?? destination;
    if (normalizedDestination.toLowerCase() === normalizedRoot.toLowerCase()) {
        return root;
    }

    const relativeDestination = normalizedDestination.slice(
        normalizedRoot.length
    );
    return appendStorageDestination(normalizedRoot, relativeDestination);
}

export function resolveStorageDestination(
    volume: Fat32Volume,
    destination: string
): Fat32Volume | null {
    if (containsStorageDestination(volume.source, destination)) {
        return {
            ...volume,
            source: getContainedStorageDestination(volume.source, destination),
        };
    }

    return null;
}
