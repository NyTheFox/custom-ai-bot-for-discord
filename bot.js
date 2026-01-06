const { Client, GatewayIntentBits, EmbedBuilder, AttachmentBuilder, ActivityType, Options } = require('discord.js');
const axios = require('axios');
const fs = require('fs').promises;
const path = require('path');
require('dotenv').config();

// ============================================================================
// MEMORY-OPTIMIZED CONFIGURATION
// ============================================================================

const LOW_MEMORY = process.env.LOW_MEMORY_MODE === 'true';

const CONFIG = {
    files: {
        personality: path.join(__dirname, 'personality.json'),
        conversations: path.join(__dirname, 'conversations.json')
    },
    limits: {
        // Reduced limits for low memory
        conversationHistory: LOW_MEMORY ? 20 : 100,
        conversationContext: LOW_MEMORY ? 2 : 3,
        maxRetries: 2,
        conversationRetentionDays: LOW_MEMORY ? 3 : 7,
        maxUsersInMemory: LOW_MEMORY ? 50 : 200,
        // Aggressive memory management
        messageBufferSize: LOW_MEMORY ? 5 : 10,
        maxCacheAge: LOW_MEMORY ? 1800000 : 3600000 // 30min vs 1hr
    },
    intervals: {
        autoSave: LOW_MEMORY ? 600000 : 300000, // 10min vs 5min
        cleanup: LOW_MEMORY ? 1800000 : 3600000, // 30min vs 1hr
        activityUpdate: 30000,
        memoryCheck: LOW_MEMORY ? 60000 : 300000 // 1min vs 5min
    },
    timeouts: {
        apiRequest: 20000,
        saveDebounce: LOW_MEMORY ? 5000 : 2000
    }
};

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ],
    // Optimize client settings for low memory
    sweepers: {
        messages: {
            interval: 300,
            lifetime: 600
        },
        users: {
            interval: 3600,
            filter: () => user => user.bot && user.id !== client.user.id
        }
    },
    // Reduce cache sizes
    ...(LOW_MEMORY && {
        makeCache: Options.cacheWithLimits({
            MessageManager: 50,
            ChannelManager: 50,
            GuildManager: 10,
            UserManager: 100,
            GuildMemberManager: 50
        })
    })
});

let personality = null;
let conversations = {};
let saveTimeout = null;
let lastCleanup = Date.now();

// ============================================================================
// MEMORY MANAGEMENT
// ============================================================================

function getMemoryUsage() {
    const used = process.memoryUsage();
    return {
        rss: Math.round(used.rss / 1024 / 1024),
        heapUsed: Math.round(used.heapUsed / 1024 / 1024),
        heapTotal: Math.round(used.heapTotal / 1024 / 1024),
        external: Math.round(used.external / 1024 / 1024)
    };
}

function forceGarbageCollection() {
    if (global.gc) {
        global.gc();
        console.log('🧹 Manual garbage collection triggered');
    }
}

function pruneOldUsers() {
    const now = Date.now();
    const maxAge = CONFIG.limits.maxCacheAge;
    let pruned = 0;
    
    for (const userId in conversations) {
        const lastMsg = new Date(conversations[userId].lastMessage).getTime();
        if (now - lastMsg > maxAge) {
            delete conversations[userId];
            pruned++;
        }
    }
    
    // Keep only most recent users if still over limit
    const userIds = Object.keys(conversations);
    if (userIds.length > CONFIG.limits.maxUsersInMemory) {
        const sorted = userIds.sort((a, b) => {
            const timeA = new Date(conversations[a].lastMessage).getTime();
            const timeB = new Date(conversations[b].lastMessage).getTime();
            return timeB - timeA;
        });
        
        sorted.slice(CONFIG.limits.maxUsersInMemory).forEach(id => {
            delete conversations[id];
            pruned++;
        });
    }
    
    if (pruned > 0) {
        console.log(`🧹 Pruned ${pruned} inactive users from memory`);
    }
    
    return pruned;
}

