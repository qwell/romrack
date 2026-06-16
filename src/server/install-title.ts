import path from 'path';
import { safeDirectoryName } from '../shared/string.js';
import { decryptTitleKey } from './decryption.js';
import {
    downloadContent,
    downloadContentH3ToFile,
    downloadContentToFile,
    downloadTicket,
    downloadTmd,
    NUS_BASE_URL,
} from './download-title.js';
import {
    assertExistingContentFileSize,
    getContentH3FileSize,
    getEncryptedContentFileSize,
    isHashedContent,
    verifyContentInstallFiles,
} from './nus/content.js';
import {
    CERT_TITLE_FILE,
    ContentInstallFiles,
    ContentTreeVerification,
    createGeneratedCert,
    extractMetaXmlFromTitle,
    formatInstallDirectoryKind,
    GeneratedTitleInstallFiles,
    getContentInstallFiles,
    InstalledTitleValidation,
    InstalledTitleVerification,
    InstalledTitleVerificationProgress,
    getDownloadableTitle,
    readCommonKey,
    readMetaXml,
    resolveTitleKey,
    readTikFromBuffer,
    readTikHeader,
    readTmd,
    readTmdFromBuffer,
    TIK_TITLE_FILE,
    TitleDownloadProgress,
    TitleMetadataError,
    TmdContent,
    writeGeneratedTik,
} from './title.js';
import { mapConcurrent } from '../shared/shared.js';
import { mkdir, stat, writeFile } from 'fs/promises';
import { normalizeTitleName } from '../shared/titles.js';
import { getTitleIdHex, TMD_TITLE_FILE } from './nus/tmd.js';
import { getImmediatePathSizeBytes } from '../shared/file.js';
import logger from '../shared/logger.js';
import { isHttpErrorStatus } from '../shared/download.js';

const TITLE_DOWNLOAD_CONCURRENCY = 8;

type TitleContentDownload = {
    content: TmdContent;
    files: ContentInstallFiles;
    appSizeBytes: number;
    appCached: boolean;
    h3SizeBytes: number | null;
    h3Available: boolean;
    h3Cached: boolean;
};

