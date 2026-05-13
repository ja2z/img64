import type { APIGatewayProxyResultV2 } from 'aws-lambda';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import * as crypto from 'crypto';

type AnyEvent = any;

const BUCKET = process.env.IMG64_BUCKET || 'big-buys-public';
const BUCKET_REGION = process.env.IMG64_BUCKET_REGION || 'us-west-1';
const KEY_PREFIX = process.env.IMG64_KEY_PREFIX || 'img64/';
const PUBLIC_URL_BASE = process.env.IMG64_PUBLIC_URL_BASE || 'https://d2le8l2yvdies6.cloudfront.net';
const MAX_DECODED_BYTES = Number(process.env.IMG64_MAX_BYTES || 10 * 1024 * 1024); // 10 MB

const s3 = new S3Client({ region: BUCKET_REGION });

// MIME ↔ extension map for the small set of image types we serve.
const MIME_TO_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/x-icon': 'ico',
    'image/vnd.microsoft.icon': 'ico',
    'image/avif': 'avif',
    'image/apng': 'png',
    'image/tiff': 'tiff',
};

interface ParsedInput {
    rawBase64: string;       // base64 without any data: prefix
    declaredType?: string;   // MIME from data URI or `type` param, if present
}

class HttpError extends Error {
    constructor(public statusCode: number, message: string) {
        super(message);
    }
}

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        ...extra,
    };
}

function jsonResponse(statusCode: number, body: any): APIGatewayProxyResultV2 {
    return {
        statusCode,
        headers: corsHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(body),
    };
}

function getMethod(event: AnyEvent): string {
    return (event.requestContext?.http?.method || event.httpMethod || 'GET').toUpperCase();
}

function readBodyString(event: AnyEvent): string {
    if (!event.body) return '';
    return event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
}

function parseInput(event: AnyEvent): ParsedInput {
    const body = readBodyString(event);
    if (!body) throw new HttpError(400, 'Empty request body');

    let dataField: string | undefined;
    let typeField: string | undefined;

    // Try JSON first; fall back to raw base64 / data-URI body
    if (body.trimStart().startsWith('{')) {
        let parsed: any;
        try {
            parsed = JSON.parse(body);
        } catch {
            throw new HttpError(400, 'Body looks like JSON but failed to parse');
        }
        dataField = typeof parsed.data === 'string' ? parsed.data : undefined;
        typeField = typeof parsed.type === 'string' ? parsed.type : undefined;
    } else {
        dataField = body.trim();
    }

    if (!dataField) throw new HttpError(400, 'Missing required field: data');

    // Strip data: URI prefix if present, e.g. "data:image/png;base64,iVBOR..."
    const dataUriMatch = dataField.match(/^data:([^;,]+)?(;base64)?,(.+)$/s);
    let rawBase64: string;
    let declaredType: string | undefined = typeField?.trim().toLowerCase() || undefined;

    if (dataUriMatch) {
        const [, mimeFromUri, hasBase64, payload] = dataUriMatch;
        if (!hasBase64) throw new HttpError(400, 'data URI must be base64-encoded');
        rawBase64 = payload;
        if (mimeFromUri && !declaredType) declaredType = mimeFromUri.toLowerCase();
    } else {
        rawBase64 = dataField;
    }

    // Strip whitespace/newlines that often sneak in via copy-paste
    rawBase64 = rawBase64.replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/=]+$/.test(rawBase64)) {
        throw new HttpError(400, 'data is not valid base64');
    }

    return { rawBase64, declaredType };
}

