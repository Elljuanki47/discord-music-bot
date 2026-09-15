import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ytSearch from 'yt-search';
import type { Track } from './music.js';

const clientId = process.env.SPOTIFY_CLIENT_ID;
const clientSecret = process.env.SPOTIFY_CLIENT_SECRET;

type SpotifyToken = {
    accessToken: string;
    expiresAt: number;
};

let cachedToken: SpotifyToken | undefined;

async function getSpotifyToken(): Promise<string> {
    if (cachedToken && Date.now() < cachedToken.expiresAt) {
        return cachedToken.accessToken;
    }

    if (!clientId || !clientSecret) {
        throw new Error (
            'Faltan SPOTIFY_CLIENT_ID o SPOTIFY_CLIENT_SECRET en el .env',
        );
    }

    const requestedAt = Date.now();
    const credentials = Buffer.from(
        clientId + ':' + clientSecret,
    ).toString('base64');

    const response = await fetch(
        'https://accounts.spotify.com/api/token',
        {
            method: 'POST',
            headers: {
                Authorization: 'Basic ' + credentials,
                'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
                grant_type: 'client_credentials',
            }),
            signal: AbortSignal.timeout(15_000),
        },
    );

    if (!response.ok) {
        const details: unknown = await response.json().catch(() => null);

        const reason =
            typeof details === 'object' &&
            details !== null &&
            'error' in details &&
            typeof details.error === 'string'
                ? details.error
                : 'sin detalle';

        throw new Error(
            'No pude obtener el token de spotify ' +
            `(HTTP ${response.status}; motivo: ${reason})`,
        );
    }

    const data: unknown = await response.json();

    if (
        typeof data !== 'object' ||
        data === null ||
        !('access_token' in data) ||
        typeof data.access_token !== 'string' ||
        data.access_token.length === 0 ||
        !('expires_in' in data) ||
        typeof data.expires_in !== 'number' ||
        !Number.isFinite(data.expires_in) ||
        data.expires_in <= 0
    ) {
        throw new Error('Spotify devolvio un token con formato inesperado.');
    }

    cachedToken = {
        accessToken: data.access_token,
        expiresAt: requestedAt + Math.max(0, data.expires_in - 60) * 1000,
    };

    return cachedToken.accessToken;
}

export async function getSpotifyTrack(input: string) {
    const url = new URL(input.trim());

    if (
        url.protocol !== 'https:' ||
        url.hostname !== 'open.spotify.com' ||
        url.username ||
        url.password ||
        url.port
    ) {
        throw new Error('Pega un enlace de open.spotify.com valido');
    }

    // Acepta /track/ID y /intl-es/track/ID
    const match = url.pathname.match(
        /^\/(?:intl-[a-zA-Z-]+\/)?track\/([A-Za-z0-9]{22})\/?$/,
    );

    const trackId = match?.[1];

    if (!trackId) {
        throw new Error(
            'Por ahora aceptamos enlaces de canciones individuales de spotify.',
        );
    }

    const token = await getSpotifyToken();

    const response = await fetch(
        'https://api.spotify.com/v1/tracks/' + trackId + '?market=AR',
        {
            headers: {
                Authorization: 'Bearer ' + token,
            },
            signal: AbortSignal.timeout(15_000),
        },
    );

    if (!response.ok) {
        if (response.status === 401) {
            cachedToken = undefined;
        }

        if (response.status === 404) {
            throw new Error('Spotify no encontro esa cancion');
        }

        if (response.status === 429) {
            throw new Error('Spotify recibio demasiadas consultas. Proba mas tarde',);
        }

        throw new Error (
            `No pude leer la cancion de Spotify (HTTP ${response.status}).`,
        );
    }

    const data: unknown = await response.json();

    if (
        typeof data !== 'object' ||
        data === null ||
        !('name' in data) ||
        typeof data.name !== 'string' ||
        !data.name.trim() ||
        !('artists' in data) ||
        !Array.isArray(data.artists)
    ) {
        throw new Error('Spotify devolvio datos de cancion inesperados.');
    }

    const artists: string[] = [];

    for (const artist of data.artists) {
        if (
            typeof artist === 'object' &&
            artist !== null &&
            'name' in artist &&
            typeof artist.name === 'string' &&
            artist.name.trim()
        ) {
            artists.push(artist.name.trim());
        }
    }

    if (artists.length === 0) {
        throw new Error('No pude obtener el artista de la cancion');
    }

    return {
        title: data.name.trim(),
        artists,
        spotifyUrl: 'https://open.spotify.com/track/' + trackId,
    };
}

