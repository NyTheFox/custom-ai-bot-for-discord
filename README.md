# 🤖 Custom AI Bot for Discord

A fully-featured Discord AI bot built with **Node.js**, powered by **Groq** and **Google Gemini**, featuring intelligent API key rotation, persistent conversation memory, and a fully customizable personality system.

This bot is designed for stability, extensibility, and low-resource environments while maintaining rich, contextual, and personality-driven conversations.

---

## ✨ Features

- 🧠 **Dual AI Provider Support**
  - Groq (LLaMA-based, fast responses)
  - Google Gemini (advanced reasoning & creativity)
  - Automatic fallback when one provider fails

- 🔁 **Intelligent API Key Rotation**
  - Supports up to **3 Groq keys** and **3 Gemini keys**
  - Tracks daily request limits per key
  - Temporarily blocks failing or rate-limited keys
  - Automatically unblocks keys after cooldown
  - Daily request counters reset automatically

- 💬 **Persistent Conversation Memory**
  - Conversations stored in `conversations.json`
  - Timestamped message history
  - Context-aware replies
  - Safe JSON serialization and recovery

- 🎭 **Advanced Personality System**
  - Fully configurable via `personality.json`
  - Intent-based responses (greetings, love, hugs, etc.)
  - Multilingual support (EN / FR / ES / DE)
  - Emoji-rich, tone-controlled responses
  - Dynamic Discord activity rotation

- 🧩 **Channel-Based Behavior**
  - Dedicated chat channel
  - Optional image generation channel
  - Keyword-triggered replies outside main channels

- 🐢 **Low Memory Mode**
  - Optimized for servers with 256–512MB RAM
  - Reduced in-memory history
  - Safer garbage collection behavior

---

## 📋 Prerequisites

- **Node.js** v16 or higher
- A **Discord Bot Token**
- **Groq API Keys** (up to 3)
- **Gemini API Keys** (up to 3)

---

## 🚀 Installation

1. Clone or download the repository:
   ```bash
   git clone https://github.com/your-username/custom-ai-bot-for-discord.git
   cd custom-ai-bot-for-discord
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a `.env` file in the project root:
   ```env
   # Discord Configuration
   DISCORD_TOKEN=YOUR_DISCORD_BOT_TOKEN

   # Channel IDs
   CHAT_CHANNEL_ID=
   IMAGE_CHANNEL_ID=

   # Groq API Keys
   GROQ_API_KEY_1=
   GROQ_API_KEY_2=
   GROQ_API_KEY_3=

   # Gemini API Keys
   GEMINI_API_KEY_1=
   GEMINI_API_KEY_2=
   GEMINI_API_KEY_3=

   # Memory Configuration
   LOW_MEMORY_MODE=true
   ```

---

## 📁 Project Structure

```
custom-ai-bot-for-discord/
├── README.md
├── .env
├── bot.js
├── conversations.json
├── personality.json
├── package.json
└── package-lock.json
```

---

## 🎯 Usage

### Start the bot
```bash
npm start
```

### Development mode
```bash
npm run dev
```

---

## 🤝 Support

Discord: https://discord.gg/KFaJWUN6CC

---
