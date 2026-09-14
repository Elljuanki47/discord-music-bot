import { spawn } from 'node:child_process';
import {
    AudioPlayerStatus,
    NoSubscriberBehavior,
    VoiceConnectionStatus,
    createAudioPlayer,
    createAudioResource,
    StreamType,
} from '@discordjs/voice';
import type {
    AudioPlayer,
    VoiceConnection,
} from '@discordjs/voice';
import { EventEmitter } from 'node:events';

export type Track = {
    query: string;
    url: string;
    requestedBy: string;
    durationSeconds?: number;
};

type Session = {
    guildId: string,
    player: AudioPlayer;
    queue: Track[];
    active: boolean;
    disposed: boolean;
    cleanup: (() => void) | undefined;
};

const sessions = new Map<string, Session>();

export const playbackEvents = new EventEmitter();

function notifyPlaybackChange(guildId: string): void {
    queueMicrotask(() => {
        playbackEvents.emit('change', guildId);
    });
} 

export function startPlayback(
    guildId: string,
    queue: Track[],
    connection: VoiceConnection,
): void {
    let session = sessions.get(guildId);

    if (!session) {
        const player = createAudioPlayer({
            behaviors: {
                noSubscriber: NoSubscriberBehavior.Pause,
            },
        });

        session = {
            guildId,
            player,
            queue,
            active: false,
            disposed: false,
            cleanup: undefined,
        };

        sessions.set(guildId, session);
        player.on('stateChange', () => {
            notifyPlaybackChange(guildId);
        });

        const createdSession = session;

        connection.once(VoiceConnectionStatus.Destroyed, () => {
            if (sessions.get(guildId) === createdSession) {
                stopPlayback(guildId);
            }
        });
    }

    connection.subscribe(session.player);

    // Si hay una cancion sonando o cargando, no la reemplazamos.
    if (!session.active) {
        playNext(session);
    }

    notifyPlaybackChange(guildId);
}

function playNext(session: Session): void {
    if (session.disposed || session.active) return;

    const firstTrack = session.queue[0];
    if (!firstTrack) return;

    const track: Track = firstTrack;

    session.active = true;

    notifyPlaybackChange(session.guildId);

    // Los argumentos se pasan por separado, sin usar una shell
    const downloader = spawn(
        'yt-dlp',
        [
            '--ignore-config',
            '--no-playlist',
            '--no-progress',
            '--js-runtimes', 'deno',
            '--format', 'bestaudio/best',
            '--output', '-',
            '--',
            track.url,
        ],
        {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
        },
    );

    // Recibe el audio y lo convierte a Ogg Opus para discord
    const converter = spawn (
        'ffmpeg',
        [
            '-hide_banner',
            '-loglevel', 'error',
            '-i', 'pipe:0',
            '-vn',
            '-c:a', 'libopus',
            '-ar', '48000',
            '-ac', '2',
            '-b:a', '128k',
            '-frame_duration', '20',
            '-f', 'ogg',
            'pipe:1',
        ],
        {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
        },
    );

    let finished = false;
    let diagnostic = '';
    let startupTimer: ReturnType<typeof setTimeout> | undefined;

    const collectDiagnostic = (chunk: Buffer): void => {
        diagnostic = (diagnostic + chunk.toString()).slice(-4000);
    };

    downloader.stderr.on('data', collectDiagnostic);
    converter.stderr.on('data', collectDiagnostic);

    function cleanup(): void {
        if (startupTimer) clearTimeout(startupTimer);

        session.player.off(AudioPlayerStatus.Idle, onIdle);
        session.player.off(AudioPlayerStatus.Playing, onPlaying);

        downloader.stdout.unpipe(converter.stdin);

        // Cerramos los dos proceso al terminar, fallar o usar /leave
        downloader.kill();
        converter.kill();

        downloader.stdout.destroy();
        converter.stdin.destroy();
        converter.stdout.destroy();
    }

    function finish(error?: Error): void {
        if (finished) return;
        finished = true;

        cleanup();
        session.cleanup = undefined;
        session.player.stop(true);
        session.active = false;

        if (error) {
            console.error(`❌ No se pudo reproducir "${track.query}":`);
            console.error(error.message);
            if (diagnostic.trim()) console.error(diagnostic.trim());
        }

        // Quitamos unicamente la cancion que acabamos de procesar
        if (session.queue[0] === track) {
            session.queue.shift();
        }

        notifyPlaybackChange(session.guildId);

        // Dejamos pasar los eventos pendientes antes de iniciar otra
        setImmediate(() => {
            session.player.off('error', onPlayerError);

            if (!session.disposed) {
                playNext(session);
            }
        });
    }

    function onIdle(): void {
        finish();
    }

    function onPlaying(): void {
        if (startupTimer) clearTimeout(startupTimer);
        console.log(`🎶 Reproduciendo: ${track.query}`);
    }

    function onPlayerError(error: Error): void {
        finish(error);
    }

    session.cleanup = () => {
        finished = true;
        cleanup();

        // este reproductor se descarta, absorbemos errores pendientes
    };

    session.player.on('error', onPlayerError);
    session.player.once(AudioPlayerStatus.Idle, onIdle);
    session.player.once(AudioPlayerStatus.Playing, onPlaying);

    downloader.on('error', (error) => finish(error));
    converter.on('error', (error) => finish(error));
    downloader.stdout.on('error', (error) => finish(error));
    converter.stdin.on('error', (error) => finish(error));
    converter.stdout.on('error', (error) => finish(error));

    downloader.on('close', (code) => {
        if (!finished && code !== 0) {
            finish(new Error(`yt-dlp termino con codigo ${code}`));
        }
    });

    converter.on('close', (code) => {
        if (!finished && code !== 0) {
            finish(new Error(`FFmpeg termino con codigo ${code}`));
        }
    });

    startupTimer = setTimeout(() => {
        finish(new Error(' El audio no empezo dentro de los 60 segundos'));
    }, 60_000);

    try {
        downloader.stdout.pipe(converter.stdin);

        const resource = createAudioResource(converter.stdout, {
            inputType: StreamType.OggOpus,
        });

        session.player.play(resource);
    } catch (error) {
        finish(
            error instanceof Error ? error : new Error(String(error)),
        );
    }
}

