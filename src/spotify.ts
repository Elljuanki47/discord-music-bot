import 'dotenv/config';

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