async function checkMemoryPressure() {
    const mem = getMemoryUsage();
    const threshold = LOW_MEMORY ? 200 : 400; // MB
    
    if (mem.heapUsed > threshold) {
        console.log(`⚠️ High memory usage: ${mem.heapUsed}MB`);
        pruneOldUsers();
        forceGarbageCollection();
        
        // Emergency save if needed
        if (mem.heapUsed > threshold * 1.2) {
            await saveConversations();
            conversations = {}; // Clear all and reload on demand
            console.log('🚨 Emergency memory clear performed');
        }
    }
}

// ============================================================================
// LIGHTWEIGHT API KEY MANAGER
// ============================================================================

class APIKeyManager {
    constructor(keys, serviceName) {
        this.keys = keys.filter(key => key && key.trim());
        this.serviceName = serviceName;
        this.currentIndex = 0;
        this.keyStatus = new Map();
        
        this.keys.forEach((_, index) => {
            this.keyStatus.set(index, {
                isBlocked: false,
                blockUntil: null,
                consecutiveErrors: 0
            });
        });
        
        console.log(`🔑 Loaded ${this.keys.length} ${serviceName} key(s)`);
    }

    getNextAvailable() {
        const now = Date.now();
        
        // Unblock expired keys
        this.keyStatus.forEach((status, index) => {
            if (status.isBlocked && status.blockUntil && now >= status.blockUntil) {
                status.isBlocked = false;
                status.blockUntil = null;
                status.consecutiveErrors = Math.max(0, status.consecutiveErrors - 1);
            }
        });
        
        // Find first available
        for (let i = 0; i < this.keys.length; i++) {
            const keyIndex = (this.currentIndex + i) % this.keys.length;
            const status = this.keyStatus.get(keyIndex);
            
            if (!status.isBlocked) {
                return { key: this.keys[keyIndex], index: keyIndex };
            }
        }
        
        return null;
    }

    blockKey(keyIndex, duration = 120000) {
        const status = this.keyStatus.get(keyIndex);
        if (!status) return;
        
        status.isBlocked = true;
        status.blockUntil = Date.now() + duration;
        status.consecutiveErrors++;
    }

    markSuccess(keyIndex) {
        const status = this.keyStatus.get(keyIndex);
        if (!status) return;
        
        status.consecutiveErrors = 0;
        this.currentIndex = keyIndex;
    }
}

const groqManager = new APIKeyManager([
    process.env.GROQ_API_KEY_1,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_API_KEY_3
], 'Groq');

const geminiManager = new APIKeyManager([
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3
], 'Gemini');

// ============================================================================
// PERSONALITY CONFIGURATION
// ============================================================================

async function loadPersonality() {
    try {
        const data = await fs.readFile(CONFIG.files.personality, 'utf8');
        personality = JSON.parse(data);
        console.log(`💖 Loaded personality: ${personality.personality.name}`);
        return true;
    } catch (error) {
        console.error('❌ Error loading personality.json:', error);
        throw new Error('personality.json is required');
    }
}

function replacePlaceholders(text, userName = 'friend') {
    if (!text || typeof text !== 'string') return text;
    return text
        .replace(/{ai}/gi, personality.personality.name)
        .replace(/{user}/gi, userName);
}

function buildSystemPrompt(userName) {
    if (!personality) return "You are a helpful AI assistant.";
    
    const p = personality.personality;
    let prompt = `You are ${p.name}. ${p.description}\n\n`;
    
    if (p.responseStyle) {
        prompt += `STYLE: ${replacePlaceholders(p.responseStyle, userName)}\n\n`;
    }
    
    if (p.likes?.length > 0) {
        prompt += `LOVES: ${p.likes.slice(0, 5).join(', ')}\n`;
    }
    
    if (p.conversationGoals?.length > 0) {
        prompt += `GOALS: ${p.conversationGoals[0]}\n`;
    }
    
    prompt += `\nIMPORTANT: Detect user's language and reply in SAME language. Keep responses under 150 words.`;
    
    return prompt;
}