// Sniff image magic bytes. Returns MIME or null if unrecognized.
function sniffImageMime(buf: Buffer): string | null {
    if (buf.length < 4) return null;
    // PNG: 89 50 4E 47 0D 0A 1A 0A
    if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    // JPEG: FF D8 FF
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    // GIF: "GIF87a" or "GIF89a"
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) return 'image/gif';
    // WebP: "RIFF????WEBP"
    if (buf.length >= 12 && buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP') return 'image/webp';
    // BMP: "BM"
    if (buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp';
    // ICO: 00 00 01 00
    if (buf[0] === 0x00 && buf[1] === 0x00 && buf[2] === 0x01 && buf[3] === 0x00) return 'image/x-icon';
    // TIFF: "II*\0" or "MM\0*"
    if ((buf[0] === 0x49 && buf[1] === 0x49 && buf[2] === 0x2a && buf[3] === 0x00) ||
        (buf[0] === 0x4d && buf[1] === 0x4d && buf[2] === 0x00 && buf[3] === 0x2a)) return 'image/tiff';
    // AVIF/HEIC: byte 4..8 == "ftyp" and brand starts with "avif"|"avis"|"heic"|"heix"|"mif1"
    if (buf.length >= 12 && buf.slice(4, 8).toString() === 'ftyp') {
        const brand = buf.slice(8, 12).toString();
        if (brand === 'avif' || brand === 'avis') return 'image/avif';
    }
    // SVG: leading "<svg" or "<?xml" then "<svg" — best-effort text sniff
    const head = buf.slice(0, 512).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'image/svg+xml';
    return null;
}

export const handler = async (event: AnyEvent): Promise<APIGatewayProxyResultV2> => {
    if (getMethod(event) === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(), body: '' };
    }
    if (getMethod(event) !== 'POST') {
        return jsonResponse(405, { success: false, error: 'Use POST with a base64 payload' });
    }

    try {
        const { rawBase64, declaredType } = parseInput(event);

        // Cheap pre-check: base64 has ~4/3 expansion, so cap before decoding
        const approxDecodedSize = Math.floor((rawBase64.length * 3) / 4);
        if (approxDecodedSize > MAX_DECODED_BYTES) {
            throw new HttpError(413, `Decoded image would exceed ${MAX_DECODED_BYTES} bytes`);
        }

        const buf = Buffer.from(rawBase64, 'base64');
        if (buf.length === 0) throw new HttpError(400, 'data decoded to zero bytes');
        if (buf.length > MAX_DECODED_BYTES) {
            throw new HttpError(413, `Decoded image is ${buf.length} bytes (max ${MAX_DECODED_BYTES})`);
        }

        // Sniff the actual bytes — defense in depth, also catches arbitrary uploads
        const sniffedType = sniffImageMime(buf);
        let contentType: string;
        if (sniffedType) {
            contentType = sniffedType;
            // If caller declared a different type, trust the bytes — log mismatch
            if (declaredType && declaredType !== sniffedType) {
                console.warn(`Type mismatch: caller declared ${declaredType}, bytes are ${sniffedType}. Using sniffed type.`);
            }
        } else if (declaredType && MIME_TO_EXT[declaredType]) {
            // Couldn't sniff but caller declared an allowed image type — accept
            contentType = declaredType;
        } else {
            throw new HttpError(415, `Could not identify image type${declaredType ? ` (declared: ${declaredType})` : ''}`);
        }

        const ext = MIME_TO_EXT[contentType] || 'bin';

        // SHA-256 of the bytes → 32 hex char prefix for the key. Natural dedup.
        const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
        const key = `${KEY_PREFIX}${hash}.${ext}`;

        await s3.send(new PutObjectCommand({
            Bucket: BUCKET,
            Key: key,
            Body: buf,
            ContentType: contentType,
            CacheControl: 'public, max-age=31536000, immutable',
        }));

        const publicUrl = `${PUBLIC_URL_BASE.replace(/\/$/, '')}/${key}`;

        return jsonResponse(200, {
            success: true,
            url: publicUrl,
            key,
            contentType,
            byteLength: buf.length,
        });
    } catch (error: any) {
        if (error instanceof HttpError) {
            return jsonResponse(error.statusCode, { success: false, error: error.message });
        }
        console.error('img64 error:', error);
        return jsonResponse(500, {
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
        });
    }
};
