import 'dotenv/config';
import ytSearch from 'yt-search';
import type { MessageReaction } from 'discord.js';
import {
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    Client,
    Events,
    GatewayIntentBits,
    MessageFlags,
    escapeMarkdown,
} from 'discord.js';
import { entersState, getVoiceConnection, getVoiceConnections, joinVoiceChannel, VoiceConnectionStatus, } from '@discordjs/voice';
import {
    startPlayback,
    stopPlayback,
    togglePause,
    skipTrack,
    getQueueSnapshot,
    shuffleQueue,
    removeQueuedTrack,
    hasQueuedMusic,
} from './music.js';
import type { Track } from './music.js';
import { loadYouTubeLink } from './youtube.js';
import {
    setupNowPlaying,
    watchNowPlaying,
    isNowPlayingMessage,
} from './now-playing.js';
import { getSpotifyTrack } from './spotify.js';



const queues = new Map<string, Track[]>();

type InactivityState = {
    channelId: string;
    emptySince: number | undefined;
    idleSince: number | undefined;
};

const inactivityStates = new Map<string, InactivityState>();

const EMPTY_CHANNEL_TIMEOUT = 60_000;
const NO_MUSIC_TIMEOUT = 5 * 60_000;

function checkVoiceInactivity(): void {
    const connections = getVoiceConnections();
    const now = Date.now();

    // Quitamos los registros de conexiones que ya no existen.
    for (const guildId of inactivityStates.keys()) {
        if (!connections.has(guildId)) {
            inactivityStates.delete(guildId);
        }
    }

    for (const [guildId, connection] of connections) {
        if (connection.state.status !== VoiceConnectionStatus.Ready) {
            inactivityStates.delete(guildId);
            continue;
        }

        const channelId = connection.joinConfig.channelId;

        if (!channelId) continue;

        const guild = client.guilds.cache.get(guildId);
        const channel = guild?.channels.cache.get(channelId);

        // Si no odemos comprobar quien esta conectado, no decidimos salir
        if (!channel || !channel.isVoiceBased()) {
            inactivityStates.delete(guildId);
            continue;
        }

        let state = inactivityStates.get(guildId);

        if (!state || state.channelId !== channelId) {
            state = {
                channelId,
                emptySince: undefined,
                idleSince: undefined,
            };

            inactivityStates.set(guildId, state);
        }

        const hasPeople = channel.members.some(
            (member) => !member.user.bot,
        );

        if (hasPeople) {
            state.emptySince = undefined;
        } else {
            state.emptySince ??= now;
        }

        if (hasQueuedMusic(guildId)) {
            state.idleSince = undefined;
        } else {
            state.idleSince ??= now;
        }

        const emptyTooLong =
            state.emptySince !== undefined &&
            now - state.emptySince >= EMPTY_CHANNEL_TIMEOUT;

        const idleTooLong =
            state.idleSince !== undefined &&
            now - state.idleSince >= NO_MUSIC_TIMEOUT;

        if (!emptyTooLong && !idleTooLong) continue;

        stopPlayback(guildId);
        queues.delete(guildId);
        inactivityStates.delete(guildId);
        connection.destroy();

        console.log(
            `NO VEMO NEMO porque: ` +
            (emptyTooLong
                ? 'Cakin es un gato y no se conecto.'
                : 'Gagaciano entro muteado... OTRA VEZ'),
        );
    }
}

function createMusicControls(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
            .setCustomId('music:pause')
            .setLabel('Pausar / Reanudar')
            .setEmoji('⏯️')
            .setStyle(ButtonStyle.Primary),

        new ButtonBuilder()
            .setCustomId('music:stop')
            .setLabel('Detener')
            .setEmoji('⏹️')
            .setStyle(ButtonStyle.Danger),

        new ButtonBuilder()
            .setCustomId('music:skip')
            .setLabel('Siguiente')
            .setEmoji('⏭️')
            .setStyle(ButtonStyle.Secondary),
    );
}