// ============================================================================
// LANGUAGE & INTENT DETECTION (OPTIMIZED)
// ============================================================================

function detectLanguage(text) {
    if (!text) return 'en';
    const lower = text.toLowerCase();
    
    // Quick keyword check
    if (/\b(je|tu|le|la|bonjour)\b/.test(lower)) return 'fr';
    if (/\b(hola|que|como|esta)\b/.test(lower)) return 'es';
    if (/\b(hallo|ich|du|der)\b/.test(lower)) return 'de';
    
    return 'en';
}

function detectIntent(message) {
    if (!personality.responses?.intents) return 'random';
    
    const lower = message.toLowerCase();
    
    // Priority intents first
    if (/\b(profile|who are you|about)\b/.test(lower)) return 'profile';
    if (/\b(stats|statistics|level)\b/.test(lower)) return 'stats';
    if (/\b(hi|hello|hey|bonjour|hola)\b/.test(lower)) return 'greetings';
    if (/\b(night|sleep|bed|gn)\b/.test(lower)) return 'goodnight';
    if (/\b(love|kiss|miss|heart)\b/.test(lower)) return 'love';
    if (/\b(hug|cuddle|embrace)\b/.test(lower)) return 'hug';
    if (/\b(beautiful|cute|gorgeous|sexy)\b/.test(lower)) return 'flirty';
    
    return 'random';
}

function containsKeywords(message) {
    if (!personality.misc?.keywordsOfInterest) return false;
    const lower = message.toLowerCase();
    return personality.misc.keywordsOfInterest.some(kw => 
        lower.includes(kw.toLowerCase())
    );
}

function getCustomResponse(intent, userName, lang = 'en') {
    const intentConfig = personality.responses?.intents?.[intent];
    if (!intentConfig?.responses) return null;
    
    const responses = intentConfig.responses[lang] || intentConfig.responses['en'];
    if (!responses?.length) return null;
    
    const response = responses[Math.floor(Math.random() * responses.length)];
    return replacePlaceholders(response, userName);
}

// ============================================================================
// AI API CALLS (OPTIMIZED)
// ============================================================================

async function callGroqAPI(prompt, userName) {
    for (let attempt = 0; attempt < 2; attempt++) {
        const keyData = groqManager.getNextAvailable();
        if (!keyData) throw new Error('No Groq keys available');
        
        try {
            const response = await axios.post(
                'https://api.groq.com/openai/v1/chat/completions',
                {
                    model: "llama-3.1-8b-instant",
                    messages: [
                        { role: "system", content: buildSystemPrompt(userName) },
                        { role: "user", content: prompt }
                    ],
                    max_tokens: 120,
                    temperature: 0.85,
                    stream: false
                },
                {
                    headers: {
                        'Authorization': `Bearer ${keyData.key}`,
                        'Content-Type': 'application/json'
                    },
                    timeout: CONFIG.timeouts.apiRequest
                }
            );

            if (response.data?.choices?.[0]) {
                groqManager.markSuccess(keyData.index);
                return response.data.choices[0].message.content;
            }
            
            throw new Error('Invalid response');
            
        } catch (error) {
            groqManager.blockKey(keyData.index, error.response?.status === 429 ? 600000 : 180000);
            if (attempt === 1) throw error;
            await new Promise(r => setTimeout(r, 1000));
        }
    }
}

