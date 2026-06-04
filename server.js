const express = require('express');
const path = require('path');
const { Pool } = require('pg');
const { Client, GatewayIntentBits, ApplicationCommandOptionType, REST, Routes } = require('discord.js');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ID de ton serveur Discord (Doit être configuré dans l'onglet Environment sur Render !)
const GUILD_ID = process.env.GUILD_ID; 

// -------------------------------------------------------------
// 1. BASE DE DONNÉES POSTGRESQL (RENDER)
// -------------------------------------------------------------
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// -------------------------------------------------------------
// 2. LE BOT DISCORD & COMMANDES SLASH INDIVIDUELLES
// -------------------------------------------------------------
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers
    ]
});

const commands = [
    {
        name: 'warn',
        description: 'Mettre un avertissement à un membre et l\'ajouter au site',
        options: [
            { name: 'membre', description: 'Le membre à avertir', type: ApplicationCommandOptionType.User, required: true },
            { name: 'motif', description: 'La raison de l\'avertissement', type: ApplicationCommandOptionType.String, required: true }
        ]
    },
    {
        name: 'mute',
        description: 'Rendre muet (Timeout) un membre sur Discord et l\'ajouter au site',
        options: [
            { name: 'membre', description: 'Le membre à rendre muet', type: ApplicationCommandOptionType.User, required: true },
            { name: 'duree', description: 'La durée du mute (ex: 15m, 2h, 2h15m, 1d12h)', type: ApplicationCommandOptionType.String, required: true },
            { name: 'motif', description: 'La raison du mute', type: ApplicationCommandOptionType.String, required: true }
        ]
    },
    {
        name: 'ban',
        description: 'Bannir définitivement un membre de Discord et l\'ajouter au site',
        options: [
            { name: 'membre', description: 'Le membre à bannir', type: ApplicationCommandOptionType.User, required: true },
            { name: 'motif', description: 'La raison du bannissement', type: ApplicationCommandOptionType.String, required: true }
        ]
    }
];

