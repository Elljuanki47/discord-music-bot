import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Track } from './music.js';

const execFileAsync = promisify(execFile);

function asObject(value: unknown): Record<string, unknown> {
    if (typeof value !== 'object' || value === null) {
        return {};
    }

    return value as Record<string, unknown>;
}

export async function loadYouTubeLink(
    input: string,
    requestedBy: string,
) {
    const url = new URL(input);

    const allowedHosts = [
        'youtube.com',
        'www.youtube.com',
        'm.youtube.com',
        'music.youtube.com',
        'youtu.be',
        'www.youtu.be',
    ];

    if (
        !['https:', 'http:'].includes(url.protocol) ||
        !allowedHosts.includes(url.hostname) ||
        url.username ||
        url.password
    ) {
        throw new Error('Pega un enlace de YouTube valido.');
    }

    const playlistId = url.searchParams.get('list');
    let normalizedUrl: string;

    if (playlistId) {
        if(!/^[A-Za-z0-9_-]+$/.test(playlistId)) {
            throw new Error('El identificador de la playlist no es valido.');
        }

        normalizedUrl = 
            `https://www.youtube.com/playlist?list=${playlistId}`;
    } else {
        const parts = url.pathname.split('/').filter(Boolean);
        let videoId: string | undefined;

        if (url.hostname === 'youtu.be' || url.hostname === 'www.youtu.be') {
            videoId = parts[0];
        } else if (url.pathname === '/watch') {
            videoId = url.searchParams.get('v') ?? undefined;
        } else if (
            parts[0] === 'shorts' ||
            parts[0] === 'live' ||
            parts[0] === 'embed'
        ) {
            videoId = parts[1];
        }

        if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) {
            throw new Error('El enlace debe apuntar a un video o una playlist.');
        }

        normalizedUrl = 'https://www.youtube.com/watch?v=' + videoId;
    }

    const { stdout } = await execFileAsync(
        'yt-dlp',
        [
            '--ignore-config',
            '--no-progress',
            '--skip-download',
            '--flat-playlist',
            '--dump-single-json',
            '--ignore-errors',
            '--js-runtimes', 'deno',
            '--playlist-items', '1:100',
            ...(playlistId ? ['--yes-playlist'] : ['--no-playlist']),
            '--',
            normalizedUrl,
        ],
        {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 90_000,
            maxBuffer: 10 * 1024 * 1024,
        },
    );

    const data = asObject(JSON.parse(stdout));

    const entries: unknown[] = playlistId
        ? (Array.isArray(data.entries) ? data.entries.slice(0, 100) : [])
        : [data];

    const tracks: Track[] = [];
    let omitted = 0;

    for (const raw of entries) {
        const entry = asObject(raw);

        const id = typeof entry.id === 'string' ? entry.id : '';
        const title = typeof entry.title === 'string' ? entry.title : '';

        const unavailable =
            entry.availability === 'private' ||
            entry.availability === 'premium_only' ||
            entry.availability === 'subscriber_only' ||
            entry.availability === 'needs_auth' ||
            /^\[(private|deleted) video\]$/i.test(title);

        if (
            !/^[A-Za-z0-9_-]{11}$/.test(id) ||
            !title ||
            unavailable
        ) {
            omitted++;
            continue;
        }

        tracks.push({
            query: title,
            url: `https://www.youtube.com/watch?v=${id}`,
            requestedBy,
        });
    }

    return {
        tracks,
        omitted,
        isPlaylist: Boolean(playlistId),
    };
}