async function callGeminiAPI(prompt, userName) {
    const keyData = geminiManager.getNextAvailable();
    if (!keyData) throw new Error('No Gemini keys available');
    
    try {
        const geminiPrompt = `${buildSystemPrompt(userName)}\n\nUser: ${prompt}`;
        
        const response = await axios.post(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${keyData.key}`,
            {
                contents: [{ parts: [{ text: geminiPrompt }] }],
                generationConfig: {
                    maxOutputTokens: 120,
                    temperature: 0.85
                }
            },
            {
                headers: { 'Content-Type': 'application/json' },
                timeout: CONFIG.timeouts.apiRequest
            }
        );

        if (response.data?.candidates?.[0]) {
            geminiManager.markSuccess(keyData.index);
            return response.data.candidates[0].content.parts[0].text;
        }
        
        throw new Error('Invalid response');
        
    } catch (error) {
        geminiManager.blockKey(keyData.index, 180000);
        throw error;
    }
}

async function getChatResponse(userMessage, userName, userId) {
    try {
        const context = getConversationContext(userId);
        const userData = getUserData(userId, userName);
        
        const prompt = context 
            ? `Recent:\n${context}\n\nCurrent: "${userMessage}"`
            : userMessage;

        try {
            return await callGroqAPI(prompt, userName);
        } catch {
            return await callGeminiAPI(prompt, userName);
        }
        
    } catch (error) {
        console.error('API failed:', error.message);
        const lang = detectLanguage(userMessage);
        return getCustomResponse('apiFailed', userName, lang) || 
               "I'm having trouble right now! 💕";
    }
}

// ============================================================================
// CONVERSATION MANAGEMENT (MEMORY-OPTIMIZED)
// ============================================================================

async function loadConversations() {
    try {
        const data = await fs.readFile(CONFIG.files.conversations, 'utf8');
        const loaded = JSON.parse(data);
        
        // Only load recent users
        const threshold = Date.now() - CONFIG.limits.maxCacheAge;
        conversations = {};
        
        for (const [userId, userData] of Object.entries(loaded)) {
            const lastMsg = new Date(userData.lastMessage).getTime();
            if (lastMsg > threshold) {
                conversations[userId] = userData;
            }
        }
        
        console.log(`💾 Loaded ${Object.keys(conversations).length} active users`);
        await cleanupOldConversations();
    } catch (error) {
        if (error.code === 'ENOENT') {
            conversations = {};
            await saveConversations();
        } else {
            console.error('Load error:', error);
            conversations = {};
        }
    }
}

async function saveConversations() {
    try {
        // Save only essential data
        const toSave = {};
        for (const [userId, data] of Object.entries(conversations)) {
            toSave[userId] = {
                userId: data.userId,
                userName: data.userName,
                firstMessage: data.firstMessage,
                lastMessage: data.lastMessage,
                messageCount: data.messageCount,
                conversationHistory: data.conversationHistory.slice(-CONFIG.limits.conversationHistory),
                userStats: data.userStats
            };
        }
        
        await fs.writeFile(CONFIG.files.conversations, JSON.stringify(toSave, null, 0));
        console.log(`💾 Saved ${Object.keys(toSave).length} users`);
    } catch (error) {
        console.error('Save error:', error);
    }
}

function debouncedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveConversations, CONFIG.timeouts.saveDebounce);
}

function getUserData(userId, userName) {
    if (!conversations[userId]) {
        conversations[userId] = {
            userId,
            userName,
            firstMessage: new Date().toISOString(),
            lastMessage: new Date().toISOString(),
            messageCount: 0,
            conversationHistory: [],
            userStats: {
                totalMessages: 0,
                imagesGenerated: 0,
                relationshipLevel: 1,
                favoriteIntents: {},
                specialMoments: []
            }
        };
    }
    
    conversations[userId].userName = userName;
    return conversations[userId];
}

function addToConversation(userId, userName, message, response, intent, type = 'chat') {
    const userData = getUserData(userId, userName);
    
    // Trim message for memory
    const trimmedMsg = message.length > 200 ? message.substring(0, 200) + '...' : message;
    const trimmedRes = response.length > 300 ? response.substring(0, 300) + '...' : response;
    
    userData.conversationHistory.push({
        timestamp: new Date().toISOString(),
        type,
        userMessage: trimmedMsg,
        botResponse: trimmedRes,
        intent
    });
    
    userData.lastMessage = new Date().toISOString();
    userData.messageCount++;
    userData.userStats.totalMessages++;
    
    if (intent) {
        userData.userStats.favoriteIntents[intent] = 
            (userData.userStats.favoriteIntents[intent] || 0) + 1;
    }
    
    // Level up
    const newLevel = Math.floor(userData.userStats.totalMessages / 10) + 1;
    if (newLevel > userData.userStats.relationshipLevel) {
        userData.userStats.relationshipLevel = newLevel;
        userData.userStats.specialMoments.push({
            type: 'level_up',
            level: newLevel,
            timestamp: new Date().toISOString()
        });
    }
    
    // Keep only recent history
    if (userData.conversationHistory.length > CONFIG.limits.conversationHistory) {
        userData.conversationHistory = userData.conversationHistory.slice(-CONFIG.limits.conversationHistory);
    }
    
    if (userData.userStats.specialMoments.length > 10) {
        userData.userStats.specialMoments = userData.userStats.specialMoments.slice(-10);
    }
    
    userData.messageCount = userData.conversationHistory.length;
    debouncedSave();
}

function getConversationContext(userId) {
    const userData = conversations[userId];
    if (!userData?.conversationHistory.length) return '';
    
    return userData.conversationHistory
        .slice(-CONFIG.limits.conversationContext)
        .map(e => `User: ${e.userMessage}\n${personality.personality.name}: ${e.botResponse}`)
        .join('\n---\n');
}

async function cleanupOldConversations() {
    const threshold = new Date(Date.now() - CONFIG.limits.conversationRetentionDays * 24 * 60 * 60 * 1000);
    let totalDeleted = 0;
    
    for (const userId in conversations) {
        const userData = conversations[userId];
        const originalCount = userData.conversationHistory?.length || 0;
        
        if (userData.conversationHistory) {
            userData.conversationHistory = userData.conversationHistory.filter(e => 
                new Date(e.timestamp) >= threshold
            );
            
            totalDeleted += originalCount - userData.conversationHistory.length;
            userData.messageCount = userData.conversationHistory.length;
        }
        
        if (userData.userStats?.specialMoments) {
            userData.userStats.specialMoments = userData.userStats.specialMoments.filter(m =>
                new Date(m.timestamp) >= threshold
            );
        }
    }
    
    if (totalDeleted > 0) {
        console.log(`🧹 Cleaned ${totalDeleted} old messages`);
        await saveConversations();
    }
    
    return { totalDeleted };
}

// ============================================================================
// IMAGE GENERATION (OPTIMIZED)
// ============================================================================

async function generateImage(prompt) {
    try {
        const cleanPrompt = prompt.replace(/\b(sexy|hot|nude|naked|nsfw|sexual)\b/gi, 'beautiful');
        const enhancedPrompt = `${cleanPrompt}, anime style, high quality`;
        const encodedPrompt = encodeURIComponent(enhancedPrompt);
        
        const imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=512&height=512&nologo=true`;
        
        const response = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            maxContentLength: 5 * 1024 * 1024 // 5MB limit
        });
        
        return Buffer.from(response.data);
    } catch (error) {
        console.error('Image error:', error.message);
        return null;
    }
}

