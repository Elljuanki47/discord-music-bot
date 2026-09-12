import 'dotenv/config';
import {REST, Routes, SlashCommandBuilder} from 'discord.js';

const token = process.env.DISCORD_TOKEN;
const clientId = process.env.CLIENT_ID;
const guildId = process.env.GUILD_ID;

if (!token || !clientId || !guildId) {
    throw new Error('Faltan datos en el archivo .env');
}

const commands = [
    new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Comprueba si el bot esta funcionando'),

    new SlashCommandBuilder()
        .setName('join')
        .setDescription('Une el bot a tu canal de voz'),

    new SlashCommandBuilder()
        .setName('leave')
        .setDescription('Hace que el bot se vaya del canal de voz'),

    new SlashCommandBuilder()
        .setName('play')
        .setDescription('Agrega una cancion o enlace a la cola')
        .addStringOption((option) =>
            option
                .setName('busqueda')
                .setDescription('Link o nombre de la cancion')
                .setRequired(true),
        ),

    new SlashCommandBuilder()
    .setName('queue')
    .setDescription('Muestra la canción actual y las canciones pendientes')
    .addIntegerOption((option) =>
        option
            .setName('pagina')
            .setDescription('Página de canciones pendientes')
            .setMinValue(1),
    ),

    new SlashCommandBuilder()
        .setName('shuffle')
        .setDescription('Mezcla las canciones pendientes sin interrumpir la actual'),
        
].map((command) => command.toJSON());

const rest = new REST({ version: '10' }).setToken(token);

console.log('Registrando el comando /ping...');

await rest.put(
    Routes.applicationGuildCommands(clientId, guildId),
    { body: commands },
);

console.log('✅ Comando /ping registrado.');