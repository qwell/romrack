export type Fat32Volume = {
    label: string | null;
    fileSystem: 'FAT32';
    source: string;
    sizeBytes: number | null;
    freeBytes: number | null;
};

export type OsOperations = {
    listFat32Volumes: () => Promise<Fat32Volume[]>;
};