// ============================================================================
// EMBED CREATORS (LIGHTWEIGHT)
// ============================================================================

function createStatsEmbed(userId, userName) {
    const userData = conversations[userId];
    if (!userData) return null;

    const stats = userData.userStats;
    const favoriteIntent = Object.keys(stats.favoriteIntents).length > 0 
        ? Object.keys(stats.favoriteIntents).reduce((a, b) => 
            stats.favoriteIntents[a] > stats.favoriteIntents[b] ? a : b)
        : 'random';
    
    const daysSince = Math.floor((new Date() - new Date(userData.firstMessage)) / (1000 * 60 * 60 * 24));

    return new EmbedBuilder()
        .setColor('#FF69B4')
        .setTitle(`💖 ${userName}'s Journey with ${personality.personality.name}`)
        .addFields(
            { name: '💌 Messages', value: `${stats.totalMessages}`, inline: true },
            { name: '🖼️ Images', value: `${stats.imagesGenerated}`, inline: true },
            { name: '💖 Level', value: `${stats.relationshipLevel}`, inline: true },
            { name: '🌟 Vibe', value: favoriteIntent, inline: true },
            { name: '📅 Days', value: `${daysSince}`, inline: true }
        )
        .setTimestamp();
}

function createProfileEmbed() {
    const p = personality.personality;
    
    return new EmbedBuilder()
        .setColor('#FF69B4')
        .setTitle(`💖 About ${p.name}`)
        .setDescription(p.description)
        .addFields(
            { name: '✨ Info', value: `Age: ${p.age}\nBirthday: ${p.birthday}`, inline: true },
            { name: '💕 Loves', value: p.likes.slice(0, 3).join(', '), inline: true }
        )
        .setTimestamp();
}