export async function generateTitleInstallFiles(
    titleId: string,
    romRoot: string,
    options: {
        onProgress?: (progress: TitleDownloadProgress) => void;
        signal?: AbortSignal;
    } = {}
): Promise<GeneratedTitleInstallFiles> {
    const baseUrl = NUS_BASE_URL;
    const { titleId: downloadableTitleId, kind } =
        getDownloadableTitle(titleId);
    const commonKey = await readCommonKey();
    throwIfAborted(options.signal);
    const tmdBytes = await downloadTmd(
        baseUrl,
        downloadableTitleId,
        options.signal
    );
    throwIfAborted(options.signal);
    const tmd = readTmdFromBuffer(Buffer.from(tmdBytes));

    if (!tmd) {
        throw new TitleMetadataError(
            'parse_tmd',
            `Failed to parse TMD for ${downloadableTitleId}`
        );
    }

    const fstContent = tmd.contents[0];
    if (!fstContent) {
        throw new TitleMetadataError(
            'missing_fst_content',
            `TMD has no first content entry for ${downloadableTitleId}`
        );
    }

    const encryptedFst = await downloadContent(
        baseUrl,
        downloadableTitleId,
        fstContent.id,
        options.signal
    );
    throwIfAborted(options.signal);
    const ticketBytes = await downloadTicket(
        baseUrl,
        downloadableTitleId,
        options.signal
    ).catch((error: unknown) => {
        if (isHttpErrorStatus(error, 404)) {
            return null;
        }

        throw error;
    });
    const ticket = ticketBytes
        ? readTikFromBuffer(Buffer.from(ticketBytes))
        : null;
    const { encryptedTitleKey, titleKey, decryptedFst, titleKeyPassword } =
        resolveTitleKey({
            commonKey,
            encryptedFst,
            normalizedTitleId: downloadableTitleId,
            ticket,
            tmd,
        });

    if (
        encryptedTitleKey === null ||
        titleKey === null ||
        decryptedFst === null
    ) {
        throw new TitleMetadataError(
            'resolve_title_key',
            `Failed to produce an encrypted title key for ${downloadableTitleId}`
        );
    }

    const metaXml = await extractMetaXmlFromTitle(
        decryptedFst,
        tmd,
        titleKey,
        baseUrl,
        downloadableTitleId,
        options.signal
    );
    const meta = metaXml ? readMetaXml(metaXml) : null;
    const directoryKind = formatInstallDirectoryKind(kind);
    const outputDir = path.join(
        romRoot,
        `${safeDirectoryName(meta?.name ?? downloadableTitleId)} [${directoryKind}] [${downloadableTitleId}]`
    );
    const tmdFile = path.join(outputDir, TMD_TITLE_FILE);
    const certFile = path.join(outputDir, CERT_TITLE_FILE);
    const files = {
        tmd: TMD_TITLE_FILE,
        tik: TIK_TITLE_FILE,
        cert: CERT_TITLE_FILE,
        app: [] as string[],
        h3: [] as string[],
    };
    await mkdir(outputDir, { recursive: true });

    options.onProgress?.({
        outputDir,
        completedFiles: 0,
        totalFiles: tmd.contents.reduce(
            (total, content) => total + (isHashedContent(content) ? 2 : 1),
            0
        ),
        currentFileName: null,
        currentFileSizeBytes: 0,
    });

    await Promise.all([
        writeFile(tmdFile, tmdBytes),
        writeGeneratedTik(outputDir, {
            titleId: tmd.header.titleId,
            encryptedTitleKey,
            titleVersion: tmd.header.titleVersion,
        }),
        writeFile(
            certFile,
            await createGeneratedCert(tmd, {
                ticketBytes: ticketBytes ?? undefined,
            })
        ),
    ]);

    const totalFiles = tmd.contents.reduce(
        (total, content) => total + (isHashedContent(content) ? 2 : 1),
        0
    );
    const contentDownloads: TitleContentDownload[] = await mapConcurrent(
        tmd.contents,
        TITLE_DOWNLOAD_CONCURRENCY,
        async (content) => {
            throwIfAborted(options.signal);
            const contentFiles = getContentInstallFiles(outputDir, content);
            const appSizeBytes = Number(getEncryptedContentFileSize(content));
            const appCached = await hasExpectedFileSize(
                contentFiles.appFile,
                appSizeBytes
            );
            const h3SizeBytes = isHashedContent(content)
                ? getContentH3FileSize(content)
                : null;
            const h3Cached =
                h3SizeBytes !== null &&
                contentFiles.h3File !== null &&
                (await hasExpectedFileSize(contentFiles.h3File, h3SizeBytes));

            return {
                content,
                files: contentFiles,
                appSizeBytes,
                appCached,
                h3SizeBytes,
                h3Available: !isHashedContent(content) || h3Cached,
                h3Cached,
            };
        }
    );

    let completedFiles = contentDownloads.reduce(
        (total, download) =>
            total + Number(download.appCached) + Number(download.h3Cached),
        0
    );
    const reportProgress = (
        currentFileName: string,
        currentFileSizeBytes: number,
        complete = false
    ): void => {
        if (complete) {
            completedFiles += 1;
        }
        options.onProgress?.({
            outputDir,
            completedFiles,
            totalFiles,
            currentFileName,
            currentFileSizeBytes,
        });
    };

    await mapConcurrent(
        contentDownloads.filter(
            (download) => download.h3SizeBytes !== null && !download.h3Cached
        ),
        TITLE_DOWNLOAD_CONCURRENCY,
        async (download) => {
            throwIfAborted(options.signal);
            const h3File = download.files.h3File;
            const h3Name = download.files.h3Name;
            const h3SizeBytes = download.h3SizeBytes;
            if (!h3File || !h3Name || h3SizeBytes === null) {
                return;
            }

            reportProgress(h3Name, h3SizeBytes);
            await downloadContentH3ToFile(
                baseUrl,
                downloadableTitleId,
                download.content.id,
                h3File,
                options.signal
            );
            download.h3Available = true;
            reportProgress(h3Name, h3SizeBytes, true);
        }
    );

    await mapConcurrent(
        contentDownloads.filter(
            (download) => download.h3Available && !download.appCached
        ),
        TITLE_DOWNLOAD_CONCURRENCY,
        async (download) => {
            throwIfAborted(options.signal);
            reportProgress(download.files.appName, download.appSizeBytes);
            await downloadContentToFile(
                baseUrl,
                downloadableTitleId,
                download.content.id,
                download.files.appFile,
                options.signal
            );
            reportProgress(download.files.appName, download.appSizeBytes, true);
        }
    );

    for (const download of contentDownloads) {
        if (!download.h3Available) {
            continue;
        }
        files.app.push(download.files.appName);
        if (download.files.h3Name) {
            files.h3.push(download.files.h3Name);
        }
    }

    const name = normalizeTitleName(meta?.name ?? downloadableTitleId);
    const sizeBytes = await getImmediatePathSizeBytes(outputDir);

    logger.log(
        'metadata',
        `finished downloading: [${downloadableTitleId}] ${name} ${kind}`
    );

    return {
        titleId: downloadableTitleId,
        kind,
        name,
        titleVersion: tmd.header.titleVersion,
        titleKey: Buffer.from(titleKey).toString('hex'),
        titleKeyPassword,
        outputDir,
        sizeBytes,
        files,
    };
}

async function hasExpectedFileSize(
    filePath: string,
    expectedSize: number
): Promise<boolean> {
    try {
        return (await stat(filePath)).size === expectedSize;
    } catch {
        return false;
    }
}

