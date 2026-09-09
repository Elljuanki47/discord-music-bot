import 'dotenv/config';
import { Client, Events, GatewayIntentBits } from 'discord.js';
import { entersState, getVoiceConnection, joinVoiceChannel, VoiceConnectionStatus, } from '@discordjs/voice';

type Track = {
    query: string;
    requestedBy: string;
};

const queues = new Map<string, Track[]>();

const token = process.env.DICORD_TOKEN;

if (!token) {
    throw new Error('Falta DISCORD_TOKEN en el archivo .env');
}

const client = new Client ({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildVoiceStates,
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

        if (!guildId) {
            await interaction.reply('Este comando solo funciona dentro de un canal');
            return;
        }

        const query = interaction.options.getString('busqueda', true);

        const queue = queues.get(guildId) ?? [];

        queue.push({
            query,
            requestedBy: interaction.user.username,
        });

        queues.set(guildId, queue);

        await interaction.reply(
            `➕ Agregado a la cola: **${query}**\nPosición: **${queue.length}**`,
        );
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