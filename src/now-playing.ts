import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    escapeMarkdown,
} from 'discord.js';
import { 
    getQueueSnapshot,
    playbackEvents,
} from './music.js';
import type { Track } from './music.js';
import type { Client, Message } from 'discord.js';

type PlaybackSnapshot = ReturnType<typeof getQueueSnapshot>;

function formatTime(seconds: number): string {
    const total = Math.max(0, Math.floor(seconds));
    const minutes = Math.floor(total / 60);
    const remainingSeconds = total % 60;

    return `${minutes}:${String(remainingSeconds).padStart(2, '0')}`;
}

function createProgressBar(elapsed: number, duration: number): string {
    const positions = 30;
    const progress = Math.min(1, Math.max(0, elapsed / duration));
    const circlePosition = Math.floor(progress * (positions - 1));

    const completed = '━'.repeat(circlePosition);
    const remaining = '━'.repeat(positions - circlePosition - 1);

    return `${completed}●${remaining}`;
}

export function createNowPlayingMessage(snapshot: PlaybackSnapshot)  {
    const { current, status, elapsedSeconds } = snapshot;

    const row = new ActionRowBuilder<ButtonBuilder>();

    if (!current) {
        return {
            content: '⏹️ Reproduccion terminada. Usa /play para agregar canciones',
            components: [] as ActionRowBuilder<ButtonBuilder>[],
            allowedMentions: { parse: [] as []},
        };
    }

    const paused = status === 'En pausa';
    const playing = status === 'Reproduciendo';

    const duration = current.durationSeconds;
    const hasDuration = 
        typeof duration === 'number' &&
        Number.isFinite(duration) &&
        duration > 0;

    const elapsed = 
        typeof elapsedSeconds === 'number' &&
        Number.isFinite(elapsedSeconds)
            ? Math.max(0, elapsedSeconds)
            : 0;

    let progressLine: string;

    if (hasDuration) {
        const position = Math.min(elapsed, duration);

        progressLine = 
            `${formatTime(position)} ` +
            `${createProgressBar(position, duration)} ` +
            `${formatTime(duration)}`;
    } else {
        progressLine = `${formatTime(elapsed)} · Duracion desconocida`;
    }

    const title = escapeMarkdown(
        current.query.replace(/[\r\n]/g, ' ').slice(0, 100),
    );

    const requestedBy = escapeMarkdown(
        current.requestedBy.replace(/[\r\n]/g, ' ').slice(0, 80),
    );

    row.addComponents(
        new ButtonBuilder()
            .setCustomId('music:pause')
            .setLabel(paused ? 'Reanudar' : 'Pausar')
            .setEmoji(paused ? '▶️' : '⏸️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!playing && !paused),

        new ButtonBuilder()
            .setCustomId('music:skip')
            .setLabel('Siguiente')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Secondary),
    );

    return {
        content: [
            `🎶 **${title}**`,
            `Pedida por: ${requestedBy}`,
            '',
            `\`${progressLine}\``,
            paused ? '⏸️ En pausa' : '',
        ].filter((line) => line !== '').join('\n'),
        components: [row],
        allowedMentions: { parse: [] as [] },
    };
}

type NowPlayingPanel = {
    channelId: string;
    message: Message | undefined;
    shownTrack: Track | undefined;
    updating: boolean;
    dirty: boolean;
    lastContent: string;
};

const panels = new Map<string, NowPlayingPanel>();
let discordClient: Client | undefined;

export function isNowPlayingMessage(
    guildId: string,
    messageId: string,
): boolean {
    return panels.get(guildId)?.message?.id === messageId;
}

export function watchNowPlaying(
    guildId: string,
    channelId: string,
): void {
    if (!panels.has(guildId)) {
        panels.set(guildId, {
            channelId,
            message: undefined,
            shownTrack: undefined,
            updating: false,
            dirty: false,
            lastContent: '',
        });
    }

    void refreshNowPlaying(guildId);
}

async function updatePanel(
    guildId: string,
    panel: NowPlayingPanel,
): Promise<void> {
    const snapshot = getQueueSnapshot(guildId);
    const { current, status } = snapshot;

    // Una cancion nueva se anuncia cuando empieza a sonar,
    // no mientras yt-dlp todavia esta obteniendo el audio
    const differentTrack = current !== panel.shownTrack;

    if (
        current &&
        (differentTrack || !panel.message) &&
        status !== 'Reproduciendo'
    ) {
        return;
    }

    const payload = createNowPlayingMessage(snapshot);

    if (current && (differentTrack || !panel.message)) {
        if (!discordClient) return;

        const channel = await discordClient.channels.fetch(panel.channelId);

        if (
            !channel ||
            !channel.isSendable() ||
            !('guildId' in channel) ||
            channel.guildId !== guildId
        ) {
            throw new Error('El canal de Ahora suena no esta disponible.');
        }

        const previousMessage = panel.message;

        // Primero publicamos el nuevo para conservar los controles
        // anteriores si Discord no permite enviar el mensaje.
        const newMessage = await channel.send(payload);

        panel.message = newMessage;
        panel.shownTrack = current;
        panel.lastContent = payload.content;

        if (previousMessage) {
            try {
                await previousMessage.delete();
            } catch (error) {
                console.error('No pude borrar el Ahora suena anterior:', error);

                // Si no se pudo borrar, quitamos sus controles.
                await previousMessage.edit({
                    content: 'Esta cancion termino. Usa el mensaje mas reciente',
                    components: [],
                }).catch(console.error);
            }
        }

        return;
    }

    //Puasar, reanudar y avanzar el reloj editan el mismo mensaje
    if (!panel.message || panel.lastContent === payload.content) return;

    try {
        await panel.message.edit(payload);
        panel.lastContent = payload.content;

        if(!current) {
            panel.shownTrack = undefined;
        }
    } catch (error) {
        const code =
            error && typeof error === 'object' && 'code' in error
                ? error.code
                : undefined;

        if (code === 10008) {
            // Discord confirmo que el mensaje fue eliminado
            panel.message = undefined;
            panel.lastContent = '';
        }

        throw error;
    }
}

async function refreshNowPlaying (guildId: string): Promise<void> {
    const panel = panels.get(guildId);
    if (!panel) return;

    panel.dirty = true;

    // Evita que dos avisos simultaneos creen dos mensajes
    if (panel.updating) return;

    panel.updating = true;

    try {
        do {
            panel.dirty = false;
            await updatePanel(guildId, panel);
        } while (panel.dirty);
    } catch (error) {
        console.error('Error al actualizar Ahora suena:', error);
    } finally {
        panel.updating = false;
    }
}

export function setupNowPlaying(client: Client): void {
    // Evita registrar varias veces el listener y el temporizador.
    if (discordClient) return;

    discordClient = client;

    playbackEvents.on('change', (guildId: string) => {
        void refreshNowPlaying(guildId);
    });

    const timer = setInterval(() => {
        for (const guildId of panels.keys()) {
            if (getQueueSnapshot(guildId). status === 'Reproduciendo') {
                void refreshNowPlaying(guildId);
            }
        }
    }, 3_000);

    timer.unref();
}