export async function verifyTitleInstallFiles(
    dirPath: string,
    onProgress?: (progress: InstalledTitleVerificationProgress) => void,
    signal?: AbortSignal
): Promise<InstalledTitleVerification> {
    throwIfAborted(signal);
    const tmd = await readTmd(dirPath);
    throwIfAborted(signal);
    if (!tmd) {
        return createFailedInstalledVerification(
            null,
            null,
            `Missing or invalid ${TMD_TITLE_FILE}`
        );
    }

    const titleId = getTitleIdHex(tmd.header.titleId);
    const titleVersion = tmd.header.titleVersion;
    const ticket = await readTikHeader(dirPath);
    throwIfAborted(signal);
    if (!ticket) {
        return createFailedInstalledVerification(
            titleId,
            titleVersion,
            `Missing or invalid ${TIK_TITLE_FILE}`
        );
    }

    let titleKey: Uint8Array;
    try {
        titleKey = decryptTitleKey(
            ticket.encryptedKey,
            await readCommonKey(),
            ticket.titleId
        );
        throwIfAborted(signal);
    } catch (error) {
        throwIfAborted(signal);
        return createFailedInstalledVerification(
            titleId,
            titleVersion,
            error instanceof Error ? error.message : String(error)
        );
    }

    const verification: ContentTreeVerification[] = [];
    let failedFileCount = 0;
    let totalFileCount = 0;
    for (const content of tmd.contents) {
        throwIfAborted(signal);
        const files = getContentInstallFiles(dirPath, content);
        onProgress?.({
            currentFileName: files.appName,
            currentFileSizeBytes: getEncryptedContentFileSize(content),
        });
        const result = await verifyInstalledContent({
            dirPath,
            content,
            files,
            titleKey,
            signal,
        });
        throwIfAborted(signal);
        const fileSizes = await validateInstalledContentFileSizes(
            dirPath,
            content
        );
        throwIfAborted(signal);
        verification.push(result);
        failedFileCount +=
            fileSizes.failedFileCount === 0 && result.status !== 'ok'
                ? 1
                : fileSizes.failedFileCount;
        totalFileCount += fileSizes.totalFileCount;
    }

    return {
        titleId,
        titleVersion,
        status: verification.every((result) => result.status === 'ok')
            ? 'ok'
            : 'failed',
        error: null,
        verification,
        failedFileCount,
        totalFileCount,
    };
}

export async function validateTitleInstallFileSizes(
    dirPath: string,
    signal?: AbortSignal
): Promise<InstalledTitleValidation> {
    throwIfAborted(signal);
    const tmd = await readTmd(dirPath);
    throwIfAborted(signal);
    if (!tmd) {
        return createFailedInstalledValidation(
            null,
            null,
            `Missing or invalid ${TMD_TITLE_FILE}`
        );
    }

    const titleId = getTitleIdHex(tmd.header.titleId);
    const titleVersion = tmd.header.titleVersion;
    let failedFileCount = 0;
    let totalFileCount = 0;

    for (const content of tmd.contents) {
        throwIfAborted(signal);
        const result = await validateInstalledContentFileSizes(
            dirPath,
            content
        );
        failedFileCount += result.failedFileCount;
        totalFileCount += result.totalFileCount;
    }

    return {
        titleId,
        titleVersion,
        status: failedFileCount === 0 ? 'ok' : 'failed',
        error: null,
        failedFileCount,
        totalFileCount,
    };
}

async function validateInstalledContentFileSizes(
    dirPath: string,
    content: TmdContent
): Promise<{
    failedFileCount: number;
    totalFileCount: number;
}> {
    const files = getContentInstallFiles(dirPath, content);
    const expectedSize = getEncryptedContentFileSize(content);
    let failedFileCount = 0;
    const totalFileCount = isHashedContent(content) ? 2 : 1;

    try {
        await assertExistingContentFileSize(
            files.appFile,
            expectedSize,
            files.contentId
        );
    } catch {
        failedFileCount += 1;
    }

    if (isHashedContent(content)) {
        try {
            if (!files.h3File) {
                throw new Error('Missing H3 file path for hashed content');
            }
            await assertExistingContentFileSize(
                files.h3File,
                getContentH3FileSize(content),
                files.contentId
            );
        } catch {
            failedFileCount += 1;
        }
    }

    return {
        failedFileCount,
        totalFileCount,
    };
}

function createFailedInstalledValidation(
    titleId: string | null,
    titleVersion: number | null,
    error: string
): InstalledTitleValidation {
    return {
        titleId,
        titleVersion,
        status: 'failed',
        error,
        failedFileCount: 0,
        totalFileCount: 0,
    };
}

function createFailedInstalledVerification(
    titleId: string | null,
    titleVersion: number | null,
    error: string
): InstalledTitleVerification {
    return {
        ...createFailedInstalledValidation(titleId, titleVersion, error),
        verification: [],
    };
}

function verifyInstalledContent({
    dirPath,
    content,
    files,
    titleKey,
    signal,
}: {
    dirPath: string;
    content: TmdContent;
    files?: ContentInstallFiles;
    titleKey: Uint8Array;
    signal?: AbortSignal;
}): Promise<ContentTreeVerification> {
    return verifyContentInstallFiles({
        files: files ?? getContentInstallFiles(dirPath, content),
        content,
        titleKey,
        signal,
    });
}

function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}
