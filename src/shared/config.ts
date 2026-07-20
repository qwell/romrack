export type AppConfig = {
    host: string;
    port: number;
    openBrowser: boolean;
    '3dsRoots': string[];
    gamecubeRoots: string[];
    wiiRoots: string[];
    wiiuRoots: string[];
};

export type AppConfigUpdate = Partial<AppConfig>;

export type AppConfigResponse = {
    config: AppConfig;
    restartRequired: boolean;
};

export type AppConfigValidateRootResponse = {
    exists: boolean;
    isDirectory: boolean;
    readable: boolean;
    message: string;
};
