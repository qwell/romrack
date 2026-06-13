import path from 'path';
import { safeDirectoryName } from '../shared/string.js';
import {
    decryptContentWithBigIntIv,
    decryptTitleKey,
    encryptTitleKey,
    findGeneratedTitleKey,
} from './decryption.js';
import {
    downloadContent,
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
import { looksLikeFst } from './nus/fst.js';
import {
    CERT_TITLE_FILE,
    ContentInstallFiles,
    ContentTreeVerification,
    createGeneratedCert,
    downloadTitleContentFile,
    extractMetaXmlFromTitle,
    formatInstallDirectoryKind,
    GeneratedTitleInstallFiles,
    getContentInstallFiles,
    InstalledTitleValidation,
    InstalledTitleVerification,
    InstalledTitleVerificationProgress,
    normalizeDownloadableTitleId,
    readCommonKey,
    readMetaXml,
    readTikFromBuffer,
    readTikHeader,
    readTmd,
    readTmdFromBuffer,
    Tik,
    TIK_TITLE_FILE,
    TitleDownloadProgress,
    TitleMetadataError,
    Tmd,
    TmdContent,
    writeGeneratedTik,
} from './title.js';
import { mapConcurrent } from '../shared/shared.js';
import { mkdir, writeFile } from 'fs/promises';
import { normalizeTitleName } from '../shared/titles.js';
import { getTitleIdHex, TMD_TITLE_FILE } from './nus/tmd.js';
import { getImmediatePathSizeBytes } from '../shared/file.js';
import logger from '../shared/logger.js';
import { isHttpErrorStatus } from '../shared/download.js';

type ResolvedTitleKey = {
    titleKey: Uint8Array;
    decryptedFst: Uint8Array;
    encryptedTitleKey: Uint8Array | null;
    titleKeyPassword: string | null;
};

const TITLE_DOWNLOAD_CONCURRENCY = 8;

export function resolveTitleKey({
    commonKey,
    encryptedFst,
    normalizedTitleId,
    ticket,
    tmd,
}: {
    commonKey: Uint8Array;
    encryptedFst: Uint8Array;
    normalizedTitleId: string;
    ticket: Tik | null;
    tmd: Tmd;
}): ResolvedTitleKey {
    const ticketTitleKey =
        ticket !== null
            ? decryptTitleKey(ticket.encryptedKey, commonKey, ticket.titleId)
            : null;
    const ticketDecryptedFst =
        ticketTitleKey !== null
            ? decryptContentWithBigIntIv(encryptedFst, ticketTitleKey, 0)
            : null;

    if (
        ticket !== null &&
        ticketTitleKey !== null &&
        ticketDecryptedFst !== null &&
        looksLikeFst(ticketDecryptedFst)
    ) {
        return {
            titleKey: ticketTitleKey,
            decryptedFst: ticketDecryptedFst,
            encryptedTitleKey: ticket.encryptedKey,
            titleKeyPassword: null,
        };
    }

    const generatedMatch = findGeneratedTitleKey(
        tmd.header.titleId,
        (candidate) =>
            looksLikeFst(
                decryptContentWithBigIntIv(encryptedFst, candidate.titleKey, 0)
            )
    );

    if (!generatedMatch) {
        throw new TitleMetadataError(
            'resolve_title_key',
            `No usable title key produced an FST for ${normalizedTitleId}`
        );
    }

    return {
        titleKey: generatedMatch.titleKey,
        decryptedFst: decryptContentWithBigIntIv(
            encryptedFst,
            generatedMatch.titleKey,
            0
        ),
        encryptedTitleKey: encryptTitleKey(
            generatedMatch.titleKey,
            commonKey,
            tmd.header.titleId
        ),
        titleKeyPassword: generatedMatch.password,
    };
}

export async function generateTitleInstallFiles(
    titleId: string,
    romRoot: string,
    options: {
        onProgress?: (progress: TitleDownloadProgress) => void;
        signal?: AbortSignal;
    } = {}
): Promise<GeneratedTitleInstallFiles> {
    const baseUrl = NUS_BASE_URL;
    const { titleId: normalizedTitleId, kind } =
        normalizeDownloadableTitleId(titleId);
    const commonKey = await readCommonKey();
    throwIfAborted(options.signal);
    const tmdBytes = await downloadTmd(
        baseUrl,
        normalizedTitleId,
        options.signal
    );
    throwIfAborted(options.signal);
    const tmd = readTmdFromBuffer(Buffer.from(tmdBytes));

    if (!tmd) {
        throw new TitleMetadataError(
            'parse_tmd',
            `Failed to parse TMD for ${normalizedTitleId}`
        );
    }

    const fstContent = tmd.contents[0];
    if (!fstContent) {
        throw new TitleMetadataError(
            'missing_fst_content',
            `TMD has no first content entry for ${normalizedTitleId}`
        );
    }

    const encryptedFst = await downloadContent(
        baseUrl,
        normalizedTitleId,
        fstContent.id,
        options.signal
    );
    throwIfAborted(options.signal);
    const ticketBytes = await downloadTicket(
        baseUrl,
        normalizedTitleId,
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
            normalizedTitleId,
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
            `Failed to produce an encrypted title key for ${normalizedTitleId}`
        );
    }

    const metaXml = await extractMetaXmlFromTitle(
        decryptedFst,
        tmd,
        titleKey,
        baseUrl,
        normalizedTitleId,
        options.signal
    );
    const meta = metaXml ? readMetaXml(metaXml) : null;
    const directoryKind = formatInstallDirectoryKind(kind);
    const outputDir = path.join(
        romRoot,
        `${safeDirectoryName(meta?.name ?? normalizedTitleId)} [${directoryKind}] [${normalizedTitleId}]`
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
    let completedFiles = 0;

    const downloadedContentFiles = await mapConcurrent(
        tmd.contents,
        TITLE_DOWNLOAD_CONCURRENCY,
        async (content) => {
            throwIfAborted(options.signal);
            const downloadedContentFile = await downloadTitleContentFile({
                content,
                outputDir,
                baseUrl,
                titleId: normalizedTitleId,
                onFileStart: (currentFileName, currentFileSizeBytes) => {
                    options.onProgress?.({
                        outputDir,
                        completedFiles,
                        totalFiles,
                        currentFileName,
                        currentFileSizeBytes,
                    });
                },
                onFileComplete: (currentFileName, currentFileSizeBytes) => {
                    completedFiles += 1;
                    options.onProgress?.({
                        outputDir,
                        completedFiles,
                        totalFiles,
                        currentFileName,
                        currentFileSizeBytes,
                    });
                },
                signal: options.signal,
            });

            throwIfAborted(options.signal);
            completedFiles += downloadedContentFile.cachedFiles;

            return downloadedContentFile;
        }
    );

    for (const downloadedContentFile of downloadedContentFiles) {
        if (downloadedContentFile.app) {
            files.app.push(downloadedContentFile.app);
        }
        if (downloadedContentFile.h3) {
            files.h3.push(downloadedContentFile.h3);
        }
    }

    const name = normalizeTitleName(meta?.name ?? normalizedTitleId);
    const sizeBytes = await getImmediatePathSizeBytes(outputDir);

    logger.log(
        'metadata',
        `finished downloading: [${normalizedTitleId}] ${name} ${kind}`
    );

    return {
        titleId: normalizedTitleId,
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

export async function verifyTitleInstallFiles(
    dirPath: string,
    onProgress?: (progress: InstalledTitleVerificationProgress) => void
): Promise<InstalledTitleVerification> {
    const tmd = await readTmd(dirPath);
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
    } catch (error) {
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
        });
        const fileSizes = await validateInstalledContentFileSizes(
            dirPath,
            content
        );
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
}: {
    dirPath: string;
    content: TmdContent;
    files?: ContentInstallFiles;
    titleKey: Uint8Array;
}): Promise<ContentTreeVerification> {
    return verifyContentInstallFiles({
        files: files ?? getContentInstallFiles(dirPath, content),
        content,
        titleKey,
    });
}

function throwIfAborted(signal?: AbortSignal): void {
    signal?.throwIfAborted();
}