const execFileAsync = promisify(execFile);

type SpotifyPlaylistTrack = {
    title: string;
    artists: string[];
};

export async function getSpotifyPlaylist(input: string) {
    const pythonPath = fileURLToPath(
        new URL('../.venv/Scripts/python.exe', import.meta.url),
    );

    const scriptPath = fileURLToPath(
        new URL('../test-playlist.py', import.meta.url),
    );

    const { stdout } = await execFileAsync(
        pythonPath,
        ['-u', scriptPath, input],
        {
            windowsHide: true,
            encoding: 'utf8',
            timeout: 90_000,
            maxBuffer: 10 * 1024 * 1024,
        },
    );

    const data: unknown = JSON.parse(stdout);

    if (
        typeof data !== 'object' ||
        data === null ||
        !('tracks' in data) ||
        !Array.isArray(data.tracks) ||
        !('received' in data) ||
        typeof data.received !== 'number' ||
        !Number.isInteger(data.received) ||
        data.received < 0 ||
        !('omitted' in data) ||
        typeof data.omitted !== 'number' ||
        !Number.isInteger(data.omitted) ||
        data.omitted < 0
    ) {
        throw new Error('El lector de playulist devolvio datos inesperados.');
    }

    const tracks: SpotifyPlaylistTrack[] = [];

    for (const item of data.tracks) {
        if (
            typeof item !== 'object' ||
            item === null ||
            !('title' in item) ||
            typeof item.title !== 'string' ||
            !item.title.trim() ||
            !('artists' in item) ||
            !Array.isArray(item.artists)
        ) {
            throw new Error('Una cancion de la playlist tiene datos invalidos.');
        }

        const artists: string[] = [];

        for (const artist of item.artists) {
            if (typeof artist !== 'string' || !artist.trim()) {
                throw new Error('Una cancion tiene un artista invalido');
            }

            artists.push(artist.trim());
        }

        if (artists.length === 0) {
            throw new Error('Una cancion no tiene artistas.');
        }

        tracks.push({
            title: item.title.trim(),
            artists,
        });
    }

    return {
        tracks,
        received: data.received,
        omitted: data.omitted,
    };
}

export async function loadSpotifyPlaylist(
    input: string,
    requestedBy: string,
) {
    const playlist = await getSpotifyPlaylist(input);
    const selected = playlist.tracks.slice(0, 100);

    const tracks: Track[] = [];
    let notFound = 0;

    for (const song of selected) {
        const query = song.title + ' ' + song.artists.join(' ');

        try {
            const results = await ytSearch(query);

            const video = results.videos.find(
                (candidate) =>
                    /^[A-Za-z0-9_-]{11}$/.test(candidate.videoId) &&
                    candidate.seconds > 0,
            );

            if (!video) {
                notFound++;
                continue;
            }

            tracks.push({
                query: video.title,
                url: 'https://www.youtube.com/watch?v=' + video.videoId,
                requestedBy,
                durationSeconds: video.seconds,
            });
        } catch (error) {
            notFound++;

            console.error(
                `No pude buscar en Youtube: ${query}`,
                error instanceof Error ? error.message : error,
            );
        }

        // Espaciamos las busuqedas para no enviarlos todas juntas
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 500);
        });
    }

    return {
        tracks,
        omitted: playlist.omitted + notFound,
        limited: Math.max(0, playlist.tracks.length - selected.length),
        isPlaylist: true,
    };
}