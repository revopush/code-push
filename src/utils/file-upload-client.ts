import * as fs from "fs";
import * as path from "path";
import superagent = require("superagent");

// Drop-in replacement for `appcenter-file-upload-client`: implements the same
// chunked-upload protocol over the `superagent` dependency the SDK already ships.

export interface IProgress {
    percentCompleted: number;
    averageSpeedInMbps: number;
    secondsRemaining: number;
}

export interface IFileUploadClientSettings {
    assetId: string;
    assetDomain: string;
    assetToken: string;
    file: string;
    onProgressChanged?: (progress: IProgress) => void;
}

export interface IUploadResults {
    assetId: string;
    secureDownloadUrl: string;
    publicDownloadUrl: string;
    totalTimeInSeconds: number;
    averageSpeedInMbps: number;
}

export default class FileUploadClient {
    public upload(settings: IFileUploadClientSettings): Promise<IUploadResults> {
        return new Uploader(settings).run();
    }
}

const Endpoints = {
    SetMetadata: "/upload/set_metadata/",
    UploadChunk: "/upload/upload_chunk/",
    UploadFinished: "/upload/finished/",
} as const;

const MAX_CONCURRENT_UPLOADS = 10;
const MAX_CHUNK_RETRIES = 3;
const MAX_FINISH_RETRIES = 5;
const FAIL_TO_UPLOAD_MSG = "The asset cannot be uploaded. Try creating a new one";

// Endpoint responses (the service is inconsistent about `error` vs `Error`).
interface MetadataResponse {
    error?: boolean;
    Error?: boolean;
    message?: string;
    chunk_size: number;
    chunk_list?: number[];
}

interface FinishResponse {
    error?: boolean;
    message?: string;
    state?: string;
    absolute_uri?: string;
    missing_chunks?: number[];
}

interface ChunkResponse {
    error?: boolean;
    Error?: boolean;
}

/** Runs a single file upload; one instance per upload. */
class Uploader {
    private readonly startTime = Date.now();
    private fileHandle: fs.promises.FileHandle;
    private fileSize: number;
    private chunkSize: number;
    private totalBlocks: number;
    private blocksCompleted = 0;

    constructor(private readonly settings: IFileUploadClientSettings) {}

    public async run(): Promise<IUploadResults> {
        this.fileSize = fs.statSync(this.settings.file).size;
        if (!this.fileSize) {
            throw new Error("Uploaded file is not valid");
        }

        let chunks = await this.setMetadata();
        this.blocksCompleted = this.totalBlocks - chunks.length;

        this.fileHandle = await fs.promises.open(this.settings.file, "r");
        try {
            // Upload pending chunks, then finalize; re-upload any the server missed.
            for (let attempt = 0; ; attempt++) {
                await this.uploadChunks(chunks);

                const finished = await this.finish();
                if (!finished.error && finished.state === "Done") {
                    return this.toResults(finished);
                }

                chunks = finished.missing_chunks || [];
                if (chunks.length === 0 || attempt >= MAX_FINISH_RETRIES) {
                    throw new Error(finished.message || FAIL_TO_UPLOAD_MSG);
                }
                this.blocksCompleted = this.totalBlocks - chunks.length;
            }
        } finally {
            await this.fileHandle.close();
        }
    }

    private async setMetadata(): Promise<number[]> {
        // content_type is empty: the SDK uploads by path and never sets one.
        const url = this.endpoint(Endpoints.SetMetadata, {
            file_name: path.basename(this.settings.file),
            file_Size: this.fileSize.toString(),
            content_type: "",
            token: this.settings.assetToken,
        });

        const body: MetadataResponse = (await this.post(url)).body || {};
        if (body.error || body.Error) {
            throw new Error(body.message || "Set metadata failed");
        }

        this.chunkSize = body.chunk_size;
        this.totalBlocks = Math.ceil(this.fileSize / this.chunkSize);
        return body.chunk_list || [];
    }

    private async uploadChunks(chunks: number[]): Promise<void> {
        const queue = chunks.slice();
        const retries = new Map<number, number>();

        const worker = async (): Promise<void> => {
            let chunkNumber: number;
            while ((chunkNumber = queue.shift()) !== undefined) {
                if (await this.uploadChunk(chunkNumber)) {
                    this.reportProgress();
                    continue;
                }

                const attempts = (retries.get(chunkNumber) || 0) + 1;
                if (attempts > MAX_CHUNK_RETRIES) {
                    throw new Error(`${FAIL_TO_UPLOAD_MSG} (chunk ${chunkNumber})`);
                }
                retries.set(chunkNumber, attempts);
                queue.push(chunkNumber);
            }
        };

        const workerCount = Math.min(MAX_CONCURRENT_UPLOADS, chunks.length);
        await Promise.all(Array.from({ length: workerCount }, worker));
    }

    private async uploadChunk(chunkNumber: number): Promise<boolean> {
        const chunk = await this.readChunk(chunkNumber);
        const url = this.endpoint(Endpoints.UploadChunk, {
            block_number: chunkNumber.toString(),
            token: this.settings.assetToken,
        });

        const body: ChunkResponse = (await this.postChunk(url, chunk)).body || {};
        return !(body.error || body.Error);
    }

    private async finish(): Promise<FinishResponse> {
        const url = this.endpoint(Endpoints.UploadFinished, { token: this.settings.assetToken });
        return (await this.post(url)).body || {};
    }

    private async readChunk(chunkNumber: number): Promise<Buffer> {
        // Chunk numbers are 1-based.
        const start = (chunkNumber - 1) * this.chunkSize;
        const length = Math.min(chunkNumber * this.chunkSize, this.fileSize) - start;
        const buffer = Buffer.alloc(length);
        await this.fileHandle.read(buffer, 0, length, start);
        return buffer;
    }

    private reportProgress(): void {
        this.blocksCompleted++;
        this.settings.onProgressChanged?.({
            percentCompleted: Math.min(100, Math.floor((this.blocksCompleted / this.totalBlocks) * 100)),
            averageSpeedInMbps: 0,
            secondsRemaining: 0,
        });
    }

    private toResults(finished: FinishResponse): IUploadResults {
        const downloadUrl = finished.absolute_uri || "";
        return {
            assetId: this.settings.assetId,
            secureDownloadUrl: downloadUrl + this.settings.assetToken,
            publicDownloadUrl: downloadUrl,
            totalTimeInSeconds: parseFloat(((Date.now() - this.startTime) / 1000).toFixed(1)),
            averageSpeedInMbps: 0,
        };
    }

    private endpoint(base: string, query: Record<string, string>): string {
        const params = Object.keys(query)
            .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(query[key])}`)
            .join("&");
        return `${this.settings.assetDomain}${base}${this.settings.assetId}?${params}`;
    }

    private post(url: string): superagent.SuperAgentRequest {
        return superagent.post(url).set("X-XblCorrelationId", this.settings.assetId).set("MS-CV", "");
    }

    private postChunk(url: string, chunk: Buffer): superagent.SuperAgentRequest {
        return this.post(url).set("Content-Type", "application/x-binary").send(chunk);
    }
}