const token = process.env.DISCORD_TOKEN;

if (!token) {
    throw new Error('Falta DISCORD_TOKEN en el archivo .env');
}

const client = new Client ({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMessageReactions,
    ],
});

client.once(Events.ClientReady, (readyClient) => {
    console.log(`✅ Conectado como ${readyClient.user.tag}`);

    const inactivityTimer = setInterval(() => {
        try {
            checkVoiceInactivity();
        } catch (error) {
            console.error('Error al revisar la inactividad:', error);
        }
    }, 10_000);

    inactivityTimer.unref();
});

client.on(Events.VoiceStateUpdate, (_previous, current) => {
    const guildId = current.guild.id;
    const state = inactivityStates.get(guildId);

    if (!state) return;

    if (
        current.channelId === state.channelId &&
        current.member &&
        !current.member.user.bot
    ) {
        state.emptySince = undefined;
    }
});

setupNowPlaying(client);

client.on(Events.InteractionCreate, async (interaction) => {
    if (interaction.isButton()) {
        const validIds = ['music:pause', 'music:stop', 'music:skip'];

        if (!validIds.includes(interaction.customId)) return;

        try {
            // La respuesta al clic solo la ve quien presiono el boton
            await interaction.deferReply({
                flags: MessageFlags.Ephemeral,
            });

            const guildId = interaction.guildId;
            const guild = interaction.guild;

            if (!guildId || !guild) {
                await interaction.editReply(
                    "Estos controles solo funcionan en un servidor.",
                );
                return;
            }

            // Comrprobamos que el boton pertenezca al mensaje actual.
            if (!isNowPlayingMessage(guildId, interaction.message.id)) {
                await interaction.editReply(
                    'Usa los controles del mensaje mas reciente de Ahora suena',
                );
                return;
            }

            const member = await guild.members.fetch(interaction.user.id);
            const connection = getVoiceConnection(guildId);

            if (!connection) {
                await interaction.editReply(
                    "El bot esta desconectado. Usa /play para comenzar",
                );
                return;
            }

            if (!member.voice.channelId || member.voice.channelId !== connection.joinConfig.channelId) {
                await interaction.editReply("Entra al mismo canal de voz que el bot para usar los controles",);
                return;
            }

            if (interaction.customId === 'music:pause') {
                await interaction.editReply(togglePause(guildId));
                return;
            }

            if (interaction.customId === 'music:stop') {
                stopPlayback(guildId);
                queues.delete(guildId);

                await interaction.editReply('⏹️ Reproducción detenida y cola vacía. Sigo en el canal de voz.',);
                return;
            }

            if (interaction.customId === 'music:skip') {
                const skipped = skipTrack(guildId);
                
                await interaction.editReply(
                    skipped
                       ? '⏭️ Canción saltada. Si hay otra en la cola, empezará a cargar.'
                        : 'No hay ninguna canción para saltar.',
                );
                return;
            }
        } catch (error) {
            console.error('Error en los controles de musica:', error);
            
            if(interaction.deferred || interaction.replied) {
                await interaction.editReply(
                    '❌ No pude ejecutar ese control. Revisá la terminal.',
                ).catch(console.error);
            } else {
                await interaction.reply({
                    content: '❌ No pude ejecutar ese control.',
                    flags: MessageFlags.Ephemeral,
                }).catch(console.error);
            }
        }

        return;
        
    }

    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'ping') {
        await interaction.reply('🏓 Pong! El bot está funcionando.');
    }

    if (interaction.commandName === 'join') {
      const member = await interaction.guild?.members.fetch(interaction.user.id);
      const voiceChannel = member?.voice.channel;

      if (!voiceChannel) {
        await interaction.reply('Primero tenés que entrar a un canal de voz.');
        return;
      }

      joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: voiceChannel.guild.id,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
      });

      await interaction.reply(`✅ Me uní a **${voiceChannel.name}**.`);
    }

    if (interaction.commandName === 'leave') {
        const guildId = interaction.guildId;

        if (!guildId) {
            await interaction.reply(
                'Este comando solo funciona en un servidor.',
            );
            return;
        }

        stopPlayback(guildId);
        queues.delete(guildId);

        const connection = getVoiceConnection(guildId);

        if (!connection) {
            await interaction.reply(
                "No estoy conectado. La cola quedo vacia",
            );
            return;
        }

        connection.destroy();

        await interaction.reply(
            '👋 Salí del canal de voz y vacié la cola.',
        );
        return;
    }

    if (interaction.commandName === 'play') {
        const guildId = interaction.guildId;

        if (!guildId || !interaction.guild) {
            await interaction.reply('Este comando solo funciona dentro de un canal');
            return;
        }

        // Youtube puede tardar: avisamos a Discord que estamos trabajando.
        await interaction.deferReply();

        try {
            const member = await interaction.guild.members.fetch(
                interaction.user.id,
            );

            if (!member.voice.channel) {
                await interaction.editReply(
                    "Primero tenés que entrar a un canal de voz.",
                );
                return;
            }

            let query = interaction.options.getString('busqueda', true).trim();

            if (!query) {
                await interaction.editReply("Escribi el nombnre de una cancion.");
                return;
            }

            if (/^https?:\/\//i.test(query)) {
                const url = new URL(query);

                if (url.hostname === 'open.spotify.com') {
                    await interaction.editReply(
                        '⏳ Leyendo la canción de Spotify...',
                    );
                    
                    
                    try {
                        const track = await getSpotifyTrack(query);
                    
                        query = track.title + ' ' + track.artists.join(' ');
                    } catch (error) {
                        console.error('Error al leer Spotify:', error);
                    
                        await interaction.editReply({
                            content:
                                error instanceof Error
                                    ? error.message
                                    : 'No pude leer la cancion de spotify.',
                            allowedMentions: { parse: [] },
                        });
                    
                        return;
                    }
                }
            }

            // Los enlaces y las playlist laos incorporamos en el siguiente paso.
            if (/^https?:\/\//i.test(query)) {
                await interaction.editReply(
                    '⏳ Leyendo el enlace de YouTube. ' +
                    'Si es una playlist, revisaré sus primeras 100 entradas...',
                );

                let result: Awaited<ReturnType<typeof loadYouTubeLink>>;

                try {
                    result = await loadYouTubeLink(
                        query,
                        interaction.user.username,
                    );
                } catch (error) {
                    console.error('Error al leer el enlace de YouTube:', error);

                    await interaction.editReply(
                         '❌ No pude leer el enlace. Comprobá que sea un video ' +
                        'o una playlist de YouTube accesible sin iniciar sesión. ' +
                        'Revisá la terminal para ver el detalle.',
                    );
                    return;
                }

                if (result.tracks.length === 0) {
                    await interaction.editReply(
                        'No encontre canciones disponibles para agregar.',
                    );
                    return;
                }

                // La lectura puede tardar: comprobamos de nuevo el canal
                const currentMember = await interaction.guild.members.fetch(
                    interaction.user.id,
                );
                const voiceChannel = currentMember.voice.channel;

                if(!voiceChannel) {
                    await interaction.editReply(
                        'Saliste del canal de voz. Volve a entrar y usa /play de nuevo.',
                    );
                    return;
                }

                let connection = getVoiceConnection(guildId);

                if (
                    connection &&
                    connection.joinConfig.channelId !== voiceChannel.id
                ) {
                    await interaction.editReply(
                        'Entrá al mismo canal de voz que el bot para agregar canciones.',
                    );
                    return;
                }

                const createdConnection = !connection;

            if (!connection) {
                connection = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                    selfDeaf: true,
                });
            }

            try {
                await entersState(
                    connection,
                    VoiceConnectionStatus.Ready,
                    20_000,
                );
            } catch (error) {
                console.error('Error al conectar la voz:', error);

                if (
                    createdConnection &&
                    connection.state.status !== VoiceConnectionStatus.Destroyed
                ) {
                    connection.destroy();
                }

                await interaction.editReply(
                    '❌ No pude conectarme al canal. No agregué las canciones.',
                );
                return;
            }

            // Recuperamos la cola despues de las esperas para usar la actual
            const queue = queues.get(guildId) ?? [];
            queue.push(...result.tracks);
            queues.set(guildId, queue);

            startPlayback(guildId, queue, connection);

            const inactivity = inactivityStates.get(guildId);

            if (inactivity) {
                inactivity.idleSince = undefined;
            }

            if (interaction.channelId) {
                watchNowPlaying(guildId, interaction.channelId);
            }

            await interaction.editReply({
                content: [
                    `➕ Agrege ${result.tracks.length} canciones al final de la cola.`,
                    result.isPlaylist
                        ? 'Se revisaron hasta las primeras 100 entradas de la playlist.'
                        : '',
                    result.omitted > 0
                        ? `Omiti ${result.omitted} entradas sin datos o no disponibles`
                        : '',
                    'Usa /queue para ver el orden o /shuffle para mezclar las pendientes.',
                    '🎛️ Los botones controlan la reproduccion actual del servidor.',
                ].filter(Boolean).join('\n'),
                components: [],
                allowedMentions: { parse: []},
            });

            return;
        }

            const results = await ytSearch(query);
            const videos = results.videos.slice(0, 5);

            if (videos.length === 0) {
                await interaction.editReply("No encontre canciones. Probar otro nombre...",);
                return; 
            }

            const emojis = ['1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣'];
            const availableEmojis = emojis.slice(0, videos.length);

            const options = videos
                .map((video, index) => {
                    const title = video.title.replace(/[\r\n]/g, ' ').slice(0, 100);
                    const author = video.author.name
                        .replace(/[\r\n]/g, ' ')
                        .slice(0, 60);

                    return `${emojis[index]} ${title} — ${author} (${video.timestamp})`;
                })
                .join('\n');

            const message = await interaction.editReply({
                content:
                    `🎵 **Elegí una canción:**\n\n${options}\n\n` +
                    'Reaccioná con su número. Tenés 60 segundos; ' +
                    'solo cuenta la elección de quien usó el comando.',
                allowedMentions: { parse: [] },
            });

            // Escuchamos antes de agregar los emojis para captar elecciones rapidas.
            const collector = message.createReactionCollector({
                filter: (reaction, user) =>
                    user.id === interaction.user.id &&
                    availableEmojis.includes(reaction.emoji.name ?? ''),
                max: 1,
                time: 60_000,
            });

            // Registramos la espera antes de que pueda terminar el collector.
            const selection = new Promise<MessageReaction | undefined>((resolve) => {
                collector.once('end', (collected) => {
                    resolve(collected.first());
                });
            });

            try {
                for (const emoji of availableEmojis) {
                    if (collector.ended) break;
                    await message.react(emoji);
                }
            } catch (error) {
                collector.stop("reaction-error");
                throw error;
            }

            const reaction = await selection;

            if (!reaction) {
                await interaction.editReply(
                    '⌛ Se terminó el tiempo. Usá /play para buscar de nuevo.',
                );
                return;
            }

            const index = availableEmojis.indexOf(reaction.emoji.name ?? '');
            const selected = videos[index];

            if (!selected) {
                await interaction.editReply("No pude reconocer la seleccion. Proba de nuevo",);
                return;
            }
            
            // Revisamos el canal actual: pudo cambiar durante la seleccion
            const currentMember = await interaction.guild.members.fetch(
                interaction.user.id,
            );
            const voiceChannel = currentMember.voice.channel;

            if (!voiceChannel) {
                await interaction.editReply(
                    "Saliste del canal de voz. Volve a entrar y usa /play de nuevo",
                );
                return;
            }

            let connection = getVoiceConnection(guildId);

            // Evitamos mover al bot si esta en otro canal.
            if (connection && connection.joinConfig.channelId !== voiceChannel.id) {
                await interaction.editReply("Estoy en otro canal de voz. Entra a ese canal para agregar canciones.",);
                return;
            }

            const createdConnection = !connection;

            if (!connection) {
                connection = joinVoiceChannel ({
                    channelId: voiceChannel.id,
                    guildId,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                    selfDeaf: true,
                });
            }

            try {
                await entersState(connection, VoiceConnectionStatus.Ready, 20_000);
            } catch (error) {
                console.error('No se pudo conectar al canal de voz:', error);

                if ( createdConnection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                    connection.destroy();
                }

                await interaction.editReply(
                        '❌ No pude conectarme al canal de voz. ' +
                        'Revisá mis permisos de Ver canal y Conectar, y probá de nuevo.',
                );

                return;
            }

            const queue = queues.get(guildId) ?? [];

            const track: Track = {
                query: selected.title,
                url: selected.url,
                requestedBy: interaction.user.username,
            };

            if (Number.isFinite(selected.seconds) && selected.seconds > 0) {
                track.durationSeconds = selected.seconds;
            }

            queue.push(track);

            queues.set(guildId, queue);
            
            startPlayback(guildId, queue, connection);

            const inactivity = inactivityStates.get(guildId);

            if (inactivity) {
                inactivity.idleSince = undefined;
            }


            if (interaction.channelId) {
                watchNowPlaying(guildId, interaction.channelId);
            }

            await interaction.editReply({
                content:
                    `➕ Agregado a la cola: ${selected.title}\n` +
                    `${selected.url}\nPosición: **${queue.length}**\n\n` +
                    '🎛️ Estos controles actúan sobre la reproducción actual del servidor.',
                components: [],
                allowedMentions: { parse: []},
            });

            // Quita tanto las reacciones del bot como la seleccion del usuario.
            await message.reactions.removeAll().catch((error: unknown) => {
                console.error(
                    'No pude quitar las reacciones. Revisa el permiso Aministrar mensajes:',
                    error,
                );
            });

        } catch (error) {
            console.error('Error en /play:', error);

            await interaction.editReply(
                '❌ No pude completar la búsqueda o selección. ' +
                'Revisá la terminal y los permisos del bot para agregar reacciones.',
            ).catch(console.error);
        }

        return;
    }

    if (interaction.commandName === 'queue') {
        const guildId = interaction.guildId;
        
        if (!guildId) {
            await interaction.reply('Este comando solo funciona en un servidor.');
            return;
        }

        const { current, pending, status } = getQueueSnapshot(guildId);

        if (!current && pending.length === 0) {
            await interaction.reply('La cola esta vacia.');
            return;
        }

        const page = interaction.options.getInteger('pagina') ?? 1;
        const pageSize = 10;
        const totalPages = Math.max(1, Math.ceil(pending.length / pageSize));

        if (page < 1 || page > totalPages) {
            await interaction.reply({
                content: `Elegi una pagina entre 1 y ${totalPages}.`,
                flags: MessageFlags.Ephemeral,
            });
            return;
        }

        // Acortamos y escapamos titulos para respetar el limite del mensaje
        const title = (track: Track): string =>
            escapeMarkdown(
                track.query.replace(/[\r\n]/g, ' ').slice(0, 60),
            );

        const offset = (page - 1) * pageSize;
        const visible = pending.slice(offset, offset + pageSize);
        const next = pending[0];

        const list = visible
            .map((track, index) => `${offset + index + 1}. ${title(track)}`)
            .join('\n');

            await interaction.reply({
                content: [
                    current
                        ? `🎶 **${status}:** ${title(current)}`
                        : '🎶 No hay una canción activa.',
                    next
                        ? `⏭️ **Siguiente:** ${title(next)}`
                        : '⏭️ No hay más canciones pendientes.',
                    '',
                    `📋 **Pendientes: ${pending.length}**`,
                    list || 'No hay canciones en espera.',
                    '',
                    `Pagina ${page}/${totalPages} · Usa /queue pagina:N para cambiar.`,
                ].join('\n'),
                allowedMentions: { parse: [] },
        });

        return;
    }

    if (interaction.commandName === 'shuffle') {
        await interaction.deferReply();

        try {
            const guildId = interaction.guildId;
            const guild = interaction.guild;

            if (!guildId || !guild) {
                await interaction.editReply(
                    'Este comando solo funciona en un servidor.',
                );
                return;
            }

            const member = await guild.members.fetch(interaction.user.id);
            const connection = getVoiceConnection(guildId);

            if (
                !connection ||
                !member.voice.channelId ||
                member.voice.channelId !== connection.joinConfig.channelId
            ) {
                await interaction.editReply(
                    'Entra al mismo canal de voz que el bot para mezclar la queue.',
                );
                return;
            }

            const count = shuffleQueue(guildId);

            if (count < 2) {
                await interaction.editReply(
                    'Necesito al menos dos canciones pendientes para mezclarlas,',
                );
                return;
            }

            await interaction.editReply(
                `🔀 Mezclé las ${count} canciones pendientes. ` +
                'La canción actual sigue igual. Usá /queue para ver el orden.',
            );
        } catch (error) {
            console.error('Erroe en /shuffle:', error);

            await interaction.editReply(
                '❌ No pude mezclar la cola. Revisá la terminal.',
            ).catch(console.error);
        }
        return;
    }

    if(interaction.commandName === 'skip') {
        await interaction.deferReply();

        try {
            const guildId = interaction.guildId;
            const guild = interaction.guild;

            if (!guildId || !guild) {
                await interaction.editReply(
                    'Este comando solo funciona en un servidor.',
                );
                return;
            }

            const member = await guild.members.fetch(interaction.user.id);
            const connection = getVoiceConnection(guildId);

            if (
                !connection ||
                !member.voice.channelId ||
                member.voice.channelId !== connection.joinConfig.channelId
            ) {
                await interaction.editReply(
                    'Entra al mismo canal de voz que el bot para saltar la cancion.',
                );
                return;
            }

            const skipped = skipTrack(guildId);

            await interaction.editReply(
                skipped
                    ? '⏭️ Canción saltada. Si hay otra en la cola, empezará a cargar.'
                    : 'No hay ninguna canción para saltar.',
            );
        } catch (error) {
            console.error('Error en /skip:', error);
            
            await interaction.editReply(
                '❌ No pude saltar la canción. Revisá la terminal.',
            ).catch(console.error);
        }

        return;
    }

    if (interaction.commandName === 'remove') {
        await interaction.deferReply();

        try {
            const guildId = interaction.guildId;
            const guild = interaction.guild;

            if (!guildId || !guild) {
                await interaction.editReply(
                    'Este comando solo funciona en un servidor',
                );
                return;
            }

            const member = await guild.members.fetch(interaction.user.id);
            const connection = getVoiceConnection(guildId);

            if (
                !connection ||
                !member.voice.channelId ||
                member.voice.channelId !== connection.joinConfig.channelId
            ) {
                await interaction.editReply(
                    'Entra al mismo canal de voz que el bot para quitar canciones',
                );
                return;
            }

            const position = interaction.options.getInteger('posicion', true);
            const removed = removeQueuedTrack(guildId, position);

            if (!removed) {
                await interaction.editReply(
                    'No hay una cancion pendiente en esa posicion. ' +
                    'Usa /queue para consultar la lista actual.',
                );
                return;
            }

            const title = escapeMarkdown(
                removed.query.replace(/[\r\n]/g, ' ').slice(0, 180),
            );

            await interaction.editReply({
                content: `🗑️ Quité de la cola: **${title}**`,
                allowedMentions: { parse: [] },
            });
        } catch (error) {
            console.error('Error en /remove:', error);

            await interaction.editReply(
                '❌ No pude quitar la canción. Revisá los registros del bot.',
            ).catch(console.error);
        }

        return;
    }
});

client.login(token);