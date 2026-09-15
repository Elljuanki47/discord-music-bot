import { getSpotifyTrack } from './spotify.js';

const link = process.argv[2];

if (!link) {
    console.error('Falta el enace de una cancion de Spotify');
    process.exitCode = 1;
} else {
    try {
        const track = await getSpotifyTrack(link);

        console.log('✅ Spotify respondió correctamente');
        console.log('Titulo:', track.title);
        console.log('Artistas: ', track.artists.join(', '));
        console.log('Enlace: ', track.spotifyUrl);
    } catch (error) {
        console.error(
            '❌',
            error instanceof Error ? error.message : 'Error inesperado',
        );

        process.exitCode = 1
    }
}