export function stopPlayback(guildId: string): void {
    const session = sessions.get(guildId);
    if (!session) return;

    session.disposed = true;
    session.cleanup?.();
    session.cleanup = undefined;
    session.player.stop(true);
    session.queue.length = 0;

    sessions.delete(guildId);

    notifyPlaybackChange(session.guildId);
}

export function togglePause(guildId: string): string {
    const session = sessions.get(guildId);

    if (!session || session.disposed || !session.active) {
        return 'No hay ninguna cancion reproduciendose.';
    }

    const status = session.player.state.status;

    if (status === AudioPlayerStatus.Paused) {
        return session.player.unpause()
            ? '▶️ Reproducción reanudada.'
            : 'No pude reanudar la reproducción.';
    }

    if (status === AudioPlayerStatus.Playing) {
        return session.player.pause()
            ? '⏸️ Reproducción pausada.'
            : 'No pude pausar la reproducción.';
    }

    return 'El audio esta cargando o esperando la conexion. Proba en unos segundos.';
}

export function skipTrack(guildId: string): boolean {
    const session = sessions.get(guildId);

    if (!session || session.disposed || !session.active) {
        return false;
    }

    // Al pasar a Idle, finish() limpa los procesos,
    // quita la cancion actual y arranca la siguiente
    return session.player.stop(true);
}

function getElapsedSeconds(session: Session): number {
    const state = session.player.state;

    if (state.status === AudioPlayerStatus.Idle) {
        return 0;
    }

    // Cada paquete de audio representa 20 milisegundos
    const seconds = state.resource.playbackDuration / 1000;
    const duration = session.queue[0]?.durationSeconds;

    if (duration !== undefined) {
        return Math.min(seconds, duration);
    }

    return seconds;
}

export function getQueueSnapshot(guildId: string) {
    const session = sessions.get(guildId);

    if (!session || session.disposed) {
        return {
            current: undefined as Track | undefined,
            pending: [] as Track[],
            status: 'Sin reproduccion',
            elapsedSeconds: 0,
        };
    }

    const current = session.active ? session.queue[0] : undefined;
    const pending = session.queue.slice(current ? 1 : 0);

    let status = 'Cargando';

    if (session.player.state.status === AudioPlayerStatus.Playing) {
        status = 'Reproduciendo';
    } else if (
        session.player.state.status === AudioPlayerStatus.Paused ||
        session.player.state.status === AudioPlayerStatus.AutoPaused
    ) {
        status = 'En pausa';
    }

    return { 
        current, 
        pending, 
        status,
        elapsedSeconds: getElapsedSeconds(session),
    };
}

export function shuffleQueue(guildId: string): number {
    const session = sessions.get(guildId);

    if (!session || session.disposed) return 0;

    // Si hay una cancion activa, dejamos intacta la posicion 0
    const start = session.active ? 1 : 0;
    const count = session.queue.length - start;

    if (count < 2) return count;

    // Mezclamos el mismo array que usa el reproductor
    for (let i = session.queue.length - 1; i > start ; i--) {
        const j = start + Math.floor(Math.random() * (i - start + 1));

        const first = session.queue[i];
        const second = session.queue[j];

        if (!first || !second) continue;

        session.queue[i] = second;
        session.queue[j] = first;
    }

    notifyPlaybackChange(session.guildId);

    return count;
}

export function removeQueuedTrack(
    guildId: string,
    position: number,
): Track | undefined {
    const session = sessions.get(guildId);

    if (
        !session ||
        session.disposed ||
        !Number.isInteger(position) ||
        position < 1
    ) {
        return undefined;
    }

    // La posicion 0 del array contiene la cancion actual si esta activo
    const pendingStart = session.active ? 1 : 0;
    const index = pendingStart + position - 1;

    if (index >= session.queue.length) {
        return undefined;
    }

    const [removed] = session.queue.splice(index, 1);

    if (removed) {
        notifyPlaybackChange(guildId);
    }

    return removed;
}

export function hasQueuedMusic(guildId: string): boolean {
    const session = sessions.get(guildId);

    if (!session || session.disposed) {
        return false;
    }

    return session.active || session.queue.length > 0;
}