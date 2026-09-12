import 'dotenv/config';
import ytSearch from 'yt-search';
import type { MessageReaction } from 'discord.js';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { entersState, getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus, } from '@discordjs/voice';

type Track = {
    query: string;
    url: string;
    requestedBy: string;
};

const queues = new Map<string, Track[]>();

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
});

client.on(Events.InteractionCreate, async (interaction) => {
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
        const connection = getVoiceConnection(interaction.guildId!);

        if (!connection) {
            await interaction.reply('No estoy conectado a ningún canal de voz.');
            return;
        }

        connection.destroy();

        await interaction.reply('👋 Salí del canal de voz.' );
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

            const query = interaction.options.getString('busqueda', true).trim();

            if (!query) {
                await interaction.editReply("Escribi el nombnre de una cancion.");
                return;
            }

            // Los enlaces y las playlist laos incorporamos en el siguiente paso.
            if (/^https?:\/\//i.test(query)) {
                await interaction.editReply("Por ahora busca por nombre. Todavia falta agregar los enlaces.",);
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

            queue.push({
                query: selected.title,
                url: selected.url,
                requestedBy: interaction.user.username,
            });

            queues.set(guildId, queue);

            await interaction.editReply({
                content:
                    `➕ Agregado a la cola: ${selected.title}\n` +
                    `${selected.url}\nPosición: **${queue.length}**`,
                allowedMentions: { parse: [] },
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
        const queue = guildId ? queues.get(guildId) : undefined;

        if (!queue || queue.length === 0) {
            await interaction.reply('La cola de canciones está vacía.');
            return;
        }

        const list = queue
            .map((track, index) => `${index + 1}. ${track.query} — pedido por ${track.requestedBy}`)
            .join('\n');

        await interaction.reply(`🎶 **Cola actual:**\n${list}`);
    }
});

client.login(token);