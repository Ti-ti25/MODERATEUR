const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits, ApplicationCommandOptionType, REST, Routes } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// -------------------------------------------------------------
// 1. BASE DE DONNÉES POSTGRESQL (RENDER)
// -------------------------------------------------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// -------------------------------------------------------------
// 2. LE BOT DISCORD & ENREGISTREMENT DES COMMANDES SLASH
// -------------------------------------------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ]
});

// Définition de la commande Slash /sanction
const sanctionCommand = {
    name: 'sanction',
    description: 'Appliquer une sanction (Ban, Mute, Warn) et l\'ajouter au site web',
    options: [
        {
            name: 'type',
            description: 'Le type de sanction',
            type: ApplicationCommandOptionType.String,
            required: true,
            choices: [
                { name: 'Avertissement (Warn)', value: 'warn' },
                { name: 'Rendre muet (Mute)', value: 'mute' },
                { name: 'Bannir (Ban)', value: 'ban' }
            ]
        },
        {
            name: 'membre',
            description: 'Le membre à sanctionner (recherche automatique)',
            type: ApplicationCommandOptionType.User,
            required: true
        },
        {
            name: 'motif',
            description: 'La raison de la sanction',
            type: ApplicationCommandOptionType.String,
            required: true
        },
        {
            name: 'duree',
            description: 'Pour les Mutes uniquement (ex: 15m, 2h, 1d). Par défaut: 24h.',
            type: ApplicationCommandOptionType.String,
            required: false
        }
    ]
};

client.once('ready', async () => {
    console.log(`🤖 Bot Discord connecté en tant que : ${client.user.tag} !`);

    // Enregistrement automatique de la commande auprès de Discord
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        console.log('🔄 Enregistrement de la commande Slash /sanction en cours...');
        
        await rest.put(
            Routes.applicationCommands(client.user.id),
            { body: [sanctionCommand] }
        );

        console.log('✅ Commande Slash /sanction enregistrée avec succès partout !');
    } catch (error) {
        console.error('❌ Erreur lors de l\'enregistrement de la commande Slash:', error);
    }
});

// Gestionnaire des interactions (quand quelqu'un utilise /sanction)
client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    if (interaction.commandName === 'sanction') {
        const type = interaction.options.getString('type');
        const targetMember = interaction.options.getMember('membre');
        const reason = interaction.options.getString('motif');
        const timeArg = interaction.options.getString('duree');

        if (!targetMember) {
            return interaction.reply({ content: "❌ Impossible de trouver ce membre sur le serveur.", ephemeral: true });
        }

        const moderator = interaction.user.tag;
        const username = targetMember.user.username;
        const user_id = targetMember.id;

        // On répond tout de suite à Discord pour lui dire qu'on traite la demande
        await interaction.deferReply();

        try {
            // --- ACTION : BAN ---
            if (type === 'ban') {
                await targetMember.ban({ reason: reason });
                await pool.query(
                    'INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                    [username, user_id, reason, moderator]
                );
                return interaction.editReply(`🔨 **${username}** a été banni de Discord et ajouté au site web !`);
            }

            // --- ACTION : MUTE ---
            if (type === 'mute') {
                let ms = 0;
                let durationText = "24 Heures";

                if (timeArg) {
                    const timeValue = parseInt(timeArg);
                    const timeUnit = timeArg.slice(-1).toLowerCase();

                    if (timeUnit === 'm') {
                        ms = timeValue * 60 * 1000;
                        durationText = `${timeValue} Minute(s)`;
                    } else if (timeUnit === 'h') {
                        ms = timeValue * 60 * 60 * 1000;
                        durationText = `${timeValue} Heure(s)`;
                    } else if (timeUnit === 'd') {
                        ms = timeValue * 24 * 60 * 60 * 1000;
                        durationText = `${timeValue} Jour(s)`;
                    }
                }

                if (ms === 0) {
                    ms = 24 * 60 * 60 * 1000;
                    durationText = "24 Heures";
                }

                await targetMember.timeout(ms, reason);

                await pool.query(
                    'INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)',
                    [username, user_id, reason, moderator, durationText]
                );
                return interaction.editReply(`🔇 **${username}** a été muté pendant **${durationText}** sur Discord et ajouté au site !`);
            }

            // --- ACTION : WARN ---
            if (type === 'warn') {
                await pool.query(
                    'INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)',
                    [username, user_id, reason, moderator]
                );
                return interaction.editReply(`⚠️ **${username}** a reçu un avertissement et cela apparaît sur le site web !`);
            }

        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Impossible d'exécuter la commande. Vérifie que mon rôle est bien **tout en haut** de la liste des rôles et que j'ai la permission Administrateur.");
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

// -------------------------------------------------------------
// 3. SITE WEB API (ROUTES POUR LES PAGES HTML)
// -------------------------------------------------------------
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/api/sanctions/:type', async (req, res) => {
    const type = req.params.type;
    try {
        const result = await pool.query(`SELECT * FROM ${type} ORDER BY date_added DESC`);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/sanctions', async (req, res) => {
    const { type, username, user_id, reason, moderator, duration } = req.body;
    try {
        if (type === 'mute') {
            await pool.query('INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)', [username, user_id, reason, moderator, duration || 'Non spécifiée']);
        } else if (type === 'warn') {
            await pool.query('INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        } else if (type === 'ban') {
            await pool.query('INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        }
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/sanctions/:type/:id', async (req, res) => {
    const { type, id } = req.params;
    try {
        await pool.query(`DELETE FROM ${type} WHERE id = $1`, [id]);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`Serveur en ligne sur le port ${PORT} 🚀`);
});