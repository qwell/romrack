export type Fat32Volume = {
    label: string | null;
    fileSystem: 'FAT32';
    source: string;
    sizeBytes: number | null;
    freeBytes: number | null;
};

export type RuntimeOs = 'windows' | 'linux' | 'wsl2' | 'macos' | 'unsupported';

export type OsOperations = {
    listFat32Volumes: () => Promise<Fat32Volume[]>;
};
