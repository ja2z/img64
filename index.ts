import type { APIGatewayProxyResultV2 } from 'aws-lambda';

type AnyEvent = any;

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB — keep response under API Gateway's 6 MB sync cap after base64 expansion
const FETCH_TIMEOUT_MS = 8000;

const ALLOWED_CONTENT_TYPES = new Set([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
    'image/svg+xml',
    'image/bmp',
    'image/x-icon',
    'image/vnd.microsoft.icon',
    'image/avif',
    'image/apng',
    'image/tiff',
]);

interface RequestParams {
    url?: string;
    alt?: string;
    format?: 'json' | 'html';
}

function corsHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
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

function htmlResponse(statusCode: number, body: string): APIGatewayProxyResultV2 {
    return {
        statusCode,
        headers: corsHeaders({ 'Content-Type': 'text/html; charset=utf-8' }),
        body,
    };
}

function getMethod(event: AnyEvent): string {
    return (
        event.requestContext?.http?.method ||
        event.httpMethod ||
        'GET'
    ).toUpperCase();
}

function parseParams(event: AnyEvent): RequestParams {
    const method = getMethod(event);
    const query = event.queryStringParameters || {};

    if (method === 'POST' && event.body) {
        try {
            const raw = event.isBase64Encoded
                ? Buffer.from(event.body, 'base64').toString('utf8')
                : event.body;
            const parsed = JSON.parse(raw);
            return {
                url: parsed.url ?? query.url,
                alt: parsed.alt ?? query.alt,
                format: (parsed.format ?? query.format) as RequestParams['format'],
            };
        } catch {
            // Fall through to query params if body isn't valid JSON
        }
    }

    return {
        url: query.url,
        alt: query.alt,
        format: query.format as RequestParams['format'],
    };
}

function escapeHtmlAttr(value: string): string {
    return value
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function isHttpUrl(value: string): boolean {
    try {
        const u = new URL(value);
        return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
        return false;
    }
}

async function fetchImage(url: string): Promise<{ buffer: Buffer; contentType: string }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

    let response: Response;
    try {
        response = await fetch(url, {
            signal: controller.signal,
            redirect: 'follow',
            headers: { 'User-Agent': 'img64-lambda/0.1' },
        });
    } finally {
        clearTimeout(timer);
    }

    if (!response.ok) {
        throw new HttpError(502, `Upstream returned ${response.status} ${response.statusText}`);
    }

    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!contentType || !ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new HttpError(415, `Unsupported or missing image content-type: ${contentType || '(none)'}`);
    }

    const declaredLength = Number(response.headers.get('content-length'));
    if (declaredLength && declaredLength > MAX_BYTES) {
        throw new HttpError(413, `Image too large: ${declaredLength} bytes (max ${MAX_BYTES})`);
    }

    const arrayBuf = await response.arrayBuffer();
    if (arrayBuf.byteLength > MAX_BYTES) {
        throw new HttpError(413, `Image too large: ${arrayBuf.byteLength} bytes (max ${MAX_BYTES})`);
    }

    return { buffer: Buffer.from(arrayBuf), contentType };
}

class HttpError extends Error {
    constructor(public statusCode: number, message: string) {
        super(message);
    }
}

export const handler = async (event: AnyEvent): Promise<APIGatewayProxyResultV2> => {
    if (getMethod(event) === 'OPTIONS') {
        return { statusCode: 204, headers: corsHeaders(), body: '' };
    }

    try {
        const { url, alt, format } = parseParams(event);

        if (!url) {
            return jsonResponse(400, { success: false, error: 'Missing required parameter: url' });
        }
        if (!isHttpUrl(url)) {
            return jsonResponse(400, { success: false, error: 'url must be http(s)' });
        }

        const { buffer, contentType } = await fetchImage(url);
        const base64 = buffer.toString('base64');
        const dataUri = `data:${contentType};base64,${base64}`;
        const altAttr = alt ? ` alt="${escapeHtmlAttr(alt)}"` : '';
        const tag = `<img src="${dataUri}"${altAttr} />`;

        if (format === 'html') {
            return htmlResponse(200, tag);
        }

        return jsonResponse(200, {
            success: true,
            tag,
            dataUri,
            contentType,
            byteLength: buffer.length,
        });
    } catch (error: any) {
        if (error?.name === 'AbortError') {
            return jsonResponse(504, { success: false, error: 'Upstream fetch timed out' });
        }
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