// ============================================================================
// DISCORD EVENT HANDLERS
// ============================================================================

client.on('ready', async () => {
    console.log(`💕 ${personality.personality.name} online as ${client.user.tag}`);
    
    await loadConversations();
    updateActivity();
    
    setInterval(updateActivity, CONFIG.intervals.activityUpdate);
    setInterval(saveConversations, CONFIG.intervals.autoSave);
    setInterval(cleanupOldConversations, CONFIG.intervals.cleanup);
    
    if (LOW_MEMORY) {
        setInterval(checkMemoryPressure, CONFIG.intervals.memoryCheck);
        console.log('🔧 Low-memory mode ACTIVE');
    }
    
    console.log('🚀 Ready');
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    const chatChannelId = process.env.CHAT_CHANNEL_ID;
    const imageChannelId = process.env.IMAGE_CHANNEL_ID;
    const userId = message.author.id;
    const userName = message.author.displayName || message.author.username;
    
    const isInChatChannel = message.channel.id === chatChannelId;
    const isInImageChannel = message.channel.id === imageChannelId;
    const hasKeyword = containsKeywords(message.content);
    
    // Check if message is a reply to the bot
    const isReplyToBot = message.reference && message.reference.messageId;
    let isBotMessage = false;
    
    if (isReplyToBot) {
        try {
            const repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
            isBotMessage = repliedMessage.author.id === client.user.id;
        } catch (error) {
            console.error('Error fetching replied message:', error);
        }
    }
    
    // Respond if: in chat channel, in image channel, has keyword, OR is reply to bot
    if (!isInChatChannel && !isInImageChannel && !hasKeyword && !isBotMessage) return;
    
    if (isInChatChannel || (!isInImageChannel && hasKeyword) || isBotMessage) {
        await handleChatMessage(message, userId, userName);
    } else if (isInImageChannel) {
        await handleImageRequest(message, userId, userName);
    }
});

async function handleChatMessage(message, userId, userName) {
    try {
        await message.channel.sendTyping();
        
        const lang = detectLanguage(message.content);
        const intent = detectIntent(message.content);
        
        if (intent === 'profile') {
            const embed = createProfileEmbed();
            await message.reply({ embeds: [embed] });
            const reply = getCustomResponse('profile', userName, lang) || "Here's me! 💖";
            addToConversation(userId, userName, message.content, reply, intent);
            return;
        }
        
        if (intent === 'stats') {
            const embed = createStatsEmbed(userId, userName);
            if (embed) {
                await message.reply({ embeds: [embed] });
                const reply = getCustomResponse('stats', userName, lang) || "Our stats! 💖";
                addToConversation(userId, userName, message.content, reply, intent);
            }
            return;
        }
        
        let response = getCustomResponse(intent, userName, lang);
        
        if (!response) {
            response = await getChatResponse(message.content, userName, userId);
        }
        
        addToConversation(userId, userName, message.content, response, intent);
        await message.reply(response);
        
        // Memory check after interaction
        if (LOW_MEMORY && Math.random() < 0.1) {
            checkMemoryPressure();
        }
        
    } catch (error) {
        console.error('Chat error:', error);
        const fallback = getCustomResponse('apiFailed', userName, detectLanguage(message.content)) || 
                        "Having trouble! 💕";
        await message.reply(fallback).catch(console.error);
    }
}

