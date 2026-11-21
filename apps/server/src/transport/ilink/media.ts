import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  ILinkApiClient,
} from "./api-client.js";
import {
  ILinkCdnMedia,
  ILinkGetUploadUrlResponse,
  ILinkMessageItemType,
  ILinkMessageState,
  ILinkMessageType,
  ILinkSendMessageRequest,
  ILinkUploadMediaType,
  ILinkUploadMediaTypeValue,
} from "./protocol.js";
import { splitWechatText } from "./text-chunks.js";

const CDN_UPLOAD_RETRIES = 3;
const CDN_DOWNLOAD_TIMEOUT_MS = 60_000;

function aesEcbPaddedSize(plaintextSize: number): number {
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function encryptAesEcb(plaintext: Buffer, aesKey: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", aesKey, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

function decryptAesEcb(ciphertext: Buffer, aesKey: Buffer): Buffer {
  const decipher = crypto.createDecipheriv("aes-128-ecb", aesKey, null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function parseAesKey(value: string): Buffer {
  const trimmed = value.trim();
  if (/^[0-9a-fA-F]{32}$/.test(trimmed)) {
    return Buffer.from(trimmed, "hex");
  }

  const decoded = Buffer.from(trimmed, "base64");
  if (decoded.length === 16) {
    return decoded;
  }

  const decodedText = decoded.toString("utf8").trim();
  if (/^[0-9a-fA-F]{32}$/.test(decodedText)) {
    return Buffer.from(decodedText, "hex");
  }

  throw new Error("Unsupported iLink media AES key encoding");
}

function buildUploadUrl(params: {
  cdnBaseUrl: string;
  uploadParam: string;
  fileKey: string;
  uploadFullUrl?: string;
}): string {
  if (params.uploadFullUrl) {
    return params.uploadFullUrl;
  }

  return `${params.cdnBaseUrl}/upload?encrypted_query_param=${encodeURIComponent(
    params.uploadParam,
  )}&filekey=${encodeURIComponent(params.fileKey)}`;
}

function buildDownloadUrl(params: {
  cdnBaseUrl: string;
  encryptedQueryParam: string;
}): string {
  return `${params.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(
    params.encryptedQueryParam,
  )}`;
}

function describeUploadUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "[invalid upload url]";
  }
}

function createClientId(): string {
  return `baotuo-ai-family-${crypto.randomUUID()}`;
}

function detectUploadMediaType(filePath: string): ILinkUploadMediaTypeValue {
  return /\.(?:jpe?g|png|gif|webp)$/i.test(filePath)
    ? ILinkUploadMediaType.IMAGE
    : ILinkUploadMediaType.FILE;
}

export interface UploadedIlinkMedia {
  fileKey: string;
  fileName: string;
  plaintextSize: number;
  ciphertextSize: number;
  plaintextMd5: string;
  aesKeyHex: string;
  downloadEncryptedQueryParam: string;
  mediaType: ILinkUploadMediaTypeValue;
}

export async function uploadEncryptedBufferToCdn(params: {
  buffer: Buffer;
  uploadParams: ILinkGetUploadUrlResponse;
  cdnBaseUrl: string;
  fileKey: string;
  aesKey: Buffer;
  signal?: AbortSignal;
}): Promise<string> {
  const ciphertext = encryptAesEcb(params.buffer, params.aesKey);
  const url = buildUploadUrl({
    cdnBaseUrl: params.cdnBaseUrl,
    uploadParam: params.uploadParams.upload_param ?? "",
    fileKey: params.fileKey,
    ...(params.uploadParams.upload_full_url
      ? { uploadFullUrl: params.uploadParams.upload_full_url }
      : {}),
  });
  const uploadTarget = describeUploadUrl(url);

  let lastError: unknown;

  for (let attempt = 1; attempt <= CDN_UPLOAD_RETRIES; attempt += 1) {
    try {
      params.signal?.throwIfAborted();
      const response = await fetch(url, {
        signal: params.signal ? AbortSignal.any([params.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
        },
        body: new Uint8Array(ciphertext),
      });

      if (response.status >= 400 && response.status < 500) {
        const message =
          response.headers.get("x-error-message") ?? (await response.text());
        throw new Error(
          `CDN upload client error ${response.status} at ${uploadTarget}: ${message}`,
        );
      }

      if (response.status !== 200) {
        const message =
          response.headers.get("x-error-message") ?? `status ${response.status}`;
        throw new Error(`CDN upload server error at ${uploadTarget}: ${message}`);
      }

      const encryptedParam = response.headers.get("x-encrypted-param");
      if (!encryptedParam) {
        throw new Error(
          "CDN upload succeeded but response is missing x-encrypted-param",
        );
      }

      return encryptedParam;
    } catch (error) {
      lastError = error;
      if (params.signal?.aborted) throw error;
      if (
        error instanceof Error &&
        error.message.includes("client error")
      ) {
        throw error;
      }
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("CDN upload failed after retries");
}

export async function downloadEncryptedMediaFromCdn(params: {
  client: ILinkApiClient;
  media: ILinkCdnMedia;
  aesKeyOverride?: string;
  maxPlaintextBytes: number;
  expectedMd5?: string;
  expectedSize?: number;
}): Promise<Buffer> {
  const encryptedQueryParam = params.media.encrypt_query_param?.trim();
  const encodedAesKey =
    params.aesKeyOverride?.trim() || params.media.aes_key?.trim();
  if (!encryptedQueryParam) {
    throw new Error("Inbound media is missing encrypt_query_param");
  }
  if (!encodedAesKey) {
    throw new Error("Inbound media is missing aes_key");
  }

  if (
    params.expectedSize !== undefined &&
    params.expectedSize > params.maxPlaintextBytes
  ) {
    throw new Error(
      `Inbound media is too large: ${params.expectedSize} bytes`,
    );
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CDN_DOWNLOAD_TIMEOUT_MS);

  try {
    const response = await fetch(
      buildDownloadUrl({
        cdnBaseUrl: params.client.cdnBaseUrl,
        encryptedQueryParam,
      }),
      {
        method: "GET",
        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const message =
        response.headers.get("x-error-message") ?? (await response.text());
      throw new Error(`CDN download failed ${response.status}: ${message}`);
    }

    const ciphertext = Buffer.from(await response.arrayBuffer());
    const plaintext = decryptAesEcb(ciphertext, parseAesKey(encodedAesKey));
    if (plaintext.length > params.maxPlaintextBytes) {
      throw new Error(`Inbound media is too large: ${plaintext.length} bytes`);
    }

    if (
      params.expectedSize !== undefined &&
      plaintext.length !== params.expectedSize
    ) {
      throw new Error(
        `Inbound media size mismatch: expected ${params.expectedSize}, got ${plaintext.length}`,
      );
    }

    if (params.expectedMd5) {
      const actualMd5 = crypto.createHash("md5").update(plaintext).digest("hex");
      if (actualMd5.toLowerCase() !== params.expectedMd5.toLowerCase()) {
        throw new Error("Inbound media MD5 mismatch");
      }
    }

    return plaintext;
  } finally {
    clearTimeout(timer);
  }
}

export async function uploadLocalMedia(params: {
  client: ILinkApiClient;
  filePath: string;
  toUserId: string;
  signal?: AbortSignal;
}): Promise<UploadedIlinkMedia> {
  const buffer = await fs.readFile(params.filePath, params.signal ? { signal: params.signal } : {});
  const mediaType = detectUploadMediaType(params.filePath);
  const fileKey = crypto.randomBytes(16).toString("hex");
  const aesKey = crypto.randomBytes(16);
  const plaintextSize = buffer.length;
  const plaintextMd5 = crypto.createHash("md5").update(buffer).digest("hex");
  const ciphertextSize = aesEcbPaddedSize(plaintextSize);

  const uploadParams = await params.client.getUploadUrl({
    filekey: fileKey,
    media_type: mediaType,
    to_user_id: params.toUserId,
    rawsize: plaintextSize,
    rawfilemd5: plaintextMd5,
    filesize: ciphertextSize,
    no_need_thumb: true,
    aeskey: aesKey.toString("hex"),
  });

  if (!uploadParams.upload_param && !uploadParams.upload_full_url) {
    throw new Error(
      `getUploadUrl did not return upload parameters: ${JSON.stringify(uploadParams)}`,
    );
  }

  const downloadEncryptedQueryParam = await uploadEncryptedBufferToCdn({
    buffer,
    uploadParams,
    cdnBaseUrl: params.client.cdnBaseUrl,
    fileKey,
    aesKey,
    ...(params.signal ? { signal: params.signal } : {}),
  });

  return {
    fileKey,
    fileName: path.basename(params.filePath),
    plaintextSize,
    ciphertextSize,
    plaintextMd5,
    aesKeyHex: aesKey.toString("hex"),
    downloadEncryptedQueryParam,
    mediaType,
  };
}

export async function sendTextMessage(params: {
  client: ILinkApiClient;
  toUserId: string;
  contextToken: string;
  text: string;
}): Promise<string> {
  let lastClientId = "";
  const chunks = splitWechatText(params.text);

  for (const [index, text] of chunks.entries()) {
    const clientId = createClientId();
    const request: ILinkSendMessageRequest = {
      msg: {
        from_user_id: "",
        to_user_id: params.toUserId,
        client_id: clientId,
        message_type: ILinkMessageType.BOT,
        message_state: ILinkMessageState.FINISH,
        context_token: params.contextToken,
        item_list: [
          {
            type: ILinkMessageItemType.TEXT,
            text_item: {
              text,
            },
          },
        ],
      },
    };

    assertSendMessageSucceeded(await params.client.sendMessage(request), clientId);
    lastClientId = clientId;
    if (index < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }

  return lastClientId;
}

export async function sendUploadedFileMessage(params: {
  client: ILinkApiClient;
  toUserId: string;
  contextToken: string;
  uploaded: UploadedIlinkMedia;
  caption?: string;
}): Promise<string> {
  let lastClientId = "";

  if (params.caption?.trim()) {
    lastClientId = await sendTextMessage({
      client: params.client,
      toUserId: params.toUserId,
      contextToken: params.contextToken,
      text: params.caption.trim(),
    });
  }

  const clientId = createClientId();
  const encodedAesKey = Buffer.from(params.uploaded.aesKeyHex, "utf8").toString(
    "base64",
  );
  const media: ILinkCdnMedia = {
    encrypt_query_param: params.uploaded.downloadEncryptedQueryParam,
    aes_key: encodedAesKey,
    encrypt_type: 1,
  };
  const item = params.uploaded.mediaType === ILinkUploadMediaType.IMAGE
    ? {
        type: ILinkMessageItemType.IMAGE,
        image_item: {
          media,
          aeskey: params.uploaded.aesKeyHex,
          mid_size: params.uploaded.ciphertextSize,
        },
      }
    : {
        type: ILinkMessageItemType.FILE,
        file_item: {
          file_name: params.uploaded.fileName,
          md5: params.uploaded.plaintextMd5,
          len: String(params.uploaded.plaintextSize),
          media,
        },
      };
  const request: ILinkSendMessageRequest = {
    msg: {
      from_user_id: "",
      to_user_id: params.toUserId,
      client_id: clientId,
      message_type: ILinkMessageType.BOT,
      message_state: ILinkMessageState.FINISH,
      context_token: params.contextToken,
      item_list: [
        item,
      ],
    },
  };

  assertSendMessageSucceeded(await params.client.sendMessage(request), clientId);
  return clientId || lastClientId;
}

function assertSendMessageSucceeded(
  response: { ret?: number; errmsg?: string },
  clientId: string,
): void {
  if (response.ret === undefined || response.ret === 0) {
    return;
  }

  throw new Error(
    `iLink sendmessage failed for ${clientId}: ret=${response.ret}${
      response.errmsg ? ` ${response.errmsg}` : ""
    }`,
  );
}

export async function uploadAndSendFileMessage(params: {
  client: ILinkApiClient;
  filePath: string;
  toUserId: string;
  contextToken: string;
  caption?: string;
}): Promise<UploadedIlinkMedia> {
  const uploaded = await uploadLocalMedia({
    client: params.client,
    filePath: params.filePath,
    toUserId: params.toUserId,
  });

  await sendUploadedFileMessage({
    client: params.client,
    toUserId: params.toUserId,
    contextToken: params.contextToken,
    uploaded,
    ...(params.caption ? { caption: params.caption } : {}),
  });

  return uploaded;
}
