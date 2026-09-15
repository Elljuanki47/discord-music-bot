import { getSpotifyPlaylist } from './spotify.js';

const link = process.argv[2];

if (!link) {
    console.error('Pasa el enlace de una playlist entre comillas.');
    process.exitCode = 1;
} else {
    try {
        console.log('Consultando la playlist desde TypeScript...');

        const result = await getSpotifyPlaylist(link);

        console.log('✅ Lectura correcta');
        console.log('Entradas recibidas:', result.received);
        console.log('Canciones validas;', result.tracks.length);
        console.log('Omitidas:', result.omitted);

        for(const [index, track] of result.tracks.slice(0,5).entries()) {
            console.log(
                `${index + 1}. ${track.title} — ${track.artists.join(', ')}`,
            );
        }
    } catch (error) {
        console.error(
            error instanceof Error ? error.message : 'Error inesperado',
        );
        process.exitCode = 1;
    }
}