async function handleImageRequest(message, userId, userName) {
    try {
        await message.channel.sendTyping();
        const lang = detectLanguage(message.content);
        
        const imageBuffer = await generateImage(message.content);
        
        if (imageBuffer) {
            const attachment = new AttachmentBuilder(imageBuffer, { name: 'image.png' });
            const title = getCustomResponse('imageGenerated', userName, lang) || 
                         '💖 Your image! ✨';
            
            const embed = new EmbedBuilder()
                .setColor('#FF1493')
                .setTitle(title)
                .setImage('attachment://image.png');
            
            await message.reply({ embeds: [embed], files: [attachment] });
            
            const userData = getUserData(userId, userName);
            userData.userStats.imagesGenerated++;
            addToConversation(userId, userName, message.content, "Generated image", 'image', 'image');
            
        } else {
            const errorMsg = getCustomResponse('imageFailed', userName, lang) || 
                            "Couldn't create image! 💕";
            await message.reply(errorMsg);
        }
        
    } catch (error) {
        console.error('Image error:', error);
        const errorMsg = getCustomResponse('imageFailed', userName, detectLanguage(message.content)) || 
                        "Image failed! 💕";
        await message.reply(errorMsg).catch(console.error);
    }
}

function updateActivity() {
    if (!personality?.misc?.activityStatuses) return;
    
    const statuses = personality.misc.activityStatuses;
    const randomStatus = statuses[Math.floor(Math.random() * statuses.length)];
    
    let activityType = ActivityType.Playing;
    let activityText = randomStatus.text || randomStatus;
    
    if (typeof randomStatus === 'object') {
        activityText = randomStatus.text;
        
        switch(randomStatus.type?.toLowerCase()) {
            case 'streaming': activityType = ActivityType.Streaming; break;
            case 'listening': activityType = ActivityType.Listening; break;
            case 'watching': activityType = ActivityType.Watching; break;
            case 'competing': activityType = ActivityType.Competing; break;
        }
    }
    
    activityText = replacePlaceholders(activityText);
    client.user.setActivity(activityText, { type: activityType });
}

// ============================================================================
// ERROR HANDLING & SHUTDOWN
// ============================================================================

client.on('error', error => console.error('Discord error:', error));
process.on('unhandledRejection', error => console.error('Unhandled rejection:', error));

const shutdown = async (signal) => {
    console.log(`\n💾 ${signal}, saving...`);
    try {
        await saveConversations();
        console.log('✅ Saved');
    } catch (error) {
        console.error('❌ Save failed:', error);
    }
    process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// ============================================================================
// STARTUP
// ============================================================================

(async () => {
    try {
        if (LOW_MEMORY) {
            console.log('🔧 LOW MEMORY MODE ENABLED');
            console.log(`📊 Limits: ${CONFIG.limits.conversationHistory} msgs, ${CONFIG.limits.maxUsersInMemory} users`);
        }
        
        const mem = getMemoryUsage();
        console.log(`💾 Memory: ${mem.heapUsed}MB / ${mem.heapTotal}MB (RSS: ${mem.rss}MB)`);
        
        await loadPersonality();
        await client.login(process.env.DISCORD_TOKEN);
    } catch (error) {
        console.error('❌ Failed to start:', error);
        process.exit(1);
    }
})();