client.once('ready', async () => {
    console.log(`🤖 Bot Discord connecté en tant que : ${client.user.tag} !`);
    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        
        // Supprime les vieux résidus de commandes globales obsolètes
        await rest.put(Routes.applicationCommands(client.user.id), { body: [] });
        
        // Enregistre proprement la nouvelle liste
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        
        console.log('✅ Toutes les commandes Slash individuelles sont synchronisées !');
    } catch (error) {
        console.error('❌ Erreur lors de l\'enregistrement des commandes:', error);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const { commandName } = interaction;
    const targetMember = interaction.options.getMember('membre');
    const reason = interaction.options.getString('motif');

    if (!targetMember) {
        return interaction.reply({ content: "❌ Impossible de trouver ce membre sur le serveur.", ephemeral: true });
    }

    const moderator = interaction.user.tag;
    const username = targetMember.user.username;
    const user_id = targetMember.id;

    // --- COMMANDE /WARN ---
    if (commandName === 'warn') {
        await interaction.deferReply();
        try {
            await pool.query('INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
            return interaction.editReply(`⚠️ **${username}** a reçu un avertissement et cela apparaît sur le site web !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Erreur de base de données.");
        }
    }

    // --- COMMANDE /MUTE ---
    if (commandName === 'mute') {
        const timeArg = interaction.options.getString('duree').toLowerCase().trim();
        await interaction.deferReply();

        try {
            let totalMs = 0;
            const daysMatch = timeArg.match(/(\d+)d/);
            const hoursMatch = timeArg.match(/(\d+)h/);
            const minsMatch = timeArg.match(/(\d+)m/);

            if (daysMatch) totalMs += parseInt(daysMatch[1]) * 24 * 60 * 60 * 1000;
            if (hoursMatch) totalMs += parseInt(hoursMatch[1]) * 60 * 60 * 1000;
            if (minsMatch) totalMs += parseInt(minsMatch[1]) * 60 * 1000;

            if (totalMs === 0) {
                return interaction.editReply("❌ Format de durée invalide ! Exemple : `15m`, `2h`, `2h15m` ou `1d12h`.");
            }

            let durationParts = [];
            if (daysMatch) durationParts.push(`${daysMatch[1]} Jour(s)`);
            if (hoursMatch) durationParts.push(`${hoursMatch[1]} Heure(s)`);
            if (minsMatch) durationParts.push(`${minsMatch[1]} Minute(s)`);
            const durationText = durationParts.join(' et ');

            await targetMember.timeout(totalMs, reason);

            await pool.query(
                'INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)',
                [username, user_id, reason, moderator, durationText]
            );
            return interaction.editReply(`🔇 **${username}** a été muté pendant **${durationText}** sur Discord et ajouté au site !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Erreur lors du mute. Vérifie ma hiérarchie.");
        }
    }

    // --- COMMANDE /BAN ---
    if (commandName === 'ban') {
        await interaction.deferReply();
        try {
            await targetMember.ban({ reason: reason });
            await pool.query('INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
            return interaction.editReply(`🔨 **${username}** a été banni de Discord et ajouté au site web !`);
        } catch (err) {
            console.error(err);
            return interaction.editReply("❌ Impossible de bannir ce membre.");
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

// -------------------------------------------------------------
// 3. SITE WEB API (AVEC SYSTEME DE SUPPRESSION ASSOCIEE)
// -------------------------------------------------------------
app.get('/', (req, res) => { res.sendFile(path.join(__dirname, 'index.html')); });

// Affiche la liste des sanctions et efface automatiquement les mutes expirés de Discord
app.get('/api/sanctions/:type', async (req, res) => {
    let type = req.params.type.toLowerCase();
    if (type.endsWith('s')) type = type.slice(0, -1); // Transforme 'mutes' en 'mute'
    
    const dbTable = type + 's'; // Donne 'mutes', 'bans' ou 'warns'

    try {
        const result = await pool.query(`SELECT * FROM ${dbTable} ORDER BY date_added DESC`);
        let rows = result.rows;

        // Nettoyage automatique en tâche de fond pour les mutes expirés
        if (type === 'mute' && GUILD_ID) {
            const guild = await client.guilds.fetch(GUILD_ID).catch(() => null);
            if (guild) {
                for (const row of rows) {
                    const member = await guild.members.fetch(row.user_id).catch(() => null);
                    // Si le membre n'a plus le sablier Discord ou a quitté, on l'enlève du site
                    if (!member || !member.communicationDisabledUntilTimestamp || member.communicationDisabledUntilTimestamp < Date.now()) {
                        await pool.query('DELETE FROM mutes WHERE id = $1', [row.id]);
                    }
                }
                // Récupération de la liste nettoyée
                const updatedResult = await pool.query(`SELECT * FROM mutes ORDER BY date_added DESC`);
                rows = updatedResult.rows;
            }
        }
        res.json(rows);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/sanctions', async (req, res) => {
    let { type, username, user_id, reason, moderator, duration } = req.body;
    type = type.toLowerCase();
    if (type.endsWith('s')) type = type.slice(0, -1);

    try {
        if (type === 'mute') await pool.query('INSERT INTO mutes (username, user_id, reason, moderator, duration) VALUES ($1, $2, $3, $4, $5)', [username, user_id, reason, moderator, duration || 'Non spécifiée']);
        else if (type === 'warn') await pool.query('INSERT INTO warns (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        else if (type === 'ban') await pool.query('INSERT INTO bans (username, user_id, reason, moderator) VALUES ($1, $2, $3, $4)', [username, user_id, reason, moderator]);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Supprime du site ET annule en direct la sanction sur Discord
app.delete('/api/sanctions/:type/:id', async (req, res) => {
    let { type, id } = req.params;
    type = type.toLowerCase();
    if (type.endsWith('s')) type = type.slice(0, -1); // Sécurise les pluriels au cas où
    
    const dbTable = type + 's';

    console.log(`🗑️ Clic détecté sur le site ! Type : ${type}, ID : ${id}`);

    try {
        // 1. On cherche d'abord l'ID de l'utilisateur dans la base de données
        const data = await pool.query(`SELECT user_id FROM ${dbTable} WHERE id = $1`, [id]);
        
        if (data.rows.length > 0) {
            const userIdDiscord = data.rows[0].user_id;
            console.log(`👤 Utilisateur trouvé dans la DB. ID Discord : ${userIdDiscord}`);

            if (GUILD_ID) {
                const guild = await client.guilds.fetch(GUILD_ID).catch((e) => {
                    console.error("❌ Impossible de trouver le serveur Discord :", e.message);
                    return null;
                });

                if (guild) {
                    // Si on retire un MUTE du site -> On enlève l'exclusion sur Discord
                    if (type === 'mute') {
                        const member = await guild.members.fetch(userIdDiscord).catch(() => null);
                        if (member) {
                            await member.timeout(null, "Sanction annulée depuis le site web");
                            console.log(`🔊 Unmute appliqué avec succès sur Discord pour ${member.user.username}`);
                        } else {
                            console.log("⚠️ Le membre n'est plus sur le serveur Discord.");
                        }
                    } 
                    // Si on retire un BAN du site -> On unban l'utilisateur sur Discord
                    else if (type === 'ban') {
                        await guild.bans.remove(userIdDiscord, "Sanction annulée depuis le site web")
                            .then(() => console.log(`🔓 Unban appliqué avec succès sur Discord pour l'ID ${userIdDiscord}`))
                            .catch((e) => console.error("⚠️ Impossible d'unban sur Discord :", e.message));
                    }
                }
            } else {
                console.log("⚠️ GUILD_ID n'est pas défini dans les variables Render. L'action Discord est ignorée.");
            }
        }

        // 2. On supprime enfin la ligne de la base de données pour l'effacer du tableau
        await pool.query(`DELETE FROM ${dbTable} WHERE id = $1`, [id]);
        console.log(`✅ Ligne nettoyée avec succès de la table ${dbTable}.`);
        res.json({ success: true });

    } catch (err) { 
        console.error("❌ Erreur générale lors de la suppression :", err);
        res.status(500).json({ error: err.message }); 
    }
});

app.listen(PORT, () => { console.log(`Serveur en ligne sur le port ${PORT} 🚀`); });